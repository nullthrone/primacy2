import { describe, expect, it } from 'vitest';
import { Rng } from '../prng.ts';
import {
  isLandable, terrainHeight, terrainMax, terrainMin, terrainNormal, terrainParams, terrainRelief, terrainSample, terrainSkipped,
  type TerrainParams,
} from './terrain.ts';
import source from './terrain.ts?raw';
import type { BodyDef } from './types.ts';

const DEG = Math.PI / 180;

/** A rocky moon the size of ours, a small ice moon, a desert planet and a small rocky moon. */
const BODIES: Pick<BodyDef, 'seed' | 'cls' | 'radius'>[] = [
  { seed: 12345, cls: 'rocky', radius: 1.7374e6 },
  { seed: 777, cls: 'ice', radius: 8e5 },
  { seed: 4242, cls: 'desert', radius: 3.4e6 },
  { seed: 0xdeadbeef, cls: 'rocky', radius: 2.5e5 },
];
const PAD_DIR: [number, number, number] = [0, 0.6, -0.8];
const PAD = { dir: PAD_DIR, radius: 400, blend: 400 };
const NATURAL: TerrainParams[] = BODIES.map((b) => terrainParams(b));
const PADDED: TerrainParams[] = BODIES.map((b) => terrainParams(b, [PAD]));

/** A random unit direction built with a square root only, as the terrain expects its input. */
function direction(rng: Rng): [number, number, number] {
  for (;;) {
    const x = rng.range(-1, 1);
    const y = rng.range(-1, 1);
    const z = rng.range(-1, 1);
    const l2 = x * x + y * y + z * z;
    if (l2 < 0.01 || l2 > 1) continue;
    const l = Math.sqrt(l2);
    return [x / l, y / l, z / l];
  }
}

/** A unit vector at right angles to `d`. */
function tangent(d: readonly number[], rng: Rng): [number, number, number] {
  const r = direction(rng);
  const dot = r[0] * d[0]! + r[1] * d[1]! + r[2] * d[2]!;
  const t = [r[0] - dot * d[0]!, r[1] - dot * d[1]!, r[2] - dot * d[2]!];
  const l = Math.sqrt(t[0]! * t[0]! + t[1]! * t[1]! + t[2]! * t[2]!);
  return [t[0]! / l, t[1]! / l, t[2]! / l];
}

/** The unit direction `metres` along the ground from `d` toward `t`. */
function along(d: readonly number[], t: readonly number[], metres: number, radius: number): [number, number, number] {
  const a = metres / radius;
  const k = 1 / Math.sqrt(1 + a * a);
  return [(d[0]! + t[0]! * a) * k, (d[1]! + t[1]! * a) * k, (d[2]! + t[2]! * a) * k];
}

describe('isLandable', () => {
  it('is true for solid bodies without atmosphere of class rocky, ice or desert', () => {
    const body = (kind: BodyDef['kind'], cls: BodyDef['cls'], atmo = false): Pick<BodyDef, 'kind' | 'cls' | 'atmo'> =>
      (atmo ? { kind, cls, atmo: { height: 1e5, color: 0, density: 1 } } : { kind, cls });
    expect(isLandable(body('moon', 'rocky'))).toBe(true);
    expect(isLandable(body('planet', 'rocky'))).toBe(true);
    expect(isLandable(body('moon', 'ice'))).toBe(true);
    expect(isLandable(body('planet', 'desert'))).toBe(true);
    expect(isLandable(body('planet', 'desert', true))).toBe(false);
    expect(isLandable(body('moon', 'rocky', true))).toBe(false);
    for (const cls of ['lava', 'ocean', 'terran', 'gas', 'icegiant'] as const) expect(isLandable(body('planet', cls))).toBe(false);
    for (const cls of ['G', 'M', 'WD', 'NS', 'BH'] as const) expect(isLandable(body('star', cls))).toBe(false);
  });
});

