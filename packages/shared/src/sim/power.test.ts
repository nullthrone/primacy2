/**
 * Power distribution, silent running, heat signature and detection in the shared simulation.
 */
import { describe, expect, it } from 'vitest';
import { HULLS, computeShipStats, starterLoadout } from '../catalog.ts';
import { AU, DT, EARTH_RADIUS } from '../constants.ts';
import { v3, type Vec3 } from '../math.ts';
import { decodeSnapshot, encodeSnapshot } from '../snapshot.ts';
import { FIXTURE_PLANET, FIXTURE_STATION, fixtureSystem } from './fixtures.ts';
import {
  DEFAULT_PIPS,
  PIP_MAX,
  PIP_TOTAL,
  addPip,
  engineMul,
  normalizePips,
  packPips,
  shieldDamageMul,
  shieldRegenMul,
  unpackPips,
  weaponEnergyMul,
} from './power.ts';
import { newShipState, simulateShip, stepShip } from './ship.ts';
import {
  DETECT_HYSTERESIS,
  SIG_BOOST,
  SIG_CRUISE,
  SIG_HEAT,
  SIG_HEAT_LIMIT,
  SIG_REF_RADIUS,
  SIG_SHIELDS_DOWN,
  SIG_SILENT,
  SIG_THRUST,
  SILENT_COOLING,
  SILENT_REACTOR_HEAT,
  SILENT_SHIELD_DRAIN,
  VISUAL_RANGE,
  canDetect,
  detectionRange,
  shipSignature,
} from './signature.ts';
import { Button, FlightMode, type ShipInput, type ShipState, type ShipStats, type StepEnv } from './types.ts';

const wisp = computeShipStats(starterLoadout('wisp'));
/** Deep space: no gravity and no star to heat the hull. */
const EMPTY: StepEnv = { t: 0, anchor: 0, sources: [] };

const input = (over: Partial<ShipInput> = {}): ShipInput => ({ seq: 0, thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0, ...over });

function run(s: ShipState, inp: ShipInput, ticks: number, stats: ShipStats = wisp): void {
  for (let i = 0; i < ticks; i++) stepShip(s, inp, stats, EMPTY, DT);
}

describe('power distribution: packing and validation', () => {
  it('packs three shares into one number and back', () => {
    expect(DEFAULT_PIPS).toBe(0x444);
    expect(unpackPips(DEFAULT_PIPS)).toEqual({ sys: 4, eng: 4, wep: 4 });
    expect(packPips(8, 3, 1)).toBe(8 | (3 << 4) | (1 << 8));
    for (let sys = 0; sys <= PIP_MAX; sys++) {
      for (let eng = 0; eng <= PIP_MAX; eng++) {
        const wep = PIP_TOTAL - sys - eng;
        if (wep < 0 || wep > PIP_MAX) continue;
        const packed = packPips(sys, eng, wep);
        expect(unpackPips(packed)).toEqual({ sys, eng, wep });
        expect(normalizePips(packed)).toBe(packed);
      }
    }
  });

  it('turns anything that is not a valid split into the default', () => {
    const bad: unknown[] = [
      undefined, null, '1092', {}, [], true, NaN, Infinity, -1, 1.5, 0, 0x1000, 0x10444,
      packPips(4, 4, 5), // sums to 13
      packPips(4, 4, 3), // sums to 11
      packPips(9, 3, 0), // one share above the limit
      packPips(12, 0, 0),
    ];
    for (const x of bad) expect(normalizePips(x), String(x)).toBe(DEFAULT_PIPS);
  });

  it('moves a pip at a time and never leaves the valid range', () => {
    let p = addPip(DEFAULT_PIPS, 'sys');
    expect(unpackPips(p)).toEqual({ sys: 6, eng: 3, wep: 3 });
    p = addPip(p, 'sys');
    expect(unpackPips(p)).toEqual({ sys: 8, eng: 2, wep: 2 });
    expect(addPip(p, 'sys')).toBe(p);
    expect(unpackPips(addPip(p, 'wep'))).toEqual({ sys: 6, eng: 2, wep: 4 });
    expect(unpackPips(addPip(packPips(8, 4, 0), 'eng'))).toEqual({ sys: 6, eng: 6, wep: 0 });
    expect(addPip(0xfff, 'eng')).toBe(addPip(DEFAULT_PIPS, 'eng'));

    const order = ['sys', 'eng', 'wep'] as const;
    let q = DEFAULT_PIPS;
    for (let i = 0; i < 200; i++) {
      q = addPip(q, order[(i * 7 + (i >> 2)) % 3]!);
      expect(normalizePips(q)).toBe(q);
    }
  });
});

