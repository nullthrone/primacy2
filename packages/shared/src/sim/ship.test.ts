import { describe, expect, it } from 'vitest';
import { computeShipStats, starterLoadout } from '../catalog.ts';
import {
  AIM_BUFFER_MAX,
  AU,
  BOOST_DURATION,
  BOOST_ENERGY,
  C,
  COMPACT_KILL_FACTOR,
  CRUISE_CHARGE_TIME,
  CRUISE_FUEL_RATE,
  CRUISE_GROUND_MIN_SPEED,
  CRUISE_MIN_SPEED,
  CRUISE_TURN_FACTOR,
  DT,
  EARTH_MASS,
  EARTH_RADIUS,
  FOLD_CHARGE_TIME,
  G,
  SCOOP_MAX_RADII,
  SOLAR_RADIUS,
} from '../constants.ts';
import { forwardOf, quat, rightOf, v3, type Quat, type Vec3 } from '../math.ts';
import { Rng } from '../prng.ts';
import { soiRadius } from '../universe/orbits.ts';
import {
  blackHoleSystem,
  FIXTURE_BH_MASS,
  FIXTURE_BH_RS,
  FIXTURE_PLANET,
  FIXTURE_STAR,
  FIXTURE_STATION,
  fixtureSystem,
} from './fixtures.ts';
import {
  buildStepEnv,
  cruiseSpeedLimit,
  dilationAt,
  gravityAt,
  hazardsAt,
  MAX_SHIP_SPEED,
  MIN_DILATION,
  newShipState,
  simulateShip,
  stepShip,
} from './ship.ts';
import { absolutePosition, disengageCruise, engageCruise } from './transitions.ts';
import { Button, ChargeKind, FlightMode, type ShipInput, type ShipState, type ShipStats, type StepEnv } from './types.ts';

const DEG = Math.PI / 180;
const wisp = computeShipStats(starterLoadout('wisp'));
const drover = computeShipStats(starterLoadout('drover'));
const wayfarer = computeShipStats(starterLoadout('wayfarer'));

/** Deep space: no gravity, no heat. */
const EMPTY: StepEnv = { t: 0, anchor: 0, sources: [] };

const input = (over: Partial<ShipInput> = {}): ShipInput => ({
  seq: 0,
  thrust: [0, 0, 0],
  aim: [0, 0],
  roll: 0,
  throttle: 0,
  buttons: 0,
  ...over,
});

const cloneState = (s: ShipState): ShipState => ({
  ...s,
  pos: [s.pos[0], s.pos[1], s.pos[2]],
  vel: [s.vel[0], s.vel[1], s.vel[2]],
  rot: [s.rot[0], s.rot[1], s.rot[2], s.rot[3]],
  angVel: [s.angVel[0], s.angVel[1], s.angVel[2]],
  aim: [s.aim[0], s.aim[1]],
});

/** Every numeric field of a state in a fixed order (booleans as 0/1). */
const numbers = (s: ShipState): number[] => [
  s.mode, s.anchor, ...s.pos, ...s.vel, ...s.rot, ...s.angVel, ...s.aim, s.fa ? 1 : 0, s.throttle, s.cruiseSpeed,
  s.boost, s.boostCd, s.energy, s.heat, s.fuel, s.shield, s.hull, s.shieldDelay, s.charge, s.chargeKind, s.dilation,
];
const allFinite = (s: ShipState): boolean => numbers(s).every((x) => Number.isFinite(x));

/** Steps `s` with a constant input in a fixed environment and calls `each` after every tick. */
function run(
  s: ShipState,
  inp: ShipInput,
  stats: ShipStats,
  env: StepEnv,
  seconds: number,
  each?: (s: ShipState) => void,
): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    stepShip(s, inp, stats, env, DT);
    each?.(s);
  }
}

/** Yaw of the nose in degrees, positive toward +X (right), measured from -Z. */
const yawDeg = (rot: Readonly<Quat>): number => {
  const f = forwardOf(rot);
  return Math.atan2(f[0], -f[2]) / DEG;
};
/** Pitch of the nose in degrees, positive toward +Y (up). */
const pitchDeg = (rot: Readonly<Quat>): number => Math.asin(forwardOf(rot)[1]) / DEG;

describe('newShipState', () => {
  it('is at rest at anchor 0 with full systems and flight assist on', () => {
    const s = newShipState(wisp);
    expect(s.mode).toBe(FlightMode.Normal);
    expect(s.anchor).toBe(0);
    expect(s.pos).toEqual([0, 0, 0]);
    expect(s.vel).toEqual([0, 0, 0]);
    expect(s.rot).toEqual([0, 0, 0, 1]);
    expect(s.fa).toBe(true);
    expect(s.hull).toBe(wisp.hullMax);
    expect(s.shield).toBe(wisp.shieldMax);
    expect(s.energy).toBe(wisp.energyMax);
    expect(s.fuel).toBe(wisp.fuelCap);
    expect(s.chargeKind).toBe(ChargeKind.None);
    expect(s.dilation).toBe(1);
  });
});

