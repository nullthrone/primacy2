import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditionPlugin } from '../../../dev/auditionPlugin.ts';
import { analyseChannel, fileExplains, levelBoth } from './capture.ts';
import { bufferEdges, crossfadeWeights, PLAN_LEAD, START_LEAD } from './engine.ts';
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

// ---- The click detector follows the material -----------------------------------------------------------------------

const db = (d: number) => 10 ** (d / 20);

/** Gaussian white noise from a fixed seed. */
function whiteNoise(seconds: number, sigma: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => sigma * Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next()));
}

/** The 99.9th percentile of the sample-to-sample steps of x. */
function stepCeiling(x: Float32Array): number {
  const d = Float32Array.from({ length: x.length - 1 }, (_, i) => Math.abs(x[i + 1] - x[i])).sort();
  return d[Math.floor(0.999 * (d.length - 1))];
}

const clicksOf = (x: Float32Array) => analyseChannel(x, RATE, 0).filter((f) => f.kind === 'click');

describe('analyseChannel reaches quiet and dense material', () => {
  it('finds a -40 dBFS click inside a quiet tone at -50 dBFS, and nothing in the tone itself', () => {
    const tone = sine(1, db(-50));
    expect(clicksOf(tone)).toEqual([]);
    const cut = 24000;
    for (let i = cut; i < tone.length; i++) tone[i] += db(-40);
    const found = clicksOf(tone);
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0].t - cut / RATE)).toBeLessThan(0.001);
  });

  it('finds a click 12 dB above the step ceiling of loud white noise, at several levels, and nothing in the noise itself', () => {
    for (const [sigma, seed] of [
      [0.03, 1],
      [0.1, 2],
      [0.3, 3],
    ]) {
      const noise = whiteNoise(1, sigma, seed);
      expect(clicksOf(noise)).toEqual([]);
      const cut = 24000;
      const step = 4 * stepCeiling(noise);
      for (let i = cut; i < noise.length; i++) noise[i] += step;
      const found = clicksOf(noise);
      expect(found, `sigma ${sigma}`).toHaveLength(1);
      expect(Math.abs(found[0].t - cut / RATE)).toBeLessThan(0.001);
    }
  });

  it('finds nothing in a clean sine and in clean exponential attacks (of a tone, of noise, of a plain rise)', () => {
    expect(clicksOf(sine(1, 0.5, 1000))).toEqual([]);
    for (const tau of [0.0005, 0.002, 0.01]) {
      const env = (i: number) => 1 - Math.exp(-i / (tau * RATE));
      const tone = Float32Array.from(sine(1, 0.5, 200), (v, i) => v * env(i));
      const noise = Float32Array.from(whiteNoise(1, 0.2, 5), (v, i) => v * env(i));
      const rise = Float32Array.from({ length: RATE }, (_, i) => 0.8 * env(i));
      expect(clicksOf(tone), `tone, tau ${tau}`).toEqual([]);
      expect(clicksOf(noise), `noise, tau ${tau}`).toEqual([]);
      expect(clicksOf(rise), `rise, tau ${tau}`).toEqual([]);
    }
  });

  it('ignores a step below numerical dust (-70 dBFS) even in silence', () => {
    const x = new Float32Array(RATE / 2);
    for (let i = 12000; i < x.length; i++) x[i] = db(-80);
    expect(clicksOf(x)).toEqual([]);
    for (let i = 12000; i < x.length; i++) x[i] = db(-60);
    expect(clicksOf(x)).toHaveLength(1);
  });

  it('a click is judged against the steps around it with its own samples left out', () => {
    // A single-sample spike makes two large steps next to each other: neither may hide the other.
    const x = sine(0.5, 0.05);
    x[12000] += 0.5;
    const found = clicksOf(x);
    expect(found).toHaveLength(1);
    expect(found[0].ratio).toBeGreaterThan(10);
  });
});

describe('what the click detector cannot see', () => {
  /** Gaussian noise from a fixed seed, `rms` linear. */
  function noise(rms: number): Float32Array {
    let seed = 99;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    return Float32Array.from({ length: RATE }, () => rms * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()));
  }

  it('in noise at -12 dBFS RMS no step that fits under full scale is found: it is masked by the noise', () => {
    // Stated as a limit, not hidden: a step must beat CLICK_RATIO times the 99.9th percentile of the steps around it.
    const x = noise(db(-12));
    expect(clicksOf(x)).toEqual([]);
    for (let i = 24000; i < x.length; i++) x[i] += 0.5;
    expect(clicksOf(x)).toEqual([]);
  });

  it('noise at -30 dBFS RMS shows a step of -6 dBFS but not one of -18 dBFS: 3 times its step ceiling is the least that is found', () => {
    const quiet = noise(db(-30));
    const small = quiet.map((v, i) => (i >= 24000 ? v + db(-18) : v));
    expect(clicksOf(small)).toEqual([]);
    const big = quiet.map((v, i) => (i >= 24000 ? v + db(-6) : v));
    expect(clicksOf(big)).toHaveLength(1);
  });
});

describe('fileExplains', () => {
  const click = { kind: 'click' as const, channel: 0, t: 1, size: 0.02, ratio: 5 };

  it('a step that is the file step times the page gain is the file', () => {
    // File step 0.04, the page passes it on at 0.5: 0.02 at the output.
    const v = fileExplains(click, 0.04 * 0.5);
    expect(v.file).toBe(true);
    expect(v.explained).toBeLessThan(1);
  });

  it('a step four times larger than the file can account for is the page, whatever its ratio', () => {
    const v = fileExplains({ ...click, size: 0.08, ratio: 40 }, 0.02);
    expect(v.file).toBe(false);
    expect(v.explained).toBeGreaterThan(2);
  });

  it('with the gain not known, or for a clipped sample, the match alone counts', () => {
    expect(fileExplains({ ...click, size: 1 }, null).file).toBe(true);
    expect(fileExplains({ kind: 'clip', channel: 0, t: 1, size: 1.2 }, 0.001).file).toBe(true);
  });
});

