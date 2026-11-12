// End-to-end smoke test of the real game in a real browser.
//
//   npm run build && node scripts/e2e.mjs
//
// Starts two linked servers (scripts/dev.ts), opens the game in GPU-accelerated headless Chromium,
// logs in, undocks, flies, engages cruise and opens the maps. Screenshots go to screenshots/e2e/.
// Exits with code 1 when a step fails or the page logged an error.
import { spawn } from 'node:child_process';
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
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
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

  await page.fill('.start-card input', 'Test Pilot');
  await page.click('.start-card button.primary');
  await page.waitForFunction(() => window.primacy2?.game?.view?.mode === 3, null, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await shot('02-docked-station');

  // Pointer lock does not exist in headless mode; the input module has a switch for that.
  await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
  await page.click('.panel header button.primary');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 });
  await page.waitForTimeout(1200);
  await shot('03-undocked-cockpit');

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);
  await shot('04-chase');

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  const flying = await state();
  if (!(flying.speed > 60)) throw new Error(`thrust had no effect: ${JSON.stringify(flying)}`);
  await shot('05-flying');

  // Turn with the mouse test hook and keep going until the mass lock is behind us.
  await page.evaluate(() => window.primacy2.game.input.addMouse(120, -40));
  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(() => Math.hypot(...window.primacy2.game.view.self.state.pos) > 4600, null, { timeout: 60_000 });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');

  await page.keyboard.press('KeyJ');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 1, null, { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  await page.keyboard.up('KeyW');
  const cruising = await state();
  if (!(cruising.cruise > 60_000)) throw new Error(`cruise did not accelerate: ${JSON.stringify(cruising)}`);
  await shot('06-cruise');

  await page.keyboard.press('KeyM');
  await page.waitForSelector('.panel.map canvas', { timeout: 5000 });
  await page.waitForTimeout(800);
  await shot('07-galaxy-map');
  await page.keyboard.press('Escape');

  await page.keyboard.press('KeyN');
  await page.waitForSelector('.panel.narrow .list', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot('08-navigation');
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
