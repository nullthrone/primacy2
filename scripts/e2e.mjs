// End-to-end smoke test of the real game in a real browser.
//
//   npm run build && node scripts/e2e.mjs
//
// Starts two linked servers (scripts/dev.ts), opens the game in GPU-accelerated headless Chromium,
// logs in, undocks, is shot down by a second pilot, comes back through insurance, engages cruise
// and opens the maps.
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
 * One steering step toward a point: the locked target, or with `away` the point opposite the
 * station of the current zone. Returns how far the point is from the middle of the view in pixels
 * (Infinity while it is behind the camera), or null when there is nothing to steer at.
 */
function steerStep(page, away) {
  return page.evaluate((awayFromStation) => {
    const g = window.primacy2.game;
    const v = g.view;
    let rel = null;
    if (awayFromStation) rel = v?.zone ? [-v.zone[0], -v.zone[1], -v.zone[2]] : null;
    else rel = v?.ents.find((e) => e.id === v.targetId)?.rel ?? null;
    if (!rel) return null;
    const p = g.project(rel);
    if (p.behind) { g.input.addMouse(60, 0); return Infinity; }
    const ex = p.x - window.innerWidth / 2, ey = p.y - window.innerHeight / 2;
    // A gentle gain: the ship works its aim off at its own turn rate, and whatever is still queued
    // when the point reaches the middle would carry the nose past it.
    g.input.addMouse(ex * 0.2, ey * 0.2);
    return Math.hypot(ex, ey);
  }, away);
}

/** Steers until the point has stayed within `tolerance` pixels of the middle for half a second. */
async function settle(page, away, tolerance, timeoutMs) {
  const t0 = Date.now();
  let held = 0;
  while (Date.now() - t0 < timeoutMs) {
    const off = await steerStep(page, away);
    held = off !== null && off < tolerance ? held + 1 : 0;
    if (held >= 5) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** Turns the nose until the station of the current zone is straight behind the ship. */
const aimAwayFromStation = (page, timeoutMs = 30_000) => settle(page, true, 70, timeoutMs);

/** Steers with the mouse hook until the locked target sits in the middle of the view. */
const aimAtTarget = (page, timeoutMs = 30_000) => settle(page, false, 28, timeoutMs);

/**
 * Keeps the nose on the locked target until `done` says so (returns true), the target is gone
 * (returns 'lost') or the time is up (returns false). `done` receives the distance to the target
 * and the pilot's own distance from the zone anchor, both in metres.
 */
async function steerUntil(page, done, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await steerStep(page, false)) === null) return 'lost';
    const v = await page.evaluate(() => {
      const view = window.primacy2.game.view;
      const ent = view?.ents.find((e) => e.id === view.targetId);
      return ent && view.self ? { dist: Math.hypot(...ent.rel), own: Math.hypot(...view.self.state.pos) } : null;
    });
    if (!v) return 'lost';
    if (done(v)) return true;
    await page.waitForTimeout(100);
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
  if (!(await aimAwayFromStation(page))) throw new Error('could not turn away from the station');
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

  // The second pilot gives chase, closes to gun range outside the mass lock and shoots the first
  // pilot down. A starter ship does not survive that for long.
  if (!(await targetPlayer(page2))) throw new Error('the second pilot does not see the first');
  await page2.keyboard.down('KeyW');
  await page2.keyboard.down('ShiftLeft');
  const closed = await steerUntil(page2, (v) => v.dist < 1400 && v.own > 4700, 90_000);
  await page2.keyboard.up('ShiftLeft');
  await page2.keyboard.up('KeyW');
  if (closed !== true) throw new Error(`the second pilot could not close in on the first (${closed})`);
  if (!(await aimAtTarget(page2))) throw new Error('the second pilot could not aim at the first');
  if (await targetPlayer(page)) await aimAtTarget(page, 6000);
  await page2.mouse.move(800, 450);
  await page2.mouse.down();
  await page2.waitForTimeout(450);
  await page2.screenshot({ path: `${OUT}/07-wingman-fires.png` });
  await shot('08-under-fire');
  const kill = await steerUntil(page2, () => false, 40_000);
  await page2.mouse.up();
  if (kill !== 'lost') throw new Error('the first pilot survived forty seconds of fire');
  await page2.waitForTimeout(150);
  await page2.screenshot({ path: `${OUT}/09-kill.png` });
  await page2.waitForTimeout(2600);
  await page2.screenshot({ path: `${OUT}/10-wreck.png` });
  const wreck = await page2.evaluate(() => window.primacy2.game.view.ents.filter((e) => e.info.kind === 6).length);
  if (wreck < 1) throw new Error('the destroyed ship left no wreck');
  const combat = await page.evaluate(() => window.__combat);
  if (!(combat.shot > 0 && combat.hit > 0)) throw new Error(`the first pilot saw no shots or hits: ${JSON.stringify(combat)}`);
  console.log(`combat events seen by the first pilot: ${JSON.stringify(combat)}`);
  await context2.close();

  // Insurance: the first pilot returns to the home station in a replacement ship and sets out again.
  await page.waitForFunction(() => { const v = window.primacy2.game.view; return !v?.self || v.mode === 4; }, null, { timeout: 10_000 });
  await page.waitForTimeout(800);
  await shot('11-destroyed');
  await page.getByRole('button', { name: /home station/i }).click();
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 3, null, { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot('12-rebuilt-at-station');
  await undock(page);
  if (!(await aimAwayFromStation(page))) throw new Error('could not turn away from the station after the respawn');
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(() => {
    const self = window.primacy2.game.view?.self;
    if (!self) throw new Error('the pilot lost the replacement ship');
    return Math.hypot(...self.state.pos) > 4600;
  }, null, { timeout: 60_000 });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');

  await page.keyboard.press('KeyJ');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 1, null, { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  await page.keyboard.up('KeyW');
  const cruising = await state();
  if (!(cruising.cruise > 60_000)) throw new Error(`cruise did not accelerate: ${JSON.stringify(cruising)}`);
  await shot('13-cruise');

  await page.keyboard.press('KeyM');
  await page.waitForSelector('.panel.map canvas', { timeout: 5000 });
  await page.waitForTimeout(800);
  await shot('14-galaxy-map');
  await page.keyboard.press('Escape');

  await page.keyboard.press('KeyN');
  await page.waitForSelector('.panel.narrow .list', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot('15-navigation');
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
