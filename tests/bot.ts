/**
 * A headless game client for integration tests: speaks the real protocol over a real WebSocket.
 */
import WebSocket from 'ws';
import {
  Domain,
  PROTOCOL_VERSION,
  authMessage,
  decodeSnapshot,
  generateKeyPair,
  idFromPublicKey,
  signText,
  wsUrlOf,
  type C2S,
  type ChatMessage,
  type Command,
  type EntityInfo,
  type GalaxyView,
  type GameEvent,
  type KeyPair,
  type PilotView,
  type S2C,
  type ShipInput,
  type Signed,
  type Snapshot,
  type StationView,
  type SystemDef,
  type TransferTicket,
} from '@primacy2/shared';

export interface BotOptions {
  keys?: KeyPair;
  name?: string;
  ticket?: Signed<TransferTicket>;
}

export type CmdReply = { ok: boolean; err?: string; data?: unknown };

export class Bot {
  readonly keys: KeyPair;
  readonly id: string;
  name: string;
  pilot: PilotView | null = null;
  serverId = '';
  system: SystemDef | null = null;
  selfId = 0;
  snap: Snapshot | null = null;
  snapshots = 0;
  station: StationView | null = null;
  galaxy: GalaxyView | null = null;
  handoff: Extract<S2C, { t: 'handoff' }> | null = null;
  authFail: Extract<S2C, { t: 'authFail' }> | null = null;
  kicked: string | null = null;
  closed = false;
  readonly events: GameEvent[] = [];
  readonly chats: ChatMessage[] = [];
  readonly notices: Extract<S2C, { t: 'notice' }>[] = [];
  readonly ents = new Map<number, EntityInfo>();
  /** Input held until changed; sent by `sendInput`. */
  held: Omit<ShipInput, 'seq'> = { thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0 };

  private ws!: WebSocket;
  private seq = 0;
  private cmdId = 0;
  private readonly pending = new Map<number, (r: CmdReply) => void>();
  private ready!: () => void;
  private failed!: (err: Error) => void;

  private constructor(opts: BotOptions) {
    this.keys = opts.keys ?? generateKeyPair();
    this.id = idFromPublicKey(this.keys.publicKey);
    this.name = opts.name ?? 'Bot';
  }

  /** Connects and authenticates. Resolves after `welcome` and the first `system`; rejects on refusal. */
  static connect(serverUrl: string, opts: BotOptions = {}): Promise<Bot> {
    const bot = new Bot(opts);
    return new Promise<Bot>((resolve, reject) => {
      bot.ready = () => resolve(bot);
      bot.failed = reject;
      const ws = new WebSocket(wsUrlOf(serverUrl));
      bot.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.on('open', () => bot.send({ t: 'hello', proto: PROTOCOL_VERSION }));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const snap = decodeSnapshot(data as ArrayBuffer);
          if (snap) {
            bot.snap = snap;
            bot.snapshots++;
          }
          return;
        }
        bot.onMessage(JSON.parse(data.toString()) as S2C, opts);
      });
      ws.on('close', () => {
        bot.closed = true;
        reject(Object.assign(new Error(bot.authFail?.msg ?? bot.kicked ?? 'closed'), { bot }));
      });
      ws.on('error', (err) => reject(err));
    });
  }

  private onMessage(m: S2C, opts: BotOptions): void {
    switch (m.t) {
      case 'challenge':
        this.serverId = m.server.id;
        this.send({
          t: 'auth', key: this.keys.publicKey, name: this.name, ticket: opts.ticket,
          sig: signText(Domain.Auth, authMessage(m.nonce, m.server.id), this.keys.secretKey),
        });
        break;
      case 'authFail':
        this.authFail = m;
        break;
      case 'welcome':
        this.pilot = m.pilot;
        break;
      case 'system':
        this.system = m.def;
        this.selfId = m.self;
        this.ents.clear();
        this.ready();
        break;
      case 'pilot':
        this.pilot = { ...(this.pilot as PilotView), ...m.p };
        break;
      case 'station':
        this.station = m.s;
        break;
      case 'galaxy':
        this.galaxy = m.g;
        break;
      case 'ent+':
        for (const e of m.e) this.ents.set(e.id, e);
        break;
      case 'ent-':
        for (const id of m.ids) this.ents.delete(id);
        break;
      case 'ev':
        this.events.push(...m.e);
        break;
      case 'chat':
        this.chats.push(m.m);
        break;
      case 'notice':
        this.notices.push(m);
        break;
      case 'handoff':
        this.handoff = m;
        break;
      case 'kick':
        this.kicked = m.reason;
        break;
      case 'res': {
        const fn = this.pending.get(m.id);
        this.pending.delete(m.id);
        fn?.({ ok: m.ok, err: m.err, data: m.data });
        break;
      }
      default:
        break;
    }
  }

  send(m: C2S): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  sendRaw(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  /** Sends a command; the promise resolves with the server's reply. */
  cmd(c: Command): Promise<CmdReply> {
    const id = ++this.cmdId;
    return new Promise<CmdReply>((resolve) => {
      this.pending.set(id, resolve);
      this.send({ t: 'cmd', id, c });
    });
  }

  /** Sends one tick of the held input. */
  sendInput(): void {
    this.send({ t: 'in', i: { seq: ++this.seq, ...this.held, aim: [...this.held.aim] as [number, number] } });
    this.held.aim = [0, 0];
  }

  get self() {
    return this.snap?.self ?? null;
  }

  close(): void {
    this.ws.close();
  }
}
