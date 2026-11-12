// End-to-end smoke test of the real game in a real browser.
//
//   npm run build && node scripts/e2e.mjs
//
// Starts two linked servers (scripts/dev.ts), opens the game in GPU-accelerated headless Chromium,
// logs in, undocks, meets a second pilot who opens fire, flies, engages cruise and opens the maps.
// Screenshots go to screenshots/e2e/.
// Exits with code 1 when a step fails or the page logged an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'screenshots/e2e';
const URL = process.env.PRIMACY2_URL ?? 'http://localhost:8420';
mkdirSync(OUT, { recursive: true });

function startServers() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx tsx scripts/dev.ts', { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Synchronous, so the whole process tree is gone before this script exits and the next run finds the ports free.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Enters a pilot name on the start screen and waits until the pilot is docked. */
async function login(page, name) {
  await page.fill('.start-card input', name);
  await page.click('.start-card button.primary');
  await page.waitForFunction(() => window.primacy2?.game?.view?.mode === 3, null, { timeout: 20_000 });
}

/** Leaves the station. Pointer lock does not exist in headless mode; the input module has a switch for that. */
async function undock(page) {
  await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
  await page.click('.panel header button.primary');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 });
}

/** Waits for another player's ship among the contacts and locks it as target. */
async function targetPlayer(page) {
  try {
    await page.waitForFunction(() => window.primacy2.game.view?.ents.some((e) => e.info.player), null, { timeout: 20_000 });
  } catch {
    return false;
  }
  await page.evaluate(() => {
    const g = window.primacy2.game;
    g.setTarget(g.view.ents.find((e) => e.info.player).id);
  });
  return true;
}

/**
 * Keeps the nose on the locked target until `done` says so or the time is up. `done` receives the
 * distance to the target and the pilot's own distance from the zone anchor, both in metres.
 */