describe('power distribution: effects', () => {
  it('multiplies by exactly one at the default setting', () => {
    expect(engineMul(DEFAULT_PIPS)).toBe(1);
    expect(shieldRegenMul(DEFAULT_PIPS)).toBe(1);
    expect(shieldDamageMul(DEFAULT_PIPS)).toBe(1);
    expect(weaponEnergyMul(DEFAULT_PIPS)).toBe(1);
  });

  it('spans the designed range between no pips and full pips', () => {
    const none = { sys: packPips(0, 6, 6), eng: packPips(6, 0, 6), wep: packPips(6, 6, 0) };
    const full = { sys: packPips(8, 2, 2), eng: packPips(2, 8, 2), wep: packPips(2, 2, 8) };
    expect(engineMul(none.eng)).toBeCloseTo(0.8, 12);
    expect(engineMul(full.eng)).toBeCloseTo(1.2, 12);
    expect(shieldRegenMul(none.sys)).toBeCloseTo(0.5, 12);
    expect(shieldRegenMul(full.sys)).toBeCloseTo(1.5, 12);
    expect(shieldDamageMul(none.sys)).toBeCloseTo(1.15, 12);
    expect(shieldDamageMul(full.sys)).toBeCloseTo(0.85, 12);
    expect(weaponEnergyMul(none.wep)).toBeCloseTo(1.3, 12);
    expect(weaponEnergyMul(full.wep)).toBeCloseTo(0.7, 12);
    // Each multiplier reads only its own share.
    expect(engineMul(full.sys)).toBe(engineMul(full.wep));
    expect(shieldRegenMul(full.eng)).toBe(shieldRegenMul(full.wep));
    expect(weaponEnergyMul(full.sys)).toBe(weaponEnergyMul(full.eng));
  });

  it('copies the applied setting into the ship state, falling back to the default', () => {
    const s = newShipState(wisp);
    expect(s.pips).toBe(DEFAULT_PIPS);
    run(s, input({ pips: packPips(2, 8, 2) }), 1);
    expect(s.pips).toBe(packPips(2, 8, 2));
    run(s, input({ pips: packPips(9, 3, 0) }), 1);
    expect(s.pips).toBe(DEFAULT_PIPS);
    run(s, input({ pips: packPips(0, 4, 8) }), 1);
    run(s, input(), 1);
    expect(s.pips).toBe(DEFAULT_PIPS);
    // Also while the ship is not flying.
    s.mode = FlightMode.Docked;
    run(s, input({ pips: packPips(8, 2, 2) }), 1);
    expect(s.pips).toBe(packPips(8, 2, 2));
  });

  it('ENG scales linear acceleration', () => {
    for (const [eng, mul] of [[0, 0.8], [4, 1], [8, 1.2]] as const) {
      const s = newShipState(wisp);
      run(s, input({ thrust: [0, 0, 1], buttons: Button.FaOff, pips: packPips(6 - eng / 2, eng, 6 - eng / 2) }), 1);
      expect(-s.vel[2]).toBeCloseTo(wisp.accelFwd * mul * DT, 10);
      const side = newShipState(wisp);
      run(side, input({ thrust: [1, 0, 0], buttons: Button.FaOff, pips: packPips(6 - eng / 2, eng, 6 - eng / 2) }), 1);
      expect(side.vel[0]).toBeCloseTo(wisp.accelLat * mul * DT, 10);
    }
  });

  it('ENG scales the flight-assist speed limit and the boost speed', () => {
    for (const [eng, mul] of [[0, 0.8], [4, 1], [8, 1.2]] as const) {
      const pips = packPips(6 - eng / 2, eng, 6 - eng / 2);
      const s = newShipState(wisp);
      run(s, input({ throttle: 1, pips }), 20 / DT);
      expect(v3.len(s.vel)).toBeCloseTo(wisp.maxSpeed * mul, 0);

      let peak = 0;
      for (let i = 0; i < 3 / DT; i++) {
        run(s, input({ throttle: 1, buttons: Button.Boost, pips }), 1);
        peak = Math.max(peak, v3.len(s.vel));
      }
      expect(peak / (wisp.boostSpeed * mul)).toBeGreaterThan(0.97);
      expect(peak / (wisp.boostSpeed * mul)).toBeLessThan(1.001);
    }
  });

  it('SYS scales shield regeneration', () => {
    for (const [sys, mul] of [[0, 0.5], [4, 1], [8, 1.5]] as const) {
      const s = newShipState(wisp);
      s.shield = 0;
      run(s, input({ pips: packPips(sys, 6 - sys / 2, 6 - sys / 2) }), 1);
      expect(s.shield).toBeCloseTo(wisp.shieldRegen * mul * DT, 10);
    }
  });
});

