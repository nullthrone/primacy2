// Controller check of the real game in a real browser, with a simulated gamepad.
//
//   npm run build && node scripts/pad-check.mjs
//
// Starts the two dev servers like scripts/e2e.mjs, then replaces navigator.getGamepads in the page
// with a function that returns one plain object whose state this script sets through window.__pad.
// Three passes:
//   Xbox id, 1600 x 900: the start screen, the station screen (tabs, a quantity field, closing it
//     and coming back through the pause menu, undock), flight (sticks, fire, places, chords), the
//     pause menu (slider, select, a held direction), the binding screen (assigning, the two ways a
//     pad cancels an assignment), what a button or stick held through a closing menu does, and the
//     galaxy map.
//   PlayStation id: the start screen with nothing typed (a pilot without a keyboard), the station
//     screen, and the other names in a hint.
//   Xbox id, 844 x 390 (a phone held sideways): that the station screen and the pause menu lie
//     inside the viewport, and screenshots.
// A step that fails is reported and the run goes on where it can, so one run shows every failure.
// Screenshots go to screenshots/pad/. Exits with code 1 when a step fails or the page logged an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'screenshots/pad';
// PRIMACY2_DEV_PORT moves the servers this script starts to other ports (see scripts/dev.ts).
const URL = process.env.PRIMACY2_URL ?? `http://localhost:${process.env.PRIMACY2_DEV_PORT ?? 8420}`;
// PRIMACY2_PAD_PASS=xbox, ps or phone plays one pass alone, for work on this script. A run that
// counts as the check plays all three.
const ONLY = process.env.PRIMACY2_PAD_PASS ?? '';
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
let checks = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => {
  checks++;
  if (!cond) problems.push(`check failed: ${msg}`);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  return !!cond;
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
/** A chord the easy way round: Y down, the target tapped, Y up. */
async function chord(page, n) {
  await setButton(page, B.Y, true);
  await sleep(150);
  await tap(page, n);
  await setButton(page, B.Y, false);
  await sleep(200);
}

/**
 * The marked control, or null when nothing carries the mark. `input` is its place among the input
 * elements of the screen: two text fields have no text of their own to tell them apart by.
 */
const focus = (page) => page.evaluate(() => {
  const e = document.querySelector('.padfocus');
  if (!e) return null;
  const inputs = Array.from(document.querySelectorAll('.start-card input, .backdrop .panel input'));
  return {
    tag: e.tagName, text: (e.textContent ?? '').trim().slice(0, 50), cls: String(e.className), inTabs: !!e.closest('.tabs'), type: e.type ?? '',
    value: 'value' in e ? String(e.value) : null, input: inputs.indexOf(e), marks: document.querySelectorAll('.padfocus').length,
  };
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
/** As waitFor, for a step whose failure the run can survive: false when the wait ran out. */
const waitOk = async (page, fn, arg, timeout = 5000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch {
    return false;
  }
};
const panelOpen = (page) => page.evaluate(() => !!document.querySelector('.backdrop .panel'));
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('primacy2.settings') ?? '{}'));
/**
 * What the ship would be told for one tick right now, asked from the game's own input object. In
 * normal flight the call changes nothing that lasts: no mouse turn is pending under a pad.
 */
const tick = (page) => page.evaluate(() => {
  const g = window.primacy2.game;
  const s = g.input.sample(g.view.mode, 1 / 30);
  return { thrust: [...s.thrust], aim: [...s.aim], roll: s.roll, buttons: s.buttons };
});

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
      return {
        dx: b.left + b.width / 2 - (a.left + a.width / 2), dy: b.top + b.height / 2 - (a.top + a.height / 2),
        // Which control it is, not where it stands: in a list that scrolls, the next row takes the
        // place on the screen that the last one had.
        key: String(Array.from(document.querySelectorAll('button, a[href], input, select, textarea')).indexOf(f)),
        // Left and right change a slider or a select instead of leaving it.
        adjusts: f.matches('select, input[type="range"]'),
      };
    });
    if (d.here) return true;
    if (d.missing) return false;
    if (d.nofocus) { await tap(page, B.Down); continue; }
    // When the last press went nowhere, try the other axis.
    const stuck = d.key === lastKey;
    lastKey = d.key;
    if (stuck) tried++;
    let n;
    if (d.adjusts) {
      // Only up and down lead away from such a control; sideways would change a setting.
      n = d.dy > 1 ? B.Down : d.dy < -1 ? B.Up : tried % 2 === 1 ? B.Down : B.Up;
    } else {
      const vertical = (Math.abs(d.dy) >= Math.abs(d.dx)) !== (tried % 2 === 1);
      n = vertical ? (d.dy > 0 ? B.Down : B.Up) : (d.dx > 0 ? B.Right : B.Left);
    }
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

