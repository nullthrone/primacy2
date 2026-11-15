import { describe, expect, it } from 'vitest';
import { analyseChannel } from './capture.ts';
import { bufferEdges, crossfadeWeights } from './engine.ts';
import { DOCKING, SCENES, sceneSoundIds } from './scenes.ts';

const RATE = 48000;

function sine(seconds: number, amp: number, freq = 440): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / RATE));
}

/** A stand-in for an AudioBuffer with the one method that bufferEdges reads. */
function fakeBuffer(...channels: Float32Array[]): AudioBuffer {
  return { numberOfChannels: channels.length, getChannelData: (c: number) => channels[c] } as unknown as AudioBuffer;
}

describe('bufferEdges', () => {
  it('a buffer that starts and ends at zero needs no fade', () => {
    const x = sine(0.1, 0.5);
    x[0] = 0;
    x[x.length - 1] = 0;
    expect(bufferEdges(fakeBuffer(x))).toEqual({ startSilent: true, endSilent: true });
  });

  it('a first or last sample away from zero asks for a fade, in any channel', () => {
    const quiet = new Float32Array(100);
    const loud = new Float32Array(100);
    loud[0] = 0.3;
    expect(bufferEdges(fakeBuffer(quiet, loud))).toEqual({ startSilent: false, endSilent: true });
    const tail = new Float32Array(100);
    tail[99] = -0.2;
    expect(bufferEdges(fakeBuffer(tail))).toEqual({ startSilent: true, endSilent: false });
  });
});

describe('analyseChannel', () => {
  it('finds nothing in a clean sine', () => {
    expect(analyseChannel(sine(0.5, 0.5), RATE, 0)).toEqual([]);
  });

  it('finds a click: a sine cut off at its peak and carried on after a jump', () => {
    const x = sine(0.5, 0.4);
    const cut = 12000;
    for (let i = cut; i < x.length; i++) x[i] += 0.5;
    const faults = analyseChannel(x, RATE, 0);
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('click');
    expect(Math.abs(faults[0].t - cut / RATE)).toBeLessThan(0.001);
    expect(faults[0].size).toBeGreaterThan(0.4);
  });

  it('does not call a loud noise burst a click', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: RATE / 2 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296) * 1.6 - 0.8;
    });
    expect(analyseChannel(noise, RATE, 0).filter((f) => f.kind === 'click')).toEqual([]);
  });

  it('counts a flat run at full scale as one clipped fault', () => {
    const x = sine(0.2, 0.5);
    for (let i = 3000; i < 3040; i++) x[i] = 1;
    const faults = analyseChannel(x, RATE, 0).filter((f) => f.kind === 'clip');
    expect(faults).toHaveLength(1);
    expect(faults[0].size).toBe(1);
  });
});

describe('crossfadeWeights', () => {
  it('shares equal power between the neighbours', () => {
    const w = crossfadeWeights([0, 0.25, 0.5], 0.375);
    expect(w[0]).toBe(0);
    expect(w[1] ** 2 + w[2] ** 2).toBeCloseTo(1, 9);
  });
});

describe('scenes', () => {
  it('refer to no struck NASA speech recording', () => {
    for (const def of SCENES) expect(sceneSoundIds(def).filter((id) => /^n_sts_|^n_apollo|^n_mercury/.test(id))).toEqual([]);
  });

  it('every scripted event of the docking scene exists', () => {
    const keys = new Set(DOCKING.events.map((e) => e.key));
    for (const step of DOCKING.script) if (step.event) expect(keys.has(step.event)).toBe(true);
  });
});
