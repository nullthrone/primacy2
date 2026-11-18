/** Places and ids the acts of the effect stage share, so every family shows its effect on the same picture. */
import { EntityFlag, HULLS } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
import type { EntityView } from '../../contracts.ts';
import type { StageFrame } from './types.ts';

/** The ship that shoots, and the ship the act is about. */
export const SHOOTER = 40;
export const TARGET = 41;
export const MISSILE = 50;
export const WRECK = 80;

/** Where the ship the act is about stands: a little right of the middle, at the distance of the stage. */
export const targetRel = (f: StageFrame): Vec3 => f.rel(0.28 * f.dist, 0.04 * f.dist, f.dist);

/** Where the shooter stands: to the left and nearer, so its fire crosses the picture. */
export const shooterRel = (f: StageFrame): Vec3 => f.rel(-0.62 * f.dist, -0.14 * f.dist, 0.72 * f.dist);

export const radiusOf = (hull: string): number => HULLS[hull]?.radius ?? 10;

/**
 * Puts the shooter (a Lancet turned toward the target) and the target (side-on, turning slowly)
 * on the stage and returns their places. `extra` changes the target: its shield, its hull, its flags.
 */
export function duel(f: StageFrame, extra: Partial<EntityView> = {}): { from: Vec3; to: Vec3 } {
  const from = shooterRel(f), to = targetRel(f);
  const turn = 0.5 + 0.12 * f.clock;
  f.ents.push(
    f.ship(SHOOTER, 'lancet', from, f.facing(0.9, 0.18, 0.28), { flags: EntityFlag.Firing }),
    f.ship(TARGET, f.hull, to, f.facing(Math.cos(turn), 0.1, -Math.sin(turn)), { flags: 0, shield: 1, ...extra }),
  );
  return { from, to };
}

/** The point on a sphere of `frac` radii around the target that faces the camera-relative point `from`. */
export function facingPoint(f: StageFrame, to: Vec3, from: Vec3, frac: number): Vec3 {
  const d: Vec3 = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
  const k = (radiusOf(f.hull) * frac) / (Math.hypot(d[0], d[1], d[2]) || 1);
  return [to[0] + d[0] * k, to[1] + d[1] * k, to[2] + d[2] * k];
}