/**
 * The start screen by pad: the D-pad to Launch, A connects. With a `name` it is typed with the
 * keyboard first; with null nothing is typed, as for a pilot who has only the controller, and the
 * screen has to come with a name of its own.
 */
async function startByPad(page, name, tag) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.start-card', { timeout: 20_000 });
  let nothingTyped = false;
  if (name === null) {
    const made = await page.inputValue('.start-card input');
    nothingTyped = check(/^\p{L}+ \d{4}$/u.test(made), `${tag}: with no saved name the start screen begins with a made-up one, a word and four digits ("${made}")`);
    // So that the rest of the pass can run when it does not.
    if (!nothingTyped) await page.fill('.start-card input', `Fallback${Date.now() % 10000}`);
  } else {
    await page.fill('.start-card input', name);
  }
  await tap(page, B.Down);
  let f = await focus(page);
  check(f?.tag === 'INPUT' && f.input === 0, `${tag}: the first press marks the focused name field (got ${f?.tag}, input ${f?.input})`);
  await tap(page, B.Down);
  f = await focus(page);
  check(f?.tag === 'INPUT' && f.input === 1, `${tag}: D-pad down moves to the server field (got ${f?.tag}, input ${f?.input})`);
  await tap(page, B.Down);
  f = await focus(page);
  check(f?.tag === 'BUTTON' && f.cls.includes('primary'), `${tag}: D-pad down reaches the launch button (got ${JSON.stringify(f)})`);
  if (name === null) {
    // Below the launch button are the tabs and, under them, the link to the source code. It opens
    // another tab, where a pad cannot follow, so the mark must pass it by.
    const below = [];
    for (let i = 0; i < 3; i++) {
      await tap(page, B.Down);
      below.push(await focus(page));
    }
    check(below.every((x) => x !== null && x.tag !== 'A') && below[0]?.inTabs === true, `${tag}: further down are the tabs, and the mark never stops on the link that opens another tab (${below.map((x) => `${x?.tag} ${x?.text}`).join(' | ')})`);
    const back = await navTo(page, () => document.querySelector('.start-card button.primary'));
    check(back, `${tag}: the D-pad comes back to the launch button`);
  }
  await shot(page, `${tag}-01-start`);
  await tap(page, B.A);
  await waitFor(page, () => window.primacy2?.game?.view?.mode === 3, null, 20_000);
  if (name === null) check(nothingTyped, `${tag}: A on Launch connects without anything having been typed`);
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
  // The marked tab went from "on" to plain, so the page rewrote its class. The mark is a class too.
  f = await focus(page);
  check(f !== null && f.marks === 1 && f.inTabs, `${tag}: the focus mark is still there after RB changed the tab (${JSON.stringify(f)})`);
  await shot(page, `${tag}-02-station-services`);
  await tap(page, B.LB);
  check((await tabText()) === first, `${tag}: LB changes it back`);
  f = await focus(page);
  check(f !== null && f.marks === 1, `${tag}: and the mark is there after LB as well (${JSON.stringify(f)})`);
  // Down from the tab into the market, then back up.
  await tap(page, B.Down);
  f = await focus(page);
  check(f && !f.inTabs, `${tag}: D-pad down leaves the tabs for the market (got ${JSON.stringify(f)})`);
  await shot(page, `${tag}-03-station-market`);

  // A quantity: A starts editing, left and right count, and a held direction counts faster. The
  // market takes up to 9999 units and a pad has no digits.
  const qty = await navTo(page, () => document.querySelector('.backdrop .panel input[type="number"]'));
  check(qty, `${tag}: the D-pad reaches a quantity field of the market`);
  if (qty) {
    await tap(page, B.A);
    const q0 = Number((await focus(page))?.value);
    await setButton(page, B.Right, true);
    await sleep(3000);
    await setButton(page, B.Right, false);
    await sleep(150);
    const q1 = Number((await focus(page))?.value);
    check(q1 > 100, `${tag}: right held for three seconds takes a quantity past 100 (${q0} -> ${q1})`);
    await tap(page, B.Left);
    const q2 = Number((await focus(page))?.value);
    check(q2 === q1 - 1, `${tag}: one press of left takes one unit off (${q1} -> ${q2})`);
    await tap(page, B.B);
    check(await page.evaluate(() => !!document.querySelector('.backdrop .panel nav.tabs')), `${tag}: B ends the editing and leaves the station screen open`);
  }

  // B closes the station screen, as Escape does. The pause menu is the way back to it.
  await tap(page, B.B);
  await sleep(250);
  check(!(await panelOpen(page)), `${tag}: B closes the station screen while docked`);
  await tap(page, B.Menu);
  const paused = await waitOk(page, () => !!document.querySelector('.backdrop .panel.narrow'));
  check(paused, `${tag}: Menu opens the pause menu while docked`);
  const way = paused && await navTo(page, () => Array.from(document.querySelectorAll('.backdrop .panel header button')).find((b) => /Station services/.test(b.textContent)));
  check(way, `${tag}: the pause menu of a docked pilot has a "Station services" button, and the D-pad reaches it`);
  if (way) {
    await shot(page, `${tag}-03b-pause-docked`);
    await tap(page, B.A);
  }
  const back = await waitOk(page, () => !!document.querySelector('.backdrop .panel nav.tabs'), null, 4000);
  check(back, `${tag}: A on it brings the station screen back`);
  if (back) {
    await sleep(300);
    f = await focus(page);
    check(f?.inTabs === true, `${tag}: the station screen has its mark on a tab again (${JSON.stringify(f)})`);
    const reached = await navTo(page, () => document.querySelector('.backdrop .panel header button.primary'));
    check(reached, `${tag}: the D-pad reaches the undock button`);
    await tap(page, B.A);
  } else {
    // Without the station screen the dock chord is the only way out of the station.
    if (await panelOpen(page)) await tap(page, B.B);
    await sleep(200);
    await chord(page, B.A);
  }
  await waitFor(page, () => window.primacy2.game.view?.mode === 0, null, 12_000);
  if (back) check(true, `${tag}: A on the undock button leaves the station`);
}