/**
 * Final states of three scripted flights, recorded from the simulation before power distribution
 * and signatures existed. The default setting must reproduce every number bit for bit.
 */
const GOLDEN = {
  wispStation: {
    mode: 0, anchor: 1000,
    pos: [1051.296128632343, -401.13774460152734, -652.5917848664318],
    vel: [12.205818093714985, 10.159141894453063, -22.972464745697348],
    rot: [0.38992158156943924, 0.318636118128586, -0.15641126762812174, 0.8496868245473134],
    angVel: [0, 0.6000000003745393, 0], aim: [-0.029666308936952067, 0],
    fa: true, throttle: -0.5, cruiseSpeed: 0, boost: 0, boostCd: 0, energy: 100, heat: 0, fuel: 8,
    shield: 86.67999999999208, hull: 220, shieldDelay: 0, charge: 0, chargeKind: 0, dilation: 0.9999999999999953,
  },
  bulwarkPlanet: {
    mode: 0, anchor: 1,
    pos: [393.83547430142505, 6770675.604621889, -571.6026921210326],
    vel: [-0.09288605939409281, -45.41328016605562, -5.311177485288086],
    rot: [0.27313895131843463, 0.17367436399286737, -0.07851744773698395, 0.9429036742770751],
    angVel: [0, 0.4014257279586958, 0], aim: [-0.4326369055398402, 0],
    fa: true, throttle: -0.5, cruiseSpeed: 0, boost: 0, boostCd: 0, energy: 330, heat: 0, fuel: 18,
    shield: 541.6479999999736, hull: 1360, shieldDelay: 0, charge: 0, chargeKind: 0, dilation: 0.9999999999999883,
  },
  wayfarerCruise: {
    mode: 1, anchor: 1,
    pos: [2775504.9695969857, 50737178.347648904, -3683115.9623951237],
    vel: [2334419.9093567342, 618849.5486329427, -3070564.7917601084],
    rot: [0.1450212694052632, -0.29319481005613207, -0.18792634614532575, 0.9261151781504836],
    angVel: [0, 0, 0], aim: [0, 0],
    fa: true, throttle: 0.5, cruiseSpeed: 3906514.9708456383, boost: 0, boostCd: 0, energy: 160, heat: 0, fuel: 31.998800000000045,
    shield: 56.800000000000125, hull: 340, shieldDelay: 0, charge: 0, chargeKind: 0, dilation: 1,
  },
};

/** The scripted pilot of the golden flights: thrust, boost, flight assist off, braking, reverse. */
function script(i: number, pips?: number): ShipInput {
  const inp = input({ seq: i });
  if (pips !== undefined) inp.pips = pips;
  if (i < 60) {
    inp.thrust = [0, 0, 1];
    inp.aim = [0.01, 0.005];
    inp.roll = 0.2;
  } else if (i < 120) {
    inp.thrust = [0.5, -0.3, 1];
    inp.throttle = 0.5;
    inp.buttons = Button.Boost;
  } else if (i < 180) {
    inp.thrust = [-1, 0.4, -0.6];
    inp.buttons = Button.FaOff;
    inp.aim = [-0.004, 0.002];
  } else if (i < 240) {
    inp.buttons = Button.Brake;
  } else {
    inp.throttle = -0.5;
    inp.aim = [-0.02, 0];
  }
  return inp;
}

