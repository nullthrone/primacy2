import { signal, type Signal } from '@preact/signals';
import { engine, type GroupVoice, type Voice } from './engine.ts';
import {
  effectiveThrust,
  initialState,
  sampleTrack,
  SCENES,
  sceneSoundIds,
  type EventSpec,
  type Param,
  type SceneDef,
  type SceneState,
  type Shot,
} from './scenes.ts';

const TICK_MS = 50;
const AUDIBLE = 0.002;
/** Directions of the hits in turn, so that they come from changing sides (degrees, 0 ahead, 90 right, 180 behind). */
const HIT_SIDES = [-65, 70, -120, 110, -35, 40];

interface LoopVoice {
  voice: Voice | null;
  starting: boolean;
}

/** Test hooks: `speed` shortens the written sequence, `sceneRuns` tells a test when a run has reached its end. */
export interface AuditionHooks {
  speed: number;
  sceneRuns: Record<string, { started: number; ended: number }>;
  /** Output peak of the last frame and the highest since resetPeak(), linear. */
  peak: number;
  peakMax: number;
  /** The same per output channel, to hear with numbers where a sound sits. */
  peakLMax: number;
  peakRMax: number;
  resetPeak(): void;
  /** Current send levels of the room, for checking the Room slider without listening. */
  sendLevels(): { dryDirect: number; dryWet: number; bakedSend: number };
  /** Target gains of the engine group, for checking the crossfade without listening. */
  groupLevels(): { id: string; thrust: number; gain: number }[];
}

export function hooks(): AuditionHooks {
  const w = window as unknown as { __audition?: Partial<AuditionHooks> & Record<string, unknown> };
  w.__audition ??= {};
  w.__audition.speed ??= 1;
  w.__audition.sceneRuns ??= {};
  const speed = Number(new URLSearchParams(location.search).get('speed'));
  if (speed > 0 && w.__audition.speed === 1) w.__audition.speed = speed;
  return w.__audition as unknown as AuditionHooks;
}

/** Runs one scene: follows the sliders live, and can play the written sequence by moving them itself. */
export class SceneRunner {
  readonly state: Signal<SceneState>;
  readonly live = signal(false);
  readonly scripted = signal(false);
  readonly simTime = signal(0);
  readonly missing = signal<string[]>([]);
  /** Only the engine group sounds, outside a running scene, so that the thrust range can be heard alone. */
  readonly engineSolo = signal(false);

  private group: GroupVoice | null = null;
  private loops = new Map<string, LoopVoice>();
  private timer = 0;
  private last = 0;
  private scriptIndex = 0;
  private repeatAcc = new Map<string, number>();
  private starting = false;
  private sideIndex = 0;
  /** Voices and switch timers of the events fired from a button or the sequence, so that Stop can end a long chain. */
  private shotVoices = new Set<Promise<Voice | null>>();
  private shotTimers = new Set<number>();

  constructor(readonly def: SceneDef) {
    this.state = signal(initialState(def));
  }

  /** Called when the manifest is known. */
  refreshMissing(): void {
    const out = sceneSoundIds(this.def).filter((id) => !engine.get(id));
    if (this.def.thrustFamily && !this.familyMembers().length) out.unshift(this.def.thrustFamily);
    this.missing.value = out;
  }

  private familyMembers() {
    if (!this.def.thrustFamily) return [];
    return engine.all().filter((s) => s.family === this.def.thrustFamily && s.kind === 'loop' && typeof s.params?.thrust === 'number');
  }

  patch(p: Partial<SceneState>): void {
    this.state.value = { ...this.state.value, ...p };
    // The ticker only runs while the scene is live; the solo engine follows the sliders directly.
    if (this.engineSolo.value) this.group?.setThrust(effectiveThrust(this.state.value));
  }

  setParam(name: Param, v: number): void {
    this.patch({ [name]: v });
    // Moving the thrust slider in a silent scene starts the engine alone, so that it can be heard through its range.
    if (name === 'thrust' && !this.live.value && !this.engineSolo.value) void this.startEngineSolo();
  }

