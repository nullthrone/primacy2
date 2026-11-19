import { Button, FlightMode } from '@primacy2/shared';
import { describe, expect, it } from 'vitest';
import type { FrameView } from '../contracts.ts';
import { cue, engineAsk, initialCueState, TUNING, type CueState, type Mix } from './cues.ts';

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
}

function frame(f: Frame = {}): FrameView {
  const mode = f.mode ?? FlightMode.Normal;
  const self = f.self ?? (mode === FlightMode.Normal || mode === FlightMode.Cruise || mode === FlightMode.Landed);
  return {
    clock: f.clock ?? 0,
    dt: f.dt ?? 1 / 60,
    mode,
    events: [],
    fx: { cruise: 0, charge: 0, chargeKind: 0, fold: 0, dilation: 1, heat: 0, boosting: f.boosting ?? false, hitFlash: 0 },
    self: self
      ? { id: 1, vel: [0, 0, -(f.speed ?? 0)], input: { seq: 0, thrust: f.thrust ?? [0, 0, 0], aim: [0, 0], roll: 0, throttle: f.throttle ?? 0, buttons: f.buttons ?? 0 } }
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
  });
  return { mixes, state };
}

const repeat = (n: number, f: Frame): Frame[] => Array.from({ length: n }, () => ({ ...f }));
const pulses = (mixes: Mix[]): number => mixes.reduce((n, m) => n + m.shots.filter((s) => s.event === 'thruster_pulse_c').length, 0);

describe('nothing to hear', () => {
  it('is silent without a view, and the state starts over', () => {
    const { state } = run(repeat(30, { thrust: [0, 0, 1] }));
    const r = cue(state, null, () => 0);
    expect(r.mix).toEqual({ engine: null, loops: {}, shots: [] });
    expect(r.state).toEqual(initialCueState());
  });

  it('a destroyed ship has no cabin and no engine', () => {
    const { mix } = cue(initialCueState(), frame({ mode: FlightMode.Dead }), () => 0);
    expect(mix).toEqual({ engine: null, loops: {}, shots: [] });
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