/** The pause menu: a slider, a select and a held direction. Leaves the mark somewhere in the menu. */
async function pauseMenuControls(page) {
  const slider = await navTo(page, () => document.querySelector('.backdrop .panel input[type="range"][max="100"]'));
  check(slider, 'the D-pad reaches the field-of-view slider');
  if (slider) {
    const v0 = Number((await focus(page))?.value);
    await tap(page, B.Left);
    const v1 = Number((await focus(page))?.value);
    const stored = (await saved(page)).fov;
    check(v1 === v0 - 1 && stored === v1, `left on the slider lowers the field of view by one step (${v0} -> ${v1}, saved ${stored})`);
    await tap(page, B.Right);
    const v2 = Number((await focus(page))?.value);
    check(v2 === v0 && (await saved(page)).fov === v0, `right raises it again (${v2})`);
  }
  // The camera select, not the language one: the texts this script looks for are English.
  const select = await navTo(page, () => document.querySelectorAll('.backdrop .panel select')[1]);
  check(select, 'the D-pad reaches the camera select');
  if (select) {
    const c0 = (await focus(page))?.value;
    const there = c0 === 'cockpit' ? B.Right : B.Left;
    await tap(page, there);
    const c1 = (await focus(page))?.value;
    check(c1 !== c0 && (await saved(page)).camera === c1, `${there === B.Right ? 'right' : 'left'} on the select changes the camera (${c0} -> ${c1})`);
    await tap(page, there === B.Right ? B.Left : B.Right);
    const c2 = (await focus(page))?.value;
    check(c2 === c0 && (await saved(page)).camera === c0, `the other direction changes it back (${c2})`);
  }
  // A held direction repeats: from the top of the menu the mark runs down over several controls.
  const top = await navTo(page, () => document.querySelector('.backdrop .panel header button'));
  check(top, 'the D-pad comes back to the top of the pause menu');
  const passed = new Set();
  await setButton(page, B.Down, true);
  for (let i = 0; i < 12; i++) {
    await sleep(100);
    const f = await focus(page);
    if (f) passed.add(`${f.tag}|${f.text}|${f.input}`);
  }
  await setButton(page, B.Down, false);
  await sleep(150);
  check(passed.size >= 3, `a held D-pad direction repeats: the mark passed ${passed.size} controls in 1.2 s`);
}