describe('determinism', () => {
  it('uses nothing but exactly specified arithmetic', () => {
    // Comments name the functions that are not allowed, so they are taken out first.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.length).toBeGreaterThan(5000);
    const maths = [...code.matchAll(/Math\.(\w+)/g)].map((m) => m[1]!);
    expect(maths.length).toBeGreaterThan(20);
    for (const fn of maths) expect(['sqrt', 'floor', 'abs', 'min', 'max', 'imul']).toContain(fn);
    expect(code).not.toMatch(/\*\*/);
    expect(code).not.toMatch(/\bDate\b|\bperformance\b|random/);
    // The vector helpers of math.ts use Math.hypot; only types may come from other modules.
    for (const line of code.split('\n')) if (/^\s*import\b/.test(line)) expect(line).toMatch(/^\s*import type\b/);
  });

  // Captured from this implementation. A change here means every server and client must change together.
  const GOLDEN: [number, [number, number, number], number, number, number][] = [
    [0, [1, 0, 0], 0, 3791.7774472098913, 0.6682045699480471],
    [0, [1, 0, 0], 500, 3793.2668641161654, 0.6682045699480471],
    [0, [0, -1, 0], 0, 1838.182295258647, 0.6944646613689528],
    [0, [0.6, 0.48, 0.64], 0, 1087.8431319777862, 0.5105910080294612],
    [0, [0.6, 0.48, 0.64], 500, 1087.6345145182636, 0.5103558885893936],
    [0, [-0.28, 0.96, 0], 0, -769.9411662546246, 0.20152920584994025],
    [0, [0.36, -0.48, -0.8], 0, 1416.7997459291944, 0.5999315521593089],
    [0, [0, 0.6, -0.8], 0, 923.2448564195555, 0.5],
    [1, [1, 0, 0], 0, 20.117459649624458, 0.7342542538922473],
    [1, [0, -1, 0], 0, 77.17370617917527, 0.48706416212885023],
    [1, [0.6, 0.48, 0.64], 500, 5.602081787698819, 0.7479985254520835],
    [1, [-0.28, 0.96, 0], 0, -55.250114322661005, 0.5754064807814471],
    [1, [0.36, -0.48, -0.8], 0, 43.23202767606759, 0.6913518714965674],
    [1, [0, 0.6, -0.8], 500, 59.63961311489692, 0.5],
    [2, [1, 0, 0], 0, -207.98268601031714, 0.40415472836439936],
    [2, [0, -1, 0], 0, -94.21221279534211, 0.5643045704792301],
    [2, [0, -1, 0], 500, -109.33520246173941, 0.517097225223023],
    [2, [0.6, 0.48, 0.64], 0, -73.96764360524813, 0.4343479290977661],
    [2, [-0.28, 0.96, 0], 0, 263.8439719950764, 0.6286348690683878],
    [2, [0.36, -0.48, -0.8], 500, -332.68665741212476, 0.5131131460498439],
    [2, [0, 0.6, -0.8], 0, 1287.1549726594837, 0.5],
    [3, [1, 0, 0], 0, -184.22030005219497, 0.1694222515697116],
    [3, [0, -1, 0], 500, -42.617743190497904, 0.23342506899426962],
    [3, [0.6, 0.48, 0.64], 0, -296.4744879327918, 0.15939075620304893],
    [3, [-0.28, 0.96, 0], 0, 656.3536873496886, 0.9683579410810568],
    [3, [-0.28, 0.96, 0], 500, 657.0678298412938, 0.6015072968494138],
    [3, [0.36, -0.48, -0.8], 0, 383.6002439004927, 0.6530684643462557],
    [3, [0, 0.6, -0.8], 0, 799.2362302044703, 0.5],
  ];

  it('gives these exact heights and tones for fixed bodies and directions', () => {
    const out = [0, 0];
    for (const [b, d, detail, height, tone] of GOLDEN) {
      terrainSample(PADDED[b]!, d[0], d[1], d[2], detail, out);
      expect(out[0], `body ${b} at ${d} detail ${detail}`).toBe(height);
      expect(out[1], `tone of body ${b} at ${d} detail ${detail}`).toBe(tone);
      expect(terrainHeight(PADDED[b]!, d[0], d[1], d[2], detail)).toBe(height);
    }
    expect(terrainMin(PADDED[0]!)).toBe(-6392.464666789246);
    expect(terrainMax(PADDED[0]!)).toBe(7878.386230468752);
  });

  it('gives the same result whatever was sampled before, and from parameters built twice', () => {
    const rng = new Rng(5);
    const dirs = Array.from({ length: 200 }, () => direction(rng));
    for (let b = 0; b < BODIES.length; b++) {
      const first = dirs.map((d) => terrainHeight(PADDED[b]!, d[0], d[1], d[2]));
      const again = terrainParams(BODIES[b]!, [PAD]);
      // Backwards, with samples of another body in between.
      for (let i = dirs.length - 1; i >= 0; i--) {
        const d = dirs[i]!;
        terrainHeight(NATURAL[(b + 1) % BODIES.length]!, d[2], d[0], d[1], 100);
        expect(terrainHeight(again, d[0], d[1], d[2])).toBe(first[i]);
      }
    }
  });
});

