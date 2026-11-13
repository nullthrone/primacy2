/**
 * Frame state shared by the effects. Live effects keep their positions relative to the zone anchor
 * as plain float64 numbers and are re-based on the camera when they are written into vertex
 * buffers, because the camera moves every frame and the anchor does not.
 *
 * Everything the effects store is in the axes of the zone's frame: positions, velocities,
 * orientations, and the camera-relative positions they write into their buffers. In space those
 * are system axes. In a surface frame they turn with the body (`FrameView.zoneRot`), which is
 * what keeps a blast on the ground on the ground. The effects part turns its whole subtree by
 * `Frame.q*` when it draws, so no effect has to know about it; what an effect takes from the
 * frame view itself is brought into zone axes here.
 */
import { HULLS } from '@primacy2/shared';
import type { Quat, Vec3 } from '@primacy2/shared';
import type { FrameView } from '../../../contracts.ts';
import { TAU } from '../util.ts';

/**
 * Where an entity was last seen, relative to the zone anchor. Kept for a few seconds after the
 * entity left the view, so an explosion still knows the size of what blew up.
 */
export interface Track {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number;
  radius: number;
  /** `EntityKind`. */
  kind: number;
  /** Effect time at which the entity was last in the view. */
  seen: number;
  /** True for the pilot's own ship. */
  own: boolean;
}

/** A fixed set of preallocated items; the live ones are packed at the front. */
export class Pool<T> {
  readonly items: T[];
  count = 0;

  constructor(max: number, make: () => T) {
    this.items = Array.from({ length: max }, make);
  }

  /** The next free item, or null when all are in use. */
  take(): T | null {
    return this.count < this.items.length ? this.items[this.count++]! : null;
  }

  /** Frees item `i` by swapping the last live item into its place; iterate downwards while freeing. */
  free(i: number): void {
    const last = --this.count;
    const item = this.items[i]!;
    this.items[i] = this.items[last]!;
    this.items[last] = item;
  }
}

export class Frame {
  view!: FrameView;
  /** Zone anchor relative to the camera, in zone axes. Anchor coordinates plus this are camera-relative, in zone axes. */
  zx = 0; zy = 0; zz = 0;
  /** Orientation of the zone's axes in system axes (`FrameView.zoneRot`); the identity in space. */
  qx = 0; qy = 0; qz = 0; qw = 1;
  dt = 0;
  /** Effect time in seconds, summed from frame times. */
  now = 0;
  quality: 0 | 1 | 2 = 2;
  readonly tracks = new Map<number, Track>();
  private anchor: unknown = undefined;
  private system: unknown = undefined;
  private pruned = 0;
  private readonly prune = (t: Track, id: number): void => {
    if (this.now - t.seen > 6) this.tracks.delete(id);
  };

