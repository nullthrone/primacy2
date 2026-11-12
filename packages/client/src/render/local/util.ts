/**
 * Small numeric helpers shared by the local layer. Nothing here allocates per call.
 */

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
