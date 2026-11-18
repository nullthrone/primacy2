// Pictures of effects at exact moments: sequences of a dev page taken with its clock stopped, laid
// out as one sheet per job, and with `--old` as old above new.
//
//   node tools/dev/fx-shots.mjs [jobs.json] --port=5271 [--old=5272] [--only=blast,shield]
//                               [--out=screenshots/fx] [--frames]
//
// Needs a dev server of the client (`npx vite --port 5271 --strictPort` in packages/client);
// `--old` names a second one that serves the code to compare with (a worktree of `main`). The
// default job list is tools/dev/fx-shots.json; `--only` picks jobs by name; `--frames` also keeps
// every frame as a PNG.
//
// A job: { name, page, at, size, dpr, cols, cell, settle, clip | crop + (track | point), follow }
//   page    path below /dev/, e.g. "local.html?scene=fx&show=blast&t=0.5&info=0"
//   at      the moments to take: values of the scene clock on local.html, seconds after the page
//           was ready on space.html (which has no scene clock to read)
//   size    viewport in CSS pixels (default [1280, 720]); dpr scales the drawing buffer, so
//           size [1280, 720] with dpr 3 is the picture of a 3840x2160 screen
//   clip    { x, y, width, height } in CSS pixels, or
//   crop    [width, height] centred on `track` (an entity id, or "self") or on `point`
//           ([x right, y up, z ahead] in metres from the camera); `follow` re-centres every frame
//
// How it works: the page's performance.now() is replaced by a clock that advances by 1/60 s per
// animation frame and stops at each moment asked for, so a frame is taken exactly there however
// long the screenshot takes, and Math.random is seeded, so two runs of the same code draw the same
// sparks. Effects that are changed draw other random numbers; old and new then differ by chance
// as well as by design.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? 'true' : a.slice(i + 1)]; }));
const jobsFile = args.find((a) => !a.startsWith('--')) ?? resolve(here, 'fx-shots.json');
const only = flags.only ? new Set(flags.only.split(',')) : null;
const jobs = JSON.parse(readFileSync(jobsFile, 'utf8')).filter((j) => !only || only.has(j.name));
const outDir = resolve(flags.out ?? 'screenshots/fx');
const port = Number(flags.port ?? 5173);
const sides = flags.old ? [{ label: 'old', port: Number(flags.old) }, { label: 'new', port }] : [{ label: '', port }];
if (!jobs.length) { console.error('no job matches'); process.exit(1); }
mkdirSync(resolve(outDir, 'frames'), { recursive: true });

const INIT = `(() => {
  let virt = 1000;
  const raf = window.requestAnimationFrame.bind(window);
  window.__hold = { virt: 0 }; // { clock } or { virt }: where the clock stops; stopped from the start
  window.__held = 0;           // frames drawn since it stopped
  performance.now = () => virt;
  window.__virt = () => virt;
  window.requestAnimationFrame = (cb) => raf(() => {
    const h = window.__hold;
    const stop = h && (h.clock !== undefined ? (window.__clock ?? -1e9) >= h.clock : virt >= h.virt);
    if (stop) window.__held++; else { virt += 1000 / 60; window.__held = 0; }
    cb(virt);
  });
  let seed = 0x2f6e2b1;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Where an entity, or a point given in camera axes, is on the screen (CSS pixels).
  window.__project = (what) => {
    const v = window.__view;
    if (!v) return null;
    let c;
    if (Array.isArray(what)) c = [what[0], what[1], -what[2]];
    else {
      const e = what === 'self' ? v.self : v.ents.find((x) => x.id === what);
      if (!e) return null;
      const q = v.camera.rot, [x, y, z] = e.rel;
      const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      c = [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
    }
    const f = 1 / Math.tan((v.camera.fov * Math.PI) / 360);
    return { x: (c[0] / -c[2]) * f * innerHeight / 2 + innerWidth / 2, y: innerHeight / 2 - (c[1] / -c[2]) * f * innerHeight / 2 };
  };
})();`;

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = false;

