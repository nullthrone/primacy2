/**
 * Galaxy-wide chat: messages on the `lattice` channel are relayed to linked servers, which show
 * them and pass them on once more. Every relayed message is treated as hostile input.
 */
import { MAX_CHAT_LENGTH, randomNonce, sanitizeName, type ChatMessage } from '@primacy2/shared';
import type { GameModule } from '../game.ts';
import type { World } from '../world.ts';
import { cleanChat } from './core.ts';

interface Relay {
  /** Unique id; servers drop messages they have already seen. */
  id: string;
  /** Server the message was written on. */
  origin: string;
  hops: number;
  from: { id: string; name: string };
  text: string;
  at: number;
}

/** Messages travel at most this many links from their origin. */
const MAX_HOPS = 2;
/** Relayed messages accepted from one server per ten seconds. */
const RATE = 20;

const seen = new Map<string, number>();
const buckets = new Map<string, { start: number; n: number }>();

function forward(world: World, msg: Relay, except: string | null): void {
  for (const k of world.fed.links()) {
    if (k.id === except || k.id === msg.origin || !world.fed.isOnline(k)) continue;
    if (world.fed.trustOf(k.id) === 'blocked') continue;
    void world.fed.send(k, 'chat', msg).catch(() => {});
  }
}

export const commsModule: GameModule = {
  name: 'comms',

  init(world) {
    // Messages written here: show them locally (the core does) and send them out.
    world.onLatticeChat = (m: ChatMessage) => {
      const msg: Relay = { id: randomNonce(), origin: world.id, hops: 0, from: m.from, text: m.text, at: m.at };
      seen.set(msg.id, world.host.now());
      forward(world, msg, null);
    };

    world.fed.handle('chat', (from, payload) => {
      const now = world.host.now();
      const b = buckets.get(from.id);
      if (!b || now - b.start > 10_000) buckets.set(from.id, { start: now, n: 1 });
      else if (++b.n > RATE) return { ok: false };

      const r = payload as Partial<Relay> | null;
      if (!r || typeof r.id !== 'string' || r.id.length < 16 || r.id.length > 64) return { ok: false };
      if (typeof r.origin !== 'string' || !/^[a-z2-7]{16}$/.test(r.origin) || r.origin === world.id) return { ok: false };
      if (typeof r.hops !== 'number' || !(r.hops >= 0 && r.hops < MAX_HOPS)) return { ok: false };
      if (typeof r.text !== 'string' || r.text.length > MAX_CHAT_LENGTH * 2 || !r.from || typeof r.from.id !== 'string') return { ok: false };
      if (world.fed.trustOf(r.origin) === 'blocked') return { ok: false };
      if (seen.has(r.id)) return { ok: true };
      if (seen.size > 5000) {
        for (const [id, at] of seen) if (now - at > 120_000) seen.delete(id);
        if (seen.size > 5000) seen.clear();
      }
      seen.set(r.id, now);

      const text = cleanChat(r.text);
      if (!text) return { ok: false };
      const msg: Relay = {
        id: r.id, origin: r.origin, hops: r.hops + 1, text,
        from: { id: r.from.id.slice(0, 16), name: sanitizeName(r.from.name) },
        // A relayed timestamp is not trusted; the message is shown as arriving now.
        at: now,
      };
      world.broadcast({ t: 'chat', m: { ch: 'lattice', from: { ...msg.from, server: msg.origin }, text, at: now } });
      if (msg.hops < MAX_HOPS) forward(world, msg, from.id);
      return { ok: true };
    });
  },
};
