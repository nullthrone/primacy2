/** Acts of the effect stage for hits: on a shield, on a hull, by a missile, and ships that are badly damaged. */
import { EntityFlag, EntityKind } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
import { MISSILE, SHOOTER, TARGET, duel, radiusOf, shooterRel, targetRel } from './common.ts';
import type { Act, StageFrame } from './types.ts';

/** Damage of a light, a medium and a heavy hit (a pulse bolt, a few cannon rounds, a missile). */
const BLOWS = [13, 60, 210] as const;
/** The first of the damaged ships of the `fleet` act; clear of every other id on the stage. */
const FLEET = 60;

/** A point on the side of the target that faces the camera, `frac` radii out, moving around with `n`. */
function spot(f: StageFrame, to: Vec3, n: number, frac: number): Vec3 {
  const a = n * 2.4, r = radiusOf(f.hull) * frac;
  const side = f.dir(Math.cos(a) * 0.8, Math.sin(a * 1.3) * 0.6, -0.55);
  const l = Math.hypot(side[0], side[1], side[2]) || 1;
  return [to[0] + (side[0] / l) * r, to[1] + (side[1] / l) * r, to[2] + (side[2] / l) * r];
}

/** The point `frac` radii from the target in a direction given in camera axes (x right, y up, z ahead). */
function toward(f: StageFrame, to: Vec3, x: number, y: number, z: number, frac: number): Vec3 {
  const d = f.dir(x, y, z);
  const k = (radiusOf(f.hull) * frac) / (Math.hypot(d[0], d[1], d[2]) || 1);
  return [to[0] + d[0] * k, to[1] + d[1] * k, to[2] + d[2] * k];
}

export const acts: Record<string, Act> = {
  shield: {
    note: 'hits on a shield, light, medium and heavy in turn, from changing sides; the shield runs down to nothing and falls',
    period: 8,
    frame: (f) => {
      const { to } = duel(f, { shield: Math.max(0, 1 - f.t / 7) });
      if (f.t < 7 && f.ticked(1.5, 0.4)) {
        const n = Math.floor((f.t - 0.4) * 1.5);
        f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg: BLOWS[n % 3]!, shield: true, at: f.at(spot(f, to, n, 1.15)) });
      }
    },
  },
  'shield-sides': {
    note: 'medium hits on a shield: on the near side, at the upper edge, on the far side, and from the left',
    period: 6,
    frame: (f) => {
      const { to } = duel(f);
      if (f.ticked(1, 0.4)) {
        const n = Math.floor(f.t - 0.4) % 4;
        const at = n === 0 ? toward(f, to, 0, 0, -1, 1) : n === 1 ? toward(f, to, 0.1, 1, -0.05, 1) : n === 2 ? toward(f, to, -0.1, 0.25, 1, 1) : toward(f, to, -1, 0, -0.1, 1);
        f.events.push({ e: 'hit', id: TARGET, dmg: 60, shield: true, at: f.at(at) });
      }
    },
  },
  collapse: {
    note: 'a shield at its end: two hits on what is left of it, then it falls (at 2 s)',
    period: 5,
    frame: (f) => {
      const { to } = duel(f, { shield: f.t < 2 ? 0.2 - 0.09 * f.t : 0 });
      const blow = (dmg: number, n: number): void => {
        f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg, shield: true, at: f.at(spot(f, to, n, 1)) });
      };
      if (f.crossed(0.4)) blow(60, 0);
      if (f.crossed(1.2)) blow(13, 1);
      if (f.crossed(1.97)) blow(60, 3);
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
  scar: {
    note: 'hull hits as the server reports them (a ship radius out), on a ship that turns: the scars stay on it and cool',
    period: 7,
    frame: (f) => {
      const from = shooterRel(f), to = targetRel(f);
      const turn = 0.5 + 0.7 * f.t;
      f.ents.push(
        f.ship(SHOOTER, 'lancet', from, f.facing(0.9, 0.18, 0.28), { flags: EntityFlag.Firing }),
        f.ship(TARGET, f.hull, to, f.facing(Math.cos(turn), 0.25 * Math.sin(0.4 * f.t), -Math.sin(turn)), { flags: 0, shield: 0, hull: 0.7 }),
      );
      const blow = (dmg: number, x: number, y: number, z: number): void => {
        f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg, shield: false, at: f.at(toward(f, to, x, y, z, 1)) });
      };
      if (f.crossed(0.4)) blow(13, -0.7, 0.1, -0.7);
      if (f.crossed(0.9)) blow(260, -0.5, -0.1, -0.85);
      if (f.crossed(1.6)) blow(60, 0.2, 0.2, -1);
      // One reported at the centre of the ship, as the fight scene does.
      if (f.crossed(2.4)) f.events.push({ e: 'hit', id: TARGET, by: SHOOTER, dmg: 60, shield: false, at: f.at(to) });
      if (f.crossed(3.2)) blow(210, -0.9, 0.3, -0.3);
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
  fleet: {
    note: 'twelve damaged ships at once, every other one below a fifth of its hull: the load of a large fight',
    period: 8,
    frame: (f) => {
      for (let i = 0; i < 12; i++) {
        const col = i % 4, row = Math.floor(i / 4);
        const a = 0.9 * i + 0.1 * f.clock;
        f.ents.push(f.ship(FLEET + i, f.hull, f.rel((col - 1.5) * 0.42 * f.dist, (row - 1) * 0.3 * f.dist, f.dist * (1 + 0.12 * ((col + row) % 3))),
          f.facing(Math.cos(a), 0.3 * Math.sin(1.7 * i), -Math.sin(a)), { flags: EntityFlag.Thrust, shield: 0, hull: i % 2 ? 0.3 : 0.12 }));
      }
    },
  },
  'own-hit': {
    note: 'the pilot\'s own ship is hit (own=1 or cam=cockpit): three times on its shield, then twice on its hull',
    period: 6,
    frame: (f) => {
      duel(f);
      const id = f.ownId;
      if (id === null) return;
      // Places are given from the camera, which is in the ship (cockpit) or behind it (chase): the
      // hits land ahead of the pilot in the one and on the side he sees in the other.
      const eye = f.rel(0, 0, 0);
      const blow = (dmg: number, shield: boolean, x: number, y: number, z: number): void => {
        const d = f.dir(x, y, z);
        f.events.push({ e: 'hit', id, by: SHOOTER, dmg, shield, at: f.at([eye[0] + d[0], eye[1] + d[1], eye[2] + d[2]]) });
      };
      if (f.crossed(0.4)) blow(60, true, -3, 2, 8);
      if (f.crossed(1.3)) blow(13, true, 4, 1, 8);
      if (f.crossed(2.2)) blow(210, true, -1, 3, 8);
      if (f.crossed(3.4)) blow(60, false, -4, 1, 6);
      if (f.crossed(4.4)) blow(210, false, 3, 2, 6);
    },
  },
};