function fly(hull: string, anchor: number, pos: Vec3, mode: FlightMode, ticks: number, pips?: number, buttons = 0): ShipState {
  const stats = computeShipStats(starterLoadout(hull));
  const sys = fixtureSystem();
  const s = newShipState(stats);
  s.mode = mode;
  s.anchor = anchor;
  s.pos = pos;
  s.shield = 10;
  s.shieldDelay = 0.5;
  s.heat = 40;
  let t = 1000;
  for (let i = 0; i < ticks; i++) {
    const inp = script(i, pips);
    inp.buttons |= buttons;
    simulateShip(s, inp, stats, sys, t, DT);
    t += DT;
  }
  return s;
}

const FLIGHTS: Record<keyof typeof GOLDEN, [string, number, Vec3, FlightMode, number]> = {
  wispStation: ['wisp', FIXTURE_STATION, [500, -200, 300], FlightMode.Normal, 300],
  bulwarkPlanet: ['bulwark', FIXTURE_PLANET, [0, EARTH_RADIUS + 400e3, 0], FlightMode.Normal, 300],
  wayfarerCruise: ['wayfarer', FIXTURE_PLANET, [0, 5e7, 0], FlightMode.Cruise, 120],
};

describe('power distribution: the default changes nothing', () => {
  for (const name of Object.keys(GOLDEN) as (keyof typeof GOLDEN)[]) {
    it(`reproduces the recorded flight "${name}" exactly`, () => {
      const [hull, anchor, pos, mode, ticks] = FLIGHTS[name];
      // Without a setting in the input, and with the default spelled out.
      for (const pips of [undefined, DEFAULT_PIPS]) {
        const s = fly(hull, anchor, [...pos], mode, ticks, pips);
        expect(s.pips).toBe(DEFAULT_PIPS);
        const { pips: _pips, sig: _sig, ...old } = s;
        // Through JSON, as the numbers were recorded; every finite double survives that unchanged.
        expect(JSON.parse(JSON.stringify(old))).toEqual(GOLDEN[name]);
      }
    });
  }

  it('really flies differently with another setting or with silent running', () => {
    const [hull, anchor, pos, mode, ticks] = FLIGHTS.wispStation;
    const base = fly(hull, anchor, [...pos], mode, ticks);
    const eng = fly(hull, anchor, [...pos], mode, ticks, packPips(2, 8, 2));
    expect(v3.dist(eng.pos, base.pos)).toBeGreaterThan(10);
    // Power moved between shields and weapons leaves the flight itself untouched.
    const sys = fly(hull, anchor, [...pos], mode, ticks, packPips(8, 4, 0));
    expect(sys.pos).toEqual(base.pos);
    expect(sys.shield).toBeGreaterThan(base.shield + 10);
    const silent = fly(hull, anchor, [...pos], mode, ticks, undefined, Button.Silent);
    expect(silent.pos).toEqual(base.pos);
    expect(silent.shield).toBe(0);
    expect(silent.heat).toBeGreaterThan(40);
  });

  it('is deterministic, also when replayed from a copy of an intermediate state', () => {
    const stats = wisp;
    const sys = fixtureSystem();
    const inputs = (i: number): ShipInput => {
      const inp = script(i, i % 90 < 45 ? packPips(2, 8, 2) : packPips(7, 1, 4));
      if (i % 70 > 40) inp.buttons |= Button.Silent;
      return inp;
    };
    const a = newShipState(stats);
    a.anchor = FIXTURE_STATION;
    let copy: ShipState | null = null;
    for (let i = 0; i < 300; i++) {
      if (i === 137) copy = { ...a, pos: [...a.pos], vel: [...a.vel], rot: [...a.rot], angVel: [...a.angVel], aim: [...a.aim] };
      simulateShip(a, inputs(i), stats, sys, 1000 + i * DT, DT);
    }
    const b = copy!;
    for (let i = 137; i < 300; i++) simulateShip(b, inputs(i), stats, sys, 1000 + i * DT, DT);
    expect(b).toEqual(a);
    // The replay also works from a state that went through a snapshot.
    const viaWire = decodeSnapshot(encodeSnapshot({ tick: 1, ackSeq: 1, time: 0, self: a, ents: [] }))!.self!;
    expect(viaWire).toEqual(a);
  });
});

