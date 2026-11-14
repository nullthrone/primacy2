// Checks the direction indicators of the HUD and the size of the station screen in a browser, on
// the development page (no game server): the real interface over made-up frame views.
//
//   node tools/dev/orient-check.mjs [--size=1280x720] [--keep]
//
// It starts its own Vite server for packages/client on a free port, plays the page in headless
// Chromium and writes screenshots to screenshots/orient/. What it asserts:
//   - every place to dock that is off screen has an arrow, also with nothing chosen
//   - O and L step through the places, the list opens and closes again, the panel names the place
//   - a place behind the ship has the arrow with the second chevron, the word for "behind" and a
//     hollow dot on the compass
//   - U lets go of the ship first and of the place second
//   - with a controller as the device the hints name its buttons
//   - no block of the HUD lies over another one and no arrow lies over a block (German and
//     English, a small and a crowded system)
//   - the station screen has the same rectangle on every tab, with and without an error line
// The game core (keys, pad buttons, the real `cycleNav`) is not part of this page: scripts/e2e.mjs
// and scripts/pad-check.mjs play that.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const opt = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? 'true' : a.slice(i + 1)]; }));
const [W, H] = (opt.size ?? '1280x720').split('x').map(Number);
const OUT = 'screenshots/orient';
mkdirSync(OUT, { recursive: true });

const problems = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

