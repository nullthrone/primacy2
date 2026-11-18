/**
 * The big, brief events: a ship blowing up, a missile going off, a ship arriving or leaving by
 * fold, a ship entering or dropping out of cruise.
 *
 * A blast in vacuum has next to nothing to burn. There is a flash, a fireball that is gone in less
 * than half a second, and then what the ship was made of, flying apart: debris and light.
 *
 *   the flash    a point of light with a long falloff (`blastlight.ts`), its rays in the lens
 *                (`post/lens.ts`) and its light on whatever is near (`lights.ts`)
 *   the shell    the gas driven out ahead of everything, soft and thick, gone in half a second
 *   the cloud    hundreds of splinters (`splinters.ts`) and a few large chunks (`debris.ts`) that
 *                cool from white to dull red over seconds and then only glint in the sun
 *   the veil     what is left of the gas, thin, lit by the sun, spreading until it cannot be seen
 *   after-blasts smaller blasts on the wreck in the second and a half that follows
 *
 * What blew up decides more than the scale of all this: see `SizeClass`.
 */
import { Group } from 'three';
import { EntityKind } from '@primacy2/shared';
import type { GameEvent, Vec3 } from '@primacy2/shared';
import type { Lighting } from '../../../contracts.ts';
import { localLens } from '../../post/lens.ts';
import { TAU, clamp, hash01 } from '../util.ts';
import { BlastLight, CORE, SHELL, VEIL, type Disc } from './blastlight.ts';
import { Pool, rand, randCone, randDir, rotate, type Frame, type Track } from './core.ts';
import type { Debris } from './debris.ts';
import { detonations } from './detonations.ts';
import { groundBelow, type GroundBelow } from './ground.ts';
import { effectLights } from './lights.ts';
import { RISE, type Flashes, type Sparks } from './particles.ts';
import { Splinters } from './splinters.ts';
import { GLOW, PUFF, RING } from './sprites.ts';
import type { Weapons } from './weapons.ts';

type DestroyedEvent = Extract<GameEvent, { e: 'destroyed' }>;
type FoldEvent = Extract<GameEvent, { e: 'fold' }>;
type CruiseEvent = Extract<GameEvent, { e: 'cruise' }>;

/** What differs between the blast of a small thing, of a ship and of a large ship, apart from its scale. Counts are those of the highest quality. */
interface SizeClass {
  /** Splinters of the cloud, and the seconds they fly, least and most. */
  splinters: number; life0: number; life1: number;
  /** How slowly the splinters cool (see `Splinter.cool`): they are orange after about 10 times this many seconds and dull red after 85 times. */
  cool: number;
  sparks: number;
  chunks: number;
  /** Puffs of the fireball and the seconds it burns. */
  puffs: number; fire: number;
  /** Seconds of the flash and of the shell of gas. */
  flash: number; shell: number;
  /** Veils of gas and the seconds they stay. */
  veils: number; veil: number;
  /** After-blasts on the wreck, least and most, and the seconds they are spread over. */
  after0: number; after1: number; span: number;
}

const CLASSES: readonly SizeClass[] = [
  // A cargo pod, a missile shot down: a pop, a handful of splinters, dark again in two seconds.
  { splinters: 50, life0: 2.5, life1: 4.5, cool: 0.06, sparks: 24, chunks: 2, puffs: 2, fire: 0.22, flash: 0.14, shell: 0.25, veils: 2, veil: 3, after0: 0, after1: 0, span: 0 },
  // A ship.
  { splinters: 300, life0: 6, life1: 9.5, cool: 0.25, sparks: 90, chunks: 10, puffs: 5, fire: 0.38, flash: 0.22, shell: 0.4, veils: 3, veil: 6, after0: 2, after1: 3, span: 1.5 },
  // A large ship: more of everything, it takes longer to come apart, and its cloud glows longest.
  { splinters: 520, life0: 8, life1: 12, cool: 0.5, sparks: 140, chunks: 16, puffs: 9, fire: 0.55, flash: 0.3, shell: 0.55, veils: 5, veil: 9, after0: 3, after1: 4, span: 1.9 },
];
/** Radius in metres from which a ship is a ship, and from which a large one. */
const SHIP = 5;
const LARGE = 15;
/** Share of the counts that is drawn at each quality. */
const SHARE = [0.35, 0.65, 1] as const;
const VEIL_SHARE = [0.5, 0.75, 1] as const;

