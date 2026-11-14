// Controller check of the real game in a real browser, with a simulated gamepad.
//
//   npm run build && node scripts/pad-check.mjs
//
// Starts the two dev servers like scripts/e2e.mjs, then replaces navigator.getGamepads in the page
// with a function that returns one plain object whose state this script sets through window.__pad.
// It plays the start screen, the station screen, flight (stick, fire, camera chord, pause menu,
// binding screen) with an Xbox id, then once with a PlayStation id to see the other names in a
// hint, and one pass at a phone-sized landscape viewport for screenshots only.
// Screenshots go to screenshots/pad/. Exits with code 1 when a step fails or the page logged an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'screenshots/pad';
const URL = process.env.PRIMACY2_URL ?? 'http://localhost:8420';
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const PLAYSTATION = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
mkdirSync(OUT, { recursive: true });

function startServers() {
  return new Promise((resolve, reject) => {
    // The same two sectors as the end-to-end test (see scripts/dev.ts).
    const env = { ...process.env, PRIMACY2_FIXED_UNIVERSE: process.env.PRIMACY2_FIXED_UNIVERSE ?? '16' };
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
  // Synchronous, so the whole process tree is gone before this script exits.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

const problems = [];
const steps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => {
  if (!cond) problems.push(`check failed: ${msg}`);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  return cond;
};

/** The fake pad: plain objects, no Gamepad instance; the page reads window.__pad on every call. */
function fakePad(id) {
  const blank = () => ({ pressed: false, touched: false, value: 0 });
  window.__pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, blank) };
  navigator.getGamepads = () => [{
    id, index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
    axes: [...window.__pad.axes], buttons: window.__pad.buttons.map((b) => ({ ...b })),
  }, null, null, null];
}

async function openPage(browser, id, viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(fakePad, id);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  return { context, page };
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); steps.push(name); };
const setButton = (page, n, down) => page.evaluate(([i, d]) => { const b = window.__pad.buttons[i]; b.pressed = d; b.value = d ? 1 : 0; b.touched = d; }, [n, down]);
const setAxis = (page, i, v) => page.evaluate(([a, x]) => { window.__pad.axes[a] = x; }, [i, v]);
/** Holds a button long enough for a few frames, then lets go. */
async function tap(page, n, ms = 170) {
  await setButton(page, n, true);
  await sleep(ms);
  await setButton(page, n, false);
  await sleep(120);
}
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, View: 8, Menu: 9, L3: 10, R3: 11, Up: 12, Down: 13, Left: 14, Right: 15, Guide: 16 };

const focus = (page) => page.evaluate(() => {
  const e = document.querySelector('.padfocus');
  return e ? { tag: e.tagName, text: (e.textContent ?? '').trim().slice(0, 50), cls: String(e.className), inTabs: !!e.closest('.tabs'), type: e.type ?? '' } : null;
});
const waitFor = async (page, fn, arg, timeout = 8000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (err) {
    // A picture of what the page showed when the wait ran out.
    await page.screenshot({ path: `${OUT}/failed-wait.png` }).catch(() => {});
    throw err;
  }
};

/** Moves the focus mark to the element that `mark` tags with data-pt, using only the D-pad. */
async function navTo(page, mark, arg) {
  await page.evaluate(() => document.querySelectorAll('[data-pt]').forEach((e) => e.removeAttribute('data-pt')));
  const handle = await page.evaluateHandle(mark, arg);
  const el = handle.asElement();
  if (el) await el.evaluate((e) => e.setAttribute('data-pt', '1'));
  let tried = 0;
  let lastKey = '';
  for (let i = 0; i < 80; i++) {
    const d = await page.evaluate(() => {
      const f = document.querySelector('.padfocus');
      const t = document.querySelector('[data-pt]');
      if (!t) return { missing: true };
      if (!f) return { nofocus: true };
      if (f === t) return { here: true };
      const a = f.getBoundingClientRect();
      const b = t.getBoundingClientRect();
      return { dx: b.left + b.width / 2 - (a.left + a.width / 2), dy: b.top + b.height / 2 - (a.top + a.height / 2), key: `${Math.round(a.left)},${Math.round(a.top)}` };
    });
    if (d.here) return true;
    if (d.missing) return false;
    if (d.nofocus) { await tap(page, B.Down); continue; }
    // When the last press went nowhere, try the other axis.
    const stuck = d.key === lastKey;
    lastKey = d.key;
    if (stuck) tried++;
    const vertical = (Math.abs(d.dy) >= Math.abs(d.dx)) !== (tried % 2 === 1);
    const n = vertical ? (d.dy > 0 ? B.Down : B.Up) : (d.dx > 0 ? B.Right : B.Left);
    await tap(page, n, 90);
  }
  return false;
}