describe('flight assist', () => {
  it('reaches about maxSpeed with forward held and never exceeds it by more than 2 %', () => {
    for (const inp of [input({ thrust: [0, 0, 1] }), input({ throttle: 1 })]) {
      const s = newShipState(wisp);
      let peak = 0;
      run(s, inp, wisp, EMPTY, 20, (st) => {
        peak = Math.max(peak, v3.len(st.vel));
      });
      expect(peak).toBeLessThanOrEqual(wisp.maxSpeed * 1.02);
      expect(v3.len(s.vel)).toBeGreaterThan(wisp.maxSpeed * 0.98);
      // Forward is -Z.
      expect(s.vel[2]).toBeLessThan(-wisp.maxSpeed * 0.98);
      expect(s.pos[2]).toBeLessThan(-1000);
    }
  });

  it('brakes to under 1 m/s when the controls are released', () => {
    const s = newShipState(wisp);
    run(s, input({ thrust: [0.4, -0.3, 1] }), wisp, EMPTY, 15);
    expect(v3.len(s.vel)).toBeGreaterThan(200);
    run(s, input(), wisp, EMPTY, 20);
    expect(v3.len(s.vel)).toBeLessThan(1);
  });

  it('brakes to a stop while the brake button is held, whatever the thrust input', () => {
    const s = newShipState(wisp);
    run(s, input({ throttle: 1 }), wisp, EMPTY, 15);
    run(s, input({ throttle: 1, thrust: [1, 0, 1], buttons: Button.Brake }), wisp, EMPTY, 20);
    expect(v3.len(s.vel)).toBeLessThan(1);
  });

  it('strafes on both axes in both directions', () => {
    const cases: { thrust: Vec3; axis: 0 | 1; sign: number }[] = [
      { thrust: [1, 0, 0], axis: 0, sign: 1 },
      { thrust: [-1, 0, 0], axis: 0, sign: -1 },
      { thrust: [0, 1, 0], axis: 1, sign: 1 },
      { thrust: [0, -1, 0], axis: 1, sign: -1 },
    ];
    for (const c of cases) {
      const s = newShipState(wisp);
      run(s, input({ thrust: c.thrust }), wisp, EMPTY, 15);
      const other = c.axis === 0 ? 1 : 0;
      expect(s.vel[c.axis] * c.sign).toBeGreaterThan(wisp.maxSpeed * 0.7 * 0.98);
      expect(s.vel[c.axis] * c.sign).toBeLessThanOrEqual(wisp.maxSpeed * 0.7 * 1.02);
      expect(Math.abs(s.vel[other])).toBeLessThan(1e-6);
      expect(Math.abs(s.vel[2])).toBeLessThan(1e-6);
      expect(s.pos[c.axis] * c.sign).toBeGreaterThan(1000);
    }
  });

  it('commands velocity in ship axes, not frame axes', () => {
    const s = newShipState(wisp);
    // Nose toward +X.
    s.rot = quat.lookRotation([1, 0, 0]);
    run(s, input({ throttle: 1 }), wisp, EMPTY, 15);
    expect(s.vel[0]).toBeGreaterThan(wisp.maxSpeed * 0.98);
    expect(Math.abs(s.vel[2])).toBeLessThan(1e-6);
  });

  it('limits reverse speed to 0.6 of the forward limit and the combined speed to the limit', () => {
    const back = newShipState(wisp);
    run(back, input({ throttle: -1 }), wisp, EMPTY, 20);
    expect(back.vel[2]).toBeGreaterThan(wisp.maxSpeed * 0.6 * 0.98);
    expect(back.vel[2]).toBeLessThanOrEqual(wisp.maxSpeed * 0.6 * 1.02);

    const diag = newShipState(wisp);
    let peak = 0;
    run(diag, input({ thrust: [1, 1, 1] }), wisp, EMPTY, 20, (st) => {
      peak = Math.max(peak, v3.len(st.vel));
    });
    expect(peak).toBeLessThanOrEqual(wisp.maxSpeed * 1.02);
    expect(v3.len(diag.vel)).toBeGreaterThan(wisp.maxSpeed * 0.98);
  });

  it('boost raises the speed limit and costs energy', () => {
    const s = newShipState(wisp);
    run(s, input({ throttle: 1 }), wisp, EMPTY, 15);
    const before = s.energy;
    stepShip(s, input({ throttle: 1, buttons: Button.Boost }), wisp, EMPTY, DT);
    expect(s.energy).toBeLessThan(before - BOOST_ENERGY + 1);
    expect(s.energy).toBeGreaterThan(before - BOOST_ENERGY - 1e-9);
    expect(s.boost).toBeGreaterThan(BOOST_DURATION - 2 * DT);
    expect(s.boostCd).toBeGreaterThan(0);

    let peak = 0;
    run(s, input({ throttle: 1 }), wisp, EMPTY, BOOST_DURATION - 2 * DT, (st) => {
      peak = Math.max(peak, v3.len(st.vel));
    });
    expect(peak).toBeGreaterThan(wisp.maxSpeed * 1.2);
    expect(peak).toBeLessThanOrEqual(wisp.boostSpeed * 1.02);

    // Once the boost has run out the ship settles back to its rated speed.
    run(s, input({ throttle: 1 }), wisp, EMPTY, 15);
    expect(s.boost).toBe(0);
    expect(v3.len(s.vel)).toBeLessThanOrEqual(wisp.maxSpeed * 1.02);
    expect(v3.len(s.vel)).toBeGreaterThan(wisp.maxSpeed * 0.98);
  });

  it('does not boost without enough energy or during the cooldown', () => {
    const s = newShipState(wisp);
    s.energy = BOOST_ENERGY - 5;
    stepShip(s, input({ buttons: Button.Boost }), wisp, EMPTY, DT);
    expect(s.boost).toBe(0);

    const t = newShipState(wisp);
    stepShip(t, input({ buttons: Button.Boost }), wisp, EMPTY, DT);
    const afterFirst = t.energy;
    // Held through the boost: no second charge is taken while the cooldown runs.
    run(t, input({ buttons: Button.Boost }), wisp, EMPTY, BOOST_DURATION);
    expect(t.energy).toBeGreaterThanOrEqual(afterFirst);
  });
});

