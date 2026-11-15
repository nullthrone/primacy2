// Level of single sounds at the output of the audition page, after stage, radio filter, room and limiter.
//
//   AUDITION_URL=http://localhost:<port>/dev/audition.html node tools/dev/audition-level.mjs id,id,... [--dry]
//
// The files of a group can be equally loud and still leave the page at different levels: the radio filter has a
// waveshaper, the room adds a tail, the limiter acts on peaks. This plays each sound once in the page's default
// settings (or with --dry: room 0 and radio filter off), records the output and prints, per sound, the peak, the
// level of the sounding parts (50 ms windows above -45 dBFS, channel 0), the crest factor and whether the overload
// lamp lit. Two more columns look at BOTH channels: "both dBFS" is the level of the sounding parts with the energies
// of the left and the right channel added (a window counts when that sum is above -45 dBFS), and "file>page dB" is the
// energy over both channels at the output of the page, over the whole play, against the energy of the sound file
// (summed over its own channels, as the page decodes it): 0 means the page passes the file's energy on unchanged, 3.01
// means that a one-channel file is heard on two channels. It rates nothing and writes nothing, so it needs no ratings
// file; start it against your own dev server, never against a page somebody is listening on (it presses Play).
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
  const manifest = await page.evaluate(() => fetch('/audio-lib/render/manifest.json').then((r) => r.json()));
  console.log(`settings: ${dry ? 'room 0, radio filter off' : 'the page defaults (room 1, radio filter on)'}`);
  console.log('id                                   length s  peak dBFS  sounding dBFS  both dBFS  file>page dB  crest dB  overload lamp');
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
    const fileFile = (manifest.sounds.find((x) => x.id === id) ?? {}).file;
    const res = await page.evaluate(async ([p, file]) => {
      const cap = window.__audition.capture;
      const whole = cap.window(p.start, p.start + p.length + 2);
      const sq = [];
      const both = [];
      let energy = 0;
      for (let t = p.start; t < p.start + p.length + 2; t += 0.05) {
        sq.push(cap.window(t, t + 0.05).rms);
        const w = cap.windowBoth(t, t + 0.05);
        both.push(w.power);
        energy += w.power * 0.05;
      }
      // the sound file as the page decodes it, its energy over its own channels (amplitude squared times seconds)
      let fileEnergy = 0;
      let channels = 0;
      if (file) {
        const buf = await (await fetch('/audio-lib/render/' + file, { cache: 'no-store' })).arrayBuffer();
        const dec = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf);
        channels = dec.numberOfChannels;
        for (let c = 0; c < channels; c++) {
          const d = dec.getChannelData(c);
          let sum = 0;
          for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
          fileEnergy += sum / dec.sampleRate;
        }
      }
      return { peak: whole.peak, windows: sq, both, energy, fileEnergy, channels };
    }, [play, fileFile]);
    const loud = res.windows.filter((v) => v >= 10 ** (-45 / 20));
    const level = loud.length ? Math.sqrt(loud.reduce((a, v) => a + v * v, 0) / loud.length) : 0;
    const loudBoth = res.both.filter((v) => v >= 10 ** (-45 / 10));
    const levelBoth = loudBoth.length ? Math.sqrt(loudBoth.reduce((a, v) => a + v, 0) / loudBoth.length) : 0;
    const gainFilePage = res.fileEnergy > 0 && res.energy > 0 ? 10 * Math.log10(res.energy / res.fileEnergy) : NaN;
    const lampAfter = await page.evaluate(() => document.getElementById('over-lamp')?.className ?? '');
    console.log(
      `${id.padEnd(36)} ${play.length.toFixed(2).padStart(8)}  ${db(res.peak).toFixed(1).padStart(9)}  ${db(level).toFixed(1).padStart(13)}  ${db(levelBoth).toFixed(1).padStart(9)}  ${gainFilePage.toFixed(2).padStart(12)}  ${(db(res.peak) - db(level)).toFixed(1).padStart(8)}  ${lampAfter === lampBefore ? 'unchanged' : 'CHANGED'} (${lampAfter || 'no class'})`,
    );
    await page.click('#stop-all').catch(() => undefined);
    await sleep(400);
  }
} finally {
  await browser.close();
}
