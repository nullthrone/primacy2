/**
 * Strict parsing of client messages. Everything a client sends is untrusted: each field is
 * type-checked and range-checked here, and a clean object is rebuilt from the known fields only.
 */
import { MAX_CHAT_LENGTH, normalizePips, type C2S, type Command, type ShipInput } from '@primacy2/shared';

type Check = (x: unknown) => boolean;

const str = (max: number, min = 1): Check => (x) => typeof x === 'string' && x.length >= min && x.length <= max;
const int = (lo: number, hi: number): Check => (x) => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const bool: Check = (x) => typeof x === 'boolean';
const oneOf = (...vals: string[]): Check => (x) => typeof x === 'string' && vals.includes(x);
const nullable = (c: Check): Check => (x) => x === null || c(x);
const fin = (x: unknown, lo: number, hi: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null;

const ID = str(16, 16);
const SYSTEM_ID = (x: unknown): boolean => typeof x === 'string' && /^[a-z2-7]{16}:\d{1,3}$/.test(x);
const ITEM = (x: unknown): boolean => typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x);
const AMOUNT = int(1, 100_000);
const ANCHOR = int(0, 100_000);
const ENTITY = int(1, 0xffffffff);

/** Field specifications per command: `[check, optional]`. Unknown fields are dropped. */
const SPECS: { [K in Command['k']]: Record<string, [Check, boolean?]> } = {
  cruise: { on: [bool], site: [ANCHOR, true] },
  fold: { system: [SYSTEM_ID] },
  foldCancel: {},
  gate: { site: [ANCHOR] },
  target: { id: [nullable(ENTITY)] },
  dock: {},
  undock: {},
  respawn: {},
  chat: { ch: [oneOf('local', 'system', 'sector', 'lattice', 'wing', 'direct')], text: [str(MAX_CHAT_LENGTH * 2)], to: [ID, true] },
  station: {},
  galaxy: {},
  buy: { c: [ITEM], n: [AMOUNT] },
  sell: { c: [ITEM], n: [AMOUNT] },
  refuel: {},
  repair: {},
  buyHull: { hull: [ITEM] },
  fit: { slot: [int(0, 31)], module: [nullable(ITEM)] },
  missionAccept: { id: [str(64)] },
  missionAbandon: { id: [str(64)] },
  missionComplete: { id: [str(64)] },
  jettison: { c: [ITEM], n: [AMOUNT] },
  scan: { body: [int(0, 999)] },
  sellData: {},
  wing: { op: [oneOf('invite', 'accept', 'leave', 'kick')], player: [ID, true] },
  gateFund: { linkId: [str(64)], c: [ITEM, true], n: [AMOUNT, true], credits: [int(1, 1_000_000_000), true] },
  giveFuel: { to: [ENTITY], n: [int(1, 1000)] },
};

function parseCommand(raw: unknown): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const k = (raw as { k?: unknown }).k;
  if (typeof k !== 'string' || !Object.hasOwn(SPECS, k)) return null;
  const spec = SPECS[k as Command['k']];
  const out: Record<string, unknown> = { k };
  for (const [field, [check, optional]] of Object.entries(spec)) {
    const v = (raw as Record<string, unknown>)[field];
    if (v === undefined) {
      if (optional) continue;
      return null;
    }
    if (!check(v)) return null;
    out[field] = v;
  }
  return out as Command;
}

function parseInput(raw: unknown): ShipInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!int(0, 0xffffffff)(r.seq)) return null;
  const th = r.thrust;
  const aim = r.aim;
  if (!Array.isArray(th) || th.length !== 3 || !Array.isArray(aim) || aim.length !== 2) return null;
  const tx = fin(th[0], -1, 1);
  const ty = fin(th[1], -1, 1);
  const tz = fin(th[2], -1, 1);
  // One tick of mouse movement is capped at half a radian per axis.
  const ax = fin(aim[0], -0.5, 0.5);
  const ay = fin(aim[1], -0.5, 0.5);
  const roll = fin(r.roll, -1, 1);
  const throttle = fin(r.throttle, -1, 1);
  if (tx === null || ty === null || tz === null || ax === null || ay === null || roll === null || throttle === null) return null;
  if (!int(0, 0xffff)(r.buttons)) return null;
  // A power setting that is missing or not a valid split becomes the default rather than costing the pilot the input.
  const pips = normalizePips(r.pips);
  return { seq: r.seq as number, thrust: [tx, ty, tz], aim: [ax, ay], roll, throttle, buttons: r.buttons as number, pips };
}

/** Parses a text frame from a client. Returns null for anything malformed. */
export function parseClientMessage(text: string): C2S | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.t) {
    case 'in': {
      const i = parseInput(r.i);
      return i ? { t: 'in', i } : null;
    }
    case 'ping':
      return typeof r.c === 'number' && Number.isFinite(r.c) ? { t: 'ping', c: r.c } : null;
    case 'cmd': {
      if (!int(0, 0x7fffffff)(r.id)) return null;
      const c = parseCommand(r.c);
      return c ? { t: 'cmd', id: r.id as number, c } : null;
    }
    case 'hello':
      return int(0, 1_000_000)(r.proto) ? { t: 'hello', proto: r.proto as number } : null;
    case 'auth': {
      if (typeof r.key !== 'string' || !/^[0-9a-f]{64}$/.test(r.key)) return null;
      if (typeof r.sig !== 'string' || !/^[0-9a-f]{128}$/.test(r.sig)) return null;
      if (typeof r.name !== 'string' || r.name.length > 96) return null;
      // The ticket is validated cryptographically and structurally by `verifyTicket`.
      const ticket = r.ticket && typeof r.ticket === 'object' ? (r.ticket as never) : undefined;
      return { t: 'auth', key: r.key, sig: r.sig, name: r.name, ticket };
    }
    default:
      return null;
  }
}
