/**
 * Review of the landing core, shared part: frame conversions. A ship that coasts with its engines
 * off across the border between the frame of a body and its surface frame keeps its inertial
 * trajectory, and an orbit flown for many revolutions in the turning surface frame keeps its energy.
 */
import { describe, expect, it } from 'vitest';
import {
  Button,
  DT,
  G,
  absolutePosition,
  absoluteRotation,
  absoluteVelocity,
  anchorState,
  bodyRotation,
  bodySpinRate,
  bodySurface,
  buildStepEnv,
  computeShipStats,
  isSurfaceAnchor,
  newShipState,
  quat,
  reanchor,
  simulateShip,
  starterLoadout,
  stepShip,
  surfaceAnchor,
  surfaceFrameAltitude,
  v3,
  type ShipInput,
  type ShipState,
  type Vec3,
} from '@primacy2/shared';

import { LANDING_PLANET, LANDING_PLANET_MASS, LANDING_PLANET_RADIUS, landingSystem } from '../packages/shared/src/sim/fixtures.ts';

const sys = landingSystem();
const planet = sys.bodies[LANDING_PLANET]!;
const stats = computeShipStats(starterLoadout('wisp'));
const mu = G * LANDING_PLANET_MASS;
/** Engines off: no thrust, no throttle, flight assist off. */
const COAST: ShipInput = { seq: 0, thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: Button.FaOff };
const T0 = 1.2e6;

const clone = (s: ShipState): ShipState => ({ ...s, pos: [...s.pos], vel: [...s.vel], rot: [...s.rot], angVel: [...s.angVel], aim: [...s.aim], pips: s.pips });
/** Angle in radians between two orientations. */
const angle = (a: Readonly<[number, number, number, number]>, b: Readonly<[number, number, number, number]>): number => {
  // The rotation from a to b is b * conjugate(a); its angle is 2 atan2(|vector part|, |w|), which resolves 1e-16 where acos does not resolve 1e-8.
  const q = quat.mul(b as never, [-a[0], -a[1], -a[2], a[3]] as never) as [number, number, number, number];
  return 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
};

/**
 * The state of a ship of the planet's frames in axes that do not turn, centred on the planet: float64 resolves
 * about 3e-5 m at the distance of the barycentre from the star, so comparing barycentric states hides errors
 * of that size; these numbers show the error of the conversion itself.
 */
function planetCentred(s: ShipState, t: number): { pos: Vec3; vel: Vec3; rot: [number, number, number, number] } {
  if (!isSurfaceAnchor(s.anchor)) return { pos: s.pos, vel: s.vel, rot: s.rot as [number, number, number, number] };
  const turn = bodyRotation(planet, t);
  const omega: Vec3 = [0, bodySpinRate(planet), 0];
  const vel = v3.add(s.vel, v3.cross(omega, s.pos));
  return { pos: quat.rotate(turn, s.pos), vel: quat.rotate(turn, vel), rot: quat.mul(turn, s.rot) as [number, number, number, number] };
}

/**
 * Flies `ticks` ticks from state `s0` at universe time T0. Every tick the ship is also stepped once
 * in the frame it started the tick in, without re-anchoring, and the two results are compared as
 * barycentric states: any difference is what the change of frame did to the trajectory.
 */
