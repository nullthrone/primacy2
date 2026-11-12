/**
 * Orbital mechanics on rails: where every body and site is at universe time `t`.
 * All functions are pure and deterministic. Positions are barycentric unless stated otherwise.
 *
 * Axes: the reference plane is XZ and +Y is north. A textbook orbit computed with z up
 * (xs, ys, zs) maps to system axes as (xs, zs, -ys), which keeps the frame right-handed.
 */
import { G, SITE_ID_BASE, SURFACE_FRAME_MAX, SURFACE_FRAME_MIN, SURFACE_FRAME_RADII, SURFACE_ID_BASE } from '../constants.ts';
import { clamp, quat, v3, type Quat, type Vec3 } from '../math.ts';
import { isLandable } from './terrain.ts';
import type { BodyDef, OrbitDef, SiteDef, StateVector, SystemDef } from './types.ts';

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
  // The empty orbit of a ground site (period 0) stays at the parent's centre.
  const n = o.period > 0 ? TWO_PI / o.period : 0;
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

// ---------------------------------------------------------------------------------------------
// Body rotation
// ---------------------------------------------------------------------------------------------

/**
 * Unit rotation axis of a body in system axes: +Y rotated about +X by `tilt`. A negative
 * `rotPeriod` means the body spins clockwise seen from the tip of this axis. Rings lie in the
 * plane normal to it.
 */
export function bodySpinAxis(body: { tilt: number }): Vec3 {
  return [0, Math.cos(body.tilt), Math.sin(body.tilt)];
}

/**
 * Rotation of a body at universe time `t`: the quaternion that turns body-fixed axes into system
 * axes. The body-fixed +Y axis is the spin axis; the body has turned by `t / rotPeriod` turns
 * about it, and the axis is then tilted about system +X by `tilt`. This is the one definition
 * of how bodies turn: the surface frame, the terrain and the renderer all follow it.
 */
export function bodyRotation(body: Pick<BodyDef, 'tilt' | 'rotPeriod'>, t: number): Quat {
  // Only the fraction of a turn matters, which keeps the angle exact after years of universe time.
  const turns = body.rotPeriod !== 0 ? (t / body.rotPeriod) % 1 : 0;
  const spin = turns * Math.PI;
  const tilt = body.tilt / 2;
  return quat.mul([Math.sin(tilt), 0, 0, Math.cos(tilt)], [0, Math.sin(spin), 0, Math.cos(spin)]);
}

/** Signed spin rate of a body about its axis in rad/s; in body-fixed axes the angular velocity is `[0, rate, 0]`. */
export const bodySpinRate = (body: Pick<BodyDef, 'rotPeriod'>): number => (body.rotPeriod !== 0 ? TWO_PI / body.rotPeriod : 0);

/** Angular velocity vector of a body in system axes, rad/s. */
export function bodyAngularVelocity(body: Pick<BodyDef, 'tilt' | 'rotPeriod'>): Vec3 {
  return v3.scale(bodySpinAxis(body), bodySpinRate(body));
}

// ---------------------------------------------------------------------------------------------
// Anchors and frames
// ---------------------------------------------------------------------------------------------

/** Anchor id of the co-rotating surface frame of a body. */
export const surfaceAnchor = (bodyId: number): number => SURFACE_ID_BASE + bodyId;

/** True for the id of a surface frame (whether or not the body exists). */
export const isSurfaceAnchor = (anchorId: number): boolean => anchorId >= SURFACE_ID_BASE && anchorId < SITE_ID_BASE;

/** The body of a body anchor or of a surface anchor; -1 for sites and for no anchor. */
export function anchorBody(anchorId: number): number {
  if (!(anchorId >= 0) || anchorId >= SITE_ID_BASE) return -1;
  return anchorId < SURFACE_ID_BASE ? anchorId : anchorId - SURFACE_ID_BASE;
}

/**
 * Height (m) above the mean radius of a landable body below which a ship in normal flight is in
 * the surface frame: a tenth of the radius, between 60 and 300 km. It goes back to the
 * non-rotating body frame above SURFACE_FRAME_EXIT times this height.
 */
