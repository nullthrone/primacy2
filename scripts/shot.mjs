// Takes a screenshot of a page with GPU-accelerated headless Chromium.
//
//   node scripts/shot.mjs <url> <out.png> [--size=1600x900] [--wait=1500] [--until=<js expr>]
//                                        [--eval=<js to run before the shot>] [--dpr=1]
//
// Prints console errors and page errors of the page to stderr and exits with code 2 if there were any.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--size=WxH] [--wait=ms] [--until=expr] [--eval=js] [--dpr=n]');
  process.exit(1);
}
const opt = Object.fromEntries(rest.map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? 'true' : a.slice(i + 1)]; }));
const [width, height] = (opt.size ?? '1600x900').split('x').map(Number);

// Software rendering is the headless default; these flags select the real GPU through ANGLE/D3D11.
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(opt.dpr ?? 1) });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  if (opt.until) await page.waitForFunction(opt.until, null, { timeout: 30000 });
  if (opt.eval) await page.evaluate(opt.eval);
  await page.waitForTimeout(Number(opt.wait ?? 1500));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
} catch (err) {
  problems.push(`shot failed: ${err.message}`);
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
