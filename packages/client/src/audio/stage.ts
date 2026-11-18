/**
 * The stage: the Web Audio graph every sound of the game is played on. It is the graph of the
 * audition page (`dev/audition/engine.ts`), on which the owner judged the sounds, so that a file
 * leaves the game at the level and in the room it had there.
 *
 *   every voice: source -> gain -> place -> one of the inputs below
 *   sounds with the cabin in the file (structure, cabin, energy) -> bakedIn -+-> bus
 *                                                                           +-> small send --+
 *   dry sounds (alarms, sensor signals, downloads)               -> dryIn  -+-> direct -> bus |
 *                                                                           +-> full send ---+
 *   radio sounds -> radioIn -> band filter, a little overdrive -> dryIn                       |
 *   both sends -> the cabin's impulse response (two channels) -> bus  <-----------------------+
 *   bus -> volume -> limiter -> gain that cancels the limiter's make-up -> analyser -> output
 *
 * A file with one channel is put at a direction (0 ahead, 90 right, -90 left, 180 behind) by a
 * balance law: straight ahead it plays at the file's own level on both sides, which is what the
 * level table of the library assumes, and no side ever gets more than the file holds. A source
 * behind is panned like its mirror image ahead and is duller. A file with two channels is never
 * moved. The limiter leaves everything below its threshold as it is.
 *
 * What the audition page taught, kept here: a new voice's gain is 0 before its start and never the
 * node's default of 1; a loop rises from zero from the moment its source starts; a one-shot whose
 * file does not begin or end on silence gets a short fade; a chain is planned from the start time
 * that was really used (`Voice.start`).
 */
import type { ShippedSound } from './library.ts';

/** How far ahead of the audio clock a sound is scheduled, in seconds: the clock moves in steps of about 10 ms. */
export const START_LEAD = 0.03;
/**
 * How far ahead a group of sounds that must keep their spacing (a transmission, a chain) is planned,
 * in seconds: more than the lead, because a start nearer than the lead is pushed later while the
 * sounds after it keep their planned times, and the spacing between them would shrink.
 */
export const PLAN_LEAD = START_LEAD + 0.07;
/** Level of the hiss under a radio signal, linear, ahead of the radio's filter. */
const RADIO_HISS = 0.012;
/** Fade of a loop that starts or of any voice that is stopped, in seconds. */
export const FADE = 0.03;
/** Fade-in of a one-shot whose buffer does not start on silence, in seconds. */
const EDGE_IN = 0.003;
/** Fade-out before the end of a one-shot buffer that does not end on silence, in seconds. */
const EDGE_OUT = 0.005;
/** A first or last sample below this magnitude (about -54 dBFS) counts as silence. */
const SILENT = 0.002;
/** The nodes that place a voice stay connected this long after its end (ms), so that their tail is not cut. */
const PLACEMENT_TAIL_MS = 250;
/** The limiter: threshold in dB, knee, ratio, attack and release in seconds. */
const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };
/** Share of the room send that a sound with the cabin already in the file gets, compared with a dry sound. */
export const BAKED_SEND = 0.25;
/** How much of a dry sound stays direct once the room is there (the rest is the room). */
export const DRY_DIRECT = 0.3;
const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

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

/** The balance law: gains of the left and right side for a direction. Never above 1; both 1 straight ahead. */
export function balance(azimuth: number): { left: number; right: number } {
  const p = stagePan(azimuth);
  return { left: Math.min(1, 1 - p), right: Math.min(1, 1 + p) };
}

/** Low-pass corner of a source in Hz: open ahead and to the sides, closing to 3.5 kHz straight behind. */
export function behindCutoff(azimuth: number): number {
  const a = Math.abs(wrapDegrees(azimuth));
  if (a <= 90) return 20000;
  return 20000 * Math.pow(3500 / 20000, (a - 90) / 90);
}

