/**
 * Federation primitives shared by servers and clients: descriptors, transfer tickets and their
 * verification. Everything here is pure; replay caches, trust policy and networking live in the server.
 */
import {
  DESCRIPTOR_MAX_AGE_MS,
  MAX_CLOCK_SKEW_MS,
  MAX_NAME_LENGTH,
  MAX_RATED_PEERS,
  MAX_SYSTEMS_PER_SECTOR,
  PROTOCOL_VERSION,
  TICKET_TTL_MS,
} from './constants.ts';
import { Domain, idFromPublicKey, isValidId, signBody, verifySigned, type KeyPair, type Signed } from './crypto.ts';
import { v3, type Vec3 } from './math.ts';
import type { Passport } from './pilot.ts';
import type { ShipLimits } from './trade.ts';
import type { GateState, Security, StarClass, SystemSummary } from './universe/types.ts';

/**
 * How a server rates another one.
 * - `union`: a customs union between operators who know each other. Goods and ships move freely.
 *   It only takes effect when both servers rate each other `union` and publish the same rules
 *   fingerprint; otherwise the relation is treated as `partner` (see `effectiveTier`).
 * - `partner`: trade under the trade balance, plus the tariff.
 * - `visitor`: pilots may enter, but all their cargo is sealed.
 * - `blocked`: no entry.
 */
export type TrustLevel = 'union' | 'partner' | 'visitor' | 'blocked';

export const TRUST_LEVELS: readonly TrustLevel[] = ['union', 'partner', 'visitor', 'blocked'];

/** One end of a warp gate pair as advertised by its server. */
export interface GateLink {
  linkId: string;
  /** Local system id hosting this end. */
  system: string;
  /** Local site anchor id. */
  site: number;
  peer: string;
  remoteSystem: string;
  state: GateState;
  progress: number;
}

export interface ServerRules {
  /** Whether strangers may peer without operator approval. */
  openPeering: boolean;
  /** Rating applied to servers without an explicit entry. */
  defaultTrust: TrustLevel;
  /** Tariff rate (0..1) on cargo imported from `partner` servers. */
  tariff: number;
}

/** What a server publishes about its trade rules, so that others can act on them before a jump. */
export interface TradePolicy {
  /** `rulesFingerprint()` of the server: a hash of its catalog and rule constants. */
  fingerprint: string;
  /** Ids of the servers it rates `union`. */
  union: string[];
  /** Ids of the servers it rates `partner`. */
  partner: string[];
  /** Largest hull, as a catalog price, that a partner's or a visitor's ship may have; null is no limit. */
  shipLimit: ShipLimits;
}

/** Self-certifying public description of a server and its sector. Relayed by gossip. */
export interface ServerDescriptor {
  v: 1;
  /** Must equal `idFromPublicKey(signer)`. */
  id: string;
  name: string;
  /** Public base URL, e.g. `https://example.org:8420`. The WebSocket endpoint is `<url>/ws`. */
  url: string;
  proto: number;
  version: string;
  /** Sector centre, galactic light years. */
  pos: Vec3;
  radius: number;
  systems: SystemSummary[];
  /** Ids of servers this one is directly peered with. */
  links: string[];
  gates: GateLink[];
  rules: ServerRules;
  trade: TradePolicy;
  /** Players currently online. */
  online: number;
  /** Milliseconds since the Unix epoch; newer descriptors replace older ones. */
  updatedAt: number;
}

export interface Arrival {
  kind: 'fold' | 'gate';
  /** Destination system id on the destination server. */
  system: string;
  /** Gate site anchor id at the destination, for `gate` arrivals. */
  site?: number;
  /** Galactic position the ship jumped from (ly); orients the arrival point for fold jumps. */
  from?: Vec3;
}

/** A one-time, destination-bound, expiring permission to continue playing on another server. */
export interface TransferTicket {
  v: 1;
  /** Random, unique per ticket. Redeemed exactly once. */
  nonce: string;
  /** Issuing server id; must match the signing key. */
  issuer: string;
  /** Destination server id. */
  dest: string;
  playerId: string;
  /** Player public key (hex); the destination checks it against the authenticated connection. */
  playerKey: string;
  arrival: Arrival;
  passport: Passport;
  issuedAt: number;
  expiresAt: number;
}

export type VerifyResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const STAR_CLASSES = new Set<string>(['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'NS', 'BH']);
const SECURITY = new Set<string>(['secure', 'frontier', 'lawless']);
const GATE_STATES = new Set<string>(['planned', 'building', 'active', 'dormant']);
const TRUST = new Set<string>(TRUST_LEVELS);

const isVec3 = (x: unknown): x is Vec3 =>
  Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e9);
const isText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

/** True for `http(s)://host[:port]` without credentials, path, query or fragment. */
export function isValidServerUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 200) return false;
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      !u.username && !u.password && !u.search && !u.hash &&
      (u.pathname === '/' || u.pathname === '') &&
      url === u.origin
    );
  } catch {
    return false;
  }
}