const sample = (page) => page.evaluate(() => {
  const v = window.primacy2.game.view;
  const s = v?.self?.state;
  return s ? { speed: Math.hypot(...s.vel), rot: [...s.rot], mode: v.mode, t: performance.now() } : null;
});
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.rot[0] * b.rot[0] + a.rot[1] * b.rot[1] + a.rot[2] * b.rot[2] + a.rot[3] * b.rot[3])));

/** Types the name with the keyboard, moves with the D-pad to Launch and connects with A. */
async function startByPad(page, name, tag) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.start-card', { timeout: 20_000 });
  await page.fill('.start-card input', name);
  await tap(page, B.Down);
  let f = await focus(page);
  check(f?.tag === 'INPUT', `${tag}: the first press marks the focused name field (got ${f?.tag})`);
  await tap(page, B.Down);
  f = await focus(page);
  check(f?.tag === 'INPUT' && f.text === '', `${tag}: D-pad down moves to the server field`);
  await tap(page, B.Down);
  f = await focus(page);
  check(f?.tag === 'BUTTON' && f.cls.includes('primary'), `${tag}: D-pad down reaches the launch button (got ${JSON.stringify(f)})`);
  await shot(page, `${tag}-01-start`);
  await tap(page, B.A);
  await waitFor(page, () => window.primacy2?.game?.view?.mode === 3, null, 20_000);
}

async function stationByPad(page, tag) {
  await waitFor(page, () => !!document.querySelector('.backdrop .panel nav.tabs'));
  await sleep(500);
  // The panel opened while a pad was in use: the focus is already on the first tab.
  let f = await focus(page);
  check(f?.inTabs === true, `${tag}: the station panel opens with the focus on a tab (got ${JSON.stringify(f)})`);
  const tabText = () => page.evaluate(() => document.querySelector('nav.tabs button.on')?.textContent?.trim());
  const first = await tabText();
  await tap(page, B.RB);
  const second = await tabText();
  check(first !== second && !!second, `${tag}: RB changes the tab (${first} -> ${second})`);
  await shot(page, `${tag}-02-station-services`);
  await tap(page, B.LB);
  check((await tabText()) === first, `${tag}: LB changes it back`);
  // Down from the tab into the market, then back up.
  await tap(page, B.Down);
  f = await focus(page);
  check(f && !f.inTabs, `${tag}: D-pad down leaves the tabs for the market (got ${JSON.stringify(f)})`);
  await shot(page, `${tag}-03-station-market`);
  const reached = await navTo(page, () => document.querySelector('.backdrop .panel header button.primary'));
  check(reached, `${tag}: the D-pad reaches the undock button`);
  await tap(page, B.A);
  await waitFor(page, () => window.primacy2.game.view?.mode === 0, null, 12_000);
  check(true, `${tag}: A on the undock button leaves the station`);
}

