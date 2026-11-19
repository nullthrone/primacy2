/**
 * The mapping from what the game shows to what should sound.
 *
 * `cue` is a pure function: the state it kept from the frame before, this frame's view and a source
 * of random numbers go in; the new state and a `Mix` come out. A `Mix` names events of the sound
 * list (`assets/audio/game.json`), never files: the mixer finds the approved sounds of an event in
 * the shipped manifest, and an event that has none makes no sound. Nothing here touches the audio
 * context, so the whole mapping is tested without one (`cues.test.ts`).
 *
 * The levels are in the files (scenes mix by adding), so a gain here is 1 unless the game has
 * something to say with it.
 */
import { Button, FlightMode } from '@primacy2/shared';
import type { FrameView } from '../contracts.ts';

/** A one-shot to start. */
export interface Shot {
  /** Event of the sound list, or a role of an adopted download. */
  event: string;
  gain?: number;
  /** Where a one-channel sound comes from, degrees (0 ahead, 90 right, -90 left, 180 behind). */
  direction?: number;
  /** Seconds from now. */
  delay?: number;
  /** 0..1: chooses among the event's sounds; the mixer never takes the same one twice in a row. */
  pick: number;
  /** Not started while this many sounds of the event are still playing. */
  maxVoices?: number;
}

/** What should sound as of one frame. */
export interface Mix {
  /** The main engines: where on the crossfade of its levels (0 idle .. 1 full, 1.4 boost) and how loud; null for no engine. */
  engine: { thrust: number; gain: number } | null;
  /** Loops by event: gain above zero while the loop runs. A loop that is missing here stops. */
  loops: Record<string, number>;
  shots: Shot[];
}

/** What the mapping remembers between frames. Plain data. */
export interface CueState {
  /** `FrameView.clock` of the last frame that had a view, -1 before the first. */
  clock: number;
  /** The engine setting as it sounds now: it follows what the pilot asks for with a short spool time. */
  thrust: number;
  /** Whether manoeuvring thrust (sideways or vertical) is on, with hysteresis. */
  lateral: boolean;
  /** Sign of the sideways and of the vertical thrust while it is on. */
  side: number;
  lift: number;
  /** `clock` of the last thruster pulse. */
  lastPulse: number;
}

export const TUNING = {
  /** Seconds in which the engine follows a higher and a lower setting (time constants). */
  spoolUp: 0.25,
  spoolDown: 0.45,
  /** Position of the boost level on the crossfade (`params.thrust` of `engine_main_boost`). */
  boost: 1.4,
  /** What the engines do while the brake is held and the ship still moves. */
  brake: 0.5,
  /** Manoeuvring thrust counts as on above the first and as off below the second (of 1). */
  lateralOn: 0.2,
  lateralOff: 0.08,
  /** Seconds that must lie between the starts of two thruster pulses, and how many may sound at once. */
  pulseSpacing: 1.2,
  pulseVoices: 2,
  /** A longer pause than this between two frames (a hidden tab) starts no one-shots, in seconds. */
  gap: 0.5,
} as const;

export function initialCueState(): CueState {
  return { clock: -1, thrust: 0, lateral: false, side: 0, lift: 0, lastPulse: -Infinity };
}

const SILENCE: Mix = { engine: null, loops: {}, shots: [] };

/** What the pilot asks of the main engines, 0 .. 1.4. They push along the nose; sideways and vertical thrust is the thrusters'. */
export function engineAsk(view: FrameView): number {
  const self = view.self;
  if (!self) return 0;
  // In cruise the drive carries the ship, on the ground nothing does: the engines idle.
  if (view.mode !== FlightMode.Normal) return 0;
  if (view.fx.boosting) return TUNING.boost;
  const i = self.input;
  let ask = Math.min(1, Math.max(Math.abs(i.thrust[2]), Math.abs(i.throttle)));
  const speed = Math.hypot(self.vel[0], self.vel[1], self.vel[2]);
  if ((i.buttons & Button.Brake) !== 0 && speed > 2) ask = Math.max(ask, TUNING.brake);
  return ask;
}

/** One frame of the mapping. With no view (the menu) nothing sounds and the state starts over. */
export function cue(prev: CueState, view: FrameView | null, rand: () => number): { state: CueState; mix: Mix } {
  if (!view) return { state: initialCueState(), mix: SILENCE };
  const state: CueState = { ...prev, clock: view.clock };
  const first = prev.clock < 0 || view.clock - prev.clock > TUNING.gap;
  const mix: Mix = { engine: null, loops: {}, shots: [] };
  const self = view.self;

  // The cabin: wherever the pilot sits in the ship. With the ship destroyed there is no cabin.
  if (view.mode !== FlightMode.Dead) {
    const silentRunning = self !== null && (self.input.buttons & Button.Silent) !== 0;
    mix.loops[silentRunning ? 'silent_running_loop' : 'cabin_ambience_loop'] = 1;
  }

  if (!self) {
    // Docked, in the fold tunnel, destroyed: no engine, and nothing to remember of the thrusters.
    state.thrust = 0;
    state.lateral = false;
    return { state, mix };
  }

  // Main engines: one engine at six settings, crossfaded by what the pilot asks for.
  const ask = engineAsk(view);
  if (first) state.thrust = ask;
  else {
    const tau = ask > prev.thrust ? TUNING.spoolUp : TUNING.spoolDown;
    state.thrust = prev.thrust + (ask - prev.thrust) * (1 - Math.exp(-view.dt / tau));
    if (Math.abs(state.thrust - ask) < 0.002) state.thrust = ask;
  }
  mix.engine = { thrust: state.thrust, gain: 1 };

  // Manoeuvring thrusters: a pulse when sideways or vertical thrust sets in or turns round, a burn while it is held.
  const right = view.mode === FlightMode.Normal ? self.input.thrust[0] : 0;
  const up = view.mode === FlightMode.Normal ? self.input.thrust[1] : 0;
  const amount = Math.min(1, Math.hypot(right, up));
  const on = amount > (prev.lateral ? TUNING.lateralOff : TUNING.lateralOn);
  const side = on ? Math.sign(Math.abs(right) > TUNING.lateralOff ? right : 0) : 0;
  const lift = on ? Math.sign(Math.abs(up) > TUNING.lateralOff ? up : 0) : 0;
  const turned = prev.lateral && on && ((side !== 0 && side === -prev.side) || (lift !== 0 && lift === -prev.lift));
  if (on && (!prev.lateral || turned) && !first && view.clock - prev.lastPulse >= TUNING.pulseSpacing) {
    mix.shots.push({ event: 'thruster_pulse_c', pick: rand(), maxVoices: TUNING.pulseVoices });
    state.lastPulse = view.clock;
  }
  state.lateral = on;
  state.side = side;
  state.lift = lift;
  if (on) mix.loops.thruster_burn_loop = amount;

  return { state, mix };
}
