// Checks the direction indicators of the HUD and the size of the station screen in a browser, on
// the development page (no game server): the real interface over made-up frame views.
//
//   node tools/dev/orient-check.mjs [--size=1280x720] [--keep] [--only=radar]
//
// It starts its own Vite server for packages/client on a free port, plays the page in headless
// Chromium and writes screenshots to screenshots/orient/. What it asserts:
//   - every place to dock that is off screen has an arrow, also with nothing chosen
//   - O and L step through the places, the list opens and closes again, the panel names the place
//   - a place behind the ship has the arrow with the second chevron, the word for "behind" and a
//     hollow dot on the compass
//   - U lets go of the ship first and of the place second
//   - with a controller as the device the hints name its buttons
//   - the radar: every ship, wreck and pod in range is a point where the ship's own axes put it
//     (left of the middle for one to the left, up the disc for one ahead, the stalk upward for one
//     above the plane), in the colour of its kind, the locked one ringed; every place to dock and
//     every gate has a mark on the rim at its bearing, the chosen place in amber; with the camera
//     turned away from the nose it still shows the ship's axes
//   - no block of the HUD lies over another one and no arrow lies over a block (German and
//     English, a small and a crowded system)
//   - the station screen has the same rectangle on every tab, with and without an error line
// `--only=radar` plays the radar part alone. The game core (keys, pad buttons, the real `cycleNav`)
// is not part of this page: scripts/e2e.mjs and scripts/pad-check.mjs play that.
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
/** Something measured that is reported and not required. */
const note = (what) => console.log(`note ${what}`);

const server = await createServer({ root: 'packages/client', configFile: 'packages/client/vite.config.ts', logLevel: 'error', server: { port: 5190 } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

/** Whether a part of the check runs: all of them, or the ones `--only` names. */
const want = (part) => !opt.only || opt.only.split(',').includes(part);

async function open(query, size = [W, H], scale = 1) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: scale });
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
      ...named('.hud-left', 'bars'), ...named('.hud-power', 'power'), ...named('.hud-centre', 'centre'), ...named('.compass', 'compass'), ...named('.radar', 'radar'),
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

/**
 * The radar as it is drawn: the middle and the half axes of its disc in pixels, and for every
 * contact and every mark on the rim its classes and the middle of its head and of its foot.
 */
const radar = (page) => page.evaluate(() => {
  const mid = (n) => { const r = n.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; };
  const disc = document.querySelector('.radar-disc').getBoundingClientRect();
  const part = (g) => ({ key: g.dataset.key, cls: g.getAttribute('class').split(/\s+/).filter(Boolean), head: mid(g.querySelector('.radar-head')), foot: mid(g.querySelector('.radar-foot')), ring: g.querySelector('.radar-lock') !== null });
  const plate = document.querySelector('.radar-plate').getBoundingClientRect();
  const inside = (n) => { const r = n.getBoundingClientRect(); return r.left >= plate.left - 0.5 && r.right <= plate.right + 0.5 && r.top >= plate.top - 0.5 && r.bottom <= plate.bottom + 0.5; };
  return {
    cx: (disc.left + disc.right) / 2, cy: (disc.top + disc.bottom) / 2, rx: disc.width / 2, ry: disc.height / 2,
    width: plate.width,
    blips: [...document.querySelectorAll('.radar-blip')].map(part),
    marks: [...document.querySelectorAll('.radar-mark')].map(part),
    outside: [...document.querySelectorAll('.radar-plate *')].filter((n) => !inside(n)).length,
    scale: document.querySelector('.radar-scale')?.innerText ?? '',
  };
});

/**
 * Where everything lies in the ship's own axes (x right, y up, nose along -z) and in the camera's,
 * worked out here from the frame view, apart from the interface: per entity and per site.
 */
