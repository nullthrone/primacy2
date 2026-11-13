/**
 * The hand-over between the far view of a landable body and its ground tiles, as two numbers that
 * depend only on how high the camera is. The space layer and the terrain part both use them, so
 * they agree without talking to each other.
 *
 * Above `handoverAltitude` the body is the far view alone: a smooth sphere shaded from the far
 * map. At that height the tiles appear, flat on the same sphere and shaded from the same map, so
 * nothing changes on screen. From there down to half that height the relief grows from nothing to
 * full (`reliefAt`) and the tiles' own finer maps take over, while the far view's sphere shrinks
 * under the lowest ground: whatever a tile does not cover yet shows the far view behind it.
 */

/** Height above the mean radius (m) below which the ground tiles are drawn. */
export const handoverAltitude = (radius: number): number => Math.max(0.5 * radius, 100_000);

/** 0 at and above the hand-over height, 1 (full relief) at and below half of it. `dist` is from the body centre, metres. */
export function reliefAt(radius: number, dist: number): number {
  const top = handoverAltitude(radius);
  const x = Math.min(1, Math.max(0, (top - (dist - radius)) / (0.5 * top)));
  return x * x * (3 - 2 * x);
}

/** How far below the lowest ground the far view's sphere lies at full relief, metres. */
export const FAR_SPHERE_MARGIN = 200;
