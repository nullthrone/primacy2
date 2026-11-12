/**
 * Camera-facing discs of light: flashes and glares, thin rings, and the torn puffs of fire an
 * explosion is made of.
 */
import { QuadBatch } from './batch.ts';

/** A point of light: a small hot core in a soft skirt. */
export const GLOW = 0;
/** A thin circle at 0.82 of the radius; `param` is its thickness as a fraction of the radius. */
export const RING = 1;
/** A ragged cloud of fire that is eaten away as `param` goes from 0 to 1. */
export const PUFF = 2;

const VERTEX = /* glsl */ `
attribute vec4 iP; // centre (camera-relative), radius in metres
attribute vec4 iC; // radiance, kind
attribute vec4 iQ; // param, seed, rotation, aspect
uniform float uPix;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vK;   // kind, param, seed

void main() {
  vec3 c = (modelViewMatrix * vec4(iP.xyz, 1.0)).xyz;
  // Never smaller than a pixel in radius; what is lost in size is taken from the brightness.
  float rad = max(iP.w, uPix * max(-c.z, 0.5));
  float cs = cos(iQ.z), sn = sin(iQ.z);
  vec2 o = position.xy * vec2(1.0, iQ.w);
  o = vec2(o.x * cs - o.y * sn, o.x * sn + o.y * cs) * rad;
  vUv = position.xy;
  // A small disc the camera is all but inside of (the pilot's own muzzle flash) must not white out
  // the view. Large ones, like the flash of a nearby explosion, are meant to.
  float inside = smoothstep(0.5, 2.0, length(c) / rad);
  vCol = iC.rgb * (iP.w / rad) * mix(inside, 1.0, smoothstep(3.0, 8.0, iP.w));
  vK = vec3(iC.a, iQ.x, iQ.y);
  gl_Position = projectionMatrix * vec4(c + vec3(o, 0.0), 1.0);
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
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  // Each octave is turned against the last, which hides the grid the noise is built on.
  mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = turn * p * 2.03 + vec2(17.1, 5.3); a *= 0.5; }
  return s / 0.96875;
}

void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float r2 = r * r;
  float win = (1.0 - r2) * (1.0 - r2);
  float light;
  if (vK.x < 0.5) {
    // The skirt falls off like scattered light, so even a blinding flash has a soft edge.
    light = (exp(-r2 * 22.0) + 0.09 / (1.0 + 36.0 * r2)) * win;
  } else if (vK.x < 1.5) {
    float d = (r - 0.82) / max(vK.y, 0.004);
    light = exp(-d * d) * smoothstep(1.0, 0.95, r);
  } else {
    // Fire as warped noise in a round body. The threshold rises with age, so the puff tears into
    // wisps and thins out instead of fading as a whole.
    vec2 q = vUv * 2.3 + vK.z * vec2(37.0, 17.0);
    vec2 warp = vec2(fbm(q * 1.3 + 3.1), fbm(q * 1.3 - 5.2)) - 0.5;
    float n = fbm(q + 1.7 * warp);
    float fall = 1.0 - r2;
    float body = n * fall * 2.0;
    float cut = mix(0.1, 1.0, vK.y);
    light = smoothstep(cut, cut + 0.4, body) * (0.3 + body) * fall;
  }
  gl_FragColor = vec4(vCol * light, 1.0);
}`;

export class Sprites extends QuadBatch {
  constructor(max: number) {
    super(max, ['iP', 'iC', 'iQ'], VERTEX, FRAGMENT);
  }

  /** Adds a disc at a camera-relative position. `aspect` below 1 squashes it into an ellipse turned by `rot`. */
  add(x: number, y: number, z: number, radius: number, r: number, g: number, b: number,
      kind: number, param: number, seed: number, rot: number, aspect: number): void {
    const i = this.next();
    if (i < 0) return;
    const d = this.data;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = radius;
    d[i + 4] = r; d[i + 5] = g; d[i + 6] = b; d[i + 7] = kind;
    d[i + 8] = param; d[i + 9] = seed; d[i + 10] = rot; d[i + 11] = aspect;
  }

  /** A plain point of light. */
  glow(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void {
    this.add(x, y, z, radius, r, g, b, GLOW, 0, 0, 0, 1);
  }
}