function coast(s0: ShipState, ticks: number): { crossings: number; dPos: number; dVel: number; dRot: number; dPosAny: number; cPos: number; cVel: number; cRot: number } {
  const s = clone(s0);
  let t = T0;
  let crossings = 0;
  let dPos = 0;
  let dVel = 0;
  let dRot = 0;
  let dPosAny = 0;
  let cPos = 0;
  let cVel = 0;
  let cRot = 0;
  for (let i = 0; i < ticks; i++) {
    const ref = clone(s);
    stepShip(ref, COAST, stats, buildStepEnv(sys, ref.anchor, t), DT);
    const before = s.anchor;
    simulateShip(s, COAST, stats, sys, t, DT);
    t += DT;
    const dp = v3.dist(absolutePosition(s, sys, t), absolutePosition(ref, sys, t));
    dPosAny = Math.max(dPosAny, dp);
    if (s.anchor !== before) {
      crossings++;
      dPos = Math.max(dPos, dp);
      dVel = Math.max(dVel, v3.dist(absoluteVelocity(s, sys, t), absoluteVelocity(ref, sys, t)));
      dRot = Math.max(dRot, angle(absoluteRotation(s, sys, t), absoluteRotation(ref, sys, t)));
      const a = planetCentred(s, t);
      const b = planetCentred(ref, t);
      cPos = Math.max(cPos, v3.dist(a.pos, b.pos));
      cVel = Math.max(cVel, v3.dist(a.vel, b.vel));
      cRot = Math.max(cRot, angle(a.rot, b.rot));
    }
  }
  return { crossings, dPos, dVel, dRot, dPosAny, cPos, cVel, cRot };
}

/** A tumbling ship at `radius` metres from the planet centre in the frame `anchor`, moving with `vel` there. */
function shipAt(anchor: number, dir: Vec3, radius: number, vel: Vec3): ShipState {
  const s = newShipState(stats);
  s.anchor = anchor;
  s.pos = v3.scale(v3.normalize(dir), radius);
  s.vel = [...vel];
  s.rot = quat.normalize([0.3, -0.5, 0.2, 0.8]);
  s.angVel = [0.02, -0.01, 0.015];
  s.fa = false;
  return s;
}

describe('frame conversions with the engines off', () => {
  const enter = LANDING_PLANET_RADIUS + surfaceFrameAltitude(planet);
  const dir: Vec3 = [0.4, 0.7, -0.59];

  it('falling in across the border keeps position, velocity and orientation (inertial) to float error', () => {
    // From 100 km above the border at 1.5 km/s inwards with some sideways speed, in the body's frame.
    const s = shipAt(LANDING_PLANET, dir, enter + 100_000, v3.add(v3.scale(v3.normalize(dir), -1_500), v3.scale(v3.normalize(v3.cross(dir, [0, 0, 1])), 400)));
    const r = coast(s, 4_000);
    console.log('inbound crossing:', JSON.stringify(r));
    expect(r.crossings).toBe(1);
    expect(r.dPos).toBeLessThan(1e-6);
    expect(r.dVel).toBeLessThan(1e-9);
    expect(r.dRot).toBeLessThan(1e-9);
    // The same, centred on the planet, where float64 resolves 1e-9 m.
    expect(r.cPos).toBeLessThan(1e-6);
    expect(r.cVel).toBeLessThan(1e-9);
    expect(r.cRot).toBeLessThan(1e-9);
    // Every other tick is stepped in the same frame as its reference and is bit for bit the same.
    expect(r.dPosAny).toBeLessThan(1e-6);
  });

  it('climbing out across the border keeps position, velocity and orientation (inertial) to float error', () => {
    const exit = LANDING_PLANET_RADIUS + 1.3 * surfaceFrameAltitude(planet);
    const s = shipAt(surfaceAnchor(LANDING_PLANET), dir, enter - 60_000, [0, 0, 0]);
    // 1.5 km/s straight up and 400 m/s along the ground, in the turning frame.
    s.vel = v3.add(v3.scale(v3.normalize(dir), 1_500), v3.scale(v3.normalize(v3.cross(dir, [0, 0, 1])), 400));
    const r = coast(s, 5_000);
    console.log('outbound crossing:', JSON.stringify(r), 'exit', exit);
    expect(r.crossings).toBe(1);
    expect(r.dPos).toBeLessThan(1e-6);
    expect(r.dVel).toBeLessThan(1e-9);
    expect(r.dRot).toBeLessThan(1e-9);
    expect(r.cPos).toBeLessThan(1e-6);
    expect(r.cVel).toBeLessThan(1e-9);
    expect(r.cRot).toBeLessThan(1e-9);
    expect(r.dPosAny).toBeLessThan(1e-6);
  });

  it('a ship hovering at the border (no hysteresis chatter) changes frame at most once', () => {
    // Coasting up to just under the exit height and falling back: it must not flip frames each tick.
    const s = shipAt(surfaceAnchor(LANDING_PLANET), dir, enter + 70_000, [0, 0, 0]);
    s.vel = v3.scale(v3.normalize(dir), 120);
    const r = coast(s, 6_000);
    expect(r.crossings).toBeLessThanOrEqual(1);
  });
});

