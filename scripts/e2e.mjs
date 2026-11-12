// End-to-end smoke test of the real game in a real browser.
//
//   npm run build && node scripts/e2e.mjs
//
// Starts two linked servers (scripts/dev.ts), opens the game in GPU-accelerated headless Chromium,
// logs in, undocks, is shot down by a second pilot, comes back through insurance, engages cruise
// and opens the maps.
// Screenshots go to screenshots/e2e/.
// Exits with code 1 when a step fails or the page logged an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'screenshots/e2e';
// PRIMACY2_JOURNEY_ONLY=1 skips the fight and flight checks and plays only the cross-server journey.
const JOURNEY_ONLY = process.env.PRIMACY2_JOURNEY_ONLY === '1';
const URL = process.env.PRIMACY2_URL ?? 'http://localhost:8420';
mkdirSync(OUT, { recursive: true });

function startServers() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx tsx scripts/dev.ts', { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('servers did not start:\n' + out)), 60_000);
    const onData = (d) => {
      out += d;
      if (out.includes('Both sectors are peered')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`servers exited with code ${code}:\n${out}`)));
  });
}

function stopServers(child) {
  if (!child) return;
  // Synchronous, so the whole process tree is gone before this script exits and the next run finds the ports free.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Enters a pilot name on the start screen and waits until the pilot is docked. */
async function login(page, name) {
  await page.fill('.start-card input', name);
  await page.click('.start-card button.primary');
  await page.waitForFunction(() => window.primacy2?.game?.view?.mode === 3, null, { timeout: 20_000 });
}

/** Leaves the station. Pointer lock does not exist in headless mode; the input module has a switch for that. */
async function undock(page) {
  await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
  await page.click('.panel header button.primary');
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 });
}

/** Waits for another player's ship among the contacts and locks it as target. */
async function targetPlayer(page) {
  try {
    await page.waitForFunction(() => window.primacy2.game.view?.ents.some((e) => e.info.player), null, { timeout: 20_000 });
  } catch {
    return false;
  }
  await page.evaluate(() => {
    const g = window.primacy2.game;
    g.setTarget(g.view.ents.find((e) => e.info.player).id);
  });
  // The lock shows up in the frame view one frame later.
  await page.waitForFunction(() => window.primacy2.game.view?.targetId != null, null, { timeout: 5000 });
  return true;
}

/**
 * One steering step toward a point. `mode` chooses it: 'target' is the locked target, 'away' the
 * point opposite the station of the current zone, and 'chase' the locked target with a push away
 * from the station while the ship is within three kilometres of it, so that a pursuit curves
 * around the station instead of ending in its hull. Returns how far the point is from the middle
 * of the view in pixels (Infinity while it is behind the camera), or null when there is nothing
 * to steer at.
 */
function steerStep(page, mode) {
  return page.evaluate((how) => {
    const g = window.primacy2.game;
    const v = g.view;
    const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    let rel = null;
    if (how === 'away') {
      rel = v?.zone ? [-v.zone[0], -v.zone[1], -v.zone[2]] : null;
    } else {
      rel = v?.ents.find((e) => e.id === v.targetId)?.rel ?? null;
      if (rel && how === 'chase' && v.self) {
        const pos = v.self.state.pos;
        const push = Math.min(2, Math.max(0, (3000 - Math.hypot(pos[0], pos[1], pos[2])) / 1000));
        const to = unit(rel), out = unit(pos);
        rel = [to[0] + out[0] * push, to[1] + out[1] * push, to[2] + out[2] * push].map((x) => x * 1000);
      }
    }
    if (!rel) return null;
    const p = g.project(rel);
    if (p.behind) { g.input.addMouse(60, 0); return Infinity; }
    const ex = p.x - window.innerWidth / 2, ey = p.y - window.innerHeight / 2;
    // A gentle gain: the ship works its aim off at its own turn rate, and whatever is still queued
    // when the point reaches the middle would carry the nose past it.
    g.input.addMouse(ex * 0.2, ey * 0.2);
    return Math.hypot(ex, ey);
  }, mode);
}