describe('silent running', () => {
  const silent = input({ buttons: Button.Silent });

  it('takes the shields offline: they drain, stay down and restart only after the full delay', () => {
    const s = newShipState(wisp);
    run(s, silent, 1 / DT);
    expect(s.shield).toBeCloseTo(wisp.shieldMax * (1 - SILENT_SHIELD_DRAIN), 6);
    run(s, silent, 1.2 / DT);
    expect(s.shield).toBe(0);
    run(s, silent, 10 / DT);
    expect(s.shield).toBe(0);
    expect(s.shieldDelay).toBe(wisp.shieldDelay);

    run(s, input(), (wisp.shieldDelay - 0.2) / DT);
    expect(s.shield).toBe(0);
    run(s, input(), 0.5 / DT);
    expect(s.shield).toBeGreaterThan(0);
  });

  it('closes the radiators: heat builds up where an open ship stays cold', () => {
    const s = newShipState(wisp);
    run(s, silent, 10 / DT);
    const rate = wisp.energyRegen * SILENT_REACTOR_HEAT - wisp.cooling * SILENT_COOLING;
    expect(rate).toBeGreaterThan(0);
    expect(s.heat).toBeCloseTo(rate * 10, 6);

    const open = newShipState(wisp);
    run(open, input(), 10 / DT);
    expect(open.heat).toBe(0);
    // Opening the radiators again sheds the stored heat at the normal rate.
    run(s, input(), 1 / DT);
    expect(s.heat).toBeCloseTo(rate * 10 - wisp.cooling, 6);
  });

  it('cannot be held forever on any hull, and lasts a useful while on each', () => {
    for (const id of Object.keys(HULLS)) {
      const stats = computeShipStats(starterLoadout(id));
      const rate = stats.energyRegen * SILENT_REACTOR_HEAT - stats.cooling * SILENT_COOLING;
      expect(rate, id).toBeGreaterThan(0);
      const seconds = stats.heatCap / rate;
      expect(seconds, id).toBeGreaterThan(20);
      expect(seconds, id).toBeLessThan(200);
    }
  });

  it('cuts the signature sharply', () => {
    const open = newShipState(wisp);
    run(open, input(), 1);
    const dark = newShipState(wisp);
    run(dark, silent, 1);
    expect(dark.sig).toBeLessThan(open.sig * 0.1);
    expect(dark.sig).toBeGreaterThan(0);
    // Once the shields are gone it is lower still, then creeps up with the stored heat.
    run(dark, silent, 3 / DT);
    const cold = dark.sig;
    expect(cold).toBeCloseTo((wisp.radius / SIG_REF_RADIUS) * (SIG_SHIELDS_DOWN + (SIG_HEAT * dark.heat) / wisp.heatCap) * SIG_SILENT, 10);
    run(dark, silent, 30 / DT);
    expect(dark.sig).toBeGreaterThan(cold);
    expect(dark.sig).toBeLessThan(open.sig * 0.25);
  });

  it('does nothing to a ship that is not flying', () => {
    for (const mode of [FlightMode.Docked, FlightMode.Dead, FlightMode.Fold]) {
      const s = newShipState(wisp);
      s.mode = mode;
      run(s, silent, 5 / DT);
      expect(s.shield).toBe(wisp.shieldMax);
      expect(s.heat).toBe(0);
      expect(s.sig).toBe(0);
    }
  });
});

