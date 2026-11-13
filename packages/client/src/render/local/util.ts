/**
 * Small numeric helpers shared by the local layer. Nothing here allocates per call.
 */
import type { FrameView } from '../../contracts.ts';

export const TAU = Math.PI * 2;

/** Integer hash to [0, 1). */
export function hash01(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Hash of two integers to [0, 1). */
export const hash2 = (a: number, b: number): number => hash01(Math.imul(a | 0, 0x27d4eb2d) ^ (b | 0));

/** Frame-rate independent exponential approach of `cur` toward `target`. */
export const damp = (cur: number, target: number, rate: number, dt: number): number =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** `x` reduced to [0, m). Keeps large universe times out of float32 uniforms and matrices. */
export const wrap = (x: number, m: number): number => ((x % m) + m) % m;

/** Deterministic generator for stand-in geometry (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lattice = (x: number, y: number, z: number): number =>
  hash01(Math.imul(x, 0x1f1f1f1f) ^ Math.imul(y, 0x5f356495) ^ Math.imul(z, 0x2c1b3c6d));

/** Value noise in [0, 1], smooth in all three axes. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const a = lattice(xi, yi, zi), b = lattice(xi + 1, yi, zi);
  const c = lattice(xi, yi + 1, zi), d = lattice(xi + 1, yi + 1, zi);
  const e = lattice(xi, yi, zi + 1), f = lattice(xi + 1, yi, zi + 1);
  const g = lattice(xi, yi + 1, zi + 1), h = lattice(xi + 1, yi + 1, zi + 1);
  const x0 = a + (b - a) * u, x1 = c + (d - c) * u, x2 = e + (f - e) * u, x3 = g + (h - g) * u;
  const y0 = x0 + (x1 - x0) * v, y1 = x2 + (x3 - x2) * v;
  return y0 + (y1 - y0) * w;
}

/** Fractal value noise in [0, 1]. */
export function fbm3(x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x, y, z);
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 5.3;
    z = z * 2.03 + 9.7;
  }
  return sum / norm;
}

/**
 * Half the width of dusk in radians: the sun fades over twice this as it crosses the horizon. A
 * little more than the disc of a sun-like star at 1 AU (0.0047), so the light does not snap off.
 */
const DUSK = 0.012;

/**
 * How much of the sun reaches the camera past the landable body it is near (`view.surface`): 1 in
 * full light, 0 once the mean sphere of that body hides the sun, with a short dusk in between.
 * `sunDir` is the unit vector from the camera toward the sun in system axes. Away from any
 * landable body the answer is 1. Mountains are not looked at: the horizon is that of the sphere,
 * and it drops as the camera climbs, so a ship high above the night side is in sunlight again.
 */
export function sunVisibility(view: FrameView, sunDir: readonly number[]): number {
  const s = view.surface;
  const body = s ? view.bodies[s.body] : undefined;
  if (!body || !(body.dist > 0)) return 1;
  const rel = body.rel;
  // Height of the sun above the level plane at the camera; straight up is away from the centre.
  const sine = -(rel[0] * sunDir[0]! + rel[1] * sunDir[1]! + rel[2] * sunDir[2]!) / body.dist;
  const elevation = Math.asin(clamp(sine, -1, 1));
  const horizon = -Math.acos(Math.min(1, body.def.radius / body.dist));
  return smooth(horizon - DUSK, horizon + DUSK, elevation);
}

// The landing light of a ship in numbers. The `objects` part owns the light, and
// `objects/landing.ts` says what it is and why it is this strong; the effects light the dust a
// ship raises by the same lamp, and the two parts do not know each other, so the numbers are here.