/** Takes the frames of one job from one server; returns [{ file, label }]. */
async function take(job, side) {
  const [width, height] = job.size ?? [1280, 720];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: job.dpr ?? 1 });
  await page.addInitScript(INIT);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  const local = job.page.startsWith('local.html');
  const frames = [];
  let clip = job.clip;
  try {
    await page.goto(`http://localhost:${side.port}/dev/${job.page}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
    // Models may arrive late; the page clock stands still meanwhile.
    await page.waitForTimeout(job.settle ?? (local ? 2500 : 500));
    const base = await page.evaluate('window.__virt()');
    for (let i = 0; i < job.at.length; i++) {
      const t = job.at[i];
      await page.evaluate(local ? `window.__held = 0; window.__hold = { clock: ${t} }` : `window.__held = 0; window.__hold = { virt: ${base + t * 1000} }`);
      await page.waitForFunction('window.__held >= 3', null, { timeout: 120000, polling: 'raf' });
      if (job.crop && (i === 0 || job.follow)) {
        const p = await page.evaluate((w) => window.__project(w), job.track ?? job.point);
        const [cw, ch] = job.crop;
        if (p) clip = { x: Math.round(Math.min(width - cw, Math.max(0, p.x - cw / 2))), y: Math.round(Math.min(height - ch, Math.max(0, p.y - ch / 2))), width: cw, height: ch };
        else if (i === 0) problems.push('nothing to centre the crop on');
      }
      const file = resolve(outDir, 'frames', `${job.name}${side.label ? '-' + side.label : ''}-${i}.png`);
      await page.screenshot({ path: file, clip });
      frames.push({ file, label: `${t.toFixed(2)} s` });
    }
  } catch (err) {
    problems.push(`failed: ${err.message}`);
  }
  await page.close();
  if (problems.length) { failed = true; console.error(`[${job.name}${side.label ? ' ' + side.label : ''}] ${problems.join(' | ')}`); }
  return frames;
}

for (const job of jobs) {
  const blocks = [];
  for (const side of sides) blocks.push({ side, frames: await take(job, side) });
  const cols = job.cols ?? Math.min(job.at.length, 4);
  const cell = job.cell ?? 480;
  const grid = (frames) => `<div style="display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:3px">${
    frames.map((f) => `<div style="position:relative"><img src="file:///${f.file.replace(/\\/g, '/')}" style="width:${cell}px;display:block"><span style="position:absolute;left:6px;top:4px;padding:1px 6px;background:rgba(5,8,12,.72)">${f.label}</span></div>`).join('')}</div>`;
  const html = `<body style="margin:0;background:#05070a;color:#dbe4ec;font:600 12px ui-monospace,Consolas,monospace">${
    blocks.map((b) => `${b.side.label ? `<div style="padding:5px 8px;background:#121923">${job.name}: ${b.side.label} (port ${b.side.port})</div>` : ''}${grid(b.frames)}`).join('')}</body>`;
  const htmlFile = resolve(outDir, 'frames', `${job.name}.html`);
  writeFileSync(htmlFile, html);
  const sheet = await browser.newPage({ viewport: { width: cols * cell + (cols - 1) * 3, height: 100 } });
  await sheet.goto('file:///' + htmlFile.replace(/\\/g, '/'));
  await sheet.waitForTimeout(250);
  const out = resolve(outDir, `${job.name}.jpg`);
  await sheet.screenshot({ path: out, fullPage: true, type: 'jpeg', quality: 88 });
  await sheet.close();
  console.log(`${job.name}: ${out}`);
}
await browser.close();
if (flags.frames !== 'true') {
  // The single frames are scratch unless asked for; the sheets are what is looked at.
  const { rmSync } = await import('node:fs');
  rmSync(resolve(outDir, 'frames'), { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
