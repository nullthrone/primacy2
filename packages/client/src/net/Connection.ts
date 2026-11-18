/**
 * One WebSocket connection to a PRIMACY2 server: handshake, message dispatch, commands.
 */
import {
  Domain,
  PROTOCOL_VERSION,
  authMessage,
  decodeSnapshot,
  signText,
  wsUrlOf,
  type C2S,
  type Command,
  type KeyPair,
  type S2C,
  type Signed,
  type Snapshot,
  type TransferTicket,
} from '@primacy2/shared';
import type { CmdReply } from '../contracts.ts';

export type Welcome = Extract<S2C, { t: 'welcome' }>;
export type AuthFail = Extract<S2C, { t: 'authFail' }>;

export interface ConnectionHandlers {
  onMessage(m: S2C): void;
  onSnapshot(s: Snapshot): void;
  /** The socket closed after a successful login. */
  onClose(reason: string): void;
}

/** Why a connection attempt failed. `fail` is set when the server refused the login. */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly fail: AuthFail | null = null,
  ) {
    super(message);
  }
}

const COMMAND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 12_000;

/** Removes trailing slashes and falls back to the page's own origin for an empty address. */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return location.origin;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export class Connection {
  serverId = '';
  serverName = '';
  ready = false;
  private ws: WebSocket | null = null;
  private cmdId = 0;
  private closedByUs = false;
  private readonly pending = new Map<number, { resolve: (r: CmdReply) => void; timer: number }>();

  constructor(
    readonly url: string,
    private readonly keys: KeyPair,
    private readonly name: string,
    private readonly ticket: Signed<TransferTicket> | undefined,
    private readonly handlers: ConnectionHandlers,
  ) {}

  /** Connects and logs in. Resolves with the welcome message; rejects with a `ConnectError`. */
  open(): Promise<Welcome> {
    return new Promise<Welcome>((resolve, reject) => {
      if (location.protocol === 'https:' && this.url.startsWith('http://')) {
        reject(new ConnectError('This page was loaded over HTTPS, so it cannot reach a server without TLS. Open that server directly or ask its operator to enable HTTPS.'));
        return;
      }
      let settled = false;
      let fail: AuthFail | null = null;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrlOf(this.url));
      } catch {
        reject(new ConnectError('That is not a valid server address.'));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new ConnectError('The server did not answer in time.'));
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => this.send({ t: 'hello', proto: PROTOCOL_VERSION });
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          const snap = decodeSnapshot(ev.data as ArrayBuffer);
          if (snap && this.ready) this.handlers.onSnapshot(snap);
          return;
        }
        let m: S2C;
        try {
          m = JSON.parse(ev.data) as S2C;
        } catch {
          return;
        }
        switch (m.t) {
          case 'challenge':
            this.serverId = m.server.id;
            this.serverName = m.server.name;
            this.send({
              t: 'auth', key: this.keys.publicKey, name: this.name, ticket: this.ticket,
              sig: signText(Domain.Auth, authMessage(m.nonce, m.server.id), this.keys.secretKey),
            });
            return;
          case 'authFail':
            fail = m;
            return;
          case 'welcome':
            this.ready = true;
            if (!settled) {
              settled = true;
              window.clearTimeout(timer);
              resolve(m);
            }
            return;
          case 'res': {
            const p = this.pending.get(m.id);
            if (p) {
              this.pending.delete(m.id);
              window.clearTimeout(p.timer);
              p.resolve(m.ok ? { ok: true, data: m.data } : { ok: false, err: m.err ?? 'Refused.', data: m.data });
            }
            return;
          }
          default:
            if (this.ready) this.handlers.onMessage(m);
        }
      };
      ws.onclose = (ev) => {
        window.clearTimeout(timer);
        for (const p of this.pending.values()) {
          window.clearTimeout(p.timer);
          p.resolve({ ok: false, err: 'Connection lost.' });
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new ConnectError(fail?.msg ?? 'Could not connect to the server.', fail));
        } else if (this.ready && !this.closedByUs) {
          this.handlers.onClose(ev.reason || 'Connection lost.');
        }
        this.ready = false;
      };
    });
  }

  send(m: C2S): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Sends a command. Always resolves: with the server's reply, or with an error after a timeout. */
  cmd(c: Command): Promise<CmdReply> {
    if (!this.ready) return Promise.resolve({ ok: false, err: 'Not connected.' });
    const id = ++this.cmdId;
    return new Promise<CmdReply>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, err: 'The server did not answer.' });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send({ t: 'cmd', id, c });
    });
  }

  close(): void {
    this.closedByUs = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      // Closing an already closed socket is fine.
    }
  }
}