const server = await createServer({ root: 'packages/client', configFile: 'packages/client/vite.config.ts', logLevel: 'error', server: { port: 5190 } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function open(query, size = [W, H]) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  page.on('pageerror', (e) => problems.push(`pageerror (${query}): ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console (${query}): ${m.text()}`); });
  await page.goto(`${base}/dev/local.html?hud=1&cam=cockpit&universe=16&${query}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', null, { timeout: 60_000 });
  await page.waitForTimeout(400);
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const texts = (page, sel) => page.$$eval(sel, (ns) => ns.map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
const count = (page, sel) => page.$$eval(sel, (ns) => ns.length);
const nav = (page) => page.evaluate(() => window.__store.navAnchor.value);

/** Rectangles of the HUD blocks and of the arrows, and which of them lie over each other. */
async function overlaps(page) {
  return page.evaluate(() => {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }; };
    const hit = (a, b) => a.x0 < b.x1 - 1 && a.x1 > b.x0 + 1 && a.y0 < b.y1 - 1 && a.y1 > b.y0 + 1;
    const named = (sel, name) => [...document.querySelectorAll(sel)].map((n, i) => ({ name: `${name}${i ? i + 1 : ''}`, ...rect(n) })).filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
    // The blocks as the pilot reads them. The top left block is taken row by row, since its rows differ much in width.
    const blocks = [
      ...named('.hud-left', 'bars'), ...named('.hud-power', 'power'), ...named('.hud-centre', 'centre'), ...named('.compass', 'compass'),
      ...named('.hud-right .panel-mini', 'panel'), ...named('.hud-topleft > *', 'topleft'), ...named('.keys', 'keys'), ...named('.chat-line', 'chat'),
    ];
    const arrows = [...named('.edge-glyph', 'arrow'), ...named('.edge-text', 'label')];
    const out = [];
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) if (hit(blocks[i], blocks[j])) out.push(`${blocks[i].name} over ${blocks[j].name}`);
    for (const a of arrows) for (const b of blocks) if (hit(a, b)) out.push(`${a.name} over ${b.name}`);
    const view = { w: innerWidth, h: innerHeight };
    for (const r of [...blocks, ...arrows]) if (r.x0 < 0 || r.y0 < 0 || r.x1 > view.w || r.y1 > view.h) out.push(`${r.name} leaves the view`);
    return out;
  });
}

try {
  // ---------------------------------------------------------------------------------------------
  // Stepping, the list, the panel, behind, clearing (German, the capital of universe 16).
  {
    const page = await open('scene=orient&lang=de&speed=120');
    check((await nav(page)) === null, 'nothing is chosen at the start');
    const small = await count(page, '.edge.place');
    check(small >= 3, `places to dock off screen have arrows with nothing chosen (${small})`);
    check((await count(page, '.edge.nav')) === 0 && (await count(page, '.place-list')) === 0, 'no chosen-place arrow and no list before the first step');
    const lines = (await texts(page, '.sys-lines')).join(' ');
    check(/ORTE/.test(lines) && /Andockplätze 5/.test(lines) && /Himmelskörper 7/.test(lines), `the system line counts the places: ${JSON.stringify(lines)}`);
    check(/KONTAKTE/.test(lines) && /Schiffe 3/.test(lines) && /Frachtbehälter 1/.test(lines), 'the contacts line counts ships and pods in range');
    const caps = await texts(page, '.sys-lines .keycap');
    check(['L', 'O', 'N', 'G', 'T', 'Tab'].every((k) => caps.includes(k)), `the lines name the keys: ${caps.join(' ')}`);
    await shot(page, '01-nothing-chosen-de');

    await page.keyboard.press('KeyO');
    await page.waitForSelector('.place-list');
    const first = (await texts(page, '.place-row.on'))[0] ?? '';
    const rows = await texts(page, '.place-row');
    check(first === rows[0] && /Station|Außenposten|Bodenbasis/.test(first), `the first step takes the nearest place to dock: ${JSON.stringify(first)}`);
    const big = (await texts(page, '.panel-mini.place .big'))[0] ?? '';
    check(first.startsWith(big) && big.length > 0, `the panel names the chosen place: ${JSON.stringify(big)}`);
    await page.keyboard.press('KeyO');
    await page.keyboard.press('KeyO');
    const third = (await texts(page, '.place-row.on'))[0];
    check(third === rows[2], `two more steps reach the third row: ${JSON.stringify(third)}`);
    await page.keyboard.press('KeyL');
    check((await texts(page, '.place-row.on'))[0] === rows[1], 'a step back reaches the second row');
    check(rows.length === 8 && (await texts(page, '.place-more')).some((x) => /5 weitere/.test(x)), `the list shows eight of thirteen rows and says how many more: ${rows.length}`);
    await page.keyboard.press('KeyL');
    await page.keyboard.press('KeyL');
    const last = (await texts(page, '.place-row.on'))[0] ?? '';
    check(/Stern|Planet|Mond/.test(last), `stepping back from the first row goes around to the last, a body: ${JSON.stringify(last)}`);
    await page.keyboard.press('KeyO');

    // A place behind the ship: the outpost of another planet.
    const behind = await page.evaluate(() => {
      const v = window.__view;
      const fwd = [0, 0, -1];
      const q = v.camera.rot;
      // The site whose direction is farthest from the nose.
      let best = null;
      for (const s of v.sites) {
        if (s.def.kind !== 'station' && s.def.kind !== 'outpost') continue;
        const [x, y, z] = s.rel;
        // unrotate by the camera: v' = q^-1 v q
        const [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]];
        const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
        const cz = z + qw * tz + (qx * ty - qy * tx);
        const cos = -cz / Math.hypot(x, y, z);
        if (!best || cos < best.cos) best = { id: s.def.id, name: s.def.name, cos, fwd };
      }
      window.__api.setNav(best.id);
      return best;
    });
    await page.waitForTimeout(200);
    const navArrow = await texts(page, '.edge.nav.big.behind .edge-text');
    check(navArrow.length === 1 && navArrow[0].includes(behind.name) && /hinten/.test(navArrow[0]), `a place behind the ship has the large arrow that says so: ${JSON.stringify(navArrow)} (cosine to the nose ${behind.cos.toFixed(2)})`);
    check((await count(page, '.edge.nav.behind .edge-glyph .tail')) === 1, 'its arrow carries the second chevron');
    check((await count(page, '.compass-dot.nav')) === 1 && (await count(page, '.compass-dot.nav.front')) === 0, 'its dot on the compass is hollow');
    check(/hinten/.test((await texts(page, '.panel-mini.place'))[0] ?? ''), 'the panel says the place lies behind');

    // A ship lock beside it, then clearing in two steps.
    await page.keyboard.press('KeyT');
    await page.waitForTimeout(150);
    check((await count(page, '.hud-right .panel-mini')) === 2, 'a locked ship and a chosen place stand side by side');
    check(/Annäherung|Entfernt sich/.test((await texts(page, '.hud-right .panel-mini'))[0] ?? ''), 'the ship panel says how fast the ship closes');
    await shot(page, '02-place-behind-and-ship-de');
    const o = await overlaps(page);
    check(o.length === 0, `nothing on the HUD lies over anything else with list, both panels and arrows${o.length ? `: ${o.join('; ')}` : ''}`);

    await page.keyboard.press('KeyU');
    await page.waitForTimeout(100);
    check((await page.evaluate(() => window.__store.targetId.value)) === null && (await nav(page)) === behind.id, 'U lets go of the ship first and keeps the place');
    await page.keyboard.press('KeyU');
    await page.waitForTimeout(100);
    check((await nav(page)) === null, 'a second U lets go of the place');

    await page.waitForTimeout(6300);
    check((await count(page, '.place-list')) === 0, 'the list closes six seconds after the last step');
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // A place ahead: filled dot, a time of arrival, a marker instead of an arrow.
  {
    const page = await open('scene=orient&lang=de&speed=120&yaw=4&pitch=2');
    await page.keyboard.press('KeyO');
    await page.waitForTimeout(200);
    check((await count(page, '.compass-dot.nav.front')) === 1, 'a place ahead has a filled dot on the compass');
    check((await count(page, '.edge.nav')) === 0 && (await count(page, '.marker.site.nav')) === 1, 'on screen it has its marker and no arrow');
    const panel = (await texts(page, '.panel-mini.place'))[0] ?? '';
    check(/Annäherung 1[12]\d m\/s/.test(panel) && /Ankunft \d/.test(panel), `flying at it at 120 m/s the panel gives closing speed and arrival: ${JSON.stringify(panel)}`);
    await shot(page, '03-place-ahead-de');
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // English, the crowded system (10 sites, 9 bodies), list open, everything chosen.
  for (const lang of ['en', 'de']) {
    const page = await open(`scene=orient&lang=${lang}&sys=1&speed=80&target=12&list=1`);
    await page.keyboard.press('KeyO');
    await page.keyboard.press('KeyO');
    await page.waitForTimeout(250);
    const rows = await texts(page, '.place-row');
    check(rows.length === 8, `the crowded system shows a window of eight rows (${lang})`);
    const o = await overlaps(page);
    check(o.length === 0, `crowded system, ${lang}: nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    if (lang === 'en') {
      const lines = (await texts(page, '.sys-lines')).join(' ');
      check(/PLACES/.test(lines) && /Docks 2/.test(lines) && /Other 8/.test(lines) && /Bodies 9/.test(lines) && /CONTACTS/.test(lines), `English lines: ${JSON.stringify(lines)}`);
    }
    await shot(page, `04-crowded-system-${lang}`);
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // Near the ground the centre block is at its widest: the compass and the arrows keep clear.
  {
    const page = await open('scene=surface&lang=de&alt=400&nav=1000&target=11');
    await page.waitForTimeout(300);
    check((await count(page, '.ground')) === 1 && (await count(page, '.compass')) === 1, 'over the ground the instruments and the compass are both shown');
    const o = await overlaps(page);
    check(o.length === 0, `over the ground: nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    await shot(page, '05-over-ground-de');
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // A controller as the device: the hints name its buttons.
  {
    const page = await open('scene=orient&lang=de&device=pad&nav=1003');
    const caps = await texts(page, '.sys-lines .keycap');
    check(caps.includes('D-pad left') && caps.includes('D-pad right') && caps.includes('D-pad up') && caps.includes('Y + Menu') && caps.includes('Y + LB'), `with a pad the lines name its buttons: ${caps.join(' | ')}`);
    const o = await overlaps(page);
    check(o.length === 0, `with pad hints nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    await shot(page, '06-pad-hints-de');
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // The station screen: one rectangle on every tab.
  for (const [lang, size, cmd] of [['de', [W, H], ''], ['en', [W, H], 'fail'], ['de', [1920, 1080], ''], ['de', [1024, 768], 'fail']]) {
    const page = await open(`scene=station&lang=${lang}&panel=station${cmd ? `&cmd=${cmd}` : ''}`, size);
    await page.waitForSelector('.panel.station');
    const rect = () => page.$eval('.panel.station', (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((x) => Math.round(x * 10) / 10).join(' '); });
    const tabs = await texts(page, '.panel.station nav.tabs button');
    check(tabs.length === 6, `the made-up station has all six tabs (${tabs.join(', ')})`);
    const seen = {};
    for (let i = 0; i < tabs.length; i++) {
      await page.locator('.panel.station nav.tabs button').nth(i).click();
      await page.waitForTimeout(120);
      seen[tabs[i]] = await rect();
      // A command on this tab: with `cmd=fail` it leaves the error line, on the market a sale leaves its note.
      const button = page.locator('.panel.station > :not(header):not(nav) button:not([disabled])').first();
      if (await button.count()) {
        await button.click();
        await page.waitForTimeout(120);
        seen[`${tabs[i]} after a command`] = await rect();
        if (cmd) check((await count(page, '.panel.station > .bad')) === 1, `${tabs[i]}: the refused command shows its error line (${lang})`);
      }
      if (i === 0 && !cmd) {
        await page.locator('.panel.station .scroll > table tbody tr.held button').nth(1).click();
        await page.waitForTimeout(120);
        check((await count(page, '.panel.station > .sale-note')) === 1, 'a sale cut short shows its note on the market tab');
        seen[`${tabs[i]} with a sale note`] = await rect();
      }
      const inside = await page.$eval('.panel.station', (n) => {
        const p = n.getBoundingClientRect();
        return [...n.children].every((c) => { const r = c.getBoundingClientRect(); return r.bottom <= p.bottom + 0.5 && r.right <= p.right + 0.5; });
      });
      check(inside, `${tabs[i]}: everything stays inside the window (${lang}, ${size.join('x')})`);
      if (size[0] === W && !cmd) await shot(page, `07-station-${i + 1}-${lang}`);
    }
    const sizes = new Set(Object.values(seen));
    check(sizes.size === 1, `the station window keeps one rectangle on every tab (${lang}, ${size.join('x')}${cmd ? ', commands refused' : ''}): ${[...sizes].join(' | ')}${sizes.size > 1 ? ` ${JSON.stringify(seen)}` : ''}`);
    const fits = await page.$eval('.panel.station', (n) => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    check(fits, `the station window lies inside the view (${size.join('x')})`);
    await page.close();
  }
} catch (err) {
  problems.push(`stopped: ${err.stack ?? err.message}`);
} finally {
  if (!opt.keep) {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\norient check ok');
process.exit(0);
