/**
 * The hand-over between the far view of a landable body (drawn by the space layer) and its
 * ground tiles (drawn by the terrain part), by how high the camera is.
 *
 * Above `handoverAltitude` the body is the far view alone: a smooth sphere shaded from the far
 * map. At that height the tiles appear, flat on the same sphere and shaded from the same map by
 * the same code, so nothing changes on screen. From there down to half that height the relief
 * grows from nothing to full (`reliefAt`) and the tiles' own finer maps take over. While tiles are
 * drawn the far view's sphere sinks under the lowest ground, so it never shows above a low
 * horizon and is still there behind anything a tile does not cover.
 */
import type { SystemDef } from '@primacy2/shared';

/** Height above the mean radius (m) below which the ground tiles are drawn. */
export const handoverAltitude = (radius: number): number => Math.max(radius, 100_000);

/** 0 at and above the hand-over height, 1 (full relief) at and below half of it. `dist` is from the body centre, metres. */
export function reliefAt(radius: number, dist: number): number {
  const top = handoverAltitude(radius);
  const x = Math.min(1, Math.max(0, (top - (dist - radius)) / (0.5 * top)));
  return x * x * (3 - 2 * x);
}

/** How far below the lowest ground the far view's sphere lies at full relief, metres. */
export const FAR_SPHERE_MARGIN = 200;

/**
 * What the terrain part draws this frame, for the far view: the body whose tiles are on screen
 * (`body` -1 when none are) and their relief. The terrain part writes it before the space layer
 * draws; without the part it stays empty and every body is its far view alone.
 */
export const groundShown: { system: SystemDef | null; body: number; relief: number } = { system: null, body: -1, relief: 0 };