export function wsUrlOf(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/ws';
}

export function signDescriptor(desc: ServerDescriptor, keys: KeyPair): Signed<ServerDescriptor> {
  return signBody(Domain.Descriptor, desc, keys);
}

/**
 * Validates a descriptor received from the network. Checks the signature, that the id belongs to
 * the signing key, freshness, and the shape and bounds of every field that is later used.
 */
export function verifyDescriptor(signed: unknown, nowMs: number): VerifyResult<Signed<ServerDescriptor>> {
  if (!verifySigned<ServerDescriptor>(Domain.Descriptor, signed)) return fail('bad signature');
  const d = signed.body as Partial<ServerDescriptor>;
  if (d.v !== 1) return fail('unsupported descriptor version');
  if (!isValidId(d.id) || d.id !== idFromPublicKey(signed.key)) return fail('id does not match key');
  if (!isText(d.name, 48)) return fail('bad name');
  if (!isValidServerUrl(d.url)) return fail('bad url');
  if (d.proto !== PROTOCOL_VERSION) return fail('protocol mismatch');
  if (!isText(d.version, 24)) return fail('bad version');
  if (!isVec3(d.pos)) return fail('bad position');
  if (typeof d.radius !== 'number' || !(d.radius > 0 && d.radius <= 500)) return fail('bad radius');
  if (typeof d.updatedAt !== 'number' || !Number.isFinite(d.updatedAt)) return fail('bad timestamp');
  if (d.updatedAt > nowMs + MAX_CLOCK_SKEW_MS) return fail('timestamp in the future');
  if (d.updatedAt < nowMs - DESCRIPTOR_MAX_AGE_MS) return fail('descriptor expired');
  if (typeof d.online !== 'number' || !(d.online >= 0)) return fail('bad online count');

  if (!Array.isArray(d.systems) || d.systems.length === 0 || d.systems.length > MAX_SYSTEMS_PER_SECTOR) {
    return fail('bad system list');
  }
  const seen = new Set<string>();
  for (const s of d.systems as Partial<SystemSummary>[]) {
    if (!s || typeof s !== 'object') return fail('bad system');
    if (typeof s.id !== 'string' || !s.id.startsWith(d.id + ':') || !/^\d{1,3}$/.test(s.id.slice(d.id.length + 1))) {
      return fail('system id outside own namespace');
    }
    if (seen.has(s.id)) return fail('duplicate system id');
    seen.add(s.id);
    if (!isText(s.name, 48) || !isVec3(s.pos)) return fail('bad system fields');
    if (v3.dist(s.pos, d.pos) > d.radius * 1.5 + 1) return fail('system outside sector');
    if (!STAR_CLASSES.has(s.starClass as StarClass) || !SECURITY.has(s.security as Security)) return fail('bad system class');
    if (typeof s.stations !== 'number' || !(s.stations >= 0 && s.stations <= 64)) return fail('bad station count');
    if (!Array.isArray(s.tags) || s.tags.length > 12 || !s.tags.every((t) => isText(t, 24))) return fail('bad tags');
  }

  if (!Array.isArray(d.links) || d.links.length > 256 || !d.links.every(isValidId)) return fail('bad links');
  if (!Array.isArray(d.gates) || d.gates.length > 64) return fail('bad gates');
  for (const g of d.gates as Partial<GateLink>[]) {
    if (!g || typeof g !== 'object') return fail('bad gate');
    if (!isText(g.linkId, 64) || !seen.has(g.system as string) || !isValidId(g.peer)) return fail('bad gate fields');
    if (typeof g.site !== 'number' || !Number.isInteger(g.site)) return fail('bad gate site');
    if (!isText(g.remoteSystem, 24) || !GATE_STATES.has(g.state as string)) return fail('bad gate state');
    if (typeof g.progress !== 'number' || !(g.progress >= 0 && g.progress <= 1)) return fail('bad gate progress');
  }

  const r = d.rules as Partial<ServerRules> | undefined;
  if (!r || typeof r.openPeering !== 'boolean' || !TRUST.has(r.defaultTrust as string)) return fail('bad rules');
  if (typeof r.tariff !== 'number' || !(r.tariff >= 0 && r.tariff <= 1)) return fail('bad tariff');

  const tp = d.trade as Partial<TradePolicy> | undefined;
  if (!tp || typeof tp !== 'object' || typeof tp.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(tp.fingerprint)) {
    return fail('bad trade policy');
  }
  for (const list of [tp.union, tp.partner]) {
    if (!Array.isArray(list) || list.length > MAX_RATED_PEERS || !list.every(isValidId)) return fail('bad trade ratings');
  }
  const caps = tp.shipLimit as Partial<ShipLimits> | undefined;
  const isCap = (x: unknown): boolean => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0);
  if (!caps || typeof caps !== 'object' || !isCap(caps.partner) || !isCap(caps.visitor)) return fail('bad ship limits');
  return { ok: true, value: signed };
}

