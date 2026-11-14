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
} from './scenes.ts';

const TICK_MS = 50;
const AUDIBLE = 0.002;

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
  resetPeak(): void;
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

  private group: GroupVoice | null = null;
  private loops = new Map<string, LoopVoice>();
  private timer = 0;
  private last = 0;
  private scriptIndex = 0;
  private repeatAcc = new Map<string, number>();
  private starting = false;

  constructor(readonly def: SceneDef) {
    this.state = signal(initialState(def));
  }

  /** Called when the manifest is known. */
  refreshMissing(): void {
    const out = sceneSoundIds(this.def).filter((id) => !engine.get(id));
    if (!this.familyMembers().length) out.unshift(this.def.thrustFamily);
    this.missing.value = out;
  }

  private familyMembers() {
    return engine.all().filter((s) => s.family === this.def.thrustFamily && s.kind === 'loop' && typeof s.params?.thrust === 'number');
  }

  patch(p: Partial<SceneState>): void {
    this.state.value = { ...this.state.value, ...p };
  }

  setParam(name: Param, v: number): void {
    this.patch({ [name]: v });
  }

  async startLive(): Promise<void> {
    if (this.live.value || this.starting) return;
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

  stopLive(): void {
    window.clearInterval(this.timer);
    this.live.value = false;
    this.scripted.value = false;
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
      this.stopLive();
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

  private shot(id: string | string[], gain: number): void {
    const pick = Array.isArray(id) ? id[Math.floor(Math.random() * id.length)] : id;
    const sound = engine.get(pick);
    if (sound) void engine.play(sound, { gain });
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
    const s = this.state.value;
    for (const sh of ev.shots ?? []) {
      const gain = sh.gain?.(s) ?? 1;
      if (sh.at) window.setTimeout(() => this.shot(sh.id, gain), (sh.at * 1000) / (this.scripted.value ? Math.max(0.1, hooks().speed) : 1));
      else this.shot(sh.id, gain);
    }
  }

  /** Makes sure the first press of an event button has its sound ready, without starting the loops. */
  prepare(): void {
    void engine.preload(sceneSoundIds(this.def));
  }
}

export const runners: SceneRunner[] = SCENES.map((d) => new SceneRunner(d));