/** The binding screen, opened from the pause menu; ends back in the pause menu. */
async function bindingScreen(page, keysBefore) {
  const open = await navTo(page, () => Array.from(document.querySelectorAll('.panel button')).find((b) => /Controller assignments/.test(b.textContent)));
  check(open, 'the D-pad reaches the controller assignments button');
  await tap(page, B.A);
  await waitFor(page, () => !!document.querySelector('.bindings'));
  await sleep(300);
  // Before navTo, which presses a direction when nothing is marked and would hide a missing mark.
  let f = await focus(page);
  check(f !== null && f.text === 'Back', `the binding screen opens with the mark on its Back button (${JSON.stringify(f)})`);
  const reason = await page.evaluate(() => document.querySelector('.bindings')?.textContent?.includes('Connect a joystick first.') ?? false);
  check(reason, 'why the joystick preset is switched off stands on the screen as text, not only in a tooltip');
  await shot(page, 'xbox-07-bindings');
  const assignOf = (label) => navTo(page, (l) => {
    const row = Array.from(document.querySelectorAll('.bind-table tbody tr')).find((r) => r.firstElementChild?.textContent?.trim() === l);
    return row?.querySelector('.acts button');
  }, label);
  const listening = () => page.evaluate(() => document.querySelector('.bindings .listen')?.textContent ?? null);
  const bindingsOpen = () => page.evaluate(() => !!document.querySelector('.backdrop .panel .bindings') && document.querySelectorAll('.backdrop .panel').length === 1);

  // Assign the Guide button to the cruise drive.
  check(await assignOf('Cruise drive'), 'the D-pad reaches the assign button of the cruise drive');
  await tap(page, B.A);
  await waitFor(page, () => !!document.querySelector('.bindings .listen'));
  check(true, 'A on assign starts listening');
  // "Assign" became "Cancel" and took a class: the mark has to survive that as well.
  f = await focus(page);
  check(f !== null && f.marks === 1 && f.text === 'Cancel', `the mark stays on the button that started it, which now reads Cancel (${JSON.stringify(f)})`);
  const hint = await listening();
  check(/Menu or Esc cancels\./.test(hint ?? ''), `the text shown names the pad's way out of a button assignment (${hint})`);
  await shot(page, 'xbox-08-listening');
  await tap(page, B.Guide, 250);
  await sleep(500);
  const row = await page.evaluate(() => Array.from(document.querySelectorAll('.bind-table tbody tr')).find((r) => r.firstElementChild?.textContent?.trim() === 'Cruise drive')?.textContent ?? '');
  check(/Guide/.test(row), `the new button shows in the binding row (${row})`);
  check((await listening()) === null, 'listening ended after the button was pressed');
  const keysAfter = await page.evaluate(() => document.querySelector('.keys')?.textContent ?? '');
  check(/Guide cruise/.test(keysAfter) && keysAfter !== keysBefore, `the HUD hint shows the new control (${keysAfter.slice(0, 40)}...)`);
  await shot(page, 'xbox-09-bound');

  // The pad's way out of a button assignment: the button of the pause menu. It ends the wait and
  // changes nothing, and it is never taken from the pause menu.
  check(await assignOf('Camera'), 'the D-pad reaches the assign button of the camera');
  const bindingsBefore = JSON.stringify((await saved(page)).bindings);
  await tap(page, B.A);
  const heard = await waitOk(page, () => !!document.querySelector('.bindings .listen'));
  // The screen starts to listen once every button is up.
  await sleep(400);
  await tap(page, B.Menu, 250);
  const ended = await waitOk(page, () => !document.querySelector('.bindings .listen'), null, 3000);
  check(heard && ended, 'Menu ends the wait for a button');
  const untouched = JSON.stringify((await saved(page)).bindings) === bindingsBefore;
  check(untouched, 'and leaves every assignment as it was, the pause menu its button included');
  check(await bindingsOpen(), 'the binding screen is still open afterwards: Menu did not act a second time');
  if (!untouched && await bindingsOpen()) {
    // So that the Menu button opens the pause menu in the steps that follow.
    if (await navTo(page, () => document.querySelector('.bindings button.danger'))) await tap(page, B.A);
  }

  // The way out while an axis is wanted: any button.
  const axisAssign = await navTo(page, () => document.querySelector('.bindings .axis-block > .row button'));
  check(axisAssign, 'the D-pad reaches the assign button of the first analog axis');
  const padBefore = JSON.stringify((await saved(page)).pad);
  await tap(page, B.A);
  const heardAxis = await waitOk(page, () => !!document.querySelector('.bindings .listen'));
  const axisHint = await listening();
  check(/Any button or Esc cancels\./.test(axisHint ?? ''), `the text shown names the pad's way out of an axis assignment (${axisHint})`);
  await sleep(400);
  await tap(page, B.B, 250);
  const endedAxis = await waitOk(page, () => !document.querySelector('.bindings .listen'), null, 3000);
  check(heardAxis && endedAxis, 'B ends the wait for an axis');
  check(JSON.stringify((await saved(page)).pad) === padBefore, 'and leaves the axes as they were');
  check(await bindingsOpen(), 'the binding screen is still open afterwards: B did not also go back');
  if (!endedAxis) {
    // The keyboard's way out, so that the run can go on.
    await page.keyboard.press('Escape');
    await sleep(200);
    await tap(page, B.Down);
  }

  // B goes back to the pause menu, which is a new screen and gets a mark of its own at once.
  await tap(page, B.B);
  check(!(await page.evaluate(() => document.querySelector('.bindings'))) && (await page.locator('.backdrop .panel').count()) === 1, 'B leaves the binding screen for the pause menu');
  await sleep(250);
  f = await focus(page);
  check(f !== null && f.marks === 1, `back in the pause menu a control is marked at once (${JSON.stringify(f)})`);
}

