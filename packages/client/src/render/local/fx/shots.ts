/**
 * The light of weapon fire and tool beams: bolts, beams, the line a rail slug leaves, jets of gas,
 * glints and rings. Like the streaks in `ribbons.ts` they are camera-facing segments, but every
 * kind has a shape of its own, and two things hold for all of them:
 *
 * - a smallest size on screen. Nothing here is drawn narrower than about 2.5 pixels, and nothing
 *   is taken from its brightness when it is held there, so fire at 1.5 km still reads as fire;
 * - a largest size on screen. The pilot's own bolt starts a few metres from the eye, where its
 *   real width would fill the canopy with white.
 */
import { QuadBatch } from './batch.ts';

/** A bolt: bright at the head, thinner and dimmer toward the tail. `frac` how much the tail narrows, `value` its brightness. */
export const BOLT = 0;
/** A held beam with waves of brightness running from tail to head. `frac` the strength of its white core, `value` the time in seconds. */
export const BEAM = 1;
/** The line a rail slug leaves, which tears into pieces. `value` age over life, `frac` flight time over life. */
export const WAKE = 2;
/** Gas leaving a point: a cone from the tail outward that thins to nothing. `value` how white its root is. */
export const JET = 3;
/** A point of light (tail and head in one place). `value` how white its core is. */
export const DOT = 4;
/** A circle around an axis. `value` its thickness as a fraction of the radius. */
export const RING = 5;

const VERTEX = /* glsl */ `
attribute vec4 iA; // tail position (camera-relative), half width in metres; of a ring: centre, radius
attribute vec4 iB; // head position; of a ring: its axis. w: the kind plus a fraction the kind reads
attribute vec4 iC; // radiance of the sheath, a value the kind reads
uniform float uPix;
varying vec3 vCol;
varying vec4 vP;   // across -1..1, metres along from the tail, length, drawn half width in metres
varying vec4 vK;   // kind, its fraction, its value, drawn half width in pixels

void main() {
  float kind = floor(iB.w + 0.001);
  vK = vec4(kind, iB.w - kind, iC.a, 8.0);
  vCol = iC.rgb;
  vec3 a = (modelViewMatrix * vec4(iA.xyz, 1.0)).xyz;
  if (kind > 4.5) {
    // A ring lies in the plane across its axis, so it is a circle from ahead and a line from the side.
    vec3 n = normalize(mat3(modelViewMatrix) * iB.xyz);
    vec3 u = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 v = cross(n, u);
    // Seen from the side its line is foreshortened to nothing, and the fragment shader thickens it
    // there to keep it 2.5 pixels wide; the quad leaves room for that.
    float tilt = max(abs(dot(n, normalize(a))), 0.12);
    float th = max(iC.a, 1.5 * uPix * max(-a.z, 0.5) / (iA.w * tilt));
    float ext = 1.0 + 2.2 * th;
    vP = vec4(position.xy * ext, iC.a, th);
    gl_Position = projectionMatrix * vec4(a + (u * position.x + v * position.y) * (iA.w * ext), 1.0);
    return;
  }
  vec3 b = (modelViewMatrix * vec4(iB.xyz, 1.0)).xyz;
  vec3 d = b - a;
  float len = length(d);
  vec3 dir = len > 1e-4 ? d / len : vec3(0.0, 1.0, 0.0);
  float end = position.y * 0.5 + 0.5;
  vec3 p = mix(a, b, end);
  // Widen at right angles to both the segment and the line of sight; a segment seen end-on has no
  // such direction, so any will do.
  vec3 side = cross(dir, p);
  float sl = length(side);
  side = sl > 1e-4 * length(p) ? side / sl : vec3(1.0, 0.0, 0.0);
  float depth = max(-p.z, 0.5);
  float pix = uPix * depth;
  // Never wider than a small angle: what leaves the pilot's own muzzle is a needle, not a wall.
  // Never narrower than two pixels to each side, of which the fragment shader lights 2.5 in all.
  float w = max(min(iA.w, (kind > 3.5 ? 0.07 : 0.016) * depth), 2.0 * pix);
  vec3 pos = p + side * (position.x * w) + dir * (position.y * w);
  vP = vec4(position.x, end * len + position.y * w, len, w);
  vK.w = w / pix;
  gl_Position = projectionMatrix * vec4(pos, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vCol;
varying vec4 vP;
varying vec4 vK;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float noise(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}

void main() {
  float kind = vK.x;
  if (kind > 4.5) {
    float r = length(vP.xy);
    float d = (r - 1.0) / clamp(1.3 * fwidth(r), vP.z, vP.w);
    gl_FragColor = vec4(vCol * exp(-d * d), 1.0);
    return;
  }
  // How much room the shape has on screen: 0 held at the smallest size, 1 with room for a core in a sheath.
  float px = vK.w;
  float room = smoothstep(2.0, 7.0, px);
  float t = vP.z > 1e-4 ? clamp(vP.y / vP.z, 0.0, 1.0) : 1.0;
  float dy = (vP.y - clamp(vP.y, 0.0, vP.z)) / vP.w;
  float x = vP.x;
  float gain = 1.0;    // brightness along the length
  float white = 0.85;  // how far the core is burnt out to white
  float core = 16.0;   // how narrow the core is
  float sheath = 0.2;  // the coloured light around it
  float swell = 1.0;   // how much wider than usual the sheath is
  if (kind < 0.5) {
    // Bolt: the body narrows to the tail and only the head is white-hot.
    x /= mix(1.0, mix(1.0 - vK.y, 1.0, t), room);
    gain = mix(vK.z, 1.0, t * t);
    white = 0.9 * t * t;
    sheath = 0.24;
  } else if (kind < 1.5) {
    // Beam: two trains of waves run from the muzzle outward, a long one and a ripple, so the
    // light is never even along its length; a crest is brighter and a little fatter.
    float lam = clamp(vP.z / 3.0, 12.0, 160.0);
    float c1 = 0.5 + 0.5 * sin(6.2832 * (vP.y / lam - vK.z * 2.5));
    float c2 = sin(6.2832 * (vP.y / (lam * 0.37) - vK.z * 4.0));
    c1 *= c1;
    gain = 0.8 + 0.34 * c1 + 0.1 * c2;
    // The core is far brighter than white, so it is kept thin and the sheath weak: light this
    // strong burns out to white on screen by itself, and a beam that is white all through has no colour.
    white = 0.7 * vK.y / 0.99;
    core = mix(9.0, 60.0, vK.y / 0.99);
    sheath = 0.1 * (0.5 + 1.3 * c1);
    swell = 1.0 + 0.5 * c1;
  } else if (kind < 2.5) {
    // Wake: each place starts to fade when the slug has passed it. It is whole and blazing for
    // an instant; then a threshold that rises with age eats it into shorter and shorter pieces.
    float age = vK.z - t * vK.y;
    if (age < 0.0 || age >= 1.0) discard;
    float s = vP.y + fract(vP.z * 0.371) * 400.0;
    float n = 0.34 * noise(s / 17.0) + 0.36 * noise(s / 4.3) + 0.3 * noise(s / 70.0);
    n = smoothstep(0.3, 0.7, n);
    float flash = exp(-age * 40.0);
    float cut = 1.15 * pow(age, 0.75) - 0.05;
    gain = (0.5 * pow(1.0 - age, 1.5) + 1.2 * flash) * smoothstep(cut, cut + 0.2, n);
    white = 0.2 + 0.6 * flash;
    core = 30.0 * (1.0 + 2.0 * age);
    sheath = 0.1 + 0.12 * flash;
  } else if (kind < 3.5) {
    // Jet: a cone that is densest at its root.
    x /= mix(1.0, mix(0.16, 1.0, t), room);
    gain = pow(1.0 - t, 1.6) * smoothstep(0.0, 0.07, t);
    white = vK.z * (1.0 - t) * (1.0 - t);
    core = 3.5;
    sheath = 0.0;
  } else {
    white = vK.z;
    core = 22.0;
  }
  float r2 = x * x + dy * dy;
  if (r2 >= 1.0) discard;
  // The core keeps 2.5 pixels however thin the shape really is.
  core = min(core, 0.444 * px * px);
  float glow = kind > 3.5 ? 0.09 / (1.0 + 36.0 * r2) : sheath * exp(-r2 * 3.0 / (swell * swell));
  vec3 hot = vec3(max(vCol.r, max(vCol.g, vCol.b)));
  // Held at its smallest size a shot is all core; it keeps its colour there, or every weapon would be white at range.
  vec3 col = mix(vCol, hot, white * mix(0.3, 1.0, room)) * exp(-r2 * core) + vCol * glow * room;
  // Light many times brighter than white spreads on screen: it burns out a wider line and blooms.
  // With room that is the white-hot core. At the smallest size it would make a bar of every hairline,
  // so there the light is no stronger than it takes to show the 2.5 pixels at full brightness.
  float keep = mix(min(1.0, 3.0 / max(hot.r, 1e-3)), 1.0, room);
  gl_FragColor = vec4(col * (gain * keep * smoothstep(1.0, 0.7, sqrt(r2))), 1.0);
}`;

