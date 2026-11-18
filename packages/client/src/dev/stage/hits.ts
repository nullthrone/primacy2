/** Acts of the effect stage for hits: on a shield, on a hull, by a missile, and a ship that is badly damaged. */
import { EntityFlag, EntityKind } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
import { MISSILE, SHOOTER, TARGET, duel, radiusOf, targetRel } from './common.ts';
import type { Act, StageFrame } from './types.ts';

/** Damage of a light, a medium and a heavy hit (a pulse bolt, a few cannon rounds, a missile). */
const BLOWS = [13, 60, 210] as const;

/** A point on the side of the target that faces the camera, `frac` radii out, moving around with `n`. */
function spot(f: StageFrame, to: Vec3, n: number, frac: number): Vec3 {
  const a = n * 2.4, r = radiusOf(f.hull) * frac;
  const side = f.dir(Math.cos(a) * 0.8, Math.sin(a * 1.3) * 0.6, -0.55);
  const l = Math.hypot(side[0], side[1], side[2]) || 1;
  return [to[0] + (side[0] / l) * r, to[1] + (side[1] / l) * r, to[2] + (side[2] / l) * r];
}

export const acts: Record<string, Act> = {
  shield: {
    note: 'hits on a shield, light, medium and heavy in turn, from changing sides; the shield runs down to nothing',
    period: 8,
    frame: (f) => {
      const { to } = duel(f, { shield: Math.max(0, 1 - f.t / 7) });
      if (f.t < 7 && f.ticked(1.5, 0.4)) {
        const n = Math.floor((f.t - 0.4) * 1.5);
        f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg: BLOWS[n % 3]!, shield: true, at: f.at(spot(f, to, n, 1.15)) });
      }
    },
  },
  hull: {
    note: 'hits on a bare hull, light, medium and heavy in turn; the hull runs down to a tenth',
    period: 8,
    frame: (f) => {
      const { to } = duel(f, { shield: 0, hull: Math.max(0.1, 1 - f.t / 7) });
      if (f.t < 7 && f.ticked(1.5, 0.4)) {
        const n = Math.floor((f.t - 0.4) * 1.5);
        f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg: BLOWS[n % 3]!, shield: false, at: f.at(spot(f, to, n, 0.5)) });
      }
    },
  },
  missile: {
    note: 'a missile flies from the shooter to the target in 2.5 s and goes off on its hull',
    period: 5,
    frame: (f) => {
      const { from, to } = duel(f, { shield: 0 });
      const flight = 2.5, start = 0.5;
      const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      const reach = len - radiusOf(f.hull) * 0.5;
      if (f.t >= start && f.t < start + flight) {
        const k = ((f.t - start) / flight) * reach / len;
        const vel: Vec3 = [d[0] / len * (reach / flight), d[1] / len * (reach / flight), d[2] / len * (reach / flight)];
        f.ents.push({
          id: MISSILE, info: { id: MISSILE, kind: EntityKind.Missile, name: 'Missile', model: 'missile', radius: 1 },
          rel: [from[0] + d[0] * k, from[1] + d[1] * k, from[2] + d[2] * k], vel,
          rot: f.facing(0.9, 0.18, 0.28), flags: EntityFlag.Thrust, hull: 1, shield: 0,
        });
      }
      if (f.crossed(start + flight)) {
        const k = reach / len;
        f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg: 210, shield: false, at: f.at([from[0] + d[0] * k, from[1] + d[1] * k, from[2] + d[2] * k]) });
      }
    },
  },
  damage: {
    note: 'a ship with its hull at 35 %, then at 15 %: what a damaged ship shows without being hit',
    period: 8,
    frame: (f) => {
      f.ents.push(f.ship(TARGET, f.hull, targetRel(f), f.facing(Math.cos(0.5 + 0.12 * f.clock), 0.1, -Math.sin(0.5 + 0.12 * f.clock)), {
        flags: EntityFlag.Thrust, shield: 0, hull: f.t < 4 ? 0.35 : 0.15,
      }));
    },
  },
};