const axes = (page) => page.evaluate(() => {
  const v = window.__view;
  // v' = q^-1 v q
  const un = (q, [x, y, z]) => {
    const [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
  };
  const from = (p) => [p[0] - v.self.rel[0], p[1] - v.self.rel[1], p[2] - v.self.rel[2]];
  const both = (p) => ({ ship: un(v.self.rot, from(p)), cam: un(v.camera.rot, from(p)) });
  return {
    ents: Object.fromEntries(v.ents.map((e) => [`e${e.id}`, { ...both(e.rel), name: e.info.name }])),
    sites: Object.fromEntries(v.sites.map((s) => [s.def.id, { ...both(s.rel), kind: s.def.kind, name: s.def.name }])),
    bodies: Object.fromEntries(v.bodies.map((b) => [b.def.id, { ...both(b.rel), name: b.def.name }])),
    turned: Math.abs(v.self.rot[0] * v.camera.rot[0] + v.self.rot[1] * v.camera.rot[1] + v.self.rot[2] * v.camera.rot[2] + v.self.rot[3] * v.camera.rot[3]),
  };
});

/**
 * Where the radar has to draw a contact at `c` (ship axes, metres): head and foot in pixels. The
 * scale is the one `ui/orient.ts` defines; how flat the disc is drawn is measured, and a length
 * straight up keeps what that view leaves of it.
 */
function blipAt(r, c) {
  const dist = Math.hypot(c[0], c[1], c[2]);
  const f = dist <= 100 ? 0.16 : dist >= 1e5 ? 1 : 0.16 + (0.84 * Math.log10(dist / 100)) / 3;
  const k = f / dist;
  const foot = { x: r.cx + c[0] * k * r.rx, y: r.cy + c[2] * k * r.ry };
  return { foot, head: { x: foot.x, y: foot.y - c[1] * k * r.rx * Math.sqrt(1 - (r.ry / r.rx) ** 2) } };
}
/** The longest stalk of a mark on the rim in units of the disc's radius, as in `ui/orient.ts`. */
const RIM_STALK = 0.4;
/** Where the radar has to draw the mark of a place in the direction `c`: its foot on the rim at the bearing, the head on the stalk. */
function rimAt(r, c) {
  const bearing = Math.atan2(c[0], -c[2]);
  const foot = { x: r.cx + Math.sin(bearing) * r.rx, y: r.cy - Math.cos(bearing) * r.ry };
  return { foot, head: { x: foot.x, y: foot.y - (c[1] / Math.hypot(c[0], c[1], c[2])) * RIM_STALK * r.rx } };
}
const near = (a, b, tol = 1.5) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
const xy = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

try {
  // ---------------------------------------------------------------------------------------------
  // Stepping, the list, the panel, behind, clearing (German, the capital of universe 16).
  if (want('step')) {
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
  if (want('ahead')) {
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
  for (const lang of want('crowded') ? ['en', 'de'] : []) {
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
  // Near the ground the centre block is at its widest: the compass, the radar and the arrows keep
  // clear, in both languages and with the longer hints of a controller.
  for (const [name, query] of want('ground') ? [['de', 'lang=de'], ['en', 'lang=en'], ['pad-de', 'lang=de&device=pad']] : []) {
    const page = await open(`scene=surface&alt=400&info=0&nav=1000&target=11&${query}`);
    await page.waitForTimeout(300);
    check((await count(page, '.ground')) === 1 && (await count(page, '.compass')) === 1 && (await count(page, '.radar')) === 1, `over the ground the instruments, the compass and the radar are all shown (${name})`);
    const o = await overlaps(page);
    check(o.length === 0, `over the ground, ${name}: nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    await shot(page, `05-over-ground-${name}`);
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // The radar: contacts where the ship's own axes put them, places on the rim (German).
  if (want('radar')) {
    const page = await open('scene=orient&lang=de');
    const colour = (sel, prop = 'fill') => page.$eval(sel, (n, p) => getComputedStyle(n)[p], prop);
    let r = await radar(page);
    let a = await axes(page);
    const blip = (key) => r.blips.find((b) => b.key === key);
    check(r.ry / r.rx > 0.4 && r.ry / r.rx < 0.7 && r.width >= 120, `the radar is drawn: a disc of ${Math.round(r.rx * 2)} x ${Math.round(r.ry * 2)} px on a plate of ${Math.round(r.width)} px`);
    check(/Ringe 0,1 · 1 · 10 · 100 km/.test(r.scale), `its scale is written under it: ${JSON.stringify(r.scale)}`);
    check(r.blips.length === 4 && ['e10', 'e11', 'e12', 'e60'].every(blip), `every ship and pod in range is a point on the radar (${r.blips.map((b) => b.key).join(' ')})`);
    // Lancet 10 lies ahead, to the left and above the ship's plane.
    const s10 = a.ents.e10.ship;
    const b10 = blip('e10');
    check(s10[0] < 0 && s10[1] > 0 && s10[2] < 0 && b10.head.x < r.cx - 1 && b10.foot.y < r.cy - 1 && b10.head.y < b10.foot.y - 0.5,
      `a ship ahead, to the left and above the plane stands left of the middle, up the disc, its stalk upward (head ${xy(b10.head)}, foot ${xy(b10.foot)}, middle ${xy({ x: r.cx, y: r.cy })})`);
    // Drover 11 lies behind, to the right and below it.
    const s11 = a.ents.e11.ship;
    const b11 = blip('e11');
    check(s11[0] > 0 && s11[1] < 0 && s11[2] > 0 && b11.head.x > r.cx + 1 && b11.foot.y > r.cy + 1 && b11.head.y > b11.foot.y + 0.5 && b11.cls.includes('below'),
      `a ship behind, to the right and below the plane stands right of the middle, down the disc, and hangs under its foot (head ${xy(b11.head)}, foot ${xy(b11.foot)})`);
    const off = r.blips.filter((b) => { const w = blipAt(r, a.ents[b.key].ship); return !near(b.head, w.head) || !near(b.foot, w.foot); });
    check(off.length === 0, `every contact stands where the ship's axes and the logarithmic scale put it, to 1.5 px${off.length ? `: off ${off.map((b) => b.key).join(' ')}` : ''}`);
    check(blip('e12').cls.includes('hostile') && blip('e60').cls.includes('loot') && blip('e10').cls.includes('npc'), 'the pirate is classed hostile, the pod as a pod, a trader as neither');
    check((await colour('.radar-blip.hostile .radar-head')) === 'rgb(255, 77, 109)' && (await colour('.radar-blip.loot .radar-head')) === 'rgb(255, 179, 71)', 'the hostile ship is red and the pod amber');
    check(r.blips.every((b) => !b.ring), 'no contact is ringed while no ship is locked');
    check(r.outside === 0, 'nothing of the radar leaves its plate');

    // Places: one mark per place to dock, at its bearing in the ship's plane.
    const docks = Object.values(a.sites).filter((s) => ['station', 'outpost', 'base', 'gate'].includes(s.kind)).length;
    check(r.marks.length === docks && docks === 5 && r.marks.every((m) => !m.cls.includes('chosen')), `every place to dock has a mark on the rim and none is amber with nothing chosen (${r.marks.length})`);
    const offRim = (rr, aa) => rr.marks.filter((m) => { const w = rimAt(rr, (aa.sites[m.key.slice(1)] ?? aa.bodies[m.key.slice(1)]).ship); return !near(m.foot, w.foot) || !near(m.head, w.head); });
    const offMarks = offRim(r, a);
    check(offMarks.length === 0, `every mark has its foot on the rim at the bearing of its place and its stalk toward the side of the plane the place lies on${offMarks.length ? `: off ${offMarks.map((m) => m.key).join(' ')}` : ''}`);
    await shot(page, '09-radar-nothing-chosen-de');

    // A chosen place and a locked ship.
    await page.keyboard.press('KeyO');
    await page.keyboard.press('KeyT');
    await page.waitForTimeout(200);
    r = await radar(page);
    a = await axes(page);
    const chosenId = await nav(page);
    const chosen = r.marks.filter((m) => m.cls.includes('chosen'));
    const c = a.sites[chosenId].ship;
    check(chosen.length === 1 && chosen[0].key === `p${chosenId}` && r.marks.length === docks, 'the chosen place is the one amber mark, in place of its plain one');
    check(c[2] > 0 && chosen[0].foot.y > r.cy && near(chosen[0].foot, rimAt(r, c).foot), `the chosen place lies behind the ship and stands on the near half of the rim, at its bearing (${xy(chosen[0].foot)})`);
    check((await colour('.radar-mark.chosen .radar-head')) === 'rgb(255, 179, 71)', 'its mark is amber');
    const targetId = await page.evaluate(() => window.__store.targetId.value);
    const locked = r.blips.filter((b) => b.ring);
    check(locked.length === 1 && locked[0].key === `e${targetId}` && locked[0].cls.includes('locked'), `the locked ship is the one ringed contact (${locked.map((b) => b.key).join(' ')})`);
    check(r.marks.at(-1).key === chosen[0].key && r.blips.at(-1).key === locked[0]?.key, 'the chosen place and the locked ship are drawn last, over the others');
    check(r.outside === 0, 'with both chosen nothing leaves the plate');
    const o = await overlaps(page);
    check(o.length === 0, `radar, list and both panels: nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    await shot(page, '09-radar-chosen-de');

    // A celestial body as the chosen place has a mark as well.
    const bodyId = await page.evaluate(() => { const b = window.__view.bodies[0]; window.__api.setNav(b.def.id); return b.def.id; });
    await page.waitForTimeout(150);
    r = await radar(page);
    a = await axes(page);
    const bodyMark = r.marks.find((m) => m.key === `p${bodyId}`);
    check(r.marks.length === docks + 1 && bodyMark?.cls.includes('chosen') && offRim(r, a).length === 0, `a celestial body chosen as the place (${a.bodies[bodyId].name}) has the amber mark, beside the marks of the places to dock`);
    await page.close();
  }

  // The radar with more on it (English): another pilot, a wreck, a ship far below, one beyond the
  // scale, a gate.
  if (want('radar')) {
    const page = await open('scene=orient&lang=en&more=1&nav=1003&target=13');
    const colour = (sel, prop = 'fill') => page.$eval(sel, (n, p) => getComputedStyle(n)[p], prop);
    const r = await radar(page);
    const a = await axes(page);
    const blip = (key) => r.blips.find((b) => b.key === key);
    check(/Rings 0\.1 · 1 · 10 · 100 km/.test(r.scale), `the scale in English: ${JSON.stringify(r.scale)}`);
    check(r.blips.length === 8, `eight contacts are on the radar (${r.blips.map((b) => b.key).join(' ')})`);
    check(blip('e13').cls.includes('pilot') && blip('e13').ring && (await colour('.radar-blip.pilot .radar-head')) === 'rgb(125, 255, 168)', 'another pilot is green, and ringed while locked');
    check(blip('e80').cls.includes('wreck') && (await colour('.radar-blip.wreck .radar-head', 'stroke')) === 'rgb(255, 179, 71)' && (await colour('.radar-blip.wreck .radar-head')) !== 'rgb(255, 179, 71)', 'a wreck is a hollow amber square');
    const far = r.blips.filter((b) => b.cls.includes('beyond')).map((b) => b.key);
    const f15 = blip('e15');
    const d15 = a.ents.e15.ship;
    check(far.join() === 'e15' && Math.abs(Math.hypot((f15.foot.x - r.cx) / r.rx, (f15.foot.y - r.cy) / r.ry) - Math.hypot(d15[0], d15[2]) / Math.hypot(...d15)) < 0.03,
      `a ship ${Math.round(Math.hypot(...d15) / 1000)} km off, beyond the scale, stands at the rim's distance in its direction and is drawn hollow`);
    const b14 = blip('e14');
    check(a.ents.e14.ship[1] < -2e4 && b14.head.y > b14.foot.y + 10, `a ship 21 km below the plane hangs on a long stalk (${(b14.head.y - b14.foot.y).toFixed(1)} px)`);
    const off = r.blips.filter((b) => { const w = blipAt(r, a.ents[b.key].ship); return !near(b.head, w.head) || !near(b.foot, w.foot); });
    check(off.length === 0, `all eight stand where the ship's axes and the scale put them${off.length ? `: off ${off.map((b) => b.key).join(' ')}` : ''}`);
    const gates = Object.entries(a.sites).filter(([, s]) => s.kind === 'gate');
    const gateMark = r.marks.find((m) => m.key === `s${gates[0]?.[0]}`);
    check(gates.length === 1 && r.marks.length === 6 && gateMark?.cls.includes('gate') && near(gateMark.foot, rimAt(r, gates[0][1].ship).foot), 'a gate has a mark of its own shape on the rim, at its bearing');
    check(r.outside === 0, 'nothing leaves the plate');
    const o = await overlaps(page);
    check(o.length === 0, `radar with more on it, en: nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    await shot(page, '09-radar-more-en');
    await page.close();
  }

  // The radar shows the ship's axes, not the camera's: over the ground with the pilot's head turned.
  if (want('radar')) {
    const page = await open('scene=surface&lang=de&alt=400&info=0&nav=1000&target=11&look=55,12');
    await page.waitForTimeout(300);
    const r = await radar(page);
    const a = await axes(page);
    check(a.turned < 0.95, `the camera is turned away from the nose (the two orientations agree to ${a.turned.toFixed(3)})`);
    const b = r.blips.find((x) => x.key === 'e11');
    const ship = blipAt(r, a.ents.e11.ship);
    const cam = blipAt(r, a.ents.e11.cam);
    check(near(b.foot, ship.foot) && near(b.head, ship.head) && !near(b.foot, cam.foot, 5), `with the camera turned the locked ship stays where the ship's axes put it (drawn ${xy(b.foot)}, ship axes ${xy(ship.foot)}, camera axes ${xy(cam.foot)})`);
    const m = r.marks.find((x) => x.cls.includes('chosen'));
    const place = a.sites[1000];
    check(near(m.foot, rimAt(r, place.ship).foot) && !near(m.foot, rimAt(r, place.cam).foot, 5), `and so does the chosen place on the rim (drawn ${xy(m.foot)}, camera axes ${xy(rimAt(r, place.cam).foot)})`);
    await shot(page, '09-radar-camera-turned-de');
    await page.close();
  }

  // Close-ups at three times the resolution, to judge the drawing: the bottom row of the HUD.
  for (const [name, query] of want('radar') ? [
    ['10-radar-close-de', 'scene=orient&lang=de&more=1&nav=1003&target=12'],
    ['10-radar-close-ground-de', 'scene=surface&lang=de&alt=400&info=0&nav=1000&target=11'],
  ] : []) {
    const page = await open(query, [W, H], 3);
    await page.waitForTimeout(300);
    const clip = await page.$eval('.radar', (n) => { const r = n.getBoundingClientRect(); const x = Math.max(0, r.left - 330); const y = Math.max(0, r.top - 24); return { x, y, width: Math.min(innerWidth, r.right + 24) - x, height: innerHeight - y }; });
    await page.screenshot({ path: `${OUT}/${name}.png`, clip });
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // A controller as the device: the hints name its buttons.
  if (want('pad')) {
    const page = await open('scene=orient&lang=de&device=pad&nav=1003');
    const caps = await texts(page, '.sys-lines .keycap');
    check(['D←', 'D→', 'D↑', 'Y+Menu', 'Y+LB'].every((k) => caps.includes(k)), `with a pad the lines name its buttons, in the short form: ${caps.join(' | ')}`);
    const power = await texts(page, '.hud-power .pip-key');
    check(power.join(' ') === 'Y+D← Y+D↑ Y+D→', `the power rows name the pad chords in the short form: ${power.join(' ')}`);
    const corner = await texts(page, '.keys .key-item');
    check(corner.length === 8 && corner.includes('View Reiseflug') && corner.includes('Y+A andocken'), `the corner names eight controls, a key cap and a word each: ${corner.join(' | ')}`);
    check((await overlaps(page)).length === 0, 'with a pad nothing lies over anything else at this size');
    const o = await overlaps(page);
    check(o.length === 0, `with pad hints nothing lies over anything else${o.length ? `: ${o.join('; ')}` : ''}`);
    await shot(page, '06-pad-hints-de');
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // A phone held sideways, played with a controller. The HUD has no layout of its own for that
  // size yet, so what lies over what is reported and not required; panels must fit and scroll.
  for (const scene of want('phone') ? ['scene=orient&nav=1003&target=11&list=1', 'scene=surface&alt=400&info=0&nav=1000'] : []) {
    const page = await open(`${scene}&lang=de&device=pad`, [844, 390]);
    await page.waitForTimeout(300);
    const o = await overlaps(page);
    note(`844 x 390 with a pad (${scene.split('&')[0]}): ${o.length ? o.join('; ') : 'nothing lies over anything else'}`);
    await shot(page, `08-phone-${scene.split('&')[0].split('=')[1]}-de`);
    if (scene.startsWith('scene=orient')) {
      await page.evaluate(() => { window.__store.panel.value = 'menu'; });
      await page.waitForSelector('.backdrop .panel');
      const fits = await page.$eval('.backdrop .panel', (n) => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && n.scrollHeight >= n.clientHeight; });
      check(fits, 'the pause menu lies inside an 844 x 390 view and scrolls inside itself');
      await shot(page, '08-phone-pause-de');
    }
    await page.close();
  }

  // ---------------------------------------------------------------------------------------------
  // The station screen: one rectangle on every tab.
  for (const [lang, size, cmd] of want('station') ? [['de', [W, H], ''], ['en', [W, H], 'fail'], ['de', [1920, 1080], ''], ['de', [1024, 768], 'fail'], ['en', [844, 390], '']] : []) {
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
