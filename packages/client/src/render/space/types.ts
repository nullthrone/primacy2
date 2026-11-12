import type { BodyDef, Vec3 } from '@primacy2/shared';
import type { FrameView } from '../../contracts.ts';

/** The part of a frame view the space renderer reads; the idle backdrop builds one without a game. */
export type SpaceFrame = Pick<FrameView, 'time' | 'dt' | 'clock' | 'system' | 'camera' | 'bodies' | 'fx' | 'galaxy' | 'graphics'>;

/** Per-frame values derived from the camera and the render target. */
export interface ViewParams {
  /** Angle covered by one render-target pixel at the centre of the view, radians. */
  pixAngle: number;
  /** Render-target size in pixels. */
  width: number;
  height: number;
  quality: 0 | 1 | 2;
  /** Seconds since the page loaded, for shader animation. Shaders only use it at slow rates, so float32 is enough. */
  clock: number;
}

/**
 * Rotation axis of a body in system axes (unit vector): +Y tilted toward +Z by the body's tilt.
 * Rings, accretion disks and jets are laid out around it. This matches the generated universe,
 * where ring sites and moons orbit with inclination = tilt and ascending node 0.
 */
export function bodyAxis(def: BodyDef): Vec3 {
  return [0, Math.cos(def.tilt), Math.sin(def.tilt)];
}

/** A body's seed reduced to a small float that is safe to use as a noise offset in shaders. */
export function seedFloat(seed: number): number {
  return ((seed >>> 0) % 9973) / 9973 * 60;
}

/** FNV-1a hash of a string, as an unsigned 32-bit integer. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic generator (mulberry32) returning floats in 0..1. */
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
