/**
 * The effect stage: `/dev/local.html?scene=fx`. Every effect of the local layer on its own, close
 * to the camera and repeating, so it can be looked at, compared and measured.
 *
 *   show=<act>[,<act>]  which acts play, one after the other (default: all of them in turn)
 *   dist=<m>            distance of the action from the camera (default 90)
 *   hull=<id>           the ship the act is about (default wisp); the shooter is a Lancet
 *   every=<s>           the act starts over after that many seconds instead of its own period;
 *                       a short value gives a steady load to measure a frame time under
 *   own=1               the pilot's own ship is on the stage too and fires where an act has fire
 *                       (always so with cam=cockpit)
 *   slow=<factor>       the scene clock runs at that fraction of real time (any scene)
 *   info=0              without the name of the act in the corner
 *
 * The acts are listed below, family by family; a family is one file. An act that needs an asteroid
 * field (the mining beam) is not here: `scene=belt` shows it. The engines and jets of the pilot's
 * own ship are in `scene=chase`, the ground in `scene=surface`, and the effects that lie over the
 * picture (`cruise`, `fold`, `charge`, `kind`, `heat`, `hit`, `dil`) work as options of any scene.
 */
import { acts as blasts } from './blasts.ts';
import { acts as engines } from './engines.ts';
import { acts as hits } from './hits.ts';
import { acts as transits } from './transits.ts';
import type { Act } from './types.ts';
import { acts as weapons } from './weapons.ts';

export type { Act, StageFrame } from './types.ts';

export const ACTS: Record<string, Act> = { ...weapons, ...hits, ...blasts, ...transits, ...engines };

/** Which act plays at a scene clock, how far into it, and in which repetition. */
export interface Cue { name: string; act: Act; t: number; round: number }

/** The acts named in `show` (all when it names none), with `every` in place of their periods when given. */
export function programme(show: string, every: number): (clock: number) => Cue {
  const picked = show.split(',').map((s) => s.trim()).filter((s) => ACTS[s]);
  const names = picked.length ? picked : Object.keys(ACTS);
  const spans = names.map((n) => (every > 0 ? every : ACTS[n]!.period));
  const total = spans.reduce((a, b) => a + b, 0);
  return (clock) => {
    const lap = Math.floor(clock / total);
    let rest = clock - lap * total;
    let i = 0;
    while (i < names.length - 1 && rest >= spans[i]!) rest -= spans[i++]!;
    return { name: names[i]!, act: ACTS[names[i]!]!, t: rest, round: lap };
  };
}
