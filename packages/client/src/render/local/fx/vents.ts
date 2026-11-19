/**
 * Gas leaving a hull: the short white puff a heavy hit lets out, and the thin jet a ship close to
 * breaking up loses its air through. In vacuum gas does not billow or hang: it leaves in a narrow
 * cone, widening and thinning until it is nothing. No smoke, no fire.
 *
 * Each is one camera-facing quad along the jet, narrow at the root and wide at the end, with faint
 * streaks running outward in it.
 */
import type { Vec3 } from '@primacy2/shared';
import { QuadBatch } from './batch.ts';
import { Pool, rotate, type Frame, type Track } from './core.ts';

const VERTEX = /* glsl */ `
attribute vec4 iA; // root (camera-relative), length in metres
attribute vec4 iB; // unit direction (zone axes), half width at the end in metres
attribute vec4 iC; // radiance, seed, time, how far the front of the gas has got along the length 0..1
uniform float uPix;
varying vec3 vP;   // across -1..1, along 0..1, share of the drawn width that is real
varying vec4 vC;

void main() {
  vec3 a = (modelViewMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 dir = normalize(mat3(modelViewMatrix) * iB.xyz);
  float u = position.y * 0.5 + 0.5;
  vec3 p = a + dir * (u * iA.w);
  // Widened at right angles to both the jet and the line of sight; a jet seen end-on has no such
  // direction, so any will do.
  vec3 side = cross(dir, p);
  float sl = length(side);
  side = sl > 1e-4 * length(p) ? side / sl : vec3(1.0, 0.0, 0.0);
  float want = iB.w * mix(0.12, 1.0, pow(u, 0.8));
  // Never thinner than a pixel on each side; gas is faint, and what it gains in width it loses in light.
  float w = max(want, 1.1 * uPix * max(-p.z, 0.5));
  vP = vec3(position.x, u, want / w);
  vC = iC;
  gl_Position = projectionMatrix * vec4(p + side * (position.x * w), 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vP;
varying vec4 vC;

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

void main() {
  float x = vP.x, u = vP.y;
  float x2 = x * x;
  if (x2 >= 1.0) discard;
  float across = exp(-x2 * 3.2) * (1.0 - x2);
  // Dense at the root and thinner the wider it gets; nothing ahead of the front of the gas.
  float spread = mix(0.12, 1.0, pow(u, 0.8));
  float along = smoothstep(0.0, 0.03, u) * pow(1.0 - u, 1.4) * min(0.3 / spread, 1.6)
    * (1.0 - smoothstep(vC.a - 0.25, vC.a, u));
  // Streaks that run outward, stretched along the jet.
  float n = noise(vec2(x * spread * 5.0 + vC.g * 61.0, u * 5.0 - vC.b * 7.0));
  float m = noise(vec2(x * spread * 13.0 - vC.g * 23.0, u * 11.0 - vC.b * 12.0));
  float streak = 0.45 + 0.75 * n + 0.4 * m;
  // Sunlit gas is white with a trace of blue.
  gl_FragColor = vec4(vec3(0.86, 0.93, 1.0) * (vC.r * across * along * streak * vP.z), 1.0);
}`;

class JetBatch extends QuadBatch {
  constructor(max: number) {
    super(max, ['iA', 'iB', 'iC'], VERTEX, FRAGMENT);
  }

  add(x: number, y: number, z: number, len: number, dx: number, dy: number, dz: number, width: number,
      gain: number, seed: number, time: number, front: number): void {
    const i = this.next();
    if (i < 0) return;
    const d = this.data;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = len;
    d[i + 4] = dx; d[i + 5] = dy; d[i + 6] = dz; d[i + 7] = width;
    d[i + 8] = gain; d[i + 9] = seed; d[i + 10] = time; d[i + 11] = front;
  }
}

interface Puff {
  id: number;
  /** Root and direction in the ship's own axes. */
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  age: number; life: number;
  len: number; width: number;
  gain: number;
  seed: number;
}

const MAX_PUFFS = 24, MAX_JETS = 24;
const P: Vec3 = [0, 0, 0];
const N: Vec3 = [0, 0, 0];

export class Vents {
  private readonly batch = new JetBatch(MAX_PUFFS + MAX_JETS);
  readonly mesh = this.batch.mesh;
  private readonly pool = new Pool<Puff>(MAX_PUFFS, () => ({ id: 0, x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, age: 0, life: 1, len: 1, width: 1, gain: 1, seed: 0 }));

  /** Empties the batch; jets and puffs of this frame are written after it and uploaded by `end`. */
  begin(): void {
    this.batch.begin();
  }

  /**
   * A jet for this frame only, from a camera-relative root along a unit direction in zone axes;
   * a leak that lasts calls it every frame with the same `seed`.
   */
  jet(x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, width: number, gain: number, seed: number, time: number): void {
    this.batch.add(x, y, z, len, dx, dy, dz, width, gain, seed, time, 1.25);
  }

  /** A puff out of the hull of `t`: root and unit direction in the ship's axes. It shoots out to `len` metres and thins away. */
  puff(t: Track, x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, width: number, gain: number, life: number): void {
    const p = this.pool.take();
    if (!p) return;
    p.id = t.id; p.x = x; p.y = y; p.z = z; p.dx = dx; p.dy = dy; p.dz = dz;
    p.age = 0; p.life = life; p.len = len; p.width = width; p.gain = gain; p.seed = Math.random();
  }

  /** Steps the puffs and writes them; between `begin` and `end`. */
  update(f: Frame): void {
    const items = this.pool.items;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      const host = f.tracks.get(p.id);
      if (p.age >= p.life || !host || host.seen < f.now) { this.pool.free(i); continue; }
      const t = p.age / p.life, u = 1 - t;
      rotate(host, p.x, p.y, p.z, P);
      rotate(host, p.dx, p.dy, p.dz, N);
      // The gas is out at once and then only thins: the front runs ahead while the root dies down.
      const reach = 1 - Math.exp(-p.age * 16);
      this.batch.add(host.x + P[0] + f.zx, host.y + P[1] + f.zy, host.z + P[2] + f.zz, p.len * (0.5 + 0.5 * reach + 0.5 * t),
        N[0], N[1], N[2], p.width * (0.6 + 0.8 * t), p.gain * u * u, p.seed, p.age, 0.25 + 1.1 * reach);
    }
  }

  end(): void {
    this.batch.end();
  }

  clear(): void {
    this.pool.count = 0;
  }

  dispose(): void {
    this.batch.dispose();
  }
}
