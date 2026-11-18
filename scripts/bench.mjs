// Frame time of dev pages with vsync and the frame limit switched off.
//
//   node scripts/bench.mjs <name=url> [<name=url> ...] [--size=2560x1440] [--secs=4] [--rounds=3]
//
// Urls are relative to http://localhost:<port>/dev/, with the port given as "5211:" in front
// (default 5211). The pages are measured in turn, `rounds` times, and the median frame interval of
// the best round is printed: with the frame limit off the interval is what CPU and GPU need together.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? 'true' : a.slice(i + 1)]; }));
const cases = args.filter((a) => !a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  const name = a.slice(0, i);
  let rel = a.slice(i + 1);
  let port = 5211;
  const m = /^(\d{4}):(.*)$/.exec(rel);
  if (m) { port = Number(m[1]); rel = m[2]; }
  return { name, url: `http://localhost:${port}/dev/${rel}`, best: Infinity, mean: 0 };
});
const [width, height] = (flags.size ?? '2560x1440').split('x').map(Number);
const secs = Number(flags.secs ?? 4);
const rounds = Number(flags.rounds ?? 3);

const browser = await chromium.launch({
  headless: flags.headed !== 'true',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
for (let round = 0; round < rounds; round++) {
  for (const c of cases) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`[${c.name}] pageerror: ${e.message}`));
    await page.goto(c.url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const result = await page.evaluate((ms) => new Promise((done) => {
      // Reading one pixel back after the page drew its frame makes the browser wait until the
      // graphics card has finished it; without that, frames are only queued and the interval says nothing.
      const gl = document.getElementById('view').getContext('webgl2');
      const px = new Uint8Array(4);
      const gaps = [];
      let last = performance.now();
      const end = last + ms;
      const tick = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (now < end) requestAnimationFrame(tick);
        else {
          gaps.sort((a, b) => a - b);
          done({ median: gaps[gaps.length >> 1], mean: gaps.reduce((a, b) => a + b, 0) / gaps.length, n: gaps.length });
        }
      };
      requestAnimationFrame(tick);
    }), secs * 1000);
    if (result.median < c.best) { c.best = result.median; c.mean = result.mean; c.n = result.n; }
    await page.close();
  }
}
await browser.close();
for (const c of cases) console.log(`${c.name.padEnd(28)} median ${c.best.toFixed(3)} ms   mean ${c.mean.toFixed(3)} ms   (${c.n} frames, ${width}x${height})`);
