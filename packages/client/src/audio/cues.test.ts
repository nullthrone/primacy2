import { readFileSync } from 'node:fs';
import { Button, EntityKind, FlightMode, type GameEvent, type Vec3 } from '@primacy2/shared';
import { describe, expect, it } from 'vitest';
import type { FrameView } from '../contracts.ts';
import { CUE_EVENTS, cue, directionOf, engineAsk, hitStrength, initialCueState, tickInterval, TUNING, type CueState, type Mix } from './cues.ts';

/** Every event any mix of a test run asked for, to hold against `CUE_EVENTS`. */
const seen = new Set<string>();
const record = (m: Mix): void => {
  for (const k of [...Object.keys(m.loops), ...Object.keys(m.holds), ...m.shots.map((x) => x.event)]) seen.add(k);
};

/** The parts of a frame view the mapping reads; everything else is left out. */
interface Frame {
  clock?: number;
  dt?: number;
  mode?: FlightMode;
  /** `[right, up, forward]` */
  thrust?: [number, number, number];
  throttle?: number;
  buttons?: number;
  boosting?: boolean;
  speed?: number;
  /** False for a view without the pilot's ship (docked, fold tunnel, destroyed). */
  self?: boolean;
  events?: GameEvent[];
  /** 0 none, 1 cruise, 2 fold. */
  chargeKind?: number;
  heat?: number;
  /** Shares of the maximum, 0..1. */
  hull?: number;
  shield?: number;
  fuel?: number;
  /** Other ships and missiles: position relative to the pilot's ship in the ship's own axes (nose -Z, right +X), and velocity. */
  ents?: { id: number; kind?: number; at: Vec3; vel?: Vec3 }[];
  targetId?: number | null;
  /** Over the ground of a landable body: height in metres and vertical speed (negative sinking). */
  ground?: { height: number; verticalSpeed: number; groundSpeed?: number };
  weapons?: { kind: 'pulse' | 'beam' | 'cannon' | 'missile' | 'mining'; offset?: Vec3 }[];
}

const SELF = 1;
const HULL_MAX = 200;
const SHIELD_MAX = 100;
const FUEL_CAP = 10;

/**
 * A view with the ship at the origin of the zone, the camera in it and no rotation anywhere: the
 * ship's own axes, the zone's axes and system axes are the same, so a point `[x, 0, -z]` is x
 * metres to the right and z metres ahead.
 */
function frame(f: Frame = {}): FrameView {
  const mode = f.mode ?? FlightMode.Normal;
  const self = f.self ?? (mode === FlightMode.Normal || mode === FlightMode.Cruise || mode === FlightMode.Landed);
  const placed = mode === FlightMode.Normal || mode === FlightMode.Landed;
  return {
    clock: f.clock ?? 0,
    dt: f.dt ?? 1 / 60,
    mode,
    events: f.events ?? [],
    fx: { cruise: 0, charge: 0, chargeKind: f.chargeKind ?? 0, fold: 0, dilation: 1, heat: f.heat ?? 0, boosting: f.boosting ?? false, hitFlash: 0 },
    zone: placed ? [0, 0, 0] : null,
    zoneRot: placed ? [0, 0, 0, 1] : null,
    targetId: f.targetId ?? null,
    ents: (f.ents ?? []).map((e) => ({ id: e.id, info: { id: e.id, kind: e.kind ?? EntityKind.Ship }, rel: e.at, vel: e.vel ?? [0, 0, 0] })),
    surface: f.ground
      ? { ship: { height: f.ground.height, verticalSpeed: f.ground.verticalSpeed, groundSpeed: f.ground.groundSpeed ?? 0, landed: mode === FlightMode.Landed } }
      : null,
    self: self
      ? {
        id: SELF,
        rel: [0, 0, 0],
        rot: [0, 0, 0, 1],
        vel: [0, 0, -(f.speed ?? 0)],
        input: { seq: 0, thrust: f.thrust ?? [0, 0, 0], aim: [0, 0], roll: 0, throttle: f.throttle ?? 0, buttons: f.buttons ?? 0 },
        state: { hull: (f.hull ?? 1) * HULL_MAX, shield: (f.shield ?? 1) * SHIELD_MAX, fuel: (f.fuel ?? 1) * FUEL_CAP },
        stats: {
          hullMax: HULL_MAX, shieldMax: SHIELD_MAX, fuelCap: FUEL_CAP,
          weapons: (f.weapons ?? []).map((w) => ({ kind: w.kind, offset: w.offset ?? [0, 0, 0] })),
        },
      }
      : null,
  } as unknown as FrameView;
}

/** Runs frames one after the other at 60 per second and returns every mix. */
function run(frames: Frame[], start: CueState = initialCueState(), rand: () => number = () => 0.5): { mixes: Mix[]; state: CueState } {
  let state = start;
  const mixes: Mix[] = [];
  frames.forEach((f, i) => {
    const r = cue(state, frame({ clock: i / 60, ...f }), rand);
    state = r.state;
    mixes.push(r.mix);
    record(r.mix);
  });
  return { mixes, state };
}

const repeat = (n: number, f: Frame): Frame[] => Array.from({ length: n }, () => ({ ...f }));
const pulses = (mixes: Mix[]): number => mixes.reduce((n, m) => n + m.shots.filter((s) => s.event === 'thruster_pulse_c').length, 0);

