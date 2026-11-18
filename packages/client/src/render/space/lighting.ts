import type { BodyDef, Vec3 } from '@primacy2/shared';
import { Color } from 'three';
import type { Texture } from 'three';
import type { BodyView, Lighting } from '../../contracts.ts';

const SOLAR_LUM = 3.828e26;
/** Sunlight at 1 AU, W/m^2. Fluxes are expressed as multiples of this. */
const SOLAR_CONSTANT = 1361;

/** Colour of a black body at `kelvin`, linear RGB with the largest channel at 1. */
export function kelvinToLinear(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const lin = (v: number): number => Math.pow(Math.min(255, Math.max(0, v)) / 255, 2.2);
  const out: [number, number, number] = [lin(r), lin(g), lin(b)];
  const m = Math.max(out[0], out[1], out[2], 1e-6);
  return [out[0] / m, out[1] / m, out[2] / m];
}

const tmpColor = new Color();

/** Linear RGB of a 0xRRGGBB colour from the universe definition. */
export function hexToLinear(hex: number): [number, number, number] {
  tmpColor.setHex(hex);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

/** Luminosity used for lighting. Compact objects without a stated luminosity get a nominal glow. */
export function effectiveLum(def: BodyDef): number {
  if (def.kind !== 'star') return 0;
  if (def.lum !== undefined && def.lum > 0) return def.lum;
  return def.disk ? SOLAR_LUM * 0.3 : SOLAR_LUM * 0.02;
}

/** Colour of the light a star-like body emits, linear RGB with the largest channel at 1. */
export function starColor(def: BodyDef): [number, number, number] {
  if (def.cls === 'BH') {
    const c = hexToLinear(def.disk ? def.disk.color : def.color);
    const m = Math.max(c[0], c[1], c[2], 1e-6);
    return [c[0] / m, c[1] / m, c[2] / m];
  }
  return kelvinToLinear(def.temp > 500 ? def.temp : 5800);
}

export interface StarLight {
  /** Index into the frame's bodies. */
  index: number;
  /** Unit vector from the lit point toward the star. */
  dir: Vec3;
  /** Flux at the lit point in multiples of sunlight at 1 AU. */
  flux: number;
  color: [number, number, number];
}

/** The star that lights the point `at` (camera-relative, metres) most strongly, or null without stars. */
export function dominantStar(bodies: readonly BodyView[], at: Readonly<Vec3>, skip = -1): StarLight | null {
  let best: StarLight | null = null;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    if (i === skip || b.def.kind !== 'star') continue;
    const dx = b.rel[0] - at[0], dy = b.rel[1] - at[1], dz = b.rel[2] - at[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!(d2 > 1)) continue;
    const flux = effectiveLum(b.def) / (4 * Math.PI * d2) / SOLAR_CONSTANT;
    if (!best || flux > best.flux) {
      const d = Math.sqrt(d2);
      best = { index: i, dir: [dx / d, dy / d, dz / d], flux, color: starColor(b.def) };
    }
  }
  return best;
}

/** Lighting of the local scene: the dominant star as a directional light, compressed into a usable range. */
export function computeLighting(bodies: readonly BodyView[], envMap: Texture | null): Lighting {
  const star = dominantStar(bodies, [0, 0, 0]);
  if (!star) {
    return { sunDir: [0.4, 0.6, 0.69], sunColor: [1, 1, 1], sunIntensity: 0.3, ambient: 0.06, envMap };
  }
  // 3 at one solar constant; a fourth root keeps the outer system lit and the corona survivable.
  const intensity = Math.min(4, Math.max(0.3, 3 * Math.pow(star.flux, 0.25)));
  const c = star.color;
  return {
    sunDir: star.dir,
    sunColor: [0.35 + 0.65 * c[0], 0.35 + 0.65 * c[1], 0.35 + 0.65 * c[2]],
    sunIntensity: intensity,
    ambient: 0.06,
    envMap,
  };
}