async function steerUntil(page, done, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.evaluate(() => {
      const g = window.primacy2.game;
      const view = g.view;
      const ent = view?.ents.find((e) => e.id === view.targetId);
      if (!ent || !view.self) return null;
      const p = g.project(ent.rel);
      if (p.behind) g.input.addMouse(300, 0);
      else g.input.addMouse((p.x - window.innerWidth / 2) * 0.35, (p.y - window.innerHeight / 2) * 0.35);
      return { dist: Math.hypot(...ent.rel), own: Math.hypot(...view.self.state.pos) };
    });
    if (v && done(v)) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/** Turns the nose until the station of the current zone is straight behind the ship. */
async function aimAwayFromStation(page, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const off = await page.evaluate(() => {
      const g = window.primacy2.game;
      const zone = g.view?.zone;
      if (!zone) return null;
      const p = g.project([-zone[0], -zone[1], -zone[2]]);
      if (p.behind) { g.input.addMouse(300, 0); return Infinity; }
      const ex = p.x - window.innerWidth / 2, ey = p.y - window.innerHeight / 2;
      g.input.addMouse(ex * 0.35, ey * 0.35);
      return Math.hypot(ex, ey);
    });
    if (off !== null && off < 60) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/** Steers with the mouse hook until the locked target sits in the middle of the view. */
async function aimAtTarget(page, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const off = await page.evaluate(() => {
      const g = window.primacy2.game;
      const v = g.view;
      const ent = v?.ents.find((e) => e.id === v.targetId);
      if (!ent) return null;
      const p = g.project(ent.rel);
      if (p.behind) { g.input.addMouse(300, 0); return Infinity; }
      const ex = p.x - window.innerWidth / 2, ey = p.y - window.innerHeight / 2;
      g.input.addMouse(ex * 0.35, ey * 0.35);
      return Math.hypot(ex, ey);
    });
    if (off !== null && off < 24) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

const problems = [];
const steps = [];
let servers = null;
let browser = null;
try {
  servers = process.env.PRIMACY2_URL ? null : await startServers();
  browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); steps.push(name); };
  const state = () => page.evaluate(() => {
    const v = window.primacy2.game.view;
    const s = v?.self?.state;
    return v ? { mode: v.mode, system: v.system.name, speed: s ? Math.hypot(...s.vel) : 0, pos: s ? Math.hypot(...s.pos) : 0, cruise: s?.cruiseSpeed ?? 0, ents: v.ents.length } : null;
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.start-card', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await shot('01-menu');

  await login(page, 'Test Pilot');
  await page.waitForTimeout(1500);
  await shot('02-docked-station');

  await undock(page);
  await page.waitForTimeout(1200);
  await shot('03-undocked-cockpit');

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);
  await shot('04-chase');

  // A second pilot with an identity of their own joins and undocks at the same station.
  const context2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page2 = await context2.newPage();
  page2.on('pageerror', (e) => problems.push(`pageerror (wingman): ${e.message}`));
  page2.on('console', (m) => { if (m.type() === 'error') problems.push(`console (wingman): ${m.text()}`); });
  await page2.goto(URL, { waitUntil: 'load' });
  await page2.waitForSelector('.start-card', { timeout: 20_000 });
  await login(page2, 'Wingman');
  await undock(page2);

  if (!(await targetPlayer(page))) throw new Error('the second pilot never showed up as a contact');
  if (!(await aimAtTarget(page))) throw new Error('could not bring the second pilot into view');
  await page.waitForTimeout(600);
  await shot('05-wingman-in-sight');

  // The first pilot turns away from the station, flies out of its mass lock, where weapons are
  // free, and stops there.
  if (!(await aimAwayFromStation(page))) {
    const dbg = await page.evaluate(() => {
      const g = window.primacy2.game; const v = g.view;
      return { mode: v?.mode, zone: v?.zone, self: !!v?.self, p: v?.zone ? g.project([-v.zone[0], -v.zone[1], -v.zone[2]]) : null, panel: document.querySelector('.panel')?.className ?? null };
    });
    throw new Error('could not turn away from the station: ' + JSON.stringify(dbg));
  }
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  const flying = await state();
  if (!(flying.speed > 60)) throw new Error(`thrust had no effect: ${JSON.stringify(flying)}`);
  await shot('06-flying');
  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(() => {
    const self = window.primacy2.game.view?.self;
    if (!self) throw new Error('the pilot lost the ship on the way out');
    return Math.hypot(...self.state.pos) > 5600;
  }, null, { timeout: 60_000 });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');

  // Count the combat events the first pilot receives from here on.
  await page.evaluate(() => {
    const seen = (window.__combat = { shot: 0, hit: 0 });
    let last = null;
    const watch = () => {
      const ev = window.primacy2.game.view?.events;
      if (ev && ev !== last) {
        last = ev;
        for (const e of ev) if (e.e === 'shot' || e.e === 'hit') seen[e.e]++;
      }
      requestAnimationFrame(watch);
    };
    watch();
  });

  // The second pilot gives chase, closes to gun range outside the mass lock and opens fire.
  if (!(await targetPlayer(page2))) throw new Error('the second pilot does not see the first');
  await page2.keyboard.down('KeyW');
  await page2.keyboard.down('ShiftLeft');
  const closed = await steerUntil(page2, (v) => v.dist < 1400 && v.own > 4700, 90_000);
  await page2.keyboard.up('ShiftLeft');
  await page2.keyboard.up('KeyW');
  if (!closed) throw new Error('the second pilot could not close in on the first');
  if (!(await aimAtTarget(page2))) throw new Error('the second pilot could not aim at the first');
  await page2.mouse.move(800, 450);
  await page2.mouse.down();
  const firing = steerUntil(page2, () => false, 2400);
  await page2.waitForTimeout(1200);
  await page2.screenshot({ path: `${OUT}/07-wingman-fires.png` });
  if (await targetPlayer(page)) await aimAtTarget(page, 6000);
  await shot('08-under-fire');
  await firing;
  await page2.mouse.up();
  const combat = await page.evaluate(() => window.__combat);
  if (!(combat.shot > 0 && combat.hit > 0)) throw new Error(`the first pilot saw no shots or hits: ${JSON.stringify(combat)}`);
  console.log(`combat events seen by the first pilot: ${JSON.stringify(combat)}`);
  await context2.close();

  await page.keyboard.press('KeyJ');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 1, null, { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  await page.keyboard.up('KeyW');
  const cruising = await state();
  if (!(cruising.cruise > 60_000)) throw new Error(`cruise did not accelerate: ${JSON.stringify(cruising)}`);
  await shot('09-cruise');

  await page.keyboard.press('KeyM');
  await page.waitForSelector('.panel.map canvas', { timeout: 5000 });
  await page.waitForTimeout(800);
  await shot('10-galaxy-map');
  await page.keyboard.press('Escape');

  await page.keyboard.press('KeyN');
  await page.waitForSelector('.panel.narrow .list', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot('11-navigation');
  await page.keyboard.press('Escape');

  const fps = await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(Math.round(n / 2)); };
    requestAnimationFrame(tick);
  }));
  console.log(`steps: ${steps.join(', ')}`);
  console.log(`state: ${JSON.stringify(await state())}, fps ${fps}`);
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
console.log('e2e ok');
process.exit(0);
