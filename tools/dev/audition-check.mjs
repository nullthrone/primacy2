// Checks the audition page in a real (headless) Chromium. Starts nothing itself: run
//   cd packages/client && AUDITION_RATINGS_FILE=<a scratch file> npx vite --port 5183 --strictPort
// first. The page is taken from AUDITION_URL (default http://localhost:5183/dev/audition.html).
// The check writes ratings through the page, so the server must keep them in AUDITION_RATINGS_FILE (the same
// variable is read here), never in the owner's assets/audio/ratings.json.
// Saves screenshots to screenshots/audition/ and exits with code 1 on any failure.
import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_PAGE = process.env.AUDITION_URL ?? 'http://localhost:5183/dev/audition.html';
const ORIGIN = new URL(URL_PAGE).origin;
const SHOTS = path.join(ROOT, 'screenshots', 'audition');
const OWNERS = path.join(ROOT, 'assets', 'audio', 'ratings.json');
if (!process.env.AUDITION_RATINGS_FILE || path.resolve(process.env.AUDITION_RATINGS_FILE) === OWNERS) {
  console.error('Set AUDITION_RATINGS_FILE to a scratch file (the same one the vite server was started with): this check writes ratings.');
  process.exit(2);
}
const RATINGS = path.resolve(process.env.AUDITION_RATINGS_FILE);
const BACKUP = RATINGS + '.audition-check-backup';
const SPEED = 25;

