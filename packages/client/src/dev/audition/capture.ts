import { engine } from './engine.ts';
import { hooks } from './sceneRunner.ts';

// Test recorder of the audition page: taps the signal after the limiter (what the destination receives), keeps the
// float samples and finds clipped samples and clicks in them. Only the browser check uses it, through
// window.__audition.capture; nothing here runs unless the check asks for it.

export interface Fault {
  /** 'clip' is a sample at or above full scale; 'click' is a step that stands out from its surroundings. */
  kind: 'clip' | 'click';
  channel: number;
  /** Seconds since the capture started. */
  t: number;
  /** The magnitude of the sample (clip) or of the step (click). */
  size: number;
  /** For a click: the step divided by the 99.9th percentile of the steps in the surrounding 50 ms (its own few samples left out). */
  ratio?: number;
  /** 'file' when the same fault is in the samples of a sound that was playing, else 'page'. */
  origin: 'page' | 'file';
  /** The sounds that were playing at that moment. */
  sounds: string[];
}

type Raw = Omit<Fault, 'origin' | 'sounds'>;

export interface CaptureResult {
  seconds: number;
  /** Highest absolute sample per channel. */
  peak: number[];
  faults: Fault[];
}

/**
 * A step counts as a click when it stands far above the steps around it, so the test follows the material instead
 * of a fixed level:
 *  - ratio: the step is at least CLICK_RATIO times the 99.9th percentile of the steps in the surrounding 50 ms, with
 *    the click's own 1 ms on either side left out of that surrounding;
 *  - level: and at least CLICK_LEVEL times the RMS of the signal in the same surrounding, so that a step that is only
 *    a large part of a very quiet surrounding's tiny steps is not mistaken for one when the signal itself is large;
 *  - dust: and above CLICK_DUST (about -70 dBFS), below which nothing is looked at.
 */
export const CLICK_RATIO = 3;
export const CLICK_LEVEL = 0.5;
export const CLICK_DUST = 10 ** (-70 / 20);
/**
 * A sound file is looked at more closely than the output: the page changes its level and adds the room, so a step
 * that is below the limits in the file can be above them at the output. A step of the output counts as the file's
 * when the file has a step that passes a looser test.
 */
