/**
 * Makes the stage sound like a `Mix`: starts and stops the engine group and the loops, and fires
 * the one-shots. It is the only part that knows both the shipped sounds and the audio graph.
 *
 * Nothing is queued for later. While the audio context does not run (before the first click, or
 * while the page is hidden) a mix is dropped: loops and the engine start with the first mix that
 * arrives once it runs, and a one-shot whose moment has passed is not played late.
 */
import type { Mix, Shot } from './cues.ts';
import type { Library, ShippedSound } from './library.ts';
import { FADE, type GroupVoice, type Stage, type Voice } from './stage.ts';

/** A loop below this gain is stopped, so that it starts fresh (an alarm at its first beat) next time. */
const AUDIBLE = 0.002;
/** Family of the engine levels in the manifest. */
const ENGINE_FAMILY = 'engine_main';
/** Fade of the engine when the ship is left (docking, the fold tunnel, destruction), in seconds. */
const ENGINE_OFF = 0.4;
/** Fade of a loop that ends, in seconds. */
const LOOP_OFF = 0.12;

export class Mixer {
  private engine: GroupVoice | null = null;
  private loops = new Map<string, { voice: Voice; gain: number }>();
  /** Voices of one-shots still playing, by event. */
  private shots = new Map<string, Voice[]>();
  /** The sound each event played last, so that a repeat takes another one. */
  private last = new Map<string, string>();

  constructor(private readonly library: Library, private readonly stage: Stage) {}

  apply(mix: Mix): void {
    const { library, stage } = this;
    if (!stage.running || !library.manifest) return;
    const ir = library.buffer('cabin_ir');
    if (ir) stage.setRoom(ir);

    // The engine: all levels of the family together, or not at all.
    if (mix.engine) {
      if (!this.engine) {
        const levels = this.engineLevels();
        if (levels) this.engine = stage.group(levels, mix.engine.thrust, mix.engine.gain);
      } else this.engine.set(mix.engine.thrust, mix.engine.gain);
    } else if (this.engine) {
      this.engine.stop(ENGINE_OFF);
      this.engine = null;
    }

    // Loops.
    for (const [event, entry] of this.loops) {
      if ((mix.loops[event] ?? 0) > AUDIBLE && !entry.voice.ended) continue;
      entry.voice.stop(LOOP_OFF);
      this.loops.delete(event);
    }
    for (const event in mix.loops) {
      const gain = mix.loops[event];
      if (!(gain > AUDIBLE)) continue;
      const entry = this.loops.get(event);
      if (entry) {
        if (Math.abs(entry.gain - gain) > 1e-3) {
          entry.voice.setGain(gain);
          entry.gain = gain;
        }
        continue;
      }
      const sound = library.ready(event)[0];
      const buf = sound && library.buffer(sound.id);
      if (!sound || !buf) continue;
      const voice = stage.play(sound, buf, { gain });
      if (voice) this.loops.set(event, { voice, gain });
    }

    for (const shot of mix.shots) this.fire(shot);
  }

  /** Starts one one-shot now (or after its delay). Returns the voice, or null when nothing was started. */
  fire(shot: Shot): Voice | null {
    const { library, stage } = this;
    if (!stage.running) return null;
    const now = stage.now();
    const playing = (this.shots.get(shot.event) ?? []).filter((v) => !v.ended && v.end > now);
    this.shots.set(shot.event, playing);
    if (shot.maxVoices !== undefined && playing.length >= shot.maxVoices) return null;
    const sound = this.choose(shot.event, shot.pick);
    const buf = sound && library.buffer(sound.id);
    if (!sound || !buf) return null;
    const voice = stage.play(sound, buf, {
      gain: shot.gain,
      direction: shot.direction,
      when: shot.delay ? now + shot.delay : undefined,
      // A loop file fired as a shot plays one pass.
      once: sound.kind === 'loop',
    });
    if (voice) {
      playing.push(voice);
      this.last.set(shot.event, sound.id);
    }
    return voice;
  }

  /** One of the event's decoded sounds: where there are several, never the one that played last. */
  private choose(event: string, pick: number): ShippedSound | undefined {
    let list = this.library.ready(event);
    const last = this.last.get(event);
    if (list.length > 1) list = list.filter((s) => s.id !== last);
    return list[Math.min(list.length - 1, Math.max(0, Math.floor(pick * list.length)))];
  }

  /** The engine's levels with their buffers, or null while one of them is not decoded yet. */
  private engineLevels(): { sound: ShippedSound; buf: AudioBuffer }[] | null {
    const out: { sound: ShippedSound; buf: AudioBuffer }[] = [];
    for (const sound of this.library.manifest?.sounds ?? []) {
      if (sound.family !== ENGINE_FAMILY || sound.kind !== 'loop' || typeof sound.params?.thrust !== 'number') continue;
      const buf = this.library.buffer(sound.id);
      if (!buf) return null;
      out.push({ sound, buf });
    }
    return out.length > 0 ? out : null;
  }

  /** Target gains of the engine levels, for the debug hook and the browser check. */
  engineLevelGains(): { id: string; thrust: number; gain: number }[] {
    return this.engine ? this.engine.levels.map((l) => ({ ...l })) : [];
  }

  /** The loops that are running, for the debug hook and the browser check. */
  runningLoops(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [event, entry] of this.loops) out[event] = entry.gain;
    return out;
  }

  /** Stops everything with a short fade (the menu). */
  silence(): void {
    this.engine?.stop(FADE);
    this.engine = null;
    for (const entry of this.loops.values()) entry.voice.stop(FADE);
    this.loops.clear();
  }
}
