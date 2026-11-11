/**
 * One WebSocket connection: handshake (hello -> challenge -> auth), then inputs and commands.
 */
import type { WebSocket } from 'ws';
import {
  Domain,
  GAME_VERSION,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  TICK_RATE,
  authMessage,
  encodeMsg,
  idFromPublicKey,
  randomNonce,
  verifyText,
  type S2C,
} from '@primacy2/shared';
import type { Connection, Player } from './game.ts';
import { parseClientMessage } from './validate.ts';
import type { World } from './world.ts';

const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Messages allowed per second before the connection is dropped. */
const RATE_LIMIT = TICK_RATE * 3 + 40;
const COMMANDS_PER_SECOND = 20;

export class Session implements Connection {
  private state: 'new' | 'challenged' | 'authing' | 'ready' | 'closed' = 'new';
  private nonce = '';
  private player: Player | null = null;
  private windowStart = 0;
  private windowCount = 0;
  private commandCount = 0;
  private lastInputSeq = -1;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly ws: WebSocket,
    private readonly world: World,
  ) {
    this.timer = setTimeout(() => {
      if (this.state !== 'ready') this.close('Handshake timed out.');
    }, HANDSHAKE_TIMEOUT_MS);
    this.timer.unref?.();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.close('Unexpected binary frame.');
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
      this.onMessage(text);
    });
    ws.on('close', () => this.onClose());
    ws.on('error', () => this.onClose());
  }

  send(text: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(text);
  }

  sendBinary(data: ArrayBuffer): void {
    // Snapshots are disposable: when the socket is backed up, skip rather than queue stale state.
    if (this.ws.readyState === this.ws.OPEN && this.ws.bufferedAmount < 256 * 1024) this.ws.send(data, { binary: true });
  }

  private sendMsg(m: S2C): void {
    this.send(encodeMsg(m));
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    try {
      this.sendMsg({ t: 'kick', reason });
      this.ws.close(1000, reason.slice(0, 100));
    } catch {
      this.ws.terminate();
    }
    this.onClose();
  }

  private onClose(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    const p = this.player;
    this.player = null;
    // Only log out when this is still the pilot's current connection (a newer login may have replaced it).
    if (p && p.conn === this) this.world.logout(p);
  }

  private overLimit(): boolean {
    // The server clock, not Date.now(): tests run simulated time much faster than wall time.
    const now = this.world.host.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
      this.commandCount = 0;
    }
    return ++this.windowCount > RATE_LIMIT;
  }

  private onMessage(text: string): void {
    if (this.state === 'closed') return;
    if (text.length > MAX_MESSAGE_BYTES) return this.close('Message too large.');
    if (this.overLimit()) return this.close('Too many messages.');
    const msg = parseClientMessage(text);
    if (!msg) {
      // Malformed input before authentication ends the connection; afterwards it is ignored.
      if (this.state !== 'ready') this.close('Malformed message.');
      return;
    }

    switch (msg.t) {
      case 'hello': {
        if (this.state !== 'new') return;
        if (msg.proto !== PROTOCOL_VERSION) {
          this.sendMsg({ t: 'authFail', code: 'proto', msg: `This server speaks protocol ${PROTOCOL_VERSION}; reload the game.` });
          return this.close('Protocol mismatch.');
        }
        this.nonce = randomNonce();
        this.state = 'challenged';
        this.sendMsg({
          t: 'challenge', nonce: this.nonce,
          server: { id: this.world.id, name: this.world.config.name, proto: PROTOCOL_VERSION, version: GAME_VERSION },
        });
        return;
      }
      case 'auth': {
        if (this.state !== 'challenged') return;
        this.state = 'authing';
        if (!verifyText(Domain.Auth, authMessage(this.nonce, this.world.id), msg.sig, msg.key)) {
          this.sendMsg({ t: 'authFail', code: 'signature', msg: 'Signature check failed.' });
          return this.close('Authentication failed.');
        }
        const playerId = idFromPublicKey(msg.key);
        void this.world.login(this, msg.key, playerId, msg.name, msg.ticket).then(
          (res) => {
            if (this.state !== 'authing') {
              // The socket closed while the ticket was being checked.
              if (res.ok && res.player.conn === this) this.world.logout(res.player);
              return;
            }
            if (!res.ok) {
              this.sendMsg({ t: 'authFail', code: res.code, msg: res.msg, redirect: res.redirect });
              return this.close('Login refused.');
            }
            this.player = res.player;
            this.state = 'ready';
            clearTimeout(this.timer);
            const w = this.world;
            this.sendMsg({
              t: 'welcome', pilot: w.pilotView(res.player),
              server: { id: w.id, name: w.config.name, rules: w.host.descriptor().body.rules },
              universeTime: w.time(), tick: w.tickCount,
            });
            w.greet(res.player);
          },
          () => this.close('Login failed.'),
        );
        return;
      }
      case 'ping':
        this.sendMsg({ t: "pong", c: msg.c, s: this.world.host.now(), u: this.world.time() });
        return;
      case 'in': {
        const p = this.player;
        if (this.state !== 'ready' || !p) return;
        // Sequence numbers must increase; anything else is a duplicate or a replay.
        if (msg.i.seq <= this.lastInputSeq) return;
        this.lastInputSeq = msg.i.seq;
        if (p.inputs.length < 30) p.inputs.push(msg.i);
        return;
      }
      case 'cmd': {
        const p = this.player;
        if (this.state !== 'ready' || !p) return;
        if (++this.commandCount > COMMANDS_PER_SECOND) {
          this.sendMsg({ t: 'res', id: msg.id, ok: false, err: 'Too many commands.' });
          return;
        }
        void this.world.handleCommand(p, msg.c).then((res) => {
          if (this.state !== 'ready') return;
          this.sendMsg(res.ok ? { t: 'res', id: msg.id, ok: true, data: res.data } : { t: 'res', id: msg.id, ok: false, err: res.err });
        });
        return;
      }
    }
  }
}