describe('bounds and tone', () => {
  it('keeps every height inside terrainMin .. terrainMax and every tone inside 0 .. 1', () => {
    const out = [0, 0];
    for (let b = 0; b < BODIES.length; b++) {
      const p = PADDED[b]!;
      const lo = terrainMin(p);
      const hi = terrainMax(p);
      expect(lo).toBeLessThan(0);
      expect(hi).toBeGreaterThan(0);
      const rng = new Rng(100 + b);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 30_000; i++) {
        const d = direction(rng);
        terrainSample(p, d[0], d[1], d[2], i % 3 === 0 ? 2000 : 0, out);
        if (out[0]! < min) min = out[0]!;
        if (out[0]! > max) max = out[0]!;
        if (!(out[0]! >= lo && out[0]! <= hi)) throw new Error(`height ${out[0]} outside ${lo} .. ${hi}`);
        if (!(out[1]! >= 0 && out[1]! <= 1)) throw new Error(`tone ${out[1]} outside 0 .. 1`);
      }
      // The bounds are not wildly loose either: the relief uses a good part of them.
      expect(max - min).toBeGreaterThan(0.25 * (hi - lo));
    }
  });

  it('holds the bounds whatever the parts add up to', () => {
    // The same bodies with continents and mountains twenty times as high: the sum of the parts is far
    // outside the bounds, and the height still is not.
    for (let b = 0; b < 3; b++) {
      const p = NATURAL[b]!;
      const inflated: TerrainParams = { ...p, contAmp: p.contAmp * 20, mtnAmp: p.mtnAmp * 20 };
      const rng = new Rng(150 + b);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 10_000; i++) {
        const d = direction(rng);
        const h = terrainHeight(inflated, d[0], d[1], d[2]);
        if (h < min) min = h;
        if (h > max) max = h;
      }
      expect(min).toBeGreaterThanOrEqual(terrainMin(p));
      expect(max).toBeLessThanOrEqual(terrainMax(p));
      // It did press against them: well beyond the knee at three quarters of each bound.
      expect(max).toBeGreaterThan(0.95 * terrainMax(p));
      expect(min).toBeLessThan(0.9 * terrainMin(p));
    }
  });

  it('is true to scale: a few kilometres of relief on a body a thousand kilometres across', () => {
    expect(terrainMax(NATURAL[0]!) - terrainMin(NATURAL[0]!)).toBeGreaterThan(5_000);
    expect(terrainMax(NATURAL[0]!) - terrainMin(NATURAL[0]!)).toBeLessThan(20_000);
    // Ice is the smoothest of the three kinds.
    expect(terrainMax(NATURAL[1]!)).toBeLessThan(0.5 * terrainMax(NATURAL[0]!));
  });

  it('shades the plains of a rocky body darker than its highlands', () => {
    const out = [0, 0];
    const rng = new Rng(9);
    const samples: [number, number][] = [];
    for (let i = 0; i < 6000; i++) {
      const d = direction(rng);
      // At a coarse detail the tone is that of the broad terrain, without single craters.
      terrainSample(NATURAL[0]!, d[0], d[1], d[2], 50_000, out);
      samples.push([out[0]!, out[1]!]);
    }
    samples.sort((a, b) => a[0] - b[0]);
    const mean = (list: [number, number][]): number => list.reduce((s, x) => s + x[1], 0) / list.length;
    const low = mean(samples.slice(0, 1500));
    const high = mean(samples.slice(-1500));
    expect(high - low).toBeGreaterThan(0.2);
  });
});

