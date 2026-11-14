/**
 * Geometry of the HUD's direction indicators, as pure functions: where the arrow for something
 * off screen stands and which way it points, where a dot sits on the compass, how fast a distance
 * closes, and which labels have to give way to others.
 *
 * Camera space here is what `quat.unrotate(camera.rot, rel)` gives: x to the right, y up, and the
 * view along -z, so a point with positive z lies behind the viewer.
 */
import type { Vec3 } from '@primacy2/shared';

/** The arrows stand on an ellipse around the middle of the view, clear of the HUD blocks in the corners. */
export const EDGE_RX = 0.42;
export const EDGE_RY = 0.27;
/** Below this share of its length a direction has no sideways part worth pointing along. */
const SIDE_MIN = 1e-3;

export interface EdgeMark {
  /** CSS pixels from the top left of the view. */
  x: number;
  y: number;
  /** Direction the arrow points in, radians: 0 to the right, a quarter turn is down the screen. */
  angle: number;
  /** The point lies behind the viewer. */
  behind: boolean;
}

/**
 * The arrow for a point at `c` in camera space, in a view of `w` by `h` pixels. It points the way
 * the nose has to turn, also for a point behind the viewer. Dead ahead or dead astern there is no
 * such way: the arrow then keeps `held`, the angle it had before, or points down.
 */
export function edgeMark(c: Readonly<Vec3>, w: number, h: number, held?: number): EdgeMark {
  const len = Math.hypot(c[0], c[1], c[2]);
  const side = Math.hypot(c[0], c[1]);
  const angle = len > 0 && side > len * SIDE_MIN ? Math.atan2(-c[1], c[0]) : held ?? Math.PI / 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const rx = w * EDGE_RX;
  const ry = h * EDGE_RY;
  const k = 1 / Math.hypot(dx / rx, dy / ry);
  return { x: w / 2 + dx * k, y: h / 2 + dy * k, angle, behind: c[2] > 0 };
}

export interface CompassDot {
  /** Position on the disc in units of its radius: x to the right, y down the screen. */
  x: number;
  y: number;
  /** In the forward half: the dot is drawn filled. Behind, it is drawn hollow. */
  front: boolean;
}

/**
 * Where a direction sits on the compass: the unit sphere seen from behind the ship, so dead ahead
 * and dead astern are both the middle (filled and hollow) and the rim is a quarter turn away.
 * `c` is the direction in the ship's own axes (x right, y up, nose along -z).
 */
export function compassDot(c: Readonly<Vec3>): CompassDot {
  const len = Math.hypot(c[0], c[1], c[2]);
  if (!(len > 0)) return { x: 0, y: 0, front: true };
  return { x: c[0] / len, y: -c[1] / len, front: c[2] <= 0 };
}

/** Running estimate of how fast the distance to one thing changes. */
export interface RangeRate {
  /** What is being tracked; a new key starts over. */
  key: string;
  /** Time of the last sample, seconds. */
  at: number;
  dist: number;
  /** Closing speed in m/s: positive while the distance shrinks. */
  closing: number;
  /** False until two samples have been seen: there is no rate yet. */
  ready: boolean;
}

/** Seconds over which the closing speed is smoothed. */
const RATE_SMOOTH = 0.4;
/** A gap longer than this between two samples starts the estimate over, seconds. */
const RATE_GAP = 1;

/** Takes one more sample of the distance to `key` at time `at` (seconds) and returns the new estimate. */
export function trackRate(prev: RangeRate | null, key: string, at: number, dist: number): RangeRate {
  if (!prev || prev.key !== key) return { key, at, dist, closing: 0, ready: false };
  const dt = at - prev.at;
  if (dt < 0 || dt > RATE_GAP) return { key, at, dist, closing: 0, ready: false };
  // Two frames at the same time (a paused view) add nothing.
  if (dt < 1e-4) return prev;
  const now = (prev.dist - dist) / dt;
  const closing = prev.ready ? prev.closing + (now - prev.closing) * (1 - Math.exp(-dt / RATE_SMOOTH)) : now;
  return { key, at, dist, closing, ready: true };
}

/** Slowest approach that still gets a time of arrival, m/s. */
const ETA_MIN_CLOSING = 0.5;
/** Longest time of arrival worth showing, seconds. */
const ETA_MAX = 100 * 3600;

/** Seconds until arrival at the present closing speed; null while not approaching or too far off to say. */
export function arrival(dist: number, rate: RangeRate | null): number | null {
  if (!rate || !rate.ready || rate.closing < ETA_MIN_CLOSING) return null;
  const s = dist / rate.closing;
  return s <= ETA_MAX ? s : null;
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

export const boxesOverlap = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Lets labels give way to each other: goes through the boxes in the order given (most important
 * first) and returns, per box, whether it may be drawn without running into one drawn before it.
 */
export function declutter(boxes: readonly Box[]): boolean[] {
  const kept: Box[] = [];
  return boxes.map((b) => {
    if (kept.some((k) => boxesOverlap(k, b))) return false;
    kept.push(b);
    return true;
  });
}
