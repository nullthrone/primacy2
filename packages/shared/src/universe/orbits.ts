/**
 * Orbital mechanics on rails: where every body and site is at universe time `t`.
 * All functions are pure and deterministic. Positions are barycentric unless stated otherwise.
 *
 * Axes: the reference plane is XZ and +Y is north. A textbook orbit computed with z up
 * (xs, ys, zs) maps to system axes as (xs, zs, -ys), which keeps the frame right-handed.
 */
import { G, SITE_ID_BASE } from '../constants.ts';
import { v3, type Vec3 } from '../math.ts';
import type { OrbitDef, SiteDef, StateVector, SystemDef } from './types.ts';

const TWO_PI = Math.PI * 2;

/** Solves the Kepler equation M = E - e sin E for the eccentric anomaly E. `M` may be any real number. */
export function solveKepler(meanAnomaly: number, e: number): number {
  let m = meanAnomaly % TWO_PI;
  if (m > Math.PI) m -= TWO_PI;
  else if (m < -Math.PI) m += TWO_PI;
  if (e < 1e-9) return m;
  // Newton iteration from a starting guess that converges for all e < 1.
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let i = 0; i < 30; i++) {
    const f = E - e * Math.sin(E) - m;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** Period of an orbit with semi-major axis `a` around a parent of the given mass. */
export const orbitalPeriod = (a: number, parentMass: number): number => TWO_PI * Math.sqrt((a * a * a) / (G * parentMass));

/** Builds a circular orbit of radius `a` around a parent of the given mass; `phase` is the mean anomaly at t = 0. */
export function circularOrbit(parent: number, parentMass: number, a: number, phase: number, inc = 0, node = 0): OrbitDef {
  return { parent, a, e: 0, inc, node, argp: 0, m0: phase, period: orbitalPeriod(a, parentMass) };
}

/** Position and velocity relative to the parent of the orbit, in system axes. */
export function orbitState(o: OrbitDef, t: number): StateVector {
  const n = TWO_PI / o.period;
  const E = solveKepler(o.m0 + n * t, o.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const b = Math.sqrt(1 - o.e * o.e);
  const xp = o.a * (cosE - o.e);
  const yp = o.a * b * sinE;
  const eDot = n / (1 - o.e * cosE);
  const vxp = -o.a * sinE * eDot;
  const vyp = o.a * b * cosE * eDot;

  const cO = Math.cos(o.node), sO = Math.sin(o.node);
  const ci = Math.cos(o.inc), si = Math.sin(o.inc);
  const cw = Math.cos(o.argp), sw = Math.sin(o.argp);
  // Perifocal -> textbook inertial (z up).
  const m00 = cO * cw - sO * sw * ci, m01 = -cO * sw - sO * cw * ci;
  const m10 = sO * cw + cO * sw * ci, m11 = -sO * sw + cO * cw * ci;
  const m20 = sw * si, m21 = cw * si;
  const xs = m00 * xp + m01 * yp, ys = m10 * xp + m11 * yp, zs = m20 * xp + m21 * yp;
  const vxs = m00 * vxp + m01 * vyp, vys = m10 * vxp + m11 * vyp, vzs = m20 * vxp + m21 * vyp;
  return { pos: [xs, zs, -ys], vel: [vxs, vzs, -vys] };
}

/** Barycentric state of a body (walks the parent chain). Body 0 is at rest at the origin. */
export function bodyState(sys: SystemDef, bodyId: number, t: number): StateVector {
  const pos: Vec3 = [0, 0, 0];
  const vel: Vec3 = [0, 0, 0];
  let body = sys.bodies[bodyId];
  if (!body) throw new Error(`unknown body ${bodyId}`);
  // The chain is at most star -> planet -> moon; the guard only protects against malformed data.
  for (let depth = 0; body && body.orbit && depth < 8; depth++) {
    const s = orbitState(body.orbit, t);
    v3.addScaledIn(pos, s.pos, 1);
    v3.addScaledIn(vel, s.vel, 1);
    body = sys.bodies[body.orbit.parent];
  }
  return { pos, vel };
}

/** Barycentric states of all bodies, index-aligned with `sys.bodies`. Cheaper than calling `bodyState` per body. */
export function allBodyStates(sys: SystemDef, t: number): StateVector[] {
  const out: StateVector[] = new Array(sys.bodies.length);
  for (let i = 0; i < sys.bodies.length; i++) {
    const b = sys.bodies[i]!;
    if (!b.orbit) {
      out[i] = { pos: [0, 0, 0], vel: [0, 0, 0] };
      continue;
    }
    const s = orbitState(b.orbit, t);
    // Generated systems list parents before children; fall back to the slow path otherwise.
    const parent = b.orbit.parent < i ? out[b.orbit.parent]! : bodyState(sys, b.orbit.parent, t);
    out[i] = { pos: v3.add(parent.pos, s.pos), vel: v3.add(parent.vel, s.vel) };
  }
  return out;
}

/** The site with this anchor id, or undefined (also for body ids). */
export function findSite(sys: SystemDef, anchorId: number): SiteDef | undefined {
  if (anchorId < SITE_ID_BASE) return undefined;
  const direct = sys.sites[anchorId - SITE_ID_BASE];
  if (direct && direct.id === anchorId) return direct;
  return sys.sites.find((s) => s.id === anchorId);
}

/** True when `anchorId` names an existing body or site of the system. */
export function isValidAnchor(sys: SystemDef, anchorId: number): boolean {
  if (!Number.isInteger(anchorId) || anchorId < 0) return false;
  return anchorId < SITE_ID_BASE ? anchorId < sys.bodies.length : findSite(sys, anchorId) !== undefined;
}

/** Barycentric state of an anchor: a body (`id < SITE_ID_BASE`) or a site. Throws on unknown ids. */
export function anchorState(sys: SystemDef, anchorId: number, t: number): StateVector {
  if (anchorId < SITE_ID_BASE) return bodyState(sys, anchorId, t);
  const site = findSite(sys, anchorId);
  if (!site) throw new Error(`unknown anchor ${anchorId}`);
  const parent = bodyState(sys, site.orbit.parent, t);
  const s = orbitState(site.orbit, t);
  return { pos: v3.add(parent.pos, s.pos), vel: v3.add(parent.vel, s.vel) };
}

export function anchorName(sys: SystemDef, anchorId: number): string {
  if (anchorId < SITE_ID_BASE) return sys.bodies[anchorId]?.name ?? 'Unknown';
  return findSite(sys, anchorId)?.name ?? 'Unknown';
}

/**
 * Sphere-of-influence radius of a body: a * (m / M_parent)^(2/5), at least 3 body radii.
 * Infinity for the primary (body 0).
 */
export function soiRadius(sys: SystemDef, bodyId: number): number {
  const b = sys.bodies[bodyId];
  if (!b || !b.orbit) return Infinity;
  const parent = sys.bodies[b.orbit.parent];
  if (!parent) return Infinity;
  return Math.max(b.radius * 3, b.orbit.a * Math.pow(b.mass / parent.mass, 0.4));
}

/**
 * The body anchor for a ship in cruise at barycentric position `absPos`:
 * the body with the smallest sphere of influence that contains the position (body 0 if none).
 */
export function pickCruiseAnchor(sys: SystemDef, absPos: Readonly<Vec3>, t: number): number {
  const states = allBodyStates(sys, t);
  let best = 0;
  let bestSoi = Infinity;
  for (let i = 1; i < sys.bodies.length; i++) {
    const soi = soiRadius(sys, i);
    if (soi < bestSoi && v3.distSq(absPos, states[i]!.pos) < soi * soi) {
      best = i;
      bestSoi = soi;
    }
  }
  return best;
}

/**
 * The anchor for a ship entering normal space at `absPos`: the nearest site whose `frameRadius`
 * contains the position, otherwise `pickCruiseAnchor`.
 */
export function pickNormalAnchor(sys: SystemDef, absPos: Readonly<Vec3>, t: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const site of sys.sites) {
    const d = v3.dist(absPos, anchorState(sys, site.id, t).pos);
    if (d < site.frameRadius && d < bestDist) {
      best = site.id;
      bestDist = d;
    }
  }
  return best >= 0 ? best : pickCruiseAnchor(sys, absPos, t);
}
