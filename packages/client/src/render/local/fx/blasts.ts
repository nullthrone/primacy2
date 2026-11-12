/**
 * The big, brief events: a ship blowing up, a ship arriving or leaving by fold, a ship entering or
 * dropping out of cruise. Each is a recipe of flashes, sparks, debris and streaks.
 */
import type { GameEvent, Vec3 } from '@primacy2/shared';
import { TAU, clamp, hash01 } from '../util.ts';
import { rand, randDir, rotate, type Frame } from './core.ts';
import type { Debris } from './debris.ts';
import { RISE, type Flashes, type Sparks } from './particles.ts';
import { GLOW, PUFF, RING } from './sprites.ts';
import type { Weapons } from './weapons.ts';

type DestroyedEvent = Extract<GameEvent, { e: 'destroyed' }>;
type FoldEvent = Extract<GameEvent, { e: 'fold' }>;
type CruiseEvent = Extract<GameEvent, { e: 'cruise' }>;

const D: Vec3 = [0, 0, 0];
const PUFFS = [5, 8, 11] as const;
const BLAST_SPARKS = [45, 90, 150] as const;
const CHUNKS = [6, 10, 16] as const;
const FOLD_SPARKS = [10, 18, 28] as const;

export class Blasts {
  constructor(private readonly f: Frame, private readonly sparks: Sparks, private readonly flashes: Flashes,
              private readonly debris: Debris, private readonly weapons: Weapons) {}

  /** An explosion in vacuum: nothing lingers, everything flies apart on straight lines. */
  destroyed(ev: DestroyedEvent): void {
    const f = this.f, fl = this.flashes;
    const x = ev.at[0], y = ev.at[1], z = ev.at[2];
    const R = clamp(f.tracks.get(ev.id)?.radius ?? 10, 4, 80);

    // The flash: blinding for a few frames, then an orange glare that is gone within a second.
    fl.spawn(GLOW, x, y, z, 0.18, R * 5, R * 13, 1.0, 0.94, 0.84, 70);
    fl.spawn(GLOW, x, y, z, 0.8, R * 3.5, R * 6, 1.0, 0.5, 0.16, 6).cool = 1;

    // The fireball: puffs of burning gas driven outward, each tearing apart as it expands.
    for (let i = PUFFS[f.quality]; i > 0; i--) {
      randDir(D);
      const v = R * rand(0.7, 2.6);
      const p = fl.spawn(PUFF, x + D[0] * R * 0.3, y + D[1] * R * 0.3, z + D[2] * R * 0.3, rand(0.55, 1.25),
        R * rand(0.5, 0.9), R * rand(2.2, 3.8), 1.0, 0.58, 0.2, rand(5, 9));
      p.vx = D[0] * v; p.vy = D[1] * v; p.vz = D[2] * v;
      p.cool = 1;
      p.rot = rand(0, TAU);
      p.age = -rand(0, 0.06);
    }

    // The shock ring: a thin shell of gas seen at a random tilt.
    const ring = fl.spawn(RING, x, y, z, 0.65, R * 1.5, R * 18, 0.7, 0.82, 1.0, 3.5);
    ring.param = 0.022;
    ring.aspect = rand(0.3, 1);
    ring.rot = rand(0, TAU);

    for (let i = BLAST_SPARKS[f.quality]; i > 0; i--) {
      randDir(D);
      const v = R * rand(2, 13);
      const hot = rand(4, 10);
      this.sparks.spawn(x, y, z, D[0] * v, D[1] * v, D[2] * v, rand(0.5, 1.7), 0.1 * Math.sqrt(R / 10), hot, hot * 0.74, hot * 0.36, 0.045);
    }
    this.debris.burst(x, y, z, R, CHUNKS[f.quality]);
  }

  /** Another ship arriving or leaving by fold. The arrival is the bigger one: space pulls in, then flashes. */
  fold(ev: FoldEvent): void {
    const f = this.f, fl = this.flashes;
    if (ev.id === f.view.self?.id) return;
    const x = ev.at[0], y = ev.at[1], z = ev.at[2];
    if (ev.out) {
      const pull = fl.spawn(RING, x, y, z, 0.2, 45, 2, 0.55, 0.72, 1.0, 3);
      pull.curve = RISE;
      pull.param = 0.04;
      fl.spawn(GLOW, x, y, z, 0.16, 10, 28, 0.75, 0.87, 1.0, 22).age = -0.2;
      return;
    }
    const T = 0.26;
    const pull = fl.spawn(RING, x, y, z, T, 80, 3, 0.55, 0.72, 1.0, 4);
    pull.curve = RISE;
    pull.param = 0.035;
    for (let i = FOLD_SPARKS[f.quality]; i > 0; i--) {
      randDir(D);
      const d = rand(45, 80), v = -d / T;
      this.sparks.spawn(x + D[0] * d, y + D[1] * d, z + D[2] * d, D[0] * v, D[1] * v, D[2] * v, T, 0.14, 3, 3.9, 5, 0.06);
    }
    fl.spawn(GLOW, x, y, z, 0.24, 22, 60, 0.8, 0.9, 1.0, 45).age = -T;
    fl.spawn(GLOW, x, y, z, 0.9, 14, 7, 0.4, 0.6, 1.0, 4).age = -T;
    const wave = fl.spawn(RING, x, y, z, 0.55, 6, 120, 0.6, 0.78, 1.0, 3);
    wave.age = -T;
    wave.param = 0.018;
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
    const L = 650;
    if (ev.on) {
      this.weapons.streak(x, y, z, x + D[0] * L, y + D[1] * L, z + D[2] * L, 0.22, 170, 0.35, 0.2, 0.5, 3.9, 4.8, 6, 0);
      this.flashes.spawn(GLOW, x, y, z, 0.14, 4, 11, 0.65, 0.8, 1.0, 7);
    } else {
      this.weapons.streak(x - D[0] * L, y - D[1] * L, z - D[2] * L, x, y, z, 0.22, 170, 0.35, 0.2, 0.5, 3.9, 4.8, 6, 0);
      this.flashes.spawn(GLOW, x, y, z, 0.18, 5, 14, 0.65, 0.8, 1.0, 9).age = -0.2;
    }
  }
}