async function flight(page) {
  await sleep(1500);
  const live = await page.evaluate(() => window.primacy2.game.input.active());
  check(live === true, 'in space with a pad and no pointer lock the controls are live');
  check((await page.locator('button.capture').count()) === 0, 'the click-to-capture button is not shown while a pad is in use');
  await shot(page, 'xbox-04-space');

  // Left stick forward raises the speed.
  const v0 = await sample(page);
  await setAxis(page, 1, -1);
  await sleep(2500);
  const v1 = await sample(page);
  await setAxis(page, 1, 0);
  check(v1 && v0 && v1.speed > v0.speed + 1, `left stick forward raises the speed (${v0?.speed.toFixed(1)} -> ${v1?.speed.toFixed(1)} m/s)`);

  // Right stick turns; letting go stops the turn.
  const r0 = await sample(page);
  await setAxis(page, 2, 1);
  await sleep(1000);
  const r1 = await sample(page);
  const turning = angle(r0, r1) / ((r1.t - r0.t) / 1000);
  await setAxis(page, 2, 0);
  await sleep(500);
  const r2 = await sample(page);
  await sleep(500);
  const r3 = await sample(page);
  const after = angle(r2, r3) / ((r3.t - r2.t) / 1000);
  check(turning > 0.05, `right stick turns the ship (${turning.toFixed(3)} rad/s)`);
  check(after < Math.max(0.02, turning * 0.1), `the turn has stopped half a second after letting go (${after.toFixed(4)} rad/s afterwards, ${turning.toFixed(3)} while turning)`);

  // Weapons are locked within 4 km of a station in secure space: fly out with stick and boost (L3).
  await setAxis(page, 1, -1);
  await setButton(page, B.L3, true);
  let far = false;
  try {
    await waitFor(page, () => Math.hypot(...window.primacy2.game.view.self.state.pos) > 4300, null, 90_000);
    far = true;
  } catch { /* reported below */ }
  await setButton(page, B.L3, false);
  await setAxis(page, 1, 0);
  check(far, 'left stick forward and L3 boost carry the ship out of the station weapon lock');

  // RT fires.
  await page.evaluate(() => {
    window.__shots = 0;
    window.__energy = [];
    window.__kinds = {};
    let last = null;
    const loop = () => {
      const v = window.primacy2.game.view;
      if (v && v !== last) {
        last = v;
        window.__energy.push(v.self?.state.energy ?? 0);
        for (const e of v.events) {
          window.__kinds[e.e] = (window.__kinds[e.e] ?? 0) + 1;
          if (e.e === 'shot' && e.from === v.self?.id) window.__shots++;
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  });
  await setButton(page, B.RT, true);
  await sleep(1200);
  await setButton(page, B.RT, false);
  const shots = await page.evaluate(() => window.__shots);
  const energy = await page.evaluate(() => ({ lo: Math.min(...window.__energy), hi: Math.max(...window.__energy), kinds: window.__kinds }));
  console.log('energy', JSON.stringify(energy));
  check(shots > 0, `RT fires the primary weapon (${shots} shot events)`);

  // Y + RB changes the camera.
  const cam = () => page.evaluate(() => JSON.parse(localStorage.getItem('primacy2.settings') ?? '{}').camera ?? 'cockpit');
  const c0 = await cam();
  await setButton(page, B.Y, true);
  await sleep(150);
  await tap(page, B.RB);
  await setButton(page, B.Y, false);
  await sleep(300);
  const c1 = await cam();
  check(c0 !== c1, `Y + RB changes the camera (${c0} -> ${c1})`);
  await shot(page, 'xbox-05-chase');
  await setButton(page, B.Y, true);
  await sleep(150);
  await tap(page, B.RB);
  await setButton(page, B.Y, false);
  await sleep(200);

  // Menu opens the pause menu.
  const keysBefore = await page.evaluate(() => document.querySelector('.keys')?.textContent ?? '');
  await tap(page, B.Menu);
  await waitFor(page, () => !!document.querySelector('.backdrop .panel'));
  check(true, 'Menu opens the pause menu');
  await sleep(300);
  const f = await focus(page);
  check(f !== null, `the pause menu has the focus mark (${JSON.stringify(f)})`);
  await shot(page, 'xbox-06-pause');

  // The binding screen: assign the Guide button to the cruise drive.
  const open = await navTo(page, () => Array.from(document.querySelectorAll('.panel button')).find((b) => /Controller assignments/.test(b.textContent)));
  check(open, 'the D-pad reaches the controller assignments button');
  await tap(page, B.A);
  await waitFor(page, () => !!document.querySelector('.bindings'));
  await sleep(300);
  await shot(page, 'xbox-07-bindings');
  const reach = await navTo(page, () => {
    const row = Array.from(document.querySelectorAll('.bind-table tbody tr')).find((r) => r.firstElementChild?.textContent?.trim() === 'Cruise drive');
    return row?.querySelector('.acts button');
  });
  check(reach, 'the D-pad reaches the assign button of the cruise drive');
  await tap(page, B.A);
  await waitFor(page, () => !!document.querySelector('.bindings .listen'));
  check(true, 'A on assign starts listening');
  await shot(page, 'xbox-08-listening');
  await tap(page, B.Guide, 250);
  await sleep(500);
  const row = await page.evaluate(() => Array.from(document.querySelectorAll('.bind-table tbody tr')).find((r) => r.firstElementChild?.textContent?.trim() === 'Cruise drive')?.textContent ?? '');
  check(/Guide/.test(row), `the new button shows in the binding row (${row})`);
  check(!(await page.evaluate(() => document.querySelector('.bindings .listen'))), 'listening ended after the button was pressed');
  const keysAfter = await page.evaluate(() => document.querySelector('.keys')?.textContent ?? '');
  check(/Guide cruise/.test(keysAfter) && keysAfter !== keysBefore, `the HUD hint shows the new control (${keysAfter.slice(0, 40)}...)`);
  await shot(page, 'xbox-09-bound');
  // B goes back to the pause menu, B again closes it and returns to flight.
  await tap(page, B.B);
  check(!(await page.evaluate(() => document.querySelector('.bindings'))) && (await page.locator('.backdrop .panel').count()) === 1, 'B leaves the binding screen for the pause menu');
  await tap(page, B.B);
  await sleep(300);
  check((await page.locator('.backdrop .panel').count()) === 0, 'B closes the pause menu');
  check((await page.evaluate(() => window.primacy2.game.input.active())) === true, 'closing the panel by pad returns to flight');
}

async function phone(browser) {
  const { context, page } = await openPage(browser, XBOX, { width: 844, height: 390 });
  try {
    await startByPad(page, `PhonePad${Date.now() % 10000}`, 'phone');
    await shot(page, 'phone-02-start-launched');
    await waitFor(page, () => !!document.querySelector('.backdrop .panel nav.tabs'));
    await sleep(500);
    await shot(page, 'phone-03-station');
    await tap(page, B.RB);
    await shot(page, 'phone-04-station-tab');
    await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
    await page.click('.panel header button.primary');
    await waitFor(page, () => window.primacy2.game.view?.mode === 0, null, 12_000);
    await sleep(1500);
    await shot(page, 'phone-05-space');
    await tap(page, B.Menu);
    await waitFor(page, () => !!document.querySelector('.backdrop .panel'));
    await sleep(300);
    await shot(page, 'phone-06-pause');
    await tap(page, B.B);
  } finally {
    await context.close();
  }
}

let servers = null;
let browser = null;
try {
  servers = process.env.PRIMACY2_URL ? null : await startServers();
  browser = await chromium.launch({
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });

  {
    const { context, page } = await openPage(browser, XBOX, { width: 1600, height: 900 });
    await startByPad(page, `XboxPad${Date.now() % 10000}`, 'xbox');
    await stationByPad(page, 'xbox');
    await flight(page);
    await context.close();
  }

  {
    const { context, page } = await openPage(browser, PLAYSTATION, { width: 1600, height: 900 });
    await startByPad(page, `PsPad${Date.now() % 10000}`, 'ps');
    await stationByPad(page, 'ps');
    await sleep(1500);
    const keys = await page.evaluate(() => document.querySelector('.keys')?.textContent ?? '');
    check(/Create cruise/.test(keys) && /Options menu/.test(keys) && /Triangle \+ Cross dock/.test(keys), `a PlayStation pad shows PlayStation names in the hint (${keys.slice(0, 80)})`);
    await shot(page, 'ps-04-space');
    await context.close();
  }

  await phone(browser);
} catch (err) {
  problems.push(`failed after [${steps.join(', ')}]: ${err.message}`);
} finally {
  await browser?.close().catch(() => {});
  stopServers(servers);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`pad check ok (${steps.length} screenshots in ${OUT})`);
process.exit(0);