/** Equal-power weights of the levels (sorted by thrust) for a thrust value; neighbours share, the rest are zero. */
export function crossfadeWeights(points: readonly number[], t: number): number[] {
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

/** Where a one-channel sound sits: the direction the game gives, else the sound's own place, else straight ahead. */
export function azimuthOf(sound: Pick<ShippedSound, 'place'>, direction?: number): number {
  if (direction !== undefined && Number.isFinite(direction)) return wrapDegrees(direction);
  if (typeof sound.place === 'number') return wrapDegrees(sound.place);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------------

export interface PlayOpts {
  gain?: number;
  /** Start time on the audio clock; kept exactly when it lies far enough ahead. */
  when?: number;
  /** Where a one-channel sound comes from, degrees. */
  direction?: number;
  /** Plays one pass of a loop file instead of looping it. */
  once?: boolean;
  /** This pass continues the one before it exactly (same periodic file): no fade-in. */
  joinIn?: boolean;
  /** The next pass continues this one exactly: no fade-out. */
  joinOut?: boolean;
  /** Fade lengths in seconds used where the buffer does not start or end on silence. */
  fadeIn?: number;
  fadeOut?: number;
}

export interface Voice {
  readonly sound: ShippedSound;
  /** When the source starts and (for a one-shot) ends, on the audio clock. */
  readonly start: number;
  readonly end: number;
  readonly ended: boolean;
  setGain(g: number): void;
  /** Fades out over `fade` seconds and stops. */
  stop(fade?: number): void;
}

export interface GroupVoice {
  /** Target gain per level, readable so that the crossfade can be checked without listening. */
  readonly levels: { id: string; thrust: number; gain: number }[];
  set(thrust: number, gain: number): void;
  stop(fade?: number): void;
}

/** One line of the play log, for the tests and the debug hook. */
export interface PlayRecord {
  id: string;
  start: number;
  end: number;
  /** Direction of a one-channel sound, null for a file with two channels. */
  azimuth: number | null;
  loop: boolean;
  gain: number;
}

function configureLimiter(c: DynamicsCompressorNode): void {
  c.threshold.value = LIMITER.threshold;
  c.knee.value = LIMITER.knee;
  c.ratio.value = LIMITER.ratio;
  c.attack.value = LIMITER.attack;
  c.release.value = LIMITER.release;
}

/**
 * The make-up gain a compressor node set as this limiter applies by itself, measured with a 1 kHz
 * sine at -20 dBFS (far below the threshold) in an offline context. The stage cancels exactly this.
 */
export async function measureLimiterMakeup(): Promise<number> {
  try {
    const off = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const buf = off.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
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
    for (let i = SAMPLE_RATE / 2; i < SAMPLE_RATE; i++) {
      sIn += d[i] * d[i];
      sOut += out[i] * out[i];
    }
    const gain = Math.sqrt(sOut / sIn);
    return Number.isFinite(gain) && gain > 0.1 && gain < 10 ? gain : 1;
  } catch {
    return 1;
  }
}

export class Stage {
  /** Everything that was started, newest last (capped): what the browser check reads. */
  readonly plays: PlayRecord[] = [];
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private volumeNode!: GainNode;
  private limiterComp!: GainNode;
  private analyser!: AnalyserNode;
  private dryIn!: GainNode;
  private dryDirect!: GainNode;
  private dryWet!: GainNode;
  private bakedIn!: GainNode;
  private bakedSend!: GainNode;
  private radioIn!: GainNode;
  private convolver!: ConvolverNode;
  private volume = 0.7;
  private makeup = 1;
  private ir: AudioBuffer | null = null;
  private noise: AudioBuffer | null = null;
  private edges = new WeakMap<AudioBuffer, { startSilent: boolean; endSilent: boolean }>();
  private meter = new Float32Array(2048);

  /** Measures the limiter once; called when the page starts, long before the first sound. */
  async prepare(): Promise<void> {
    this.makeup = await measureLimiterMakeup();
    if (this.ctx) this.limiterComp.gain.value = 1 / this.makeup;
  }

  /** True once the context exists and runs: before that nothing can be scheduled. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** The audio clock, or 0 before the context exists. */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** The node whose output is what the loudspeakers get, for a recorder. */
  get tap(): AudioNode | null {
    return this.ctx ? this.analyser : null;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Creates the context on the first call (browsers allow that only after a click or a key) and resumes it afterwards. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      // No audio device or an unsupported browser: the game stays silent.
      return;
    }
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.volumeNode = ctx.createGain();
    // Always two channels out, so that a one-channel mix reaches both ears equally.
    this.volumeNode.channelCount = 2;
    this.volumeNode.channelCountMode = 'explicit';
    this.volumeNode.gain.value = this.volume;
    const limiter = ctx.createDynamicsCompressor();
    configureLimiter(limiter);
    this.limiterComp = ctx.createGain();
    this.limiterComp.gain.value = 1 / this.makeup;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.bus.connect(this.volumeNode).connect(limiter).connect(this.limiterComp).connect(this.analyser).connect(ctx.destination);

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

    // The radio loudspeaker: narrow band and a little overdrive.
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
    const radioLevel = ctx.createGain();
    radioLevel.gain.value = 0.9;
    this.radioIn.connect(hp).connect(lp).connect(drive).connect(radioLevel).connect(this.dryIn);

    this.applyRoom(false);
    void ctx.resume();
  }

  /** Pauses the output while the page is hidden and resumes it when it is seen again. */
  setHidden(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden && this.ctx.state === 'running') void this.ctx.suspend();
    else if (!hidden && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ctx) this.volumeNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  /** The cabin's impulse response. Until it is there, dry sounds play direct and nothing is sent to the room. */
  setRoom(ir: AudioBuffer): void {
    if (this.ir === ir) return;
    this.ir = ir;
    if (this.ctx) this.applyRoom(true);
  }

  get hasRoom(): boolean {
    return this.ctx !== null && this.convolver.buffer !== null;
  }

  private applyRoom(smooth: boolean): void {
    const ctx = this.ctx as AudioContext;
    if (this.ir && this.convolver.buffer !== this.ir) this.convolver.buffer = this.ir;
    const on = this.convolver.buffer !== null;
    const set = (p: AudioParam, v: number): void => {
      if (smooth) p.setTargetAtTime(v, ctx.currentTime, 0.03);
      else p.value = v;
    };
    set(this.dryDirect.gain, on ? DRY_DIRECT : 1);
    set(this.dryWet.gain, on ? 1 : 0);
    set(this.bakedSend.gain, on ? BAKED_SEND : 0);
  }

  /** The hiss of the radio loudspeaker under a signal, from `start` to `end` on the audio clock, ramped so that it never steps. */
  hiss(start: number, end: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !(end > start)) return;
    if (!this.noise) {
      // Fixed noise, so that the hiss is the same on every start.
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      let s = 7919;
      for (let i = 0; i < d.length; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        d[i] = (s / 4294967296) * 2 - 1;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    const from = Math.max(start, ctx.currentTime + START_LEAD);
    g.gain.setValueAtTime(0, from);
    g.gain.linearRampToValueAtTime(RADIO_HISS, from + 0.005);
    g.gain.setValueAtTime(RADIO_HISS, Math.max(from + 0.005, end - 0.01));
    g.gain.linearRampToValueAtTime(0, Math.max(from + 0.015, end));
    src.connect(g).connect(this.radioIn);
    src.start(from);
    src.stop(Math.max(from + 0.02, end + 0.01));
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  /** Peak of the last 43 ms at the output, linear. */
  readPeak(): number {
    if (!this.ctx) return 0;
    this.analyser.getFloatTimeDomainData(this.meter);
    let peak = 0;
    for (let i = 0; i < this.meter.length; i++) peak = Math.max(peak, Math.abs(this.meter[i]));
    return peak;
  }

  private edgesOf(buf: AudioBuffer): { startSilent: boolean; endSilent: boolean } {
    let e = this.edges.get(buf);
    if (!e) this.edges.set(buf, (e = bufferEdges(buf)));
    return e;
  }

  private inputFor(sound: ShippedSound): AudioNode {
    if (sound.path === 'radio') return this.radioIn;
    return sound.dry ? this.dryIn : this.bakedIn;
  }

  private log(record: PlayRecord): PlayRecord {
    this.plays.push(record);
    if (this.plays.length > 2000) this.plays.shift();
    return record;
  }

  /** Puts a voice's gain node into the stage; returns the function that takes it out again. */
  private place(g: GainNode, out: AudioNode, multi: boolean, azimuth: number): () => void {
    const ctx = this.ctx as AudioContext;
    if (multi) {
      g.connect(out);
      return () => g.disconnect();
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = behindCutoff(azimuth);
    lp.Q.value = 0.5;
    const b = balance(azimuth);
    const left = ctx.createGain();
    left.gain.value = b.left;
    const right = ctx.createGain();
    right.gain.value = b.right;
    const merge = ctx.createChannelMerger(2);
    g.connect(lp);
    lp.connect(left).connect(merge, 0, 0);
    lp.connect(right).connect(merge, 0, 1);
    merge.connect(out);
    return () => {
      g.disconnect();
      lp.disconnect();
      left.disconnect();
      right.disconnect();
      merge.disconnect();
    };
  }

  /** Plays a decoded sound. A loop runs until it is stopped; a one-shot ends by itself. Null while the context does not run. */
  play(sound: ShippedSound, buf: AudioBuffer, opts: PlayOpts = {}): Voice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const level = (opts.gain ?? 1) * (sound.gain ?? 1);
    const loop = sound.kind === 'loop' && !opts.once;
    const multi = buf.numberOfChannels > 1;
    const azimuth = azimuthOf(sound, opts.direction);
    // A start nearer than the lead would be applied late, and a loud first sample then comes in without its fade.
    const start = Math.max(opts.when ?? 0, ctx.currentTime + START_LEAD);
    const end = loop ? Infinity : start + buf.duration;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = ctx.createGain();
    // 0 from the start, not the node's default of 1: whether the gain events or the source come first on a frame
    // depends on the last bit of the start time, and a source that meets the default plays its first sample at full level.
    g.gain.value = 0;
    const edges = this.edgesOf(buf);
    const fadeIn = loop ? FADE : opts.joinIn || edges.startSilent ? 0 : Math.min(Math.max(opts.fadeIn ?? EDGE_IN, 0.001), buf.duration / 2);
    const fadeOut = loop || opts.joinOut || edges.endSilent ? 0 : Math.min(Math.max(opts.fadeOut ?? EDGE_OUT, 0.001), buf.duration / 2);
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(level, start + fadeIn);
    } else {
      g.gain.setValueAtTime(level, start);
    }
    if (fadeOut > 0) {
      g.gain.setValueAtTime(level, end - fadeOut);
      g.gain.linearRampToValueAtTime(0, end);
    }
    src.connect(g);
    const unplace = this.place(g, this.inputFor(sound), multi, azimuth);
    src.start(start);
    const record = this.log({ id: sound.id, start, end, azimuth: multi ? null : azimuth, loop, gain: level });

    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      setTimeout(() => {
        src.disconnect();
        unplace();
      }, PLACEMENT_TAIL_MS);
    };
    src.onended = finish;
    const rampEnd = start + fadeIn;
    return {
      sound,
      start,
      get end() {
        return record.end;
      },
      get ended() {
        return ended;
      },
      setGain: (v) => {
        // Never inside the fade-in ramp: a target curve that starts in the middle of a ramp makes the gain jump.
        if (!ended) g.gain.setTargetAtTime(v * (sound.gain ?? 1), Math.max(ctx.currentTime, rampEnd), 0.05);
      },
      stop: (fade = FADE) => {
        if (ended) return;
        const now = ctx.currentTime;
        const at = Math.max(now, start);
        record.end = Math.min(record.end, at + fade + 0.01);
        g.gain.cancelScheduledValues(at);
        g.gain.setValueAtTime(at > now ? 0 : g.gain.value, at);
        g.gain.linearRampToValueAtTime(0, at + fade);
        src.stop(at + fade + 0.01);
        // A voice stopped before its start never fires "ended".
        setTimeout(finish, (at - now + fade + 0.2) * 1000);
      },
    };
  }

  /**
   * All looped levels of one engine, started together so that they stay in phase, crossfaded by
   * thrust. The levels are one engine, so they share one place.
   */
  group(levels: { sound: ShippedSound; buf: AudioBuffer }[], thrust: number, gain: number): GroupVoice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || levels.length === 0) return null;
    const sorted = [...levels].sort((a, b) => (a.sound.params?.thrust ?? 0) - (b.sound.params?.thrust ?? 0));
    const points = sorted.map((l) => l.sound.params?.thrust ?? 0);
    const when = ctx.currentTime + START_LEAD + 0.02;
    const azimuth = azimuthOf(sorted[0].sound);
    const nodes = sorted.map(({ sound, buf }) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      const multi = buf.numberOfChannels > 1;
      const unplace = this.place(g, this.inputFor(sound), multi, azimuth);
      src.start(when);
      const record = this.log({ id: sound.id, start: when, end: Infinity, azimuth: multi ? null : azimuth, loop: true, gain: 1 });
      return { src, g, sound, unplace, record };
    });
    const state = sorted.map((l, i) => ({ id: l.sound.id, thrust: points[i], gain: 0 }));
    let stopped = false;
    const set = (t: number, master: number): void => {
      if (stopped) return;
      const w = crossfadeWeights(points, t);
      nodes.forEach((n, i) => {
        const target = w[i] * master * (n.sound.gain ?? 1);
        if (Math.abs(target - state[i].gain) < 1e-4) return;
        state[i].gain = target;
        // Never before the sources start: held at 0 until then, the rise begins together with the sound.
        n.g.gain.setTargetAtTime(target, Math.max(ctx.currentTime, when), 0.03);
      });
    };
    // The first setting is applied in full, also where a target is zero.
    for (const s of state) s.gain = -1;
    set(thrust, gain);
    return {
      levels: state,
      set,
      stop: (fade = FADE) => {
        if (stopped) return;
        stopped = true;
        const now = ctx.currentTime;
        const at = Math.max(now, when);
        for (const n of nodes) {
          n.record.end = Math.min(n.record.end, at + fade + 0.01);
          n.g.gain.cancelScheduledValues(at);
          n.g.gain.setValueAtTime(at > now ? 0 : n.g.gain.value, at);
          n.g.gain.linearRampToValueAtTime(0, at + fade);
          n.src.stop(at + fade + 0.01);
          n.src.onended = () => {
            setTimeout(() => {
              n.src.disconnect();
              n.unplace();
            }, PLACEMENT_TAIL_MS);
          };
        }
      },
    };
  }
}
