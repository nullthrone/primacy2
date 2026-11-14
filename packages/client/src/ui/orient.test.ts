import { describe, expect, it } from 'vitest';
import { EDGE_RX, EDGE_RY, arrival, boxesOverlap, closingSpeed, compassDot, declutter, edgeMark, pullClear, type Box, type EdgeMark } from './orient.ts';

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
  it('is the part of the ship velocity that points at the target', () => {
    expect(closingSpeed([0, 0, -5000], [0, 0, -120])).toBeCloseTo(120, 12);
    expect(closingSpeed([0, 0, -5000], [0, 0, 120])).toBeCloseTo(-120, 12);
    // Flying past at a right angle closes nothing.
    expect(closingSpeed([0, 0, -5000], [300, 0, 0])).toBeCloseTo(0, 12);
    // At 60 degrees off the nose half of the speed counts.
    expect(closingSpeed([Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3)], [0, 0, -200])).toBeCloseTo(100, 9);
  });

  it('counts the other ship moving as well', () => {
    // Both fly the same way at the same speed: the distance stays.
    expect(closingSpeed([0, 0, -800], [0, 0, -150], [0, 0, -150])).toBeCloseTo(0, 12);
    // It comes toward a ship that lies still.
    expect(closingSpeed([0, 0, -800], [0, 0, 0], [0, 0, 90])).toBeCloseTo(90, 12);
    // A chase: 200 after 150.
    expect(closingSpeed([0, 0, -800], [0, 0, -200], [0, 0, -150])).toBeCloseTo(50, 12);
  });

  it('does not depend on how far the target is, and is zero at no distance', () => {
    expect(closingSpeed([0, 0, -1], [0, 0, -40])).toBeCloseTo(closingSpeed([0, 0, -1e12], [0, 0, -40]), 9);
    expect(closingSpeed([0, 0, 0], [0, 0, -40])).toBe(0);
  });

  it('gives a time of arrival only for a real approach', () => {
    expect(arrival(6000, 100)).toBeCloseTo(60, 9);
    expect(arrival(6000, 0.1)).toBeNull();
    expect(arrival(6000, -100)).toBeNull();
    expect(arrival(6000, Number.NaN)).toBeNull();
    // More than a hundred hours away is no time worth showing.
    expect(arrival(1e12, 1)).toBeNull();
    // Cruise toward a place an astronomical unit off, at a tenth of light speed.
    expect(arrival(1.5e11, 3e7)).toBeCloseTo(5000, 6);
  });
});

describe('arrows keeping clear of the HUD', () => {
  const around = (m: EdgeMark): Box => ({ x0: m.x - 60, y0: m.y - 15, x1: m.x + 15, y1: m.y + 15 });
  // A panel in the top right corner, like the target panels.
  const panel: Box = { x0: 1060, y0: 20, x1: 1260, y1: 290 };

  it('leaves an arrow alone that touches nothing', () => {
    const m = edgeMark([10, 0, -1], W, H);
    expect(pullClear(m, W, H, around, [panel])).toBe(m);
    expect(pullClear(m, W, H, around, [])).toBe(m);
  });

  it('moves an arrow inward along its own direction until it is clear, and keeps its angle', () => {
    // Up and to the right, where the ellipse runs under the panel.
    const m = edgeMark([10, 2.2, -1], W, H);
    expect(boxesOverlap(around(m), panel)).toBe(true);
    const c = pullClear(m, W, H, around, [panel]);
    expect(boxesOverlap(around(c), panel)).toBe(false);
    expect(c.angle).toBe(m.angle);
    expect(c.behind).toBe(m.behind);
    // Still on the same ray from the middle of the view, nearer to it.
    const ratio = (c.x - W / 2) / (m.x - W / 2);
    expect(ratio).toBeGreaterThan(0.33);
    expect(ratio).toBeLessThan(1);
    expect((c.y - H / 2) / (m.y - H / 2)).toBeCloseTo(ratio, 9);
  });

  it('does not go on to the middle when nothing helps', () => {
    const everywhere: Box = { x0: 0, y0: 0, x1: W, y1: H };
    const m = edgeMark([10, 0, -1], W, H);
    const c = pullClear(m, W, H, around, [everywhere]);
    expect((c.x - W / 2) / (m.x - W / 2)).toBeGreaterThan(0.33);
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
