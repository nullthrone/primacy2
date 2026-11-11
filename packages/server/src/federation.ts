/**
 * Server-to-server federation: the directory of known sectors, peering, gossip and ticket redemption.
 *
 * Every descriptor in the directory has passed `verifyDescriptor`, so it is self-certifying
 * regardless of who relayed it. A *link* is stronger: the two servers have talked directly and
 * each confirmed that the other's URL really serves that server id.
 */
import {
  GOSSIP_INTERVAL_MS,
  MAX_DESCRIPTOR_BYTES,
  PEER_TIMEOUT_MS,
  isValidServerUrl,
  randomNonce,
  signEnvelope,
  verifyDescriptor,
  verifyEnvelope,
  type KeyPair,
  type ServerDescriptor,
  type Signed,
  type TrustLevel,
} from '@primacy2/shared';
import type { ServerConfig } from './config.ts';
import type { Store, StoredPeer } from './store.ts';

export interface KnownServer {
  id: string;
  signed: Signed<ServerDescriptor>;
  desc: ServerDescriptor;
  linked: boolean;
  /** Last time this server answered us directly, or a fresh descriptor arrived by gossip. */
  lastSeen: number;
  /** True once we fetched the descriptor from its own URL and the id matched. */
  urlVerified: boolean;
}

export interface FedHost {
  readonly id: string;
  readonly keys: KeyPair;
  readonly config: ServerConfig;
  readonly store: Store;
  now(): number;
  /** Builds and signs this server's current descriptor. */
  descriptor(): Signed<ServerDescriptor>;
  log(msg: string): void;
}

const MAX_KNOWN = 400;
const MAX_GOSSIP = 200;
const FETCH_TIMEOUT_MS = 6_000;