describe('nothing to hear', () => {
  it('is silent without a view, and the state starts over', () => {
    const { state } = run(repeat(30, { thrust: [0, 0, 1] }));
    const r = cue(state, null, () => 0);
    expect(r.mix).toEqual({ engine: null, loops: {}, holds: {}, shots: [] });
    expect(r.state).toEqual(initialCueState());
  });

  it('a destroyed ship has no cabin and no engine', () => {
    const { mix } = cue(initialCueState(), frame({ mode: FlightMode.Dead }), () => 0);
    expect(mix).toEqual({ engine: null, loops: {}, holds: {}, shots: [] });
  });
});

describe('the cabin', () => {
  it('sounds wherever the pilot sits in the ship: flying, cruising, landed, docked, in the fold tunnel', () => {
    for (const mode of [FlightMode.Normal, FlightMode.Cruise, FlightMode.Landed, FlightMode.Docked, FlightMode.Fold]) {
      expect(cue(initialCueState(), frame({ mode }), () => 0).mix.loops, `mode ${mode}`).toMatchObject({ cabin_ambience_loop: 1 });
    }
  });

  it('silent running takes the fan away', () => {
    const { mix } = cue(initialCueState(), frame({ buttons: Button.Silent }), () => 0);
    expect(mix.loops.silent_running_loop).toBe(1);
    expect(mix.loops.cabin_ambience_loop).toBeUndefined();
  });
});

