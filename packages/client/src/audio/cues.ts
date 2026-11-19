/**
 * The mapping from what the game shows to what should sound.
 *
 * `cue` is a pure function: the state it kept from the frame before, this frame's view and a source
 * of random numbers go in; the new state and a `Mix` come out. A `Mix` names events of the sound
 * list (`assets/audio/game.json`), never files: the mixer finds the approved sounds of an event in
 * the shipped manifest, and an event that has none makes no sound. So the mapping asks for the
 * cannon and the pulse laser like for everything else, and they are silent until a sound for them
 * is approved and shipped. Nothing here touches the audio context, so the whole mapping is tested
 * without one (`cues.test.ts`).
 *
 * The concept is "you hear your ship, not space": what happens to the own ship sounds; what
 * happens outside is a signal of the ship's sensors.
 *
 * The levels are in the files (scenes mix by adding), so a gain here is 1 unless the game has
 * something to say with it.
 */
import { Button, ChargeKind, EntityKind, FlightMode, quat, type Vec3 } from '@primacy2/shared';
import type { FrameView, SelfView } from '../contracts.ts';

/** A one-shot to start. */
export interface Shot {
  /** Event of the sound list, or a role of an adopted download. */
  event: string;
  gain?: number;
  /**
   * Gain used instead when the event has no sound of its own and plays those of its stand-in: a
   * stronger event that borrows the sound of a weaker one says its strength with level alone.
   */
  standInGain?: number;
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
  /**
   * Sounds that play once from the frame their event appears here and are faded out when it is
   * gone before they have ended: a charge that is cancelled must not run on.
   */
  holds: Record<string, number>;
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
  /** Flight mode and kind of charge of the frame before. */
  mode: number;
  charge: number;
  /** A charge that completed: its sound may ring out until this time. */
  tail: { event: string; until: number } | null;
  /** When the ship came to where it is (a change of flight mode, or the first frame). */
  since: number;
  /** Whether the shield was up, and how much hull (0..1) was left, in the frame before. */
  shielded: boolean;
  hull: number;
  /** Until when the hull alarm and the fuel alarm sound, and which fuel warnings were given (0, 1 or 2). */
  hullAlarmUntil: number;
  fuelAlarmUntil: number;
  fuelStage: number;
  /** `clock` of the last sound of a hit on the own hull and on the own shield. */
  lastHullHit: number;
  lastShieldHit: number;
  /** Until when the beam weapon and the tool beam (mining, salvage) are taken to be on. */
  beamUntil: number;
  toolUntil: number;
  /** Ships the sensors showed in the frame before, by id. */
  contacts: number[];
  lastPing: number;
  /** `clock` of the last signal for fire outside. */
  lastOutside: number;
  target: number | null;
  /** Landing gear out. */
  gear: boolean;
  /** `clock` at which the next tick of the approach signal is due; 0 while it is off. */
  nextTick: number;
  /** Sink rate of the frame before, m/s, positive downward: what a touchdown is judged by. */
  sink: number;
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
  /** A hit that takes less than the first share of the hull or shield is light, less than the second medium, else heavy. */
  hitMedium: 0.1,
  hitHeavy: 0.2,
  /** Seconds between two sounds of hits of one kind, and how many of a strength may ring at once (light, medium, heavy). */
  hitSpacing: 0.1,
  hitVoices: [4, 3, 2],
  /** Gain of a medium and a heavy shield hit while they borrow the sound of the light one (+3 dB, +6 dB). */
  shieldStandIn: [1, 1.41, 2],
  /** A beam weapon and a tool report themselves every 0.2 s; their loop holds on this long after a report. */
  beamHold: 0.45,
  /** Heat above this share of the capacity sounds the heat alarm. */
  heat: 0.9,
  /** Hull below this share sounds the hull alarm, for this many seconds after it fell there or was hit again. */
  hullCritical: 0.25,
  hullAlarm: 6,
  /** Fuel below these shares of the tank sounds the fuel alarm once each, for this many seconds (three chimes). */
  fuelLow: [0.1, 0.05],
  fuelAlarm: 12,
  /** A missile within this distance (m) that closes faster than this (m/s) sounds the missile alarm. */
  missileRange: 8000,
  missileClosing: 40,
  /** Contacts that are there when the ship arrives are not news: seconds without a ping after arriving, and between pings. */
  contactQuiet: 3,
  contactSpacing: 2,
  /** Fire and blasts of other ships are signalled within this distance (m); fire at most once in this many seconds. */
  outsideRange: 12000,
  outsideSpacing: 1,
  /** Fragments of a blast reach the hull within this distance (m), at this speed (m/s). */
  debrisRange: 1500,
  debrisSpeed: 800,
  /** The gear goes out below the first height above the ground (m) while sinking, and in above the second. */
  gearOut: 150,
  gearIn: 300,
  /** The approach signal ticks below this height (m) while sinking: every `tickFar` seconds at that height, `tickNear` at the ground. */
  tickHeight: 600,
  tickFar: 1.6,
  tickNear: 0.12,
  /** A touchdown at this sink rate (m/s) or more is a hard one. */
  hardSink: 3,
  /** The engines throw up regolith below this height (m). */
  dustHeight: 60,
} as const;

