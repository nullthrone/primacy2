/** Acts of the effect stage for ships blowing up. */
import { EntityFlag, EntityKind } from '@primacy2/shared';
import { SHOOTER, TARGET, WRECK, radiusOf, shooterRel, targetRel } from './common.ts';
import type { Act, StageFrame } from './types.ts';

/** The ship of the act stands for `fuse` seconds, blows up, and its wreck stays; a second ship stands by to be lit. */
function blast(f: StageFrame, fuse: number): void {
  const to = targetRel(f);
  const rot = f.facing(Math.cos(0.5), 0.1, -Math.sin(0.5));
  f.ents.push(f.ship(SHOOTER, 'lancet', shooterRel(f), f.facing(0.9, 0.18, 0.28), { flags: 0 }));
  if (f.t < fuse) {
    f.ents.push(f.ship(TARGET, f.hull, to, rot, { flags: EntityFlag.Thrust, shield: 0, hull: 0.05 }));
  } else {
    f.ents.push({
      id: WRECK, info: { id: WRECK, kind: EntityKind.Wreck, name: 'Wreck', model: f.hull, radius: radiusOf(f.hull) },
      rel: to, vel: [0, 0, 0], rot, flags: 0, hull: 1, shield: 0,
    });
  }
  if (f.crossed(fuse)) f.events.push({ e: 'destroyed', id: TARGET, by: SHOOTER, at: f.at(to) });
}

export const acts: Record<string, Act> = {
  blast: { note: 'a ship blows up one second in; its wreck stays (hull=<id> for another size)', period: 12, frame: (f) => blast(f, 1) },
};