describe('sign conventions', () => {
  it('positive aim[0] turns the nose toward +X (right)', () => {
    const s = newShipState(wisp);
    stepShip(s, input({ aim: [0.2, 0] }), wisp, EMPTY, DT);
    run(s, input(), wisp, EMPTY, 0.5);
    expect(forwardOf(s.rot)[0]).toBeGreaterThan(0.05);
    expect(Math.abs(forwardOf(s.rot)[1])).toBeLessThan(1e-9);
    // Yaw right is a rotation about -Y.
    const t = newShipState(wisp);
    stepShip(t, input({ aim: [0.2, 0] }), wisp, EMPTY, DT);
    expect(t.angVel[1]).toBeLessThan(0);
  });

  it('positive aim[1] turns the nose toward +Y (up)', () => {
    const s = newShipState(wisp);
    stepShip(s, input({ aim: [0, 0.2] }), wisp, EMPTY, DT);
    expect(s.angVel[0]).toBeGreaterThan(0);
    run(s, input(), wisp, EMPTY, 0.5);
    expect(forwardOf(s.rot)[1]).toBeGreaterThan(0.05);
    expect(Math.abs(forwardOf(s.rot)[0])).toBeLessThan(1e-9);
  });

  it('positive roll moves the right wing (+X) toward -Y', () => {
    const s = newShipState(wisp);
    run(s, input({ roll: 1 }), wisp, EMPTY, 0.5);
    expect(s.angVel[2]).toBeLessThan(0);
    expect(rightOf(s.rot)[1]).toBeLessThan(-0.05);
    // Rolling does not move the nose.
    expect(forwardOf(s.rot)[2]).toBeCloseTo(-1, 9);
  });

  it('thrust is [right, up, forward] with forward along -Z', () => {
    const fa = Button.FaOff;
    const right = newShipState(wisp);
    run(right, input({ thrust: [1, 0, 0], buttons: fa }), wisp, EMPTY, 1);
    expect(right.vel[0]).toBeCloseTo(wisp.accelLat, 6);
    const up = newShipState(wisp);
    run(up, input({ thrust: [0, 1, 0], buttons: fa }), wisp, EMPTY, 1);
    expect(up.vel[1]).toBeCloseTo(wisp.accelVert, 6);
    const fwd = newShipState(wisp);
    run(fwd, input({ thrust: [0, 0, 1], buttons: fa }), wisp, EMPTY, 1);
    expect(fwd.vel[2]).toBeCloseTo(-wisp.accelFwd, 6);
    const back = newShipState(wisp);
    run(back, input({ thrust: [0, 0, -1], buttons: fa }), wisp, EMPTY, 1);
    expect(back.vel[2]).toBeCloseTo(wisp.accelBack, 6);
  });
});

