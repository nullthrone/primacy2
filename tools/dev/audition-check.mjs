// Checks the audition page in a real (headless) Chromium. Starts nothing itself: run
//   cd packages/client && npx vite --port 5183 --strictPort
// first. The page is taken from AUDITION_URL (default http://localhost:5183/dev/audition.html).
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
const RATINGS = path.join(ROOT, 'assets', 'audio', 'ratings.json');
const BACKUP = path.join(ROOT, 'assets', 'audio', 'ratings.json.audition-check-backup');
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
    await scrollTo(page, '#cat-engines .part.downloaded', 330);
    await page.screenshot({ path: path.join(SHOTS, 'library-category-engines.png') });
    await scrollTo(page, '#cat-radio .part.downloaded', 250);
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
    await scrollTo(page, '#group-engine', 190);
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

  await check('chained one-shots start 20 ms before the end of the previous one', async () => {
    await page.click('[data-tab="landing"]');
    await page.click('#scene-landing [data-event="cruise_start"]');
    await page.waitForFunction(() => (window.__audition.plays ?? []).some((p) => p.id === 'cruise_engage'), null, { timeout: 5000 });
    const plays = await page.evaluate(() => window.__audition.plays);
    const charge = plays.filter((p) => p.id === 'cruise_charge').pop();
    const engage = plays.filter((p) => p.id === 'cruise_engage').pop();
    const gap = engage.start - (charge.end - 0.02);
    assert(Math.abs(gap) < 0.001, `engage starts ${(gap * 1000).toFixed(2)} ms off the planned overlap`);
  });

  await check('the thrust slider sounds the engine alone while no scene runs', async () => {
    await page.click('[data-tab="combat"]');
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
    await page.locator('.counter input[type="checkbox"]').check();
    const rows = await page.locator('.sound').count();
    assert(rows === manifest.sounds.length - 1, `${rows} rows with the filter`);
    await page.locator('.counter input[type="checkbox"]').uncheck();
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
