/**
 * Binary snapshot codec (server -> client).
 *
 * Layout, little endian:
 *   u8  type (= 1)        u8  flags (bit 0: self present)
 *   u16 entity count      u32 tick          u32 ackSeq
 *   f64 universe time
 *   [self]  u8 mode, u8 fa, u8 chargeKind, u8 pad, i32 anchor, f64 x SELF_F64 (order: see encodeSnapshot)
 *   entity* u32 id, u8 flags, u8 hull %, u8 shield %, u8 pad,
 *           f32 pos xyz (offset from the recipient's own position), f32 vel xyz, i16 quat xyzw
 *
 * Entity positions are offsets from the recipient's ship, so float32 keeps sub-centimetre
 * precision nearby however far the zone is from its anchor.
 */
import type { Quat, Vec3 } from './math.ts';
import type { ChargeKind, FlightMode, ShipState } from './sim/types.ts';

export const SNAPSHOT_TYPE = 1;

export interface SnapshotEntity {
  id: number;
  /** `EntityFlag` bits. */
  flags: number;
  /** Hull and shield as fractions 0..1 (quantised to 1/255). */
  hull: number;
  shield: number;
  /** Offset from the recipient's ship in metres. */
  pos: Vec3;
  vel: Vec3;
  rot: Quat;
}

export interface Snapshot {
  tick: number;
  /** Last input sequence number the server applied for the recipient. */
  ackSeq: number;
  /** Universe time of the tick, seconds. */
  time: number;
  /** The recipient's own authoritative ship state, or null while it has no ship. */
  self: ShipState | null;
  ents: SnapshotEntity[];
}

const SELF_F64 = 27;
const HEADER = 2 + 2 + 4 + 4 + 8;
const SELF_BYTES = 8 + SELF_F64 * 8;
const ENTITY_BYTES = 4 + 4 + 12 + 12 + 8;

const q16 = (x: number): number => Math.max(-32767, Math.min(32767, Math.round(x * 32767)));
const u8 = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const n = Math.min(s.ents.length, 65535);
  const buf = new ArrayBuffer(HEADER + (s.self ? SELF_BYTES : 0) + n * ENTITY_BYTES);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, SNAPSHOT_TYPE); o += 1;
  dv.setUint8(o, s.self ? 1 : 0); o += 1;
  dv.setUint16(o, n, true); o += 2;
  dv.setUint32(o, s.tick >>> 0, true); o += 4;
  dv.setUint32(o, s.ackSeq >>> 0, true); o += 4;
  dv.setFloat64(o, s.time, true); o += 8;

  if (s.self) {
    const me = s.self;
    dv.setUint8(o, me.mode); o += 1;
    dv.setUint8(o, me.fa ? 1 : 0); o += 1;
    dv.setUint8(o, me.chargeKind); o += 1;
    o += 1;
    dv.setInt32(o, me.anchor, true); o += 4;
    const f = [
      me.pos[0], me.pos[1], me.pos[2],
      me.vel[0], me.vel[1], me.vel[2],
      me.rot[0], me.rot[1], me.rot[2], me.rot[3],
      me.angVel[0], me.angVel[1], me.angVel[2],
      me.aim[0], me.aim[1],
      me.throttle, me.cruiseSpeed, me.boost, me.boostCd,
      me.energy, me.heat, me.fuel, me.shield, me.hull,
      me.shieldDelay, me.charge, me.dilation,
    ];
    for (let i = 0; i < SELF_F64; i++) { dv.setFloat64(o, f[i]!, true); o += 8; }
  }

  for (let i = 0; i < n; i++) {
    const e = s.ents[i]!;
    dv.setUint32(o, e.id >>> 0, true); o += 4;
    dv.setUint8(o, e.flags & 255); o += 1;
    dv.setUint8(o, u8(e.hull)); o += 1;
    dv.setUint8(o, u8(e.shield)); o += 1;
    o += 1;
    dv.setFloat32(o, e.pos[0], true); o += 4;
    dv.setFloat32(o, e.pos[1], true); o += 4;
    dv.setFloat32(o, e.pos[2], true); o += 4;
    dv.setFloat32(o, e.vel[0], true); o += 4;
    dv.setFloat32(o, e.vel[1], true); o += 4;
    dv.setFloat32(o, e.vel[2], true); o += 4;
    dv.setInt16(o, q16(e.rot[0]), true); o += 2;
    dv.setInt16(o, q16(e.rot[1]), true); o += 2;
    dv.setInt16(o, q16(e.rot[2]), true); o += 2;
    dv.setInt16(o, q16(e.rot[3]), true); o += 2;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer | ArrayBufferView): Snapshot | null {
  const dv = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.byteLength < HEADER || dv.getUint8(0) !== SNAPSHOT_TYPE) return null;
  let o = 1;
  const hasSelf = (dv.getUint8(o) & 1) === 1; o += 1;
  const n = dv.getUint16(o, true); o += 2;
  const tick = dv.getUint32(o, true); o += 4;
  const ackSeq = dv.getUint32(o, true); o += 4;
  const time = dv.getFloat64(o, true); o += 8;
  if (dv.byteLength !== HEADER + (hasSelf ? SELF_BYTES : 0) + n * ENTITY_BYTES) return null;

  let self: ShipState | null = null;
  if (hasSelf) {
    const mode = dv.getUint8(o) as FlightMode; o += 1;
    const fa = dv.getUint8(o) === 1; o += 1;
    const chargeKind = dv.getUint8(o) as ChargeKind; o += 2;
    const anchor = dv.getInt32(o, true); o += 4;
    const f: number[] = new Array(SELF_F64);
    for (let i = 0; i < SELF_F64; i++) { f[i] = dv.getFloat64(o, true); o += 8; }
    self = {
      mode, anchor, fa, chargeKind,
      pos: [f[0]!, f[1]!, f[2]!],
      vel: [f[3]!, f[4]!, f[5]!],
      rot: [f[6]!, f[7]!, f[8]!, f[9]!],
      angVel: [f[10]!, f[11]!, f[12]!],
      aim: [f[13]!, f[14]!],
      throttle: f[15]!, cruiseSpeed: f[16]!, boost: f[17]!, boostCd: f[18]!,
      energy: f[19]!, heat: f[20]!, fuel: f[21]!, shield: f[22]!, hull: f[23]!,
      shieldDelay: f[24]!,
      charge: f[25]!,
      dilation: f[26]!,
    };
  }

  const ents: SnapshotEntity[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const id = dv.getUint32(o, true); o += 4;
    const flags = dv.getUint8(o); o += 1;
    const hull = dv.getUint8(o) / 255; o += 1;
    const shield = dv.getUint8(o) / 255; o += 2;
    const pos: Vec3 = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]; o += 12;
    const vel: Vec3 = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]; o += 12;
    const rot: Quat = [
      dv.getInt16(o, true) / 32767, dv.getInt16(o + 2, true) / 32767,
      dv.getInt16(o + 4, true) / 32767, dv.getInt16(o + 6, true) / 32767,
    ]; o += 8;
    ents[i] = { id, flags, hull, shield, pos, vel, rot };
  }
  return { tick, ackSeq, time, self, ents };
}
