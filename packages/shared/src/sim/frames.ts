/**
 * A ship's position, velocity and orientation are stored in the frame of its anchor. These
 * functions express them in system axes or in the frame of another anchor. They are exact for
 * every pair of frames, rotating (surface frames, ground sites) or not.
 */
import { quat, v3, type Quat, type Vec3 } from '../math.ts';
import { anchorBody, anchorFrame, anchorState, isRotatingAnchor } from '../universe/orbits.ts';
import type { SystemDef } from '../universe/types.ts';
import type { ShipState } from './types.ts';

/** Barycentric position of a ship: the origin of its anchor frame plus its offset in system axes. */
export function absolutePosition(s: ShipState, sys: SystemDef, t: number): Vec3 {
  // A ship in a fold tunnel has no anchor; its offset is returned unchanged.
  if (s.anchor < 0) return v3.clone(s.pos);
  if (!isRotatingAnchor(sys, s.anchor)) return v3.add(anchorState(sys, s.anchor, t).pos, s.pos);
  const f = anchorFrame(sys, s.anchor, t);
  return v3.add(f.pos, quat.rotate(f.rot, s.pos));
}

/**
 * Barycentric velocity of a ship in system axes. In a rotating frame this includes the speed at
 * which the frame carries the ship around (omega x r). In cruise `vel` is not a physical velocity.
 */
export function absoluteVelocity(s: ShipState, sys: SystemDef, t: number): Vec3 {
  if (s.anchor < 0) return v3.clone(s.vel);
  if (!isRotatingAnchor(sys, s.anchor)) return v3.add(anchorState(sys, s.anchor, t).vel, s.vel);
  const f = anchorFrame(sys, s.anchor, t);
  const r = quat.rotate(f.rot, s.pos);
  return v3.add(f.vel, v3.add(quat.rotate(f.rot, s.vel), v3.cross(f.omega, r)));
}

/** Orientation of a ship in system axes. */
export function absoluteRotation(s: ShipState, sys: SystemDef, t: number): Quat {
  if (s.anchor < 0 || !isRotatingAnchor(sys, s.anchor)) return quat.clone(s.rot);
  return quat.normalize(quat.mul(anchorFrame(sys, s.anchor, t).rot, s.rot));
}

/**
 * Re-expresses position, velocity and orientation relative to another anchor without changing
 * the trajectory: the barycentric position and velocity and the orientation in system axes are
 * the same before and after.
 */
export function reanchor(s: ShipState, sys: SystemDef, newAnchor: number, t: number): void {
  if (newAnchor === s.anchor) return;
  if (!isRotatingAnchor(sys, s.anchor) && !isRotatingAnchor(sys, newAnchor)) {
    const from = anchorState(sys, s.anchor, t);
    const to = anchorState(sys, newAnchor, t);
    // The anchor difference is formed first so the small ship offset is not lost in the large sum.
    v3.addScaledIn(s.pos, v3.sub(from.pos, to.pos), 1);
    v3.addScaledIn(s.vel, v3.sub(from.vel, to.vel), 1);
    s.anchor = newAnchor;
    return;
  }
  const from = anchorFrame(sys, s.anchor, t);
  const to = anchorFrame(sys, newAnchor, t);
  // Offset and velocity relative to the old origin, in system axes. A rotating frame carries
  // the ship around, which is a velocity the ship has in every non-rotating frame.
  const r = quat.rotate(from.rot, s.pos);
  const v = v3.add(quat.rotate(from.rot, s.vel), v3.cross(from.omega, r));
  // Between a body frame and the surface frame of the same body the origin does not move at all.
  const sameOrigin = anchorBody(s.anchor) >= 0 && anchorBody(s.anchor) === anchorBody(newAnchor);
  if (!sameOrigin) {
    v3.addScaledIn(r, v3.sub(from.pos, to.pos), 1);
    v3.addScaledIn(v, v3.sub(from.vel, to.vel), 1);
  }
  // Into the new frame: take off what the new frame carries, then turn into its axes.
  v3.addScaledIn(v, v3.cross(to.omega, r), -1);
  const pos = quat.unrotate(to.rot, r);
  const vel = quat.unrotate(to.rot, v);
  const rot = quat.normalize(quat.mul(quat.conj(to.rot), quat.mul(from.rot, s.rot)));
  v3.copy(s.pos, pos);
  v3.copy(s.vel, vel);
  s.rot[0] = rot[0];
  s.rot[1] = rot[1];
  s.rot[2] = rot[2];
  s.rot[3] = rot[3];
  s.anchor = newAnchor;
}