const D: Vec3 = [0, 0, 0];
const A: Vec3 = [0, 0, 0];
const GB: GroundBelow = { h: 0, ux: 0, uy: 1, uz: 0, g: 0 };
const FOLD_SPARKS = [10, 18, 28] as const;
/** Intensity of the light a blast throws at its first moment, per square metre of the radius of what blew up. */
const BLAST_LIGHT = 600;
/** The same for the warhead of a missile, whatever its size. */
const WARHEAD_LIGHT = 9000;
/** Intensity of sunlight near a sun-like star, in the unit of the effect lights: what a flash is measured against for its glare. */
const SUN = 3;

/** A blast that waits for its moment on the wreck. */
interface After {
  wait: number;
  /** Where on the wreck, in the wreck's own axes. */
  ox: number; oy: number; oz: number;
  /** Place, velocity and orientation of the ship when it blew up, and the effect time then. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number;
  t0: number;
  radius: number;
  cool: number;
}

/** A flash that still dazzles: named to the lens in every frame of its life. */
interface Dazzle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  /** Intensity as the effect lights count it. */
  power: number;
  /** Metres by which it is counted nearer than it is, so the wreck it sits on does not cover it. */
  cover: number;
}

/** Rotates (x, y, z) by the quaternion q into `out`. */
function turn(qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number, out: Vec3): void {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/** A random direction in `D`; over ground one that does not point into it. */
function away(ground: GroundBelow | null): void {
  randDir(D);
  if (!ground) return;
  const down = D[0] * ground.ux + D[1] * ground.uy + D[2] * ground.uz;
  if (down < 0) { D[0] -= 2 * down * ground.ux; D[1] -= 2 * down * ground.uy; D[2] -= 2 * down * ground.uz; }
}

/** Gives a disc its drift and, over ground, what it needs to stay above it. */
function carry(d: Disc, vx: number, vy: number, vz: number, ground: GroundBelow | null): void {
  d.vx = vx; d.vy = vy; d.vz = vz;
  if (ground) { d.h = ground.h; d.ux = ground.ux; d.uy = ground.uy; d.uz = ground.uz; }
}

export class Blasts {
  /** What this family draws besides the shared streaks and discs; the effects part hangs it into the scene. */
  readonly group = new Group();
  private readonly glow = new BlastLight(192);
  private readonly splinters = new Splinters(3072);
  private readonly afters = new Pool<After>(24, () => ({
    wait: 0, ox: 0, oy: 0, oz: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, t0: 0, radius: 10, cool: 1,
  }));
  private readonly dazzles = new Pool<Dazzle>(8, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, power: 0, cover: 0 }));

  constructor(private readonly f: Frame, private readonly sparks: Sparks, private readonly flashes: Flashes,
              private readonly debris: Debris, private readonly weapons: Weapons) {
    this.group.add(this.glow.mesh, this.splinters.mesh);
  }

  /** A ship, a pod or anything else that the server says is destroyed. */
  destroyed(ev: DestroyedEvent): void {
    const f = this.f, fl = this.flashes, gl = this.glow;
    const x = ev.at[0], y = ev.at[1], z = ev.at[2];
    const t = f.tracks.get(ev.id);
    const R = clamp(t?.radius ?? 10, 2, 80);
    const c = CLASSES[R < SHIP ? 0 : R < LARGE ? 1 : 2]!;
    const share = SHARE[f.quality];
    // What blew up was moving, and what is left of it moves on the same way, as the wreck does.
    const moving = t !== undefined && f.now - t.seen < 1;
    const vx = moving ? t.vx : 0, vy = moving ? t.vy : 0, vz = moving ? t.vz : 0;
    const ground = groundBelow(f, x, y, z, GB) && GB.h < 15 * R + 50 ? GB : null;

    // The flash. Near the ground it is kept small enough to sit on it; its glare is the lens's then.
    const wide = ground ? Math.min(R * 8, Math.max(R * 2.5, (ground.h + R) * 2.5)) : R * 8;
    carry(gl.spawn(CORE, x, y, z, c.flash, wide * 0.7, wide, 1.0, 0.95, 0.86, 34), vx, vy, vz, ground);
    // What still glows in the middle while the fireball dies.
    const ember = gl.spawn(CORE, x, y, z, c.fire * 2.4, wide * 0.3, wide * 0.5, 1.0, 0.5, 0.16, 5);
    ember.cool = 1;
    ember.param = 0.14;
    carry(ember, vx, vy, vz, ground);
    // Its light on whatever is near, and in the lens of whoever looks.
    const power = BLAST_LIGHT * R * R;
    effectLights.pulse(x, y, z, 1.0, 0.9, 0.76, power, R * 45, c.flash);
    effectLights.pulse(x, y, z, 1.0, 0.5, 0.16, 0.12 * power, R * 30, c.fire * 2.4);
    this.dazzle(x, y, z, vx, vy, vz, power, c.flash * 1.4, R * 1.3);

    // The fireball: short and hot. Over ground it is smaller and starts high enough not to be cut by it.
    const seat = ground ? Math.max(0, R * 1.5 - ground.h) : 0, swell = ground && ground.h < R * 3 ? 0.6 : 1;
    const sx = ground ? x + ground.ux * seat : x, sy = ground ? y + ground.uy * seat : y, sz = ground ? z + ground.uz * seat : z;
    for (let i = Math.round(c.puffs * share); i > 0; i--) {
      away(ground);
      const v = R * rand(0.8, 2.6);
      const p = fl.spawn(PUFF, sx + D[0] * R * 0.4, sy + D[1] * R * 0.4, sz + D[2] * R * 0.4, c.fire * rand(0.6, 1),
        R * rand(0.4, 0.9) * swell, R * rand(1.5, 2.6) * swell, 1.0, 0.7, 0.34, rand(7, 13));
      p.vx = vx + D[0] * v; p.vy = vy + D[1] * v; p.vz = vz + D[2] * v;
      p.cool = 1;
      p.rot = rand(0, TAU);
      p.age = -rand(0, 0.04);
    }

    // The shell of gas. Over ground it would be a dome; the dust the ground throws up stands for it there.
    const reach = R * rand(9, 12);
    if (!ground || ground.h > reach) {
      carry(gl.spawn(SHELL, x, y, z, c.shell, R * 1.5, reach, 0.72, 0.84, 1.0, R < SHIP ? 0.18 : 0.3), vx, vy, vz, null);
    }

    // The fastest of what flies off, seen as streaks for a moment.
    for (let i = Math.round(c.sparks * share); i > 0; i--) {
      away(ground);
      const v = R * rand(2.5, 14);
      const hot = rand(4, 10);
      this.sparks.spawn(x, y, z, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, rand(0.35, 1.1), 0.1 * Math.sqrt(R / 10), hot, hot * 0.74, hot * 0.36, 0.045);
    }

    // The cloud. Most of it is slow and stays where the ship was; a few splinters leave fast. A
    // ship comes apart along its length, so the cloud starts out drawn along the hull.
    if (t) rotate(t, 0, 0, 1, A);
    else { randDir(D); A[0] = D[0]; A[1] = D[1]; A[2] = D[2]; }
    const along = R * (R < LARGE ? 0.3 : 0.6), scale = Math.sqrt(R / 10);
    const gx = ground ? -ground.ux * ground.g : 0, gy = ground ? -ground.uy * ground.g : 0, gz = ground ? -ground.uz * ground.g : 0;
    for (let i = Math.round(c.splinters * share); i > 0; i--) {
      away(ground);
      const u = Math.random(), o = rand(-along, along);
      const v = R * (0.25 + 5.2 * u * u * Math.sqrt(u));
      const size = Math.random();
      // The fast ones are the small ones, and those cool first.
      const s = this.splinters.spawn(x + A[0] * o + D[0] * R * 0.3, y + A[1] * o + D[1] * R * 0.3, z + A[2] * o + D[2] * R * 0.3,
        vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, rand(c.life0, c.life1), scale * (0.05 + 0.3 * size * size * size),
        rand(0.6, 1.25), c.cool * rand(0.4, 1.8) * (1.3 - 0.6 * u));
      s.gx = gx; s.gy = gy; s.gz = gz;
    }
    this.debris.burst(x, y, z, R, Math.round(c.chunks * share), vx, vy, vz, c.fire * 3.5, c.life0, c.life1, ground);

    // The veil: thin gas that spreads at the pace it left with.
    for (let i = Math.round(c.veils * VEIL_SHARE[f.quality]); i > 0; i--) {
      away(ground);
      const v = R * rand(0.3, 1.0), life = c.veil * rand(0.75, 1.1), s0 = R * rand(1.0, 1.6);
      const veil = gl.spawn(VEIL, x + D[0] * R * 0.5, y + D[1] * R * 0.5, z + D[2] * R * 0.5, life, s0, s0 + R * rand(1.1, 2.0) * life,
        1.0, 0.55, 0.22, 0.45);
      veil.lit = 0.016 * rand(0.7, 1.3);
      carry(veil, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, ground);
    }

    // What goes off on the wreck afterwards: tanks, magazines, whatever the first blast left whole.
    const n = f.quality === 0 ? c.after0 : c.after0 + Math.floor(Math.random() * (c.after1 - c.after0 + 1));
    for (let i = 0; i < n; i++) {
      const a = this.afters.take();
      if (!a) break;
      a.wait = 0.25 + ((i + rand(0.15, 0.85)) / n) * (c.span - 0.25);
      a.ox = rand(-0.3, 0.3) * R; a.oy = rand(-0.15, 0.15) * R; a.oz = rand(-0.6, 0.6) * R;
      a.x = x; a.y = y; a.z = z; a.vx = vx; a.vy = vy; a.vz = vz;
      a.qx = t ? t.qx : 0; a.qy = t ? t.qy : 0; a.qz = t ? t.qz : 0; a.qw = t ? t.qw : 1;
      a.t0 = f.now; a.radius = R; a.cool = c.cool;
    }
  }

  /** A smaller blast at a place on the wreck: its own flash, sparks, splinters and light. */
  private afterBlast(a: After): void {
    const f = this.f, R = a.radius, share = SHARE[f.quality];
    const since = f.now - a.t0;
    let x = a.x + a.vx * since, y = a.y + a.vy * since, z = a.z + a.vz * since;
    let vx = a.vx, vy = a.vy, vz = a.vz;
    // The wreck itself, when the view has one where the ship was: the blast sits on its hull.
    const wreck = this.wreckAt(x, y, z, R);
    if (wreck) {
      rotate(wreck, a.ox, a.oy, a.oz, D);
      x = wreck.x; y = wreck.y; z = wreck.z; vx = wreck.vx; vy = wreck.vy; vz = wreck.vz;
    } else {
      turn(a.qx, a.qy, a.qz, a.qw, a.ox, a.oy, a.oz, D);
    }
    x += D[0]; y += D[1]; z += D[2];
    // It bursts outward, away from the middle of the wreck.
    const d = Math.hypot(D[0], D[1], D[2]) || 1;
    const nx = D[0] / d, ny = D[1] / d, nz = D[2] / d;
    const ground = groundBelow(f, x, y, z, GB) && GB.h < 6 * R ? GB : null;

    const flash = this.glow.spawn(CORE, x, y, z, 0.16, R * 1.4, R * 2.6, 1.0, 0.9, 0.72, 16);
    flash.param = 0.07;
    carry(flash, vx, vy, vz, ground);
    effectLights.pulse(x, y, z, 1.0, 0.8, 0.55, 0.1 * BLAST_LIGHT * R * R, R * 25, 0.2);
    const puff = this.flashes.spawn(PUFF, x + nx * R * 0.3, y + ny * R * 0.3, z + nz * R * 0.3, 0.22, R * 0.25, R * 0.9, 1.0, 0.7, 0.34, 9);
    puff.vx = vx + nx * R; puff.vy = vy + ny * R; puff.vz = vz + nz * R;
    puff.cool = 1;
    puff.rot = rand(0, TAU);
    for (let i = Math.round(16 * share); i > 0; i--) {
      randCone(nx, ny, nz, 0.8, D);
      const v = R * rand(1.5, 8);
      const hot = rand(3, 8);
      this.sparks.spawn(x, y, z, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, rand(0.3, 0.8), 0.08 * Math.sqrt(R / 10), hot, hot * 0.7, hot * 0.32, 0.04);
    }
    const scale = Math.sqrt(R / 10);
    for (let i = Math.round(26 * share); i > 0; i--) {
      randCone(nx, ny, nz, 0.9, D);
      const v = R * rand(0.3, 2.6);
      const s = this.splinters.spawn(x, y, z, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, rand(2.5, 5), scale * rand(0.02, 0.07),
        rand(0.75, 1.1), a.cool * rand(0.2, 0.6));
      if (ground) { s.gx = -ground.ux * ground.g; s.gy = -ground.uy * ground.g; s.gz = -ground.uz * ground.g; }
    }
  }

  /** The track of a wreck within reach of an anchor-relative point, or null. */
  private wreckAt(x: number, y: number, z: number, R: number): Track | null {
    const f = this.f, ents = f.view.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      if (e.info.kind !== EntityKind.Wreck) continue;
      const t = f.tracks.get(e.id);
      if (t && Math.hypot(t.x - x, t.y - y, t.z - z) < R + 8) return t;
    }
    return null;
  }

  /**
   * A missile going off at an anchor-relative point; (vx, vy, vz) is the velocity it had. The
   * warhead bursts just short of its target and throws its splinters forward, as a cone along the
   * flight, so the blast has a direction where a ship's has none.
   */
  private detonation(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const f = this.f, gl = this.glow, share = SHARE[f.quality];
    const speed = Math.hypot(vx, vy, vz);
    if (speed > 1) { A[0] = vx / speed; A[1] = vy / speed; A[2] = vz / speed; }
    else { randDir(D); A[0] = D[0]; A[1] = D[1]; A[2] = D[2]; }
    const ground = groundBelow(f, x, y, z, GB) && GB.h < 60 ? GB : null;

    const wide = ground ? Math.min(26, Math.max(8, (ground.h + 2) * 2.5)) : 26;
    carry(gl.spawn(CORE, x, y, z, 0.16, wide * 0.7, wide, 1.0, 0.94, 0.84, 26), 0, 0, 0, ground);
    const ember = gl.spawn(CORE, x, y, z, 0.45, wide * 0.25, wide * 0.4, 1.0, 0.55, 0.2, 4);
    ember.cool = 1;
    ember.param = 0.14;
    carry(ember, 0, 0, 0, ground);
    effectLights.pulse(x, y, z, 1.0, 0.9, 0.76, WARHEAD_LIGHT, 320, 0.18);
    effectLights.pulse(x, y, z, 1.0, 0.5, 0.16, 0.1 * WARHEAD_LIGHT, 200, 0.5);
    this.dazzle(x, y, z, 0, 0, 0, WARHEAD_LIGHT, 0.22, 4);
    if (!ground || ground.h > 34) gl.spawn(SHELL, x, y, z, 0.26, 3, 34, 0.72, 0.84, 1.0, 0.2);
    this.flashes.spawn(PUFF, x, y, z, 0.2, 2, 7, 1.0, 0.72, 0.36, 10).cool = 1;

    // The fastest splinters of the cone, seen as streaks.
    for (let i = Math.round(70 * share); i > 0; i--) {
      randCone(A[0], A[1], A[2], 0.3, D);
      const v = rand(140, 420);
      const hot = rand(5, 11);
      this.sparks.spawn(x, y, z, D[0] * v, D[1] * v, D[2] * v, rand(0.25, 0.7), 0.09, hot, hot * 0.78, hot * 0.42, 0.05);
    }
    // The rest of it: a cloud that keeps the shape of the cone while it cools.
    for (let i = Math.round(90 * share); i > 0; i--) {
      randCone(A[0], A[1], A[2], 0.45, D);
      const v = rand(12, 150);
      const s = this.splinters.spawn(x, y, z, D[0] * v, D[1] * v, D[2] * v, rand(1.6, 3.2), rand(0.03, 0.1), rand(0.85, 1.2), rand(0.05, 0.15));
      if (ground) { s.gx = -ground.ux * ground.g; s.gy = -ground.uy * ground.g; s.gz = -ground.uz * ground.g; }
    }
    // The casing, to all sides.
    for (let i = Math.round(16 * share); i > 0; i--) {
      away(ground);
      const v = rand(25, 110);
      const hot = rand(3, 7);
      this.sparks.spawn(x, y, z, D[0] * v, D[1] * v, D[2] * v, rand(0.2, 0.5), 0.07, hot, hot * 0.72, hot * 0.34, 0.04);
    }
  }

  /** Makes a flash dazzle for `life` seconds: the lens draws its glare and rays while it lasts. */
  private dazzle(x: number, y: number, z: number, vx: number, vy: number, vz: number, power: number, life: number, cover: number): void {
    const p = this.dazzles.take();
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = 0; p.life = life; p.power = power; p.cover = cover;
  }

  /** Another ship arriving or leaving by fold. The arrival is the bigger one: space pulls in, then flashes. */
  fold(ev: FoldEvent): void {
    const f = this.f, fl = this.flashes;
    if (ev.id === f.view.self?.id) return;
    const x = ev.at[0], y = ev.at[1], z = ev.at[2];
    if (ev.out) {
      const pull = fl.spawn(RING, x, y, z, 0.2, 45, 2, 0.55, 0.72, 1.0, 3);
      pull.curve = RISE;
      pull.param = 0.03;
      pull.aspect = rand(0.45, 0.9);
      pull.rot = rand(0, TAU);
      fl.spawn(GLOW, x, y, z, 0.16, 10, 28, 0.75, 0.87, 1.0, 22).age = -0.2;
      return;
    }
    const T = 0.26;
    // The rings are soft bands seen at a tilt; a hairline circle facing the camera would read as a HUD marker.
    const tilt = rand(0.4, 0.85), turn = rand(0, TAU);
    const pull = fl.spawn(RING, x, y, z, T, 80, 3, 0.55, 0.72, 1.0, 1.6);
    pull.curve = RISE;
    pull.param = 0.03;
    pull.aspect = tilt;
    pull.rot = turn;
    for (let i = FOLD_SPARKS[f.quality]; i > 0; i--) {
      randDir(D);
      const d = rand(45, 80), v = -d / T;
      this.sparks.spawn(x + D[0] * d, y + D[1] * d, z + D[2] * d, D[0] * v, D[1] * v, D[2] * v, T, 0.14, 3, 3.9, 5, 0.06);
    }
    fl.spawn(GLOW, x, y, z, 0.24, 22, 60, 0.8, 0.9, 1.0, 45).age = -T;
    fl.spawn(GLOW, x, y, z, 0.9, 14, 7, 0.4, 0.6, 1.0, 4).age = -T;
    const wave = fl.spawn(RING, x, y, z, 0.45, 6, 110, 0.6, 0.78, 1.0, 0.5);
    wave.age = -T;
    wave.param = 0.025;
    wave.aspect = tilt;
    wave.rot = turn;
  }

  /** Another ship entering or leaving cruise: a short streak along its heading and a small flash. */
  cruise(ev: CruiseEvent): void {
    const f = this.f;
    if (ev.id === f.view.self?.id) return;
    const x = ev.at[0], y = ev.at[1], z = ev.at[2];
    const t = f.tracks.get(ev.id);
    if (t) {
      rotate(t, 0, 0, -1, D);
    } else {
      // A ship that was never in view: any heading will do, as long as it is the same each time.
      const a = hash01(ev.id) * TAU, e = hash01(ev.id + 77) - 0.5;
      D[0] = Math.cos(a) * Math.cos(e); D[1] = Math.sin(e); D[2] = Math.sin(a) * Math.cos(e);
    }
    const L = 420;
    if (ev.on) {
      this.weapons.streak(x, y, z, x + D[0] * L, y + D[1] * L, z + D[2] * L, 0.2, 130, 0.3, 0.16, 0.5, 3.9, 4.8, 6, 0);
      this.flashes.spawn(GLOW, x, y, z, 0.14, 4, 11, 0.65, 0.8, 1.0, 7);
    } else {
      this.weapons.streak(x - D[0] * L, y - D[1] * L, z - D[2] * L, x, y, z, 0.2, 130, 0.3, 0.16, 0.5, 3.9, 4.8, 6, 0);
      this.flashes.spawn(GLOW, x, y, z, 0.18, 5, 14, 0.65, 0.8, 1.0, 9).age = -0.2;
    }
  }

  /**
   * Steps and draws what a blast leaves beyond the shared sparks and flashes. `light` is the
   * light that reaches the camera: the sun, gone on the night side of the body the zone is near.
   */
  update(light: Lighting): void {
    const f = this.f;
    // The missile part ran just before this one and has left what went off in this frame.
    for (let i = 0; i < detonations.count; i++) {
      const o = i * 6, d = detonations.data;
      this.detonation(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!, d[o + 4]!, d[o + 5]!);
    }
    detonations.count = 0;

    const afters = this.afters.items;
    for (let i = this.afters.count - 1; i >= 0; i--) {
      const a = afters[i]!;
      a.wait -= f.dt;
      if (a.wait > 0) continue;
      this.afterBlast(a);
      this.afters.free(i);
    }

    const dazzles = this.dazzles.items;
    for (let i = this.dazzles.count - 1; i >= 0; i--) {
      const p = dazzles[i]!;
      p.age += f.dt;
      if (p.age >= p.life) { this.dazzles.free(i); continue; }
      const x = p.x + p.vx * p.age + f.zx, y = p.y + p.vy * p.age + f.zy, z = p.z + p.vz * p.age + f.zz;
      const d = Math.hypot(x, y, z);
      // A camera inside the blast is past being dazzled by a point.
      if (d < p.cover + 2) continue;
      // The lens wants the direction in system axes; everything here is in the zone's.
      turn(f.qx, f.qy, f.qz, f.qw, x / d, y / d, z / d, D);
      const u = 1 - p.age / p.life;
      localLens.add(D[0], D[1], D[2], d - p.cover, p.power / (d * d * SUN), u * u, 1.0, 0.93, 0.82);
    }

    this.glow.update(f, light);
    this.splinters.update(f, light);
  }

  clear(): void {
    this.glow.clear();
    this.splinters.clear();
    this.afters.count = 0;
    this.dazzles.count = 0;
    detonations.count = 0;
  }

  /** Frees what `group` holds. */
  dispose(): void {
    this.glow.dispose();
    this.splinters.dispose();
  }
}