describe('heat signature', () => {
  it('is 1 for a reference-sized ship idling with shields up, and scales with hull size', () => {
    const ref = { ...wisp, radius: SIG_REF_RADIUS };
    expect(shipSignature(newShipState(ref), ref, 0, false)).toBe(1);
    expect(newShipState(wisp).sig).toBe(wisp.radius / SIG_REF_RADIUS);
    const s = newShipState(wisp);
    run(s, input(), 30);
    expect(s.sig).toBe(wisp.radius / SIG_REF_RADIUS);
    const bulwark = computeShipStats(starterLoadout('bulwark'));
    expect(newShipState(bulwark).sig).toBeGreaterThan(2 * newShipState(wisp).sig);
  });

  it('rises with thrust and falls back when the ship coasts', () => {
    const size = wisp.radius / SIG_REF_RADIUS;
    const s = newShipState(wisp);
    run(s, input({ thrust: [0, 0, 1], buttons: Button.FaOff }), 1);
    expect(s.sig).toBeCloseTo(size * (1 + SIG_THRUST), 10);
    // Half thrust, and extra engine power.
    run(s, input({ thrust: [0, 0, 0.5], buttons: Button.FaOff }), 1);
    expect(s.sig).toBeCloseTo(size * (1 + SIG_THRUST * 0.5), 10);
    run(s, input({ thrust: [0, 0, 1], buttons: Button.FaOff, pips: packPips(2, 8, 2) }), 1);
    expect(s.sig).toBeCloseTo(size * (1 + SIG_THRUST * 1.2), 10);
    // Flight assist off and hands off the stick: no thrust at all, whatever the speed.
    run(s, input({ buttons: Button.FaOff }), 1);
    expect(s.sig).toBe(size);

    // With flight assist the engines burn while the ship accelerates and go quiet at speed.
    const fa = newShipState(wisp);
    run(fa, input({ throttle: 1 }), 1);
    expect(fa.sig).toBeCloseTo(size * (1 + SIG_THRUST), 10);
    run(fa, input({ throttle: 1 }), 20 / DT);
    expect(fa.sig).toBeLessThan(size * 1.01);
  });

  it('rises further with boost', () => {
    const size = wisp.radius / SIG_REF_RADIUS;
    const s = newShipState(wisp);
    run(s, input({ throttle: 1, buttons: Button.Boost }), 1);
    expect(s.boost).toBeGreaterThan(0);
    expect(s.sig).toBeCloseTo(size * (1 + SIG_THRUST * wisp.boostAccel + SIG_BOOST), 10);
    // The burning boost shows even when the thrusters have nothing left to do.
    const coasting = newShipState(wisp);
    coasting.boost = 1;
    expect(shipSignature(coasting, wisp, 0, false)).toBe(size * (1 + SIG_BOOST));
  });

  it('rises with heat and drops when the shields are down', () => {
    const size = wisp.radius / SIG_REF_RADIUS;
    const s = newShipState(wisp);
    s.heat = wisp.heatCap / 2;
    expect(shipSignature(s, wisp, 0, false)).toBeCloseTo(size * (1 + SIG_HEAT * 0.5), 12);
    s.heat = wisp.heatCap * 10;
    expect(shipSignature(s, wisp, 0, false)).toBeCloseTo(size * (1 + SIG_HEAT * SIG_HEAT_LIMIT), 12);
    s.heat = 0;
    s.shield = 0;
    expect(shipSignature(s, wisp, 0, false)).toBe(size * SIG_SHIELDS_DOWN);
    expect(shipSignature(s, wisp, 0, true)).toBe(size * SIG_SHIELDS_DOWN * SIG_SILENT);
  });

  it('lights up the whole system in cruise', () => {
    const sys = fixtureSystem();
    const s = newShipState(wisp);
    s.mode = FlightMode.Cruise;
    s.anchor = FIXTURE_PLANET;
    s.pos = [0, 5e7, 0];
    simulateShip(s, input({ throttle: 1, buttons: Button.Silent }), wisp, sys, 1000, DT);
    expect(s.sig).toBe(SIG_CRUISE);
    expect(canDetect(wisp, 100 * AU, s.sig)).toBe(true);
  });
});