  async startEngineSolo(): Promise<void> {
    if (this.live.value || this.engineSolo.value || this.starting) return;
    this.engineSolo.value = true;
    this.refreshMissing();
    const members = this.familyMembers();
    if (!members.length) {
      this.engineSolo.value = false;
      return;
    }
    const g = await engine.playGroup(members, effectiveThrust(this.state.value), 1);
    // Stopped, or the scene went live, while the files were loading.
    if (!this.engineSolo.value || this.live.value) {
      g?.stop();
      return;
    }
    this.group = g;
  }

  stopEngineSolo(): void {
    this.engineSolo.value = false;
    this.group?.stop();
    this.group = null;
  }

  async startLive(): Promise<void> {
    if (this.live.value || this.starting) return;
    this.stopEngineSolo();
    this.starting = true;
    this.refreshMissing();
    const members = this.familyMembers();
    await engine.preload([...sceneSoundIds(this.def), ...members.map((m) => m.id)]);
    this.live.value = true;
    this.starting = false;
    if (members.length) this.group = await engine.playGroup(members, effectiveThrust(this.state.value), this.def.engineGain(this.state.value));
    this.last = performance.now();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  /** Ends the shots still running or scheduled (a fold chain is half a minute long) and cancels their switch changes. */
  private stopShots(): void {
    for (const id of this.shotTimers) window.clearTimeout(id);
    this.shotTimers.clear();
    for (const p of this.shotVoices) void p.then((v) => v?.stop());
    this.shotVoices.clear();
  }

  /** `hard` is false at the natural end of the written sequence, so that the last sounds ring out. */
  stopLive(hard = true): void {
    if (hard) this.stopShots();
    window.clearInterval(this.timer);
    this.live.value = false;
    this.scripted.value = false;
    this.engineSolo.value = false;
    this.group?.stop();
    this.group = null;
    for (const l of this.loops.values()) l.voice?.stop();
    this.loops.clear();
  }

  async playScript(): Promise<void> {
    this.stopLive();
    this.state.value = initialState(this.def);
    this.simTime.value = 0;
    this.scriptIndex = 0;
    this.repeatAcc.clear();
    const h = hooks();
    const run = (h.sceneRuns[this.def.id] ??= { started: 0, ended: 0 });
    run.started++;
    await this.startLive();
    this.last = performance.now();
    this.scripted.value = true;
  }

  private tick(): void {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.scripted.value) this.advanceScript(dt * Math.max(0.1, hooks().speed));
    this.updateAudio(dt * (this.scripted.value ? Math.max(0.1, hooks().speed) : 1));
  }

  private advanceScript(dt: number): void {
    const def = this.def;
    const t = this.simTime.value + dt;
    this.simTime.value = t;
    const patch: Partial<SceneState> = {};
    for (const p of ['thrust', 'heat', 'distance'] as Param[]) patch[p] = sampleTrack(def.tracks[p], t);
    this.patch(patch);
    while (this.scriptIndex < def.script.length && def.script[this.scriptIndex].t <= t) {
      const step = def.script[this.scriptIndex++];
      if (step.boost !== undefined) this.patch({ boost: step.boost });
      if (step.event) this.fire(step.event, step.on);
    }
    if (t >= def.duration) {
      hooks().sceneRuns[def.id].ended++;
      this.stopLive(false);
    }
  }

  private updateAudio(simDt: number): void {
    const s = this.state.value;
    this.group?.setThrust(effectiveThrust(s));
    this.group?.setGain(this.def.engineGain(s));

    for (const spec of this.def.loops) {
      const sound = engine.get(spec.id);
      if (!sound) continue;
      const g = spec.gain(s);
      let l = this.loops.get(spec.id);
      if (!l) this.loops.set(spec.id, (l = { voice: null, starting: false }));
      if (g > AUDIBLE && !l.voice && !l.starting) {
        l.starting = true;
        const entry = l;
        void engine.play(sound, { gain: g }).then((v) => {
          entry.starting = false;
          if (!v) return;
          if (this.live.value) entry.voice = v;
          else v.stop();
        });
      } else if (g <= AUDIBLE && l.voice) {
        // Stopped and started fresh rather than muted, so that an alarm always begins at its first beat.
        l.voice.stop();
        l.voice = null;
      } else l.voice?.setGain(g);
    }

    for (const r of this.def.repeaters) {
      const every = r.every(s);
      if (every === null) {
        this.repeatAcc.set(r.id, 0);
        continue;
      }
      const acc = (this.repeatAcc.get(r.id) ?? every) + simDt;
      if (acc >= every) {
        this.repeatAcc.set(r.id, 0);
        this.shot(r.id, r.gain?.(s) ?? 1);
      } else this.repeatAcc.set(r.id, acc);
    }
  }