/** What is still held when a menu closes must not fly the ship. Starts and ends with the pause menu closed. */
async function heldThroughClose(page) {
  await tap(page, B.Menu);
  const opened = await waitOk(page, () => !!document.querySelector('.backdrop .panel.narrow'));
  check(opened, 'Menu opens the pause menu again');
  if (!opened) return;
  const resume = await navTo(page, () => Array.from(document.querySelectorAll('.backdrop .panel header button')).find((b) => /Resume/.test(b.textContent)));
  check(resume, 'the D-pad reaches Resume');
  // The right stick is not used by the menu; it stands in for a stick that is still deflected.
  await setAxis(page, 2, 1);
  await setButton(page, B.A, true);
  const closed = await waitOk(page, () => !document.querySelector('.backdrop .panel'), null, 3000);
  await sleep(200);
  check(closed, 'A on Resume closes the pause menu');
  const live = await page.evaluate(() => window.primacy2.game.input.active());
  const held = await tick(page);
  check(live === true && held.thrust[1] === 0, `A, still down after it closed the menu, does not thrust up (controls live: ${live}, thrust ${held.thrust.join(' ')})`);
  check(held.aim[0] === 0, `a stick that was deflected while the menu closed does not turn the ship (aim ${held.aim[0]})`);
  await setButton(page, B.A, false);
  await setAxis(page, 2, 0);
  await sleep(200);
  await setButton(page, B.A, true);
  await setAxis(page, 2, 1);
  await sleep(200);
  const again = await tick(page);
  await setButton(page, B.A, false);
  await setAxis(page, 2, 0);
  await sleep(200);
  check(again.thrust[1] === 1 && again.aim[0] > 0, `let go and used again, both work (thrust ${again.thrust[1]}, aim ${again.aim[0].toFixed(4)})`);
}

