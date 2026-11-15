import { signal } from '@preact/signals';
import { CHAIN_OVERLAP } from './scenes.ts';
import type { ManifestSound } from './types.ts';

// Web Audio graph of the audition page.
//
//   every voice: source -> gain -> stage (place) -> one of the inputs below
//   baked sounds (structure, cabin) -> bakedIn -+-> bus
//                                               +-> small send ---+
//   dry sounds (sensor, alarm, radio) -> dryIn -+-> direct gain -> bus
//                                               +-> large send ---+
//   radio and "via radio" sounds -> radioIn -> filter chain -> dryIn
//   both sends -> cabin_ir (two channels) -> bus
//   bus -> mono mix (Mono setting only) -> volume -> pre-limiter -> [limiter -> make-up cancel] -> analyser -> destination
//
// The stage puts a one-channel sound at a direction: equal-power panning (a source behind is panned like its mirror
// image ahead and is duller) for loudspeakers, an HRTF panner on a circle of 1.5 m for headphones. Files with two
// channels are never moved: they play as they are, and in Mono as their sum.
//
// The limiter is a safety limiter that leaves everything below its threshold alone: a DynamicsCompressorNode set as a
// limiter, followed by a gain that cancels the node's built-in make-up gain. That make-up gain is measured once at
// start-up in an OfflineAudioContext, not taken from a formula. The game's audio will be rebuilt on this graph.

const LIB = '/audio-lib/render/';
const SQUELCH_OPEN = 'radio_squelch_open';
const SQUELCH_CLOSE = 'radio_squelch_close';
const FADE = 0.03;
/**
 * How long the nodes that place a voice (the low-pass of the loudspeaker stage, the HRTF panner of the headphone
 * stage) stay connected after the source has ended, in milliseconds. The panner holds what it was given for some
 * milliseconds; cut off at the very moment the source ends, the end of a sound that is not silent there came out as
 * a click in Headphones (found with the control sound whose last sample is at half scale).
 */
const PLACEMENT_TAIL_MS = 250;
/** How far ahead of the audio clock a sound is scheduled when it has no start time of its own, in seconds. */
export const START_LEAD = 0.03;
/**
 * How far ahead a group of sounds that must keep their spacing (a chain) is planned, in seconds. It is larger than
 * START_LEAD by a margin: engine.play moves a start that lies nearer than START_LEAD to the audio clock, and a plan made
 * on exactly START_LEAD was overtaken by the clock between planning and playing, so that the first sound was pushed
 * later while the second kept its planned time and the spacing between them shrank.
 */
export const PLAN_LEAD = START_LEAD + 0.07;
/** Fade-in of a voice whose buffer does not start on silence, in seconds. */
const EDGE_IN = 0.003;
/** Fade-out before the end of a one-shot buffer that does not end on silence, in seconds. */
const EDGE_OUT = 0.005;
/** A first or last sample below this magnitude (about -54 dBFS) counts as silence. */
const SILENT = 0.002;
/** The limiter: threshold in dB, knee, ratio, attack and release in seconds. */
const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

/** Whether a buffer starts and ends on silence; a voice fades in or out only where it does not. */
export function bufferEdges(buf: AudioBuffer): { startSilent: boolean; endSilent: boolean } {
  let startSilent = true;
  let endSilent = true;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    if (d.length === 0) continue;
    if (Math.abs(d[0]) > SILENT) startSilent = false;
    if (Math.abs(d[d.length - 1]) > SILENT) endSilent = false;
  }
  return { startSilent, endSilent };
}

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

export type StageMode = 'mono' | 'stereo' | 'headphones';

/** Distance of a source from the listener's head in the headphone setting, in metres. */
export const HEADPHONE_RADIUS = 1.5;
/** Share of the room send that a sound with the cabin already baked in gets, compared with a dry sound. */
export const BAKED_SEND = 0.25;
/** How much of a dry sound stays direct with the room fully open (the rest is the room). */
const DRY_DIRECT_FLOOR = 0.3;