const FILE_RATIO = 2;
const FILE_LEVEL = CLICK_LEVEL / 4;
const FILE_DUST = CLICK_DUST / 4;
/** Half the surrounding window in samples at 48 kHz (50 ms in all). */
const HALF_WINDOW = 1200;
/** Samples around a candidate that do not count as its surroundings: a click rings for a moment (about 1 ms). */
const GUARD = 48;
/** A page fault is only blamed on a file whose own fault is not much weaker than it (a ratio is capped at this). */
const RATIO_CAP = 1000;
const FILE_RATIO_SLACK = 4;

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(8192);
    this.r = new Float32Array(8192);
    this.n = 0;
    this.first = -1;
    this.on = false;
    this.ack = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.first = -1; this.n = 0; this.ack = true; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n === 0) return;
    const l = this.l.slice(0, this.n);
    const r = this.r.slice(0, this.n);
    this.port.postMessage({ frame: this.first, l, r }, [l.buffer, r.buffer]);
    this.first = -1;
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0];
    const a = inp && inp[0];
    const b = inp && (inp[1] || inp[0]);
    if (this.first < 0) this.first = currentFrame;
    if (this.ack) { this.ack = false; this.port.postMessage({ started: currentFrame }); }
    for (let i = 0; i < 128; i++) {
      this.l[this.n + i] = a ? a[i] : 0;
      this.r[this.n + i] = b ? b[i] : 0;
    }
    this.n += 128;
    if (this.n >= 8192) this.flush();
    return true;
  }
}
registerProcessor('audition-rec', Rec);
`;

/**
 * The 99.9th percentile of the steps in [lo, hi) leaving out [gl, gh): the k-th largest one, found without sorting.
 * Steps are never negative, so zero stands for "none yet".
 */
function reference(steps: Float32Array, lo: number, gl: number, gh: number, hi: number): { ref: number; n: number } {
  const n = gl - lo + (hi - gh);
  if (n <= 0) return { ref: 0, n: 0 };
  // Same rank as a sorted copy read at index floor(0.999 * (n - 1)).
  const k = n - Math.floor(0.999 * (n - 1));
  const top = new Float32Array(k);
  const feed = (from: number, to: number): void => {
    for (let j = from; j < to; j++) {
      const v = steps[j];
      if (v <= top[k - 1]) continue;
      let p = k - 1;
      while (p > 0 && top[p - 1] < v) {
        top[p] = top[p - 1];
        p--;
      }
      top[p] = v;
    }
  };
  feed(lo, gl);
  feed(gh, hi);
  return { ref: top[k - 1], n };
}

/** Clipped samples and clicks of one channel; times in seconds from the first sample. */
export function analyseChannel(x: Float32Array, rate: number, channel: number, minRatio = CLICK_RATIO, minLevel = CLICK_LEVEL, dust = CLICK_DUST): Raw[] {
  const out: Raw[] = [];
  const gap = Math.round(rate * 0.005);
  let lastClip = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    if (v >= 1.0) {
      if (i - lastClip > gap) out.push({ kind: 'clip', channel, t: i / rate, size: v });
      else {
        const f = out[out.length - 1];
        if (f && f.kind === 'clip') f.size = Math.max(f.size, v);
      }
      lastClip = i;
    }
  }
  const steps = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) steps[i] = Math.abs(x[i] - x[i - 1]);
  // Running sums of the squares, for the RMS level of any stretch.
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  let lastClick = -Infinity;
  for (let i = 1; i < x.length; i++) {
    const d = steps[i];
    if (d <= dust) continue;
    // A click is the largest step of its own neighbourhood; the slopes of a smooth signal are not.
    const near0 = Math.max(0, i - GUARD);
    const near1 = Math.min(x.length, i + GUARD + 1);
    let top = true;
    for (let j = near0; j < near1; j++) {
      if (steps[j] > d) {
        top = false;
        break;
      }
    }
    if (!top) continue;
    const lo = Math.max(0, i - HALF_WINDOW);
    const hi = Math.min(x.length, i + HALF_WINDOW + 1);
    const { ref, n } = reference(steps, lo, near0, near1, hi);
    // The level of the surrounding signal, the click's own few samples left out.
    const rms = n > 0 ? Math.sqrt((sq[near0] - sq[lo] + (sq[hi] - sq[near1])) / n) : 0;
    if (d <= minLevel * rms) continue;
    // A flat surrounding gives a reference of 0; the step then only has to clear the dust floor and the level test.
    const ratio = ref > 0 ? d / ref : Infinity;
    if (ratio <= minRatio) continue;
    if (i - lastClick > gap) out.push({ kind: 'click', channel, t: i / rate, size: d, ratio });
    else {
      const f = out[out.length - 1];
      if (f && f.kind === 'click' && d > f.size) {
        f.size = d;
        f.ratio = ratio;
      }
    }
    lastClick = i;
  }
  return out;
}

const fileCache = new Map<string, Promise<Raw[]>>();

/** The faults that are in a sound file itself, as the page decodes it (times from the start of the file). */
export function fileFaults(id: string): Promise<Raw[]> {
  let p = fileCache.get(id);
  if (!p) {
    const sound = engine.get(id);
    if (!sound) return Promise.resolve([]);
    p = engine.buffer(sound).then((b) => {
      const all: Raw[] = [];
      // A loop is heard going round, so its first 50 ms are appended: a loop point that jumps counts as a fault of the file.
      const extra = sound.kind === 'loop' ? Math.min(b.length, Math.round(b.sampleRate * 0.05)) : 0;
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        const x = new Float32Array(d.length + extra);
        x.set(d);
        x.set(d.subarray(0, extra), d.length);
        all.push(...analyseChannel(x, b.sampleRate, c, FILE_RATIO, FILE_LEVEL, FILE_DUST));
      }
      return all;
    });
    fileCache.set(id, p);
  }
  return p;
}

interface Play {
  id: string;
  start: number;
  end: number;
  length?: number;
}

const MATCH = 0.02;

/** True when a fault of a file can be what the output's fault is: same kind, same place, and for a click not much weaker. */
function sameFault(own: Raw, f: Raw, rel: number): boolean {
  if (own.kind !== f.kind || Math.abs(own.t - rel) > MATCH) return false;
  if (f.kind !== 'click') return true;
  // A click that the page makes on top of a mild step of the file is stronger than that step by far.
  return Math.min(own.ratio ?? RATIO_CAP, RATIO_CAP) * FILE_RATIO_SLACK >= Math.min(f.ratio ?? RATIO_CAP, RATIO_CAP);
}

/** Marks a fault as 'file' when a sound playing at that moment holds the same kind of fault at the same place. */
async function attribute(f: Raw, audioTime: number, plays: Play[]): Promise<Fault> {
  const sounds: string[] = [];
  let origin: Fault['origin'] = 'page';
  for (const p of plays) {
    if (audioTime < p.start - MATCH || audioTime > p.end + 0.05) continue;
    if (!sounds.includes(p.id)) sounds.push(p.id);
    let rel = audioTime - p.start;
    const len = p.length ?? 0;
    if (p.end === Infinity && len > 0) rel = ((rel % len) + len) % len;
    const own = await fileFaults(p.id);
    if (own.some((q) => sameFault(q, f, rel))) origin = 'file';
    // A fault at the wrap of a looped file sits at the end and at the start of the file at once.
    else if (len > 0 && own.some((q) => sameFault(q, f, rel + len))) origin = 'file';
  }
  return { ...f, origin, sounds };
}

let node: AudioWorkletNode | null = null;
let chunks: { frame: number; l: Float32Array; r: Float32Array }[] = [];
let stopWaiter: (() => void) | null = null;
let startWaiter: (() => void) | null = null;
let last: { rate: number; first: number; l: Float32Array } | null = null;

async function ensureNode(): Promise<AudioWorkletNode> {
  if (node) return node;
  await engine.settled();
  const ctx = engine.context;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const n = new AudioWorkletNode(ctx, 'audition-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  n.port.onmessage = (e: MessageEvent) => {
    if (e.data?.started !== undefined) startWaiter?.();
    else if (e.data?.done) stopWaiter?.();
    else if (e.data?.l) chunks.push(e.data);
  };
  // Silent output only so that the browser keeps the recorder running.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  engine.tap.connect(n);
  n.connect(mute).connect(ctx.destination);
  node = n;
  return n;
}

function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

export const capture = {
  /** Starts recording and answers once the first block has been taken, so that nothing played after this is missed. */
  async start(): Promise<number> {
    const n = await ensureNode();
    chunks = [];
    await new Promise<void>((resolve) => {
      startWaiter = resolve;
      n.port.postMessage('start');
    });
    startWaiter = null;
    return engine.context.currentTime;
  },

  async stop(): Promise<CaptureResult> {
    const n = await ensureNode();
    await new Promise<void>((resolve) => {
      stopWaiter = resolve;
      n.port.postMessage('stop');
    });
    stopWaiter = null;
    const rate = engine.context.sampleRate;
    const first = chunks.length ? chunks[0].frame : 0;
    const l = join(chunks.map((c) => c.l));
    const r = join(chunks.map((c) => c.r));
    last = { rate, first, l };
    const w = window as unknown as { __audition?: { plays?: Play[] } };
    const plays = (w.__audition?.plays ?? []).filter((p) => p.end >= first / rate - 0.1);
    const raw = [...analyseChannel(l, rate, 0), ...analyseChannel(r, rate, 1)].sort((a, b) => a.t - b.t);
    const faults: Fault[] = [];
    for (const f of raw) faults.push(await attribute(f, first / rate + f.t, plays));
    return { seconds: l.length / rate, peak: [peakOf(l), peakOf(r)], faults };
  },

  /** Level of the last capture between two audio-clock times: peak and RMS of channel 0. */
  window(from: number, to: number): { peak: number; rms: number } {
    if (!last) return { peak: 0, rms: 0 };
    const a = Math.max(0, Math.round(from * last.rate) - last.first);
    const b = Math.min(last.l.length, Math.round(to * last.rate) - last.first);
    let peak = 0;
    let sum = 0;
    for (let i = a; i < b; i++) {
      peak = Math.max(peak, Math.abs(last.l[i]));
      sum += last.l[i] * last.l[i];
    }
    return { peak, rms: b > a ? Math.sqrt(sum / (b - a)) : 0 };
  },

  /** Samples of channel 0 of the last capture between two audio-clock times, for looking at a fault by hand. */
  samples(from: number, to: number): number[] {
    if (!last) return [];
    const a = Math.max(0, Math.round(from * last.rate) - last.first);
    const b = Math.min(last.l.length, Math.round(to * last.rate) - last.first);
    return Array.from(last.l.subarray(a, b));
  },

  fileFaults,
};

/** Registers the recorder and the helpers of the limiter check on the test hooks. */
export function installCaptureHooks(): void {
  const h = hooks() as unknown as Record<string, unknown>;
  h.capture = capture;
  h.now = () => engine.context.currentTime;
  h.injectTone = (amp: number, freq: number, when: number, seconds: number) => engine.injectTone(amp, freq, when, seconds);
  h.limiterMakeupDb = () => engine.limiterMakeupDb.value;
  h.settled = () => engine.settled();
  // The detector itself, for the controls of the check: plain arrays in, faults out.
  h.analyse = (samples: number[], rate: number) => analyseChannel(Float32Array.from(samples), rate, 0);
}
