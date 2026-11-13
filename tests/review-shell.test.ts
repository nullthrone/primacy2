/**
 * Review of the landing core, shared part: the two landing limits, and where orbital sites stand
 * against the surface-frame shell of landable bodies.
 */
import { describe, expect, it } from 'vitest';
import {
  LAND_MAX_SLOPE,
  LAND_MAX_SLOPE_DEG,
  LAND_MAX_TILT_DEG,
  LAND_MIN_UPRIGHT,
  anchorState,
  bodySurface,
  generateSector,
  upsertGateSite,
  type SiteDef,
  type SystemDef,
} from '@primacy2/shared';

describe('landing limits are literals', () => {
  it('LAND_MAX_SLOPE is tan(20 deg) and LAND_MIN_UPRIGHT is cos(30 deg) to float precision', () => {
    // The degrees constants stay for the client; the literals are what the step compares against.
    expect(LAND_MAX_SLOPE_DEG).toBe(20);
    expect(LAND_MAX_TILT_DEG).toBe(30);
    const tan = Math.tan((LAND_MAX_SLOPE_DEG * Math.PI) / 180);
    const cos = Math.cos((LAND_MAX_TILT_DEG * Math.PI) / 180);
    // One ulp of a number of this size is 5.6e-17 (tan) and 1.1e-16 (cos).
    expect(Math.abs(LAND_MAX_SLOPE - tan)).toBeLessThanOrEqual(5.6e-17);
    expect(Math.abs(LAND_MIN_UPRIGHT - cos)).toBeLessThanOrEqual(1.2e-16);
    // And to the exact values: tan 20 deg = 0.36397023426620236135..., cos 30 deg = sqrt(3) / 2.
    expect(Math.abs(LAND_MAX_SLOPE - 0.36397023426620236135)).toBeLessThan(1e-16);
    expect(Math.abs(LAND_MIN_UPRIGHT - Math.sqrt(3) / 2)).toBeLessThan(2e-16);
  });
});

// ---------------------------------------------------------------------------------------------
// Orbital sites against the shell
// ---------------------------------------------------------------------------------------------

const SECTORS: SystemDef[] = [];
for (let k = 0; k < 60; k++) {
  SECTORS.push(...generateSector({ serverId: `shell${k}abcdefghijk`, seed: `shell-seed-${k}`, center: [3 * k, -2, 33], radius: 18, count: 48 }));
}

// Warp gates are added to a system after it is generated; give every system three, towards different neighbours.
for (const sys of SECTORS) {
  [[1, 0, 0], [0, 0, -1], [-1, 0.3, 0.2]].forEach((towards, i) => {
    upsertGateSite(sys, { linkId: `link-${sys.id}-${i}`, peer: 'peer', remoteSystem: 'x:0', state: 'active', progress: 1, remoteProgress: 1 }, towards as [number, number, number]);
  });
}

/** Hops from a body or site up to the root: each is an orbit about a parent with periapsis and apoapsis. */
interface Hop { parent: number; lo: number; hi: number }
function chainOfBody(sys: SystemDef, id: number): Hop[] {
  const hops: Hop[] = [];
  let cur = id;
  for (let guard = 0; guard < 8; guard++) {
    const o = sys.bodies[cur]?.orbit;
    if (!o) break;
    hops.push({ parent: o.parent, lo: o.a * (1 - o.e), hi: o.a * (1 + o.e) });
    cur = o.parent;
  }
  return hops;
}
function chainOfSite(sys: SystemDef, site: SiteDef): Hop[] {
  const o = site.orbit;
  return [{ parent: o.parent, lo: o.a * (1 - o.e), hi: o.a * (1 + o.e) }, ...chainOfBody(sys, o.parent)];
}

/**
 * A rigorous lower bound of the distance between two objects from their orbital hops: the bounds
 * of each one's distance from their nearest common ancestor. Returns -1 when the ranges overlap and
 * nothing can be said.
 */
