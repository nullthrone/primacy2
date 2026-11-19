// Checks the game's sound in a real (headless) Chromium: that the shipped sounds load, that the
// flight makes the stage play what the mapping says, and that a signal leaves the output.
//
//   npm run build && PRIMACY2_DEV_PORT=8520 node tools/dev/audio-check.mjs
//
// Starts two servers of its own (scripts/dev.ts) on PRIMACY2_DEV_PORT and the port after it, with
// their data in a fresh temporary folder, and stops them again. It refuses the ports of the owner's
// own stack (8420, 8421) and of his audition page (5190). Nobody can hear here: the check reads the
// play log, the target gains and the level at the output (`window.__audio`), and says only that.
// Exits with code 1 when a step fails or the page logged an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.PRIMACY2_DEV_PORT);
if (!Number.isInteger(PORT) || [8420, 8421, 8419, 5190, 5189].includes(PORT)) {
  console.error('Set PRIMACY2_DEV_PORT to a free port that is not 8420, 8421 or 5190 (and not one below them): those are the owner\'s.');
  process.exit(2);
}
const URL = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'primacy2-audio-check-'));

const failures = [];
const problems = [];
let passed = 0;

async function check(name, fn) {
  try {
    const note = await fn();
    passed++;
    console.log(`ok    ${name}${note ? `: ${note}` : ''}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function startServers() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PRIMACY2_FIXED_UNIVERSE: '16', PRIMACY2_DEV_PORT: String(PORT), PRIMACY2_DEV_DATA: DATA };
    const child = spawn('npx tsx scripts/dev.ts', { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    const timer = setTimeout(() => reject(new Error('servers did not start:\n' + out)), 60_000);
    const onData = (d) => {
      out += d;
      if (out.includes('Both sectors are peered')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`servers exited with code ${code}:\n${out}`)));
  });
}

function stopServers(child) {
  if (!child) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Highest output peak seen while `ms` pass, linear. */
async function peakOver(page, ms) {
  return page.evaluate(async (wait) => {
    const a = window.__audio;
    let peak = 0;
    const end = performance.now() + wait;
    while (performance.now() < end) {
      peak = Math.max(peak, a.stage.readPeak());
      await new Promise((r) => setTimeout(r, 30));
    }
    return peak;
  }, ms);
}

const audioState = (page) => page.evaluate(() => {
  const a = window.__audio;
  return {
    running: a.stage.running,
    room: a.stage.hasRoom,
    progress: a.library.progress(),
    error: a.library.error,
    engine: a.mixer.engineLevelGains(),
    loops: a.mixer.runningLoops(),
    thrust: a.state.thrust,
    mode: window.primacy2?.game?.view?.mode ?? null,
    held: a.mixer.heldSounds(),
    plays: a.stage.plays.map((p) => ({ ...p, end: Number.isFinite(p.end) ? p.end : null })),
    now: a.stage.now(),
  };
});

const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');

let servers = null;
let browser = null;
try {
  servers = await startServers();
  browser = await chromium.launch({
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && m.text().startsWith('audio:'))) problems.push(`console ${m.type()}: ${m.text()}`);
  });
  const failed = [];
  page.on('response', (r) => {
    if (r.url().includes('/audio/') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(URL);

  await check('every shipped sound is fetched and decoded before the first click', async () => {
    await page.waitForFunction(() => {
      const p = window.__audio?.library.progress();
      return p && p.total > 0 && p.loaded === p.total;
    }, null, { timeout: 30_000 });
    const s = await audioState(page);
    assert(!s.error, `library error: ${s.error}`);
    assert(failed.length === 0, `failed requests: ${failed.join(', ')}`);
    assert(!s.running, 'the audio context runs before any gesture');
    return `${s.progress.loaded} of ${s.progress.total}`;
  });

  await page.fill('.start-card input', 'Lauscher');
  await page.click('.start-card button.primary');
  await page.waitForFunction(() => window.primacy2?.game?.view?.mode === 3, null, { timeout: 20_000 });

  await check('docked: the context runs, the room is set, the cabin sounds and no engine', async () => {
    await page.waitForFunction(() => window.__audio.stage.running && window.__audio.stage.hasRoom && window.__audio.mixer.runningLoops().cabin_ambience_loop === 1, null, { timeout: 5000 });
    const s = await audioState(page);
    assert(s.engine.length === 0, `engine levels while docked: ${JSON.stringify(s.engine)}`);
    return `loops ${Object.keys(s.loops).join(', ')}`;
  });

  await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
  await page.click('.panel header button.primary');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 });

  await check('undocked with no thrust: the engine idles on its lowest level', async () => {
    await page.waitForFunction(() => window.__audio.mixer.engineLevelGains().length === 6, null, { timeout: 5000 });
    await page.waitForTimeout(600);
    const s = await audioState(page);
    const on = s.engine.filter((l) => l.gain > 0.001);
    assert(on.length === 1 && on[0].id === 'engine_main_t000' && Math.abs(on[0].gain - 1) < 0.01, `levels: ${JSON.stringify(s.engine)}`);
    return `thrust ${s.thrust.toFixed(2)}`;
  });

  await check('a signal leaves the output, below full scale', async () => {
    const peak = await peakOver(page, 1500);
    assert(peak > 1e-4, `output peak ${peak}`);
    assert(peak < 0.99, `output peak ${peak}`);
    return `peak ${db(peak)} dBFS at idle`;
  });

  await check('full forward thrust: the crossfade ends on the full-thrust level', async () => {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2200);
    const s = await audioState(page);
    const peak = await peakOver(page, 800);
    await page.keyboard.up('KeyW');
    const on = s.engine.filter((l) => l.gain > 0.001);
    assert(on.length === 1 && on[0].id === 'engine_main_t100', `levels: ${JSON.stringify(s.engine)}`);
    assert(peak < 0.99, `output peak ${peak}`);
    return `thrust ${s.thrust.toFixed(2)}, peak ${db(peak)} dBFS`;
  });

  await check('half-way between two settings both neighbours sound and nothing else', async () => {
    // The throttle setpoint moves in steps with the wheel; five steps up from zero.
    await page.keyboard.press('Backspace');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
    await page.waitForTimeout(1800);
    const s = await audioState(page);
    await page.keyboard.press('Backspace');
    const on = s.engine.filter((l) => l.gain > 0.001);
    assert(on.length >= 1 && on.length <= 2, `levels: ${JSON.stringify(s.engine)}`);
    const power = on.reduce((a, l) => a + l.gain * l.gain, 0);
    assert(Math.abs(power - 1) < 0.02, `the two gains are not equal-power: ${JSON.stringify(on)}`);
    return `thrust ${s.thrust.toFixed(2)}: ${on.map((l) => `${l.id} ${l.gain.toFixed(2)}`).join(', ')}`;
  });

  await check('sideways thrust: one thruster pulse sets in and the burn runs while the key is held', async () => {
    await page.waitForTimeout(1500);
    const before = (await audioState(page)).plays.length;
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(700);
    const held = await audioState(page);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(500);
    const after = await audioState(page);
    const fresh = held.plays.slice(before);
    const pulses = fresh.filter((p) => p.id.startsWith('g_thruster'));
    assert(pulses.length === 1, `pulses: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(held.loops.thruster_burn_loop === 1, `loops while held: ${JSON.stringify(held.loops)}`);
    assert(after.loops.thruster_burn_loop === undefined, `loops after: ${JSON.stringify(after.loops)}`);
    return `${pulses[0].id} at ${pulses[0].azimuth ?? 'two channels'}`;
  });

  await check('quick taps do not pile up: the spacing and the voice limit hold', async () => {
    const before = (await audioState(page)).plays.length;
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down(i % 2 ? 'KeyA' : 'KeyD');
      await page.waitForTimeout(120);
      await page.keyboard.up(i % 2 ? 'KeyA' : 'KeyD');
      await page.waitForTimeout(120);
    }
    const s = await audioState(page);
    const pulses = s.plays.slice(before).filter((p) => p.id.startsWith('g_thruster'));
    assert(pulses.length >= 1 && pulses.length <= 2, `${pulses.length} pulses in two seconds of tapping`);
    for (let i = 1; i < pulses.length; i++) {
      assert(pulses[i].start - pulses[i - 1].start >= 1.15, `pulses ${(pulses[i].start - pulses[i - 1].start).toFixed(2)} s apart`);
      assert(pulses[i].id !== pulses[i - 1].id, `the same sound twice in a row: ${pulses[i].id}`);
    }
    return `${pulses.length} pulses`;
  });

  await check('silent running takes the fan away', async () => {
    await page.keyboard.press('KeyB');
    await page.waitForTimeout(500);
    const on = await audioState(page);
    await page.keyboard.press('KeyB');
    await page.waitForTimeout(500);
    const off = await audioState(page);
    assert(on.loops.silent_running_loop === 1 && on.loops.cabin_ambience_loop === undefined, `loops: ${JSON.stringify(on.loops)}`);
    assert(off.loops.cabin_ambience_loop === 1 && off.loops.silent_running_loop === undefined, `loops: ${JSON.stringify(off.loops)}`);
  });

  // What follows needs events the server only sends in a fight. The check puts them into the game's
  // event buffer as the server's message would, at a point given in the ship's own axes.
  const inject = (event, local) => page.evaluate(([ev, v]) => {
    const g = window.primacy2.game;
    const self = g.view.self;
    const [x, y, z, w] = self.state.rot;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    const r = [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
    const at = [self.state.pos[0] + r[0], self.state.pos[1] + r[1], self.state.pos[2] + r[2]];
    const dmg = ev.share !== undefined ? ev.share * (ev.shield ? self.stats.shieldMax : self.stats.hullMax) : undefined;
    g.events.push(ev.e === 'hit' ? { e: 'hit', id: self.id, dmg, shield: ev.shield, at } : { e: ev.e, id: ev.id, at });
  }, [event, local]);
  const freshPlays = async (before, wait) => {
    await page.waitForTimeout(wait);
    return (await audioState(page)).plays.slice(before);
  };
  const near = (a, b, tol) => a !== null && Math.abs(((a - b + 540) % 360) - 180) <= tol;

  await check('a solid hit on the shield from the right: the approved shield sound, from the right, louder than a light hit', async () => {
    const before = (await audioState(page)).plays.length;
    await inject({ e: 'hit', shield: true, share: 0.15 }, [40, 0, 0]);
    const fresh = await freshPlays(before, 400);
    const hit = fresh.find((p) => p.id.startsWith('g_impact_shield'));
    assert(hit, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(near(hit.azimuth, 90, 3), `azimuth ${hit.azimuth}`);
    assert(Math.abs(hit.gain - 1.41) < 0.01, `gain ${hit.gain}`);
    return `${hit.id} at ${hit.azimuth.toFixed(0)} degrees, gain ${hit.gain}`;
  });

  await check('a dangerous hit on the hull from the left: a heavy hull hit from the left, and the hull groans half a second later', async () => {
    const before = (await audioState(page)).plays.length;
    await inject({ e: 'hit', shield: false, share: 0.25 }, [-40, 0, 0]);
    const fresh = await freshPlays(before, 900);
    const hit = fresh.find((p) => p.id.startsWith('g_impact_hull_heavy'));
    const groan = fresh.find((p) => p.id === 'hull_stress_groan');
    assert(hit && groan, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(near(hit.azimuth, -90, 3), `azimuth ${hit.azimuth}`);
    assert(Math.abs(groan.start - hit.start - 0.5) < 0.06, `the groan starts ${(groan.start - hit.start).toFixed(3)} s after the hit`);
    const peak = await peakOver(page, 600);
    assert(peak < 0.99, `output peak ${peak}`);
    return `${hit.id} at ${hit.azimuth.toFixed(0)} degrees, peak ${db(peak)} dBFS`;
  });

  await check('a light hit on the hull from ahead plays a light hull hit', async () => {
    const before = (await audioState(page)).plays.length;
    await inject({ e: 'hit', shield: false, share: 0.04 }, [0, 0, -40]);
    const fresh = await freshPlays(before, 400);
    const hit = fresh.find((p) => p.id.startsWith('g_impact_hull_light'));
    assert(hit, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(near(hit.azimuth, 0, 3), `azimuth ${hit.azimuth}`);
    return hit.id;
  });

  await check('a ship destroyed behind: the sensor signal from behind, and no sound for the debris, which has none approved', async () => {
    const before = (await audioState(page)).plays.length;
    await inject({ e: 'destroyed', id: 987654321 }, [0, 0, 600]);
    const fresh = await freshPlays(before, 1500);
    const signal = fresh.find((p) => p.id === 'sensor_explosion_outside');
    assert(signal, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(near(signal.azimuth, 180, 3), `azimuth ${signal.azimuth}`);
    assert(!fresh.some((p) => p.id.includes('debris')), 'a debris sound played');
  });

  await check('a transmission on the radio: the squelch opens, the tone follows inside it, the squelch closes at its end', async () => {
    const before = (await audioState(page)).plays.length;
    await page.evaluate(() => window.__audio.mixer.transmission('radio_tone'));
    const fresh = await freshPlays(before, 900);
    const open = fresh.find((p) => p.id === 'radio_squelch_open');
    const tone = fresh.find((p) => p.id === 'radio_tone');
    const close = fresh.find((p) => p.id === 'radio_squelch_close');
    assert(open && tone && close, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(tone.start > open.start && tone.start < open.end, `the tone starts ${(tone.start - open.start).toFixed(3)} s after the squelch, which is ${(open.end - open.start).toFixed(3)} s long`);
    assert(Math.abs(close.start - (tone.end - 0.02)) < 0.005, `the squelch closes ${(close.start - tone.end).toFixed(3)} s from the end of the tone`);
  });

  await check('docking sets the ship down: a soft touchdown, the struts settle after it, the engine is off', async () => {
    const before = (await audioState(page)).plays.length;
    const reply = await page.evaluate(() => window.primacy2.game.cmd({ k: 'dock' }));
    assert(reply.ok, `the dock command was refused: ${JSON.stringify(reply)}`);
    await page.waitForFunction(() => window.primacy2.game.view?.mode === 3, null, { timeout: 10_000 });
    const fresh = await freshPlays(before, 1800);
    const down = fresh.find((p) => p.id === 'touchdown_soft');
    const settle = fresh.find((p) => p.id === 'settle_creak');
    assert(down && settle, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(Math.abs(settle.start - down.start - 1.2) < 0.06, `settling ${(settle.start - down.start).toFixed(3)} s after the touchdown`);
    const s = await audioState(page);
    assert(s.engine.length === 0, `engine levels while docked: ${JSON.stringify(s.engine)}`);
  });

  await check('the cruise chain: the charge, the drive takes hold at its cue, the cruise bed runs, the drive lets go', async () => {
    await page.waitForFunction(() => document.querySelector('.panel header button.primary'), null, { timeout: 10_000 });
    await page.click('.panel header button.primary');
    await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 });
    // Out of the station's mass lock first.
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => Math.min(...window.primacy2.game.view.sites.map((x) => x.dist)) > 4600, null, { timeout: 90_000 });
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    const before = (await audioState(page)).plays.length;
    await page.evaluate(() => window.primacy2.game.toggleCruise());
    await page.waitForFunction(() => window.__audio.mixer.heldSounds().includes('cruise_charge'), null, { timeout: 3000 });
    await page.waitForFunction(() => window.primacy2.game.view?.mode === 1, null, { timeout: 12_000 });
    await page.waitForTimeout(1200);
    const inCruise = await audioState(page);
    const fresh = inCruise.plays.slice(before);
    const charge = fresh.find((p) => p.id === 'cruise_charge');
    const engage = fresh.find((p) => p.id === 'cruise_engage');
    assert(charge && engage, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    const gap = engage.start - charge.start;
    assert(gap > 3.6 && gap < 4.6, `the drive took hold ${gap.toFixed(2)} s after the charge began (the cue of the charge is at 4 s)`);
    assert(inCruise.loops.cruise_loop === 1, `loops in cruise: ${JSON.stringify(inCruise.loops)}`);
    const on = inCruise.engine.filter((l) => l.gain > 0.001);
    assert(on.length === 1 && on[0].id === 'engine_main_t000', `engine in cruise: ${JSON.stringify(inCruise.engine)}`);
    const peak = await peakOver(page, 800);
    const mark = inCruise.plays.length;
    await page.evaluate(() => window.primacy2.game.toggleCruise());
    await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 8000 });
    const after = await freshPlays(mark, 600);
    assert(after.some((p) => p.id === 'cruise_disengage'), `plays after the drop: ${JSON.stringify(after.map((p) => p.id))}`);
    assert((await audioState(page)).loops.cruise_loop === undefined, 'the cruise bed still runs');
    assert(peak < 0.99, `output peak ${peak}`);
    return `engage ${gap.toFixed(2)} s after the charge began, peak in cruise ${db(peak)} dBFS`;
  });

  await check('a charge that is cancelled does not run on', async () => {
    await page.waitForTimeout(1500);
    const before = (await audioState(page)).plays.length;
    await page.evaluate(() => window.primacy2.game.toggleCruise());
    await page.waitForFunction(() => window.__audio.mixer.heldSounds().includes('cruise_charge'), null, { timeout: 3000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.primacy2.game.toggleCruise());
    await page.waitForFunction(() => window.primacy2.game.view?.fx.chargeKind === 0, null, { timeout: 3000 });
    const fresh = await freshPlays(before, 600);
    const s = await audioState(page);
    const charge = fresh.find((p) => p.id === 'cruise_charge');
    assert(charge, `plays: ${JSON.stringify(fresh.map((p) => p.id))}`);
    assert(s.mode !== 1 && !fresh.some((p) => p.id === 'cruise_engage'), 'the drive took hold although the charge was cancelled');
    assert(charge.end !== null && charge.end - charge.start < 2.5, `the charge sound ran for ${(charge.end - charge.start).toFixed(2)} s`);
    return `stopped after ${(charge.end - charge.start).toFixed(2)} s`;
  });

  await check('nothing went wrong on the page', async () => {
    assert(problems.length === 0, problems.join(' | '));
    assert(failed.length === 0, failed.join(', '));
  });
} catch (e) {
  failures.push('run');
  console.log(`FAIL  run: ${e instanceof Error ? e.stack : e}`);
} finally {
  await browser?.close();
  stopServers(servers);
  try {
    rmSync(DATA, { recursive: true, force: true });
  } catch {
    // The servers may still hold a file for a moment; the folder is in the temporary directory.
  }
}

console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
