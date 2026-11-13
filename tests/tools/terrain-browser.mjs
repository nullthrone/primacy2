// Compares the terrain and the landing step in Node and in Chromium (and in Node without the
// optimising compiler), as exact float64 bit patterns.
//
//   npx tsx tests/tools/terrain-browser.mjs
//
// The suite (tests/tools/determinism-suite.ts) is bundled with esbuild for the browser, as Vite does
// for the game, and run through Playwright. Exits with 1 when any value differs.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { runSuite } from './determinism-suite.ts';

const bundle = await build({
  entryPoints: ['tests/tools/determinism-suite.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Suite',
  write: false,
  target: 'es2022',
});
const code = bundle.outputFiles[0].text;

const node = runSuite(`node ${process.version} (V8 ${process.versions.v8})`);

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('pageerror ' + e));
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: code });
const ua = await page.evaluate(() => navigator.userAgent);
const chrome = await page.evaluate(() => globalThis.Suite.runSuite(navigator.userAgent));
await browser.close();

// The same code in Node's interpreter, without any JIT tier.
let jitless = null;
try {
  const script = "import('./tests/tools/determinism-suite.ts').then((m) => process.stdout.write('@@' + JSON.stringify(m.runSuite('node --jitless'))))";
  const out = execFileSync(process.execPath, ['--jitless', '--import', 'tsx', '-e', script], {
    encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900_000,
  });
  jitless = JSON.parse(out.slice(out.indexOf('@@') + 2));
} catch (e) {
  console.log('node --jitless could not run the suite:', String(e.message).split('\n')[0]);
}

function diff(a, b, label) {
  let n = 0;
  let total = 0;
  const first = [];
  const cmp = (x, y, where) => {
    total += x.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] !== y[i]) {
        n++;
        if (first.length < 3) first.push(`${where}[${i}] ${x[i]} vs ${y[i]}`);
      }
    }
  };
  for (const k of Object.keys(a.terrain)) {
    if (!b.terrain[k]) {
      n++;
      first.push('missing ' + k);
      continue;
    }
    cmp(a.terrain[k].cold, b.terrain[k].cold, k + ' cold');
    cmp(a.terrain[k].warm, b.terrain[k].warm, k + ' warm');
  }
  cmp(a.landings, b.landings, 'landings');
  console.log(`${label}: ${total} float64 values compared, ${n} differ ${first.join(' | ')}`);
  return n;
}
let bad = 0;
console.log('bodies:', Object.keys(node.terrain).join('; '));
console.log('node :', node.engine, '| chromium:', ua);
console.log(`values per engine: ${node.values}; landing runs ended in modes: ${node.landings.filter((x) => /^\d+:\d$/.test(x)).join(' ')}`);
bad += diff(node, chrome, 'node vs chromium');
for (const [name, r] of [['node', node], ['chromium', chrome]]) {
  for (const [k, v] of Object.entries(r.terrain)) {
    const cw = v.cold.filter((x, i) => x !== v.warm[i]).length;
    if (cw) {
      console.log(`cold vs warm differ in ${name} for ${k}: ${cw}`);
      bad++;
    }
  }
}
if (jitless) bad += diff(node, jitless, 'node vs node --jitless');
if (logs.length) console.log('page log:', logs.slice(0, 5));
process.exit(bad ? 1 : 0);