export const surfaceFrameAltitude = (body: Pick<BodyDef, 'radius'>): number =>
  clamp(SURFACE_FRAME_RADII * body.radius, SURFACE_FRAME_MIN, SURFACE_FRAME_MAX);

/** The site with this anchor id, or undefined (also for body and surface ids). */
export function findSite(sys: SystemDef, anchorId: number): SiteDef | undefined {
  if (anchorId < SITE_ID_BASE) return undefined;
  const direct = sys.sites[anchorId - SITE_ID_BASE];
  if (direct && direct.id === anchorId) return direct;
  return sys.sites.find((s) => s.id === anchorId);
}

/** True when `anchorId` names an existing body, the surface frame of a landable body, or a site of the system. */
export function isValidAnchor(sys: SystemDef, anchorId: number): boolean {
  if (!Number.isInteger(anchorId) || anchorId < 0) return false;
  if (anchorId < SURFACE_ID_BASE) return anchorId < sys.bodies.length;
  if (anchorId < SITE_ID_BASE) {
    const body = sys.bodies[anchorId - SURFACE_ID_BASE];
    return body !== undefined && isLandable(body);
  }
  return findSite(sys, anchorId) !== undefined;
}

/**
 * Orientation of a ground site on its body: turns the site's own axes (+Y up along the pad
 * normal, -Z toward the body's north, or toward body-fixed +X at a pole) into body-fixed axes.
 */
export function groundSiteRotation(site: SiteDef): Quat {
  const up = v3.normalize(site.ground ? site.ground.pos : [0, 1, 0]);
  // North along the ground: the spin axis with its vertical part removed.
  let north: Vec3 = [-up[1] * up[0], 1 - up[1] * up[1], -up[1] * up[2]];
  if (v3.lenSq(north) < 1e-6) north = [1 - up[0] * up[0], -up[0] * up[1], -up[0] * up[2]];
  return quat.lookRotation(north, up);
}

/** A frame of reference: where its origin is and how its axes lie and turn. */
export interface AnchorFrame {
  /** Barycentric position of the origin, metres. */
  pos: Vec3;
  /** Barycentric velocity of the origin, m/s. */
  vel: Vec3;
  /** Turns vectors in frame axes into system axes. The identity for a non-rotating frame. */
  rot: Quat;
  /** Angular velocity of the frame in system axes, rad/s. Zero for a non-rotating frame. */
  omega: Vec3;
}

/** True when positions relative to this anchor are in rotating axes: a surface frame or a ground site. */
export function isRotatingAnchor(sys: SystemDef, anchorId: number): boolean {
  if (anchorId < SURFACE_ID_BASE) return false;
  if (anchorId < SITE_ID_BASE) return true;
  return findSite(sys, anchorId)?.ground !== undefined;
}

/**
 * The frame of an anchor at universe time `t`. Body anchors and orbital sites move with their
 * anchor without turning. A surface anchor has its origin at the body centre and turns with the
 * body. A ground site has its origin at the centre of its pad, its axes as `groundSiteRotation`
 * says, and turns with the body too. Throws on unknown ids.
 */
export function anchorFrame(sys: SystemDef, anchorId: number, t: number): AnchorFrame {
  if (anchorId >= 0 && anchorId < SURFACE_ID_BASE) {
    const st = bodyState(sys, anchorId, t);
    return { pos: st.pos, vel: st.vel, rot: [0, 0, 0, 1], omega: [0, 0, 0] };
  }
  if (anchorId >= SURFACE_ID_BASE && anchorId < SITE_ID_BASE) {
    const body = sys.bodies[anchorId - SURFACE_ID_BASE];
    if (!body || !isLandable(body)) throw new Error(`unknown anchor ${anchorId}`);
    const st = bodyState(sys, body.id, t);
    return { pos: st.pos, vel: st.vel, rot: bodyRotation(body, t), omega: bodyAngularVelocity(body) };
  }
  const site = findSite(sys, anchorId);
  if (!site) throw new Error(`unknown anchor ${anchorId}`);
  if (site.ground) {
    const body = sys.bodies[site.ground.body];
    if (!body) throw new Error(`unknown anchor ${anchorId}`);
    const st = bodyState(sys, body.id, t);
    const rot = bodyRotation(body, t);
    const omega = bodyAngularVelocity(body);
    // The pad is carried around by the body: its velocity is the body's plus omega x r.
    const offset = quat.rotate(rot, site.ground.pos);
    return {
      pos: v3.add(st.pos, offset),
      vel: v3.add(st.vel, v3.cross(omega, offset)),
      rot: quat.mul(rot, groundSiteRotation(site)),
      omega,
    };
  }
  const parent = bodyState(sys, site.orbit.parent, t);
  const s = orbitState(site.orbit, t);
  return { pos: v3.add(parent.pos, s.pos), vel: v3.add(parent.vel, s.vel), rot: [0, 0, 0, 1], omega: [0, 0, 0] };
}