/** Steers until the point has stayed within `tolerance` pixels of the middle for half a second. */
async function settle(page, mode, tolerance, timeoutMs) {
  const t0 = Date.now();
  let held = 0;
  while (Date.now() - t0 < timeoutMs) {
    const off = await steerStep(page, mode);
    held = off !== null && off < tolerance ? held + 1 : 0;
    if (held >= 5) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** Turns the nose until the station of the current zone is straight behind the ship. */
const aimAwayFromStation = (page, timeoutMs = 30_000) => settle(page, 'away', 70, timeoutMs);

/** Steers with the mouse hook until the locked target sits in the middle of the view. */
const aimAtTarget = (page, timeoutMs = 30_000) => settle(page, 'target', 28, timeoutMs);

/**
 * Keeps the nose on the locked target until `done` says so (returns true), the target is gone
 * (returns 'lost') or the time is up (returns false). `done` receives the distance to the target
 * and the pilot's own distance from the zone anchor, both in metres.
 */
async function steerUntil(page, mode, done, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await steerStep(page, mode)) === null) return 'lost';
    const v = await page.evaluate(() => {
      const view = window.primacy2.game.view;
      const ent = view?.ents.find((e) => e.id === view.targetId);
      return ent && view.self ? { dist: Math.hypot(...ent.rel), own: Math.hypot(...view.self.state.pos) } : null;
    });
    if (!v) return 'lost';
    if (done(v)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The journey: cargo from Alpha is flown to a station in Beta's sector by fold jump and sold there
// as an import. A new pilot in a fresh browser context, so the earlier fight does not interfere.
// ---------------------------------------------------------------------------------------------

/** A cheap staple (32 per tonne) that every station market trades. */
const CARGO = { id: 'water', name: 'Water', tonnes: 4 };
const MODE = { normal: 0, cruise: 1, docked: 3, destroyed: 4 };

/** The pilot's ship was destroyed on the way (pirates are about in Beta's frontier systems): the journey can be tried again. */
class ShipLost extends Error {}

/** Reads the number out of a piece of interface text such as "12,345 cr". */
const digits = (text) => Number(String(text).replace(/[^\d]/g, ''));

/** One step of mouse steering at a site of the current system (same gain as `steerStep`). Returns the state of the approach. */
function steerAtSite(page, siteId) {
  return page.evaluate((id) => {
    const g = window.primacy2.game;
    const v = g.view;
    const site = v?.sites.find((s) => s.def.id === id);
    if (!v || !v.self || !site) return null;
    // A planet or star between the ship and the station would force the drive out of cruise. When the
    // straight line passes too close to one, aim at a point beside it instead.
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const t = site.rel;
    const t2 = dot(t, t);
    let aim = t;
    let detour = null;
    let worst = Infinity;
    for (const b of v.bodies) {
      const u = dot(b.rel, t) / t2;
      if (u <= 0 || u >= 1) continue;
      const side = [b.rel[0] - t[0] * u, b.rel[1] - t[1] * u, b.rel[2] - t[2] * u];
      const miss = Math.hypot(...side);
      if (miss >= b.def.radius * 2.2 || miss >= worst) continue;
      worst = miss;
      // Away from the line, on the side the body already lies; any sideways direction when it sits right on it.
      const away = miss > 1 ? side.map((x) => -x / miss) : [t[1], -t[0], 0].map((x) => x / (Math.hypot(t[0], t[1]) || 1));
      aim = [b.rel[0] + away[0] * b.def.radius * 2.6, b.rel[1] + away[1] * b.def.radius * 2.6, b.rel[2] + away[2] * b.def.radius * 2.6];
      detour = b.def.name;
    }
    const p = g.project(aim);
    let off;
    if (p.behind) { g.input.addMouse(60, 0); off = Infinity; } else {
      const ex = p.x - window.innerWidth / 2, ey = p.y - window.innerHeight / 2;
      g.input.addMouse(ex * 0.2, ey * 0.2);
      off = Math.hypot(ex, ey);
    }
    const st = v.self.state;
    return { off, dist: site.dist, mode: v.mode, speed: st.mode === 1 ? st.cruiseSpeed : Math.hypot(...st.vel), radius: site.def.radius ?? 300, detour };
  }, siteId);
}

/** Holds W or S (or neither) so that the throttle changes the way the controller wants. */
async function throttleKeys(page, held, want) {
  for (const key of ['KeyW', 'KeyS']) {
    const down = key === want;
    if (held[key] && !down) await page.keyboard.up(key);
    if (!held[key] && down) await page.keyboard.down(key);
    held[key] = down;
  }
}

async function journey(browser, problems, steps) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror (journey): ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console (journey): ${m.text()}`); });
  const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); steps.push(name); };
  const log = (msg) => console.log(`journey: ${msg}`);
  const stateDump = () => page.evaluate(() => {
    const v = window.primacy2.game.view;
    const st = v?.self?.state;
    return v ? {
      mode: v.mode, system: v.system.id, galaxy: v.galaxy?.self, fold: v.fx.fold, charge: v.fx.charge,
      pos: st ? Math.round(Math.hypot(...st.pos)) : null, speed: st ? Math.round(st.mode === 1 ? st.cruiseSpeed : Math.hypot(...st.vel)) : null, fuel: st?.fuel,
    } : null;
  });
  const fail = async (what) => {
    await page.screenshot({ path: `${OUT}/journey-failure.png` }).catch(() => {});
    const events = await page.evaluate(() => window.__events ?? []).catch(() => []);
    throw new Error(`${what} (${JSON.stringify(await stateDump())}; last events ${JSON.stringify(events.slice(-12))})`);
  };

  // Market of the open station panel: one entry per row, cells as text.
  const marketRows = () => page.$$eval('.panel.wide .scroll > table tbody tr:not(.lots)', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.innerText.trim())));
  const rowOf = (rows, name) => rows.find((r) => r[0] === name);
  const check = (ok, fact, problem) => { if (ok) log(`ok: ${fact}`); else problems.push(`journey: ${problem ?? `NOT ${fact}`}`); };
  const creditsNow = async () => digits(await page.innerText('.panel.wide header .credits'));
  const tap = () => page.evaluate(() => ({ serverId: window.__tap.serverId, welcomes: window.__tap.welcomes, pilot: window.__tap.pilot }));

  // From the undocked ship out of the station's mass lock, nose away from the station.
  const flyOut = async () => {
    await page.waitForTimeout(800);
    if (!(await aimAwayFromStation(page))) throw new Error('journey: could not turn away from the station');
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    try {
      await page.waitForFunction(() => {
        const self = window.primacy2.game.view?.self;
        if (!self) throw new Error('the pilot lost the ship on the way out');
        return Math.hypot(...self.state.pos) > 4700;
      }, null, { timeout: 90_000 });
    } catch (err) {
      if (/lost the ship/.test(String(err?.message))) throw new ShipLost('the ship was shot down on the way out of the station');
      throw err;
    } finally {
      await page.keyboard.up('ShiftLeft');
      await page.keyboard.up('KeyW');
    }
  };

  // Fold jumps along `hops`; waits for the arrival (on the last hop including a handoff to another server).
  const foldTo = async (hops, tunnelShot) => {
    const final = hops[hops.length - 1];
    for (const hop of hops) {
      const last = hop === final;
      // A frame watcher keeps the largest tunnel value seen: the tunnel can be over between two polls of the page.
      await page.evaluate((id) => {
        const g = window.primacy2.game;
        window.__foldMax = 0;
        const watch = () => { window.__foldMax = Math.max(window.__foldMax, g.view?.fx.fold ?? 0); if (!window.__foldStop) requestAnimationFrame(watch); };
        window.__foldStop = false;
        requestAnimationFrame(watch);
        g.setFoldTarget(id);
        g.startFold();
      }, hop.id);
      try {
        await page.waitForFunction(() => window.primacy2.game.view?.fx.chargeKind === 2, null, { timeout: 4000 });
      } catch {
        // The start was refused. Ask the server directly to learn why.
        const r = await page.evaluate((id) => window.primacy2.game.cmd({ k: 'fold', system: id }), hop.id);
        if (r.ok) await page.waitForFunction(() => window.primacy2.game.view?.fx.chargeKind === 2, null, { timeout: 4000 });
        else throw new Error(`the fold jump to ${hop.name} was refused: ${r.err}`);
      }
      // The tunnel opens while the drive carries the ship; the last one may be photographed. Then wait until
      // the ship is in the new system (on the last hop that includes the handoff to the other server).
      const tunnel = await page.waitForFunction(() => window.__foldMax > 0.1, null, { timeout: 60_000, polling: 50 }).then(() => true, () => false);
      if (tunnel && last && tunnelShot) await shot(tunnelShot);
      if (!tunnel) problems.push(`journey: the fold tunnel to ${hop.name} was never seen`);
      await page.waitForFunction((id) => {
        const v = window.primacy2.game.view;
        return !!v && v.system.id === id && v.self !== null && v.fx.fold === 0;
      }, hop.id, { timeout: 120_000 }).catch(() => fail(`the pilot never arrived at ${hop.name}`));
      await page.evaluate(() => { window.__foldStop = true; });
      await page.waitForTimeout(600);
      log(`arrived at ${hop.name}`);
    }
  };

  // Remember the latest game events, so a failure can say what happened to the ship.
  await page.addInitScript(() => {
    window.__events = [];
    const watch = () => {
      const ev = window.primacy2?.game?.view?.events;
      if (ev && ev !== window.__last) { window.__last = ev; for (const e of ev) if (e.e !== 'cruise') window.__events.push(JSON.stringify(e).slice(0, 160)); window.__events.splice(0, Math.max(0, window.__events.length - 40)); }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  // The client keeps the pilot in a module-private store. Read the server's own messages instead: the
  // welcome (which starts a server's pilot view afresh) and later pilot updates, of the latest socket only.
  await page.addInitScript(() => {
    const tap = (window.__tap = { serverId: null, pilot: null, welcomes: 0, sock: null });
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          if (m.t === 'welcome') { tap.serverId = m.server.id; tap.pilot = m.pilot; tap.welcomes++; tap.sock = this; }
          else if (m.t === 'pilot' && tap.pilot && tap.sock === this) tap.pilot = { ...tap.pilot, ...m.p };
        });
      }
    };
  });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.start-card', { timeout: 20_000 });
  const pilotName = `Trader ${Date.now() % 100000}`;
  await login(page, pilotName);
  // Keep every reply of the game's command channel, so the sale can be compared with what the server said.
  await page.evaluate(() => {
    const g = window.primacy2.game;
    const orig = g.cmd.bind(g);
    window.__replies = [];
    g.cmd = async (c) => { const r = await orig(c); window.__replies.push({ k: c.k, r }); return r; };
  });
  await page.waitForSelector('.panel.wide .scroll > table tbody tr', { timeout: 10_000 });
  await page.waitForTimeout(800);
  const alphaId = await page.evaluate(() => window.primacy2.game.view.system.id.split(':')[0]);
  log(`${pilotName} docked at ${alphaId}`);

  // 1. Buy the cargo at Alpha's market.
  let rows = await marketRows();
  const alphaRow = rowOf(rows, CARGO.name);
  if (!alphaRow || !(digits(alphaRow[2]) > 0)) throw new Error(`Alpha does not sell ${CARGO.name}: ${JSON.stringify(rows.map((r) => r.slice(0, 4)))}`);
  const bought = await page.evaluate((c) => window.primacy2.game.cmd({ k: 'buy', c: c.id, n: c.tonnes }), CARGO);
  if (!bought.ok) throw new Error(`buying ${CARGO.name} failed: ${bought.err}`);
  await page.waitForFunction(([name, n]) => {
    const row = [...document.querySelectorAll('.panel.wide .scroll > table tbody tr')].find((r) => r.cells[0]?.innerText.trim() === name);
    return row && Number(row.cells[4].innerText) >= n;
  }, [CARGO.name, CARGO.tonnes], { timeout: 8000 }).catch(() => fail(`${CARGO.tonnes} t of ${CARGO.name} did not show up in the hold`));
  rows = await marketRows();
  log(`bought ${CARGO.tonnes} t ${CARGO.name} at Alpha, hold shows ${rowOf(rows, CARGO.name)[4]}`);
  await page.waitForTimeout(400);
  await shot('20-alpha-market-with-cargo');

  // 2. Out of the mass lock, then the fold jump to a system of Beta's sector.
  const alphaCredits = await creditsNow();
  log(`credits at Alpha before leaving: ${alphaCredits}`);
  await undock(page);
  await flyOut();

  await page.evaluate(() => window.primacy2.game.cmd({ k: 'galaxy' }));
  await page.waitForFunction(() => (window.primacy2.game.view?.galaxy?.sectors.length ?? 0) > 1, null, { timeout: 8000 });
  // The fewest jumps from here to a system with a station in another sector, each within the drive's range.
  // (From the home system the nearest system of Beta is out of reach, so the route has a stop in Alpha's own sector.)
  const route = await page.evaluate(() => {
    const v = window.primacy2.game.view;
    const range = v.self.stats.jumpRange;
    const all = [];
    for (const sec of v.galaxy.sectors) {
      for (const sys of sec.systems) all.push({ id: sys.id, name: sys.name, pos: sys.pos, stations: sys.stations, security: sys.security, sector: sec.id, sectorName: sec.name, tier: sec.tier, own: sec.id === v.galaxy.self });
    }
    const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
    const start = all.find((x) => x.id === v.system.id);
    // Breadth first over the home sector's systems, so every path has the fewest jumps. Goals are the
    // systems with a station in another sector; the safest class wins (pirates fly in the others), then the shortest path.
    const prev = new Map([[start.id, null]]);
    const depth = new Map([[start.id, 0]]);
    const queue = [start];
    const goals = [];
    while (queue.length) {
      const a = queue.shift();
      for (const b of all) {
        if (prev.has(b.id) || dist(a, b) > range) continue;
        prev.set(b.id, a);
        depth.set(b.id, depth.get(a.id) + 1);
        if (!b.own) { if (b.stations > 0) goals.push(b); continue; }
        queue.push(b);
      }
    }
    const rank = { secure: 0, frontier: 1, lawless: 2 };
    goals.sort((p, q) => (rank[p.security] ?? 3) - (rank[q.security] ?? 3) || depth.get(p.id) - depth.get(q.id));
    const goal = goals[0];
    if (!goal) return { range, hops: [] };
    const hops = [];
    for (let x = goal; prev.get(x.id); x = prev.get(x.id)) hops.unshift({ ...x, ly: dist(prev.get(x.id), x) });
    return { range, hops };
  });
  if (!route.hops.length) throw new Error(`no route with jumps of ${route.range} ly leads to a station in the other sector`);
  const dest = route.hops[route.hops.length - 1];
  const betaId = dest.sector;
  log(`route: ${route.hops.map((h) => `${h.name} (${h.ly.toFixed(1)} ly, ${h.security})`).join(' -> ')}, drive range ${route.range} ly, ${dest.sectorName} rated ${dest.tier}`);
  // A. The galaxy map at Alpha, before the jump: select a system of Beta's sector with a real click
  // on the canvas and read what the panel promises for the 4 t of Water and for the ship.
  const openMap = async () => {
    await page.keyboard.press('KeyM');
    await page.waitForSelector('.panel.map canvas', { timeout: 5000 });
    await page.waitForTimeout(500);
  };
  const closeMap = () => page.click('.panel.map header button');
  const asideText = () => page.$eval('.panel.map aside .stack', (n) => n.innerText).catch(() => '');
  await openMap();
  // The map opens centred on the pilot's system at scale 14 px/ly; the wheel divides the scale by 1.2 per tick.
  const aim = await page.evaluate((id) => {
    const g = window.primacy2.game.view;
    const sys = g.galaxy.sectors.flatMap((s) => s.systems).find((x) => x.id === id);
    const r = document.querySelector('.panel.map canvas').getBoundingClientRect();
    const dx = Math.abs(sys.pos[0] - g.system.pos[0]);
    const dz = Math.abs(sys.pos[2] - g.system.pos[2]);
    let ticks = 0;
    let scale = 14;
    while (scale > 0.4 && (dx * scale > r.width / 2 - 25 || dz * scale > r.height / 2 - 25)) { ticks++; scale = Math.max(0.4, scale / 1.2); }
    return { ticks, scale, cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: r.left + r.width / 2 + (sys.pos[0] - g.system.pos[0]) * scale, y: r.top + r.height / 2 + (sys.pos[2] - g.system.pos[2]) * scale };
  }, dest.id);
  await page.mouse.move(aim.cx, aim.cy);
  for (let i = 0; i < aim.ticks; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(60); }
  // Zooming out put the target somewhere else on the canvas; recompute with the scale the ticks reached.
  const click = await page.evaluate(([id, ticks]) => {
    const g = window.primacy2.game.view;
    const sys = g.galaxy.sectors.flatMap((s) => s.systems).find((x) => x.id === id);
    const r = document.querySelector('.panel.map canvas').getBoundingClientRect();
    const scale = Math.max(0.4, 14 / Math.pow(1.2, ticks));
    return { x: r.left + r.width / 2 + (sys.pos[0] - g.system.pos[0]) * scale, y: r.top + r.height / 2 + (sys.pos[2] - g.system.pos[2]) * scale, scale };
  }, [dest.id, aim.ticks]);
  await page.mouse.click(click.x, click.y);
  await page.waitForTimeout(400);
  let panelText = await asideText();
  let selectedBy = 'a click on the canvas';
  if (!panelText.includes(dest.sectorName) || !/if you jump there/i.test(panelText)) {
    // The click landed on another star (stars crowd at low zoom). Select the destination the way the UI's own
    // destination button does and open the map again: it starts with the fold target selected.
    log(`click at scale ${click.scale.toFixed(2)} did not select a system of ${dest.sectorName}: ${JSON.stringify(panelText.slice(0, 120))}`);
    await closeMap();
    await page.evaluate((id) => window.primacy2.game.setFoldTarget(id), dest.id);
    await openMap();
    panelText = await asideText();
    selectedBy = 'the fold target (the click missed)';
  }
  const forecast = await page.$eval('.panel.map aside .forecast', (n) => n.innerText).catch(() => '');
  log(`map selection by ${selectedBy}; forecast: ${JSON.stringify(forecast)}`);
  check(panelText.includes(dest.sectorName), `the map panel shows a system of ${dest.sectorName}`);
  check(/\b4 t count as imports there/.test(forecast), 'the forecast says "4 t count as imports there" (trade partner)', `the forecast should say 4 t count as imports there, got ${JSON.stringify(forecast)}`);
  check(/ship will be bound/i.test(forecast), 'the forecast says the ship will be bound', `the forecast should say the ship will be bound, got ${JSON.stringify(forecast)}`);
  await shot('19-alpha-map-forecast');
  await closeMap();
  await page.waitForTimeout(300);

  await foldTo(route.hops, '21-fold-tunnel');
  await page.waitForFunction((beta) => window.primacy2.game.view?.galaxy?.self === beta, betaId, { timeout: 20_000 }).catch(() => fail('the page is not connected to the other sector'));
  await page.waitForTimeout(1000);
  await shot('22-arrival-at-beta');
  log(`arrived: ${JSON.stringify(await stateDump())}`);

  // 3. To a station of the system: nav target, cruise, drop at the station, normal flight, dock.
  const station = await page.evaluate(() => {
    const v = window.primacy2.game.view;
    const sites = v.sites.filter((s) => s.def.kind === 'station' || s.def.kind === 'outpost').sort((a, b) => a.dist - b.dist);
    const s = sites[0];
    return s ? { id: s.def.id, name: s.def.name, dist: s.dist, kind: s.def.kind } : null;
  });
  if (!station) throw new Error('the arrival system has no station');
  log(`station ${station.name} (${station.kind}), ${(station.dist / 1000).toFixed(0)} km away`);
  await page.evaluate((id) => window.primacy2.game.setNav(id), station.id);
  const held = {};
  let phase = 'cruise';
  let lastLog = 0;
  let shotApproach = false;
  let lastEngage = 0;
  const t0 = Date.now();
  const deadline = t0 + 25 * 60_000;
  while (Date.now() < deadline) {
    const s = await steerAtSite(page, station.id);
    if (!s) {
      const now = await stateDump();
      if (now?.mode === MODE.docked) break;
      if (now?.mode === MODE.destroyed) throw new ShipLost('the ship was shot down on the way to the station');
      await fail('lost sight of the station');
    }
    if (Date.now() - lastLog > 10_000) { lastLog = Date.now(); log(`${phase}: ${JSON.stringify({ dist: Math.round(s.dist), speed: Math.round(s.speed), off: Math.round(s.off), detour: s.detour })}`); }
    if (s.mode === MODE.cruise) {
      const aligned = s.off < 140;
      // The speed may not exceed about a tenth of the distance per second, so the drop happens near the minimum speed.
      const ceiling = Math.max(s.dist / 10, 45_000);
      let want = null;
      if (aligned && s.speed < ceiling * 0.5) want = 'KeyW';
      else if (s.speed > ceiling) want = 'KeyS';
      await throttleKeys(page, held, want);
      if (s.dist < 16_000 && !s.detour) {
        await throttleKeys(page, held, null);
        await page.evaluate(() => window.primacy2.game.toggleCruise());
        await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 5000 }).catch(() => fail('cruise did not drop at the station'));
        phase = 'approach';
        log(`dropped at ${Math.round(s.dist)} m, ${Math.round(s.speed)} m/s`);
        await shot('23-dropped-at-station');
      }
    } else if (s.mode === MODE.normal) {
      if (phase === 'cruise' || (s.dist > 2_000_000 && Date.now() - lastEngage > 8000)) {
        // The drive dropped out of cruise before the station (or has not been engaged yet): engage it again.
        lastEngage = Date.now();
        log(`out of cruise ${Math.round(s.dist)} m from the station at ${Math.round(s.speed)} m/s, engaging again`);
        await throttleKeys(page, held, null);
        await page.evaluate(() => window.primacy2.game.toggleCruise());
        await page.waitForTimeout(5500);
        continue;
      }
      phase = 'approach';
      const closeEnough = s.radius + 1300;
      const goal = Math.min(500, Math.max(100, (s.dist - closeEnough) / 6));
      let want = null;
      if (s.dist > closeEnough + 200 && s.speed < goal - 15) want = 'KeyW';
      else if (s.speed > goal + 15 || (s.dist <= closeEnough + 200 && s.speed > 110)) want = 'KeyS';
      // Stopped just outside the dock range (between closeEnough and closeEnough + 200 m): creep on.
      else if (s.dist > closeEnough && s.speed < 50) want = 'KeyW';
      await throttleKeys(page, held, want);
      if (!shotApproach && s.dist < 20_000) { shotApproach = true; await shot('24-approach'); }
      if (s.dist <= closeEnough && s.speed <= 110) {
        await throttleKeys(page, held, null);
        const r = await page.evaluate(() => window.primacy2.game.cmd({ k: 'dock' }));
        if (r.ok) {
          await page.waitForFunction(() => window.primacy2.game.view?.mode === 3, null, { timeout: 8000 }).catch(() => {});
          continue;
        }
        log(`dock refused: ${r.err}`);
      }
    }
    await page.waitForTimeout(80);
  }
  await throttleKeys(page, held, null);
  if ((await stateDump())?.mode !== MODE.docked) await fail('the pilot did not dock at the station in time');
  log(`docked at ${station.name} after ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.waitForSelector('.panel.wide .scroll > table tbody tr', { timeout: 10_000 });
  await page.waitForTimeout(1000);
  await shot('25-beta-market-before');

  // 4. The model, as the market shows it.
  const originsText = await page.$eval('.origins', (n) => n.innerText).catch(() => null);
  log(`origins panel: ${JSON.stringify(originsText)}`);
  if (!originsText) throw new Error('the market shows no foreign cargo panel although the hold has cargo from Alpha');
  const originRow = await page.$$eval('.origins tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.trim())));
  if (originRow.length !== 1 || !/alpha/i.test(originRow[0][0])) problems.push(`journey: expected one origin row for Alpha, got ${JSON.stringify(originRow)}`);
  if (!/partner/i.test(originRow[0]?.[1] ?? '')) problems.push(`journey: Alpha should be shown as partner, got ${JSON.stringify(originRow[0])}`);
  if (digits(originRow[0]?.[2]) !== CARGO.tonnes) problems.push(`journey: the hold should show ${CARGO.tonnes} t from Alpha, got ${JSON.stringify(originRow[0])}`);
  if (!(digits(originRow[0]?.[4]) > 0)) problems.push(`journey: the import allowance for Alpha should be positive, got ${JSON.stringify(originRow[0])}`);
  const lotText = await page.$eval('tr.lots', (n) => n.innerText).catch(() => '');
  if (!/import/i.test(lotText)) problems.push(`journey: the lot under ${CARGO.name} should be marked import, got ${JSON.stringify(lotText)}`);
  // B. The licence gauge and the foreign cargo table at Beta, then a real sale of 2 t with the tariff withheld.
  const licenceText = () => page.$eval('.licence-head', (n) => n.innerText).catch(() => '');
  const licence0 = await licenceText();
  check(/\b2,000 TU free/.test(licence0), 'the licence gauge shows 2,000 TU free', `the licence should show 2,000 TU free, got ${JSON.stringify(licence0)}`);
  check(/alpha/i.test(originRow[0]?.[0] ?? '') && /partner/i.test(originRow[0]?.[1] ?? '') && digits(originRow[0]?.[2]) === CARGO.tonnes,
    'the foreign cargo table lists Alpha as trade partner with 4 t');
  const tableRow = page.locator('.panel.wide .scroll > table tbody tr:not(.lots)').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${CARGO.name}$`) }) });
  const holdNow = async () => digits(await tableRow.locator('td').nth(4).innerText());
  const SELL = 2;
  const sellPrice = digits(await tableRow.locator('td').nth(3).innerText());
  const before = { credits: await creditsNow(), hold: await holdNow() };
  check(before.credits === 0, 'the pilot has 0 credits at Beta (credits stay on their own server)', `expected 0 credits at Beta, got ${before.credits}`);
  await tableRow.locator('input').fill(String(SELL));
  await tableRow.locator('button:text-is("Sell")').click();
  await page.waitForSelector('.sale-note, .panel.wide .bad', { timeout: 8000 });
  await page.waitForTimeout(700);
  const note = await page.$eval('.sale-note, .panel.wide .bad', (n) => n.innerText).catch(() => '');
  log(`sale note: ${JSON.stringify(note)}`);
  await shot('26-beta-sale-with-tariff');
  const reply = await page.evaluate(() => [...window.__replies].reverse().find((x) => x.k === 'sell')?.r ?? null);
  log(`sell reply: ${JSON.stringify(reply)}, Water sells at ${sellPrice} cr/t`);
  check(reply?.ok === true && reply.data?.n === SELL, `the sell command sold ${SELL} t`, `the sale should have succeeded with n = ${SELL}, got ${JSON.stringify(reply)}`);
  const total = reply?.data?.total ?? NaN;
  check(/Sold 2 t Water/.test(note) && /tariff/i.test(note), 'the sale note names 2 t of Water and a tariff', `the sale note should name 2 t and a tariff, got ${JSON.stringify(note)}`);
  check(total > 0 && total < SELL * sellPrice, `the total (${total} cr) is above 0 and below 2 x ${sellPrice} cr (tariff withheld, ${reply?.data?.tariff} cr)`,
    `the total ${total} should be in (0, ${SELL * sellPrice})`);
  check(reply?.data?.tariff > 0, 'the reply carries a tariff above 0', `the reply should carry a tariff, got ${JSON.stringify(reply?.data)}`);
  const credits1 = await creditsNow();
  check(credits1 === before.credits + total, `credits rose from ${before.credits} to ${credits1}, exactly the total of the reply`, `credits should be ${before.credits + total}, got ${credits1}`);
  const hold1 = await holdNow();
  check(hold1 === CARGO.tonnes - SELL, `the hold now has ${hold1} t of Water`, `the hold should have ${CARGO.tonnes - SELL} t, got ${hold1}`);
  const licence1 = await licenceText();
  check(/\b64 of 2,000 TU used/.test(licence1), 'the licence shows 64 TU used', `the licence should show 64 TU used, got ${JSON.stringify(licence1)}`);

  // C. The bound mark in Outfitting and the Shipyard.
  const tabBtn = (name) => page.locator('.panel.wide nav.tabs button', { hasText: new RegExp(`^${name}$`) });
  await tabBtn('Outfitting').click();
  await page.waitForTimeout(500);
  const boundChips = await page.$$eval('.panel.wide .chip.bound', (n) => n.map((x) => x.innerText.trim()));
  check(boundChips.length > 0 && boundChips.every((x) => /bound/i.test(x)), `the Outfitting tab shows the Bound mark on ${boundChips.length} fitted part(s)`, `no Bound mark in Outfitting: ${JSON.stringify(boundChips)}`);
  await shot('28-beta-outfitting-bound');
  if (await tabBtn('Shipyard').count()) {
    await tabBtn('Shipyard').click();
    await page.waitForTimeout(500);
    await shot('29-beta-shipyard-bound');
    log('shipyard screenshot taken');
  }
  // Fuel for the way back: refuel with what credits there are.
  await tabBtn('Services').click();
  await page.waitForTimeout(300);
  const refuel = page.locator('.panel.wide button', { hasText: /^Refuel/ });
  if (await refuel.isEnabled()) {
    await refuel.click();
    await page.waitForTimeout(800);
  }
  const refuelErr = await page.$eval('.panel.wide .bad', (n) => n.innerText).catch(() => '');
  log(`refuelled at Beta (${refuelErr ? `refused: ${refuelErr}` : 'ok'}), credits now ${await creditsNow()}`);

  // 6. The galaxy map at Beta: the relation to Alpha.
  await page.keyboard.press('KeyM');
  await page.waitForSelector('.panel.map canvas', { timeout: 5000 });
  await page.waitForTimeout(800);
  const sectors = await page.$eval('.panel.map .sectors', (n) => n.innerText).catch(() => '');
  log(`map sectors: ${JSON.stringify(sectors)}`);
  if (!/alpha/i.test(sectors) || !/partner/i.test(sectors)) problems.push(`journey: the map at Beta should list Alpha Reach as trade partner, got ${JSON.stringify(sectors)}`);
  await shot('27-beta-galaxy-map');
  await closeMap();

  // D. The way back: undock, fold into Alpha's sector (served by Alpha, so the pilot is handed back).
  await page.evaluate(() => { window.primacy2.game.input.testMode = true; });
  const undocked = await page.evaluate(() => window.primacy2.game.cmd({ k: 'undock' }));
  if (!undocked.ok) throw new Error(`undocking at Beta failed: ${undocked.err}`);
  await page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 });
  await flyOut();
  await page.evaluate(() => window.primacy2.game.cmd({ k: 'galaxy' }));
  await page.waitForFunction(() => (window.primacy2.game.view?.galaxy?.sectors.length ?? 0) > 1, null, { timeout: 8000 });
  const back = await page.evaluate((home) => {
    const v = window.primacy2.game.view;
    const range = v.self.stats.jumpRange;
    const here = v.galaxy.sectors.flatMap((s) => s.systems).find((x) => x.id === v.system.id);
    const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
    const rank = { secure: 0, frontier: 1, lawless: 2 };
    const sec = v.galaxy.sectors.find((s) => s.id === home);
    const cands = (sec?.systems ?? []).map((x) => ({ id: x.id, name: x.name, security: x.security, ly: dist(here, x) })).filter((x) => x.ly <= range);
    cands.sort((p, q) => (rank[p.security] ?? 3) - (rank[q.security] ?? 3) || p.ly - q.ly);
    return { range, here: here.name, cands };
  }, alphaId);
  if (!back.cands.length) throw new Error(`no system of Alpha's sector lies within the drive range of ${back.range} ly from ${back.here}`);
  const home = back.cands[0];
  log(`return jump: ${back.here} -> ${home.name} (${home.ly.toFixed(1)} ly, ${home.security}), drive range ${back.range} ly`);
  await foldTo([home], null);
  await page.waitForFunction((id) => window.__tap.serverId === id && window.primacy2.game.view?.self != null, alphaId, { timeout: 30_000 }).catch(() => fail('the page is not connected to Alpha again'));
  await page.waitForTimeout(1000);
  await shot('30-back-in-alpha');
  const t = await tap();
  const cargo = t.pilot?.passport?.ship?.cargo ?? [];
  const water = cargo.filter((c) => c.c === CARGO.id);
  log(`back at Alpha (welcome #${t.welcomes}, server ${t.serverId}): cargo ${JSON.stringify(cargo)}, credits ${t.pilot?.credits}, shipBound ${JSON.stringify(t.pilot?.shipBound)}`);
  check(t.serverId === alphaId, 'the page is connected to Alpha again');
  check(water.reduce((n, c) => n + c.n, 0) === CARGO.tonnes - SELL && water.every((c) => c.origin === alphaId && !c.sealed),
    `the ${CARGO.tonnes - SELL} t of Water have Alpha as origin and are not sealed`, `the Water should be 2 t of Alpha origin, not sealed, got ${JSON.stringify(cargo)}`);
  check(t.pilot?.shipBound === null, 'pilot.shipBound is null (the unchanged ship is local again)', `shipBound should be null, got ${JSON.stringify(t.pilot?.shipBound)}`);
  check(t.pilot?.credits === alphaCredits, `credits are back at ${alphaCredits}, what the pilot had at Alpha before leaving`, `credits should be ${alphaCredits}, got ${t.pilot?.credits}`);
}

const problems = [];
const steps = [];
let servers = null;
let browser = null;
try {
  servers = process.env.PRIMACY2_URL ? null : await startServers();
  // Two pilots play at once, so neither page may be slowed down for being in the background.
  browser = await chromium.launch({
    args: [
      '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
    ],
  });
  if (!JOURNEY_ONLY) {  // the fight, insurance and flight checks; skipped when only the journey is wanted
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); steps.push(name); };
    const state = () => page.evaluate(() => {
      const v = window.primacy2.game.view;
      const s = v?.self?.state;
      return v ? { mode: v.mode, system: v.system.name, speed: s ? Math.hypot(...s.vel) : 0, pos: s ? Math.hypot(...s.pos) : 0, cruise: s?.cruiseSpeed ?? 0, ents: v.ents.length } : null;
    });

    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.start-card', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await shot('01-menu');

    await login(page, 'Test Pilot');
    await page.waitForTimeout(1500);
    await shot('02-docked-station');

    await undock(page);
    await page.waitForTimeout(1200);
    await shot('03-undocked-cockpit');

    // Power distribution and silent running travel with the input and come back in the ship state.
    // A failed check is recorded and the settings are restored either way, so the later steps still run.
    {
      const own = () => page.evaluate(() => {
        const v = window.primacy2.game.view?.self;
        return v ? { pips: v.state.pips, shield: v.state.shield, sig: v.state.sig, shieldMax: v.stats.shieldMax } : null;
      });
      const until = (fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
      const before = await own();
      if (!before) throw new Error('no ship state after undocking');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      // Engines are the second of three 4-bit fields; the default is 4 half-pips each.
      if (!(await until((p) => { const n = window.primacy2.game.view?.self?.state.pips; return n !== undefined && n !== p && ((n >> 4) & 15) > 4; }, before.pips, 5_000))) {
        problems.push(`power: two presses of ArrowUp did not move power to the engines (${JSON.stringify(await own())})`);
      }
      await page.keyboard.press('KeyB');
      if (!(await until((sh) => { const s = window.primacy2.game.view?.self?.state; return !!s && s.shield < sh && s.sig < 0.2; }, before.shield, 8_000))) {
        problems.push(`silent running: shield did not fall or signature stayed high (${JSON.stringify(await own())})`);
      }
      await page.waitForTimeout(2500);
      await shot('03b-silent-running');
      await page.keyboard.press('KeyB');
      await page.keyboard.press('ArrowDown');
      const low = await own();
      if (!(await until(([p, sh]) => { const s = window.primacy2.game.view?.self; return !!s && s.state.pips === p && s.state.shield > sh + s.stats.shieldMax * 0.02; }, [before.pips, low?.shield ?? 0], 30_000))) {
        problems.push(`silent running: power did not return to the default or the shield did not recover (${JSON.stringify(await own())})`);
      }
    }

    await page.keyboard.press('KeyV');
    await page.waitForTimeout(800);
    await shot('04-chase');

    // A second pilot with an identity of their own joins and undocks at the same station.
    const context2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page2 = await context2.newPage();
    page2.on('pageerror', (e) => problems.push(`pageerror (wingman): ${e.message}`));
    page2.on('console', (m) => { if (m.type() === 'error') problems.push(`console (wingman): ${m.text()}`); });
    await page2.goto(URL, { waitUntil: 'load' });
    await page2.waitForSelector('.start-card', { timeout: 20_000 });
    await login(page2, 'Wingman');
    await undock(page2);

    if (!(await targetPlayer(page))) throw new Error('the second pilot never showed up as a contact');
    if (!(await aimAtTarget(page))) throw new Error('could not bring the second pilot into view');
    await page.waitForTimeout(600);
    await shot('05-wingman-in-sight');

    // The first pilot turns away from the station, flies out of its mass lock, where weapons are
    // free, and stops there.
    if (!(await aimAwayFromStation(page))) throw new Error('could not turn away from the station');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(4000);
    const flying = await state();
    if (!(flying.speed > 60)) throw new Error(`thrust had no effect: ${JSON.stringify(flying)}`);
    await shot('06-flying');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => {
      const self = window.primacy2.game.view?.self;
      if (!self) throw new Error('the pilot lost the ship on the way out');
      return Math.hypot(...self.state.pos) > 5600;
    }, null, { timeout: 60_000 });
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');

    // Count the combat events the first pilot receives from here on.
    await page.evaluate(() => {
      const seen = (window.__combat = { shot: 0, hit: 0 });
      let last = null;
      const watch = () => {
        const ev = window.primacy2.game.view?.events;
        if (ev && ev !== last) {
          last = ev;
          for (const e of ev) if (e.e === 'shot' || e.e === 'hit') seen[e.e]++;
        }
        requestAnimationFrame(watch);
      };
      watch();
    });

    // The second pilot gives chase, closes to gun range outside the mass lock and shoots the first
    // pilot down. A starter ship does not survive that for long.
    if (!(await targetPlayer(page2))) throw new Error('the second pilot does not see the first');
    // Boost for the long stretch only: arriving at boost speed would carry the pursuer into its target.
    await page2.keyboard.down('KeyW');
    await page2.keyboard.down('ShiftLeft');
    const near = await steerUntil(page2, 'chase', (v) => v.dist < 4000, 120_000);
    await page2.keyboard.up('ShiftLeft');
    const closed = near === true ? await steerUntil(page2, 'chase', (v) => v.dist < 2400 && v.own > 4700, 120_000) : near;
    await page2.keyboard.up('KeyW');
    if (closed !== true) {
      const dump = (pg) => pg.evaluate(() => {
        const v = window.primacy2.game.view;
        return v ? { mode: v.mode, self: v.self ? Math.round(Math.hypot(...v.self.state.pos)) : null, hull: v.self?.state.hull, target: v.targetId, ents: v.ents.map((e) => `${e.id}:${e.info.kind}:${e.info.player ? 'P' : e.info.npc ?? '-'}:${Math.round(Math.hypot(...e.rel))}`) } : null;
      });
      throw new Error(`the second pilot could not close in on the first (${closed}); wingman ${JSON.stringify(await dump(page2))}; first ${JSON.stringify(await dump(page))}`);
    }
    if (!(await aimAtTarget(page2))) throw new Error('the second pilot could not aim at the first');
    if (await targetPlayer(page)) await aimAtTarget(page, 6000);
    await page2.mouse.move(800, 450);
    await page2.mouse.down();
    await page2.waitForTimeout(450);
    await page2.screenshot({ path: `${OUT}/07-wingman-fires.png` });
    await shot('08-under-fire');
    const kill = await steerUntil(page2, 'target', () => false, 40_000);
    await page2.mouse.up();
    if (kill !== 'lost') throw new Error('the first pilot survived forty seconds of fire');
    await page2.waitForTimeout(150);
    await page2.screenshot({ path: `${OUT}/09-after-the-kill.png` });
    const combat = await page.evaluate(() => window.__combat);
    if (!(combat.shot > 0 && combat.hit > 0)) throw new Error(`the first pilot saw no shots or hits: ${JSON.stringify(combat)}`);
    console.log(`combat events seen by the first pilot: ${JSON.stringify(combat)}`);
    await context2.close();

    // Insurance: the first pilot returns to the home station in a replacement ship and sets out again.
    await page.waitForFunction(() => { const v = window.primacy2.game.view; return !v?.self || v.mode === 4; }, null, { timeout: 10_000 });
    await page.waitForTimeout(800);
    await shot('11-destroyed');
    await page.getByRole('button', { name: /home station/i }).click();
    await page.waitForFunction(() => window.primacy2.game.view?.mode === 3, null, { timeout: 15_000 });
    await page.waitForTimeout(1200);
    await shot('12-rebuilt-at-station');
    await undock(page);

    // The wreck of the lost ship is still out there. Fly to the nearest wreck and look at it.
    await page.waitForFunction(() => window.primacy2.game.view?.ents.some((e) => e.info.kind === 6), null, { timeout: 20_000 })
      .catch(() => { throw new Error('the destroyed ship left no wreck'); });
    await page.evaluate(() => {
      const g = window.primacy2.game;
      const wrecks = g.view.ents.filter((e) => e.info.kind === 6).sort((p, q) => Math.hypot(...p.rel) - Math.hypot(...q.rel));
      g.setTarget(wrecks[0].id);
    });
    await page.waitForFunction(() => window.primacy2.game.view?.targetId != null, null, { timeout: 5000 });
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    const reached = await steerUntil(page, 'chase', (v) => v.dist < 900, 120_000);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    if (reached !== true) throw new Error(`could not reach the wreck (${reached})`);
    await steerUntil(page, 'target', (v) => v.dist < 260, 20_000);
    await aimAtTarget(page, 10_000);
    await shot('13-wreck');

    if (!(await aimAwayFromStation(page))) throw new Error('could not turn away from the station');
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => {
      const self = window.primacy2.game.view?.self;
      if (!self) throw new Error('the pilot lost the replacement ship');
      return Math.hypot(...self.state.pos) > 4600;
    }, null, { timeout: 60_000 });
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(() => window.primacy2.game.view?.mode === 1, null, { timeout: 15_000 });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(6000);
    await page.keyboard.up('KeyW');
    const cruising = await state();
    if (!(cruising.cruise > 60_000)) throw new Error(`cruise did not accelerate: ${JSON.stringify(cruising)}`);
    await shot('14-cruise');

    await page.keyboard.press('KeyM');
    await page.waitForSelector('.panel.map canvas', { timeout: 5000 });
    await page.waitForTimeout(800);
    await shot('15-galaxy-map');
    await page.keyboard.press('Escape');

    await page.keyboard.press('KeyN');
    await page.waitForSelector('.panel.narrow .list', { timeout: 5000 });
    await page.waitForTimeout(400);
    await shot('16-navigation');
    await page.keyboard.press('Escape');

    const fps = await page.evaluate(() => new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(Math.round(n / 2)); };
      requestAnimationFrame(tick);
    }));
    console.log(`steps: ${steps.join(', ')}`);
    console.log(`state: ${JSON.stringify(await state())}, fps ${fps}`);
  }
  // The journey runs last, as a new pilot in a fresh browser context.
  for (let attempt = 1; ; attempt++) {
    try {
      await journey(browser, problems, steps);
      break;
    } catch (err) {
      if (!(err instanceof ShipLost) || attempt >= 3) throw err;
      console.log(`journey: ${err.message}; starting over with a new pilot (attempt ${attempt + 1})`);
    }
  }
} catch (err) {
  problems.push(`failed after [${steps.join(', ')}]: ${err.message}`);
} finally {
  await browser?.close().catch(() => {});
  stopServers(servers);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('e2e ok');
process.exit(0);