mkdirSync(SHOTS, { recursive: true });
const failures = [];
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A browser tidies '..' away before sending, so the traversal probes go out as they are written.
const rawStatus = (p) =>
  new Promise((resolve, reject) => {
    const u = new URL(ORIGIN);
    http.get({ host: u.hostname, port: u.port, path: p }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hadRatings = existsSync(RATINGS);
if (hadRatings) copyFileSync(RATINGS, BACKUP);

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];

async function openPage(context, { route } = {}) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  if (route) await route(page);
  await page.goto(URL_PAGE);
  await page.waitForSelector('.sound, #banner-missing', { timeout: 15000 });
  await page.evaluate((s) => {
    window.__audition.speed = s;
  }, SPEED);
  return page;
}

// Puts an element `offset` pixels below the top, clear of the sticky header, for the screenshots.
const scrollTo = (page, selector, offset) =>
  page.evaluate(([sel, off]) => window.scrollTo(0, document.querySelector(sel).getBoundingClientRect().top + window.scrollY - off), [selector, offset]);

const peakMax = (page) => page.evaluate(() => window.__audition.peakMax);

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'de-DE', acceptDownloads: true });
  const page = await openPage(context);
  let manifest;

  await check('manifest loads and the page lists every sound', async () => {
    manifest = await page.evaluate(() => fetch('/audio-lib/render/manifest.json').then((r) => r.json()));
    const rows = await page.locator('.sound').count();
    assert(rows === manifest.sounds.length, `page lists ${rows} rows, manifest has ${manifest.sounds.length}`);
    assert(manifest.sounds.length > 0, 'manifest is empty');
    const banner = await page.locator('#banner-placeholder').count();
    assert(banner === (manifest.placeholder ? 1 : 0), 'placeholder banner does not match the manifest');
  });

  await check('default language follows the browser (de-DE) and the switch works', async () => {
    assert((await page.locator('[data-tab="library"]').innerText()) === 'Bibliothek', 'German tab label expected');
    await page.screenshot({ path: path.join(SHOTS, 'library-top-de.png') });
    await page.click('[data-lang="en"]');
    assert((await page.locator('[data-tab="library"]').innerText()) === 'Library', 'English tab label expected');
    await page.screenshot({ path: path.join(SHOTS, 'library-top-en.png') });
    // The owner reads German: every later screenshot is taken in German.
    await page.click('[data-lang="de"]');
  });

  await check('server refuses paths outside render/downloads, oversized and malformed bodies', async () => {
    const before = errors.length;
    const r = await page.evaluate(async () => {
      const put = (body) => fetch('/audio-lib/ratings', { method: 'PUT', body }).then((x) => x.status);
      return {
        big: await put('{"a":"' + 'x'.repeat(1100 * 1024) + '"}'),
        bad: await put('not json'),
      };
    });
    r.up = await rawStatus('/audio-lib/render/../../../package.json');
    r.enc = await rawStatus('/audio-lib/%2e%2e/%2e%2e/package.json');
    r.dir = await rawStatus('/audio-lib/render');
    // The browser logs the refused requests as errors; they are the point of this step.
    errors.length = before;
    assert(r.up === 403 && r.enc === 403 && r.dir === 403, `traversal not refused: ${JSON.stringify(r)}`);
    assert(r.big === 413, `oversized body gave ${r.big}`);
    assert(r.bad === 400, `malformed body gave ${r.bad}`);
  });

  await check('a one-shot gives a signal', async () => {
    await page.evaluate(() => window.__audition.resetPeak());
    await page.click('button[data-sound="thruster_pulse_a"]');
    await sleep(700);
    const p = await peakMax(page);
    assert(p > 0.001, `peak ${p}`);
  });

  await check('a loop gives a signal and toggles off', async () => {
    await page.evaluate(() => window.__audition.resetPeak());
    const btn = page.locator('button[data-sound="thruster_burn_loop"]');
    await btn.click();
    await sleep(900);
    assert((await peakMax(page)) > 0.001, 'no signal from the loop');
    assert((await btn.getAttribute('aria-label')).startsWith('Stop'), 'loop button does not offer Stop');
    await btn.click();
    await sleep(300);
    assert(/^(Play|Abspielen)/.test(await btn.getAttribute('aria-label')), 'loop did not stop');
  });

  await check('keyboard: Enter on a focused play button plays', async () => {
    await page.evaluate(() => window.__audition.resetPeak());
    await page.focus('button[data-sound="switch_toggle"]');
    await page.keyboard.press('Enter');
    await sleep(500);
    assert((await peakMax(page)) > 0.001, 'no signal');
  });

  await check('radio sound, via-radio switch, cabin and limiter switches play without error', async () => {
    await page.evaluate(() => window.__audition.resetPeak());
    await page.click('button[data-sound="radio_tone"]');
    await page.locator('#s-alarm_heat input[type="checkbox"]').check();
    await page.click('button[data-sound="alarm_missile"]');
    await sleep(700);
    await page.click('button[data-sound="alarm_missile"]');
    await page.uncheck('#sw-cabin');
    await page.uncheck('#sw-limiter');
    await page.click('button[data-sound="sensor_contact_ping"]');
    await sleep(500);
    await page.check('#sw-cabin');
    await page.check('#sw-limiter');
    assert((await peakMax(page)) > 0.001, 'no signal');
  });

  await check('rendered and downloaded rows are split, with licence and a measured length', async () => {
    const downloads = manifest.sounds.filter((x) => x.source === 'download');
    assert(downloads.length > 0, 'the manifest has no downloaded sound to check');
    assert((await page.locator('.sound.download').count()) === downloads.length, 'downloaded rows are not all marked');
    assert((await page.locator('.part.downloaded').count()) >= 5, 'categories lack their downloaded block');
    assert((await page.locator('.part.rendered').count()) >= 5, 'categories lack their rendered block');
    const nasa = downloads.find((x) => x.licence === 'Public domain (NASA)');
    const cc0 = downloads.find((x) => x.licence === 'CC0 1.0');
    assert((await page.locator(`#s-${nasa.id} .badge.licence`).innerText()) === 'Public domain (NASA)', 'NASA licence not shown');
    assert((await page.locator(`#s-${cc0.id} .badge.licence`).innerText()) === 'CC0 1.0', 'CC0 licence not shown');
    // The build leaves the length of downloads at 0; the page measures it by decoding every file.
    await page.waitForFunction(
      (ids) => ids.every((id) => /\d s$/.test(document.querySelector(`#s-${id} .badge.mono`).textContent.trim())),
      downloads.map((x) => x.id),
      { timeout: 30000 },
    );
    await scrollTo(page, '#cat-engines .part.downloaded', 375);
    await page.screenshot({ path: path.join(SHOTS, 'library-category-engines.png') });
    await scrollTo(page, '#cat-radio .part.downloaded', 295);
    await page.screenshot({ path: path.join(SHOTS, 'library-category-radio.png') });
  });

  await check('downloaded mp3, ogg and wav files decode and play, and a second press stops them', async () => {
    for (const id of ['n_sts_how_do_you_read', 'k_toggle_1', 'n_quindar_1']) {
      await page.evaluate(() => window.__audition.resetPeak());
      const btn = page.locator(`button[data-sound="${id}"]`);
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await sleep(900);
      assert((await peakMax(page)) > 0.001, `no signal from ${id}`);
    }
    const btn = page.locator('button[data-sound="n_quindar_1"]');
    assert(/^Stop/.test(await btn.getAttribute('aria-label')), 'a long clip does not offer Stop');
    await btn.click();
    await sleep(400);
    assert(!/^Stop/.test(await btn.getAttribute('aria-label')), 'the clip did not stop');
  });

  await check('thrust slider crossfades the engine group with equal power', async () => {
    await scrollTo(page, '#group-engine', 235);
    await page.click('#group-toggle');
    await sleep(300);
    const setThrust = (v) =>
      page.evaluate((x) => {
        const el = document.getElementById('group-thrust');
        el.value = String(x);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return window.__audition.groupLevels();
      }, v);
    const at0 = await setThrust(0);
    assert(at0.length >= 2, `group has ${at0.length} levels`);
    assert(at0[0].gain === 1 && at0.slice(1).every((l) => l.gain === 0), 'thrust 0 should sound the idle level only');
    const mid = await setThrust(0.375);
    const active = mid.filter((l) => l.gain > 0);
    assert(active.length === 2, `thrust 0.375 should mix two neighbours, got ${active.length}`);
    const power = active.reduce((s, l) => s + l.gain * l.gain, 0);
    assert(Math.abs(power - 1) < 1e-6, `power sum ${power}`);
    assert(active[0].thrust === 0.25 && active[1].thrust === 0.5, 'wrong neighbours');
    const top = await setThrust(1.4);
    assert(top[top.length - 1].gain === 1, 'boost level should sound alone at 1.4');
    await sleep(200);
    await page.screenshot({ path: path.join(SHOTS, 'engine-group.png') });
    await page.click('#group-toggle');
  });

  for (const id of ['docking', 'combat', 'landing']) {
    await check(`scene ${id}: written sequence starts and reaches its end`, async () => {
      await page.click(`[data-tab="${id}"]`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForSelector(`#scene-${id}`);
      await page.screenshot({ path: path.join(SHOTS, `scene-${id}-idle.png`) });
      await page.evaluate(() => window.__audition.resetPeak());
      await page.click(`#scene-${id} [data-act="play-scene"]`);
      await page.waitForFunction((sid) => window.__audition.sceneRuns[sid]?.started >= 1, id, { timeout: 5000 });
      // Halfway through, so that the sliders and lit buttons show a moment of the sequence.
      await sleep((40 / SPEED) * 1000 * 0.55);
      await page.screenshot({ path: path.join(SHOTS, `scene-${id}-running.png`) });
      await page.waitForFunction((sid) => window.__audition.sceneRuns[sid]?.ended >= 1, id, { timeout: 20000 });
      assert((await peakMax(page)) > 0.001, 'the scene made no sound');
      await sleep(400);
    });
  }

  await check('chained one-shots start at the cue of the previous one (else 20 ms before its end)', async () => {
    await page.click('[data-tab="landing"]');
    await page.click('#scene-landing [data-event="cruise_start"]');
    await page.waitForFunction(() => (window.__audition.plays ?? []).some((p) => p.id === 'cruise_engage'), null, { timeout: 5000 });
    const plays = await page.evaluate(() => window.__audition.plays);
    const charge = plays.filter((p) => p.id === 'cruise_charge').pop();
    const engage = plays.filter((p) => p.id === 'cruise_engage').pop();
    // Where the next sound starts: the charge's cue when the manifest has one, else 20 ms before its end.
    const cue = manifest.sounds.find((x) => x.id === 'cruise_charge').cue;
    const planned = cue > 0 && cue < charge.end - charge.start ? charge.start + cue : charge.end - 0.02;
    const gap = engage.start - planned;
    assert(Math.abs(gap) < 0.001, `engage starts ${(gap * 1000).toFixed(2)} ms off the planned overlap`);
  });

  await check('the thrust slider sounds the engine alone while no scene runs', async () => {
    await page.click('[data-tab="combat"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.__audition.resetPeak());
    await page.evaluate(() => {
      const el = document.getElementById('combat-thrust');
      el.value = '0.6';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(1200);
    assert((await peakMax(page)) > 0.001, 'moving the slider made no sound');
    const label = await page.locator('#scene-combat [data-act="engine-solo"]').innerText();
    assert(/■/.test(label), `solo button says ${label}`);
    await page.evaluate(() => {
      const el = document.getElementById('combat-thrust');
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, 'scene-combat-engine-solo.png') });
    await page.click('#scene-combat [data-act="engine-solo"]');
    await sleep(300);
    assert(/▶/.test(await page.locator('#scene-combat [data-act="engine-solo"]').innerText()), 'the engine did not stop');
  });

  await check('written sequences at real speed with the limiter off never reach clipping', async () => {
    await page.evaluate(() => (window.__audition.speed = 1));
    await page.uncheck('#sw-limiter');
    for (const id of ['docking', 'combat', 'landing']) {
      await page.click(`[data-tab="${id}"]`);
      await page.evaluate(() => window.scrollTo(0, 0));
      const before = await page.evaluate((sid) => window.__audition.sceneRuns[sid]?.ended ?? 0, id);
      await page.evaluate(() => window.__audition.resetPeak());
      await page.click(`#scene-${id} [data-act="play-scene"]`);
      await sleep(14000);
      await page.screenshot({ path: path.join(SHOTS, `scene-${id}-running.png`) });
      await page.waitForFunction((a) => window.__audition.sceneRuns[a.sid].ended > a.before, { sid: id, before }, { timeout: 60000 });
      const p = await peakMax(page);
      console.log(`      ${id}: peak ${p.toFixed(3)} (${(20 * Math.log10(p)).toFixed(1)} dBFS)`);
      assert(p < 0.999, `${id} reaches clipping: ${p}`);
      await sleep(500);
    }
    await page.check('#sw-limiter');
    await page.evaluate((s) => (window.__audition.speed = s), SPEED);
  });

  await check('scene sliders and boost move the state', async () => {
    await page.click('[data-tab="combat"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#scene-combat [data-act="boost"]');
    const pressed = await page.locator('#scene-combat [data-act="boost"]').getAttribute('aria-pressed');
    assert(pressed === 'true', 'boost did not engage');
    await page.click('#scene-combat [data-act="boost"]');
    await page.click('#scene-combat [data-event="shield_heavy"]');
    await sleep(300);
  });

  await check('a rating reaches assets/audio/ratings.json through the endpoint', async () => {
    await page.click('[data-tab="library"]');
    const id = manifest.sounds[0].id;
    const row = page.locator(`#s-${id}`);
    await row.locator('.stars button').nth(3).click();
    await row.locator('.verdicts .close').click();
    await row.locator('textarea').fill('audition-check note');
    await page.waitForFunction(() => /ratings\.json/.test(document.getElementById('save-status').textContent), null, { timeout: 5000 });
    const saved = JSON.parse(readFileSync(RATINGS, 'utf-8'));
    const r = saved.ratings[id];
    assert(saved.version === 1 && r && r.stars === 4 && r.verdict === 'close' && r.note === 'audition-check note', `file holds ${JSON.stringify(r)}`);
    assert(saved.manifest.count === manifest.sounds.length && typeof saved.savedAt === 'string', 'manifest info or savedAt missing');
    assert((await page.locator('#rated-count').innerText()).startsWith('1 / '), 'counter did not move');
  });

  await check('the "only unrated" filter hides what is rated', async () => {
    await page.locator('#only-unrated').check();
    const rows = await page.locator('.sound').count();
    assert(rows === manifest.sounds.length - 1, `${rows} rows with the filter`);
    await page.locator('#only-unrated').uncheck();
  });

  await check('Export produces a download with the ratings', async () => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#export')]);
    const file = path.join(SHOTS, 'exported-ratings.json');
    await download.saveAs(file);
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    assert(data.version === 1 && data.ratings[manifest.sounds[0].id]?.stars === 4, 'export does not hold the rating');
    rmSync(file);
  });

  await context.close();

  // ---- The stage, the room, the changed mark and the fold scene, on a doctored manifest with generated test files.
  const wav = (channels, left, right) => {
    const n = left.length;
    const buf = Buffer.alloc(44 + n * channels * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * channels * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(48000, 24);
    buf.writeUInt32LE(48000 * channels * 2, 28);
    buf.writeUInt16LE(channels * 2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * channels * 2, 40);
    for (let i = 0; i < n; i++) {
      buf.writeInt16LE(Math.round(left[i] * 32767), 44 + i * channels * 2);
      if (channels === 2) buf.writeInt16LE(Math.round(right[i] * 32767), 46 + i * channels * 2);
    }
    return buf;
  };
  // One second of 440 Hz at half scale, faded at both ends so that nothing clicks.
  const tone = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000) * Math.min(1, i / 480, (48000 - i) / 480));
  const silence = new Float32Array(48000);
  const TEST_FILES = {
    'test/mono.wav': wav(1, tone),
    'test/left_only.wav': wav(2, tone, silence),
  };
  const testSound = (id, file, extra) => ({
    id,
    file,
    category: 'engines',
    kind: 'oneshot',
    path: 'structure',
    family: null,
    intent: 'test tone',
    source: 'synth',
    licence: 'test',
    duration: 1,
    channels: 1,
    gain: 1,
    dry: false,
    en: id,
    de: id,
    ...extra,
  });
  const hashOf = (id) => `h1-${id}`.slice(0, 12).padEnd(12, '0');
  const stageRoute = (variant) => async (p) => {
    await p.route('**/audio-lib/render/test/*.wav', (r) => r.fulfill({ body: TEST_FILES[`test/${new URL(r.request().url()).pathname.split('/').pop()}`], contentType: 'audio/wav' }));
    await p.route('**/audio-lib/render/manifest.json', async (r) => {
      const res = await r.fetch();
      const m = await res.json();
      m.sounds.push(
        testSound('test_right', 'test/mono.wav', { place: 90 }),
        testSound('test_free', 'test/mono.wav', {}),
        testSound('test_dry', 'test/mono.wav', { place: 0, dry: true }),
        testSound('test_left_only', 'test/left_only.wav', { channels: 2 }),
      );
      for (const sound of m.sounds) sound.hash = hashOf(sound.id);
      // The cue of the fold charge: the jump must start there and not 20 ms before the end.
      const charge = m.sounds.find((x) => x.id === 'fold_charge');
      if (charge && variant.cue) charge.cue = variant.cue;
      for (const [id, hash] of Object.entries(variant.hashes ?? {})) {
        const sound = m.sounds.find((x) => x.id === id);
        if (sound) sound.hash = hash;
      }
      await r.fulfill({ response: res, json: m });
    });
    if (variant.round1) await p.route('**/audio-lib/rounds/round1.json', (r) => r.fulfill({ json: { round: 1, hashes: variant.round1 } }));
  };
  const setRange = (pg, id, v) =>
    pg.evaluate(
      ([i, x]) => {
        const el = document.getElementById(i);
        el.value = String(x);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      [id, v],
    );
  // A click without the scrolling dance under the sticky header.
  const press = (pg, selector) => pg.locator(selector).dispatchEvent('click');
  // Plays a test sound and returns the highest peak of each output channel while it sounds.
  const channelsOf = async (pg, id) => {
    await pg.evaluate(() => window.__audition.resetPeak());
    await press(pg, `button[data-sound="${id}"]`);
    await sleep(900);
    const peaks = await pg.evaluate(() => ({ l: window.__audition.peakLMax, r: window.__audition.peakRMax }));
    // The test tone lasts one second: let it end, so that it does not leak into the next measurement.
    await sleep(350);
    return peaks;
  };

  const ctxS = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'de-DE' });
  const pageS = await ctxS.newPage();
  pageS.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  pageS.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await stageRoute({ cue: 2 })(pageS);
  await pageS.goto(URL_PAGE);
  await pageS.waitForSelector('#s-test_right');
  await pageS.evaluate((s) => (window.__audition.speed = s), SPEED);

  await check('the stage switch has three settings, German texts, Stereo by default', async () => {
    const labels = await pageS.locator('.segmented button').allInnerTexts();
    assert(labels.join('|') === 'Mono|Stereo (Lautsprecher)|Kopfhörer', `labels ${labels.join('|')}`);
    assert((await pageS.locator('[data-stage="stereo"]').getAttribute('aria-pressed')) === 'true', 'Stereo is not the default');
    assert((await pageS.locator('label[for="room"]').innerText()) === 'Raum', 'room label');
    await pageS.click('[data-lang="en"]');
    const en = await pageS.locator('.segmented button').allInnerTexts();
    assert(en.join('|') === 'Mono|Stereo (loudspeakers)|Headphones', `English labels ${en.join('|')}`);
    await pageS.click('[data-lang="de"]');
    await pageS.evaluate(() => window.scrollTo(0, 0));
    await pageS.screenshot({ path: path.join(SHOTS, 'stage-header-de.png'), clip: { x: 0, y: 0, width: 1280, height: 156 } });
  });

  await check('Stereo: a sound with place 90 is louder on the right; a place ahead is even', async () => {
    await setRange(pageS, 'room', 0);
    const side = await channelsOf(pageS, 'test_right');
    assert(side.r > 0.05, `right peak ${side.r}`);
    assert(side.l < side.r * 0.1, `left ${side.l} against right ${side.r}`);
    const ahead = await channelsOf(pageS, 'test_dry');
    assert(ahead.l > 0.02 && Math.abs(ahead.l - ahead.r) < 0.15 * ahead.l, `ahead: left ${ahead.l}, right ${ahead.r}`);
  });

  await check('Mono: both channels are equal for a placed sound', async () => {
    await pageS.click('[data-stage="mono"]');
    const m = await channelsOf(pageS, 'test_right');
    assert(m.l > 0.05 && Math.abs(m.l - m.r) < 0.02 * m.l, `mono: left ${m.l}, right ${m.r}`);
  });

  await check('Headphones: a place at 90 degrees is heard louder on the right (HRTF)', async () => {
    await pageS.click('[data-stage="headphones"]');
    const h = await channelsOf(pageS, 'test_right');
    assert(h.r > 0.03 && h.r > h.l * 1.2, `headphones: left ${h.l}, right ${h.r}`);
    const plays = await pageS.evaluate(() => window.__audition.plays.filter((x) => x.id === 'test_right').pop());
    assert(plays.azimuth === 90, `azimuth ${plays.azimuth}`);
  });

  await check('a file with two channels keeps its channels in Stereo and Headphones, and is summed in Mono', async () => {
    for (const mode of ['stereo', 'headphones']) {
      await pageS.click(`[data-stage="${mode}"]`);
      const c = await channelsOf(pageS, 'test_left_only');
      assert(c.l > 0.05 && c.r < c.l * 0.02, `${mode}: left ${c.l}, right ${c.r}`);
    }
    await pageS.click('[data-stage="mono"]');
    const m = await channelsOf(pageS, 'test_left_only');
    assert(m.l > 0.02 && Math.abs(m.l - m.r) < 0.02 * m.l, `mono sum: left ${m.l}, right ${m.r}`);
    assert(m.l < 0.3, `mono sum should be half the left file, got ${m.l}`);
    const plays = await pageS.evaluate(() => window.__audition.plays.filter((x) => x.id === 'test_left_only').pop());
    assert(plays.azimuth === null, 'a two-channel file must not get a direction');
    await pageS.click('[data-stage="stereo"]');
  });

  await check('a sound without a place gets a new direction at every trigger', async () => {
    for (let i = 0; i < 8; i++) {
      await press(pageS, 'button[data-sound="test_free"]');
      await sleep(60);
    }
    const az = await pageS.evaluate(() => window.__audition.plays.filter((x) => x.id === 'test_free').map((x) => x.azimuth));
    assert(new Set(az.map((x) => Math.round(x))).size >= 4, `directions ${az.map((x) => Math.round(x)).join(', ')}`);
    await sleep(1100);
  });

  await check('the room send: dry sounds get the full send, baked ones a smaller one, Room scales both, Cabin turns it off', async () => {
    await pageS.click('#stop-all');
    await setRange(pageS, 'room', 1);
    await sleep(400);
    const full = await pageS.evaluate(() => window.__audition.sendLevels());
    assert(Math.abs(full.dryWet - 1) < 0.02 && full.bakedSend > 0.1 && full.bakedSend < full.dryWet * 0.5, `sends at room 1: ${JSON.stringify(full)}`);
    await setRange(pageS, 'room', 0.5);
    await sleep(400);
    const half = await pageS.evaluate(() => window.__audition.sendLevels());
    assert(Math.abs(half.dryWet - 0.5) < 0.02 && Math.abs(half.bakedSend - full.bakedSend / 2) < 0.01, `sends at room 0.5: ${JSON.stringify(half)}`);
    await setRange(pageS, 'room', 1);
    await pageS.uncheck('#sw-cabin');
    await sleep(400);
    const off = await pageS.evaluate(() => window.__audition.sendLevels());
    assert(off.dryWet < 0.01 && off.bakedSend < 0.01 && off.dryDirect > 0.98, `sends with the cabin off: ${JSON.stringify(off)}`);
    await pageS.check('#sw-cabin');
    await sleep(300);
  });

  await check('the room is audible: a baked sound leaves a tail after it ends, and none at Room 0', async () => {
    const tail = async (id, room) => {
      await setRange(pageS, 'room', room);
      await sleep(300);
      await press(pageS, `button[data-sound="${id}"]`);
      await sleep(1060);
      await pageS.evaluate(() => window.__audition.resetPeak());
      await sleep(300);
      const t = await pageS.evaluate(() => Math.max(window.__audition.peakLMax, window.__audition.peakRMax));
      await sleep(600);
      return t;
    };
    const open = await tail('test_dry', 1);
    const shut = await tail('test_dry', 0);
    assert(open > 0.0005, `no tail with the room open: ${open}`);
    assert(shut < open * 0.2, `tail ${shut} at room 0 against ${open} at room 1`);
    // A sound with the cabin baked in gets the smaller send: its tail is there, and quieter.
    const bakedOpen = await tail('test_right', 1);
    assert(bakedOpen > 0.00005 && bakedOpen < open, `baked tail ${bakedOpen} against dry tail ${open}`);
  });

  await check('fold scene: buttons, chain honours the cue, tunnel passes meet without a gap', async () => {
    await pageS.click('[data-tab="fold"]');
    await pageS.evaluate(() => window.scrollTo(0, 0));
    await pageS.waitForSelector('#scene-fold');
    const buttons = await pageS.locator('#scene-fold .events button').count();
    assert(buttons >= 7, `${buttons} event buttons`);
    assert((await pageS.locator('#scene-fold [data-role="missing"]').count()) === 0, 'the fold scene lists missing sounds');
    assert((await pageS.locator('#fold-thrust').count()) === 0, 'the fold scene should show no thrust slider');
    await pageS.screenshot({ path: path.join(SHOTS, 'scene-fold-idle.png') });
    await pageS.evaluate(() => (window.__audition.plays = []));
    await press(pageS, '#scene-fold [data-event="chain2"]');
    await pageS.waitForFunction(() => (window.__audition.plays ?? []).some((p) => p.id === 'fold_exit'), null, { timeout: 40000 });
    const plays = await pageS.evaluate(() => window.__audition.plays);
    const get = (id) => plays.filter((p) => p.id === id);
    const charge = get('fold_charge')[0];
    const jump = get('fold_jump')[0];
    const passes = get('fold_tunnel_loop');
    const exit = get('fold_exit')[0];
    assert(Math.abs(jump.start - charge.start - 2) < 0.001, `jump starts ${(jump.start - charge.start).toFixed(4)} s after the charge, the cue is 2`);
    assert(passes.length === 2, `${passes.length} tunnel passes`);
    assert(Math.abs(passes[1].start - passes[0].end) < 0.001, 'the second tunnel pass does not start where the first ends');
    // The jump may carry a cue of its own in the real manifest; the tunnel starts there, else 20 ms before its end.
    const jumpCue = manifest.sounds.find((x) => x.id === 'fold_jump').cue;
    const jumpLen = jump.end - jump.start;
    const afterJump = jump.start + (jumpCue > 0 && jumpCue < jumpLen ? jumpCue : jumpLen - 0.02);
    assert(Math.abs(passes[0].start - afterJump) < 0.001, `the first tunnel pass starts ${(passes[0].start - afterJump).toFixed(4)} s off the jump's cue`);
    assert(Math.abs(exit.start - (passes[1].end - 0.02)) < 0.001, 'the exit does not start 20 ms before the end of the last pass');
    // The cruise leaves with the jump.
    await pageS.waitForFunction(() => document.querySelector('#scene-fold [data-event="cruise"]').getAttribute('aria-pressed') === 'false', null, { timeout: 5000 });
  });

  await check('Stop all ends a running fold chain, with the sounds that were still to come', async () => {
    await press(pageS, '#scene-fold [data-event="chain2"]');
    await sleep(500);
    await pageS.click('#stop-all');
    await sleep(900);
    await pageS.evaluate(() => window.__audition.resetPeak());
    await sleep(600);
    const left = await peakMax(pageS);
    assert(left < 0.002, `the chain still sounds after Stop all: peak ${left}`);
  });

  await check('fold scene: the written sequence runs to its end and takes the cruise away', async () => {
    await pageS.evaluate(() => window.scrollTo(0, 0));
    await pageS.evaluate(() => window.__audition.resetPeak());
    await pageS.click('#scene-fold [data-act="play-scene"]');
    await pageS.waitForFunction(() => window.__audition.sceneRuns.fold?.started >= 1, null, { timeout: 5000 });
    await sleep((45 / SPEED) * 1000 * 0.2);
    await pageS.screenshot({ path: path.join(SHOTS, 'scene-fold-running.png') });
    await pageS.waitForFunction(() => window.__audition.sceneRuns.fold?.ended >= 1, null, { timeout: 20000 });
    assert((await peakMax(pageS)) > 0.001, 'the scene made no sound');
    await pageS.click('#stop-all');
  });

  await check('hits in the combat scene come from changing sides', async () => {
    await pageS.click('[data-tab="combat"]');
    await pageS.evaluate(() => (window.__audition.plays = []));
    for (let i = 0; i < 3; i++) {
      await press(pageS, '#scene-combat [data-event="hull_light"]');
      await sleep(250);
    }
    await pageS.waitForFunction(() => window.__audition.plays.filter((p) => p.id === 'impact_hull_light').length >= 3, null, { timeout: 5000 });
    const az = await pageS.evaluate(() => window.__audition.plays.filter((p) => p.id === 'impact_hull_light').map((p) => p.azimuth));
    assert(az.every((x) => typeof x === 'number'), `a hit file with two channels cannot be placed: ${az.join(', ')}`);
    assert(Math.sign(az[0]) !== Math.sign(az[1]) && Math.sign(az[1]) !== Math.sign(az[2]), `the hits do not change sides: ${az.join(', ')}`);
  });

  await check('the stage can be switched while a loop runs, and the loop keeps sounding', async () => {
    await pageS.click('[data-tab="library"]');
    const btn = pageS.locator('button[data-sound="thruster_burn_loop"]');
    await press(pageS, 'button[data-sound="thruster_burn_loop"]');
    await sleep(500);
    for (const mode of ['headphones', 'mono', 'stereo']) {
      await pageS.click(`[data-stage="${mode}"]`);
      await pageS.evaluate(() => window.__audition.resetPeak());
      await sleep(400);
      assert((await peakMax(pageS)) > 0.001, `the loop fell silent after switching to ${mode}`);
    }
    assert((await btn.getAttribute('aria-label')).startsWith('Stop'), 'the loop button lost its state');
    await press(pageS, 'button[data-sound="thruster_burn_loop"]');
    await sleep(300);
  });

  await check('stage geometry: mirror panning behind, duller behind, circle of 1.5 m', async () => {
    const r = await pageS.evaluate(async () => {
      const m = await import('/src/dev/audition/engine.ts');
      return {
        right: m.stagePan(90),
        left: m.stagePan(-90),
        ahead: m.stagePan(0),
        behindRight: m.stagePan(150),
        mirror: m.stagePan(30),
        behindLeft: m.stagePan(-180 + 30),
        openAhead: m.behindCutoff(0),
        openSide: m.behindCutoff(90),
        dull: m.behindCutoff(135),
        dullest: m.behindCutoff(180),
        side: m.headphonePosition(90),
        front: m.headphonePosition(0),
        back: m.headphonePosition(180),
      };
    });
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    assert(near(r.right, 1) && near(r.left, -1) && near(r.ahead, 0), `pan ${JSON.stringify(r)}`);
    assert(near(r.behindRight, r.mirror) && near(r.behindLeft, -r.mirror), 'a source behind must pan like its mirror image ahead');
    assert(r.openAhead === 20000 && r.openSide === 20000 && r.dull < 20000 && Math.abs(r.dullest - 3500) < 1, `cutoffs ${r.openAhead}, ${r.dull}, ${r.dullest}`);
    assert(near(r.side.x, 1.5) && Math.abs(r.side.z) < 1e-9 && near(r.front.z, -1.5) && near(r.back.z, 1.5), 'the headphone circle is not 1.5 m around the listener');
  });

  await ctxS.close();

  // Start the hash tests without the ratings of the first part.
  if (existsSync(RATINGS)) rmSync(RATINGS);
  // The changed mark: a rating keeps the hash of the file it was given on; another hash later marks the row.
  const ctxH = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'de-DE' });
  let ratedId;
  await check('a new rating stores the hash of the file', async () => {
    const pg = await ctxH.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await stageRoute({})(pg);
    await pg.goto(URL_PAGE);
    await pg.waitForSelector('#s-test_right');
    ratedId = 'test_right';
    await pg.locator(`#s-${ratedId} .stars button`).nth(3).click();
    await pg.waitForFunction(() => /ratings\.json/.test(document.getElementById('save-status').textContent), null, { timeout: 5000 });
    const saved = JSON.parse(readFileSync(RATINGS, 'utf-8'));
    assert(saved.ratings[ratedId].hash === hashOf(ratedId), `stored hash ${saved.ratings[ratedId].hash}`);
    assert((await pg.locator('.changed-mark').count()) === 0, 'a fresh rating must not be marked');
    await pg.close();
  });

  await check('a rated sound whose hash changed is marked, dimmed, counted, filtered; rating again clears it and keeps the old one', async () => {
    const pg = await ctxH.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await stageRoute({ hashes: { [ratedId]: 'h2-changed00' }, round1: { test_free: 'old-hash-0001', test_dry: hashOf('test_dry') } })(pg);
    // Two more ratings given before hashes existed: one on a file that still matches round 1, one on a file that does not.
    await pg.addInitScript(
      ([id]) => {
        try {
          const raw = JSON.parse(localStorage.getItem('audition.ratings.v1'));
          raw.savedAt = '2999-01-01T00:00:00.000Z';
          raw.ratings.test_free = { stars: 5, verdict: 'fits', note: 'round one', at: '2026-11-14T10:00:00.000Z' };
          raw.ratings.test_dry = { stars: 3, verdict: 'close', note: '', at: '2026-11-14T10:00:00.000Z' };
          localStorage.setItem('audition.ratings.v1', JSON.stringify(raw));
        } catch (e) {
          // The first visit has nothing stored yet; the second page below carries the ratings.
        }
      },
      [ratedId],
    );
    await pg.goto(URL_PAGE);
    await pg.waitForSelector('#s-test_right');
    const row = pg.locator(`#s-${ratedId}`);
    assert((await row.locator('[data-role="changed"]').count()) === 1, 'the row has no changed mark');
    assert(/geändert/i.test(await row.locator('[data-role="changed"]').innerText()), 'the mark is not German');
    assert((await row.locator('.stars button.lit').count()) === 4, 'the old rating is not visible');
    assert((await row.locator('.rate').getAttribute('class')).includes('stale'), 'the old rating is not dimmed');
    const opacity = await row.locator('.rate .stars').evaluate((el) => getComputedStyle(el).opacity);
    assert(Number(opacity) < 0.9, `stars opacity ${opacity}`);
    // Round 1: test_free differs from its round 1 hash and is marked; test_dry matches it and is not.
    assert((await pg.locator('#s-test_free [data-role="changed"]').count()) === 1, 'a rating without hash on a changed file is not marked');
    assert((await pg.locator('#s-test_dry [data-role="changed"]').count()) === 0, 'a rating without hash on an unchanged file is marked');
    const detail = await pg.locator('#count-detail').innerText();
    assert(/2 geändert/.test(detail) && /unbewertet/.test(detail), `counter detail: ${detail}`);
    assert(/^3 \/ /.test(await pg.locator('#rated-count').innerText()), 'rated count');
    await row.scrollIntoViewIfNeeded();
    await scrollTo(pg, `#s-${ratedId}`, 300);
    await pg.screenshot({ path: path.join(SHOTS, 'library-changed-mark.png') });
    await pg.locator('#only-changed').check();
    assert((await pg.locator('.sound').count()) === 2, 'the filter should list the two changed sounds');
    await row.locator('.stars button').nth(4).click();
    assert((await pg.locator('.sound').count()) === 2, 'a row must not vanish from the filter under the cursor');
    assert((await row.locator('[data-role="changed"]').count()) === 0, 'rating again did not clear the mark');
    assert(/1 geändert/.test(await pg.locator('#count-detail').innerText()), 'counter did not drop');
    await pg.waitForFunction(() => /ratings\.json/.test(document.getElementById('save-status').textContent), null, { timeout: 5000 });
    await sleep(700);
    const saved = JSON.parse(readFileSync(RATINGS, 'utf-8')).ratings[ratedId];
    assert(saved.stars === 5 && saved.hash === 'h2-changed00', `new rating ${JSON.stringify(saved)}`);
    assert(saved.history?.length === 1 && saved.history[0].stars === 4 && saved.history[0].hash === hashOf(ratedId), `history ${JSON.stringify(saved.history)}`);
    await pg.close();
  });
  await ctxH.close();

  // A second load with a doctored manifest: one failed check, one sound taken away.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' });
  await check('failed checks are listed and a missing id is skipped and shown, not thrown', async () => {
    const page2 = await openPage(ctx2, {
      route: async (p) =>
        p.route('**/audio-lib/render/manifest.json', async (r) => {
          const res = await r.fetch();
          const m = await res.json();
          m.sounds = m.sounds.filter((s) => s.id !== 'sensor_proximity_tick');
          const first = m.sounds[0];
          m.sounds[1].checks = { ...m.sounds[1].checks, hints: ['clap-margin'], described: 'a test description' };
          first.checks = { ...first.checks, pass: false, failed: ['at least 85 % of the energy below 500 Hz', 'true peak above -1 dBFS'], peakDb: -0.4 };
          await r.fulfill({ response: res, json: m });
        }),
    });
    const sound = page2.locator('.sound').first();
    const hinted = page2.locator('.sound').nth(1);
    await hinted.locator('details.checks summary').click();
    const hintColor = await hinted.locator('summary .hint').evaluate((el) => getComputedStyle(el).color);
    assert(/255, 179, 71/.test(hintColor), `hint colour is ${hintColor}`);
    assert((await hinted.locator('summary').getAttribute('class')) === 'ok', 'a hint must not turn the rule line red');
    assert(/CLAP unsure/.test(await hinted.locator('summary').innerText()), 'hint text missing');
    assert(/a test description/.test(await hinted.locator('.described').innerText()), 'described line missing');
    await sound.locator('details.checks summary').click();
    await sound.scrollIntoViewIfNeeded();
    await page2.screenshot({ path: path.join(SHOTS, 'library-failed-checks.png') });
    await page2.click('[data-tab="docking"]');
    const missing = await page2.locator('#scene-docking [data-role="missing"]').innerText();
    assert(/sensor_proximity_tick/.test(missing), `missing list: ${missing}`);
    await page2.screenshot({ path: path.join(SHOTS, 'scene-docking-missing.png') });
    await page2.click('#scene-docking [data-act="play-scene"]');
    await page2.waitForFunction(() => window.__audition.sceneRuns.docking?.ended >= 1, null, { timeout: 20000 });
    await page2.close();
  });

  await check('the page says so when the manifest cannot be loaded', async () => {
    const page3 = await ctx2.newPage();
    await page3.route('**/audio-lib/render/manifest.json', (r) => r.fulfill({ status: 404, body: 'nope' }));
    await page3.goto(URL_PAGE);
    await page3.waitForSelector('#banner-missing', { timeout: 10000 });
    const text = await page3.locator('#banner-missing').innerText();
    assert(/tools\/audio\/build\.py/.test(text), 'the render command is not shown');
    await page3.screenshot({ path: path.join(SHOTS, 'manifest-missing.png') });
    await page3.close();
  });
  await ctx2.close();

  await check('no console errors', async () => {
    // The 404 of the deliberately missing manifest is the one expected network error.
    const real = errors.filter((e) => !/status of 404/.test(e));
    assert(real.length === 0, real.join(' | '));
  });
} finally {
  await browser.close();
  if (hadRatings) {
    copyFileSync(BACKUP, RATINGS);
    rmSync(BACKUP);
  } else if (existsSync(RATINGS)) {
    rmSync(RATINGS);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
