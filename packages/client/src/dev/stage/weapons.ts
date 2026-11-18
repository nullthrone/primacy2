/** Acts of the effect stage for weapon fire and tool beams. */
import { EntityKind, HULLS } from '@primacy2/shared';
import { SHOOTER, TARGET, WRECK, duel, facingPoint, shooterRel, targetRel } from './common.ts';
import type { Act, StageFrame } from './types.ts';

/**
 * The shooter fires `weapon` at the target `rate` times a second; every shot lands on the shield.
 * With an own ship on the stage, that fires the same weapon half a beat later.
 */
function fire(f: StageFrame, weapon: string, rate: number, dmg: number): void {
  const { from, to } = duel(f);
  if (f.ticked(rate, 0.3)) {
    f.events.push(
      { e: 'shot', from: SHOOTER, w: weapon, slot: 0, to: TARGET, at: f.at(to) },
      { e: 'hit', id: TARGET, by: SHOOTER, dmg, shield: true, at: f.at(facingPoint(f, to, from, 1.15)) },
    );
  }
  if (f.ownId !== null && f.ticked(rate, 0.3 + 0.5 / rate)) {
    f.events.push(
      { e: 'shot', from: f.ownId, w: weapon, slot: 0, to: TARGET, at: f.at(to) },
      { e: 'hit', id: TARGET, by: f.ownId, dmg, shield: true, at: f.at(facingPoint(f, to, f.rel(0, 0, 0), 1.15)) },
    );
  }
}

export const acts: Record<string, Act> = {
  pulse: { note: 'pulse laser, tier 1 (hot): four bolts a second onto a shield', period: 4, frame: (f) => fire(f, 'pulse_1', 4, 13) },
  pulse2: { note: 'pulse laser, tier 2 (cold)', period: 4, frame: (f) => fire(f, 'pulse_2', 4.5, 21) },
  cannon: { note: 'cannon: five tracer rounds a second', period: 4, frame: (f) => fire(f, 'cannon_1', 5, 24) },
  rail: { note: 'rail gun: one slug every two seconds', period: 4, frame: (f) => fire(f, 'rail_1', 0.5, 260) },
  beam: {
    note: 'beam laser: held for 2.4 s, off for 1.6 s',
    period: 4,
    frame: (f) => {
      const { from, to } = duel(f);
      // The server reports a held beam about ten times a second.
      if (f.t >= 0.3 && f.t < 2.7 && f.ticked(10, 0.3)) {
        f.events.push(
          { e: 'shot', from: SHOOTER, w: 'beam_1', slot: 0, to: TARGET, at: f.at(to) },
          { e: 'hit', id: TARGET, by: SHOOTER, dmg: 6, shield: true, at: f.at(facingPoint(f, to, from, 1.15)) },
        );
      }
      if (f.ownId !== null && f.t >= 0.6 && f.t < 3 && f.ticked(10, 0.6)) {
        f.events.push({ e: 'shot', from: f.ownId, w: 'beam_1', slot: 0, to: TARGET, at: f.at(to) });
      }
    },
  },
  miss: {
    note: 'shots into empty space: bolts, tracers and a beam that touch nothing',
    period: 6,
    frame: (f) => {
      const { from, to } = duel(f);
      // Past the target by a ship's length and on for 900 m, as the fight scene does.
      const d = [to[0] - from[0], to[1] - from[1] + 2.2 * (HULLS[f.hull]?.radius ?? 10), to[2] - from[2]] as const;
      const k = 900 / Math.hypot(d[0], d[1], d[2]);
      const far = f.at([from[0] + d[0] * k, from[1] + d[1] * k, from[2] + d[2] * k]);
      if (f.t < 2 && f.ticked(4, 0.2)) f.events.push({ e: 'shot', from: SHOOTER, w: 'pulse_1', slot: 0, at: far });
      if (f.t >= 2 && f.t < 4 && f.ticked(5, 2.1)) f.events.push({ e: 'shot', from: SHOOTER, w: 'cannon_1', slot: 0, at: far });
      if (f.t >= 4 && f.t < 5.6 && f.ticked(10, 4.1)) f.events.push({ e: 'shot', from: SHOOTER, w: 'beam_1', slot: 0, at: far });
    },
  },
  torch: {
    note: 'salvage torch: a ship cuts up a wreck',
    period: 6,
    frame: (f) => {
      const from = shooterRel(f), to = targetRel(f);
      f.ents.push(
        f.ship(SHOOTER, 'delver', from, f.facing(0.9, 0.18, 0.28), { flags: 0 }),
        {
          id: WRECK, info: { id: WRECK, kind: EntityKind.Wreck, name: 'Wreck', model: f.hull, radius: HULLS[f.hull]?.radius ?? 10 },
          rel: to, vel: [0, 0, 0], rot: f.facing(Math.cos(0.1 * f.clock), 0.4, Math.sin(0.1 * f.clock)), flags: 0, hull: 1 - f.t / 6, shield: 0,
        },
      );
      // The server reports a tool beam about four times a second.
      if (f.t >= 0.4 && f.t < 5 && f.ticked(4, 0.4)) f.events.push({ e: 'salvage', from: SHOOTER, id: WRECK, at: f.at(to) });
    },
  },
};
