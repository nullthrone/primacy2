// Level of single sounds at the output of the audition page, after stage, radio filter, room and limiter.
//
//   AUDITION_URL=http://localhost:<port>/dev/audition.html node tools/dev/audition-level.mjs id,id,... [--dry]
//
// The files of a group can be equally loud and still leave the page at different levels: the radio filter has a
// waveshaper, the room adds a tail, the limiter acts on peaks. This plays each sound once in the page's default
// settings (or with --dry: room 0 and radio filter off), records the output and prints, per sound, the peak, the
// level of the sounding parts (50 ms windows above -45 dBFS, channel 0), the crest factor and whether the overload
// lamp lit. It rates nothing and writes nothing, so it needs no ratings file; start it against your own dev
// server, never against a page somebody is listening on (it presses Play).
import { chromium } from 'playwright';

const URL_PAGE = process.env.AUDITION_URL;
if (!URL_PAGE) {
  console.error('Set AUDITION_URL to the audition page of your own dev server.');
  process.exit(2);
}
const ids = (process.argv[2] ?? '').split(',').filter(Boolean);
const dry = process.argv.includes('--dry');
if (!ids.length) {
  console.error('Give the sound ids, comma separated.');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(URL_PAGE);
  await page.waitForSelector('button[data-sound]', { timeout: 30000 });
  if (dry) {
    await page.evaluate(() => {
      const room = document.getElementById('room');
      room.value = '0';
      room.dispatchEvent(new Event('input', { bubbles: true }));
      const radio = document.getElementById('sw-radio');
      if (radio.checked) radio.click();
    });
  }
  console.log(`settings: ${dry ? 'room 0, radio filter off' : 'the page defaults (room 1, radio filter on)'}`);
  console.log('id                                   length s  peak dBFS  sounding dBFS  crest dB  overload lamp');
  for (const id of ids) {
    const sel = `button[data-sound="${id}"]`;
    if (!(await page.$(sel))) {
      console.log(`${id.padEnd(36)} not on the page`);
      continue;
    }
    const lampBefore = await page.evaluate(() => document.getElementById('over-lamp')?.className ?? '');
    const n = await page.evaluate(() => (window.__audition.plays ?? []).length);
    await page.evaluate(() => window.__audition.capture.start());
    await page.click(sel);
    await page.waitForFunction((k) => (window.__audition.plays ?? []).length > k, n, { timeout: 8000 });
    const play = await page.evaluate((k) => {
      const p = window.__audition.plays[k];
      return { start: p.start, end: p.end, length: p.length };
    }, n);
    await sleep((play.length + 2.5) * 1000);
    await page.evaluate(() => window.__audition.capture.stop());
    const res = await page.evaluate((p) => {
      const cap = window.__audition.capture;
      const whole = cap.window(p.start, p.start + p.length + 2);
      const sq = [];
      for (let t = p.start; t < p.start + p.length + 2; t += 0.05) sq.push(cap.window(t, t + 0.05).rms);
      return { peak: whole.peak, windows: sq };
    }, play);
    const loud = res.windows.filter((v) => v >= 10 ** (-45 / 20));
    const level = loud.length ? Math.sqrt(loud.reduce((a, v) => a + v * v, 0) / loud.length) : 0;
    const lampAfter = await page.evaluate(() => document.getElementById('over-lamp')?.className ?? '');
    console.log(
      `${id.padEnd(36)} ${play.length.toFixed(2).padStart(8)}  ${db(res.peak).toFixed(1).padStart(9)}  ${db(level).toFixed(1).padStart(13)}  ${(db(res.peak) - db(level)).toFixed(1).padStart(8)}  ${lampAfter === lampBefore ? 'unchanged' : 'CHANGED'} (${lampAfter || 'no class'})`,
    );
    await page.click('#stop-all').catch(() => undefined);
    await sleep(400);
  }
} finally {
  await browser.close();
}