describe('the main engines', () => {
  it('idle with no thrust asked for', () => {
    expect(cue(initialCueState(), frame(), () => 0).mix.engine).toEqual({ thrust: 0, gain: 1 });
  });

  it('are off without the ship: docked and in the fold tunnel', () => {
    expect(cue(initialCueState(), frame({ mode: FlightMode.Docked }), () => 0).mix.engine).toBeNull();
    expect(cue(initialCueState(), frame({ mode: FlightMode.Fold }), () => 0).mix.engine).toBeNull();
  });

  it('are asked by the forward axis and the throttle, whichever is more, in both directions', () => {
    expect(engineAsk(frame({ thrust: [0, 0, 1] }))).toBe(1);
    expect(engineAsk(frame({ thrust: [0, 0, -1] }))).toBe(1);
    expect(engineAsk(frame({ throttle: 0.5 }))).toBe(0.5);
    expect(engineAsk(frame({ throttle: -0.3, thrust: [0, 0, 0.6] }))).toBe(0.6);
  });

  it('are not asked by sideways or vertical thrust: that is the thrusters', () => {
    expect(engineAsk(frame({ thrust: [1, 1, 0] }))).toBe(0);
  });

  it('go beyond full thrust while the boost runs', () => {
    expect(engineAsk(frame({ boosting: true }))).toBe(TUNING.boost);
  });

  it('work against the motion while the brake is held and the ship moves', () => {
    expect(engineAsk(frame({ buttons: Button.Brake, speed: 80 }))).toBe(TUNING.brake);
    expect(engineAsk(frame({ buttons: Button.Brake, speed: 0 }))).toBe(0);
  });

  it('idle in cruise and on the ground, whatever the throttle says', () => {
    expect(engineAsk(frame({ mode: FlightMode.Cruise, throttle: 1 }))).toBe(0);
    expect(engineAsk(frame({ mode: FlightMode.Landed, throttle: 1 }))).toBe(0);
  });

  it('follow a step with a spool time and arrive', () => {
    const { mixes } = run([...repeat(5, {}), ...repeat(180, { thrust: [0, 0, 1] })]);
    const t = mixes.map((m) => m.engine?.thrust ?? -1);
    expect(t[4]).toBe(0);
    expect(t[6]).toBeGreaterThan(0);
    expect(t[6]).toBeLessThan(0.2);
    // After one time constant about 63 % of the way.
    expect(t[5 + Math.round(TUNING.spoolUp * 60)]).toBeGreaterThan(0.55);
    expect(t[5 + Math.round(TUNING.spoolUp * 60)]).toBeLessThan(0.72);
    for (let i = 6; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    expect(t[t.length - 1]).toBe(1);
  });

  it('take the setting at once on the first frame and after a long pause', () => {
    expect(cue(initialCueState(), frame({ thrust: [0, 0, 1] }), () => 0).mix.engine?.thrust).toBe(1);
    const { state } = run(repeat(10, {}));
    expect(cue(state, frame({ clock: 20, thrust: [0, 0, 1] }), () => 0).mix.engine?.thrust).toBe(1);
  });
});

describe('the manoeuvring thrusters', () => {
  it('give one pulse when sideways thrust sets in, and burn while it is held', () => {
    const { mixes } = run([...repeat(10, {}), ...repeat(60, { thrust: [1, 0, 0] }), ...repeat(10, {})]);
    expect(pulses(mixes)).toBe(1);
    expect(mixes[10].shots).toEqual([{ event: 'thruster_pulse_c', pick: 0.5, maxVoices: TUNING.pulseVoices }]);
    expect(mixes[9].loops.thruster_burn_loop).toBeUndefined();
    expect(mixes[10].loops.thruster_burn_loop).toBe(1);
    expect(mixes[69].loops.thruster_burn_loop).toBe(1);
    expect(mixes[70].loops.thruster_burn_loop).toBeUndefined();
  });

  it('the same for vertical thrust, and forward thrust gives none', () => {
    expect(pulses(run([...repeat(5, {}), ...repeat(30, { thrust: [0, -1, 0] })]).mixes)).toBe(1);
    const fwd = run([...repeat(5, {}), ...repeat(30, { thrust: [0, 0, 1] })]).mixes;
    expect(pulses(fwd)).toBe(0);
    expect(fwd[20].loops.thruster_burn_loop).toBeUndefined();
  });

  it('a second pulse comes no sooner than the spacing', () => {
    const tap = [...repeat(6, { thrust: [1, 0, 0] }), ...repeat(6, {})];
    const taps = Array.from({ length: 20 }, () => tap).flat();
    const { mixes } = run([...repeat(5, {}), ...taps]);
    const at = mixes.flatMap((m, i) => (m.shots.length ? [i / 60] : []));
    expect(at.length).toBeGreaterThan(1);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(TUNING.pulseSpacing - 1e-9);
    // Twenty taps in four seconds give four pulses at most.
    expect(at.length).toBeLessThanOrEqual(4);
  });

  it('turning the thrust round is a new pulse, once the spacing has passed', () => {
    const { mixes } = run([...repeat(5, {}), ...repeat(90, { thrust: [1, 0, 0] }), ...repeat(30, { thrust: [-1, 0, 0] })]);
    expect(pulses(mixes)).toBe(2);
    expect(mixes[95].shots.length).toBe(1);
  });

  it('a stick that rests a little off centre is not thrust', () => {
    const { mixes } = run(repeat(60, { thrust: [0.1, 0.05, 0] }));
    expect(pulses(mixes)).toBe(0);
    expect(mixes[30].loops.thruster_burn_loop).toBeUndefined();
  });

  it('the burn follows how far the stick is pushed', () => {
    const { mixes } = run([...repeat(5, {}), ...repeat(10, { thrust: [0.5, 0, 0] })]);
    expect(mixes[10].loops.thruster_burn_loop).toBeCloseTo(0.5);
  });

  it('do nothing in cruise', () => {
    const { mixes } = run([...repeat(5, { mode: FlightMode.Cruise }), ...repeat(30, { mode: FlightMode.Cruise, thrust: [1, 1, 0] })]);
    expect(pulses(mixes)).toBe(0);
    expect(mixes[20].loops.thruster_burn_loop).toBeUndefined();
  });

  it('thrust that is already held when the view appears starts no pulse', () => {
    expect(pulses(run(repeat(30, { thrust: [1, 0, 0] })).mixes)).toBe(0);
    // After a pause between two frames (the tab was hidden) neither.
    const { state } = run(repeat(10, {}));
    expect(cue(state, frame({ clock: 30, thrust: [1, 0, 0] }), () => 0).mix.shots).toEqual([]);
  });

  it('the variant comes from the random source that is handed in', () => {
    const { mixes } = run([...repeat(5, {}), ...repeat(5, { thrust: [1, 0, 0] })], initialCueState(), () => 0.875);
    expect(mixes[5].shots[0].pick).toBe(0.875);
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers of the blocks below.

const ev = (e: Record<string, unknown>): GameEvent => e as unknown as GameEvent;
const hit = (dmg: number, at: Vec3 = [0, 0, -10], o: { shield?: boolean; id?: number } = {}): GameEvent => ev({ e: 'hit', id: o.id ?? SELF, dmg, shield: o.shield ?? false, at });
const shotEv = (from: number, slot = 0, w = 'x'): GameEvent => ev({ e: 'shot', from, slot, w });
const names = (m: Mix): string[] => m.shots.map((s) => s.event);
const shotsOf = (m: Mix, event: string) => m.shots.filter((s) => s.event === event);
/** A quiet frame, then `f`: the mix of `f`. */
const second = (f: Frame, before: Frame = {}): Mix => run([before, f]).mixes[1];
/** `n` frames `step` seconds apart, with explicit clocks. */
const stepped = (n: number, step: number, f: (i: number, t: number) => Frame): Frame[] => Array.from({ length: n }, (_, i) => ({ clock: i * step, ...f(i, i * step) }));
const WEAPONS: NonNullable<Frame['weapons']> = [
  { kind: 'pulse' }, { kind: 'cannon' }, { kind: 'missile', offset: [1, 0, 0] }, { kind: 'missile', offset: [-1, 0, 0] },
  { kind: 'missile' }, { kind: 'beam' }, { kind: 'mining' },
];

describe('the drives', () => {
  it('cruise sounds a loop while the mode is cruise', () => {
    const { mixes } = run([{}, ...repeat(3, { mode: FlightMode.Cruise }), {}]);
    expect(mixes[0].loops.cruise_loop).toBeUndefined();
    expect(mixes[2].loops.cruise_loop).toBe(1);
    expect(mixes[4].loops.cruise_loop).toBeUndefined();
  });

  it('engaging the cruise from normal flight is one shot, disengaging another', () => {
    const { mixes } = run([{}, { mode: FlightMode.Cruise }, { mode: FlightMode.Cruise }, {}]);
    expect(names(mixes[1])).toEqual(['cruise_engage']);
    expect(names(mixes[2])).toEqual([]);
    expect(names(mixes[3])).toEqual(['cruise_disengage']);
  });

  it('the jump takes the cruise away without a disengage', () => {
    const m = second({ mode: FlightMode.Fold }, { mode: FlightMode.Cruise });
    expect(names(m)).toEqual(['fold_jump']);
  });

  it('a fold jump from any mode is one shot, and the tunnel loops while it lasts', () => {
    for (const mode of [FlightMode.Normal, FlightMode.Cruise, FlightMode.Docked, FlightMode.Landed]) {
      const { mixes } = run([{ mode }, { mode: FlightMode.Fold }, { mode: FlightMode.Fold }]);
      expect(names(mixes[1]), `from ${mode}`).toContain('fold_jump');
      expect(names(mixes[2])).toEqual([]);
      expect(mixes[2].loops.fold_tunnel_loop).toBe(1);
    }
  });

  it('leaving the fold tunnel for normal flight is the exit', () => {
    const m = second({}, { mode: FlightMode.Fold });
    expect(names(m)).toEqual(['fold_exit']);
    expect(m.loops.fold_tunnel_loop).toBeUndefined();
  });

  it('no drive shot on the very first frame', () => {
    for (const mode of [FlightMode.Cruise, FlightMode.Fold]) expect(run([{ mode }]).mixes[0].shots).toEqual([]);
  });

  it('no drive shot after a pause longer than the gap', () => {
    const m = run([{ clock: 0 }, { clock: TUNING.gap + 0.1, mode: FlightMode.Cruise }]).mixes[1];
    expect(m.shots).toEqual([]);
    expect(m.loops.cruise_loop).toBe(1);
  });
});

describe('the charges', () => {
  it('are held while they charge, each by its kind', () => {
    expect(second({ chargeKind: 1 }, { chargeKind: 1 }).holds).toEqual({ cruise_charge: 1 });
    expect(second({ chargeKind: 2 }, { chargeKind: 2 }).holds).toEqual({ fold_charge: 1 });
  });

  it('a cancelled charge is gone at once', () => {
    for (const kind of [1, 2]) {
      const { mixes } = run([{}, { chargeKind: kind }, { chargeKind: kind }, {}]);
      expect(Object.keys(mixes[2].holds)).toHaveLength(1);
      expect(mixes[3].holds).toEqual({});
    }
  });

  it.each([[1, FlightMode.Cruise, 'cruise_charge'], [2, FlightMode.Fold, 'fold_charge']])('a completed charge of kind %i rings out for about 1.5 s', (kind, mode, event) => {
    // Frames every 0.1 s: charging until 0.2, the drive takes hold at 0.3.
    const { mixes } = run(stepped(30, 0.1, (i) => (i < 3 ? { chargeKind: kind } : { mode })));
    expect(mixes[2].holds[event]).toBe(1);
    expect(mixes[3].holds[event]).toBe(1);
    expect(mixes[16].holds[event]).toBe(1);
    expect(mixes[19].holds).toEqual({});
    expect(mixes[25].holds).toEqual({});
  });
});

describe('docking', () => {
  it('the edge to docked is a soft touchdown and a creak 1.2 s later', () => {
    const m = second({ mode: FlightMode.Docked });
    expect(names(m)).toEqual(['touchdown_soft', 'settle_creak']);
    expect(shotsOf(m, 'settle_creak')[0].delay).toBe(1.2);
  });

  it('nothing on the first frame, and nothing once docked', () => {
    const { mixes } = run([{ mode: FlightMode.Docked }, { mode: FlightMode.Docked }]);
    expect(mixes[0].shots).toEqual([]);
    expect(mixes[1].shots).toEqual([]);
  });
});

describe('hits on the own ship', () => {
  const hull = (frac: number) => HULL_MAX * frac;
  const shield = (frac: number) => SHIELD_MAX * frac;

  it('a hull hit is light, medium or heavy by its share of the hull, thresholds included', () => {
    const light = hull(TUNING.hitMedium) - 0.5;
    expect(names(second({ events: [hit(light)] }))).toEqual(['impact_hull_light']);
    expect(names(second({ events: [hit(hull(TUNING.hitMedium))] }))).toEqual(['impact_hull_medium']);
    expect(names(second({ events: [hit(hull(TUNING.hitHeavy) - 0.5)] }))).toEqual(['impact_hull_medium']);
    expect(names(second({ events: [hit(hull(TUNING.hitHeavy))] }))).toContain('impact_hull_heavy');
  });

  it('a heavy hull hit adds a groan half a second later, lighter ones do not', () => {
    const heavy = second({ events: [hit(hull(TUNING.hitHeavy))] });
    expect(shotsOf(heavy, 'hull_stress_groan')[0].delay).toBe(0.5);
    expect(names(second({ events: [hit(hull(TUNING.hitMedium))] }))).not.toContain('hull_stress_groan');
  });

  it('a shield hit is light, medium or heavy by its share of the shield, with the stand-in gain', () => {
    const cases: [number, string, number][] = [
      [shield(TUNING.hitMedium) - 0.5, 'impact_shield_light', 1],
      [shield(TUNING.hitMedium), 'impact_shield_medium', 1.41],
      [shield(TUNING.hitHeavy) - 0.5, 'impact_shield_medium', 1.41],
      [shield(TUNING.hitHeavy), 'impact_shield_heavy', 2],
    ];
    for (const [dmg, event, gain] of cases) {
      const m = second({ events: [hit(dmg, [0, 0, -10], { shield: true })] });
      expect(m.shots, event).toHaveLength(1);
      expect(m.shots[0].event).toBe(event);
      expect(m.shots[0].standInGain).toBe(gain);
    }
  });

  it('the direction follows where the hit came from', () => {
    const dir = (at: Vec3) => second({ events: [hit(5, at)] }).shots[0].direction;
    expect(dir([10, 0, 0])).toBeCloseTo(90);
    expect(dir([-10, 0, 0])).toBeCloseTo(-90);
    expect(dir([0, 0, -10])).toBeCloseTo(0);
    expect(Math.abs(dir([0, 0, 10]) as number)).toBeCloseTo(180);
    expect(dir([10, 0, -10])).toBeCloseTo(45);
    expect(dir([0, 0, 0])).toBeUndefined();
  });

  it('several hits of one kind in one frame are one shot, as strong as their sum, from the largest', () => {
    const m = second({ events: [hit(8, [10, 0, 0]), hit(9, [-10, 0, 0]), hit(7, [0, 0, -10])] });
    expect(m.shots).toHaveLength(1);
    // 24 of 200 is medium, though no single hit is.
    expect(m.shots[0].event).toBe('impact_hull_medium');
    expect(m.shots[0].direction).toBeCloseTo(-90);
    const s = second({ events: [hit(4, [10, 0, 0], { shield: true }), hit(7, [0, 0, -10], { shield: true }), hit(5, [-10, 0, 0], { shield: true })] });
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0].event).toBe('impact_shield_medium');
    expect(s.shots[0].direction).toBeCloseTo(0);
  });

  it('a hull hit and a shield hit in one frame are two sounds', () => {
    const m = second({ events: [hit(5), hit(5, [0, 0, -10], { shield: true })] });
    expect(names(m).sort()).toEqual(['impact_hull_light', 'impact_shield_light']);
  });

  it('two hull hits closer together than the spacing give one sound', () => {
    const near = run([{}, { events: [hit(5)] }, { events: [hit(5)] }]).mixes;
    expect(near[2].shots).toEqual([]);
    expect(1 / 60).toBeLessThan(TUNING.hitSpacing);
    const far = run([{ clock: 0 }, { clock: 0.1, events: [hit(5)] }, { clock: 0.1 + TUNING.hitSpacing + 0.01, events: [hit(5)] }]).mixes;
    expect(names(far[2])).toEqual(['impact_hull_light']);
  });

  it('a hit on another ship is not heard, and neither is anything on the first frame', () => {
    expect(second({ events: [hit(50, [0, 0, -10], { id: 7 })] }).shots).toEqual([]);
    expect(run([{ events: [hit(50)] }]).mixes[0].shots).toEqual([]);
  });
});

describe('the weapons', () => {
  const fire = (slot: number): Mix => second({ weapons: WEAPONS, events: [shotEv(SELF, slot)] }, { weapons: WEAPONS });

  it('a pulse mount fires the pulse and a cannon the cannon', () => {
    expect(names(fire(0))).toEqual(['weapon_pulse_fire']);
    expect(names(fire(1))).toEqual(['weapon_cannon_fire']);
  });

  it('a missile launches from the side of its rack', () => {
    expect(fire(2).shots).toMatchObject([{ event: 'missile_launch', direction: 50 }]);
    expect(fire(3).shots).toMatchObject([{ event: 'missile_launch', direction: -50 }]);
    expect(fire(4).shots).toMatchObject([{ event: 'missile_launch', direction: 0 }]);
  });

  it.each([
    ['a beam mount', 'weapon_beam_loop', { weapons: WEAPONS, events: [shotEv(SELF, 5)] }],
    ['a mining mount', 'mining_laser_loop', { weapons: WEAPONS, events: [shotEv(SELF, 6)] }],
    ['a mine event', 'mining_laser_loop', { events: [ev({ e: 'mine', from: SELF })] }],
    ['a salvage event', 'mining_laser_loop', { events: [ev({ e: 'salvage', from: SELF })] }],
  ] as [string, string, Frame][])('%s gives no shot but keeps its loop for the hold time after the last report', (_n, loop, f) => {
    const base = { weapons: WEAPONS };
    const t0 = 0.1;
    const { mixes } = run([
      { clock: 0, ...base }, { clock: t0, ...base, ...f },
      { clock: t0 + TUNING.beamHold - 0.05, ...base }, { clock: t0 + TUNING.beamHold + 0.05, ...base },
    ]);
    expect(mixes[1].shots).toEqual([]);
    expect(mixes[0].loops[loop]).toBeUndefined();
    expect(mixes[1].loops[loop]).toBe(1);
    expect(mixes[2].loops[loop]).toBe(1);
    expect(mixes[3].loops[loop]).toBeUndefined();
  });

  it('a report of the shot of another ship is not the own beam', () => {
    const m = second({ weapons: WEAPONS, events: [shotEv(9, 5)] });
    expect(m.loops.weapon_beam_loop).toBeUndefined();
  });
});

describe('what happens outside', () => {
  const other = (at: Vec3 = [100, 0, -100]): Frame => ({ ents: [{ id: 2, at }] });

  it('fire of another ship is a signal from its direction', () => {
    const m = second({ ...other(), events: [shotEv(2)] }, other());
    expect(m.shots).toMatchObject([{ event: 'sensor_fire_outside' }]);
    expect(m.shots[0].direction).toBeCloseTo(45);
  });

  it('at most one signal of fire per spacing', () => {
    const { mixes } = run(repeat(130, { ...other(), events: [shotEv(2)] }));
    const count = (a: number, b: number) => mixes.slice(a, b).reduce((n, m) => n + shotsOf(m, 'sensor_fire_outside').length, 0);
    expect(count(0, 60)).toBe(1);
    expect(count(0, 130)).toBeGreaterThanOrEqual(2);
    expect(count(0, 130)).toBeLessThanOrEqual(3);
  });

  it('no signal beyond the range, nor from a shooter the sensors do not show', () => {
    expect(second({ ...other([TUNING.outsideRange + 1, 0, 0]), events: [shotEv(2)] }).shots).toEqual([]);
    expect(second({ ...other([TUNING.outsideRange - 1, 0, 0]), events: [shotEv(2)] }).shots).toHaveLength(1);
    expect(second({ ...other(), events: [shotEv(99)] }).shots).toEqual([]);
  });

  it('the explosion of another ship is a signal with debris that arrives later', () => {
    const m = second({ events: [ev({ e: 'destroyed', id: 2, at: [300, 0, -400] })] });
    const bang = shotsOf(m, 'sensor_explosion_outside')[0];
    expect(bang.direction).toBeCloseTo((Math.atan2(300, 400) * 180) / Math.PI);
    const debris = shotsOf(m, 'debris_patter')[0];
    expect(debris.delay).toBeCloseTo(0.3 + 500 / TUNING.debrisSpeed);
    expect(debris.direction).toBeCloseTo(bang.direction as number);
  });

  it('far explosions have no debris, and those beyond the range nothing', () => {
    const far = second({ events: [ev({ e: 'destroyed', id: 2, at: [0, 0, -(TUNING.debrisRange + 100)] })] });
    expect(names(far)).toEqual(['sensor_explosion_outside']);
    const gone = second({ events: [ev({ e: 'destroyed', id: 2, at: [0, 0, -(TUNING.outsideRange + 100)] })] });
    expect(gone.shots).toEqual([]);
  });
});

describe('the alarms', () => {
  const alarms = (m: Mix) => Object.keys(m.loops).filter((k) => k.startsWith('alarm_'));
  const MISSILE = (vz: number, z = 1000): Frame => ({ ents: [{ id: 5, kind: EntityKind.Missile, at: [0, 0, -z], vel: [0, 0, vz] }] });

  it('the heat alarm sounds above the share and not at it', () => {
    expect(alarms(second({ heat: TUNING.heat + 0.01 }))).toEqual(['alarm_heat']);
    expect(alarms(second({ heat: TUNING.heat }))).toEqual([]);
  });

  it('the hull alarm sounds for its time after the hull fell below critical, and again after a hit', () => {
    const { mixes } = run(stepped(34, 0.25, (i) => ({ hull: i < 3 ? 1 : 0.2, events: i === 30 ? [hit(5)] : [] })));
    expect(alarms(mixes[2])).toEqual([]);
    expect(alarms(mixes[3])).toEqual(['alarm_hull_critical']);
    expect(alarms(mixes[26])).toEqual(['alarm_hull_critical']);
    expect(alarms(mixes[28])).toEqual([]);
    expect(alarms(mixes[31])).toEqual(['alarm_hull_critical']);
    expect(alarms(mixes[33])).toEqual(['alarm_hull_critical']);
  });

  it('the fuel alarm sounds for its time at each of the two shares', () => {
    const [one, two] = TUNING.fuelLow;
    const { mixes } = run(stepped(106, 0.25, (i) => ({ fuel: i < 3 ? 1 : i < 55 ? one * 0.9 : two * 0.9 })));
    expect(alarms(mixes[2])).toEqual([]);
    expect(alarms(mixes[3])).toEqual(['alarm_fuel_low']);
    expect(alarms(mixes[40])).toEqual(['alarm_fuel_low']);
    expect(alarms(mixes[52])).toEqual([]);
    expect(alarms(mixes[54])).toEqual([]);
    expect(alarms(mixes[56])).toEqual(['alarm_fuel_low']);
    expect(alarms(mixes[100])).toEqual(['alarm_fuel_low']);
    expect(alarms(mixes[105])).toEqual([]);
  });

  it('the missile alarm sounds for a missile that is near and closing fast', () => {
    expect(alarms(second(MISSILE(TUNING.missileClosing + 10)))).toEqual(['alarm_missile']);
  });

  it('not for a missile that flies away, is far, or closes slowly', () => {
    expect(alarms(second(MISSILE(-(TUNING.missileClosing + 10))))).toEqual([]);
    expect(alarms(second(MISSILE(TUNING.missileClosing + 10, TUNING.missileRange + 500)))).toEqual([]);
    expect(alarms(second(MISSILE(TUNING.missileClosing - 5)))).toEqual([]);
  });

  it('only the most urgent alarm sounds: missile before hull before heat before fuel', () => {
    const all: Frame = { heat: 1, hull: 0.1, fuel: 0.01 };
    const m = (f: Frame) => alarms(run([{}, { ...all, ...f }]).mixes[1]);
    expect(m(MISSILE(60))).toEqual(['alarm_missile']);
    expect(m({})).toEqual(['alarm_hull_critical']);
    expect(m({ hull: 1 })).toEqual(['alarm_heat']);
    expect(m({ hull: 1, heat: 0 })).toEqual(['alarm_fuel_low']);
  });

  it('the shields-down signal comes on the frame the shield reaches zero', () => {
    const { mixes } = run([{}, { shield: 0.5 }, { shield: 0 }, { shield: 0 }]);
    expect(names(mixes[1])).toEqual([]);
    expect(names(mixes[2])).toEqual(['alarm_shields_down']);
    expect(names(mixes[3])).toEqual([]);
  });

  it('not on the first frame, and not in silent running', () => {
    expect(run([{ shield: 0 }]).mixes[0].shots).toEqual([]);
    const m = run([{ buttons: Button.Silent }, { shield: 0, buttons: Button.Silent }]).mixes[1];
    expect(names(m)).toEqual([]);
  });
});

describe('the sensors', () => {
  const ship = (id: number, kind: number = EntityKind.Ship) => ({ id, kind, at: [0, 0, -1000] as Vec3 });
  const pings = (mixes: Mix[]) => mixes.flatMap((m, i) => (shotsOf(m, 'sensor_contact_ping').length ? [i] : []));

  it('a ship that appears is pinged', () => {
    const { mixes } = run(stepped(24, 0.25, (i) => ({ ents: i >= 16 ? [ship(2)] : [] })));
    expect(pings(mixes)).toEqual([16]);
  });

  it('not within the quiet time after the first frame', () => {
    const { mixes } = run(stepped(24, 0.25, (i) => ({ ents: i >= 8 ? [ship(2)] : [] })));
    expect(pings(mixes)).toEqual([]);
  });

  it('not within the quiet time after a change of mode, but after it', () => {
    const mode = (i: number) => (i < 16 ? FlightMode.Normal : FlightMode.Cruise);
    const soon = run(stepped(40, 0.25, (i) => ({ mode: mode(i), ents: i >= 20 ? [ship(2)] : [] })));
    expect(pings(soon.mixes)).toEqual([]);
    const later = run(stepped(40, 0.25, (i) => ({ mode: mode(i), ents: i >= 30 ? [ship(2)] : [] })));
    expect(pings(later.mixes)).toEqual([30]);
  });

  it('not more often than the spacing', () => {
    const { mixes } = run(stepped(40, 0.25, (i) => ({ ents: [...(i >= 16 ? [ship(2)] : []), ...(i >= 18 ? [ship(3)] : []), ...(i >= 28 ? [ship(4)] : [])] })));
    expect(pings(mixes)).toEqual([16, 28]);
    expect(0.5).toBeLessThan(TUNING.contactSpacing);
  });

  it('not for a missile', () => {
    const { mixes } = run(stepped(24, 0.25, (i) => ({ ents: i >= 16 ? [ship(5, EntityKind.Missile)] : [] })));
    expect(pings(mixes)).toEqual([]);
  });

  it('a lock tone when the target changes to another id, none when it stays or is dropped', () => {
    const { mixes } = run([{ targetId: 4 }, { targetId: 4 }, { targetId: 6 }, { targetId: 6 }, { targetId: null }]);
    expect(mixes.map((m) => shotsOf(m, 'sensor_lock_tone').length)).toEqual([0, 0, 1, 0, 0]);
    expect(names(second({ targetId: 3 }))).toEqual(['sensor_lock_tone']);
  });
});

describe('close to the ground', () => {
  const g = (height: number, verticalSpeed: number, groundSpeed = 0): Frame => ({ ground: { height, verticalSpeed, groundSpeed } });
  const count = (mixes: Mix[], event: string) => mixes.map((m) => shotsOf(m, event).length);

  it('the gear goes out once below the height while sinking, and in once above the second height', () => {
    const { mixes } = run([g(200, -5), g(140, -5), g(130, -5), g(200, 5), g(310, 5), g(320, 5)]);
    expect(count(mixes, 'gear_deploy')).toEqual([0, 1, 0, 0, 0, 0]);
    expect(count(mixes, 'gear_retract')).toEqual([0, 0, 0, 0, 1, 0]);
    expect(TUNING.gearOut).toBeLessThan(200);
    expect(200).toBeLessThan(TUNING.gearIn);
  });

  it('the gear stays in below the height while climbing', () => {
    const { mixes } = run([g(100, 5), g(100, 5)]);
    expect(count(mixes, 'gear_deploy')).toEqual([0, 0]);
  });

  it('the interval of the approach signal runs from the near value at the ground to the far one at its height', () => {
    expect(tickInterval(0)).toBeCloseTo(TUNING.tickNear);
    expect(tickInterval(TUNING.tickHeight)).toBeCloseTo(TUNING.tickFar);
    expect(tickInterval(TUNING.tickHeight * 3)).toBeCloseTo(TUNING.tickFar);
    const mid = tickInterval(TUNING.tickHeight / 2);
    expect(mid).toBeGreaterThan(TUNING.tickNear);
    expect(mid).toBeLessThan(TUNING.tickFar);
  });

  it('the approach signal ticks while sinking, spaced by the interval of the height', () => {
    const h = TUNING.tickHeight / 2;
    const { mixes } = run(stepped(100, 0.05, () => g(h, -5)));
    const at = mixes.flatMap((m, i) => (shotsOf(m, 'sensor_proximity_tick').length ? [i * 0.05] : []));
    expect(at.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(tickInterval(h) - 1e-9);
      expect(at[i] - at[i - 1]).toBeLessThan(tickInterval(h) + 0.05 + 1e-9);
    }
  });

  it('no ticks while climbing, and none above the tick height', () => {
    const climb = run(stepped(100, 0.05, () => g(TUNING.tickHeight / 2, 5)));
    expect(count(climb.mixes, 'sensor_proximity_tick').every((n) => n === 0)).toBe(true);
    const high = run(stepped(100, 0.05, () => g(TUNING.tickHeight + 50, -5)));
    expect(count(high.mixes, 'sensor_proximity_tick').every((n) => n === 0)).toBe(true);
  });

  it('the dust loop sounds below the dust height only, louder closer and with more thrust', () => {
    const dust = (height: number, thrust = 0) => run([{ ...g(height, 0), thrust: [0, 0, thrust] }]).mixes[0].loops.dust_patter_loop;
    expect(dust(TUNING.dustHeight)).toBeUndefined();
    expect(dust(TUNING.dustHeight * 2)).toBeUndefined();
    expect(dust(40)).toBeGreaterThan(0);
    expect(dust(10)).toBeGreaterThan(dust(40) as number);
    expect(dust(10, 1)).toBeGreaterThan(dust(10, 0) as number);
  });

  const land = (sink: number): Mix => run([g(5, -sink), { mode: FlightMode.Landed, ...g(0, 0) }]).mixes[1];

  it('a soft touchdown: the sound and a creak 1.2 s later', () => {
    const m = land(TUNING.hardSink - 0.1);
    expect(names(m)).toEqual(['touchdown_soft', 'settle_creak']);
    expect(shotsOf(m, 'settle_creak')[0].delay).toBe(1.2);
  });

  it('a hard touchdown at the sink rate: the hard sound, a groan after 0.8 s and the creak', () => {
    for (const sink of [TUNING.hardSink, TUNING.hardSink + 4]) {
      const m = land(sink);
      expect(names(m)).toEqual(['touchdown_hard', 'hull_stress_groan', 'settle_creak']);
      expect(shotsOf(m, 'hull_stress_groan')[0].delay).toBe(0.8);
      expect(shotsOf(m, 'settle_creak')[0].delay).toBe(1.2);
    }
  });
});

describe('a destroyed ship', () => {
  it('is silent after a flight too, whatever was going on', () => {
    const { mixes } = run([{ thrust: [0, 0, 1], heat: 1 }, { thrust: [0, 0, 1], heat: 1 }, { mode: FlightMode.Dead, events: [hit(500)] }]);
    expect(mixes[2]).toEqual({ engine: null, loops: {}, holds: {}, shots: [] });
  });
});

describe('the helpers', () => {
  it('hitStrength grades by the share, at the thresholds', () => {
    expect(hitStrength(0, 100)).toBe(0);
    expect(hitStrength(100 * TUNING.hitMedium - 0.01, 100)).toBe(0);
    expect(hitStrength(100 * TUNING.hitMedium, 100)).toBe(1);
    expect(hitStrength(100 * TUNING.hitHeavy - 0.01, 100)).toBe(1);
    expect(hitStrength(100 * TUNING.hitHeavy, 100)).toBe(2);
    expect(hitStrength(1000, 100)).toBe(2);
  });

  it('directionOf measures from the pilot in the ships own axes', () => {
    const self = { rel: [0, 0, 0] as Vec3, rot: [0, 0, 0, 1] as [number, number, number, number] };
    expect(directionOf(self, [0, 0, -5])).toBeCloseTo(0);
    expect(directionOf(self, [5, 0, 0])).toBeCloseTo(90);
    expect(directionOf(self, [-5, 0, 0])).toBeCloseTo(-90);
    expect(Math.abs(directionOf(self, [0, 0, 5]) as number)).toBeCloseTo(180);
    expect(directionOf(self, [0, 3, 0])).toBeUndefined();
    expect(directionOf(self, [0, 0, 0])).toBeUndefined();
  });

  it('directionOf takes the position of the ship into account', () => {
    const self = { rel: [10, 0, 0] as Vec3, rot: [0, 0, 0, 1] as [number, number, number, number] };
    expect(directionOf(self, [10, 0, -5])).toBeCloseTo(0);
    expect(directionOf(self, [15, 0, 0])).toBeCloseTo(90);
    expect(directionOf(self, [10, 0, 0])).toBeUndefined();
  });

  it('directionOf takes the rotation of the ship into account', () => {
    // A quarter turn to the left about the vertical: the nose points along -X.
    const s = Math.SQRT1_2;
    const self = { rel: [0, 0, 0] as Vec3, rot: [0, s, 0, s] as [number, number, number, number] };
    expect(directionOf(self, [-5, 0, 0])).toBeCloseTo(0);
    expect(directionOf(self, [0, 0, -5])).toBeCloseTo(90);
  });
});

describe('the list of cue events', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../../assets/audio/game.json', import.meta.url), 'utf8')) as { events: Record<string, unknown> };
  const inFile = Object.keys(manifest.events);
  const OTHERS = [
    'cabin_ir', 'thruster_pulse_a', 'thruster_pulse_b', 'alarm_master_caution', 'radio_squelch_open', 'radio_squelch_close', 'radio_tone',
  ];

  it('holds every event any mix of the tests asked for', () => {
    // The cabin and the thrusters, in case no run reached them.
    run([{ buttons: Button.Silent }, {}, { thrust: [1, 0, 0] }]);
    expect(seen.size).toBeGreaterThan(20);
    for (const e of seen) expect(CUE_EVENTS, e).toContain(e);
  });

  it('has no event the sound list does not know', () => {
    for (const e of CUE_EVENTS) expect(inFile, e).toContain(e);
  });

  it('misses no event of the sound list but those that other code asks for', () => {
    for (const e of inFile) if (!OTHERS.includes(e) && !e.startsWith('engine_main_')) expect(CUE_EVENTS, e).toContain(e);
  });
});
