/**
 * Geometry of the HUD's direction indicators, as pure functions: where the arrow for something
 * off screen stands and which way it points, where a dot sits on the compass, where contacts and
 * places stand on the radar, how fast the ship closes on a target, and which labels have to give
 * way to others.
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

/**
 * The radar shows the space around the ship as seen from behind and above it: the ship's own
 * plane is a disc drawn as an ellipse, ahead is up the screen, and whatever lies above or below
 * the plane stands on a stalk. Positions are in units of the disc's radius from its middle, x to
 * the right and y down the screen.
 */
/** What a length along the nose keeps of itself in that view: the sine of the angle the plane is seen at. */
export const RADAR_SQUASH = 0.5;
/** What a length straight up from the plane keeps of itself. */
export const RADAR_LIFT = Math.sqrt(1 - RADAR_SQUASH * RADAR_SQUASH);
/** The distances of the radar's rings in metres, innermost first; the last is its rim. Each ring is ten times the one inside it. */
export const RADAR_RINGS = [100, 1_000, 10_000, 100_000] as const;
/** Radius of the innermost ring. Whatever is nearer stands on it, clear of the ship's own mark in the middle. */
export const RADAR_INNER = 0.16;
/** The longest stalk of a mark on the rim: a place straight above or below the ship. */
export const RADAR_RIM_STALK = 0.42;
/** How far from the middle anything on the radar can reach: a mark at the side of the rim on its longest stalk. */
export const RADAR_REACH = Math.hypot(1, RADAR_RIM_STALK);

const RADAR_NEAR = RADAR_RINGS[0];
const RADAR_FAR = RADAR_RINGS[RADAR_RINGS.length - 1]!;

/**
 * How far from the middle of the radar something `dist` metres away stands: a logarithmic scale
 * from the innermost ring to the rim, so that a pod 200 m off and a ship 50 km off both have a
 * place. Nearer than the innermost ring stands on it, farther than the rim on the rim.
 */
export function radarRadius(dist: number): number {
  if (!(dist > RADAR_NEAR)) return RADAR_INNER;
  if (dist >= RADAR_FAR) return 1;
  return RADAR_INNER + ((1 - RADAR_INNER) * Math.log(dist / RADAR_NEAR)) / Math.log(RADAR_FAR / RADAR_NEAR);
}

export interface RadarPoint {
  /** Where the head stands. */
  x: number;
  y: number;
  /** Where its stalk meets the ship's plane: at the same x, at this y. The head is above the plane when `y < foot`. */
  foot: number;
}

export interface RadarBlip extends RadarPoint {
  /** Farther away than the rim reaches: it stands on the rim in its direction. */
  beyond: boolean;
}

/**
 * A contact on the radar. `c` is where it is in the ship's own axes (x right, y up, nose along
 * -z), in metres. Its direction is kept and its distance goes through `radarRadius`, so the head
 * never leaves the circle around the disc.
 */
export function radarBlip(c: Readonly<Vec3>): RadarBlip {
  const dist = Math.hypot(c[0], c[1], c[2]);
  if (!(dist > 0)) return { x: 0, y: 0, foot: 0, beyond: false };
  const k = radarRadius(dist) / dist;
  const foot = c[2] * k * RADAR_SQUASH;
  return { x: c[0] * k, y: foot - c[1] * k * RADAR_LIFT, foot, beyond: dist > RADAR_FAR };
}

export interface RadarRimMark extends RadarPoint {
  /** The bearing in the ship's plane, radians: 0 is ahead, a quarter turn is to the right. */
  bearing: number;
}

/**
 * A place on the rim of the radar: far beyond its scale, so only the direction is shown. The foot
 * stands on the rim at the bearing in the ship's plane, and the stalk says how far above or below
 * the plane the place lies (its full length is straight up or down). Straight above or below
 * there is no bearing: the mark then keeps `held`, the bearing it had before, or stands ahead.
 */
export function radarRim(c: Readonly<Vec3>, held?: number): RadarRimMark {
  const len = Math.hypot(c[0], c[1], c[2]);
  const side = Math.hypot(c[0], c[2]);
  const bearing = len > 0 && side > len * SIDE_MIN ? Math.atan2(c[0], -c[2]) : held ?? 0;
  const foot = -Math.cos(bearing) * RADAR_SQUASH;
  return { x: Math.sin(bearing), y: foot - (len > 0 ? c[1] / len : 0) * RADAR_RIM_STALK, foot, bearing };
}

/**
 * How fast the ship closes on something, m/s: the part of their relative velocity that points
 * from the ship at it, positive while the distance shrinks. `to` is where it is relative to the
 * ship; `vel` and `otherVel` are the two velocities in one frame (a place stands still in it).
 *
 * This is the pilot's own approach, on purpose, and not the rate at which the distance changes:
 * between two places on different orbits that rate is tens of kilometres per second while the
 * ship lies still, and says nothing about the way there.
 */
export function closingSpeed(to: Readonly<Vec3>, vel: Readonly<Vec3>, otherVel?: Readonly<Vec3>): number {
  const len = Math.hypot(to[0], to[1], to[2]);
  if (!(len > 0)) return 0;
  const rx = vel[0] - (otherVel?.[0] ?? 0);
  const ry = vel[1] - (otherVel?.[1] ?? 0);
  const rz = vel[2] - (otherVel?.[2] ?? 0);
  return (rx * to[0] + ry * to[1] + rz * to[2]) / len;
}

/** Slowest approach that still gets a time of arrival, m/s. */
const ETA_MIN_CLOSING = 0.5;
/** Longest time of arrival worth showing, seconds. */
const ETA_MAX = 100 * 3600;

/** Seconds until arrival at the present closing speed; null while not approaching or too far off to say. */
export function arrival(dist: number, closing: number): number | null {
  if (!(closing >= ETA_MIN_CLOSING)) return null;
  const s = dist / closing;
  return s <= ETA_MAX ? s : null;
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

export const boxesOverlap = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Keeps an arrow clear of the blocks of the HUD: where the rectangle it takes up (`boxOf`, the
 * arrow with its label) would lie over one of `blocks`, the arrow moves toward the middle of the
 * `w` by `h` view along its own direction, in steps, until it is clear. Its angle stays. The
 * blocks stand at the rim of the view, so the way inward is the way out of them; an arrow that is
 * still not clear at a third of its distance stays there.
 */
export function pullClear(mark: EdgeMark, w: number, h: number, boxOf: (m: EdgeMark) => Box, blocks: readonly Box[]): EdgeMark {
  if (blocks.length === 0) return mark;
  let m = mark;
  for (let k = 1; ; k -= 0.06) {
    m = k === 1 ? mark : { ...mark, x: w / 2 + (mark.x - w / 2) * k, y: h / 2 + (mark.y - h / 2) * k };
    const box = boxOf(m);
    if (k - 0.06 < 1 / 3 || !blocks.some((b) => boxesOverlap(b, box))) return m;
  }
}

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