/** Degrees folded into -180 .. 180 (0 ahead, 90 right, -90 left, 180 behind). */
export function wrapDegrees(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Pan position -1 (left) .. 1 (right) of a direction; a source behind pans like its mirror image ahead. */
export function stagePan(azimuth: number): number {
  const a = wrapDegrees(azimuth);
  const front = Math.abs(a) > 90 ? Math.sign(a) * (180 - Math.abs(a)) : a;
  return Math.sin((front * Math.PI) / 180);
}

/** Low-pass corner of a source in Hz: open ahead and to the sides, closing to 3.5 kHz straight behind. */
export function behindCutoff(azimuth: number): number {
  const a = Math.abs(wrapDegrees(azimuth));
  if (a <= 90) return 20000;
  return 20000 * Math.pow(3500 / 20000, (a - 90) / 90);
}

/** Position on the circle around the listener, who faces -z with +x to the right. */
export function headphonePosition(azimuth: number): { x: number; z: number } {
  const r = (wrapDegrees(azimuth) * Math.PI) / 180;
  return { x: HEADPHONE_RADIUS * Math.sin(r), z: -HEADPHONE_RADIUS * Math.cos(r) };
}

/** A voice's place in the stage; rebuilt when the stage setting changes while it is running. */
interface Placement {
  rebuild(): void;
  dispose(): void;
}

export function soundUrl(file: string): string {
  return new URL(file, location.origin + LIB).pathname;
}

function configureLimiter(c: DynamicsCompressorNode): void {
  c.threshold.value = LIMITER.threshold;
  c.knee.value = LIMITER.knee;
  c.ratio.value = LIMITER.ratio;
  c.attack.value = LIMITER.attack;
  c.release.value = LIMITER.release;
}

class Engine {
  /** Ids with at least one voice running; the page marks these rows. */
  readonly playing = signal<ReadonlySet<string>>(new Set());
  readonly irLoaded = signal(false);
  /** Gain reduction of the limiter in dB (0 or negative), for the meter. */
  limiterReduction = 0;
  /** The compressor node's own make-up gain in dB, measured at start-up; the gain after it cancels exactly this. */
  readonly limiterMakeupDb = signal(0);

  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private volume!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private limiterComp!: GainNode;
  private preLimiter!: GainNode;
  private limiterRouted: boolean | null = null;
  private edgeCache = new WeakMap<AudioBuffer, { startSilent: boolean; endSilent: boolean }>();
  private analyser!: AnalyserNode;
  private monoMix!: GainNode;
  private dryIn!: GainNode;
  private dryDirect!: GainNode;
  private dryWet!: GainNode;
  private bakedIn!: GainNode;
  private bakedSend!: GainNode;
  private convolver!: ConvolverNode;
  private analyserL!: AnalyserNode;
  private analyserR!: AnalyserNode;
  private placements = new Set<Placement>();
  private radioIn!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private soundsById = new Map<string, ManifestSound>();
  /** Length of each decoded file in seconds, exact to the sample, so that passes laid end to end meet exactly. */
  private decoded = new Map<string, number>();
  private counts = new Map<string, number>();
  private meterBuf = new Float32Array(2048);
  private opts = { volume: 0.7, cabin: true, limiter: true, radio: true, room: 1 };
  /** The stage setting; Stereo is the default because the game's output is two loudspeakers or headphones. */
  readonly stage = signal<StageMode>('stereo');
  /** Peaks of the last ~43 ms per output channel, linear, for the tests. */
  peakL = 0;
  peakR = 0;
  private ready: Promise<void> = Promise.resolve();

  /** Real length in seconds of files whose manifest entry says 0 (downloads are not measured by the build). */
  readonly measured = signal<Readonly<Record<string, number>>>({});

  setSounds(sounds: ManifestSound[]): void {
    this.soundsById = new Map(sounds.map((s) => [s.id, s]));
    this.buffers.clear();
    this.decoded.clear();
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
    return this.decoded.get(s.id) ?? (s.duration > 0 ? s.duration : (this.measured.value[s.id] ?? 0));
  }

  /** Seconds after a sound's start at which the next sound of a chain starts: its cue, else 20 ms before its end. */
  cueOf(s: ManifestSound): number {
    const len = this.lengthOf(s);
    return typeof s.cue === 'number' && s.cue > 0 && s.cue < len ? s.cue : Math.max(0, len - CHAIN_OVERLAP);
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
    this.monoMix = ctx.createGain();
    this.volume = ctx.createGain();
    // Always two channels out, so that a mono mix reaches both ears equally and the channel meters see both.
    this.volume.channelCount = 2;
    this.volume.channelCountMode = 'explicit';
    this.preLimiter = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    configureLimiter(this.limiter);
    this.limiterComp = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.connect(ctx.destination);
    const split = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = 2048;
    this.analyserR.fftSize = 2048;
    this.analyser.connect(split);
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);
    this.bus.connect(this.monoMix).connect(this.volume);

    this.dryIn = ctx.createGain();
    this.dryDirect = ctx.createGain();
    this.dryWet = ctx.createGain();
    this.bakedIn = ctx.createGain();
    this.bakedSend = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.dryIn.connect(this.dryDirect).connect(this.bus);
    this.dryIn.connect(this.dryWet).connect(this.convolver);
    this.bakedIn.connect(this.bus);
    this.bakedIn.connect(this.bakedSend).connect(this.convolver);
    this.convolver.connect(this.bus);

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
    this.ready = Promise.all([this.loadIr(), this.measureLimiter()]).then(() => undefined);
    void ctx.resume();
    return ctx;
  }

  /** Measures the compressor's make-up gain with a 1 kHz sine at -20 dBFS (far below the threshold) and cancels it. */
  private async measureLimiter(): Promise<void> {
    try {
      const rate = 48000;
      const off = new OfflineAudioContext(1, rate, rate);
      const buf = off.createBuffer(1, rate, rate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / rate);
      const src = off.createBufferSource();
      src.buffer = buf;
      const comp = off.createDynamicsCompressor();
      configureLimiter(comp);
      src.connect(comp).connect(off.destination);
      src.start();
      const out = (await off.startRendering()).getChannelData(0);
      let sIn = 0;
      let sOut = 0;
      // The second half only: the compressor has settled and its pre-delay has passed.
      for (let i = rate / 2; i < rate; i++) {
        sIn += d[i] * d[i];
        sOut += out[i] * out[i];
      }
      const gain = Math.sqrt(sOut / sIn);
      if (Number.isFinite(gain) && gain > 0.1 && gain < 10) {
        this.limiterComp.gain.value = 1 / gain;
        this.limiterMakeupDb.value = 20 * Math.log10(gain);
      }
    } catch {
      // Without a measurement the compensation stays at 1; the check reports the gain it finds.
    }
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
    const sends = this.sendLevels();
    this.dryDirect.gain.setTargetAtTime(sends.dryDirect, now, 0.03);
    this.dryWet.gain.setTargetAtTime(sends.dryWet, now, 0.03);
    this.bakedSend.gain.setTargetAtTime(sends.bakedSend, now, 0.03);
    this.monoMix.channelCount = this.stage.value === 'mono' ? 1 : 2;
    this.monoMix.channelCountMode = this.stage.value === 'mono' ? 'explicit' : 'max';
    // Rewired only when the limiter is switched, so that moving a slider never touches the signal path.
    if (this.limiterRouted !== this.opts.limiter) {
      this.limiterRouted = this.opts.limiter;
      this.volume.disconnect();
      this.preLimiter.disconnect();
      this.limiter.disconnect();
      this.limiterComp.disconnect();
      this.volume.connect(this.preLimiter);
      if (this.opts.limiter) this.preLimiter.connect(this.limiter).connect(this.limiterComp).connect(this.analyser);
      else this.preLimiter.connect(this.analyser);
    }
  }

  /** The node whose output is what the destination receives (after the limiter), for the test recorder. */
  get tap(): AudioNode {
    this.ensure();
    return this.analyser;
  }

  get context(): AudioContext {
    return this.ensure();
  }

  /** Waits until the room and the limiter measurement are ready. */
  async settled(): Promise<void> {
    this.ensure();
    await this.ready;
  }

  /** Test hook: a sine of linear amplitude `amp` fed in just ahead of the limiter, from `when` for `seconds`. */
  injectTone(amp: number, freq: number, when: number, seconds: number): void {
    const ctx = this.ensure();
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = amp;
    osc.connect(g).connect(this.preLimiter);
    osc.start(when);
    osc.stop(when + seconds);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  /** Whether a buffer starts and ends on silence (cached). */
  edgesOf(buf: AudioBuffer): { startSilent: boolean; endSilent: boolean } {
    let e = this.edgeCache.get(buf);
    if (!e) this.edgeCache.set(buf, (e = bufferEdges(buf)));
    return e;
  }

  setVolume(v: number): void {
    this.opts.volume = v;
    this.applyOptions();
  }
  setRoom(v: number): void {
    this.opts.room = Math.min(1, Math.max(0, v));
    this.applyOptions();
  }
  setStage(mode: StageMode): void {
    if (this.stage.value === mode) return;
    this.stage.value = mode;
    this.applyOptions();
    for (const p of this.placements) p.rebuild();
  }
  /**
   * The levels the room sends are set to (also read by the tests). A loudspeaker in the cabin is mostly the room, so
   * a dry sound keeps only a little direct level; a sound with the cabin baked in is heard in the seat already, so a
   * small send only gives it width, not a second reverb.
   */
  sendLevels(): { dryDirect: number; dryWet: number; bakedSend: number } {
    const cabinOn = this.opts.cabin && this.irLoaded.value;
    const room = this.opts.room;
    return {
      dryDirect: cabinOn ? 1 - (1 - DRY_DIRECT_FLOOR) * room : 1,
      dryWet: cabinOn ? room : 0,
      bakedSend: cabinOn ? BAKED_SEND * room : 0,
    };
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
    this.peakL = this.channelPeak(this.analyserL);
    this.peakR = this.channelPeak(this.analyserR);
    this.limiterReduction = this.opts.limiter ? this.limiter.reduction : 0;
    return peak;
  }

  private channelPeak(a: AnalyserNode): number {
    a.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]));
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
        .then((a) => ctx.decodeAudioData(a))
        .then((b) => {
          this.decoded.set(sound.id, b.duration);
          return b;
        });
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
    return sound.dry || sound.path === 'radio' ? this.dryIn : this.bakedIn;
  }

  /** Where a one-channel sound sits: the scene's direction, else the sound's own place, else a new random one. */
  private azimuthFor(sound: ManifestSound, direction?: number): number {
    if (direction !== undefined) return wrapDegrees(direction);
    if (typeof sound.place === 'number') return wrapDegrees(sound.place);
    return Math.random() * 360 - 180;
  }

  /**
   * Puts the voice's gain node into the stage. A file with two channels goes through untouched; one with a single
   * channel is panned for loudspeakers or placed with an HRTF panner for headphones, and left alone in Mono.
   */
  private place(g: GainNode, out: AudioNode, multi: boolean, azimuth: number): Placement {
    const ctx = this.ctx as AudioContext;
    let nodes: AudioNode[] = [];
    const rebuild = (): void => {
      g.disconnect();
      for (const n of nodes) n.disconnect();
      nodes = [];
      const mode = this.stage.value;
      if (multi || mode === 'mono') {
        g.connect(out);
      } else if (mode === 'stereo') {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = behindCutoff(azimuth);
        lp.Q.value = 0.5;
        // A balance law, not the browser's equal-power panner: a source straight ahead plays at the file's own
        // level on both sides, as it does in Mono and as the level table of the sound files assumes, and no side
        // ever gets more than the file holds. The equal-power panner put every centred point source 3 dB under
        // the two-channel beds, which shifted the balance the owner judges.
        const p = stagePan(azimuth);
        const left = ctx.createGain();
        left.gain.value = Math.min(1, 1 - p);
        const right = ctx.createGain();
        right.gain.value = Math.min(1, 1 + p);
        const merge = ctx.createChannelMerger(2);
        g.connect(lp);
        lp.connect(left).connect(merge, 0, 0);
        lp.connect(right).connect(merge, 0, 1);
        merge.connect(out);
        nodes = [lp, left, right, merge];
      } else {
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'inverse';
        // Reference distance equal to the radius: no level change from distance, only the direction is heard.
        p.refDistance = HEADPHONE_RADIUS;
        const pos = headphonePosition(azimuth);
        p.positionX.value = pos.x;
        p.positionY.value = 0;
        p.positionZ.value = pos.z;
        g.connect(p).connect(out);
        nodes = [p];
      }
    };
    rebuild();
    const placement: Placement = {
      rebuild,
      dispose: () => {
        g.disconnect();
        for (const n of nodes) n.disconnect();
        nodes = [];
        this.placements.delete(placement);
      },
    };
    this.placements.add(placement);
    return placement;
  }

  /** Plays a sound. A loop runs until stop() is called; a one-shot ends by itself. */
  async play(
    sound: ManifestSound,
    opts: {
      gain?: number;
      viaRadio?: boolean;
      when?: number;
      direction?: number;
      once?: boolean;
      /** This pass continues the one before it exactly (same periodic file): no fade-in, an exact butt joint. */
      joinIn?: boolean;
      /** The next pass continues this one exactly: no fade-out. */
      joinOut?: boolean;
      /** Length in seconds of the fade-in / fade-out used where the buffer does not start / end on silence. */
      fadeIn?: number;
      fadeOut?: number;
    } = {},
  ): Promise<Voice | null> {
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
    // `once` plays one pass of a loop file, for a chain that lays the passes end to end.
    const loop = sound.kind === 'loop' && !opts.once;
    const multi = buf.numberOfChannels > 1;
    const azimuth = this.azimuthFor(sound, opts.direction);
    const squelchOpen = radio ? this.soundsById.get(SQUELCH_OPEN) : undefined;
    const squelchClose = radio ? this.soundsById.get(SQUELCH_CLOSE) : undefined;

    // An explicit `when` (audio clock) is kept exactly, so that chained one-shots overlap by the planned amount.
    // The lead must outlast the staleness of currentTime (it moves with the audio callbacks, about 10 ms apart): a start
    // and its fade-in scheduled in the past are applied at once, and a loud first sample then comes in without the fade.
    const t0 = Math.max(opts.when ?? 0, ctx.currentTime + START_LEAD);
    const lead = squelchOpen ? squelchOpen.duration * 0.7 : 0;
    const start = t0 + lead;
    // Test hook: when each sound was scheduled to start and to end on the audio clock.
    // `gain` is the most the page does to a sample of this file, for telling a step of the file from one of the page: the
    // voice level and the volume (the stage law never raises a side, the limiter only lowers; a radio signal passes a
    // waveshaper whose slope is about 2.3 near zero).
    const playRecord = this.logPlay(sound.id, start, loop ? Infinity : start + buf.duration, multi ? null : azimuth, buf.duration, level * this.opts.volume * (radio ? 2.5 : 1));

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = ctx.createGain();
    // The gain of a new voice is 0 from the start, not the node's default of 1: whether the gain events or the source
    // start comes first on a frame depends on the last bit of the start time in floating point (measured: about one
    // start time in seven at a lead of 30 ms), and a source whose first frame meets the default gain plays that sample
    // at full level, which is a click for any file that does not start on zero.
    g.gain.value = 0;
    // A loop fades in over FADE. A one-shot (or one pass of a loop file) starts untouched when its buffer starts on
    // silence, else with a short fade, so that a first sample away from zero never clicks; the end is treated alike.
    const edges = this.edgesOf(buf);
    const rampEnd = start + (loop ? FADE : 0);
    const fadeIn = loop ? FADE : opts.joinIn || edges.startSilent ? 0 : Math.min(Math.max(opts.fadeIn ?? EDGE_IN, 0.001), buf.duration / 2);
    const fadeOut = loop || opts.joinOut || edges.endSilent ? 0 : Math.min(Math.max(opts.fadeOut ?? EDGE_OUT, 0.001), buf.duration / 2);
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0, t0);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(level, start + fadeIn);
    } else {
      g.gain.setValueAtTime(level, t0);
    }
    if (fadeOut > 0) {
      const end = start + buf.duration;
      g.gain.setValueAtTime(level, end - fadeOut);
      g.gain.linearRampToValueAtTime(0, end);
    }
    src.connect(g);
    const placement = this.place(g, this.outputFor(sound, viaRadio), multi, azimuth);
    src.start(start);

    let hiss: AudioBufferSourceNode | null = null;
    let hissGain: GainNode | null = null;
    if (radio) {
      hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer;
      hiss.loop = true;
      hissGain = ctx.createGain();
      hissGain.gain.value = 0;
      // Ramped in and out, so that the hiss does not start or stop with a step.
      hissGain.gain.setValueAtTime(0, start);
      hissGain.gain.linearRampToValueAtTime(0.012, start + 0.005);
      if (!loop) {
        hissGain.gain.setValueAtTime(0.012, start + buf.duration + 0.04);
        hissGain.gain.linearRampToValueAtTime(0, start + buf.duration + 0.05);
      }
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
      window.setTimeout(() => {
        src.disconnect();
        placement.dispose();
      }, PLACEMENT_TAIL_MS);
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
        // Never inside the fade-in ramp: a target curve that starts in the middle of a ramp makes the gain jump.
        if (!stopped) g.gain.setTargetAtTime(v * (sound.gain ?? 1), Math.max(ctx.currentTime, rampEnd), 0.05);
      },
      stop: () => {
        if (stopped) return;
        const now = ctx.currentTime;
        playRecord.end = Math.min(playRecord.end, now + FADE + 0.01);
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

  /** Test hook: when each sound was scheduled to start and to end on the audio clock. */
  private logPlay(id: string, start: number, end: number, azimuth: number | null, length: number, gain?: number): { end: number } {
    // `loop` is kept apart from `end`, which is shortened when the voice is stopped: the recorder needs to know that the
    // file went round, also for a loop that has been stopped by the time the recording is looked at.
    const record = { id, start, end, azimuth, length, loop: end === Infinity, gain };
    const w = window as unknown as { __audition?: { plays?: (typeof record)[] } };
    if (w.__audition) {
      const plays = (w.__audition.plays ??= []);
      plays.push(record);
      if (plays.length > 4000) plays.shift();
    }
    return record;
  }

  /** Fire-and-forget one-shot on the radio path, used for the squelch ends. */
  private async fire(sound: ManifestSound, when: number, gain: number): Promise<void> {
    const ctx = this.ensure();
    try {
      const buf = await this.buffer(sound);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0;
      const level = gain * (sound.gain ?? 1);
      const at = Math.max(when, ctx.currentTime);
      const edges = this.edgesOf(buf);
      if (edges.startSilent) g.gain.setValueAtTime(level, at);
      else {
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(level, at + EDGE_IN);
      }
      if (!edges.endSilent) {
        const fo = Math.min(EDGE_OUT, buf.duration / 2);
        g.gain.setValueAtTime(level, at + buf.duration - fo);
        g.gain.linearRampToValueAtTime(0, at + buf.duration);
      }
      this.logPlay(sound.id, at, at + buf.duration, null, buf.duration, level * this.opts.volume * 2.5);
      src.connect(g).connect(this.opts.radio ? this.radioIn : this.dryIn);
      src.start(at);
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
    // The levels are one engine and crossfade, so they must share one place (ahead unless the list says otherwise).
    const first = sorted[0]?.place;
    const azimuth = typeof first === 'number' ? wrapDegrees(first) : 0;
    const nodes = sorted.map((s, i) => {
      const src = ctx.createBufferSource();
      src.buffer = bufs[i];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      const placement = this.place(g, this.outputFor(s, false), bufs[i].numberOfChannels > 1, azimuth);
      src.start(when);
      const record = this.logPlay(s.id, when, Infinity, azimuth, bufs[i].duration);
      this.count(s.id, 1);
      return { src, g, sound: s, placement, record };
    });
    const state: GroupVoice['levels'] = sorted.map((s, i) => ({ id: s.id, thrust: points[i], gain: 0 }));
    let lastThrust = thrust;
    let stopped = false;
    const apply = (): void => {
      const w = crossfadeWeights(points, lastThrust);
      nodes.forEach((n, i) => {
        state[i].gain = w[i] * master * (n.sound.gain ?? 1);
        // Never before the moment the sources start: the gain is held at 0 until then, so the rise begins together with
        // the sound, not a part of it earlier (loops start in the middle of a wave and would begin on a step).
        n.g.gain.setTargetAtTime(state[i].gain, Math.max(ctx.currentTime, when), 0.03);
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
          n.record.end = Math.min(n.record.end, now + FADE + 0.01);
          n.g.gain.cancelScheduledValues(now);
          n.g.gain.setValueAtTime(n.g.gain.value, now);
          n.g.gain.linearRampToValueAtTime(0, now + FADE);
          n.src.stop(now + FADE + 0.01);
          n.src.onended = () => {
            window.setTimeout(() => {
              n.src.disconnect();
              n.placement.dispose();
            }, PLACEMENT_TAIL_MS);
          };
          this.count(n.sound.id, -1);
        }
      },
    };
  }
}

export const engine = new Engine();
