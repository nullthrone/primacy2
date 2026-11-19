/**
 * Marks that sit on a ship where a shot landed. On the hull a scar: the place where the shot went
 * in, glowing for a few seconds and cooling from white through orange to a dull red. On a shield a
 * glint: the shot's own light for the instant before it is gone into the shell. Both belong to
 * their ship: they are kept in the ship's own axes and move and turn with it.
 *
 * A scar is drawn as a patch that lies on the plating, so it narrows as the plating turns away and
 * is gone when it faces away from the camera. Neither is ever smaller than a few pixels, and both
 * keep their brightness when they are held at that size: at fighting range a ship is a handful of
 * pixels, and a hit on it has to be seen.
 */
import type { Vec3 } from '@primacy2/shared';
import { QuadBatch } from './batch.ts';
import { Pool, rotate, type Frame, type Track } from './core.ts';

const VERTEX = /* glsl */ `
attribute vec4 iP; // centre (camera-relative), radius in metres
attribute vec4 iN; // a scar: the way the plating faces (zone axes); a glint: its radiance. Then heat 1..0
attribute vec4 iC; // gain, seed, metres it is pulled toward the camera, kind (0 scar, 1 glint)
uniform float uPix;
varying vec2 vUv;
varying vec4 vK;   // heat, seed, share of the drawn size that is real, gain
varying vec4 vTint;

void main() {
  vec3 c = (modelViewMatrix * vec4(iP.xyz, 1.0)).xyz;
  float dist = max(length(c), 0.5);
  vec3 toCam = -c / dist;
  bool glint = iC.w > 0.5;
  vec3 n = glint ? toCam : normalize(mat3(modelViewMatrix) * iN.xyz);
  float facing = dot(n, toCam);
  // Never smaller than 2.5 pixels in radius, and no dimmer for it.
  float rad = max(iP.w, 2.5 * uPix * dist);
  float real = iP.w / rad;
  // A scar lies on the plating: full size along the line the plating shares with the screen,
  // narrowed across it. Held at its smallest size it is a round dot.
  vec3 t1 = cross(n, toCam);
  float l = length(t1);
  t1 = l > 1e-3 ? t1 / l : vec3(1.0, 0.0, 0.0);
  vec3 t2 = cross(toCam, t1);
  float narrow = mix(1.0, max(abs(facing), 0.4), real);
  vec3 pos = c + (t1 * position.x + t2 * (position.y * narrow)) * rad;
  // The place is only roughly on the hull. Drawn nearer the camera along the line of sight, it
  // lies over the plating instead of inside it, and stays where it is on the screen.
  pos *= 1.0 - min(iC.z / dist, 0.5);
  vUv = position.xy;
  // Plating that faces away shows nothing.
  vK = vec4(iN.w, iC.y, real, iC.x * smoothstep(-0.3, 0.1, facing));
  vTint = vec4(iN.xyz, iC.w);
  gl_Position = projectionMatrix * vec4(pos, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vK;
varying vec4 vTint;

void main() {
  if (vTint.a > 0.5) {
    // A glint: a point of light in a soft skirt; held at its smallest size, an even dot.
    float q2 = dot(vUv, vUv);
    if (q2 >= 1.0) discard;
    float light = exp(-q2 * mix(1.5, 10.0, vK.z)) + 0.07 * vK.z;
    gl_FragColor = vec4(vTint.rgb * (vK.w * vK.x * vK.x * light * (1.0 - q2) * (1.0 - q2)), 1.0);
    return;
  }
  // A ragged outline: torn metal does not glow as a circle.
  float ang = atan(vUv.y, vUv.x);
  float rag = 1.0 + (0.2 * sin(ang * 3.0 + vK.y * 40.0) + 0.11 * sin(ang * 7.0 + vK.y * 90.0)) * vK.z;
  float r = length(vUv) * rag;
  if (r >= 1.0) discard;
  float r2 = r * r;
  float win = (1.0 - r2) * (1.0 - r2);
  // Hottest in the middle; the colour follows the temperature, so a fresh scar is white with an
  // orange edge and an old one red all over. A scar held at its smallest size is one temperature.
  float x = vK.x * exp(-r2 * mix(1.2, 6.0, vK.z));
  vec3 col = vec3(1.0, 0.85 * pow(x, 1.5), 0.7 * pow(x, 3.2)) * x * x;
  // What the hot metal throws on the plating around it.
  col += vec3(1.0, 0.3, 0.06) * 0.05 * vK.x * vK.x;
  gl_FragColor = vec4(col * vK.w * win, 1.0);
}`;

