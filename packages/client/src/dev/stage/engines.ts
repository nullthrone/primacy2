/**
 * Acts of the effect stage for engines. The pilot's own engines and attitude jets are shown by the
 * `chase` scene (`thrust=fwd|boost|left|...`); this is another ship seen from three quarters behind.
 */
import { EntityFlag } from '@primacy2/shared';
import { TARGET } from './common.ts';
import type { Act } from './types.ts';

export const acts: Record<string, Act> = {
  engines: {
    note: 'another ship from behind: thrust for 2 s, boost for 2 s, engines off for 1 s',
    period: 5,
    frame: (f) => {
      const flags = f.t < 2 ? EntityFlag.Thrust : f.t < 4 ? EntityFlag.Thrust | EntityFlag.Boost : 0;
      // Half the distance of the stage, nose away from the camera and a little to the right.
      f.ents.push(f.ship(TARGET, f.hull, f.rel(0.05 * f.dist, -0.02 * f.dist, 0.5 * f.dist), f.facing(0.5, 0.15, 0.85), { flags }));
    },
  },
};
