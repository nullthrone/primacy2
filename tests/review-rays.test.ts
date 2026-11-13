/**
 * Review of the landing core, server part: where a shot meets the terrain. The ray is compared with
 * a march along it in steps of one metre.
 */
import { describe, expect, it } from 'vitest';
import { bodySurface, generateSector, groundAltitude, isLandable, v3, type Vec3 } from '@primacy2/shared';
import { groundRay } from '../packages/server/src/ground.ts';

const sys = generateSector({ serverId: 'aaaaaaaaaaaaaaaa', seed: 'primacy', center: [10, -2, 33], radius: 18, count: 24 })[0]!;
const body = sys.bodies.find((b) => isLandable(b) && b.cls === 'rocky')!;
const surface = bodySurface(sys, body.id)!;

/** First metre along the ray at which it is under the ground, or -1. */
function dense(o: Vec3, d: Vec3, max: number): number {
  const p: Vec3 = [0, 0, 0];
  for (let t = 0; t <= max; t += 1) {
    p[0] = o[0] + d[0] * t;
    p[1] = o[1] + d[1] * t;
    p[2] = o[2] + d[2] * t;
    if (groundAltitude(surface, p) <= 0) return t;
  }
  return -1;
}

/** Rays 3 km long along the ground, from `h` metres over it, pitched between 2 degrees down and 2 up. */
function rays(h: number, count: number): { o: Vec3; d: Vec3 }[] {
  const out: { o: Vec3; d: Vec3 }[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * 0.913;
    const b = i * 1.7;
    const up = v3.normalize([Math.cos(b) * Math.cos(a) + 0.3, Math.sin(a), Math.cos(b) * Math.sin(a) - 0.2]);
    const pos = v3.scale(up, body.radius + 4000 + (i % 60) * 7000);
    const o = v3.scale(up, v3.len(pos) - groundAltitude(surface, pos) + h);
    const east = v3.normalize(v3.cross(up, [0, 0, 1]));
    const pitch = (((i % 9) - 4) * 0.5 * Math.PI) / 180;
    out.push({ o, d: v3.normalize(v3.add(v3.scale(east, Math.cos(pitch)), v3.scale(up, Math.sin(pitch)))) });
  }
  return out;
}

describe('shots against the terrain', () => {
  it('a shot along the ground from low over it is stopped by the ground it flies into, not given up as a miss', () => {
    // The ray used to be walked in steps of half its height over the ground, at most 48 of them:
    // a shot that skims the ground at a shallow angle takes a great many such steps (each halves the
    // height only a little), ran out of them and was counted as a miss, so most shots fired low and
    // along the ground passed through hills.
    let hits = 0;
    let missed = 0;
    let late = 0;
    for (const h of [8, 15, 40]) {
      for (const { o, d } of rays(h, 150)) {
        const ref = dense(o, d, 3000);
        if (ref < 0) continue;
        hits++;
        const got = groundRay(surface, o, d, 3000);
        if (got < 0) missed++;
        else if (got > ref + 10) late++;
      }
    }
    console.log(`low shots: ${hits} of 450 meet the ground within 3 km; the ray missed ${missed}, found the hit more than 10 m late ${late}`);
    expect(hits).toBeGreaterThan(100);
    // What it may still miss are features thinner than its smallest step.
    expect(missed / hits).toBeLessThan(0.03);
    expect(late / hits).toBeLessThan(0.12);
  });

  it('is exact where there is nothing to find: a shot high above the ground is a miss and costs no terrain samples', () => {
    for (const { o, d } of rays(40_000, 20)) {
      expect(groundRay(surface, o, d, 3000)).toBe(-1);
    }
  });
});