  private pickId(id: string | string[]): string {
    return Array.isArray(id) ? id[Math.floor(Math.random() * id.length)] : id;
  }

  /** A single repeater shot, right now. */
  private shot(id: string | string[], gain: number): void {
    const sound = engine.get(this.pickId(id));
    if (sound) void engine.play(sound, { gain });
  }

  /**
   * The shots of one event on the audio clock: `at` is seconds after the press (shortened with the test speed),
   * a chained shot starts CHAIN_OVERLAP before the previous one ends, so that no gap opens at the fades.
   */
  private async playShots(shots: Shot[], state: SceneState): Promise<void> {
    const speed = this.scripted.value ? Math.max(0.1, hooks().speed) : 1;
    const picks = shots.map((sh) => engine.get(this.pickId(sh.id)));
    await engine.preload(picks.filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.id));
    const base = engine.now() + 0.03;
    let prevAt = 0;
    let prevLen = 0;
    let prevCue = 0;
    shots.forEach((sh, i) => {
      const sound = picks[i];
      if (!sound) return;
      const len = engine.lengthOf(sound);
      // A chained sound starts at the cue of the one before it (the manifest's, else 20 ms before its end);
      // a seamless one starts exactly at its end, so that passes of one loop meet without an overlap.
      let at = (sh.at ?? 0) / speed;
      if (sh.seamless) at = prevAt + prevLen;
      else if (sh.chain) at = Math.max(0, prevAt + prevCue);
      prevAt = at;
      prevLen = len;
      prevCue = engine.cueOf(sound);
      const voice = engine.play(sound, { gain: sh.gain?.(state) ?? 1, viaRadio: sh.viaRadio, when: base + at, direction: this.directionOf(sh), once: sh.once });
      this.shotVoices.add(voice);
      // Forgotten again once it has ended on its own, so that the set does not grow over a long session.
      void voice.then((v) => {
        if (!v) this.shotVoices.delete(voice);
        else window.setTimeout(() => this.shotVoices.delete(voice), (base + at - engine.now() + len + 2) * 1000);
      });
      if (sh.set) {
        const set = sh.set;
        // The switch follows the audio clock, so that a loop leaves with the sound that ends it.
        const id = window.setTimeout(() => {
          this.shotTimers.delete(id);
          this.patch({ on: { ...this.state.value.on, ...set } });
        }, Math.max(0, base + at - engine.now()) * 1000);
        this.shotTimers.add(id);
      }
    });
  }

  private directionOf(sh: Shot): number | undefined {
    if (sh.direction === 'alternate') return HIT_SIDES[this.sideIndex++ % HIT_SIDES.length];
    return sh.direction;
  }

  /** A button press or a step of the written sequence. `on` forces a toggle instead of flipping it. */
  fire(key: string, on?: boolean): void {
    const ev: EventSpec | undefined = this.def.events.find((e) => e.key === key);
    if (!ev) return;
    if (ev.toggle) {
      const next = on ?? !this.state.value.on[key];
      this.patch({ on: { ...this.state.value.on, [key]: next } });
      if (!this.live.value) void this.startLive();
      return;
    }
    if (ev.set) {
      this.patch({ on: { ...this.state.value.on, ...ev.set } });
      if (!this.live.value) void this.startLive();
    }
    if (ev.shots?.length) void this.playShots(ev.shots, this.state.value);
  }

  /** Makes sure the first press of an event button has its sound ready, without starting the loops. */
  prepare(): void {
    void engine.preload(sceneSoundIds(this.def));
  }
}

export const runners: SceneRunner[] = SCENES.map((d) => new SceneRunner(d));
