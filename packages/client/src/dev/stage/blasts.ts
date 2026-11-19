/** Acts of the effect stage for ships blowing up. */
import { EntityFlag, EntityKind } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
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

/** A cargo pod, the smallest thing that blows up, is destroyed after `fuse` seconds; nothing is left of it. */
function pod(f: StageFrame, fuse: number): void {
  const to = targetRel(f);
  f.ents.push(f.ship(SHOOTER, 'lancet', shooterRel(f), f.facing(0.9, 0.18, 0.28), { flags: 0 }));
  if (f.t < fuse) {
    f.ents.push({
      id: POD, info: { id: POD, kind: EntityKind.Loot, name: 'iron', model: 'cargo_pod', radius: 2, c: 'iron', n: 4 },
      rel: to, vel: [0, 0, 0], rot: f.facing(0.3, 0.5, 0.8), flags: 0, hull: 1, shield: 0,
    });
  }
  if (f.crossed(fuse)) f.events.push({ e: 'destroyed', id: POD, by: SHOOTER, at: f.at(to) });
}

/**
 * A ship crosses the picture at `speed` m/s and blows up after `fuse` seconds; its wreck drifts on
 * as the server's does, and the cloud and the after-blasts have to go with it.
 */
function drifting(f: StageFrame, fuse: number, speed: number): void {
  const start = targetRel(f);
  const along = f.dir(-1, 0.1, 0), vel: Vec3 = [along[0] * speed, along[1] * speed, along[2] * speed];
  const s = (f.t - fuse) * speed;
  const to: Vec3 = [start[0] + along[0] * s, start[1] + along[1] * s, start[2] + along[2] * s];
  const rot = f.facing(-1, 0.1, 0);
  f.ents.push(f.ship(SHOOTER, 'lancet', shooterRel(f), f.facing(0.9, 0.18, 0.28), { flags: 0 }));
  if (f.t < fuse) {
    f.ents.push(f.ship(TARGET, f.hull, to, rot, { flags: EntityFlag.Thrust, shield: 0, hull: 0.05, vel }));
  } else {
    f.ents.push({
      id: WRECK, info: { id: WRECK, kind: EntityKind.Wreck, name: 'Wreck', model: f.hull, radius: radiusOf(f.hull) },
      rel: to, vel, rot, flags: 0, hull: 1, shield: 0,
    });
  }
  if (f.crossed(fuse)) f.events.push({ e: 'destroyed', id: TARGET, by: SHOOTER, at: f.at(to) });
}

const POD = 81;

export const acts: Record<string, Act> = {
  blast: { note: 'a ship blows up one second in; its wreck stays (hull=<id> for another size)', period: 12, frame: (f) => blast(f, 1) },
  'blast-pod': { note: 'a cargo pod blows up one second in: the smallest blast', period: 6, frame: (f) => pod(f, 1) },
  'blast-drift': { note: 'a ship blows up one second in while it crosses the picture at 12 m/s; its wreck drifts on', period: 12, frame: (f) => drifting(f, 1, 12) },
};
