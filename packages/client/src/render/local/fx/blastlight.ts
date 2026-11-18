/**
 * The light and the gas of a blast, as camera-facing discs of its own kinds:
 *
 *   CORE   the flash: a small blinding point whose light falls off steeply and far, not a disc
 *          that is evenly white
 *   SHELL  the gas the blast drives out ahead of everything else: a thick soft shell, seen
 *          through, so it is brightest toward its rim; gone in a fraction of a second
 *   VEIL   what is left of that gas: a thin uneven cloud that grows at a steady rate (nothing
 *          slows it in vacuum), glows for a moment and after that only scatters the sun
 *
 * A disc that reaches below the ground would be cut by it along a hard line. One that starts near
 * the ground therefore knows its height and which way is up, and is lifted as it grows so that it
 * sits on the ground instead (see `ground.ts`).
 */
import type { Lighting } from '../../../contracts.ts';
import { QuadBatch } from './batch.ts';
import { Pool, type Frame } from './core.ts';

export const CORE = 0;
export const SHELL = 1;
export const VEIL = 2;

const VERTEX = /* glsl */ `
attribute vec4 iP; // centre (camera-relative), radius in metres
attribute vec4 iC; // radiance, kind
attribute vec4 iQ; // param, seed
uniform float uPix;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vK;   // kind, param, seed

void main() {
  vec3 c = (modelViewMatrix * vec4(iP.xyz, 1.0)).xyz;
  // Never smaller than two pixels in radius; what is lost in size is taken from the brightness.
  float rad = max(iP.w, 2.0 * uPix * max(-c.z, 0.5));
  vUv = position.xy;
  vCol = iC.rgb * (iP.w / rad);
  vK = vec3(iC.a, iQ.x, iQ.y);
  gl_Position = projectionMatrix * vec4(c + vec3(position.xy * rad, 0.0), 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vK;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Three octaves: the veil is thin and often fills the view, so it has to be cheap.
float fbm(vec2 p) {
  mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
  float s = 0.5 * noise(p);
  p = turn * p * 2.03 + vec2(17.1, 5.3);
  s += 0.25 * noise(p);
  p = turn * p * 2.03 + vec2(17.1, 5.3);
  return (s + 0.125 * noise(p)) / 0.875;
}

void main() {
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  float win = (1.0 - r2) * (1.0 - r2);
  float light;
  if (vK.x < 0.5) {
    // 'param' is the size of the hot point as a share of the radius; around it the light falls
    // off like scattered light, with no edge anywhere.
    light = pow(1.0 + r2 / (vK.y * vK.y), -1.25) * win;
  } else if (vK.x < 1.5) {
    // A shell seen through: most gas lies along the line of sight near its rim, at 'param' of the
    // radius, little in the middle, and it has no edge on either side.
    float r = sqrt(r2);
    float band = (r - vK.y) / 0.19;
    // Gas is never even: the shell is denser on some sides than on others.
    vec2 around = vUv / max(r, 1e-3);
    float uneven = 0.5 + noise(around * 1.7 + vK.z * 31.0);
    light = (exp(-band * band) * uneven + 0.12) * (1.0 - r2);
  } else {
    // Gas that left a point in all directions keeps that in its shape: streaks along the radius,
    // most of it well away from the middle. That is what tells it from smoke.
    float r = sqrt(r2);
    vec2 around = vUv / max(r, 1e-3);
    vec2 q = around * 2.6 + vK.z * vec2(37.0, 17.0);
    float n = fbm(q + 0.45 * r + 0.9 * (fbm(q * 2.1 + r * 0.8) - 0.5));
    float fine = noise(around * 9.0 + r * 1.7 + vK.z * 53.0);
    light = smoothstep(0.38, 0.8, n) * (0.6 + 0.8 * fine) * r2 * win * 6.75;
  }
  gl_FragColor = vec4(vCol * light, 1.0);
}`;

export interface Disc {
  kind: number;
  /** Relative to the zone anchor. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Negative while the disc waits for its start. */
  age: number;
  life: number;
  /** Radius at the start and at the end of its life. */
  s0: number; s1: number;
  /** Its own glow: colour times gain. On a veil this is the heat that is gone in half a second. */
  r: number; g: number; b: number;
  /** 0..1: how far the glow cools toward red over its life. */
  cool: number;
  /** A veil only: how much of the sunlight it scatters toward the camera when it is at its densest. */
  lit: number;
  param: number;
  seed: number;
  /** Height of its start above the ground and the unit vector up there; `h` is Infinity in space. */
  h: number; ux: number; uy: number; uz: number;
}