describe('an orbit held in the turning surface frame', () => {
  it('keeps its inertial energy over many revolutions, with the drift of the explicit Coriolis step well below what a pilot could see', () => {
    // 100 km above the ground of a planet that turns once in four hours, retrograde to its spin so
    // that the ground moves fastest under the ship.
    const altitude = 100_000;
    const r0 = LANDING_PLANET_RADIUS + altitude;
    const dir: Vec3 = [0.2, 0.1, 0.97];
    const up = v3.normalize(dir);
    const vCirc = Math.sqrt((mu * 1) / r0);
    const heading = v3.normalize(v3.cross(up, [0, 1, 0]));
    const body = LANDING_PLANET;

    // The same inertial state in the body's frame, then handed to the surface frame by `reanchor`.
    const inertial = shipAt(body, up, r0, v3.scale(heading, -vCirc));
    const inSurface = clone(inertial);
    reanchor(inSurface, sys, surfaceAnchor(body), T0);
    expect(isSurfaceAnchor(inSurface.anchor)).toBe(true);

    const energy = (s: ShipState, t: number): number => {
      const centre = anchorState(sys, body, t);
      const v = v3.sub(absoluteVelocity(s, sys, t), centre.vel);
      const p = v3.sub(absolutePosition(s, sys, t), centre.pos);
      return 0.5 * v3.lenSq(v) - mu / v3.len(p);
    };
    const period = (2 * Math.PI * r0) / vCirc;
    const revolutions = 4;
    const ticks = Math.round((revolutions * period) / DT);
    const a = clone(inSurface);
    const b = clone(inertial);
    let t = T0;
    const e0 = energy(a, t);
    let worstA = 0;
    let worstB = 0;
    let envB = buildStepEnv(sys, b.anchor, t);
    for (let i = 0; i < ticks; i++) {
      simulateShip(a, COAST, stats, sys, t, DT);
      // The reference stays in the frame that does not turn, whatever the height.
      if (i % 30 === 0) envB = buildStepEnv(sys, b.anchor, t);
      stepShip(b, COAST, stats, envB, DT);
      t += DT;
      if (i % 3_000 === 0) {
        worstA = Math.max(worstA, Math.abs(energy(a, t) / e0 - 1));
        worstB = Math.max(worstB, Math.abs(energy(b, t) / e0 - 1));
      }
      expect(isSurfaceAnchor(a.anchor)).toBe(true);
    }
    worstA = Math.max(worstA, Math.abs(energy(a, t) / e0 - 1));
    worstB = Math.max(worstB, Math.abs(energy(b, t) / e0 - 1));
    const gap = v3.dist(absolutePosition(a, sys, t), absolutePosition(b, sys, t));
    console.log(`orbit: ${revolutions} revolutions (${ticks} ticks): worst relative energy change surface frame ${worstA.toExponential(2)}, body frame ${worstB.toExponential(2)}; positions ${gap.toFixed(1)} m apart`);
    // The surface frame integrates Coriolis explicitly (a rotation by 2 omega dt per tick that
    // grows the speed by (omega dt)^2 / 2 each time), so it drifts about 400 times more than the
    // frame that does not turn: 2.5e-4 over these 6 hours on a planet with a four-hour day. The
    // fastest planet the generator makes turns once in eight hours, which is 4 times slower and
    // so 4 times less drift (drift goes with omega squared); the moons turn with their orbits.
    expect(worstB).toBeLessThan(1e-5);
    expect(worstA).toBeLessThan(1e-3);
    expect(bodySurface(sys, body)).not.toBeNull();
  });
});