describe('continuity', () => {
  it('has no jumps at any scale, least of all where a crater enters or leaves its lattice cells', () => {
    for (let b = 0; b < 3; b++) {
      const p = NATURAL[b]!;
      const rng = new Rng(300 + b);
      let steepest = 0;
      // One walk per crater size class, 2.5 lattice cells long in steps of 1/4000 of a cell, and
      // two at the scale of a ship.
      const scales = [...p.craterCell, 8, 2];
      for (const cell of scales) {
        const start = direction(rng);
        const t = tangent(start, rng);
        const step = cell / 4000;
        let prev = terrainHeight(p, start[0], start[1], start[2]);
        let prevDir = start;
        for (let k = 1; k <= 10_000; k++) {
          const d = along(start, t, k * step, p.radius);
          const h = terrainHeight(p, d[0], d[1], d[2]);
          const run = p.radius * Math.sqrt((d[0] - prevDir[0]) ** 2 + (d[1] - prevDir[1]) ** 2 + (d[2] - prevDir[2]) ** 2);
          const grade = Math.abs(h - prev) / run;
          if (grade > steepest) steepest = grade;
          // Nothing on these bodies is steeper than 80 degrees; a jump would be far beyond that.
          if (grade > 6) throw new Error(`body ${b}, cell ${cell} m: ${Math.abs(h - prev)} m over ${run} m`);
          prev = h;
          prevDir = d;
        }
      }
      // The walks did cross real slopes, so the limit above was a test and not a formality.
      expect(steepest).toBeGreaterThan(0.2);
    }
  });

  it('has no step where a crater enters or leaves the lattice cells around a point', () => {
    // A crater is looked for in the 2 x 2 x 2 lattice cells nearest to a point. Which cells those
    // are changes where a coordinate of the point passes the middle of a cell. A crater that still
    // reached that far would vanish there, so the height is compared a hair on either side.
    for (let b = 0; b < 3; b++) {
      const p = NATURAL[b]!;
      const rng = new Rng(350 + b);
      let crossings = 0;
      for (const cell of p.craterCell) {
        for (let i = 0; i < 400; i++) {
          const d = direction(rng);
          const axis = i % 3;
          const u = (axis + 1) % 3;
          const w = (axis + 2) % 3;
          if (Math.abs(d[axis]!) > 0.8) continue;
          // The nearest middle of a cell along this axis, and the two points a hair either side of it.
          const middle = (Math.floor((d[axis]! * p.radius) / cell) + 0.5) * cell;
          const hair = 1e-6 * cell;
          const side = (coordinate: number): [number, number, number] => {
            const c = coordinate / p.radius;
            const k = Math.sqrt((1 - c * c) / (d[u]! * d[u]! + d[w]! * d[w]!));
            const out: [number, number, number] = [0, 0, 0];
            out[axis] = c;
            out[u] = d[u]! * k;
            out[w] = d[w]! * k;
            return out;
          };
          const lo = side(middle - hair);
          const hi = side(middle + hair);
          if (!(lo[axis]! * p.radius < middle && hi[axis]! * p.radius > middle)) continue;
          const run = p.radius * Math.sqrt((hi[0] - lo[0]) ** 2 + (hi[1] - lo[1]) ** 2 + (hi[2] - lo[2]) ** 2);
          const dh = Math.abs(terrainHeight(p, hi[0], hi[1], hi[2]) - terrainHeight(p, lo[0], lo[1], lo[2]));
          if (dh > 6 * run + 1e-9) throw new Error(`body ${b}, cell ${cell} m: step of ${dh} m over ${run} m`);
          crossings++;
        }
      }
      expect(crossings).toBeGreaterThan(200 * p.craterCell.length);
    }
  });

  it('gives neighbouring samples heights that differ by no more than the slope between them', () => {
    for (let b = 0; b < BODIES.length; b++) {
      const p = NATURAL[b]!;
      const rng = new Rng(400 + b);
      for (let i = 0; i < 4000; i++) {
        const d = direction(rng);
        const t = tangent(d, rng);
        const run = rng.logRange(0.05, 50);
        const e = along(d, t, run, p.radius);
        const dh = Math.abs(terrainHeight(p, e[0], e[1], e[2]) - terrainHeight(p, d[0], d[1], d[2]));
        if (dh > 6 * run + 1e-6) throw new Error(`body ${b}: ${dh} m over ${run} m`);
      }
    }
  });
});