/** Height of a ship's lowest point above the ground, metres, below which its landing light burns. */
export const LANDING_LIGHT_HEIGHT = 500;
/** The lamp comes up to full strength over this many metres of descent. */
const LAMP_SWITCH_ON = 60;
/** Illuminance of level ground straight under the lamp; direct sunlight is about 3. */
const LAMP_POOL = 4;
/** Up to this height above the ground the lamp holds the pool at `LAMP_POOL`; above, the pool thins. */
const LAMP_REGULATED_TO = 160;
/** The lamp is not turned down further than for this height, however near the ground is. */
const LAMP_REGULATED_FROM = 1.5;
/** Share of its night strength the lamp keeps in daylight. */
const LAMP_DAY_LEVEL = 0.1;
/**
 * Half angle of the cone, radians, and the share of it over which the edge fades. Together with
 * the lean the cone ends at the level of the lamp: nothing of it goes up.
 */
export const LAMP_HALF_ANGLE = 1.08;
export const LAMP_PENUMBRA = 0.5;
/** The beam leaves the lamp leaning this far from straight down toward the nose, radians. */
export const LAMP_FORWARD = 0.52;
/**
 * Where the light leaves the ship: this far below the underside of the hull (`ShipStats.belly`,
 * metres) and this share of the hull radius ahead of the origin. The point of light that shows
 * the lamp sits on the hull itself, above that (`Model.chin`).
 */
export const LAMP_DROP = 0.3;
export const LAMP_FORE = 0.4;

/** How far a ship's landing lamp is switched on, 0..1, with its lowest point `height` metres above the ground. */
export const landingLampLevel = (height: number): number => clamp01((LANDING_LIGHT_HEIGHT - height) / LAMP_SWITCH_ON);

/**
 * Strength of the landing lamp of a ship whose lowest point is `height` metres above the ground,
 * scene-referred, for a light that falls off with the distance (not its square): `level` is how
 * far the lamp is switched on (0..1) and `sunlight` how much of the sun reaches the place (0..1).
 * The lamp is regulated by its height above the ground.
 */
export function landingLampIntensity(height: number, level: number, sunlight: number): number {
  const reach = clamp(height + LAMP_DROP, LAMP_REGULATED_FROM, LAMP_REGULATED_TO);
  return LAMP_POOL * reach * level * (LAMP_DAY_LEVEL + (1 - LAMP_DAY_LEVEL) * (1 - sunlight));
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Diffuse reflectance of the ground of a landable body, linear RGB, written to `out`: `color` is
 * the body's base colour (0xRRGGBB, `BodyDef.color`), `cls` its class and `tone` the 0..1 value
 * the shared terrain gives with a height. This is `groundAlbedo` of `terrain/shade.ts` in numbers
 * and must follow it: regolith heaped up by a base and dust kicked up by a ship are the ground
 * they came from, and are tinted with this so they do not stand out from it.
 */
export function groundAlbedo(color: number, cls: string, tone: number, out: number[]): void {
  const r = srgbToLinear(((color >> 16) & 255) / 255);
  const g = srgbToLinear(((color >> 8) & 255) / 255);
  const b = srgbToLinear((color & 255) / 255);
  if (cls === 'ice') {
    const k = 0.34 + 0.7 * tone;
    const t = smooth(0.34, 0.68, tone);
    out[0] = lerp(r * 0.36, lerp(r, 0.93, 0.35) * k, t);
    out[1] = lerp(g * 0.27, lerp(g, 0.96, 0.35) * k, t);
    out[2] = lerp(b * 0.21, lerp(b, 1.0, 0.35) * k, t);
  } else if (cls === 'desert') {
    const k = 0.42 + 1.15 * tone;
    const t = smooth(0.35, 0.8, tone);
    out[0] = r * k * lerp(0.94, 1.05, t);
    out[1] = g * k * lerp(0.97, 1.0, t);
    out[2] = b * k * lerp(1.03, 0.93, t);
  } else {
    const k = 0.3 + 1.5 * tone;
    const t = smooth(0.15, 0.65, tone);
    out[0] = r * k * lerp(0.95, 1.04, t);
    out[1] = g * k * lerp(0.98, 1.0, t);
    out[2] = b * k * lerp(1.05, 0.95, t);
  }
}