/** Y + View opens the galaxy map; its list of systems makes a choice possible without the mouse. */
async function galaxyByPad(page) {
  await chord(page, B.View);
  const map = await waitOk(page, () => document.querySelectorAll('.backdrop .panel .sys-list button').length > 1, null, 10_000);
  check(map, 'Y + View opens the galaxy map with its list of systems');
  if (!map) {
    if (await panelOpen(page)) await tap(page, B.B);
    return;
  }
  await sleep(300);
  const inList = () => page.evaluate(() => !!document.querySelector('.padfocus')?.closest('.sys-list'));
  const f = await focus(page);
  check(await inList(), `the map opens with the mark in the list (${JSON.stringify(f)})`);
  await tap(page, B.Down);
  const g = await focus(page);
  check((await inList()) && g?.text !== f?.text, `D-pad down moves to another system (${f?.text} -> ${g?.text})`);
  await tap(page, B.A);
  await sleep(250);
  const chosen = await page.evaluate(() => {
    const on = document.querySelector('.sys-list button.on');
    return on ? { text: (on.textContent ?? '').trim().slice(0, 50), marked: on.classList.contains('padfocus') } : null;
  });
  check(chosen?.marked === true && chosen.text === g?.text, `A selects the marked system, and the mark stays on it (${JSON.stringify(chosen)})`);
  await shot(page, 'xbox-10-galaxy');
  await tap(page, B.B);
  await sleep(300);
  check(!(await panelOpen(page)), 'B closes the galaxy map');
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

  // The D-pad chooses places: right steps on, left steps back, down lets go; the hints name it.
  const navId = () => page.evaluate(() => window.primacy2.game.view?.navAnchor ?? null);
  await tap(page, B.Down);
  await tap(page, B.Down);
  await sleep(200);
  check((await navId()) === null, 'D-pad down leaves nothing chosen');
  await tap(page, B.Right);
  await sleep(300);
  const place1 = await navId();
  check(place1 !== null && (await page.locator('.hud .place-list').count()) === 1, `D-pad right chooses a place and opens the list (${place1})`);
  await tap(page, B.Right);
  await sleep(300);
  const place2 = await navId();
  check(place2 !== null && place2 !== place1, `a second press steps on (${place2})`);
  await tap(page, B.Left);
  await sleep(300);
  check((await navId()) === place1, 'D-pad left steps back');
  const caps = await page.$$eval('.hud .sys-lines .keycap', (ns) => ns.map((n) => n.textContent.trim()));
  check(['D←', 'D→', 'D↑'].every((k) => caps.includes(k)), `the system lines name the D-pad (${caps.join(' | ')})`);
  await shot(page, 'xbox-04b-places');
  await tap(page, B.Down);
  await sleep(300);
  check((await navId()) === null, 'D-pad down lets go of the place');

  // Y + RB changes the camera.
  const cam = () => page.evaluate(() => JSON.parse(localStorage.getItem('primacy2.settings') ?? '{}').camera ?? 'cockpit');
  const c0 = await cam();
  await chord(page, B.RB);
  await sleep(100);
  const c1 = await cam();
  check(c0 !== c1, `Y + RB changes the camera (${c0} -> ${c1})`);
  await shot(page, 'xbox-05-chase');
  // The same chord with Y let go first. RB alone rolls the ship: it must not, as long as it is the
  // button that was pressed for the chord.
  await setButton(page, B.Y, true);
  await sleep(150);
  await setButton(page, B.RB, true);
  await sleep(150);
  await setButton(page, B.Y, false);
  await sleep(150);
  const rolled = (await tick(page)).roll;
  await setButton(page, B.RB, false);
  await sleep(200);
  check((await cam()) === c0, 'the chord changes the camera back when Y is let go before RB');
  check(rolled === 0, `RB, still down after the chord, does not roll the ship (roll ${rolled})`);
  await setButton(page, B.RB, true);
  await sleep(150);
  const rolledAlone = (await tick(page)).roll;
  await setButton(page, B.RB, false);
  await sleep(150);
  check(rolledAlone === 1, `pressed by itself afterwards, RB rolls (roll ${rolledAlone})`);

  // Menu opens the pause menu.
  const keysBefore = await page.evaluate(() => document.querySelector('.keys')?.textContent ?? '');
  await tap(page, B.Menu);
  await waitFor(page, () => !!document.querySelector('.backdrop .panel'));
  check(true, 'Menu opens the pause menu');
  await sleep(300);
  const f = await focus(page);
  check(f !== null, `the pause menu has the focus mark (${JSON.stringify(f)})`);
  const noStation = await page.evaluate(() => !Array.from(document.querySelectorAll('.backdrop .panel header button')).some((b) => /Station services/.test(b.textContent)));
  check(noStation, 'in space the pause menu has no "Station services" button');
  await shot(page, 'xbox-06-pause');

  await pauseMenuControls(page);
  await bindingScreen(page, keysBefore);

  // B closes the pause menu and returns to flight.
  await tap(page, B.B);
  await sleep(300);
  check((await page.locator('.backdrop .panel').count()) === 0, 'B closes the pause menu');
  check((await page.evaluate(() => window.primacy2.game.input.active())) === true, 'closing the panel by pad returns to flight');

  await heldThroughClose(page);
  await galaxyByPad(page);
}