export interface IssueTicketParams {
  issuer: string;
  dest: string;
  playerKey: string;
  passport: Passport;
  arrival: Arrival;
  nonce: string;
  nowMs: number;
}

export function issueTicket(p: IssueTicketParams, keys: KeyPair): Signed<TransferTicket> {
  const ticket: TransferTicket = {
    v: 1,
    nonce: p.nonce,
    issuer: p.issuer,
    dest: p.dest,
    playerId: idFromPublicKey(p.playerKey),
    playerKey: p.playerKey,
    arrival: p.arrival,
    passport: p.passport,
    issuedAt: p.nowMs,
    expiresAt: p.nowMs + TICKET_TTL_MS,
  };
  return signBody(Domain.Ticket, ticket, keys);
}

export interface TicketContext {
  /** This server's id; the ticket must be addressed to it. */
  selfId: string;
  /** Public key the connection authenticated with. */
  playerKey: string;
  nowMs: number;
}

/**
 * Cryptographic and structural checks on a transfer ticket. The caller must additionally:
 * confirm the issuer is a known, non-blocked server; reject a nonce it has already seen;
 * redeem the nonce with the issuer; and pass `passport` through `sanitizePassport`.
 */
export function verifyTicket(signed: unknown, ctx: TicketContext): VerifyResult<TransferTicket> {
  if (!verifySigned<TransferTicket>(Domain.Ticket, signed)) return fail('bad signature');
  const t = signed.body as Partial<TransferTicket>;
  if (t.v !== 1) return fail('unsupported ticket version');
  if (!isValidId(t.issuer) || t.issuer !== idFromPublicKey(signed.key)) return fail('issuer does not match key');
  if (t.issuer === ctx.selfId) return fail('ticket issued by this server');
  if (t.dest !== ctx.selfId) return fail('ticket is for another server');
  if (typeof t.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(t.nonce)) return fail('bad nonce');
  if (typeof t.playerKey !== 'string' || t.playerKey !== ctx.playerKey) return fail('ticket belongs to another player');
  if (t.playerId !== idFromPublicKey(ctx.playerKey)) return fail('player id mismatch');
  if (typeof t.issuedAt !== 'number' || typeof t.expiresAt !== 'number') return fail('bad timestamps');
  if (!Number.isFinite(t.issuedAt) || !Number.isFinite(t.expiresAt)) return fail('bad timestamps');
  if (t.expiresAt - t.issuedAt > TICKET_TTL_MS || t.expiresAt <= t.issuedAt) return fail('bad validity window');
  if (t.issuedAt > ctx.nowMs + MAX_CLOCK_SKEW_MS) return fail('ticket from the future');
  if (ctx.nowMs > t.expiresAt) return fail('ticket expired');
  const a = t.arrival as Partial<Arrival> | undefined;
  if (!a || (a.kind !== 'fold' && a.kind !== 'gate')) return fail('bad arrival');
  if (typeof a.system !== 'string' || !a.system.startsWith(ctx.selfId + ':')) return fail('arrival outside this sector');
  if (a.site !== undefined && (typeof a.site !== 'number' || !Number.isInteger(a.site))) return fail('bad arrival site');
  if (a.from !== undefined && !isVec3(a.from)) return fail('bad arrival origin');
  if (!t.passport || typeof t.passport !== 'object') return fail('missing passport');
  return { ok: true, value: t as TransferTicket };
}

/** Body of a signed server-to-server request. */
export interface FedEnvelope<T> {
  from: string;
  to: string;
  /** Milliseconds since the Unix epoch. */
  at: number;
  nonce: string;
  payload: T;
}

export function signEnvelope<T>(from: string, to: string, payload: T, nonce: string, nowMs: number, keys: KeyPair): Signed<FedEnvelope<T>> {
  return signBody(Domain.Fed, { from, to, at: nowMs, nonce, payload }, keys);
}

/** Verifies a server-to-server request: signature, sender id, addressee and freshness. */
export function verifyEnvelope<T>(signed: unknown, selfId: string, nowMs: number): VerifyResult<FedEnvelope<T>> {
  if (!verifySigned<FedEnvelope<T>>(Domain.Fed, signed)) return fail('bad signature');
  const e = signed.body as Partial<FedEnvelope<T>>;
  if (!isValidId(e.from) || e.from !== idFromPublicKey(signed.key)) return fail('sender does not match key');
  if (e.to !== selfId) return fail('wrong addressee');
  if (typeof e.at !== 'number' || Math.abs(nowMs - e.at) > MAX_CLOCK_SKEW_MS) return fail('stale request');
  if (typeof e.nonce !== 'string' || e.nonce.length < 16 || e.nonce.length > 64) return fail('bad nonce');
  return { ok: true, value: e as FedEnvelope<T> };
}

/** Player names shown across the federation are qualified with the first characters of the home id. */
export const displayNameLimit = MAX_NAME_LENGTH;
