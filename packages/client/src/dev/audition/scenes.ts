import type { Loc } from './types.ts';

// The three audition scenes as plain data and small functions. Every sound is named by its manifest id;
// an id the manifest does not have is skipped by the runner and listed as missing on the scene.
// The mapping from the sliders (thrust, heat, distance) to gains lives here and nowhere else.

export interface SceneState {
  thrust: number;
  heat: number;
  /** Distance to the pad, the enemy or the ground, in metres; what it means is in the scene's `distance.label`. */
  distance: number;
  boost: boolean;
  /** Switches that the events toggle (alarms, scraping, engines off). */
  on: Record<string, boolean>;
}

/** A loop that runs while its gain is above zero; started fresh each time so that an alarm begins at its first beat. */
export interface LoopSpec {
  id: string;
  gain: (s: SceneState) => number;
}

export interface Shot {
  /** One id, or several of which one is picked at random. */
  id: string | string[];
  /** Seconds after the button press. */
  at?: number;
  gain?: (s: SceneState) => number;
  /** Starts this many seconds before the end of the shot before it (the files end with about 18 ms of fade and silence). */
  chain?: boolean;
  /** Plays through the radio filter, with squelch and hiss (downloaded speech is raw and needs it). */
  viaRadio?: boolean;
}

export interface EventSpec {
  key: string;
  label: Loc;
  shots?: Shot[];
  /** Flips `state.on[key]`; a loop reads it. */
  toggle?: boolean;
}

/** Fires `id` again and again, every `every(state)` seconds; null means not now. */
export interface RepeaterSpec {
  id: string;
  every: (s: SceneState) => number | null;
  gain?: (s: SceneState) => number;
}

export type Param = 'thrust' | 'heat' | 'distance';

export interface ScriptStep {
  t: number;
  event?: string;
  /** For toggles: force on or off instead of flipping. */
  on?: boolean;
  boost?: boolean;
}

export interface SceneDef {
  id: string;
  title: Loc;
  blurb: Loc;
  distance: { label: Loc; unit: string; min: number; max: number; step: number; initial: number };
  thrustFamily: string;
  /** Gain of the whole engine group, for "engines off". */
  engineGain: (s: SceneState) => number;
  loops: LoopSpec[];
  repeaters: RepeaterSpec[];
  events: EventSpec[];
  /** Keyframes [seconds, value], linear in between. */
  tracks: Record<Param, [number, number][]>;
  script: ScriptStep[];
  duration: number;
}

export const BOOST_THRUST = 1.4;

export function effectiveThrust(s: SceneState): number {
  return s.boost ? BOOST_THRUST : s.thrust;
}

