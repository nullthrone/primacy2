import { describe, expect, it } from 'vitest';
import {
  EDGE_RX, EDGE_RY, RADAR_INNER, RADAR_LIFT, RADAR_REACH, RADAR_RIM_STALK, RADAR_RINGS, RADAR_SQUASH,
  arrival, boxesOverlap, closingSpeed, compassDot, declutter, edgeMark, pullClear, radarBlip, radarRadius, radarRim, type Box, type EdgeMark,
} from './orient.ts';

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

describe('the radar', () => {
  it('puts each ring ten times farther out than the one inside it, at even steps', () => {
    const at = RADAR_RINGS.map((d) => radarRadius(d));
    expect(at[0]).toBeCloseTo(RADAR_INNER, 12);
    expect(at[at.length - 1]).toBeCloseTo(1, 12);
    const step = (1 - RADAR_INNER) / (RADAR_RINGS.length - 1);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeCloseTo(step, 12);
    // Between two rings the scale is logarithmic: 3.16 km is halfway from 1 km to 10 km.
    expect(radarRadius(Math.sqrt(1e7))).toBeCloseTo((at[1]! + at[2]!) / 2, 9);
  });

  it('holds what is nearer than the innermost ring on it and what is farther than the rim on the rim', () => {
    expect(radarRadius(3)).toBe(RADAR_INNER);
    expect(radarRadius(0)).toBe(RADAR_INNER);
    expect(radarRadius(Number.NaN)).toBe(RADAR_INNER);
    expect(radarRadius(4e9)).toBe(1);
    expect(radarRadius(Infinity)).toBe(1);
    // Farther is never nearer to the middle.
    let last = 0;
    for (let d = 1; d < 1e7; d *= 1.7) {
      const r = radarRadius(d);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('puts a contact ahead and to the left up and left of the middle, on the plane', () => {
    const b = radarBlip([-600, 0, -800]);
    expect(b.x).toBeLessThan(0);
    expect(b.y).toBeLessThan(0);
    expect(b.y).toBe(b.foot);
    // Its bearing is kept: three to the left for four ahead, the way ahead squashed.
    expect(b.x / (b.foot / RADAR_SQUASH)).toBeCloseTo(600 / 800, 12);
    expect(Math.hypot(b.x, b.foot / RADAR_SQUASH)).toBeCloseTo(radarRadius(1000), 12);
    // Behind and to the right: down and right.
    const aft = radarBlip([300, 0, 900]);
    expect(aft.x).toBeGreaterThan(0);
    expect(aft.y).toBeGreaterThan(0);
  });

  it('raises a contact above the plane on its stalk and hangs one below it', () => {
    const above = radarBlip([0, 400, -400]);
    expect(above.y).toBeLessThan(above.foot);
    const below = radarBlip([0, -400, -400]);
    expect(below.y).toBeGreaterThan(below.foot);
    expect(below.foot).toBeCloseTo(above.foot, 12);
    expect(below.y - below.foot).toBeCloseTo(above.foot - above.y, 12);
    // Straight above: the foot is the middle and the stalk has the full length for that distance.
    const top = radarBlip([0, 1000, 0]);
    expect([top.x, Math.abs(top.foot)]).toEqual([0, 0]);
    expect(top.y).toBeCloseTo(-radarRadius(1000) * RADAR_LIFT, 12);
  });

  it('keeps every contact inside the circle around the disc, at any distance', () => {
    for (const c of [[3, 4, -5], [-3e3, 4e3, 5e3], [1e12, -1e12, 1e11], [0.1, 0, 0.1], [0, -9e9, 0], [7e4, 7e4, 7e4]] as const) {
      const b = radarBlip(c);
      expect(Math.hypot(b.x, b.y)).toBeLessThanOrEqual(1 + 1e-12);
      expect(Math.hypot(b.x, b.foot / RADAR_SQUASH)).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(radarBlip([0, 0, -2e5]).beyond).toBe(true);
    expect(radarBlip([0, 0, -2e4]).beyond).toBe(false);
    expect(radarBlip([0, 0, 0])).toEqual({ x: 0, y: 0, foot: 0, beyond: false });
  });

  it('puts a place on the rim at its bearing, whatever its distance', () => {
    const ahead = radarRim([0, 0, -4e9]);
    expect([ahead.x, ahead.foot, ahead.y]).toEqual([0, -RADAR_SQUASH, -RADAR_SQUASH]);
    const right = radarRim([7, 0, 0]);
    expect(right.x).toBeCloseTo(1, 12);
    expect(right.foot).toBeCloseTo(0, 12);
    const astern = radarRim([0, 0, 5]);
    expect(astern.x).toBeCloseTo(0, 12);
    expect(astern.foot).toBeCloseTo(RADAR_SQUASH, 12);
    // Behind and to the left, 45 degrees: on the ellipse of the rim.
    const m = radarRim([-3, 0, 3]);
    expect(m.bearing).toBeCloseTo(-Math.PI * 0.75, 12);
    expect(Math.hypot(m.x, m.foot / RADAR_SQUASH)).toBeCloseTo(1, 12);
    expect(m.x).toBeLessThan(0);
    expect(m.foot).toBeGreaterThan(0);
  });

  it('tells a place above the plane from one below it by the stalk, and keeps the foot on the rim', () => {
    const up = radarRim([4, 3, 0]);
    expect(up.x).toBeCloseTo(1, 12);
    expect(up.foot - up.y).toBeCloseTo(0.6 * RADAR_RIM_STALK, 12);
    const down = radarRim([4, -3, 0]);
    expect(down.y - down.foot).toBeCloseTo(0.6 * RADAR_RIM_STALK, 12);
    for (const c of [[1, 9, 0], [-1, -9, 0], [0, 5, -1], [0, -5, 1], [3, 3, 3]] as const) {
      const m = radarRim(c);
      expect(Math.hypot(m.x, m.y)).toBeLessThanOrEqual(RADAR_REACH + 1e-12);
    }
  });

  it('keeps its bearing straight above and below the ship, where there is none', () => {
    const held = radarRim([0, 100, 0], 2.2);
    expect(held.bearing).toBe(2.2);
    expect(held.foot - held.y).toBeCloseTo(RADAR_RIM_STALK, 12);
    // Without a history the mark stands ahead; a hair off the axis counts as on it.
    expect(radarRim([0, -100, 0]).bearing).toBe(0);
    expect(radarRim([1e-5, 100, 0], -1).bearing).toBe(-1);
    const zero = radarRim([0, 0, 0]);
    expect(Number.isFinite(zero.x) && Number.isFinite(zero.y)).toBe(true);
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
