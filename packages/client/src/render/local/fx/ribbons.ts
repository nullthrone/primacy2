/**
 * Camera-facing streaks of light: bolts, beams, tracers, trails and sparks. Each is a segment with a
 * hot core and a soft skirt, brightest at its head and fading toward its tail.
 */
import { QuadBatch } from './batch.ts';

const VERTEX = /* glsl */ `
attribute vec4 iA; // tail position (camera-relative), half width in metres
attribute vec4 iB; // head position, 1 for rounded ends or 0 for flat ones
attribute vec4 iC; // radiance at the head, brightness of the tail relative to the head
uniform float uPix;
varying vec3 vCol;
varying vec4 vP;   // across -1..1, metres along from the tail, length, half width
varying vec2 vS;   // how much of the drawn width is real, tail brightness

void main() {
  vec3 a = (modelViewMatrix * vec4(iA.xyz, 1.0)).xyz;
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
  // Never thinner than a pixel on each side, or distant fire would break up into dots.
  float w = max(iA.w, uPix * max(-p.z, 0.5));
  float real = iA.w / w;
  float cap = position.y * iB.w;
  vec3 pos = p + side * (position.x * w) + dir * (cap * w);
  vP = vec4(position.x, end * len + cap * w, len, w);
  vS = vec2(real, iC.a);
  vCol = iC.rgb * sqrt(real);
  gl_Position = projectionMatrix * vec4(pos, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vCol;
varying vec4 vP;
varying vec2 vS;

void main() {
  float dy = (vP.y - clamp(vP.y, 0.0, vP.z)) / vP.w;
  float r2 = vP.x * vP.x + dy * dy;
  if (r2 >= 1.0) discard;
  // A streak wider than its pixel floor has a narrow core; one held at the floor is flat across.
  float sharp = mix(2.5, 16.0, vS.x * vS.x);
  float win = (1.0 - r2) * (1.0 - r2);
  float light = (exp(-r2 * sharp) + 0.14 * exp(-r2 * 3.0)) * win;
  float t = vP.z > 1e-4 ? clamp(vP.y / vP.z, 0.0, 1.0) : 1.0;
  gl_FragColor = vec4(vCol * light * mix(vS.y, 1.0, t), 1.0);
}`;

export class Ribbons extends QuadBatch {
  constructor(max: number) {
    super(max, ['iA', 'iB', 'iC'], VERTEX, FRAGMENT);
  }

  /**
   * Adds a streak from tail (a) to head (b), camera-relative. `width` is the half width of the
   * whole glow; the core is about a quarter of it. `tail` is the brightness of the tail relative
   * to the head, `cap` 1 for rounded ends, 0 for flat ends that join the next segment of a trail.
   */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number,
      r: number, g: number, b: number, tail: number, cap: number): void {
    const i = this.next();
    if (i < 0) return;
    const d = this.data;
    d[i] = ax; d[i + 1] = ay; d[i + 2] = az; d[i + 3] = width;
    d[i + 4] = bx; d[i + 5] = by; d[i + 6] = bz; d[i + 7] = cap;
    d[i + 8] = r; d[i + 9] = g; d[i + 10] = b; d[i + 11] = tail;
  }
}