  /**
   * Takes in a frame; `zone` is `view.zone`. Returns false when the anchor changed, which makes
   * every stored position stale.
   */
  begin(view: FrameView, zone: Readonly<Vec3>): boolean {
    const q = view.zoneRot;
    this.qx = q ? q[0] : 0; this.qy = q ? q[1] : 0; this.qz = q ? q[2] : 0; this.qw = q ? q[3] : 1;
    this.unrotate(zone[0], zone[1], zone[2], Z);
    const jump = Math.abs(Z[0] - this.zx) + Math.abs(Z[1] - this.zy) + Math.abs(Z[2] - this.zz);
    const anchor = view.self ? view.self.state.anchor : this.anchor;
    const same = anchor === this.anchor && view.system.id === this.system && jump < 20000;
    this.anchor = anchor;
    this.system = view.system.id;
    this.view = view;
    this.zx = Z[0]; this.zy = Z[1]; this.zz = Z[2];
    this.dt = view.dt;
    this.now += view.dt;
    this.quality = view.graphics.quality;
    if (!same) this.tracks.clear();

    const ents = view.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      this.touch(e.id, e.rel, e.vel, e.rot, e.info.radius, e.info.kind, false);
    }
    const self = view.self;
    if (self) this.touch(self.id, self.rel, self.vel, self.rot, HULLS[self.hull]?.radius ?? 10, 1, true);
    if (this.now - this.pruned > 2) {
      this.pruned = this.now;
      this.tracks.forEach(this.prune);
    }
    return same;
  }

  /** Writes the vector (x, y, z), given in system axes, into `out` in zone axes. */
  private unrotate(x: number, y: number, z: number, out: Vec3): void {
    if (this.qw === 1) {
      out[0] = x; out[1] = y; out[2] = z;
      return;
    }
    // Rotation by the conjugate of the zone orientation.
    const qx = -this.qx, qy = -this.qy, qz = -this.qz, qw = this.qw;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  /** Records where an entity is: `rel`, `vel` and `rot` come from the frame view, in system axes. */
  private touch(id: number, rel: Readonly<Vec3>, vel: Readonly<Vec3>, rot: Readonly<Quat>, radius: number, kind: number, own: boolean): void {
    let t = this.tracks.get(id);
    if (!t) {
      t = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, radius, kind, seen: 0, own };
      this.tracks.set(id, t);
    }
    this.unrotate(rel[0], rel[1], rel[2], Z);
    t.x = Z[0] - this.zx; t.y = Z[1] - this.zy; t.z = Z[2] - this.zz;
    this.unrotate(vel[0], vel[1], vel[2], Z);
    t.vx = Z[0]; t.vy = Z[1]; t.vz = Z[2];
    if (this.qw === 1) {
      t.qx = rot[0]; t.qy = rot[1]; t.qz = rot[2]; t.qw = rot[3];
    } else {
      // Orientation in zone axes: the conjugate of the zone orientation times the orientation.
      const ax = -this.qx, ay = -this.qy, az = -this.qz, aw = this.qw;
      t.qx = aw * rot[0] + ax * rot[3] + ay * rot[2] - az * rot[1];
      t.qy = aw * rot[1] - ax * rot[2] + ay * rot[3] + az * rot[0];
      t.qz = aw * rot[2] + ax * rot[1] - ay * rot[0] + az * rot[3];
      t.qw = aw * rot[3] - ax * rot[0] - ay * rot[1] - az * rot[2];
    }
    t.radius = radius;
    t.kind = kind;
    t.seen = this.now;
    t.own = own;
  }

  /** Where weapon `slot` of a ship sits, in anchor coordinates: its mount on the own ship, the nose of any other. */
  muzzle(t: Track, slot: number, out: Vec3): void {
    const mount = t.own ? this.view.self?.stats.weapons[slot] : undefined;
    if (mount) rotate(t, mount.offset[0], mount.offset[1], mount.offset[2], out);
    else rotate(t, 0, 0, -0.8 * t.radius, out);
    out[0] += t.x; out[1] += t.y; out[2] += t.z;
  }

  /**
   * The point on a sphere of `frac` radii around an entity that faces the point (px, py, pz), or
   * the camera when that point is the centre itself.
   */
  surface(t: Track, px: number, py: number, pz: number, frac: number, out: Vec3): void {
    let dx = px - t.x, dy = py - t.y, dz = pz - t.z;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) {
      dx = -this.zx - t.x; dy = -this.zy - t.y; dz = -this.zz - t.z;
      d = Math.hypot(dx, dy, dz) || 1;
    }
    const k = (t.radius * frac) / d;
    out[0] = t.x + dx * k; out[1] = t.y + dy * k; out[2] = t.z + dz * k;
  }
}

// Scratch for vectors brought into zone axes.
const Z: Vec3 = [0, 0, 0];

/** Rotates a ship-local vector into zone axes by the orientation of `t`. */
export function rotate(t: Track, vx: number, vy: number, vz: number, out: Vec3): void {
  const tx = 2 * (t.qy * vz - t.qz * vy);
  const ty = 2 * (t.qz * vx - t.qx * vz);
  const tz = 2 * (t.qx * vy - t.qy * vx);
  out[0] = vx + t.qw * tx + (t.qy * tz - t.qz * ty);
  out[1] = vy + t.qw * ty + (t.qz * tx - t.qx * tz);
  out[2] = vz + t.qw * tz + (t.qx * ty - t.qy * tx);
}

/** A uniformly random unit vector. */
export function randDir(out: Vec3): void {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * TAU;
  const s = Math.sqrt(1 - z * z);
  out[0] = s * Math.cos(a); out[1] = s * Math.sin(a); out[2] = z;
}

/** A random unit vector around the unit vector n: `spread` 0 is n itself, 1 the whole hemisphere. */
export function randCone(nx: number, ny: number, nz: number, spread: number, out: Vec3): void {
  randDir(out);
  const x = nx + out[0] * spread, y = ny + out[1] * spread, z = nz + out[2] * spread;
  const d = Math.hypot(x, y, z);
  if (d < 1e-4) { out[0] = nx; out[1] = ny; out[2] = nz; return; }
  out[0] = x / d; out[1] = y / d; out[2] = z / d;
}

export const rand = (lo: number, hi: number): number => lo + (hi - lo) * Math.random();
