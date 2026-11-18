/** Acts of the effect stage for other ships arriving and leaving: by fold and by cruise. */
import { EntityFlag } from '@primacy2/shared';
import { TARGET, targetRel } from './common.ts';
import type { Act, StageFrame } from './types.ts';

/** The ship of the act is on the stage while `here` holds; it points across the picture. */
function ship(f: StageFrame, here: boolean, flags = 0): void {
  if (here) f.ents.push(f.ship(TARGET, f.hull, targetRel(f), f.facing(0.94, 0.05, -0.33), { flags }));
}

export const acts: Record<string, Act> = {
  'fold-in': {
    note: 'a ship arrives by fold one second in',
    period: 5,
    frame: (f) => {
      // The effect pulls space in for a quarter second before the flash; the ship is there from the flash on.
      ship(f, f.t >= 1.26);
      if (f.crossed(1)) f.events.push({ e: 'fold', id: TARGET, out: false, at: f.at(targetRel(f)) });
    },
  },
  'fold-out': {
    note: 'a ship leaves by fold two seconds in',
    period: 5,
    frame: (f) => {
      ship(f, f.t < 2, EntityFlag.Charging);
      if (f.crossed(2)) f.events.push({ e: 'fold', id: TARGET, out: true, at: f.at(targetRel(f)) });
    },
  },
  'cruise-on': {
    note: 'a ship engages cruise two seconds in and is gone along its heading',
    period: 5,
    frame: (f) => {
      ship(f, f.t < 2, EntityFlag.Thrust | EntityFlag.Charging);
      if (f.crossed(2)) f.events.push({ e: 'cruise', id: TARGET, on: true, at: f.at(targetRel(f)) });
    },
  },
  'cruise-off': {
    note: 'a ship drops out of cruise one second in',
    period: 5,
    frame: (f) => {
      ship(f, f.t >= 1.2, EntityFlag.Thrust);
      if (f.crossed(1)) f.events.push({ e: 'cruise', id: TARGET, on: false, at: f.at(targetRel(f)) });
    },
  },
};