/**
 * Barycentric position and velocity of the origin of an anchor: a body, the surface frame of a
 * body (the body centre), an orbital site, or a ground site (the true moving position of its
 * pad). Throws on unknown ids.
 */
export function anchorState(sys: SystemDef, anchorId: number, t: number): StateVector {
  if (anchorId < SURFACE_ID_BASE) return bodyState(sys, anchorId, t);
  if (anchorId < SITE_ID_BASE) {
    if (!isValidAnchor(sys, anchorId)) throw new Error(`unknown anchor ${anchorId}`);
    return bodyState(sys, anchorId - SURFACE_ID_BASE, t);
  }
  const site = findSite(sys, anchorId);
  if (!site) throw new Error(`unknown anchor ${anchorId}`);
  if (site.ground) {
    const f = anchorFrame(sys, anchorId, t);
    return { pos: f.pos, vel: f.vel };
  }
  const parent = bodyState(sys, site.orbit.parent, t);
  const s = orbitState(site.orbit, t);
  return { pos: v3.add(parent.pos, s.pos), vel: v3.add(parent.vel, s.vel) };
}

export function anchorName(sys: SystemDef, anchorId: number): string {
  if (anchorId < SITE_ID_BASE) return sys.bodies[anchorBody(anchorId)]?.name ?? 'Unknown';
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
 * The landable body whose surface frame contains the barycentric position `absPos` (it is less
 * than `surfaceFrameAltitude` above the mean radius), or -1. With several, the one whose surface is nearest.
 */
export function surfaceBodyAt(sys: SystemDef, absPos: Readonly<Vec3>, t: number): number {
  let best = -1;
  let bestHeight = Infinity;
  let states: StateVector[] | null = null;
  for (const body of sys.bodies) {
    if (!isLandable(body)) continue;
    states ??= allBodyStates(sys, t);
    const height = v3.dist(absPos, states[body.id]!.pos) - body.radius;
    if (height < surfaceFrameAltitude(body) && height < bestHeight) {
      best = body.id;
      bestHeight = height;
    }
  }
  return best;
}

/**
 * The anchor for a ship entering normal space at `absPos`. Close above a landable body (see
 * `surfaceBodyAt`) it is that body's surface frame, whatever else is near: `simulateShip` moves
 * every ship in normal flight into that frame there, so this must agree with it. Otherwise it
 * is the nearest orbital site whose `frameRadius` contains the position, otherwise the body of
 * `pickCruiseAnchor`. A ground site is never an anchor for flight.
 */
export function pickNormalAnchor(sys: SystemDef, absPos: Readonly<Vec3>, t: number): number {
  const ground = surfaceBodyAt(sys, absPos, t);
  if (ground >= 0) return surfaceAnchor(ground);
  let best = -1;
  let bestDist = Infinity;
  for (const site of sys.sites) {
    if (site.ground) continue;
    const d = v3.dist(absPos, anchorState(sys, site.id, t).pos);
    if (d < site.frameRadius && d < bestDist) {
      best = site.id;
      bestDist = d;
    }
  }
  return best >= 0 ? best : pickCruiseAnchor(sys, absPos, t);
}