export function initialState(def: SceneDef): SceneState {
  return { thrust: 0, heat: 0.2, distance: def.distance.initial, boost: false, on: {} };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function sampleTrack(keys: [number, number][], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return keys[keys.length - 1][1];
}

const PULSES = ['thruster_pulse_a', 'thruster_pulse_b', 'thruster_pulse_c'];
const engineAlways = (): number => 1;
// The files were rendered to a common level table, so loops are mixed by adding them at gain 1.
const full = (): number => 1;
/** Overlap of chained one-shots: the fade and silence at the end of a file are about 18 ms long. */
export const CHAIN_OVERLAP = 0.02;
// Downloaded NASA speech is raw (peaks near full scale), so it comes down before the radio filter.
const RAW_SPEECH_GAIN = 0.4;
const enginesUnlessOff = (s: SceneState): number => (s.on.engines_off ? 0 : 1);
const relayClicks = ['relay_click_a', 'relay_click_b'];

export const DOCKING: SceneDef = {
  id: 'docking',
  title: { en: 'Docking approach', de: 'Andockanflug' },
  blurb: {
    en: 'Slow approach to a pad: engine by thrust, thruster pulses, the proximity tick that quickens as the pad comes closer, radio traffic, gear, touchdown, power down.',
    de: 'Langsamer Anflug auf eine Landeplattform: Triebwerk nach Schub, Steuerdüsen, der Näherungston, der mit sinkendem Abstand schneller tickt, Funkverkehr, Fahrwerk, Aufsetzen, Abschalten.',
  },
  distance: { label: { en: 'Distance to the pad', de: 'Abstand zur Plattform' }, unit: 'm', min: 0, max: 5000, step: 10, initial: 5000 },
  thrustFamily: 'engine_main',
  engineGain: engineAlways,
  loops: [{ id: 'cabin_ambience_loop', gain: full }],
  repeaters: [
    // 1.6 s between ticks at 600 m, down to 0.12 s at the pad.
    { id: 'sensor_proximity_tick', every: (s) => (s.distance < 600 ? 0.12 + 1.48 * (s.distance / 600) : null) },
  ],
  events: [
    { key: 'power_up', label: { en: 'Power up', de: 'Hochfahren' }, shots: [{ id: 'systems_power_up' }] },
    { key: 'pulse', label: { en: 'Thruster pulse', de: 'Düsenstoß' }, shots: [{ id: PULSES }] },
    // Real NASA speech through the radio filter; the three clips are 1.5 to 2.5 s long.
    { key: 'radio_check', label: { en: 'Radio: how do you read', de: 'Funk: Wie hören Sie mich' }, shots: [{ id: 'n_sts_how_do_you_read', viaRadio: true, gain: () => RAW_SPEECH_GAIN }] },
    { key: 'radio_go', label: { en: 'Radio: go for deploy', de: 'Funk: Freigabe zum Ausfahren' }, shots: [{ id: 'n_sts_go_for_deploy', viaRadio: true, gain: () => RAW_SPEECH_GAIN }] },
    { key: 'radio_roger', label: { en: 'Radio: roger', de: 'Funk: Verstanden' }, shots: [{ id: 'n_sts_roger_roll', viaRadio: true, gain: () => RAW_SPEECH_GAIN }] },
    { key: 'tone', label: { en: 'Radio tone', de: 'Funkton' }, shots: [{ id: 'radio_tone' }] },
    { key: 'ping', label: { en: 'Contact ping', de: 'Kontaktton' }, shots: [{ id: 'sensor_contact_ping' }] },
    { key: 'relay', label: { en: 'Relay', de: 'Relais' }, shots: [{ id: relayClicks }] },
    { key: 'gear', label: { en: 'Gear out', de: 'Fahrwerk aus' }, shots: [{ id: 'gear_deploy' }] },
    { key: 'touchdown', label: { en: 'Touchdown', de: 'Aufsetzen' }, shots: [{ id: 'touchdown_soft' }, { id: 'settle_creak', at: 1.2 }] },
    { key: 'power_down', label: { en: 'Power down', de: 'Herunterfahren' }, shots: [{ id: 'systems_power_down' }] },
  ],
  tracks: {
    thrust: [[0, 0], [2, 0.25], [12, 0.5], [24, 0.3], [30, 0.12], [33, 0.1], [35, 0]],
    heat: [[0, 0.2], [40, 0.2]],
    distance: [[0, 5000], [8, 4000], [16, 1500], [24, 400], [30, 60], [33, 0], [40, 0]],
  },
  script: [
    { t: 0.5, event: 'power_up' },
    { t: 3, event: 'radio_check' },
    { t: 7, event: 'pulse' },
    { t: 11, event: 'radio_roger' },
    { t: 14, event: 'pulse' },
    { t: 18, event: 'pulse' },
    { t: 19, event: 'ping' },
    { t: 21, event: 'radio_go' },
    { t: 25, event: 'pulse' },
    { t: 27, event: 'gear' },
    { t: 31, event: 'pulse' },
    { t: 33, event: 'touchdown' },
    { t: 35, event: 'radio_roger' },
    { t: 36.5, event: 'power_down' },
  ],
  duration: 40,
};

export const COMBAT: SceneDef = {
  id: 'combat',
  title: { en: 'Combat', de: 'Gefecht' },
  blurb: {
    en: 'Engine and boost, own weapons, hits on shield then hull in three strengths, shields down, the missile warning, the heat warning above 0.9, hull critical, debris.',
    de: 'Triebwerk und Boost, eigene Waffen, Treffer auf Schild und dann Rumpf in drei Stärken, Schilde unten, Raketenwarnung, Hitzewarnung über 0,9, Rumpf kritisch, Trümmer.',
  },
  distance: { label: { en: 'Distance to the enemy', de: 'Abstand zum Gegner' }, unit: 'm', min: 0, max: 10000, step: 50, initial: 3000 },
  thrustFamily: 'engine_main',
  engineGain: engineAlways,
  loops: [
    { id: 'cabin_ambience_loop', gain: full },
    { id: 'alarm_heat', gain: (s) => (s.heat > 0.9 ? 1 : 0) },
    { id: 'alarm_missile', gain: (s) => (s.on.missile ? 1 : 0) },
    { id: 'alarm_hull_critical', gain: (s) => (s.on.hull_critical ? 1 : 0) },
    { id: 'weapon_beam_loop', gain: (s) => (s.on.beam ? 1 : 0) },
  ],
  repeaters: [],
  events: [
    { key: 'pulse_fire', label: { en: 'Pulse weapon', de: 'Impulswaffe' }, shots: [{ id: 'weapon_pulse_fire' }] },
    { key: 'cannon', label: { en: 'Cannon', de: 'Kanone' }, shots: [{ id: 'weapon_cannon_fire' }] },
    { key: 'beam', label: { en: 'Beam on/off', de: 'Strahl an/aus' }, toggle: true },
    { key: 'missile_launch', label: { en: 'Missile launch', de: 'Raketenstart' }, shots: [{ id: 'missile_launch' }] },
    { key: 'shield_light', label: { en: 'Shield hit, light', de: 'Schildtreffer, leicht' }, shots: [{ id: 'impact_shield_light' }] },
    { key: 'shield_medium', label: { en: 'Shield hit, medium', de: 'Schildtreffer, mittel' }, shots: [{ id: 'impact_shield_medium' }] },
    { key: 'shield_heavy', label: { en: 'Shield hit, heavy', de: 'Schildtreffer, schwer' }, shots: [{ id: 'impact_shield_heavy' }] },
    { key: 'hull_light', label: { en: 'Hull hit, light', de: 'Rumpftreffer, leicht' }, shots: [{ id: 'impact_hull_light' }] },
    { key: 'hull_medium', label: { en: 'Hull hit, medium', de: 'Rumpftreffer, mittel' }, shots: [{ id: 'impact_hull_medium' }] },
    { key: 'hull_heavy', label: { en: 'Hull hit, heavy', de: 'Rumpftreffer, schwer' }, shots: [{ id: 'impact_hull_heavy' }, { id: 'hull_stress_groan', at: 0.5 }] },
    { key: 'shields_down', label: { en: 'Shields down', de: 'Schilde unten' }, shots: [{ id: 'alarm_shields_down' }] },
    { key: 'missile', label: { en: 'Missile warning on/off', de: 'Raketenwarnung an/aus' }, toggle: true },
    { key: 'hull_critical', label: { en: 'Hull critical on/off', de: 'Rumpf kritisch an/aus' }, toggle: true },
    { key: 'caution', label: { en: 'Master caution', de: 'Master Caution' }, shots: [{ id: 'alarm_master_caution' }] },
    { key: 'debris', label: { en: 'Debris', de: 'Trümmer' }, shots: [{ id: 'debris_patter' }] },
    {
      key: 'outside_fire',
      label: { en: 'Fire nearby (sensor)', de: 'Feuer in der Nähe (Sensor)' },
      shots: [{ id: 'sensor_fire_outside', gain: (s) => clamp(1.1 - s.distance / 10000, 0.3, 1) }],
    },
    {
      key: 'outside_explosion',
      label: { en: 'Explosion nearby (sensor)', de: 'Explosion in der Nähe (Sensor)' },
      shots: [{ id: 'sensor_explosion_outside', gain: (s) => clamp(1.1 - s.distance / 10000, 0.3, 1) }],
    },
  ],
  tracks: {
    thrust: [[0, 0.5], [3, 1], [10, 0.8], [20, 0.5], [30, 0.4], [40, 0.2]],
    heat: [[0, 0.3], [15, 0.7], [24, 0.85], [27, 1.05], [32, 1.05], [36, 0.6], [40, 0.4]],
    distance: [[0, 3000], [10, 1500], [20, 800], [30, 400], [40, 1200]],
  },
  script: [
    { t: 1, event: 'pulse_fire' },
    { t: 1.4, event: 'pulse_fire' },
    { t: 1.8, event: 'pulse_fire' },
    { t: 4, boost: true },
    { t: 5, event: 'cannon' },
    { t: 7, event: 'missile_launch' },
    { t: 9, boost: false },
    { t: 9, event: 'outside_fire' },
    { t: 10, event: 'shield_light' },
    { t: 12, event: 'shield_medium' },
    { t: 14, event: 'shield_heavy' },
    { t: 15, event: 'shields_down' },
    { t: 16, event: 'hull_light' },
    { t: 18, event: 'hull_medium' },
    { t: 19, event: 'missile', on: true },
    { t: 21, event: 'outside_explosion' },
    { t: 22, event: 'hull_heavy' },
    { t: 23, event: 'missile', on: false },
    { t: 25, event: 'caution' },
    { t: 29, event: 'hull_critical', on: true },
    { t: 31, event: 'debris' },
    { t: 34, event: 'hull_critical', on: false },
  ],
  duration: 40,
};

export const LANDING: SceneDef = {
  id: 'landing',
  title: { en: 'Landing on the moon', de: 'Mondlandung' },
  blurb: {
    en: 'Descent from 2,000 m: the cruise drops out, engine by thrust, regolith pattering on the hull below 60 m (louder with thrust), gear, touchdown, scraping, the ship settling, the cabin at rest.',
    de: 'Sinkflug aus 2000 m: der Reiseantrieb fällt weg, Triebwerk nach Schub, Regolith prasselt unter 60 m auf den Rumpf (lauter mit mehr Schub), Fahrwerk, Aufsetzen, Schleifen, das Schiff setzt sich, die Kabine in Ruhe.',
  },
  distance: { label: { en: 'Height above ground', de: 'Höhe über Grund' }, unit: 'm', min: 0, max: 2000, step: 5, initial: 2000 },
  thrustFamily: 'engine_main',
  engineGain: enginesUnlessOff,
  loops: [
    { id: 'cabin_ambience_loop', gain: full },
    // Fades out between 1,500 and 1,000 m while the disengage sound plays.
    { id: 'cruise_loop', gain: (s) => clamp((s.distance - 1000) / 500, 0, 1) },
    { id: 'dust_patter_loop', gain: (s) => (s.distance < 60 ? (1 - s.distance / 60) * (0.3 + 0.7 * clamp(effectiveThrust(s), 0, 1)) : 0) },
    { id: 'ground_scrape_loop', gain: (s) => (s.on.scrape ? 0.8 : 0) },
  ],
  repeaters: [],
  events: [
    // The charge runs into the engage click without a gap: each one starts 20 ms before the one before it ends.
    {
      key: 'cruise_start',
      label: { en: 'Cruise charge and engage', de: 'Reiseantrieb laden und einrasten' },
      shots: [{ id: 'cruise_charge' }, { id: 'cruise_engage', chain: true }],
    },
    { key: 'disengage', label: { en: 'Cruise disengage', de: 'Reiseantrieb aus' }, shots: [{ id: 'cruise_disengage' }] },
    { key: 'pulse', label: { en: 'Thruster pulse', de: 'Düsenstoß' }, shots: [{ id: PULSES }] },
    { key: 'gear', label: { en: 'Gear out', de: 'Fahrwerk aus' }, shots: [{ id: 'gear_deploy' }] },
    { key: 'soft', label: { en: 'Gentle touchdown', de: 'Sanftes Aufsetzen' }, shots: [{ id: 'touchdown_soft' }] },
    { key: 'hard', label: { en: 'Hard touchdown', de: 'Harte Landung' }, shots: [{ id: 'touchdown_hard' }, { id: 'hull_stress_groan', at: 0.8 }] },
    { key: 'scrape', label: { en: 'Scraping on/off', de: 'Schleifen an/aus' }, toggle: true },
    { key: 'settle', label: { en: 'Ship settles', de: 'Schiff setzt sich' }, shots: [{ id: 'settle_creak' }] },
    { key: 'engines_off', label: { en: 'Engines off/on', de: 'Triebwerke aus/an' }, toggle: true },
  ],
  tracks: {
    thrust: [[0, 0.15], [6, 0.3], [14, 0.55], [22, 0.6], [28, 0.7], [31, 0.5], [33, 0.1], [34, 0]],
    heat: [[0, 0.2], [40, 0.2]],
    distance: [[0, 2000], [6, 1500], [14, 600], [22, 120], [28, 40], [31, 8], [33, 0], [40, 0]],
  },
  script: [
    { t: 6, event: 'disengage' },
    { t: 9, event: 'pulse' },
    { t: 15, event: 'pulse' },
    { t: 20, event: 'gear' },
    { t: 24, event: 'pulse' },
    { t: 30, event: 'pulse' },
    { t: 33, event: 'soft' },
    { t: 33.4, event: 'scrape', on: true },
    { t: 35, event: 'scrape', on: false },
    { t: 35.5, event: 'settle' },
    { t: 37, event: 'engines_off', on: true },
  ],
  duration: 40,
};

export const SCENES: SceneDef[] = [DOCKING, COMBAT, LANDING];

/** Every id a scene refers to, for the "missing" list and for preloading. */
export function sceneSoundIds(def: SceneDef): string[] {
  const ids = new Set<string>([def.thrustFamily]);
  for (const l of def.loops) ids.add(l.id);
  for (const r of def.repeaters) ids.add(r.id);
  for (const e of def.events) for (const s of e.shots ?? []) for (const id of Array.isArray(s.id) ? s.id : [s.id]) ids.add(id);
  ids.delete(def.thrustFamily);
  return [...ids];
}
