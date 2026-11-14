import { signal } from '@preact/signals';
import type { ManifestSound } from './types.ts';

// Web Audio graph of the audition page.
//
//   structure / cabin sounds ------------------------------------> bus
//   sensor / alarm / radio (dry) -> dryIn -+-> direct gain --------> bus
//                                          +-> cabin_ir -> wet ----> bus
//   radio and "via radio" sounds -> radioIn -> filter chain -> dryIn
//   bus -> volume -> [limiter] -> analyser -> destination
//
// The limiter is a default DynamicsCompressor like the game's, so that what is heard here is what the game will do.

const LIB = '/audio-lib/render/';
const SQUELCH_OPEN = 'radio_squelch_open';
const SQUELCH_CLOSE = 'radio_squelch_close';
const FADE = 0.03;

export interface Voice {
  sound: ManifestSound;
  setGain(g: number): void;
  stop(): void;
}

export interface GroupVoice {
  /** Target gain per level, kept readable so that the crossfade can be checked without listening. */
  levels: { id: string; thrust: number; gain: number }[];
  setThrust(t: number): void;
  setGain(g: number): void;
  stop(): void;
}

/** Equal-power weights of the levels (sorted by thrust) for a thrust value; neighbours share, the rest are zero. */
export function crossfadeWeights(points: number[], t: number): number[] {
  const w = points.map(() => 0);
  if (points.length === 0) return w;
  if (t <= points[0]) {
    w[0] = 1;
    return w;
  }
  const last = points.length - 1;
  if (t >= points[last]) {
    w[last] = 1;
    return w;
  }
  let hi = 1;
  while (points[hi] < t) hi++;
  const f = (t - points[hi - 1]) / (points[hi] - points[hi - 1]);
  w[hi - 1] = Math.cos((f * Math.PI) / 2);
  w[hi] = Math.sin((f * Math.PI) / 2);
  return w;
}

export function soundUrl(file: string): string {
  return new URL(file, location.origin + LIB).pathname;
}

class Engine {
  /** Ids with at least one voice running; the page marks these rows. */
  readonly playing = signal<ReadonlySet<string>>(new Set());
  readonly irLoaded = signal(false);
  /** Gain reduction of the limiter in dB (0 or negative), for the meter. */
  limiterReduction = 0;

  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private volume!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private analyser!: AnalyserNode;
  private dryIn!: GainNode;
  private dryDirect!: GainNode;
  private dryWet!: GainNode;
  private convolver!: ConvolverNode;
  private radioIn!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private soundsById = new Map<string, ManifestSound>();
  private counts = new Map<string, number>();
  private meterBuf = new Float32Array(2048);
  private opts = { volume: 0.7, cabin: true, limiter: true, radio: true };
  private ready: Promise<void> = Promise.resolve();

  /** Real length in seconds of files whose manifest entry says 0 (downloads are not measured by the build). */
  readonly measured = signal<Readonly<Record<string, number>>>({});

  setSounds(sounds: ManifestSound[]): void {
    this.soundsById = new Map(sounds.map((s) => [s.id, s]));
    this.buffers.clear();
    this.irLoaded.value = false;
    void this.measureUnknown(sounds.filter((s) => !(s.duration > 0)));
  }

  /** Decodes in an offline context, which needs no click, only to learn the length; one file at a time to stay light. */
  private async measureUnknown(list: ManifestSound[]): Promise<void> {
    const off = new OfflineAudioContext(1, 1, 48000);
    for (const s of list) {
      try {
        const r = await fetch(soundUrl(s.file));
        if (!r.ok) continue;
        const b = await off.decodeAudioData(await r.arrayBuffer());
        this.measured.value = { ...this.measured.value, [s.id]: b.duration };
      } catch {
        // The length stays unknown; playing the file reports the real problem.
      }
    }
  }

  /** Length of a sound: from the manifest, else measured, else 0. */
  lengthOf(s: ManifestSound): number {
    return s.duration > 0 ? s.duration : (this.measured.value[s.id] ?? 0);
  }

  /** Audio clock, for scheduling several sounds against each other without timer jitter. */
  now(): number {
    return this.ensure().currentTime;
  }

  all(): ManifestSound[] {
    return [...this.soundsById.values()];
  }

  get(id: string): ManifestSound | undefined {
    return this.soundsById.get(id);
  }

  hasCabinIr(): boolean {
    return this.soundsById.has('cabin_ir');
  }

  /** Creates the context on first use; browsers only allow that after a click. */
  private ensure(): AudioContext {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.volume = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.connect(ctx.destination);
    this.bus.connect(this.volume);

    this.dryIn = ctx.createGain();
    this.dryDirect = ctx.createGain();
    this.dryWet = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.dryIn.connect(this.dryDirect).connect(this.bus);
    this.dryIn.connect(this.convolver).connect(this.dryWet).connect(this.bus);

    // The radio loudspeaker: narrow band, a little overdrive, hiss under the signal.
    this.radioIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.7;
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 2.2) / 0.97;
    drive.curve = curve;
    drive.oversample = '2x';
    const makeup = ctx.createGain();
    makeup.gain.value = 0.9;
    this.radioIn.connect(hp).connect(lp).connect(drive).connect(makeup).connect(this.dryIn);