describe('detection', () => {
  const sensors = { sensorRange: 12_000 };

  it('reaches sensorRange * sqrt(signature)', () => {
    expect(detectionRange(sensors, 1)).toBe(12_000);
    expect(detectionRange(sensors, 4)).toBe(24_000);
    expect(detectionRange(sensors, 0.25)).toBe(6_000);
    expect(detectionRange({ sensorRange: 32_000 }, 0.25)).toBe(16_000);

    expect(canDetect(sensors, 12_000, 1)).toBe(true);
    expect(canDetect(sensors, 12_000.01, 1)).toBe(false);
    expect(canDetect(sensors, 23_999, 4)).toBe(true);
    expect(canDetect(sensors, 24_001, 4)).toBe(false);
    expect(canDetect(sensors, 0, 1)).toBe(true);
  });

  it('always sees what is within visual range', () => {
    for (const sig of [0, 1e-6, 0.01, NaN, -1, undefined as unknown as number]) {
      expect(detectionRange(sensors, sig)).toBe(VISUAL_RANGE);
      expect(canDetect(sensors, VISUAL_RANGE, sig)).toBe(true);
      expect(canDetect(sensors, VISUAL_RANGE + 0.01, sig)).toBe(false);
    }
    expect(canDetect({ sensorRange: 0 }, VISUAL_RANGE, 1)).toBe(true);
    // Just above the signature whose sensor range equals the visual range, sensors take over.
    const edge = (VISUAL_RANGE / sensors.sensorRange) ** 2;
    expect(detectionRange(sensors, edge * 1.21)).toBeCloseTo(VISUAL_RANGE * 1.1, 6);
  });

  it('keeps a known contact a little farther out', () => {
    expect(DETECT_HYSTERESIS).toBeGreaterThan(1.05);
    expect(DETECT_HYSTERESIS).toBeLessThan(1.15);
    const edge = 12_000 * DETECT_HYSTERESIS;
    expect(canDetect(sensors, edge - 1, 1)).toBe(false);
    expect(canDetect(sensors, edge - 1, 1, true)).toBe(true);
    expect(canDetect(sensors, edge + 1, 1, true)).toBe(false);
    expect(canDetect(sensors, VISUAL_RANGE * DETECT_HYSTERESIS - 1, 0, true)).toBe(true);
  });

  it('never hides a ship that is not running silent from standard sensors at fighting distance', () => {
    // NPCs acquire targets out to 8 km and missiles fly 7 km: the dimmest open ship (cold,
    // idle, shields down) must still be picked up there by the basic 12 km sensor suite.
    for (const id of Object.keys(HULLS)) {
      const stats = computeShipStats(starterLoadout(id));
      const s = newShipState(stats);
      s.shield = 0;
      expect(detectionRange(sensors, shipSignature(s, stats, 0, false)), id).toBeGreaterThan(8_000 * DETECT_HYSTERESIS);
      // The same ship running silent is lost well inside that distance but not at point-blank range.
      const dark = detectionRange(sensors, shipSignature(s, stats, 0, true));
      expect(dark, id).toBeLessThan(5_000);
      expect(dark, id).toBeGreaterThan(VISUAL_RANGE);
    }
  });
});

describe('snapshot: own power setting and signature', () => {
  it('carries both with the own ship state', () => {
    const self = newShipState(wisp);
    self.pips = packPips(8, 2, 2);
    self.sig = 2.625;
    const out = decodeSnapshot(encodeSnapshot({ tick: 5, ackSeq: 9, time: 1.5, self, ents: [] }))!;
    expect(out.self).toEqual(self);
    expect(out.self!.pips).toBe(packPips(8, 2, 2));
    expect(out.self!.sig).toBe(2.625);
  });

  it('sends defaults for a state saved before the fields existed', () => {
    const legacy = newShipState(wisp) as Partial<ShipState>;
    delete legacy.pips;
    delete legacy.sig;
    const out = decodeSnapshot(encodeSnapshot({ tick: 5, ackSeq: 9, time: 1.5, self: legacy as ShipState, ents: [] }))!;
    expect(out.self!.pips).toBe(DEFAULT_PIPS);
    expect(out.self!.sig).toBe(0);
  });
});