export class Shots extends QuadBatch {
  constructor(max: number) {
    super(max, ['iA', 'iB', 'iC'], VERTEX, FRAGMENT);
  }

  /**
   * Adds a segment of `kind` from tail (a) to head (b), camera-relative. `width` is the half width
   * of the whole glow, the core about a quarter of it; `frac` (0 to 1) and `value` are what the
   * kind says they are.
   */
  seg(kind: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number,
      r: number, g: number, b: number, frac: number, value: number): void {
    const i = this.next();
    if (i < 0) return;
    const d = this.data;
    d[i] = ax; d[i + 1] = ay; d[i + 2] = az; d[i + 3] = width;
    // The fraction rides on the kind and must stay below the next one.
    d[i + 4] = bx; d[i + 5] = by; d[i + 6] = bz; d[i + 7] = kind + Math.min(Math.max(frac, 0), 0.99);
    d[i + 8] = r; d[i + 9] = g; d[i + 10] = b; d[i + 11] = value;
  }

  /** A point of light of `radius` metres whose core is `white` (0 to 1) burnt out. */
  dot(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, white: number): void {
    this.seg(DOT, x, y, z, x, y, z, radius, r, g, b, 0, white);
  }

  /** A circle of `radius` metres around the unit axis n, its line `thickness` of the radius wide. */
  ring(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number,
       r: number, g: number, b: number, thickness: number): void {
    this.seg(RING, x, y, z, nx, ny, nz, radius, r, g, b, 0, thickness);
  }
}