describe('pads', () => {
  it('is flat inside the pad, at the height the untouched ground has at its centre', () => {
    for (let b = 0; b < BODIES.length; b++) {
      const p = PADDED[b]!;
      const centre = terrainHeight(NATURAL[b]!, PAD_DIR[0], PAD_DIR[1], PAD_DIR[2]);
      const rng = new Rng(500 + b);
      for (let i = 0; i < 300; i++) {
        const d = along(PAD_DIR, tangent(PAD_DIR, rng), rng.range(0, 0.999 * PAD.radius), p.radius);
        expect(terrainHeight(p, d[0], d[1], d[2])).toBe(centre);
        expect(terrainHeight(p, d[0], d[1], d[2], 300)).toBe(centre);
      }
      const n: [number, number, number] = [0, 0, 0];
      expect(terrainNormal(p, PAD_DIR[0], PAD_DIR[1], PAD_DIR[2], 40, n)).toBe(0);
      expect(Math.hypot(n[0] - PAD_DIR[0], n[1] - PAD_DIR[1], n[2] - PAD_DIR[2])).toBeLessThan(1e-12);
      expect(terrainRelief(p, PAD_DIR[0], PAD_DIR[1], PAD_DIR[2], 0.9 * PAD.radius)).toBe(0);
    }
  });

  it('meets the natural terrain smoothly: no step at either edge of the blend ring', () => {
    for (let b = 0; b < BODIES.length; b++) {
      const p = PADDED[b]!;
      const rng = new Rng(600 + b);
      for (let walk = 0; walk < 12; walk++) {
        const t = tangent(PAD_DIR, rng);
        let prev = terrainHeight(p, PAD_DIR[0], PAD_DIR[1], PAD_DIR[2]);
        // From the centre out across both edges, in steps of 5 cm around them.
        for (const [from, to] of [[PAD.radius - 3, PAD.radius + 3], [PAD.radius + PAD.blend - 3, PAD.radius + PAD.blend + 3]] as const) {
          let d = along(PAD_DIR, t, from, p.radius);
          prev = terrainHeight(p, d[0], d[1], d[2]);
          for (let m = from + 0.05; m <= to; m += 0.05) {
            d = along(PAD_DIR, t, m, p.radius);
            const h = terrainHeight(p, d[0], d[1], d[2]);
            if (Math.abs(h - prev) > 6 * 0.05 + 1e-6) throw new Error(`body ${b}: step of ${Math.abs(h - prev)} m at ${m} m from the pad centre`);
            prev = h;
          }
        }
      }
    }
  });

  it('leaves the terrain beyond the blend ring exactly as it was', () => {
    for (let b = 0; b < BODIES.length; b++) {
      const rng = new Rng(700 + b);
      for (let i = 0; i < 300; i++) {
        const far = i < 150 ? rng.range(1.001, 3) * (PAD.radius + PAD.blend) : rng.range(1e4, 1e5);
        const d = along(PAD_DIR, tangent(PAD_DIR, rng), far, BODIES[b]!.radius);
        expect(terrainHeight(PADDED[b]!, d[0], d[1], d[2])).toBe(terrainHeight(NATURAL[b]!, d[0], d[1], d[2]));
      }
      // Inside the ring the height lies between the pad and the natural ground.
      const pad = terrainHeight(PADDED[b]!, PAD_DIR[0], PAD_DIR[1], PAD_DIR[2]);
      for (let i = 0; i < 300; i++) {
        const d = along(PAD_DIR, tangent(PAD_DIR, rng), PAD.radius + rng.range(0.01, 0.99) * PAD.blend, BODIES[b]!.radius);
        const h = terrainHeight(PADDED[b]!, d[0], d[1], d[2]);
        const natural = terrainHeight(NATURAL[b]!, d[0], d[1], d[2]);
        expect(h).toBeGreaterThanOrEqual(Math.min(pad, natural) - 1e-9);
        expect(h).toBeLessThanOrEqual(Math.max(pad, natural) + 1e-9);
      }
    }
  });
});