    // Fixed noise so that the hiss is the same on every start.
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    let s = 7919;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    this.applyOptions();
    this.ready = this.loadIr();
    void ctx.resume();
    return ctx;
  }

  private async loadIr(): Promise<void> {
    const ir = this.soundsById.get('cabin_ir');
    if (!ir || !this.ctx) return;
    try {
      this.convolver.buffer = await this.buffer(ir);
      this.irLoaded.value = true;
      this.applyOptions();
    } catch {
      this.irLoaded.value = false;
    }
  }

  private applyOptions(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.volume.gain.setTargetAtTime(this.opts.volume, now, 0.02);
    const cabinOn = this.opts.cabin && this.irLoaded.value;
    // A loudspeaker in the cabin is mostly the room: a little direct sound stays so that it keeps its edge.
    this.dryDirect.gain.setTargetAtTime(cabinOn ? 0.3 : 1, now, 0.03);
    this.dryWet.gain.setTargetAtTime(cabinOn ? 1 : 0, now, 0.03);
    this.volume.disconnect();
    this.limiter.disconnect();
    if (this.opts.limiter) this.volume.connect(this.limiter).connect(this.analyser);
    else this.volume.connect(this.analyser);
  }

  setVolume(v: number): void {
    this.opts.volume = v;
    this.applyOptions();
  }
  setCabin(on: boolean): void {
    this.opts.cabin = on;
    this.applyOptions();
  }
  setRadio(on: boolean): void {
    this.opts.radio = on;
  }
  setLimiter(on: boolean): void {
    this.opts.limiter = on;
    this.applyOptions();
  }

  /** Peak of the last ~43 ms at the output, linear; above 1 means the mix clips. */
  readPeak(): number {
    if (!this.ctx) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]));
    this.limiterReduction = this.opts.limiter ? this.limiter.reduction : 0;
    return peak;
  }

  buffer(sound: ManifestSound): Promise<AudioBuffer> {
    let p = this.buffers.get(sound.id);
    if (!p) {
      const ctx = this.ensure();
      p = fetch(soundUrl(sound.file), { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${sound.file}`);
          return r.arrayBuffer();
        })
        .then((a) => ctx.decodeAudioData(a));
      p.catch(() => this.buffers.delete(sound.id));
      this.buffers.set(sound.id, p);
    }
    return p;
  }

  async preload(ids: string[]): Promise<void> {
    this.ensure();
    await Promise.all(
      ids.map((id) => {
        const s = this.soundsById.get(id);
        return s ? this.buffer(s).catch(() => undefined) : undefined;
      }),
    );
    await this.ready;
  }

  private count(id: string, delta: number): void {
    const n = (this.counts.get(id) ?? 0) + delta;
    if (n <= 0) this.counts.delete(id);
    else this.counts.set(id, n);
    this.playing.value = new Set(this.counts.keys());
  }

  private isRadioSignal(sound: ManifestSound, viaRadio: boolean): boolean {
    return this.opts.radio && (sound.path === 'radio' || viaRadio);
  }

  private outputFor(sound: ManifestSound, viaRadio: boolean): AudioNode {
    if (this.isRadioSignal(sound, viaRadio)) return this.radioIn;
    return sound.dry || sound.path === 'radio' ? this.dryIn : this.bus;
  }

  /** Plays a sound. A loop runs until stop() is called; a one-shot ends by itself. */
  async play(sound: ManifestSound, opts: { gain?: number; viaRadio?: boolean; when?: number } = {}): Promise<Voice | null> {
    const ctx = this.ensure();
    let buf: AudioBuffer;
    try {
      buf = await this.buffer(sound);
      await this.ready;
    } catch (e) {
      console.warn('audition: cannot load', sound.id, e);
      return null;
    }
    const level = (opts.gain ?? 1) * (sound.gain ?? 1);
    const viaRadio = opts.viaRadio ?? false;
    const radio = this.isRadioSignal(sound, viaRadio) && !sound.id.startsWith('radio_squelch') && !sound.id.startsWith('radio_static');
    const loop = sound.kind === 'loop';
    const squelchOpen = radio ? this.soundsById.get(SQUELCH_OPEN) : undefined;
    const squelchClose = radio ? this.soundsById.get(SQUELCH_CLOSE) : undefined;

    // An explicit `when` (audio clock) is kept exactly, so that chained one-shots overlap by the planned amount.
    const t0 = Math.max(opts.when ?? 0, ctx.currentTime + 0.005);
    const lead = squelchOpen ? squelchOpen.duration * 0.7 : 0;
    const start = t0 + lead;
    // Test hook: when each sound was scheduled to start and to end on the audio clock.
    const w = window as unknown as { __audition?: { plays?: { id: string; start: number; end: number }[] } };
    if (w.__audition) {
      const plays = (w.__audition.plays ??= []);
      plays.push({ id: sound.id, start, end: loop ? Infinity : start + buf.duration });
      if (plays.length > 500) plays.shift();
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = ctx.createGain();
    g.gain.setValueAtTime(loop ? 0 : level, t0);
    if (loop) g.gain.linearRampToValueAtTime(level, start + FADE);
    src.connect(g).connect(this.outputFor(sound, viaRadio));
    src.start(start);

    let hiss: AudioBufferSourceNode | null = null;
    let hissGain: GainNode | null = null;
    if (radio) {
      hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer;
      hiss.loop = true;
      hissGain = ctx.createGain();
      hissGain.gain.value = 0.012;
      hiss.connect(hissGain).connect(this.radioIn);
      hiss.start(start);
    }
    if (squelchOpen) void this.fire(squelchOpen, t0, 1);

    this.count(sound.id, 1);
    let stopped = false;
    const finish = (): void => {
      if (stopped) return;
      stopped = true;
      this.count(sound.id, -1);
      src.disconnect();
      g.disconnect();
      hiss?.stop();
      hiss?.disconnect();
      hissGain?.disconnect();
    };
    if (!loop) {
      src.onended = finish;
      if (squelchClose) void this.fire(squelchClose, start + buf.duration - 0.02, 1);
      if (hiss) hiss.stop(start + buf.duration + 0.05);
    }
    return {
      sound,
      setGain: (v) => {
        if (!stopped) g.gain.setTargetAtTime(v * (sound.gain ?? 1), ctx.currentTime, 0.05);
      },
      stop: () => {
        if (stopped) return;
        const now = ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + FADE);
        src.stop(now + FADE + 0.01);
        if (loop && squelchClose) void this.fire(squelchClose, now, 1);
        src.onended = finish;
        // Stopping before the start time (during the squelch) never fires "ended".
        window.setTimeout(finish, (lead + FADE + 0.2) * 1000);
      },
    };
  }

  /** Fire-and-forget one-shot on the radio path, used for the squelch ends. */
  private async fire(sound: ManifestSound, when: number, gain: number): Promise<void> {
    const ctx = this.ensure();
    try {
      const buf = await this.buffer(sound);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = gain * (sound.gain ?? 1);
      src.connect(g).connect(this.opts.radio ? this.radioIn : this.dryIn);
      src.start(Math.max(when, ctx.currentTime));
      src.onended = () => {
        src.disconnect();
        g.disconnect();
      };
    } catch {
      // A missing squelch sound only means a transmission without squelch.
    }
  }

  /** All looped levels of a family, started together so that they stay in phase, crossfaded by thrust. */
  async playGroup(levels: ManifestSound[], thrust: number, gain = 1): Promise<GroupVoice | null> {
    const ctx = this.ensure();
    const sorted = [...levels].sort((a, b) => (a.params?.thrust ?? 0) - (b.params?.thrust ?? 0));
    let bufs: AudioBuffer[];
    try {
      bufs = await Promise.all(sorted.map((s) => this.buffer(s)));
      await this.ready;
    } catch (e) {
      console.warn('audition: cannot load group', e);
      return null;
    }
    const points = sorted.map((s) => s.params?.thrust ?? 0);
    const when = ctx.currentTime + 0.05;
    let master = gain;
    const nodes = sorted.map((s, i) => {
      const src = ctx.createBufferSource();
      src.buffer = bufs[i];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.outputFor(s, false));
      src.start(when);
      this.count(s.id, 1);
      return { src, g, sound: s };
    });
    const state: GroupVoice['levels'] = sorted.map((s, i) => ({ id: s.id, thrust: points[i], gain: 0 }));
    let lastThrust = thrust;
    let stopped = false;
    const apply = (): void => {
      const w = crossfadeWeights(points, lastThrust);
      nodes.forEach((n, i) => {
        state[i].gain = w[i] * master * (n.sound.gain ?? 1);
        n.g.gain.setTargetAtTime(state[i].gain, ctx.currentTime, 0.03);
      });
    };
    apply();
    return {
      levels: state,
      setThrust: (t) => {
        lastThrust = t;
        if (!stopped) apply();
      },
      setGain: (v) => {
        master = v;
        if (!stopped) apply();
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const now = ctx.currentTime;
        for (const n of nodes) {
          n.g.gain.cancelScheduledValues(now);
          n.g.gain.setValueAtTime(n.g.gain.value, now);
          n.g.gain.linearRampToValueAtTime(0, now + FADE);
          n.src.stop(now + FADE + 0.01);
          n.src.onended = () => {
            n.src.disconnect();
            n.g.disconnect();
          };
          this.count(n.sound.id, -1);
        }
      },
    };
  }
}

export const engine = new Engine();