export function initialCueState(): CueState {
  return {
    clock: -1, thrust: 0, lateral: false, side: 0, lift: 0, lastPulse: -Infinity,
    mode: -1, charge: ChargeKind.None, tail: null, since: 0,
    shielded: false, hull: 1, hullAlarmUntil: -Infinity, fuelAlarmUntil: -Infinity, fuelStage: 0,
    lastHullHit: -Infinity, lastShieldHit: -Infinity, beamUntil: -Infinity, toolUntil: -Infinity,
    contacts: [], lastPing: -Infinity, lastOutside: -Infinity, target: null,
    gear: false, nextTick: 0, sink: 0,
  };
}

const silence = (): Mix => ({ engine: null, loops: {}, holds: {}, shots: [] });

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

/** 0 light, 1 medium, 2 heavy: a hit by the share of the hull or shield it took. */
export function hitStrength(damage: number, max: number): 0 | 1 | 2 {
  const share = max > 0 ? damage / max : 1;
  return share >= TUNING.hitHeavy ? 2 : share >= TUNING.hitMedium ? 1 : 0;
}

/**
 * The direction, in the stage's degrees (0 ahead, 90 right, -90 left, 180 behind), of a point given
 * relative to the camera in system axes, as heard from the pilot's ship. Undefined when the point
 * is at the ship itself.
 */
export function directionOf(self: Pick<SelfView, 'rel' | 'rot'>, rel: Readonly<Vec3>): number | undefined {
  const d: Vec3 = [rel[0] - self.rel[0], rel[1] - self.rel[1], rel[2] - self.rel[2]];
  // In the ship's own axes the nose is -Z and right is +X.
  const local = quat.unrotate(self.rot, d);
  if (Math.hypot(local[0], local[2]) < 0.05) return undefined;
  return (Math.atan2(local[0], -local[2]) * 180) / Math.PI;
}

/** Where an event of the zone is, relative to the camera in system axes; null outside normal space. */
function eventPoint(view: FrameView, at: Readonly<Vec3>): Vec3 | null {
  if (!view.zone || !view.zoneRot) return null;
  const r = quat.rotate(view.zoneRot, at);
  return [view.zone[0] + r[0], view.zone[1] + r[1], view.zone[2] + r[2]];
}

const dist = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const HULL_HITS = ['impact_hull_light', 'impact_hull_medium', 'impact_hull_heavy'] as const;
const SHIELD_HITS = ['impact_shield_light', 'impact_shield_medium', 'impact_shield_heavy'] as const;

/**
 * Every event `cue` can ask for, as a loop, a held sound or a one-shot. A test holds this list
 * against the code and against `assets/audio/game.json`, so that the mapping asks for nothing the
 * shipping step does not know. The engine levels are asked for as a family, not by name.
 */
export const CUE_EVENTS: readonly string[] = [
  'cabin_ambience_loop', 'silent_running_loop', 'thruster_pulse_c', 'thruster_burn_loop',
  'cruise_charge', 'cruise_engage', 'cruise_loop', 'cruise_disengage', 'fold_charge', 'fold_jump', 'fold_tunnel_loop', 'fold_exit',
  ...HULL_HITS, ...SHIELD_HITS, 'hull_stress_groan', 'debris_patter',
  'weapon_pulse_fire', 'weapon_cannon_fire', 'weapon_beam_loop', 'mining_laser_loop', 'missile_launch',
  'alarm_missile', 'alarm_hull_critical', 'alarm_heat', 'alarm_fuel_low', 'alarm_shields_down',
  'sensor_contact_ping', 'sensor_lock_tone', 'sensor_proximity_tick', 'sensor_fire_outside', 'sensor_explosion_outside',
  'gear_deploy', 'gear_retract', 'touchdown_soft', 'touchdown_hard', 'settle_creak', 'dust_patter_loop', 'ground_scrape_loop',
];

/** The interval of the approach signal at a height above the ground, in seconds. */
export function tickInterval(height: number): number {
  const f = Math.min(1, Math.max(0, height / TUNING.tickHeight));
  return TUNING.tickNear + (TUNING.tickFar - TUNING.tickNear) * f;
}