export type FetchLike = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class Federation {
  readonly known = new Map<string, KnownServer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Handlers for module-defined server-to-server messages, keyed by topic. */
  private readonly topics = new Map<string, (from: KnownServer, payload: unknown) => unknown | Promise<unknown>>();
  /** Called whenever the directory changes in a way the galaxy map shows. */
  onChange: () => void = () => {};

  constructor(
    private readonly host: FedHost,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    for (const p of host.store.loadPeers()) {
      const v = verifyDescriptor(p.descriptor, host.now());
      // Stored descriptors may have aged past the freshness window; keep them as offline entries.
      if (v.ok || p.descriptor?.body?.id === p.id) {
        this.known.set(p.id, {
          id: p.id, signed: p.descriptor, desc: p.descriptor.body, linked: p.linked, lastSeen: p.lastSeen, urlVerified: p.linked,
        });
      }
    }
  }

  trustOf(serverId: string): TrustLevel {
    return this.host.config.trust[serverId] ?? this.host.config.defaultTrust;
  }

  isOnline(k: KnownServer): boolean {
    return this.host.now() - k.lastSeen < PEER_TIMEOUT_MS;
  }

  links(): KnownServer[] {
    return [...this.known.values()].filter((k) => k.linked);
  }

  /** Registers a handler for `POST /fed/x/<topic>` messages from linked servers. */
  handle(topic: string, fn: (from: KnownServer, payload: unknown) => unknown | Promise<unknown>): void {
    this.topics.set(topic, fn);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.gossipRound(), GOSSIP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------------------------
  // Directory
  // -------------------------------------------------------------------------------------------

  /** Validates and stores a descriptor. Returns the entry when it was new or newer. */
  private accept(signed: unknown, direct: boolean): KnownServer | null {
    const v = verifyDescriptor(signed, this.host.now());
    if (!v.ok) return null;
    const desc = v.value.body;
    if (desc.id === this.host.id) return null;
    if (this.trustOf(desc.id) === 'blocked') return null;
    const have = this.known.get(desc.id);
    if (have && have.desc.updatedAt >= desc.updatedAt) {
      if (direct) have.lastSeen = this.host.now();
      return direct ? have : null;
    }
    if (!have && this.known.size >= MAX_KNOWN) return null;
    const entry: KnownServer = {
      id: desc.id,
      signed: v.value,
      desc,
      linked: have?.linked ?? false,
      // A changed URL has to be verified again before we call it.
      urlVerified: (have?.urlVerified ?? false) && have?.desc.url === desc.url,
      lastSeen: direct ? this.host.now() : Math.max(have?.lastSeen ?? 0, Math.min(desc.updatedAt, this.host.now())),
    };
    this.known.set(desc.id, entry);
    this.persist(entry);
    this.onChange();
    return entry;
  }

  private persist(k: KnownServer): void {
    const row: StoredPeer = { id: k.id, descriptor: k.signed, linked: k.linked, lastSeen: k.lastSeen };
    this.host.store.savePeer(row);
  }

  private gossipPayload(): { descriptor: Signed<ServerDescriptor>; known: Signed<ServerDescriptor>[] } {
    const known = [...this.known.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_GOSSIP)
      .map((k) => k.signed);
    return { descriptor: this.host.descriptor(), known };
  }

  // -------------------------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------------------------

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_DESCRIPTOR_BYTES * MAX_GOSSIP) throw new Error('response too large');
    return JSON.parse(text);
  }

  /** Sends a signed request to another server and returns its JSON reply. */
  async call(to: KnownServer, path: string, payload: unknown): Promise<unknown> {
    if (!to.urlVerified) await this.verifyUrl(to);
    const env = signEnvelope(this.host.id, to.id, payload, randomNonce(), this.host.now(), this.host.keys);
    const res = await this.fetchImpl(to.desc.url + path, {
      method: 'POST',
      body: JSON.stringify(env),
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (text.length > MAX_DESCRIPTOR_BYTES * MAX_GOSSIP) throw new Error('response too large');
    to.lastSeen = this.host.now();
    return JSON.parse(text);
  }

  /** Sends a module-defined message to a linked server. */
  send(to: KnownServer, topic: string, payload: unknown): Promise<unknown> {
    return this.call(to, '/fed/x/' + topic, payload);
  }

  /** Confirms that a server's advertised URL really serves that server id. */
  private async verifyUrl(k: KnownServer): Promise<void> {
    const body = await this.getJson(k.desc.url + '/fed/descriptor');
    const v = verifyDescriptor(body, this.host.now());
    if (!v.ok || v.value.body.id !== k.id) throw new Error(`${k.desc.url} does not serve server ${k.id}`);
    k.urlVerified = true;
  }

  /** Fetches the descriptor served at a base URL, without storing it. */
  async probe(url: string): Promise<{ desc: Signed<ServerDescriptor>; known: Signed<ServerDescriptor>[] } | null> {
    if (!isValidServerUrl(url)) return null;
    try {
      const v = verifyDescriptor(await this.getJson(url + '/fed/descriptor'), this.host.now());
      if (!v.ok) return null;
      let known: Signed<ServerDescriptor>[] = [];
      try {
        const list = await this.getJson(url + '/fed/known');
        if (Array.isArray(list)) {
          known = list.filter((d): d is Signed<ServerDescriptor> => verifyDescriptor(d, this.host.now()).ok).slice(0, MAX_GOSSIP);
        }
      } catch {
        // The directory is optional; the descriptor alone is enough to peer.
      }
      return { desc: v.value, known };
    } catch {
      return null;
    }
  }

  /** Establishes (or refreshes) a link with the server at `url`. Returns true on success. */
  async peerWith(url: string): Promise<boolean> {
    const probed = await this.probe(url);
    if (!probed) return false;
    const id = probed.desc.body.id;
    if (id === this.host.id || this.trustOf(id) === 'blocked') return false;
    const entry = this.accept(probed.desc, true) ?? this.known.get(id);
    if (!entry) return false;
    try {
      // The descriptor may advertise a different URL than the one we were given; `call` confirms
      // that the advertised URL serves this id before anything is sent to it.
      const reply = (await this.call(entry, '/fed/hello', this.gossipPayload())) as { descriptor?: unknown; known?: unknown };
      this.accept(reply.descriptor, true);
      if (Array.isArray(reply.known)) for (const d of reply.known.slice(0, MAX_GOSSIP)) this.accept(d, false);
      const now = this.known.get(id);
      if (!now) return false;
      if (!now.linked) {
        now.linked = true;
        this.host.log(`linked with ${now.desc.name} (${now.id}) at ${now.desc.url}`);
      }
      now.urlVerified = true;
      now.lastSeen = this.host.now();
      this.persist(now);
      this.onChange();
      return true;
    } catch (err) {
      this.host.log(`peering with ${url} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** One round of gossip with every linked server, plus retries of configured peers that are not linked yet. */
  async gossipRound(): Promise<void> {
    const linked = this.links();
    await Promise.all(
      linked.map(async (k) => {
        try {
          const reply = (await this.call(k, '/fed/gossip', this.gossipPayload())) as { descriptor?: unknown; known?: unknown };
          this.accept(reply.descriptor, true);
          if (Array.isArray(reply.known)) for (const d of reply.known.slice(0, MAX_GOSSIP)) this.accept(d, false);
        } catch {
          // An unreachable peer simply ages out of `isOnline`.
        }
      }),
    );
    const linkedUrls = new Set(this.links().map((k) => k.desc.url));
    for (const url of this.host.config.peers) if (!linkedUrls.has(url)) await this.peerWith(url);
  }

  /**
   * Asks the issuer of a transfer ticket to redeem its nonce. Returns true only on an explicit yes.
   * Throws when the issuer cannot be reached.
   */
  async redeem(issuer: KnownServer, nonce: string, playerId: string): Promise<boolean> {
    const reply = (await this.call(issuer, '/fed/redeem', { nonce, playerId })) as { ok?: unknown };
    return reply.ok === true;
  }

  // -------------------------------------------------------------------------------------------
  // Incoming (called by the HTTP layer)
  // -------------------------------------------------------------------------------------------

  /** Verifies the envelope of an incoming request and resolves the sender. */
  private open<T>(body: unknown): { from: KnownServer | null; fromId: string; payload: T } {
    const v = verifyEnvelope<T>(body, this.host.id, this.host.now());
    if (!v.ok) throw new FedError(401, v.reason);
    if (this.trustOf(v.value.from) === 'blocked') throw new FedError(403, 'blocked');
    return { from: this.known.get(v.value.from) ?? null, fromId: v.value.from, payload: v.value.payload };
  }

  /** `POST /fed/hello` and `POST /fed/gossip`. */
  async onGossip(body: unknown, hello: boolean): Promise<unknown> {
    const { fromId, payload } = this.open<{ descriptor?: unknown; known?: unknown }>(body);
    const v = verifyDescriptor(payload?.descriptor, this.host.now());
    if (!v.ok || v.value.body.id !== fromId) throw new FedError(400, 'descriptor does not match sender');

    const existing = this.known.get(fromId);
    if (hello && !existing?.linked) {
      const cfg = this.host.config;
      const invited = cfg.peers.includes(v.value.body.url) || Object.hasOwn(cfg.trust, fromId);
      if (!cfg.openPeering && !invited) throw new FedError(403, 'this server does not accept unsolicited peering');
    } else if (!hello && !existing?.linked) {
      throw new FedError(403, 'not linked; send hello first');
    }

    const entry = this.accept(v.value, true) ?? this.known.get(fromId);
    if (!entry) throw new FedError(503, 'directory full');
    if (hello && !entry.linked) {
      // Before trusting the URL for anything, confirm it serves the claimed id.
      try {
        await this.verifyUrl(entry);
      } catch {
        throw new FedError(400, 'your public URL does not serve your descriptor');
      }
      entry.linked = true;
      this.persist(entry);
      this.host.log(`linked with ${entry.desc.name} (${entry.id}) at ${entry.desc.url}`);
      this.onChange();
    }
    if (Array.isArray(payload.known)) for (const d of payload.known.slice(0, MAX_GOSSIP)) this.accept(d, false);
    return this.gossipPayload();
  }

  /** `POST /fed/x/<topic>`. */
  async onTopic(topic: string, body: unknown): Promise<unknown> {
    const { from, payload } = this.open<unknown>(body);
    if (!from || !from.linked) throw new FedError(403, 'not linked');
    const fn = this.topics.get(topic);
    if (!fn) throw new FedError(404, 'unknown topic');
    from.lastSeen = this.host.now();
    return (await fn(from, payload)) ?? { ok: true };
  }

  /** Verifies an incoming signed request from any known server (used for ticket redemption). */
  openFromKnown<T>(body: unknown): { from: KnownServer; payload: T } {
    const { from, payload } = this.open<T>(body);
    if (!from) throw new FedError(403, 'unknown server');
    return { from, payload };
  }

  knownList(): Signed<ServerDescriptor>[] {
    return [...this.known.values()].slice(0, MAX_GOSSIP).map((k) => k.signed);
  }
}

export class FedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
