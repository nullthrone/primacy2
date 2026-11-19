import type { Library } from '../audio/library.ts';
import type { Stage } from '../audio/stage.ts';
import { analyseChannel, fileExplains, sameFault, type CaptureResult, type Fault } from './audition/capture.ts';

// Test recorder of the game: taps the stage's output (after the limiter, what the loudspeakers get), keeps the float
// samples and finds clipped samples and clicks in them, then says for each fault whether the same fault is in the
// samples of a sound that was playing (origin 'file') or not (origin 'page'). It is a chunk of its own that only the
// browser check loads, through window.__audio.capture; a player never fetches it. The detector and the rule that
// blames a file are those of the audition page (dev/audition/capture.ts); what is tied to the game is here.

type Raw = Omit<Fault, 'origin' | 'sounds'>;

/** The looser limits the audition page uses for the samples of a file (its constants are not exported). */
const FILE_RATIO = 2;
const FILE_LEVEL = 0.5 / 4;
const FILE_DUST = 10 ** (-70 / 20) / 4;
/** How far a fault of the output may lie from the one of the file, and how long after its end a voice still counts, in seconds. */
const MATCH = 0.02;
const AFTER_END = 0.05;
/** The radio loudspeaker's overdrive and level can raise a step of a radio file by up to this much (as on the audition page). */
const RADIO_GAIN = 2.5;

const WORKLET = `
class GameRec extends AudioWorkletProcessor {
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
registerProcessor('game-rec', GameRec);
`;

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

export interface GameCapture {
  /** Starts recording and answers once the first block has been taken. */
  start(): Promise<void>;
  /** Stops, analyses and attributes every fault. */
  stop(): Promise<CaptureResult>;
}

export function createGameCapture(stage: Stage, library: Library): GameCapture {
  let node: AudioWorkletNode | null = null;
  let chunks: { frame: number; l: Float32Array; r: Float32Array }[] = [];
  let startWaiter: (() => void) | null = null;
  let stopWaiter: (() => void) | null = null;
  const fileCache = new Map<string, Raw[]>();

  /** The faults that are in a shipped file itself (times from the start of the file); a loop gets its first 50 ms appended, so that its wrap is looked at. */
  function fileFaults(id: string): Raw[] {
    let all = fileCache.get(id);
    if (all) return all;
    all = [];
    const b = library.buffer(id);
    const sound = library.sound(id);
    if (b && sound) {
      const extra = sound.kind === 'loop' ? Math.min(b.length, Math.round(b.sampleRate * 0.05)) : 0;
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        const x = new Float32Array(d.length + extra);
        x.set(d);
        x.set(d.subarray(0, extra), d.length);
        all.push(...analyseChannel(x, b.sampleRate, c, FILE_RATIO, FILE_LEVEL, FILE_DUST));
      }
    }
    fileCache.set(id, all);
    return all;
  }

  /** The most the stage can make of a step of a file: the voice's level times the volume, more for the radio. */
  function gainOf(id: string, voiceGain: number): number {
    return voiceGain * stage.level * (library.sound(id)?.path === 'radio' ? RADIO_GAIN : 1);
  }

  function attribute(f: Raw, audioTime: number): Fault {
    const sounds: string[] = [];
    let matched = false;
    let expected = 0;
    for (const p of stage.plays) {
      if (audioTime < p.start - MATCH || audioTime > p.end + AFTER_END) continue;
      if (!sounds.includes(p.id)) sounds.push(p.id);
      const len = library.buffer(p.id)?.duration ?? 0;
      let rel = audioTime - p.start;
      // A loop goes round also after it was stopped (its end is then finite).
      if (p.loop && len > 0) rel = ((rel % len) + len) % len;
      const hits = fileFaults(p.id).filter((q) => sameFault(q, f, rel) || (len > 0 && sameFault(q, f, rel + len)));
      if (!hits.length) continue;
      matched = true;
      expected += Math.max(...hits.map((q) => q.size)) * gainOf(p.id, p.gain);
    }
    const out: Fault = { ...f, origin: 'page', sounds };
    if (!matched) return out;
    const verdict = fileExplains(f, expected);
    return { ...out, origin: verdict.file ? 'file' : 'page', explained: verdict.explained };
  }

  async function ensureNode(): Promise<AudioWorkletNode> {
    if (node) return node;
    const ctx = stage.context;
    const tap = stage.tap;
    if (!ctx || !tap) throw new Error('the audio context does not exist yet');
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const n = new AudioWorkletNode(ctx, 'game-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    n.port.onmessage = (e: MessageEvent) => {
      if (e.data?.started !== undefined) startWaiter?.();
      else if (e.data?.done) stopWaiter?.();
      else if (e.data?.l) chunks.push(e.data);
    };
    // Silent output only so that the browser keeps the recorder running.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tap.connect(n);
    n.connect(mute).connect(ctx.destination);
    node = n;
    return n;
  }

  return {
    async start() {
      const n = await ensureNode();
      chunks = [];
      await new Promise<void>((resolve) => {
        startWaiter = resolve;
        n.port.postMessage('start');
      });
      startWaiter = null;
    },

    async stop() {
      const n = await ensureNode();
      await new Promise<void>((resolve) => {
        stopWaiter = resolve;
        n.port.postMessage('stop');
      });
      stopWaiter = null;
      const rate = (stage.context as AudioContext).sampleRate;
      const first = chunks.length ? chunks[0].frame : 0;
      const l = join(chunks.map((c) => c.l));
      const r = join(chunks.map((c) => c.r));
      const raw = [...analyseChannel(l, rate, 0), ...analyseChannel(r, rate, 1)].sort((a, b) => a.t - b.t);
      const faults = raw.map((f) => attribute(f, first / rate + f.t));
      return { seconds: l.length / rate, peak: [peakOf(l), peakOf(r)], faults };
    },
  };
}
