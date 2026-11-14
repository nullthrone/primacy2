import { describe, expect, it } from 'vitest';
import { EDGE_RX, EDGE_RY, arrival, boxesOverlap, compassDot, declutter, edgeMark, trackRate, type RangeRate } from './orient.ts';

const W = 1280;
const H = 720;

describe('the arrow for something off screen', () => {
  it('stands on the ellipse on the side the point lies on and points outward', () => {
    const right = edgeMark([10, 0, -1], W, H);
    expect(right.x).toBeCloseTo(W / 2 + W * EDGE_RX, 6);
    expect(right.y).toBeCloseTo(H / 2, 6);
    expect(right.angle).toBeCloseTo(0, 9);
    expect(right.behind).toBe(false);

    // A point above the view: up the screen is negative y.
    const up = edgeMark([0, 10, -1], W, H);
    expect(up.x).toBeCloseTo(W / 2, 6);
    expect(up.y).toBeCloseTo(H / 2 - H * EDGE_RY, 6);
    expect(up.angle).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('points the way to turn for a point behind the viewer, without mirroring', () => {
    // Behind and to the left: turning left brings it into view.
    const m = edgeMark([-3, 0, 5], W, H);
    expect(m.behind).toBe(true);
    expect(m.x).toBeLessThan(W / 2);
    expect(Math.abs(m.angle)).toBeCloseTo(Math.PI, 9);
    // Behind and below.
    const low = edgeMark([0, -2, 9], W, H);
    expect(low.behind).toBe(true);
    expect(low.y).toBeGreaterThan(H / 2);
  });

  it('stays on the ellipse in every direction', () => {
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const m = edgeMark([Math.cos(a) * 7, Math.sin(a) * 7, i % 2 ? 3 : -3], W, H);
      const u = (m.x - W / 2) / (W * EDGE_RX);
      const v = (m.y - H / 2) / (H * EDGE_RY);
      expect(Math.hypot(u, v)).toBeCloseTo(1, 9);
    }
  });

  it('keeps its angle dead astern, where no direction is the way to turn', () => {
    const held = edgeMark([0, 0, 100], W, H, 1.1);
    expect(held.behind).toBe(true);
    expect(held.angle).toBe(1.1);
    expect(Number.isFinite(held.x) && Number.isFinite(held.y)).toBe(true);
    // Without a history it points down; never to the middle of the view.
    const fresh = edgeMark([0, 0, 100], W, H);
    expect(fresh.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(fresh.y).toBeCloseTo(H / 2 + H * EDGE_RY, 6);
    // A direction a hair off the axis counts as on it.
    expect(edgeMark([1e-5, 0, 100], W, H, 2).angle).toBe(2);
    // A point at the camera itself does not produce NaN.
    const zero = edgeMark([0, 0, 0], W, H);
    expect(Number.isFinite(zero.x) && Number.isFinite(zero.y)).toBe(true);
  });
});

describe('the compass', () => {
  it('puts dead ahead in the middle, filled, and dead astern in the middle, hollow', () => {
    expect(compassDot([0, 0, -8])).toEqual({ x: 0, y: -0, front: true });
    const astern = compassDot([0, 0, 8]);
    expect([astern.x, Math.abs(astern.y), astern.front]).toEqual([0, 0, false]);
  });

  it('puts a quarter turn on the rim, on the side to turn to', () => {
    const right = compassDot([5, 0, 0]);
    expect(right.x).toBeCloseTo(1, 12);
    expect(right.y).toBeCloseTo(0, 12);
    const above = compassDot([0, 5, 0]);
    expect(above.y).toBeCloseTo(-1, 12);
  });

  it('never leaves the disc', () => {
    for (const c of [[3, 4, -5], [-3, 4, 5], [1e12, -1e12, 1e11], [0.1, 0, 0.1]] as const) {
      const d = compassDot(c);
      expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(compassDot([0, 0, 0])).toEqual({ x: 0, y: 0, front: true });
  });

  it('tells ahead from behind by the forward half', () => {
    expect(compassDot([4, 0, -1]).front).toBe(true);
    expect(compassDot([4, 0, 1]).front).toBe(false);
  });
});

describe('the closing speed', () => {
  const run = (dist: (t: number) => number, seconds: number, key = 'a'): RangeRate => {
    let r: RangeRate | null = null;
    for (let i = 0; i <= seconds * 60; i++) r = trackRate(r, key, i / 60, dist(i / 60));
    return r!;
  };

  it('needs two samples before it says anything', () => {
    const first = trackRate(null, 'a', 0, 1000);
    expect(first.ready).toBe(false);
    expect(arrival(1000, first)).toBeNull();
    expect(trackRate(first, 'a', 1 / 60, 999).ready).toBe(true);
  });

  it('is positive while the distance shrinks and settles at the true rate', () => {
    expect(run((t) => 5000 - 120 * t, 3).closing).toBeCloseTo(120, 6);
    expect(run((t) => 5000 + 40 * t, 3).closing).toBeCloseTo(-40, 6);
  });

  it('smooths a single jump instead of following it', () => {
    let r = run((t) => 5000 - 100 * t, 2);
    // One frame in which the position was corrected by 30 m.
    r = trackRate(r, 'a', r.at + 1 / 60, r.dist - 100 / 60 - 30);
    expect(r.closing).toBeGreaterThan(100);
    expect(r.closing).toBeLessThan(200);
  });

  it('starts over for another target, after a gap and when time runs backward', () => {
    const r = run((t) => 5000 - 100 * t, 1);
    expect(trackRate(r, 'b', r.at + 1 / 60, 70).ready).toBe(false);
    expect(trackRate(r, 'a', r.at + 5, 70).ready).toBe(false);
    expect(trackRate(r, 'a', r.at - 1, 70).ready).toBe(false);
    // A frame at the same time changes nothing.
    expect(trackRate(r, 'a', r.at, 1)).toBe(r);
  });

  it('gives a time of arrival only for a real approach', () => {
    const closing = (v: number): RangeRate => ({ key: 'a', at: 0, dist: 0, closing: v, ready: true });
    expect(arrival(6000, closing(100))).toBeCloseTo(60, 9);
    expect(arrival(6000, closing(0.1))).toBeNull();
    expect(arrival(6000, closing(-100))).toBeNull();
    expect(arrival(1e12, closing(1))).toBeNull();
    expect(arrival(6000, null)).toBeNull();
  });
});

describe('labels giving way', () => {
  it('keeps the first of two that overlap and all that are apart', () => {
    const a = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const b = { x0: 90, y0: 10, x1: 190, y1: 30 };
    const c = { x0: 300, y0: 0, x1: 400, y1: 20 };
    expect(boxesOverlap(a, b)).toBe(true);
    expect(boxesOverlap(a, c)).toBe(false);
    expect(declutter([a, b, c])).toEqual([true, false, true]);
    expect(declutter([b, a, c])).toEqual([true, false, true]);
  });

  it('does not let a dropped label block a later one', () => {
    const a = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const b = { x0: 90, y0: 0, x1: 190, y1: 20 };
    const c = { x0: 180, y0: 0, x1: 280, y1: 20 };
    expect(declutter([a, b, c])).toEqual([true, false, true]);
  });

  it('treats boxes that only touch as apart', () => {
    expect(boxesOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(false);
  });
});