/** Where the open panel lies in the viewport, or null when none is open. */
const panelBox = (page) => page.evaluate(() => {
  const p = document.querySelector('.backdrop .panel');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  const round = (x) => Math.round(x * 10) / 10;
  return {
    left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom), width: innerWidth, height: innerHeight,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
  };
});

async function phone(browser) {
  const { context, page } = await openPage(browser, XBOX, { width: 844, height: 390 });
  try {
    await startByPad(page, `PhonePad${Date.now() % 10000}`, 'phone');
    await shot(page, 'phone-02-start-launched');
    await waitFor(page, () => !!document.querySelector('.backdrop .panel nav.tabs'));
    await sleep(500);
    let box = await panelBox(page);
    check(box?.inside === true, `phone: the station screen lies inside the 844 x 390 viewport (${JSON.stringify(box)})`);
    await shot(page, 'phone-03-station');
    await tap(page, B.RB);
    box = await panelBox(page);
    check(box?.inside === true, `phone: and on its second tab as well (${JSON.stringify(box)})`);
    await shot(page, 'phone-04-station-tab');
    await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
    await page.click('.panel header button.primary');
    await waitFor(page, () => window.primacy2.game.view?.mode === 0, null, 12_000);
    await sleep(1500);
    await shot(page, 'phone-05-space');
    await tap(page, B.Menu);
    await waitFor(page, () => !!document.querySelector('.backdrop .panel'));
    await sleep(300);
    box = await panelBox(page);
    check(box?.inside === true, `phone: the pause menu lies inside the viewport (${JSON.stringify(box)})`);
    await shot(page, 'phone-06-pause');
    // The menu is longer than the screen is high: it scrolls inside itself and the mark is followed.
    const last = await navTo(page, () => document.querySelector('.backdrop .panel button.danger'));
    const seen = await page.evaluate(() => {
      const r = document.querySelector('.backdrop .panel button.danger')?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), inside: r.top >= 0 && r.bottom <= innerHeight } : null;
    });
    check(last && seen?.inside === true, `phone: the D-pad reaches the last button of the pause menu and it is scrolled into view (${JSON.stringify(seen)})`);
    await shot(page, 'phone-07-pause-end');
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

  if (!ONLY || ONLY === 'xbox') {
    const { context, page } = await openPage(browser, XBOX, { width: 1600, height: 900 });
    await startByPad(page, `XboxPad${Date.now() % 10000}`, 'xbox');
    await stationByPad(page, 'xbox');
    await flight(page);
    await context.close();
  }

  if (!ONLY || ONLY === 'ps') {
    const { context, page } = await openPage(browser, PLAYSTATION, { width: 1600, height: 900 });
    // Nothing is typed in this pass: the pilot has a controller and no keyboard.
    await startByPad(page, null, 'ps');
    await stationByPad(page, 'ps');
    await sleep(1500);
    const keys = await page.evaluate(() => document.querySelector('.keys')?.textContent ?? '');
    check(/Create cruise/.test(keys) && /Options menu/.test(keys) && /Triangle\+Cross dock/.test(keys), `a PlayStation pad shows PlayStation names in the hint (${keys.slice(0, 80)})`);
    await shot(page, 'ps-04-space');
    await context.close();
  }

  if (!ONLY || ONLY === 'phone') await phone(browser);
} catch (err) {
  problems.push(`failed after [${steps.join(', ')}]: ${err.message}`);
} finally {
  await browser?.close().catch(() => {});
  stopServers(servers);
}
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`pad check FAILED: ${problems.length} problem(s) in ${checks} checks`);
  process.exit(1);
}
console.log(`pad check ok (${checks} checks, ${steps.length} screenshots in ${OUT})${ONLY ? `, pass ${ONLY} only` : ''}`);
process.exit(0);