describe('aim', () => {
  for (const [name, stats] of [['Wisp', wisp], ['Drover', drover]] as const) {
    it(`${name}: a commanded 30 degree yaw ends on target without overshoot`, () => {
      const s = newShipState(stats);
      let peak = -Infinity;
      stepShip(s, input({ aim: [30 * DEG, 0] }), stats, EMPTY, DT);
      run(s, input(), stats, EMPTY, 6, (st) => {
        peak = Math.max(peak, yawDeg(st.rot));
      });
      const final = yawDeg(s.rot);
      expect(Math.abs(final - 30)).toBeLessThan(0.5);
      expect(peak).toBeLessThan(31);
      // The buffer is fully worked off and the ship has stopped turning.
      expect(s.aim).toEqual([0, 0]);
      expect(s.angVel).toEqual([0, 0, 0]);
      // Yaw alone leaves the horizon level.
      expect(Math.abs(pitchDeg(s.rot))).toBeLessThan(1e-9);
    });

    it(`${name}: a commanded 25 degree pitch down ends on target without overshoot`, () => {
      const s = newShipState(stats);
      let low = Infinity;
      stepShip(s, input({ aim: [0, -25 * DEG] }), stats, EMPTY, DT);
      run(s, input(), stats, EMPTY, 6, (st) => {
        low = Math.min(low, pitchDeg(st.rot));
      });
      expect(Math.abs(pitchDeg(s.rot) + 25)).toBeLessThan(0.5);
      expect(low).toBeGreaterThan(-26);
    });

    it(`${name}: aim fed in small steps every tick is followed at the turn rate limit`, () => {
      const s = newShipState(stats);
      // 90 degrees per second of mouse movement is more than either hull can turn.
      let peakRate = 0;
      run(s, input({ aim: [90 * DEG * DT, 0] }), stats, EMPTY, 3, (st) => {
        peakRate = Math.max(peakRate, -st.angVel[1]);
      });
      expect(peakRate).toBeLessThanOrEqual(stats.turnYaw * (1 + 1e-9));
      expect(peakRate).toBeGreaterThan(stats.turnYaw * 0.95);
      expect(s.aim[0]).toBeLessThanOrEqual(AIM_BUFFER_MAX);
    });
  }

  it('clamps the pending aim buffer', () => {
    const s = newShipState(wisp);
    stepShip(s, input({ aim: [5, -5] }), wisp, EMPTY, DT);
    expect(s.aim[0]).toBeLessThanOrEqual(AIM_BUFFER_MAX);
    expect(s.aim[0]).toBeGreaterThan(AIM_BUFFER_MAX - 0.05);
    expect(s.aim[1]).toBeGreaterThanOrEqual(-AIM_BUFFER_MAX);
    expect(s.aim[1]).toBeLessThan(-AIM_BUFFER_MAX + 0.05);
  });

  it('never lets the pending aim change sign', () => {
    const s = newShipState(wisp);
    stepShip(s, input({ aim: [0.3, 0.2] }), wisp, EMPTY, DT);
    run(s, input(), wisp, EMPTY, 3, (st) => {
      expect(st.aim[0]).toBeGreaterThanOrEqual(0);
      expect(st.aim[1]).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('flight assist off', () => {
  it('conserves momentum with no input', () => {
    const s = newShipState(wisp);
    s.vel = [120, -30, 45];
    s.throttle = 1;
    // The throttle setpoint is a flight-assist concept; raw mode ignores it.
    run(s, input({ throttle: 1, buttons: Button.FaOff }), wisp, EMPTY, 10);
    expect(s.fa).toBe(false);
    expect(s.vel).toEqual([120, -30, 45]);
    expect(s.pos[0]).toBeCloseTo(1200, 6);
    expect(s.pos[1]).toBeCloseTo(-300, 6);
    expect(s.pos[2]).toBeCloseTo(450, 6);
  });

  it('has no speed limit', () => {
    const s = newShipState(wisp);
    run(s, input({ thrust: [0, 0, 1], buttons: Button.FaOff }), wisp, EMPTY, 30);
    expect(v3.len(s.vel)).toBeGreaterThan(wisp.maxSpeed * 2);
    expect(v3.len(s.vel)).toBeCloseTo(wisp.accelFwd * 30, 3);
  });

  it('the brake button burns against the velocity until the ship stops', () => {
    const s = newShipState(wisp);
    s.vel = [300, 200, -400];
    let last = v3.len(s.vel);
    run(s, input({ buttons: Button.FaOff | Button.Brake }), wisp, EMPTY, 30, (st) => {
      const speed = v3.len(st.vel);
      expect(speed).toBeLessThanOrEqual(last);
      last = speed;
    });
    expect(v3.len(s.vel)).toBeLessThan(1e-6);
  });

  it('a circular orbit around the planet stays within 0.5 % of its radius for one full orbit', () => {
    const sys = fixtureSystem();
    const r = 7.0e6;
    const mu = G * EARTH_MASS;
    const s = newShipState(wisp);
    s.anchor = FIXTURE_PLANET;
    s.pos = [r, 0, 0];
    s.vel = [0, 0, -Math.sqrt(mu / r)];
    const period = 2 * Math.PI * Math.sqrt((r * r * r) / mu);
    const ticks = Math.round(period / DT);
    const inp = input({ buttons: Button.FaOff });
    let lo = Infinity;
    let hi = 0;
    let farthest = 0;
    for (let i = 0; i < ticks; i++) {
      simulateShip(s, inp, wisp, sys, i * DT, DT);
      const d = v3.len(s.pos);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
      farthest = Math.max(farthest, v3.dist(s.pos, [r, 0, 0]));
    }
    expect(lo).toBeGreaterThan(r * 0.995);
    expect(hi).toBeLessThan(r * 1.005);
    // It really went around (far side reached) and came back to where it started.
    expect(farthest).toBeGreaterThan(1.99 * r);
    expect(v3.dist(s.pos, [r, 0, 0])).toBeLessThan(0.01 * r);
  });
});

describe('gravity in the anchor frame', () => {
  it('a ship at rest at the station anchor origin drifts less than 1 m in 60 s', () => {
    const sys = fixtureSystem();
    for (const buttons of [Button.FaOff, 0]) {
      const s = newShipState(wisp);
      s.anchor = FIXTURE_STATION;
      const inp = input({ buttons });
      for (let i = 0; i < 60 / DT; i++) simulateShip(s, inp, wisp, sys, i * DT, DT);
      expect(v3.len(s.pos)).toBeLessThan(1);
    }
  });

  it('a ship 100 m from the station feels only the tide and drifts less than 1 m in 60 s', () => {
    const sys = fixtureSystem();
    for (const start of [[100, 0, 0], [0, 100, 0], [0, 0, -100]] as Vec3[]) {
      const s = newShipState(wisp);
      s.anchor = FIXTURE_STATION;
      s.pos = v3.clone(start);
      const env = buildStepEnv(sys, FIXTURE_STATION, 0);
      // The planet pulls at about 8 m/s^2 here, but almost none of it is felt in free fall.
      const g = v3.len(gravityAt(env, s.pos));
      expect(g).toBeLessThan(1e-3);
      const inp = input({ buttons: Button.FaOff });
      for (let i = 0; i < 60 / DT; i++) simulateShip(s, inp, wisp, sys, i * DT, DT);
      expect(v3.dist(s.pos, start)).toBeLessThan(1);
    }
  });

  it('the anchor body pulls with its full gravity', () => {
    const sys = fixtureSystem();
    const env = buildStepEnv(sys, FIXTURE_PLANET, 0);
    const g = gravityAt(env, [0, EARTH_RADIUS, 0]);
    expect(g[1]).toBeLessThan(0);
    expect(v3.len(g)).toBeCloseTo((G * EARTH_MASS) / (EARTH_RADIUS * EARTH_RADIUS), 3);
    const hz = hazardsAt(env, { ...newShipState(wisp), anchor: FIXTURE_PLANET, pos: [0, EARTH_RADIUS * 2, 0] }, wisp);
    expect(hz.dominantBody).toBe(FIXTURE_PLANET);
    expect(hz.insideBody).toBe(-1);
    expect(hz.lethal).toBe(false);
    expect(hz.gravity).toBeCloseTo((G * EARTH_MASS) / (4 * EARTH_RADIUS * EARTH_RADIUS), 3);
  });

  it('reports the body a ship is inside of and stays finite at its centre', () => {
    const sys = fixtureSystem();
    const env = buildStepEnv(sys, FIXTURE_PLANET, 0);
    const s = newShipState(wisp);
    s.anchor = FIXTURE_PLANET;
    s.pos = [0, EARTH_RADIUS * 1.03, 0];
    expect(hazardsAt(env, s, wisp).insideBody).toBe(FIXTURE_PLANET);
    s.pos = [0, EARTH_RADIUS * 1.05, 0];
    expect(hazardsAt(env, s, wisp).insideBody).toBe(-1);
    s.pos = [0, 0, 0];
    const hz = hazardsAt(env, s, wisp);
    expect(Number.isFinite(hz.gravity)).toBe(true);
    expect(Number.isFinite(hz.tidal)).toBe(true);
    expect(v3.isFinite(gravityAt(env, [0, 0, 0]))).toBe(true);
  });

  for (const [name, stats] of [['Wisp', wisp], ['Drover', drover]] as const) {
    it(`${name}: hovers within 5 m for 30 s at 1.2 planet radii with flight assist on`, () => {
      const sys = fixtureSystem();
      const start: Vec3 = [1.2 * EARTH_RADIUS * 0.6, 1.2 * EARTH_RADIUS * 0.8, 0];
      const s = newShipState(stats);
      s.anchor = FIXTURE_PLANET;
      s.pos = v3.clone(start);
      // An arbitrary attitude, so gravity has to be cancelled on all three thruster axes.
      s.rot = quat.fromAxisAngle([0.3, -0.5, 0.8], 1.1);
      const inp = input();
      let worst = 0;
      for (let i = 0; i < 30 / DT; i++) {
        simulateShip(s, inp, stats, sys, i * DT, DT);
        worst = Math.max(worst, v3.dist(s.pos, start));
      }
      expect(worst).toBeLessThan(5);
      expect(v3.len(s.vel)).toBeLessThan(0.1);
    });
  }
});

describe('relativity', () => {
  it('a long burn with flight assist off never reaches C', () => {
    const s = newShipState(wisp);
    const inp = input({ thrust: [0, 0, 1], buttons: Button.FaOff });
    let lastDilation = 1;
    // 2000 s per step: 40 000 steps are about 2.5 years of burning.
    for (let i = 0; i < 40_000; i++) {
      stepShip(s, inp, wisp, EMPTY, 2000);
      const speed = v3.len(s.vel);
      expect(speed).toBeLessThan(C);
      expect(s.dilation).toBeLessThanOrEqual(lastDilation);
      lastDilation = s.dilation;
    }
    expect(v3.len(s.vel)).toBeGreaterThan(0.5 * C);
    expect(s.dilation).toBeLessThan(0.9);
    expect(allFinite(s)).toBe(true);
  });

  it('clamps a velocity that would pass C and keeps accelerating ever more slowly', () => {
    const s = newShipState(wisp);
    s.vel = [0, 0, -0.9989 * C];
    const inp = input({ thrust: [0, 0, 1], buttons: Button.FaOff });
    for (let i = 0; i < 5000; i++) {
      stepShip(s, inp, wisp, EMPTY, 1e6);
      expect(v3.len(s.vel)).toBeLessThan(C);
      expect(v3.len(s.vel)).toBeLessThanOrEqual(MAX_SHIP_SPEED * (1 + 1e-12));
    }
    // Thrust is divided by gamma^3: the same burn changes the velocity far less near c.
    const slow = newShipState(wisp);
    stepShip(slow, inp, wisp, EMPTY, DT);
    const fast = newShipState(wisp);
    fast.vel = [0, 0, -0.9 * C];
    stepShip(fast, inp, wisp, EMPTY, DT);
    const dvSlow = -slow.vel[2];
    const dvFast = -fast.vel[2] - 0.9 * C;
    expect(dvFast).toBeGreaterThan(0);
    expect(dvFast).toBeLessThan(dvSlow * 0.05);
  });

  it('dilation combines velocity and gravity and never drops below the floor', () => {
    expect(dilationAt(EMPTY, [0, 0, 0], [0, 0, 0])).toBe(1);
    expect(dilationAt(EMPTY, [0, 0, 0], [0.6 * C, 0, 0])).toBeCloseTo(0.8, 12);
    expect(dilationAt(EMPTY, [0, 0, 0], [2 * C, 0, 0])).toBe(MIN_DILATION);
  });
});

describe('black hole', () => {
  const sys = blackHoleSystem();
  const env = buildStepEnv(sys, FIXTURE_STAR, 0);
  const rs = FIXTURE_BH_RS;
  const at = (r: number): ShipState => ({ ...newShipState(wisp), pos: [0, r, 0] });

  it('has the Schwarzschild radius of ten solar masses', () => {
    expect(rs).toBeCloseTo((2 * G * FIXTURE_BH_MASS) / (C * C), 6);
    expect(rs).toBeGreaterThan(29_000);
    expect(rs).toBeLessThan(30_000);
    expect(env.sources[0]!.rs).toBe(rs);
  });

  it('dilation decreases monotonically toward the hole', () => {
    const radii = [1e9, 1e8, 1e7, 100 * rs, 1e6, 10 * rs, 5 * rs, 3 * rs, 2 * rs, 1.2 * rs, 1.01 * rs];
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1]!);
    let last = 1;
    for (const r of radii) {
      const d = dilationAt(env, [0, r, 0], [0, 0, 0]);
      expect(d).toBeLessThan(last);
      expect(d).toBeGreaterThanOrEqual(MIN_DILATION);
      last = d;
    }
    expect(dilationAt(env, [0, 4 * rs, 0], [0, 0, 0])).toBeCloseTo(Math.sqrt(0.75), 12);
    expect(dilationAt(env, [0, 0.5 * rs, 0], [0, 0, 0])).toBe(MIN_DILATION);
  });

  it('is lethal inside 3 rs and not outside', () => {
    expect(hazardsAt(env, at(COMPACT_KILL_FACTOR * rs * 0.99), wisp).lethal).toBe(true);
    expect(hazardsAt(env, at(rs), wisp).lethal).toBe(true);
    expect(hazardsAt(env, at(0), wisp).lethal).toBe(true);
    expect(hazardsAt(env, at(COMPACT_KILL_FACTOR * rs * 1.01), wisp).lethal).toBe(false);
    expect(hazardsAt(env, at(1e9), wisp).lethal).toBe(false);
  });

  it('tidal stretch and gravity grow as the ship approaches', () => {
    const radii = [1e10, 1e9, 1e8, 1e7, 1e6, 10 * rs, 4 * rs, 3 * rs];
    let lastTidal = 0;
    let lastGravity = 0;
    for (const r of radii) {
      const hz = hazardsAt(env, at(r), wisp);
      expect(hz.tidal).toBeGreaterThan(lastTidal);
      expect(hz.gravity).toBeGreaterThan(lastGravity);
      expect(hz.dominantBody).toBe(FIXTURE_STAR);
      lastTidal = hz.tidal;
      lastGravity = hz.gravity;
    }
    const hz = hazardsAt(env, at(1e7), wisp);
    expect(hz.tidal).toBeCloseTo((2 * G * FIXTURE_BH_MASS * 2 * wisp.radius) / 1e21, 6);
  });

  it('uses GM / (r - rs)^2 and stays finite at and inside the horizon', () => {
    const g = gravityAt(env, [0, 10 * rs, 0]);
    const expected = (G * FIXTURE_BH_MASS) / (81 * rs * rs);
    expect(g[1]).toBeLessThan(0);
    expect(v3.len(g) / expected).toBeCloseTo(1, 9);
    for (const r of [2 * rs, 1.5 * rs, rs, 0.5 * rs, 1, 0]) {
      expect(v3.isFinite(gravityAt(env, [0, r, 0]))).toBe(true);
      const hz = hazardsAt(env, at(r), wisp);
      expect(Number.isFinite(hz.gravity)).toBe(true);
      expect(Number.isFinite(hz.tidal)).toBe(true);
    }
  });

  it('a ship falling into the hole keeps a finite state and a clock that slows down', () => {
    const s = at(40 * rs);
    const inp = input({ buttons: Button.FaOff });
    let slowest = 1;
    for (let i = 0; i < 3000; i++) {
      stepShip(s, inp, wisp, env, DT);
      expect(allFinite(s)).toBe(true);
      expect(v3.len(s.vel)).toBeLessThan(C);
      slowest = Math.min(slowest, s.dilation);
    }
    expect(slowest).toBeLessThan(0.5);
  });
});

describe('cruise', () => {
  it('the speed limit grows with distance from every body', () => {
    const sys = fixtureSystem();
    const env = buildStepEnv(sys, FIXTURE_STAR, 0);
    for (const src of env.sources) {
      // Every fixture orbit lies in the XZ plane, so climbing along +Y recedes from all bodies.
      let last = cruiseSpeedLimit(env, [src.pos[0], src.radius, src.pos[2]], wisp);
      // At the surface the limit is at its lower bound; at a landable body (the moon) that is the
      // ground speed a pilot flies down with, not CRUISE_MIN_SPEED.
      expect(last).toBe(src.surface ? CRUISE_GROUND_MIN_SPEED : CRUISE_MIN_SPEED);
      for (let alt = 1e6; alt < 1e15; alt *= 3) {
        const limit = cruiseSpeedLimit(env, [src.pos[0], src.radius + alt, src.pos[2]], wisp);
        expect(limit).toBeGreaterThanOrEqual(last);
        if (last < wisp.cruiseMax) expect(limit).toBeGreaterThan(last);
        expect(limit).toBeLessThanOrEqual(wisp.cruiseMax);
        last = limit;
      }
      expect(last).toBe(wisp.cruiseMax);
    }
  });

  it('the speed limit vanishes at the lethal radius of a compact object', () => {
    const env = buildStepEnv(blackHoleSystem(), FIXTURE_STAR, 0);
    const edge = COMPACT_KILL_FACTOR * FIXTURE_BH_RS;
    expect(cruiseSpeedLimit(env, [0, edge, 0], wisp)).toBe(CRUISE_MIN_SPEED);
    expect(cruiseSpeedLimit(env, [0, edge + 1e7, 0], wisp)).toBeCloseTo(0.28 * 1e7, 3);
  });

  it('covers 1 AU from near the planet in under 120 simulated seconds, re-anchoring continuously', () => {
    const sys = fixtureSystem();
    const s = newShipState(wisp);
    s.anchor = FIXTURE_PLANET;
    s.pos = [0, 2 * EARTH_RADIUS, 0];
    s.rot = quat.lookRotation([0, 1, 0]);
    engageCruise(s, sys, 0);
    expect(s.mode).toBe(FlightMode.Cruise);
    expect(s.anchor).toBe(FIXTURE_PLANET);

    const start = absolutePosition(s, sys, 0);
    const inp = input({ throttle: 1 });
    let t = 0;
    let reanchors = 0;
    let travelled = 0;
    while (travelled < AU && t < 200) {
      const before = absolutePosition(s, sys, t);
      // The same tick without any re-anchoring, for comparison.
      const twin = cloneState(s);
      stepShip(twin, inp, wisp, buildStepEnv(sys, twin.anchor, t), DT);

      const env = simulateShip(s, inp, wisp, sys, t, DT);
      t += DT;
      const after = absolutePosition(s, sys, t);
      const moved = v3.dist(after, before);
      expect(env.anchor).toBe(s.anchor);
      if (s.anchor !== twin.anchor) {
        reanchors++;
        expect(v3.dist(after, absolutePosition(twin, sys, t))).toBeLessThanOrEqual(1e-3 * moved);
        // Cruise velocity stays "nose times speed" in the new frame.
        expect(v3.dist(s.vel, v3.scale(forwardOf(s.rot), s.cruiseSpeed))).toBeLessThan(1e-6 * s.cruiseSpeed);
        expect(s.cruiseSpeed).toBe(twin.cruiseSpeed);
        expect(s.rot).toEqual(twin.rot);
      } else {
        expect(s.pos).toEqual(twin.pos);
      }
      travelled = v3.dist(after, start);
    }
    expect(travelled).toBeGreaterThanOrEqual(AU);
    expect(t).toBeLessThan(120);
    // Left the planet's sphere of influence exactly once, into the star's frame.
    expect(reanchors).toBe(1);
    expect(s.anchor).toBe(FIXTURE_STAR);
    expect(v3.len(s.vel)).toBeGreaterThan(C);
    // Gravity is ignored in cruise and cruise speed does not dilate time.
    expect(s.dilation).toBe(1);
  });

  it('re-anchors into a sphere of influence on the way in and slows down near the body', () => {
    const sys = fixtureSystem();
    const soi = soiRadius(sys, FIXTURE_PLANET);
    const s = newShipState(wisp);
    // Above the planet's orbital plane, just outside its sphere of influence, nose toward the planet.
    s.anchor = FIXTURE_STAR;
    s.pos = [AU, 3 * soi, 0];
    s.rot = quat.lookRotation([0, -1, 0]);
    engageCruise(s, sys, 0);
    expect(s.anchor).toBe(FIXTURE_STAR);
    const inp = input({ throttle: 1 });
    let t = 0;
    let entered = -1;
    let peak = 0;
    for (let i = 0; i < 120 / DT; i++) {
      simulateShip(s, inp, wisp, sys, t, DT);
      t += DT;
      peak = Math.max(peak, s.cruiseSpeed);
      if (entered < 0 && s.anchor === FIXTURE_PLANET) entered = t;
      expect(s.cruiseSpeed).toBeLessThanOrEqual(cruiseSpeedLimit(buildStepEnv(sys, s.anchor, t), s.pos, wisp) * 1.02);
      if (entered > 0 && s.cruiseSpeed < CRUISE_MIN_SPEED * 1.5) break;
    }
    expect(entered).toBeGreaterThan(0);
    expect(s.anchor).toBe(FIXTURE_PLANET);
    expect(peak).toBeGreaterThan(1e7);
    // At full throttle the proximity limit alone has braked the ship to a crawl above the surface.
    expect(s.cruiseSpeed).toBeLessThan(CRUISE_MIN_SPEED * 1.5);
    const altitude = v3.len(s.pos) - EARTH_RADIUS;
    expect(altitude).toBeGreaterThan(0);
    expect(altitude).toBeLessThan(500_000);
  });

  it('holds minimum speed at zero throttle and turns more slowly than in normal flight', () => {
    const sys = fixtureSystem();
    const s = newShipState(wisp);
    s.anchor = FIXTURE_STAR;
    s.pos = [0, 0.5 * AU, 0];
    s.rot = quat.lookRotation([0, 1, 0]);
    engageCruise(s, sys, 0);
    const fuel = s.fuel;
    let peakRate = 0;
    for (let i = 0; i < 3 / DT; i++) {
      simulateShip(s, input({ aim: [90 * DEG * DT, 0] }), wisp, sys, i * DT, DT);
      peakRate = Math.max(peakRate, Math.abs(s.angVel[1]));
    }
    expect(s.cruiseSpeed).toBe(CRUISE_MIN_SPEED);
    expect(s.fuel).toBe(fuel);
    expect(peakRate).toBeLessThanOrEqual(wisp.turnYaw * CRUISE_TURN_FACTOR * (1 + 1e-9));
    expect(peakRate).toBeGreaterThan(wisp.turnYaw * CRUISE_TURN_FACTOR * 0.95);
  });

  it('burns fuel with throttle and falls back to minimum speed when the tank is empty', () => {
    const sys = fixtureSystem();
    const s = newShipState(wisp);
    s.anchor = FIXTURE_STAR;
    s.pos = [0, 0.5 * AU, 0];
    s.rot = quat.lookRotation([0, 1, 0]);
    engageCruise(s, sys, 0);
    const fuel = s.fuel;
    for (let i = 0; i < 10 / DT; i++) simulateShip(s, input({ throttle: 1 }), wisp, sys, i * DT, DT);
    expect(fuel - s.fuel).toBeCloseTo(CRUISE_FUEL_RATE * 10, 6);
    expect(s.cruiseSpeed).toBeGreaterThan(1e9);

    s.fuel = 0;
    for (let i = 0; i < 20 / DT; i++) simulateShip(s, input({ throttle: 1 }), wisp, sys, 10 + i * DT, DT);
    expect(s.fuel).toBe(0);
    expect(s.cruiseSpeed).toBeLessThan(CRUISE_MIN_SPEED * 1.01);
  });

  it('scoops fuel near a scoopable star only with a scoop fitted', () => {
    const sys = fixtureSystem();
    expect(wayfarer.scoopRate).toBeGreaterThan(0);
    expect(wisp.scoopRate).toBe(0);
    const place = (stats: ShipStats, radii: number): ShipState => {
      const s = newShipState(stats);
      s.mode = FlightMode.Cruise;
      s.anchor = FIXTURE_STAR;
      s.pos = [0, radii * SOLAR_RADIUS, 0];
      // Nose along the tangent, so the distance barely changes during the test.
      s.rot = quat.lookRotation([1, 0, 0]);
      s.cruiseSpeed = CRUISE_MIN_SPEED;
      s.fuel = 1;
      return s;
    };
    const near = place(wayfarer, SCOOP_MAX_RADII - 0.3);
    for (let i = 0; i < 5 / DT; i++) simulateShip(near, input(), wayfarer, sys, i * DT, DT);
    expect(near.fuel).toBeCloseTo(1 + wayfarer.scoopRate * 5, 6);
    // Radiant heat from the corona is what limits how long a ship can stay.
    expect(hazardsAt(buildStepEnv(sys, FIXTURE_STAR, 0), near, wayfarer).heatInflux).toBeGreaterThan(5);

    const far = place(wayfarer, SCOOP_MAX_RADII + 0.3);
    for (let i = 0; i < 5 / DT; i++) simulateShip(far, input(), wayfarer, sys, i * DT, DT);
    expect(far.fuel).toBe(1);

    const noScoop = place(wisp, SCOOP_MAX_RADII - 0.3);
    for (let i = 0; i < 5 / DT; i++) simulateShip(noScoop, input(), wisp, sys, i * DT, DT);
    expect(noScoop.fuel).toBe(1);

    const full = place(wayfarer, SCOOP_MAX_RADII - 0.3);
    full.fuel = wayfarer.fuelCap - 0.01;
    for (let i = 0; i < 5 / DT; i++) simulateShip(full, input(), wayfarer, sys, i * DT, DT);
    expect(full.fuel).toBe(wayfarer.fuelCap);
  });

  it('marks only scoopable bodies in the step environment', () => {
    const env = buildStepEnv(fixtureSystem(), FIXTURE_STAR, 0);
    const flags = env.sources.map((src) => (src as { scoopable?: boolean }).scoopable);
    expect(flags).toEqual([true, false, false]);
  });
});

describe('ship systems', () => {
  it('regenerates energy and, after the delay, shields up to their maximum', () => {
    const s = newShipState(wisp);
    s.energy = 10;
    s.shield = 20;
    s.shieldDelay = 2;
    run(s, input(), wisp, EMPTY, 1);
    expect(s.energy).toBeCloseTo(10 + wisp.energyRegen, 6);
    expect(s.shield).toBe(20);
    run(s, input(), wisp, EMPTY, 2);
    expect(s.shieldDelay).toBe(0);
    expect(s.shield).toBeGreaterThan(20);
    run(s, input(), wisp, EMPTY, 120);
    expect(s.energy).toBe(wisp.energyMax);
    expect(s.shield).toBe(wisp.shieldMax);
  });

  it('sheds heat down to zero in deep space and gains heat close to a star', () => {
    const s = newShipState(wisp);
    s.heat = 30;
    run(s, input(), wisp, EMPTY, 1);
    expect(s.heat).toBeCloseTo(30 - wisp.cooling, 6);
    run(s, input(), wisp, EMPTY, 10);
    expect(s.heat).toBe(0);

    const sys = fixtureSystem();
    const env = buildStepEnv(sys, FIXTURE_STAR, 0);
    const hot = newShipState(wisp);
    hot.mode = FlightMode.Cruise;
    hot.cruiseSpeed = CRUISE_MIN_SPEED;
    hot.pos = [0, 1.5 * SOLAR_RADIUS, 0];
    hot.rot = quat.lookRotation([1, 0, 0]);
    const influx = hazardsAt(env, hot, wisp).heatInflux;
    expect(influx).toBeGreaterThan(wisp.cooling);
    run(hot, input(), wisp, env, 1);
    expect(hot.heat).toBeGreaterThan(0);
    // At 1 AU the influx is far below any hull's cooling.
    const cool = hazardsAt(env, { ...newShipState(wisp), pos: [0, AU, 0] }, wisp).heatInflux;
    expect(cool).toBeGreaterThan(0);
    expect(cool).toBeLessThan(1);
  });

  it('charges the cruise and fold drives to 1 in their charge times', () => {
    const cruise = newShipState(wisp);
    cruise.chargeKind = ChargeKind.Cruise;
    run(cruise, input(), wisp, EMPTY, CRUISE_CHARGE_TIME / 2);
    expect(cruise.charge).toBeCloseTo(0.5, 6);
    run(cruise, input(), wisp, EMPTY, CRUISE_CHARGE_TIME);
    expect(cruise.charge).toBe(1);

    const fold = newShipState(wisp);
    fold.chargeKind = ChargeKind.Fold;
    run(fold, input(), wisp, EMPTY, FOLD_CHARGE_TIME / 2);
    expect(fold.charge).toBeCloseTo(0.5, 6);

    const none = newShipState(wisp);
    run(none, input(), wisp, EMPTY, 2);
    expect(none.charge).toBe(0);
  });

  it('runs only timers and regeneration while docked, folding or dead', () => {
    for (const mode of [FlightMode.Docked, FlightMode.Fold, FlightMode.Dead]) {
      const sys = fixtureSystem();
      const s = newShipState(wisp);
      s.mode = mode;
      s.anchor = mode === FlightMode.Fold ? -1 : FIXTURE_STATION;
      s.vel = [5, 6, 7];
      s.energy = 10;
      s.boostCd = 3;
      const before = cloneState(s);
      const inp = input({ thrust: [1, 1, 1], aim: [0.1, 0.1], roll: 1, throttle: 1, buttons: Button.Boost });
      for (let i = 0; i < 30; i++) simulateShip(s, inp, wisp, sys, i * DT, DT);
      expect(s.pos).toEqual(before.pos);
      expect(s.vel).toEqual(before.vel);
      expect(s.rot).toEqual(before.rot);
      expect(s.mode).toBe(mode);
      expect(s.boost).toBe(0);
      expect(s.energy).toBeCloseTo(10 + wisp.energyRegen, 6);
      expect(s.boostCd).toBeCloseTo(2, 6);
    }
  });

  it('ignores a non-positive or non-finite time step', () => {
    const s = newShipState(wisp);
    s.vel = [10, 0, 0];
    const before = numbers(s);
    for (const dt of [0, -1, NaN, Infinity]) stepShip(s, input({ throttle: 1 }), wisp, EMPTY, dt);
    expect(numbers(s)).toEqual(before);
  });
});

/** Random pilot input, deliberately out of range on every channel. */
function randomInput(rng: Rng, seq: number): ShipInput {
  return {
    seq,
    thrust: [rng.range(-1.5, 1.5), rng.range(-1.5, 1.5), rng.range(-1.5, 1.5)],
    aim: [rng.range(-0.3, 0.3), rng.range(-0.3, 0.3)],
    roll: rng.range(-1.5, 1.5),
    throttle: rng.range(-1.5, 1.5),
    buttons: rng.int(0, 63),
  };
}

/** A scripted flight through the fixture system with random input and occasional mode changes. */
function randomFlight(seed: number, ticks: number, check?: (s: ShipState) => void): ShipState {
  const sys = fixtureSystem();
  const rng = new Rng(seed);
  const s = newShipState(wisp);
  s.anchor = FIXTURE_STATION;
  s.pos = [8000, 500, -2000];
  let inp = randomInput(rng, 0);
  for (let i = 0; i < ticks; i++) {
    const t = i * DT;
    // Inputs change every few ticks, as a pilot's would.
    if (rng.chance(0.3)) inp = randomInput(rng, i);
    if (rng.chance(0.004)) {
      if (s.mode === FlightMode.Normal) engageCruise(s, sys, t);
      else if (s.mode === FlightMode.Cruise) disengageCruise(s, sys, t);
    }
    if (rng.chance(0.002)) s.chargeKind = rng.pick([ChargeKind.None, ChargeKind.Cruise, ChargeKind.Fold]);
    simulateShip(s, inp, wisp, sys, t, DT);
    check?.(s);
  }
  return s;
}

describe('determinism and robustness', () => {
  it('two runs with the same inputs give bit-identical states', () => {
    const a = numbers(randomFlight(1234, 2000));
    const b = numbers(randomFlight(1234, 2000));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);
    // A different seed really does produce a different flight.
    const c = numbers(randomFlight(99, 2000));
    expect(c.some((x, i) => !Object.is(x, a[i]))).toBe(true);
  });

  it('5000 random ticks never produce NaN or Infinity in any state field', () => {
    let modes = 0;
    const end = randomFlight(4242, 5000, (s) => {
      modes |= 1 << s.mode;
      if (!allFinite(s)) throw new Error(`non-finite state: ${JSON.stringify(s)}`);
      expect(Math.abs(s.aim[0])).toBeLessThanOrEqual(AIM_BUFFER_MAX);
      expect(Math.abs(s.aim[1])).toBeLessThanOrEqual(AIM_BUFFER_MAX);
    });
    expect(allFinite(end)).toBe(true);
    // The flight exercised both normal space and cruise.
    expect(modes & (1 << FlightMode.Normal)).not.toBe(0);
    expect(modes & (1 << FlightMode.Cruise)).not.toBe(0);
    expect(Math.hypot(...end.rot)).toBeCloseTo(1, 9);
  });

  it('5000 random ticks next to a black hole stay finite', () => {
    const sys = blackHoleSystem();
    const rng = new Rng(77);
    const s = newShipState(wisp);
    s.pos = [0, 60 * FIXTURE_BH_RS, 0];
    let inp = randomInput(rng, 0);
    for (let i = 0; i < 5000; i++) {
      if (rng.chance(0.3)) inp = randomInput(rng, i);
      const env = simulateShip(s, inp, wisp, sys, i * DT, DT);
      if (!allFinite(s)) throw new Error(`non-finite state: ${JSON.stringify(s)}`);
      const hz = hazardsAt(env, s, wisp);
      expect(Number.isFinite(hz.gravity) && Number.isFinite(hz.tidal) && Number.isFinite(hz.heatInflux)).toBe(true);
      expect(v3.len(s.vel)).toBeLessThan(C);
    }
  });

  it('non-finite input values are treated as neutral', () => {
    const s = newShipState(wisp);
    const bad: ShipInput = { seq: 1, thrust: [NaN, Infinity, -Infinity], aim: [NaN, Infinity], roll: NaN, throttle: NaN, buttons: 0 };
    for (let i = 0; i < 100; i++) stepShip(s, bad, wisp, EMPTY, DT);
    expect(allFinite(s)).toBe(true);
    expect(s.pos).toEqual([0, 0, 0]);
    expect(s.rot).toEqual([0, 0, 0, 1]);
  });
});