describe('planning lead', () => {
  it('a chain is planned further ahead than the engine pushes a start, with room for the time between planning and playing', () => {
    expect(PLAN_LEAD).toBeGreaterThanOrEqual(START_LEAD + 0.05);
  });
});

// ---- The ratings guard of the check ---------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const OWNERS = path.join(ROOT, 'assets', 'audio', 'ratings.json');

describe('auditionPlugin answers where it writes the ratings', () => {
  async function ask(env: string | undefined): Promise<{ status: number; body: string }> {
    const before = process.env.AUDITION_RATINGS_FILE;
    if (env === undefined) delete process.env.AUDITION_RATINGS_FILE;
    else process.env.AUDITION_RATINGS_FILE = env;
    try {
      let handler: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
      const configure = auditionPlugin().configureServer as unknown as (s: unknown) => void;
      configure({
        config: { root: path.join(ROOT, 'packages', 'client') },
        middlewares: { use: (p: string, fn: typeof handler) => (p === '/audio-lib' ? (handler = fn) : undefined) },
      });
      return await new Promise((resolve) => {
        const res = {
          statusCode: 0,
          setHeader: () => undefined,
          end: (body: string) => resolve({ status: res.statusCode, body: String(body) }),
        };
        handler?.({ method: 'GET', url: '/ratings-path', headers: { host: 'localhost:1' } }, res, () => resolve({ status: -1, body: 'next' }));
      });
    } finally {
      if (before === undefined) delete process.env.AUDITION_RATINGS_FILE;
      else process.env.AUDITION_RATINGS_FILE = before;
    }
  }

  it('gives the absolute path of the scratch file when AUDITION_RATINGS_FILE is set', async () => {
    const scratch = path.resolve(ROOT, 'scratch-ratings-for-test.json');
    const r = await ask(scratch);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: scratch });
  });

  it("gives the owner's file when the variable is not set", async () => {
    const r = await ask(undefined);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: OWNERS });
  });
});

describe('the check refuses to start against the wrong ratings file', () => {
  /** Runs the check against a stand-in server that answers /audio-lib/ratings-path with `answer`; collects what the check sent. */
  async function runCheck(answer: ((res: http.ServerResponse) => void) | null, scratch: string): Promise<{ code: number | null; stderr: string; requests: string[] }> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (answer) answer(res);
      else {
        res.statusCode = 404;
        res.end('nope');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev', 'audition-check.mjs')], {
          cwd: ROOT,
          env: { ...process.env, AUDITION_URL: `http://127.0.0.1:${port}/dev/audition.html`, AUDITION_RATINGS_FILE: scratch },
        });
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, requests }));
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
  const json = (p: string) => (res: http.ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: p }));
  };
  const scratch = path.join(ROOT, 'scratch-ratings-for-test.json');

  it("stops when the server writes the owner's file, also in another letter case", async () => {
    for (const served of [OWNERS, OWNERS.toUpperCase(), OWNERS.toLowerCase()]) {
      const r = await runCheck(json(served), scratch);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/owner's file/);
      // Nothing but the one read-only question was sent.
      expect(r.requests).toEqual(['GET /audio-lib/ratings-path']);
    }
  }, 60000);

  it('stops when the server does not answer the question (an old server)', async () => {
    const r = await runCheck(null, scratch);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/does not answer/);
    expect(r.requests).toEqual(['GET /audio-lib/ratings-path']);
  }, 60000);

  it('stops when the server writes another file than the one this shell names', async () => {
    const r = await runCheck(json(path.join(ROOT, 'another-scratch.json')), scratch);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/AUDITION_RATINGS_FILE/);
    expect(r.requests).toEqual(['GET /audio-lib/ratings-path']);
  }, 60000);

  it("stops before asking anything when this shell names the owner's file", async () => {
    const r = await runCheck(json(scratch), OWNERS);
    expect(r.code).toBe(2);
    expect(r.requests).toEqual([]);
  }, 60000);
});

describe('levelBoth', () => {
  it('adds the energies of the two channels: a one-channel file on both sides reads 3 dB more', () => {
    const x = sine(0.5, 0.2);
    const one = levelBoth(x, new Float32Array(x.length), 0, x.length);
    const both = levelBoth(x, x, 0, x.length);
    expect(Math.abs(20 * Math.log10(both.rms / one.rms) - 10 * Math.log10(2))).toBeLessThan(1e-9);
    expect(one.left).toBeCloseTo(0.2 / Math.SQRT2, 4);
    expect(one.right).toBe(0);
    expect(both.peak).toBeCloseTo(0.2, 4);
  });

  it('keeps the window as asked and answers zero for an empty one', () => {
    const x = sine(0.1, 0.5);
    const half = levelBoth(x, x, 0, 100);
    expect(half.power).toBeGreaterThan(0);
    expect(levelBoth(x, x, 50, 50)).toEqual({ peak: 0, power: 0, rms: 0, left: 0, right: 0 });
    expect(levelBoth(x, x, 10, 5).power).toBe(0);
    expect(levelBoth(x, x, 0, x.length + 1000).power).toBeGreaterThan(0);
  });
});