const make = (): Disc => ({
  kind: CORE, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s0: 1, s1: 1, r: 0, g: 0, b: 0, cool: 0, lit: 0,
  param: 0.05, seed: 0, h: Infinity, ux: 0, uy: 1, uz: 0,
});

/** How much of its radius a disc keeps above the ground: the outer part of each kind is too faint for a cut to show. */
const SIT = [0.3, 0.9, 0.75] as const;

export class BlastLight extends QuadBatch {
  private readonly pool: Pool<Disc>;
  /** Handed out when the pool is full, so callers can set optional fields without checking. */
  private readonly spare = make();

  constructor(max: number) {
    super(max, ['iP', 'iC', 'iQ'], VERTEX, FRAGMENT);
    this.pool = new Pool(max, make);
  }

  /** Starts a disc and returns it, so the caller can set the optional fields (velocity, delay, ground, ...). */
  spawn(kind: number, x: number, y: number, z: number, life: number, s0: number, s1: number,
        r: number, g: number, b: number, gain: number): Disc {
    const p = this.pool.take() ?? this.spare;
    p.kind = kind; p.x = x; p.y = y; p.z = z; p.vx = 0; p.vy = 0; p.vz = 0;
    p.age = 0; p.life = life; p.s0 = s0; p.s1 = s1;
    p.r = r * gain; p.g = g * gain; p.b = b * gain;
    p.cool = 0; p.lit = 0; p.param = kind === CORE ? 0.05 : 0.7; p.seed = Math.random();
    p.h = Infinity; p.ux = 0; p.uy = 1; p.uz = 0;
    return p;
  }

  /** Steps the discs and writes them into the batch. `light` is the light that reaches the camera. */
  update(f: Frame, light: Lighting): void {
    this.begin();
    const items = this.pool.items;
    const d = this.data;
    const sun = light.sunIntensity;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      if (p.age < 0) continue;
      if (p.age >= p.life) { this.pool.free(i); continue; }
      const o = this.next();
      if (o < 0) continue;
      const t = p.age / p.life, u = 1 - t;
      let rad: number, r: number, g: number, b: number;
      if (p.kind === VEIL) {
        rad = p.s0 + (p.s1 - p.s0) * t;
        // The same gas in a growing volume: it thins as it spreads, and is let go at the end.
        const thin = Math.pow(p.s0 / rad, 1.2) * Math.min(1, p.age / 0.3) * Math.min(1, (p.life - p.age) / 1.5);
        const lit = p.lit * sun * thin, hot = Math.exp(-p.age / 0.4) * Math.min(1, p.age / 0.08);
        // Thin gas scatters the blue of the sunlight best.
        r = light.sunColor[0] * lit * 0.78 + p.r * hot;
        g = light.sunColor[1] * lit * 0.92 + p.g * hot;
        b = light.sunColor[2] * lit * 1.1 + p.b * hot;
      } else if (p.kind === SHELL) {
        rad = p.s0 + (p.s1 - p.s0) * t;
        const k = u * u;
        r = p.r * k; g = p.g * k; b = p.b * k;
      } else {
        // The flash is at its brightest at once and falls away quickly; it swells a little as it goes.
        rad = p.s0 + (p.s1 - p.s0) * (1 - u * u * u);
        const k = u * u * u;
        r = p.r * k; g = p.g * k * (1 - 0.6 * p.cool * t); b = p.b * k * (1 - 0.9 * p.cool * t);
      }
      let x = p.x + p.vx * p.age, y = p.y + p.vy * p.age, z = p.z + p.vz * p.age;
      if (p.h < 1e9) {
        // How far it has climbed since its start, and how far it must be lifted to clear the ground.
        const climbed = (p.vx * p.ux + p.vy * p.uy + p.vz * p.uz) * p.age;
        const lift = rad * SIT[p.kind]! - (p.h + climbed);
        if (lift > 0) { x += p.ux * lift; y += p.uy * lift; z += p.uz * lift; }
      }
      d[o] = x + f.zx; d[o + 1] = y + f.zy; d[o + 2] = z + f.zz; d[o + 3] = rad;
      d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = p.kind;
      d[o + 8] = p.param; d[o + 9] = p.seed; d[o + 10] = 0; d[o + 11] = 0;
    }
    this.end();
  }

  clear(): void {
    this.pool.count = 0;
  }
}
