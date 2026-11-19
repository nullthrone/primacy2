/**
 * The ground under an effect. Camera-facing discs of light that reach below the ground are cut by
 * it along a hard line, and what flies apart in all directions flies into it; an effect that may
 * start near the ground of a landable body asks here how high it is and which way is up.
 */
import { G, SURFACE_ID_BASE, bodySurface, terrainSample } from '@primacy2/shared';
import type { Frame } from './core.ts';

export interface GroundBelow {
  /** Height of the point above the ground beneath it, metres. */
  h: number;
  /** Unit vector straight up there, zone axes. */
  ux: number; uy: number; uz: number;
  /** Gravity there, m/s^2. */
  g: number;
}

const SAMPLE = new Float64Array(2);

/**
 * Fills `out` for an anchor-relative point and returns true, or returns false where there is no
 * ground: away from a landable body, or while the zone is not that body's own turning frame (only
 * there is the body's centre the origin of the coordinates effects are kept in).
 */
export function groundBelow(f: Frame, x: number, y: number, z: number, out: GroundBelow): boolean {
  const view = f.view;
  const s = view.surface;
  const self = view.self;
  if (!s || !self || self.state.anchor !== SURFACE_ID_BASE + s.body) return false;
  const ground = bodySurface(view.system, s.body);
  const body = ground ? view.system.bodies[ground.body] : undefined;
  if (!ground || !body) return false;
  const r = Math.sqrt(x * x + y * y + z * z) || 1;
  out.ux = x / r; out.uy = y / r; out.uz = z / r;
  terrainSample(ground.terrain, out.ux, out.uy, out.uz, 0, SAMPLE);
  out.h = r - ground.radius - SAMPLE[0]!;
  out.g = Math.max(0.05, (G * body.mass) / (body.radius * body.radius));
  return true;
}
