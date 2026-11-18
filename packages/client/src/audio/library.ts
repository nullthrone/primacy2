/**
 * The sounds the game ships: the manifest written by `tools/audio/ship.py` and the decoded files.
 *
 * Loading never waits for the audio context and never blocks a frame: the files are fetched from
 * the moment the page starts and decoded in an offline context, which browsers allow before the
 * first click, off the main thread. What the pilot hears first is loaded first. A sound that is
 * asked for before it is decoded is simply not there yet: the stage starts a loop when its buffer
 * arrives and drops a one-shot whose moment has passed.
 */

/** One shipped sound, as `packages/client/public/audio/manifest.json` lists it. */
export interface ShippedSound {
  id: string;
  /** File name next to the manifest. */
  file: string;
  /** The event of the sound list this sound is or stands for; null for a download adopted for a role. */
  event: string | null;
  roles: string[];
  kind: 'loop' | 'oneshot' | 'ir';
  path: 'structure' | 'cabin' | 'sensor' | 'radio' | 'energy';
  /** True for a sound that is put into the cabin by the stage; false when the cabin is in the file. */
  dry?: boolean;
  channels: number;
  gain?: number;
  /** Direction in degrees (0 ahead, 90 right, -90 left, 180 behind), or 'event' when the game decides each time. */
  place?: number | 'event';
  /** Seconds after its start at which the next sound of a chain starts. */
  cue?: number;
  family?: string | null;
  params?: { thrust?: number } & Record<string, unknown>;
  frames: number;
  duration: number;
  /** Integrated loudness and true peak of the file as the library measured them. */
  lufs?: number;
  peakDb?: number;
  /** How the owner approved it: fits, stars, fits-older, stars-older, candidate (see `tools/audio/ship.py`). */
  approval: string;
}

export interface ShippedManifest {
  version: number;
  sounds: ShippedSound[];
  /** Event -> ids of the sounds that are it or stand for it. */
  events: Record<string, string[]>;
  /** Event without an approved sound of its own -> the event whose sounds it plays. */
  standIn: Record<string, string>;
  /** Role of an adopted download -> sound ids. */
  roles: Record<string, string[]>;
  /** Events and roles that have nothing approved, with the reason. They make no sound. */
  silent: Record<string, string>;
}

/** The public directory is at the root in development for every page, and next to the page in a build. */
const ROOT = import.meta.env?.DEV ? '/' : './';
const SAMPLE_RATE = 48000;
/** How many files are fetched and decoded at once. */
const PARALLEL = 3;

/**
 * What a flight needs from its first second, in this order: the room, the cabin, the engine and
 * the thrusters. Everything else follows in the order of the manifest.
 */
const FIRST: readonly string[] = [
  'cabin_ir', 'cabin_ambience_loop', 'engine_main_t000', 'engine_main_t025', 'engine_main_t050', 'engine_main_t075',
  'engine_main_t100', 'engine_main_boost', 'thruster_pulse_c', 'thruster_burn_loop', 'silent_running_loop',
];

/** The ids of an event's sounds, through a stand-in where the event has none of its own. */
export function soundsOf(manifest: ShippedManifest, event: string): string[] {
  return manifest.events[event] ?? manifest.events[manifest.standIn[event] ?? ''] ?? manifest.roles[event] ?? [];
}

/** The order in which the files are loaded: `FIRST` (events, in that order), then the rest as listed. */
export function loadOrder(manifest: ShippedManifest): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const ev of FIRST) for (const id of soundsOf(manifest, ev)) add(id);
  for (const s of manifest.sounds) add(s.id);
  return out;
}

export class Library {
  manifest: ShippedManifest | null = null;
  /** Why nothing could be loaded, when that is so; the game is silent then. */
  error: string | null = null;
  private byId = new Map<string, ShippedSound>();
  private buffers = new Map<string, AudioBuffer>();
  private waiting = new Map<string, ((b: AudioBuffer) => void)[]>();
  private started = false;

  /** Starts loading; safe to call again. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const r = await fetch(`${ROOT}audio/manifest.json`);
      if (!r.ok) throw new Error(`audio/manifest.json: ${r.status}`);
      const manifest = (await r.json()) as ShippedManifest;
      this.byId = new Map(manifest.sounds.map((s) => [s.id, s]));
      this.manifest = manifest;
      const off = new OfflineAudioContext(2, 1, SAMPLE_RATE);
      const queue = loadOrder(manifest);
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.load(off, id);
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      console.warn('audio: the sounds could not be loaded, the game stays silent:', this.error);
    }
  }

  private async load(off: OfflineAudioContext, id: string): Promise<void> {
    const s = this.byId.get(id);
    if (!s) return;
    try {
      const r = await fetch(`${ROOT}audio/${s.file}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const buf = await off.decodeAudioData(await r.arrayBuffer());
      this.buffers.set(id, buf);
      for (const cb of this.waiting.get(id) ?? []) cb(buf);
      this.waiting.delete(id);
    } catch (e) {
      // One missing file leaves one sound silent.
      console.warn(`audio: ${s.file} could not be loaded:`, e);
    }
  }

  sound(id: string): ShippedSound | undefined {
    return this.byId.get(id);
  }

  /** The decoded file, when it is there. */
  buffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  /** Calls back once the file is decoded: at once when it is, later when it arrives, never when it fails. */
  whenLoaded(id: string, cb: (b: AudioBuffer) => void): void {
    const b = this.buffers.get(id);
    if (b) cb(b);
    else this.waiting.set(id, [...(this.waiting.get(id) ?? []), cb]);
  }

  /** The sounds of an event (or role) that are decoded, in the order of the manifest. */
  ready(event: string): ShippedSound[] {
    if (!this.manifest) return [];
    const out: ShippedSound[] = [];
    for (const id of soundsOf(this.manifest, event)) {
      const s = this.byId.get(id);
      if (s && this.buffers.has(id)) out.push(s);
    }
    return out;
  }

  /** How many files are decoded, of how many: for the debug hook. */
  progress(): { loaded: number; total: number } {
    return { loaded: this.buffers.size, total: this.byId.size };
  }
}