class MarkBatch extends QuadBatch {
  constructor(max: number) {
    super(max, ['iP', 'iN', 'iC'], VERTEX, FRAGMENT);
  }

  add(x: number, y: number, z: number, radius: number, nx: number, ny: number, nz: number, heat: number,
      gain: number, seed: number, pull: number, kind: number): void {
    const i = this.next();
    if (i < 0) return;
    const d = this.data;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = radius;
    d[i + 4] = nx; d[i + 5] = ny; d[i + 6] = nz; d[i + 7] = heat;
    d[i + 8] = gain; d[i + 9] = seed; d[i + 10] = pull; d[i + 11] = kind;
  }
}

const SCAR = 0, GLINT = 1;

interface Mark {
  id: number;
  kind: number;
  /** Place in the ship's own axes. */
  x: number; y: number; z: number;
  /** A scar: the way the plating faces, in the ship's axes. A glint: its radiance. */
  nx: number; ny: number; nz: number;
  age: number; life: number;
  radius: number;
  gain: number;
  seed: number;
}

const MAX_MARKS = 128;
const P: Vec3 = [0, 0, 0];
const N: Vec3 = [0, 0, 0];

export class Scars {
  private readonly batch = new MarkBatch(MAX_MARKS);
  readonly mesh = this.batch.mesh;
  private readonly pool = new Pool<Mark>(MAX_MARKS, () => ({ id: 0, kind: SCAR, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, age: 0, life: 1, radius: 1, gain: 1, seed: 0 }));

  private take(t: Track, kind: number, x: number, y: number, z: number, radius: number, life: number, gain: number): Mark {
    let p = this.pool.take();
    if (!p) {
      // All in use: the new one takes the place of the one that is furthest gone.
      p = this.pool.items[0]!;
      for (let i = 1; i < this.pool.count; i++) {
        const q = this.pool.items[i]!;
        if (q.age / q.life > p.age / p.life) p = q;
      }
    }
    p.id = t.id; p.kind = kind; p.x = x; p.y = y; p.z = z;
    p.age = 0; p.life = life; p.radius = radius; p.gain = gain; p.seed = Math.random();
    return p;
  }

  /** A scar on the hull of `t` at (x, y, z), facing (nx, ny, nz), both in the ship's axes. */
  spawn(t: Track, x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number, life: number, gain: number): void {
    const p = this.take(t, SCAR, x, y, z, radius, life, gain);
    p.nx = nx; p.ny = ny; p.nz = nz;
  }

  /** A glint of the colour (r, g, b) at (x, y, z) in the axes of `t`, shrinking and gone after `life` seconds. */
  glint(t: Track, x: number, y: number, z: number, r: number, g: number, b: number, radius: number, life: number, gain: number): void {
    const p = this.take(t, GLINT, x, y, z, radius, life, gain);
    p.nx = r; p.ny = g; p.nz = b;
  }

  update(f: Frame): void {
    const items = this.pool.items, batch = this.batch;
    batch.begin();
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      const host = f.tracks.get(p.id);
      // A track outlives its ship by a few seconds; what sat on the ship does not.
      if (p.age >= p.life || !host || host.seen < f.now) { this.pool.free(i); continue; }
      const t = p.age / p.life;
      rotate(host, p.x, p.y, p.z, P);
      const x = host.x + P[0] + f.zx, y = host.y + P[1] + f.zy, z = host.z + P[2] + f.zz;
      if (p.kind === GLINT) {
        batch.add(x, y, z, p.radius * (1 - 0.7 * t), p.nx, p.ny, p.nz, 1 - t, p.gain, p.seed, 0, GLINT);
        continue;
      }
      // Fast at first and ever slower, as hot metal cools; and out at the end.
      const end = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
      rotate(host, p.nx, p.ny, p.nz, N);
      batch.add(x, y, z, p.radius, N[0], N[1], N[2], Math.exp(-3.3 * t) * end, p.gain, p.seed, 0.3 * host.radius, SCAR);
    }
    batch.end();
  }

  clear(): void {
    this.pool.count = 0;
  }

  dispose(): void {
    this.batch.dispose();
  }
}
