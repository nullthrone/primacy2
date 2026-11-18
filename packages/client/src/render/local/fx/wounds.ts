/**
 * What a damaged ship shows without being hit: below 40 % hull it throws a few sparks now and
 * then, below 20 % it also loses gas in a thin jet. No smoke and no fire; nothing burns in vacuum.
 *
 * A fight can have a dozen damaged ships in view, so this keeps nothing per ship: where a ship
 * leaks and when it sparks follow from its id and the clock.
 */
import { EntityKind } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
import { hash01 } from '../util.ts';
import { rand, randCone, rotate, type Frame } from './core.ts';
import { wound } from './hull.ts';
import type { Flashes, Sparks } from './particles.ts';
import { GLOW } from './sprites.ts';
import type { Vents } from './vents.ts';

/** Hull fractions below which a ship sparks, and below which it also vents. */
const SPARKING = 0.4, VENTING = 0.2;
/** The clock is cut into beats of this many seconds; on each a ship sparks or does not. */
const BEAT = 0.7;
const COUNT = [3, 5, 7] as const;

const P: Vec3 = [0, 0, 0];
const N: Vec3 = [0, 0, 0];
const W: Vec3 = [0, 0, 0];
const D: Vec3 = [0, 0, 0];

export class Wounds {
  /** Adds this frame's jets to `vents` (between its `begin` and `end`) and starts the sparks that are due. */
  update(f: Frame, sparks: Sparks, flashes: Flashes, vents: Vents): void {
    const view = f.view;
    const ents = view.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      if (e.info.kind === EntityKind.Ship) this.ship(f, e.id, e.hull, sparks, flashes, vents);
    }
    // From the cockpit the pilot's own hull is not in the picture, and its leaks would be at his eye.
    const self = view.self;
    if (self && view.camera.mode !== 'cockpit' && self.stats.hullMax > 0) {
      this.ship(f, self.id, self.state.hull / self.stats.hullMax, sparks, flashes, vents);
    }
  }

  private ship(f: Frame, id: number, hull: number, sparks: Sparks, flashes: Flashes, vents: Vents): void {
    if (hull >= SPARKING || hull <= 0) return;
    const t = f.tracks.get(id);
    if (!t) return;
    const venting = hull < VENTING;

    const phase = hash01(id * 31 + 7) * BEAT;
    const beat = Math.floor((f.now + phase) / BEAT);
    if (beat !== Math.floor((f.now - f.dt + phase) / BEAT) && hash01(id * 977 + beat * 131) < (venting ? 0.75 : 0.45)) {
      // One of three places, so a ship does not always spark at the same seam.
      wound(id, 1 + Math.floor(hash01(id * 3 + beat * 17) * 3), t.radius, P, N);
      rotate(t, P[0], P[1], P[2], W);
      rotate(t, N[0], N[1], N[2], N);
      const size = Math.sqrt(t.radius / 10);
      const flash = flashes.spawn(GLOW, W[0] + N[0] * 0.4, W[1] + N[1] * 0.4, W[2] + N[2] * 0.4, 0.14, 0.5 * size, 1.3 * size, 1.0, 0.78, 0.5, 5);
      flash.follow = id;
      const count = COUNT[f.quality] + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        randCone(N[0], N[1], N[2], 0.7, D);
        const v = rand(8, 38);
        sparks.spawn(t.x + W[0] + N[0] * 0.3, t.y + W[1] + N[1] * 0.3, t.z + W[2] + N[2] * 0.3,
          t.vx + D[0] * v, t.vy + D[1] * v, t.vz + D[2] * v, rand(0.3, 0.85), 0.07, 7, 5, 2.4, 0.04);
      }
    }

    if (venting) {
      wound(id, 0, t.radius, P, N);
      rotate(t, P[0], P[1], P[2], W);
      rotate(t, N[0], N[1], N[2], N);
      // A leak sputters: the pressure behind it is not steady.
      const a = f.now * 2.3 + id * 1.7;
      const sputter = 0.62 + 0.38 * Math.sin(a) * Math.sin(a * 0.43 + 1.1);
      const len = 0.9 * t.radius * (0.85 + 0.15 * sputter);
      vents.jet(t.x + W[0] + f.zx, t.y + W[1] + f.zy, t.z + W[2] + f.zz, N[0], N[1], N[2], len, 0.15 * len,
        0.9 * sputter, hash01(id * 19 + 5), f.now % 97);
    }
  }
}