describe('detail levels', () => {
  it('agree with the full function to within the amplitude they skip', () => {
    for (let b = 0; b < BODIES.length; b++) {
      const p = PADDED[b]!;
      expect(terrainSkipped(p, 0)).toBe(0);
      let last = 0;
      for (const detail of [5, 12, 40, 150, 600, 2500, 10_000, 40_000, 200_000]) {
        const skipped = terrainSkipped(p, detail);
        expect(skipped).toBeGreaterThanOrEqual(last);
        expect(skipped).toBeLessThanOrEqual(terrainMax(p) - terrainMin(p));
        last = skipped;
        const rng = new Rng(800 + b);
        let worst = 0;
        for (let i = 0; i < 3000; i++) {
          const d = direction(rng);
          const diff = Math.abs(terrainHeight(p, d[0], d[1], d[2], detail) - terrainHeight(p, d[0], d[1], d[2]));
          if (diff > worst) worst = diff;
        }
        expect(worst, `body ${b}, detail ${detail} m`).toBeLessThanOrEqual(skipped);
      }
      // What a ship-sized detail leaves out is small: a mesh at 5 m is the collision surface to within centimetres to metres.
      expect(terrainSkipped(p, 5)).toBeLessThan(2);
      expect(terrainSkipped(p, 150)).toBeLessThan(120);
    }
  });

  it('skips nothing at a detail finer than the smallest feature', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 500; i++) {
      const d = direction(rng);
      expect(terrainHeight(NATURAL[0]!, d[0], d[1], d[2], 1)).toBe(terrainHeight(NATURAL[0]!, d[0], d[1], d[2]));
    }
  });
});

describe('ground a ship can stand on', () => {
  it('has a slope under 15 degrees at the scale of a ship for well over half of each kind of body', () => {
    const n: [number, number, number] = [0, 0, 0];
    for (let b = 0; b < 3; b++) {
      const p = NATURAL[b]!;
      for (const baseline of [20, 50]) {
        const rng = new Rng(900 + b);
        let level = 0;
        const total = 4000;
        for (let i = 0; i < total; i++) {
          const d = direction(rng);
          const slope = terrainNormal(p, d[0], d[1], d[2], baseline, n);
          if (slope < Math.tan(15 * DEG)) level++;
          // The normal is a unit vector leaning away from the vertical by the slope angle.
          const cos = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
          if (Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-12 || Math.abs(cos - 1 / Math.sqrt(1 + slope * slope)) > 1e-9) {
            throw new Error(`normal ${n} does not fit slope ${slope}`);
          }
        }
        expect(level / total, `body ${b} over ${baseline} m`).toBeGreaterThan(0.8);
      }
    }
  });

  it('has craters: closed hollows, many on a rocky body, few on ice, none without the crater lattice', () => {
    /** Points (of 8000) that lie at least 15 m below all eight points of a 300 m circle around them. */
    const hollows = (p: TerrainParams): number => {
      const rng = new Rng(13);
      const ring: [number, number, number][] = [];
      let count = 0;
      for (let i = 0; i < 8000; i++) {
        const d = direction(rng);
        const t1 = tangent(d, rng);
        const t2: [number, number, number] = [d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]];
        const centre = terrainHeight(p, d[0], d[1], d[2]);
        ring.length = 0;
        for (const [a, b] of [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]] as const) {
          ring.push(along(d, [t1[0] * a + t2[0] * b, t1[1] * a + t2[1] * b, t1[2] * a + t2[2] * b], 300, p.radius));
        }
        if (ring.every((r) => terrainHeight(p, r[0], r[1], r[2]) >= centre + 15)) count++;
      }
      return count;
    };
    const rocky = hollows(NATURAL[0]!);
    const ice = hollows(NATURAL[1]!);
    // The same rocky body with no crater in any lattice cell: noise alone makes no such hollows.
    const bare = hollows({ ...NATURAL[0]!, craterDensity: 0 });
    expect(rocky).toBeGreaterThan(20);
    expect(bare).toBeLessThan(3);
    expect(ice).toBeLessThan(0.3 * rocky);
    // A slope measured straight across such a hollow misses it; the relief around the point does not.
    const rng = new Rng(13);
    let deepest = 0;
    for (let i = 0; i < 3000; i++) {
      const d = direction(rng);
      deepest = Math.max(deepest, terrainRelief(NATURAL[0]!, d[0], d[1], d[2], 300));
    }
    expect(deepest).toBeGreaterThan(60);
  });
});
