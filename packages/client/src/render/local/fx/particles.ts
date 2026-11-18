/**
 * The two kinds of short-lived particle everything else spawns: sparks that fly on straight lines
 * and draw as streaks, and flashes that grow or shrink in place and draw as discs.
 */
import { Pool, type Frame } from './core.ts';
import type { Ribbons } from './ribbons.ts';
import { GLOW, PUFF, type Sprites } from './sprites.ts';

interface Spark {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  w: number;
  r: number; g: number; b: number;
  /** Length of the streak in seconds of flight. */
  trail: number;
}

/** Glowing flecks in vacuum: no drag, no gravity. They cool from their colour toward red as they die. */
export class Sparks {
  private readonly pool: Pool<Spark>;

  constructor(max: number) {
    this.pool = new Pool(max, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, w: 0.1, r: 0, g: 0, b: 0, trail: 0 }));
  }

  /** Position and velocity relative to the zone anchor; `w` is the half width of the streak in metres. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, w: number,
        r: number, g: number, b: number, trail: number): void {
    const p = this.pool.take();
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = 0; p.life = life; p.w = w; p.r = r; p.g = g; p.b = b; p.trail = trail;
  }

  update(f: Frame, ribbons: Ribbons): void {
    const items = this.pool.items;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      if (p.age >= p.life) { this.pool.free(i); continue; }
      p.x += p.vx * f.dt; p.y += p.vy * f.dt; p.z += p.vz * f.dt;
      const t = p.age / p.life;
      const k = (1 - t) * (1 - t);
      const tr = Math.min(p.trail, p.age);
      const hx = p.x + f.zx, hy = p.y + f.zy, hz = p.z + f.zz;
      ribbons.seg(hx - p.vx * tr, hy - p.vy * tr, hz - p.vz * tr, hx, hy, hz, p.w,
        p.r * k, p.g * k * (1 - 0.55 * t), p.b * k * (1 - 0.85 * t), 0, 1);
    }
  }

  clear(): void {
    this.pool.count = 0;
  }
}

/** Brightness over life: bright at once and fading. */
export const FADE = 0;
/** Brightness over life: swelling and fading again. */
export const SWELL = 1;
/** Brightness over life: rising to the end, with the size change speeding up; for implosions. */
export const RISE = 2;

export interface Flash {
  kind: number;
  /** Start position relative to the zone anchor, or to the followed entity. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Negative while the flash waits for its start. */
  age: number;
  life: number;
  /** Radius at the start and at the end of its life. */
  s0: number; s1: number;
  r: number; g: number; b: number;
  curve: number;
  /** 0..1: how far the colour cools toward red over its life. */
  cool: number;
  param: number;
  seed: number;
  rot: number;
  aspect: number;
  /** Entity the flash moves with, or -1. */
  follow: number;
}

const makeFlash = (): Flash => ({
  kind: GLOW, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s0: 1, s1: 1, r: 0, g: 0, b: 0,
  curve: FADE, cool: 0, param: 0, seed: 0, rot: 0, aspect: 1, follow: -1,
});

export class Flashes {
  private readonly pool: Pool<Flash>;
  /** Handed out when the pool is full, so callers can set optional fields without checking. */
  private readonly spare = makeFlash();

  constructor(max: number) {
    this.pool = new Pool(max, makeFlash);
  }

  /** Starts a flash and returns it, so the caller can set the optional fields (velocity, delay, curve, ...). */
  spawn(kind: number, x: number, y: number, z: number, life: number, s0: number, s1: number,
        r: number, g: number, b: number, gain: number): Flash {
    const p = this.pool.take() ?? this.spare;
    p.kind = kind; p.x = x; p.y = y; p.z = z; p.vx = 0; p.vy = 0; p.vz = 0;
    p.age = 0; p.life = life; p.s0 = s0; p.s1 = s1;
    p.r = r * gain; p.g = g * gain; p.b = b * gain;
    p.curve = FADE; p.cool = 0; p.param = 0.05; p.seed = Math.random(); p.rot = 0; p.aspect = 1; p.follow = -1;
    return p;
  }

  update(f: Frame, sprites: Sprites): void {
    const items = this.pool.items;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      if (p.age < 0) continue;
      if (p.age >= p.life) { this.pool.free(i); continue; }
      const t = p.age / p.life, u = 1 - t;
      let x = p.x + p.vx * p.age + f.zx, y = p.y + p.vy * p.age + f.zy, z = p.z + p.vz * p.age + f.zz;
      if (p.follow >= 0) {
        const host = f.tracks.get(p.follow);
        if (!host) { this.pool.free(i); continue; }
        x += host.x; y += host.y; z += host.z;
      }
      const grow = p.curve === RISE ? t * t : 1 - u * u * u;
      const k = p.curve === FADE ? u * u : p.curve === SWELL ? Math.sin(Math.PI * t) : t * t;
      sprites.add(x, y, z, p.s0 + (p.s1 - p.s0) * grow,
        p.r * k, p.g * k * (1 - 0.6 * p.cool * t), p.b * k * (1 - 0.9 * p.cool * t),
        p.kind, p.kind === PUFF ? t : p.param, p.seed, p.rot, p.aspect);
    }
  }

  clear(): void {
    this.pool.count = 0;
  }
}