/** One frame of the mapping. With no view (the menu) nothing sounds and the state starts over. */
export function cue(prev: CueState, view: FrameView | null, rand: () => number): { state: CueState; mix: Mix } {
  if (!view) return { state: initialCueState(), mix: silence() };
  const now = view.clock;
  const first = prev.clock < 0 || now - prev.clock > TUNING.gap;
  const state: CueState = { ...prev, clock: now };
  const mix = silence();
  const self = view.self;
  const mode = view.mode;
  const was = first ? mode : prev.mode;
  if (first || mode !== was) state.since = now;
  state.mode = mode;

  // The cabin: wherever the pilot sits in the ship. With the ship destroyed there is no cabin.
  if (mode === FlightMode.Dead) {
    return { state: { ...initialCueState(), clock: now, mode, since: state.since }, mix };
  }
  const silentRunning = self !== null && (self.input.buttons & Button.Silent) !== 0;
  mix.loops[silentRunning ? 'silent_running_loop' : 'cabin_ambience_loop'] = 1;

  // The drives, by what the ship does, not by what was asked: a charge can be cancelled.
  if (mode === FlightMode.Cruise) mix.loops.cruise_loop = 1;
  if (mode === FlightMode.Fold) mix.loops.fold_tunnel_loop = 1;
  if (!first && mode !== was) {
    if (mode === FlightMode.Cruise) mix.shots.push({ event: 'cruise_engage', pick: rand() });
    // The jump takes the cruise away with it; only a drop to normal flight is the drive letting go.
    else if (was === FlightMode.Cruise && mode !== FlightMode.Fold) mix.shots.push({ event: 'cruise_disengage', pick: rand() });
    if (mode === FlightMode.Fold) mix.shots.push({ event: 'fold_jump', pick: rand() });
    else if (was === FlightMode.Fold) mix.shots.push({ event: 'fold_exit', pick: rand() });
  }
  const charge = view.fx.chargeKind;
  const charging = charge === ChargeKind.Cruise ? 'cruise_charge' : charge === ChargeKind.Fold ? 'fold_charge' : null;
  if (charging) mix.holds[charging] = 1;
  if (!first && prev.charge !== ChargeKind.None && charge === ChargeKind.None) {
    // The charge is over. Where the drive took hold, its sound rings out under what follows; where it was cancelled, it ends.
    const done = prev.charge === ChargeKind.Cruise ? mode === FlightMode.Cruise : mode === FlightMode.Fold;
    state.tail = done ? { event: prev.charge === ChargeKind.Cruise ? 'cruise_charge' : 'fold_charge', until: now + 1.5 } : null;
  }
  if (state.tail) {
    if (now < state.tail.until && !charging) mix.holds[state.tail.event] = 1;
    else state.tail = null;
  }
  state.charge = charge;

  if (!self) {
    // Docked or in the fold tunnel: no engine, and nothing to remember of what only a flown ship has.
    state.thrust = 0;
    state.lateral = false;
    state.contacts = [];
    state.nextTick = 0;
    if (!first && mode === FlightMode.Docked && (was === FlightMode.Normal || was === FlightMode.Landed)) {
      // The ship is set down on its pad. (A pilot who comes back after his ship was destroyed wakes up docked: no touchdown.)
      mix.shots.push({ event: 'touchdown_soft', pick: rand() });
      mix.shots.push({ event: 'settle_creak', pick: rand(), delay: 1.2 });
    }
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
  const flying = mode === FlightMode.Normal;
  const right = flying ? self.input.thrust[0] : 0;
  const up = flying ? self.input.thrust[1] : 0;
  const amount = Math.min(1, Math.hypot(right, up));
  const on = amount > (prev.lateral ? TUNING.lateralOff : TUNING.lateralOn);
  const side = on ? Math.sign(Math.abs(right) > TUNING.lateralOff ? right : 0) : 0;
  const lift = on ? Math.sign(Math.abs(up) > TUNING.lateralOff ? up : 0) : 0;
  const turned = prev.lateral && on && ((side !== 0 && side === -prev.side) || (lift !== 0 && lift === -prev.lift));
  if (on && (!prev.lateral || turned) && !first && now - prev.lastPulse >= TUNING.pulseSpacing) {
    mix.shots.push({ event: 'thruster_pulse_c', pick: rand(), maxVoices: TUNING.pulseVoices });
    state.lastPulse = now;
  }
  state.lateral = on;
  state.side = side;
  state.lift = lift;
  if (on) mix.loops.thruster_burn_loop = amount;

  // What the events of this frame say. After a pause they are old news.
  let hullDamage = 0;
  let hullAt: Vec3 | null = null;
  let hullMost = 0;
  let shieldDamage = 0;
  let shieldAt: Vec3 | null = null;
  let shieldMost = 0;
  if (!first) {
    for (const e of view.events) {
      if (e.e === 'hit' && e.id === self.id) {
        if (e.shield) {
          shieldDamage += e.dmg;
          if (e.dmg >= shieldMost) {
            shieldMost = e.dmg;
            shieldAt = e.at;
          }
        } else {
          hullDamage += e.dmg;
          if (e.dmg >= hullMost) {
            hullMost = e.dmg;
            hullAt = e.at;
          }
        }
      } else if (e.e === 'shot') {
        if (e.from === self.id) {
          const mount = self.stats.weapons[e.slot];
          const kind = mount?.kind ?? (e.w.startsWith('pulse') ? 'pulse' : e.w.startsWith('beam') ? 'beam' : e.w.startsWith('mining') ? 'mining' : e.w.startsWith('missile') ? 'missile' : 'cannon');
          if (kind === 'beam') state.beamUntil = now + TUNING.beamHold;
          else if (kind === 'mining') state.toolUntil = now + TUNING.beamHold;
          else if (kind === 'missile') {
            // From the side of the hull the rack sits on.
            const x = mount?.offset[0] ?? 0;
            mix.shots.push({ event: 'missile_launch', pick: rand(), direction: x > 0.2 ? 50 : x < -0.2 ? -50 : 0, maxVoices: 3 });
          } else mix.shots.push({ event: kind === 'pulse' ? 'weapon_pulse_fire' : 'weapon_cannon_fire', pick: rand(), maxVoices: 4 });
        } else if (now - state.lastOutside >= TUNING.outsideSpacing) {
          // Another ship fires: the sensors mark it, from where that ship is.
          const shooter = view.ents.find((x) => x.id === e.from);
          if (shooter && dist(shooter.rel, self.rel) <= TUNING.outsideRange) {
            mix.shots.push({ event: 'sensor_fire_outside', pick: rand(), direction: directionOf(self, shooter.rel), maxVoices: 2 });
            state.lastOutside = now;
          }
        }
      } else if ((e.e === 'mine' || e.e === 'salvage') && e.from === self.id) {
        state.toolUntil = now + TUNING.beamHold;
      } else if (e.e === 'destroyed' && e.id !== self.id) {
        const p = eventPoint(view, e.at);
        const d = p ? dist(p, self.rel) : Infinity;
        if (p && d <= TUNING.outsideRange) {
          const direction = directionOf(self, p);
          mix.shots.push({ event: 'sensor_explosion_outside', pick: rand(), direction, maxVoices: 2 });
          if (d <= TUNING.debrisRange) mix.shots.push({ event: 'debris_patter', pick: rand(), direction, delay: 0.3 + d / TUNING.debrisSpeed, maxVoices: 2 });
        }
      }
    }
  }
  // Hits on the own ship, by strength and from the side they came from. Several in one frame are one hit.
  if (shieldDamage > 0 && now - state.lastShieldHit >= TUNING.hitSpacing) {
    const k = hitStrength(shieldDamage, self.stats.shieldMax);
    const p = shieldAt ? eventPoint(view, shieldAt) : null;
    mix.shots.push({ event: SHIELD_HITS[k], pick: rand(), direction: p ? directionOf(self, p) : undefined, standInGain: TUNING.shieldStandIn[k], maxVoices: 3 });
    state.lastShieldHit = now;
  }
  if (hullDamage > 0 && now - state.lastHullHit >= TUNING.hitSpacing) {
    const k = hitStrength(hullDamage, self.stats.hullMax);
    const p = hullAt ? eventPoint(view, hullAt) : null;
    mix.shots.push({ event: HULL_HITS[k], pick: rand(), direction: p ? directionOf(self, p) : undefined, maxVoices: TUNING.hitVoices[k] });
    if (k === 2) mix.shots.push({ event: 'hull_stress_groan', pick: rand(), delay: 0.5, maxVoices: 1 });
    state.lastHullHit = now;
  }
  if (now < state.beamUntil) mix.loops.weapon_beam_loop = 1;
  if (now < state.toolUntil) mix.loops.mining_laser_loop = 1;

  // Alarms, from the loudspeaker in the cabin. One at a time: the most urgent.
  const st = self.state;
  const shielded = st.shield > 0;
  if (!first && prev.shielded && !shielded && self.stats.shieldMax > 0 && !silentRunning) mix.shots.push({ event: 'alarm_shields_down', pick: rand(), maxVoices: 1 });
  state.shielded = shielded;
  const hull = self.stats.hullMax > 0 ? st.hull / self.stats.hullMax : 1;
  if (hull < TUNING.hullCritical && (first || prev.hull >= TUNING.hullCritical || hullDamage > 0)) state.hullAlarmUntil = now + TUNING.hullAlarm;
  state.hull = hull;
  const fuel = self.stats.fuelCap > 0 ? st.fuel / self.stats.fuelCap : 1;
  const stage = fuel < TUNING.fuelLow[1] ? 2 : fuel < TUNING.fuelLow[0] ? 1 : 0;
  if (stage > prev.fuelStage) state.fuelAlarmUntil = now + TUNING.fuelAlarm;
  state.fuelStage = stage;
  let missile = false;
  for (const x of view.ents) {
    if (x.info.kind !== EntityKind.Missile) continue;
    const r: Vec3 = [x.rel[0] - self.rel[0], x.rel[1] - self.rel[1], x.rel[2] - self.rel[2]];
    const d = Math.hypot(r[0], r[1], r[2]);
    if (d > TUNING.missileRange || d < 1e-3) continue;
    const closing = -(r[0] * (x.vel[0] - self.vel[0]) + r[1] * (x.vel[1] - self.vel[1]) + r[2] * (x.vel[2] - self.vel[2])) / d;
    if (closing > TUNING.missileClosing) {
      missile = true;
      break;
    }
  }
  if (missile) mix.loops.alarm_missile = 1;
  else if (hull < TUNING.hullCritical && now < state.hullAlarmUntil) mix.loops.alarm_hull_critical = 1;
  else if (view.fx.heat > TUNING.heat) mix.loops.alarm_heat = 1;
  else if (stage > 0 && now < state.fuelAlarmUntil) mix.loops.alarm_fuel_low = 1;

  // Sensor signals: a new contact, a lock.
  const contacts: number[] = [];
  for (const x of view.ents) if (x.info.kind === EntityKind.Ship) contacts.push(x.id);
  if (!first && now - state.since >= TUNING.contactQuiet && now - state.lastPing >= TUNING.contactSpacing && contacts.some((id) => !prev.contacts.includes(id))) {
    mix.shots.push({ event: 'sensor_contact_ping', pick: rand(), maxVoices: 1 });
    state.lastPing = now;
  }
  state.contacts = contacts;
  if (!first && view.targetId !== null && view.targetId !== prev.target) mix.shots.push({ event: 'sensor_lock_tone', pick: rand(), maxVoices: 1 });
  state.target = view.targetId;

  // Close to the ground: the gear, the approach signal, the dust, the touchdown.
  const ground = view.surface?.ship ?? null;
  const sink = ground ? -ground.verticalSpeed : 0;
  if (ground && flying && !state.gear && ground.height < TUNING.gearOut && sink > 0) {
    state.gear = true;
    if (!first) mix.shots.push({ event: 'gear_deploy', pick: rand(), maxVoices: 1 });
  } else if (state.gear && mode !== FlightMode.Landed && (!ground || ground.height > TUNING.gearIn)) {
    state.gear = false;
    if (!first) mix.shots.push({ event: 'gear_retract', pick: rand(), maxVoices: 1 });
  }
  if (mode === FlightMode.Landed) state.gear = true;
  if (ground && flying && ground.height < TUNING.tickHeight && sink > 0.3) {
    if (now >= state.nextTick) {
      if (!first) mix.shots.push({ event: 'sensor_proximity_tick', pick: rand() });
      state.nextTick = now + tickInterval(ground.height);
    }
  } else state.nextTick = 0;
  if (ground && flying && ground.height < TUNING.dustHeight) {
    mix.loops.dust_patter_loop = (1 - ground.height / TUNING.dustHeight) * (0.3 + 0.7 * Math.min(1, state.thrust + amount));
    if (ground.height <= 0.05 && ground.groundSpeed > 2) mix.loops.ground_scrape_loop = 0.8;
  }
  if (!first && mode === FlightMode.Landed && was === FlightMode.Normal) {
    const hard = prev.sink >= TUNING.hardSink;
    mix.shots.push({ event: hard ? 'touchdown_hard' : 'touchdown_soft', pick: rand(), maxVoices: 1 });
    if (hard) mix.shots.push({ event: 'hull_stress_groan', pick: rand(), delay: 0.8, maxVoices: 1 });
    mix.shots.push({ event: 'settle_creak', pick: rand(), delay: 1.2, maxVoices: 1 });
  }
  state.sink = sink;

  return { state, mix };
}