function separationBound(a: Hop[], aRoot: number, b: Hop[], bRoot: number): number {
  // Ancestors of each, nearest first: the object's own parent, then upward.
  const ancA = [...a.map((h) => h.parent)];
  const ancB = [...b.map((h) => h.parent)];
  void aRoot;
  void bRoot;
  let ia = -1;
  let ib = -1;
  outer: for (let i = 0; i < ancA.length; i++) {
    for (let j = 0; j < ancB.length; j++) {
      if (ancA[i] === ancB[j]) { ia = i; ib = j; break outer; }
    }
  }
  if (ia < 0) return -1;
  const range = (hops: Hop[], top: number): [number, number] => {
    // hops[top] is the orbit about the common ancestor; the hops below it add up to a vector that is at most their sum long.
    let slack = 0;
    for (let i = 0; i < top; i++) slack += hops[i]!.hi;
    const lo = Math.max(0, hops[top]!.lo - slack);
    return [lo, hops[top]!.hi + slack];
  };
  const [aLo, aHi] = range(a, ia);
  const [bLo, bHi] = range(b, ib);
  if (aHi < bLo) return bLo - aHi;
  if (bHi < aLo) return aLo - bHi;
  return -1;
}

/** Smallest distance over many times; used only where the orbits' ranges overlap. */
function sampledMinimum(sys: SystemDef, site: SiteDef, body: number): number {
  let best = Infinity;
  const periods = [Math.max(site.orbit.period, 1), Math.max(sys.bodies[body]!.orbit?.period ?? 1, 1)];
  const span = 40 * Math.max(...periods);
  const n = 6000;
  for (let i = 0; i < n; i++) {
    const t = (span * i) / n;
    const a = anchorState(sys, site.id, t).pos;
    const b = anchorState(sys, body, t).pos;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d < best) best = d;
  }
  return best;
}

describe('orbital sites stay outside the surface-frame shell of every landable body', () => {
  it('the closest an orbital site gets to the centre of a landable body is above where its surface frame ends', () => {
    let pairs = 0;
    let proven = 0;
    let sampled = 0;
    let sameParent = 0;
    let smallest = Infinity;
    let where = '';
    for (const sys of SECTORS) {
      for (const body of sys.bodies) {
        const surface = bodySurface(sys, body.id);
        if (!surface) continue;
        for (const site of sys.sites) {
          if (site.ground) continue;
          pairs++;
          let margin: number;
          if (site.orbit.parent === body.id) {
            // Orbits the landable body itself: its closest approach is the periapsis.
            sameParent++;
            margin = site.orbit.a * (1 - site.orbit.e) - surface.exit;
          } else {
            const bound = separationBound(chainOfSite(sys, site), -1, chainOfBody(sys, body.id), -1);
            if (bound >= 0) {
              proven++;
              margin = bound - surface.exit;
            } else {
              sampled++;
              margin = sampledMinimum(sys, site, body.id) - surface.exit;
            }
          }
          if (margin < smallest) {
            smallest = margin;
            where = `${sys.id} site ${site.id} (${site.kind}, parent ${site.orbit.parent}) against body ${body.id}`;
          }
          expect(margin, `${sys.id}: site ${site.id} ${site.kind} comes within the surface-frame shell of body ${body.id}`).toBeGreaterThan(0);
        }
      }
    }
    console.log(`shell test: ${pairs} site/landable-body pairs (${sameParent} orbit the body, ${proven} proven apart by their orbit ranges, ${sampled} sampled); smallest margin ${(smallest / 1000).toFixed(1)} km above the exit height, ${where}`);
    expect(pairs).toBeGreaterThan(500);
    // Stations are generated 400 km or more above the surface of their planet; the frame ends at most
    // 1.3 * 300 km = 390 km up. The 10 km between them is the whole margin, so a change to either
    // number that closes it must show here.
    expect(smallest).toBeGreaterThan(5_000);
  });
});
