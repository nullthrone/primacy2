/**
 * Deterministic pseudo-random numbers. Everything procedural in PRIMACY2 derives from an `Rng`
 * so that every server and client generates identical content from the same seed.
 */

/** 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix two 32-bit integers into one (murmur-style finaliser). */
export function hashCombine(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export type Seed = number | string;

const toSeed = (s: Seed): number => (typeof s === 'number' ? s >>> 0 : hashString(s));

/** sfc32 generator: small, fast, good statistical quality, fully deterministic across engines. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: Seed) {
    const s = toSeed(seed);
    this.a = s;
    this.b = hashCombine(s, 0x1234567);
    this.c = hashCombine(s, 0x89abcdef);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** Uniform integer in [0, 2^32). */
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.float() * items.length)]!;
  }

  /** Pick an index with probability proportional to its weight. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.float() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Standard normal via Box-Muller. */
  gaussian(mean = 0, sd = 1): number {
    const u = 1 - this.float();
    const v = this.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-uniform float in [lo, hi). */
  logRange(lo: number, hi: number): number {
    return Math.exp(this.range(Math.log(lo), Math.log(hi)));
  }

  /** Uniformly distributed unit vector. */
  unitVector(): [number, number, number] {
    const z = this.range(-1, 1);
    const a = this.range(0, 2 * Math.PI);
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
  }

  /** Independent child generator; the same label always yields the same stream. */
  fork(label: Seed): Rng {
    return new Rng(hashCombine(this.a ^ this.c, toSeed(label)));
  }
}

/** Stateless helper: a child generator of `seed` identified by `label`, without consuming `seed`. */
export function rngFor(seed: Seed, ...labels: Seed[]): Rng {
  let h = toSeed(seed);
  for (const l of labels) h = hashCombine(h, toSeed(l));
  return new Rng(h);
}
