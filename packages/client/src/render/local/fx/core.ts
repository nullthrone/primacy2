/**
 * Frame state shared by the effects. Live effects keep their positions relative to the zone anchor
 * as plain float64 numbers and are re-based on the camera when they are written into vertex
 * buffers, because the camera moves every frame and the anchor does not.
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
  /** Zone anchor relative to the camera. Anchor coordinates plus this are camera-relative. */
  zx = 0; zy = 0; zz = 0;
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

  /** Takes in a frame. Returns false when the anchor changed, which makes every stored position stale. */
  begin(view: FrameView, zone: Readonly<Vec3>): boolean {
    const jump = Math.abs(zone[0] - this.zx) + Math.abs(zone[1] - this.zy) + Math.abs(zone[2] - this.zz);
    const anchor = view.self ? view.self.state.anchor : this.anchor;
    const same = anchor === this.anchor && view.system.id === this.system && jump < 20000;
    this.anchor = anchor;
    this.system = view.system.id;
    this.view = view;
    this.zx = zone[0]; this.zy = zone[1]; this.zz = zone[2];
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
    if (self) this.touch(self.id, self.rel, self.state.vel, self.rot, HULLS[self.hull]?.radius ?? 10, 1, true);
    if (this.now - this.pruned > 2) {
      this.pruned = this.now;
      this.tracks.forEach(this.prune);
    }
    return same;
  }

  private touch(id: number, rel: Readonly<Vec3>, vel: Readonly<Vec3>, rot: Readonly<Quat>, radius: number, kind: number, own: boolean): void {
    let t = this.tracks.get(id);
    if (!t) {
      t = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, radius, kind, seen: 0, own };
      this.tracks.set(id, t);
    }
    t.x = rel[0] - this.zx; t.y = rel[1] - this.zy; t.z = rel[2] - this.zz;
    t.vx = vel[0]; t.vy = vel[1]; t.vz = vel[2];
    t.qx = rot[0]; t.qy = rot[1]; t.qz = rot[2]; t.qw = rot[3];
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

/** Rotates a ship-local vector into system axes by the orientation of `t`. */
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
