// End-to-end smoke test of the real game in a real browser.
//
//   npm run build && node scripts/e2e.mjs
//
// Starts two linked servers (scripts/dev.ts), opens the game in GPU-accelerated headless Chromium,
// logs in, undocks, is shot down by a second pilot, comes back through insurance, engages cruise
// and opens the maps; a new pilot trades across the servers; two more land at a ground base.
// Screenshots go to screenshots/e2e/.
// Exits with code 1 when a step fails or the page logged an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'screenshots/e2e';
// PRIMACY2_JOURNEY_ONLY=1 skips the fight and flight checks and plays only the cross-server journey.
const JOURNEY_ONLY = process.env.PRIMACY2_JOURNEY_ONLY === '1';
// PRIMACY2_LANDING_ONLY=1 plays only the landing at a ground base.
const LANDING_ONLY = process.env.PRIMACY2_LANDING_ONLY === '1';
const URL = process.env.PRIMACY2_URL ?? 'http://localhost:8420';
mkdirSync(OUT, { recursive: true });

function startServers() {
  return new Promise((resolve, reject) => {
    // Every run plays in the same two sectors (see scripts/dev.ts). Universe 16 was picked by generating
    // candidates: Alpha's capital is one jump of a starter drive from a secure Beta system with a
    // station, and has a ground base on a rocky moon. Set the variable to try another universe.
    const env = { ...process.env, PRIMACY2_FIXED_UNIVERSE: process.env.PRIMACY2_FIXED_UNIVERSE ?? '16' };
    const child = spawn('npx tsx scripts/dev.ts', { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env });
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

/** From an undocked ship out of the station's mass lock, nose away from the station. */
async function flyOutOf(page) {
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
}

/**
 * Fold jumps along `hops`; waits for the arrival (on the last hop including a handoff to another server).
 * `c` is { page, shot, log, fail, problems, who }. A tunnel that is never seen is a failure.
 */
async function foldHops(c, hops, tunnelShot) {
  const { page, shot, log, fail, problems, who } = c;
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
    // Every handoff shows the tunnel (warp gates included), so a jump without one is a failure.
    if (!tunnel) problems.push(`${who}: the fold tunnel to ${hop.name} was never seen`);
    await page.waitForFunction((id) => {
      const v = window.primacy2.game.view;
      return !!v && v.system.id === id && v.self !== null && v.fx.fold === 0;
    }, hop.id, { timeout: 120_000 }).catch(() => fail(`the pilot never arrived at ${hop.name}`));
    await page.evaluate(() => { window.__foldStop = true; });
    await page.waitForTimeout(600);
    log(`arrived at ${hop.name}`);
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

  const flyOut = () => flyOutOf(page);

  // Fold jumps along `hops`; waits for the arrival (on the last hop including a handoff to another server).
  const foldTo = (hops, tunnelShot) => foldHops({ page, shot, log, fail, problems, who: 'journey' }, hops, tunnelShot);

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
    const sites = v.sites.filter((s) => s.def.kind === 'station' || s.def.kind === 'outpost').sort((a, b) => (a.def.kind === 'station' ? 0 : 1) - (b.def.kind === 'station' ? 0 : 1) || a.dist - b.dist);  // a station before an outpost: only it has an outfitter
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
  if (await tabBtn('Outfitting').count()) {
    await tabBtn('Outfitting').click();
    await page.waitForTimeout(500);
    const boundChips = await page.$$eval('.panel.wide .chip.bound', (n) => n.map((x) => x.innerText.trim()));
    check(boundChips.length > 0 && boundChips.every((x) => /bound/i.test(x)), `the Outfitting tab shows the Bound mark on ${boundChips.length} fitted part(s)`, `no Bound mark in Outfitting: ${JSON.stringify(boundChips)}`);
    await shot('28-beta-outfitting-bound');
  } else {
    log(`warning: ${station.name} (${station.kind}) has no Outfitting tab; the bound mark could not be checked`);
  }
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

// ---------------------------------------------------------------------------------------------
// The landing: two new pilots fly from Alpha's station to a ground base in cruise and drop at the
// cruise ceiling; one lands beside the pad, flies to it and docks, the other crashes on purpose.
// Nothing draws the ground or shows the base yet, so the pilots fly by the client's numbers
// (`view.surface`): height above ground, vertical and ground speed, slope, landed.
// ---------------------------------------------------------------------------------------------

const MODE_LANDED = 5;

/**
 * Installed into the page of a landing pilot as `window.__L`: the steering that the numbers need.
 * `cruiseAim` steers cruise toward the base's body; `setServo` runs a 50 Hz controller that holds
 * the ship level and flies it by velocity over the ground (keys are pressed through the input
 * module's own state); `status` reads the numbers back.
 */
function installLandingTools() {
  const g = window.primacy2.game;
  const MODE_LANDED = 5;
  const L = (window.__L = { servo: null, active: false, err: null, rec: { minVs: 0, gs: 0 }, last: null });
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => scale(a, 1 / (len(a) || 1));
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const qrot = (q, v) => {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  };
  const qun = (q, v) => qrot([-q[0], -q[1], -q[2], q[3]], v);
  L.qun = qun;

  // Distance from point c to the segment from the origin to p.
  const segDist = (c, p) => {
    const t = clamp(dot(c, p) / (dot(p, p) || 1), 0, 1);
    return len(sub(c, scale(p, t)));
  };

  /**
   * One cruise steering step toward the base `siteId`. Phase 'transfer' aims at a point three radii
   * straight above the pad (by way of a point beside the body when the body is in the way), phase
   * 'dive' at the pad itself, so that the cruise ceiling ends the flight over the base. Other
   * bodies are passed at a distance. Returns the state of the approach, null when the site is gone.
   */
  L.cruiseAim = (siteId, phase) => {
    const v = g.view;
    const site = v?.sites.find((s) => s.def.id === siteId);
    const self = v?.self;
    if (!v || !self || !site) return null;
    const o = self.rel;
    const host = v.bodies[site.def.ground.body];
    const R = host.def.radius;
    const C = sub(host.rel, o);
    const pad = sub(site.rel, o);
    const u = unit(sub(pad, C));
    const s = unit(scale(C, -1));
    let aim = pad;
    let label = 'pad';
    let near = false;
    if (phase === 'transfer') {
      const T1 = add(C, scale(u, 3 * R));
      if (segDist(C, T1) < 1.3 * R) {
        let w = sub(u, scale(s, dot(u, s)));
        if (len(w) < 1e-3) w = cross(s, Math.abs(s[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
        aim = add(C, scale(unit(w), 3 * R));
        label = 'beside the body';
      } else {
        aim = T1;
        label = 'above the pad';
      }
      near = len(T1) < 0.5 * R && dot(s, u) > 0.9;
    }
    // Other bodies on the way are passed at 2.6 radii.
    let detour = null;
    let worst = Infinity;
    for (const [i, b] of v.bodies.entries()) {
      if (i === site.def.ground.body) continue;
      const bc = sub(b.rel, o);
      const u2 = dot(bc, aim) / dot(aim, aim);
      if (u2 <= 0 || u2 >= 1) continue;
      const side = sub(bc, scale(aim, u2));
      const miss = len(side);
      if (miss >= b.def.radius * 2.2 || miss >= worst) continue;
      worst = miss;
      const away = miss > 1 ? scale(side, -1 / miss) : unit(cross(aim, [0, 1, 0]));
      aim = add(bc, scale(away, b.def.radius * 2.6));
      detour = b.def.name;
    }
    const p = g.project(add(aim, o));
    let off;
    if (p.behind) { g.input.addMouse(60, 0); off = Infinity; } else {
      const ex = p.x - window.innerWidth / 2, ey = p.y - window.innerHeight / 2;
      g.input.addMouse(ex * 0.2, ey * 0.2);
      off = Math.hypot(ex, ey);
    }
    const st = self.state;
    return {
      off, label, near, detour, mode: v.mode, aimDist: len(aim), padDist: len(pad), centreDist: len(C), R,
      speed: st.mode === 1 ? st.cruiseSpeed : len(self.vel), surface: v.surface ? v.surface.body : null,
    };
  };

  const KEYS = ['thrustRight', 'thrustLeft', 'thrustUp', 'thrustDown', 'thrustForward', 'thrustBack', 'rollLeft', 'rollRight'];
  const press = (k, on) => { if (on) g.input.held.add(k); else g.input.held.delete(k); };
  const release = () => { for (const k of KEYS) g.input.held.delete(k); };

  /**
   * Sets the controller (null stops it). Fields of `p`: `site` and `off` compute `target` as the point
   * `off` metres from the pad of that base on the ship's side; `target` is a body-fixed point to hold
   * position over; `land` descends to the ground; `alt` holds a height; `sink` descends at that speed
   * without care; `liftoff` presses thrust up while landed; `vcap` caps the speed over the ground.
   */
  L.setServo = (p) => {
    if (p && p.site !== undefined) {
      const v = g.view;
      const site = v.sites.find((s) => s.def.id === p.site);
      const pad = site.def.ground.pos;
      const ship = v.surface.ship.pos;
      const up = unit(pad);
      let d = sub(ship, pad);
      d = sub(d, scale(up, dot(d, up)));
      if (len(d) < 1) d = cross(up, [0, 1, 0]);
      p = { ...p, target: add(pad, scale(unit(d), p.off ?? 350)) };
    }
    L.servo = p;
    L.rec = { minVs: 0, gs: 0 };
    if (!p) release();
  };

  /** The numbers of the ship over the ground, and how far it is from the controller's target. */
  L.status = () => {
    const v = g.view;
    const ship = v?.surface?.ship;
    if (!v || !v.self || !ship) return null;
    let hdist = null;
    const p = L.servo;
    if (p?.target) {
      const e = sub(p.target, ship.pos);
      const up = unit(ship.pos);
      hdist = len(sub(e, scale(up, dot(e, up))));
    }
    return {
      mode: v.mode, height: ship.height, vs: ship.verticalSpeed, gs: ship.groundSpeed, slope: ship.slope, landed: ship.landed,
      hull: v.self.state.hull, hullMax: v.self.stats.hullMax, hdist, pos: ship.pos, minVs: L.rec.minVs, recGs: L.rec.gs, last: L.last, err: L.err, dbg: L.dbg,
    };
  };

  L.tick = () => {
    const p = L.servo;
    const v = g.view;
    const ship = v?.surface?.ship;
    if (!p || !v || !v.self || !ship || (v.mode !== 0 && v.mode !== MODE_LANDED)) {
      if (L.active) { release(); L.active = false; }
      return;
    }
    L.active = true;
    if (ship.height < 400) {
      if (ship.verticalSpeed < L.rec.minVs) { L.rec.minVs = ship.verticalSpeed; L.rec.gs = ship.groundSpeed; }
      L.last = { pos: ship.pos, height: ship.height, vs: ship.verticalSpeed, gs: ship.groundSpeed, hull: v.self.state.hull };
    }
    if (v.mode === MODE_LANDED) {
      release();
      if (p.liftoff) press('thrustUp', true);
      return;
    }
    const self = v.self;
    const st = self.state;
    const up = ship.up;
    // Level: pitch through the aim buffer (the part still pending is counted), roll through the keys.
    const eL = qun(self.rot, cross(qrot(self.rot, [0, 1, 0]), up));
    const pending = (st.aim ? st.aim[1] : 0) + g.input.aimY;
    const want = 0.7 * eL[0];
    if (Math.abs(want - pending) > 0.004) g.input.aimY += want - pending;
    const diff = clamp(1.5 * eL[2], -1.2, 1.2) - st.angVel[2];
    press('rollLeft', diff > 0.1);
    press('rollRight', diff < -0.1);
    // Velocity: toward the target over the ground, and along the vertical.
    const rot = v.surface.rot;
    const upBF = unit(ship.pos);
    let vdes = [0, 0, 0];
    let hdist = 0;
    if (p.target) {
      const e = sub(p.target, ship.pos);
      const eh = sub(e, scale(upBF, dot(e, upBF)));
      hdist = len(eh);
      vdes = scale(qrot(rot, scale(eh, 1 / (hdist || 1))), Math.min(p.vcap ?? 100, 0.08 * hdist));
    }
    const h = ship.height;
    let vu;
    if (p.sink != null) vu = -p.sink;
    else if (p.land) vu = hdist < 150 + 0.5 * h ? -clamp(0.06 * h, 1.8, 60) : 0;
    else vu = clamp(0.25 * ((p.alt ?? 0) - h), -30, 30);
    vdes = add(vdes, scale(up, vu));
    const el = qun(self.rot, sub(vdes, self.vel));
    const db = 0.4;
    press('thrustRight', el[0] > db);
    press('thrustLeft', el[0] < -db);
    press('thrustUp', el[1] > db);
    press('thrustDown', el[1] < -db);
    press('thrustForward', el[2] < -db);
    press('thrustBack', el[2] > db);
    L.dbg = { eL: eL.map((x) => +x.toFixed(3)), el: el.map((x) => +x.toFixed(2)), vdes: vdes.map((x) => +x.toFixed(1)), vel: self.vel.map((x) => +x.toFixed(1)), held: [...g.input.held].join(','), active: g.input.active(), fa: st.fa, pips: st.pips };
  };
  setInterval(() => { try { L.tick(); } catch (e) { L.err = String((e && e.stack) || e); } }, 20);

  // Frame times, for the frame rate of a descent.
  L.fpsStart = () => {
    L.frames = [];
    L.fpsOn = true;
    let last = performance.now();
    const f = (t) => { if (!L.fpsOn) return; L.frames.push(t - last); last = t; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  };
  L.fpsStop = () => { L.fpsOn = false; return L.frames; };
}

/** Minimum (over one-second windows) and median (over frames) frame rate of a list of frame times in ms. */
function frameRates(frames) {
  const fps = frames.filter((d) => d > 0).map((d) => 1000 / d).sort((a, b) => a - b);
  let min = Infinity, acc = 0, n = 0;
  for (const d of frames) {
    acc += d; n++;
    if (acc >= 1000) { min = Math.min(min, (n * 1000) / acc); acc = 0; n = 0; }
  }
  return { frames: frames.length, seconds: frames.reduce((a, b) => a + b, 0) / 1000, min: Number.isFinite(min) ? min : null, median: fps.length ? fps[Math.floor(fps.length / 2)] : null };
}

async function landing(browser, problems, steps, findings) {
  const log = (msg) => console.log(`landing: ${msg}`);
  const REMOTE = process.env.PRIMACY2_LANDING_REMOTE === '1';  // tests the search for a base in another system
  const stamp = Date.now() % 100000;

  /** A new pilot in a fresh browser context, with the landing tools installed. */
  const newPilot = async (who, name) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror (${who}): ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console (${who}): ${m.text()}`); });
    await page.addInitScript(() => {
      // The pilots play in German: every English word on the screen is then a missed translation.
      try { localStorage.setItem('primacy2.settings', JSON.stringify({ lang: 'de' })); } catch { /* no storage: English */ }
      window.__events = [];
      const watch = () => {
        const ev = window.primacy2?.game?.view?.events;
        if (ev && ev !== window.__last) { window.__last = ev; for (const e of ev) if (e.e !== 'cruise') window.__events.push(JSON.stringify(e).slice(0, 160)); window.__events.splice(0, Math.max(0, window.__events.length - 40)); }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.start-card', { timeout: 20_000 });
    await login(page, name);
    await page.waitForTimeout(800);
    await page.evaluate(installLandingTools);
    const P = { who, name, ctx, page, log: (m) => log(`${who}: ${m}`) };
    P.shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); steps.push(n); };
    P.dump = () => page.evaluate(() => {
      const v = window.primacy2.game.view;
      const s = window.__L?.status();
      return { mode: v?.mode, system: v?.system.id, surface: s ? { ...s, pos: undefined, last: undefined } : null, events: (window.__events ?? []).slice(-8) };
    }).catch(() => null);
    P.fail = async (what) => {
      await page.screenshot({ path: `${OUT}/landing-failure-${who}.png` }).catch(() => {});
      throw new Error(`${who}: ${what} (${JSON.stringify(await P.dump())})`);
    };
    P.check = (ok, fact, problem) => { if (ok) P.log(`ok: ${fact}`); else problems.push(`landing (${who}): ${problem ?? `NOT ${fact}`}`); };
    P.status = () => page.evaluate(() => window.__L.status());
    /** The ground instruments of the HUD as the pilot reads them: label and number of each cell, plus all HUD text for the language check. */
    P.hud = () => page.evaluate(() => ({
      cells: [...document.querySelectorAll('.ground-cell')].map((c) => ({ label: c.querySelector('.label')?.textContent ?? '', num: c.querySelector('.num')?.textContent ?? '' })),
      mode: document.querySelector('.hud-centre .mode')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
      text: [...document.querySelectorAll('.hud-block, .notices, .prompt')].map((n) => n.innerText).join(' | '),
    })).catch(() => null);
    /** English words of the interface that must not show while the language is German. */
    /** Turns the nose sideways until the base is in the middle of the view, so that a screenshot shows it (the controller does not steer yaw). */
    P.lookAtBase = async (siteId) => {
      for (let i = 0; i < 40; i++) {
        const ex = await page.evaluate((id) => {
          const g = window.primacy2.game;
          const site = g.view?.sites.find((s) => s.def.id === id);
          if (!site) return 0;
          const p = g.project(site.rel);
          if (p.behind) { g.input.addMouse(60, 0); return Infinity; }
          const dx = p.x - window.innerWidth / 2;
          g.input.addMouse(dx * 0.2, 0);
          return dx;
        }, siteId);
        if (Math.abs(ex) < 30) break;
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(400);
    };
    P.english = (text) => (text.match(/HEIGHT ABOVE GROUND|SINK RATE|GROUND SPEED|Cruise ended|Press [A-Z] to|LANDED|SHIELD|HULL|FUEL|ENERGY/g) ?? []);
    /** Polls the controller's numbers every 100 ms until `done` says so; logs progress now and then. */
    P.until = async (what, done, timeoutMs, every = 15_000) => {
      const t0 = Date.now();
      let lastLog = t0;
      for (;;) {
        const s = await P.status();
        if (!s) await P.fail(`lost the ship while ${what}`);
        if (s.err) await P.fail(`the controller failed while ${what}: ${s.err}`);
        if (s.mode === MODE.destroyed) return s;
        if (done(s)) return s;
        if (Date.now() - t0 > timeoutMs) await P.fail(`timeout while ${what}`);
        if (Date.now() - lastLog > every) {
          lastLog = Date.now();
          P.log(`${what}: height ${s.height.toFixed(1)} m, vertical ${s.vs.toFixed(1)} m/s, ground ${s.gs.toFixed(1)} m/s, off target ${s.hdist === null ? '-' : s.hdist.toFixed(0)} m ${process.env.PRIMACY2_DEBUG ? JSON.stringify(s.dbg) : ''}`);
        }
        await page.waitForTimeout(100);
      }
    };
    return P;
  };

  const baseOf = (page) => page.evaluate(() => {
    const s = window.primacy2.game.view.sites.find((x) => x.def.kind === 'base');
    return s ? { id: s.def.id, name: s.def.name, body: s.def.ground.body, dist: s.dist } : null;
  });

  /**
   * Undock, find a base (here, else in the nearest system in range that has one, jumping there) and
   * fly to it in cruise until the drive ends cruise at the ceiling above the ground. Returns the base.
   */
  const flyToBase = async (P, orbitShot) => {
    const { page } = P;
    await undock(page);
    await flyOutOf(page);
    let base = REMOTE ? null : await baseOf(page);
    if (!base) {
      await page.evaluate(() => window.primacy2.game.cmd({ k: 'galaxy' }));
      await page.waitForFunction(() => (window.primacy2.game.view?.galaxy?.sectors.length ?? 0) > 0, null, { timeout: 8000 });
      const route = await page.evaluate(() => {
        const v = window.primacy2.game.view;
        const range = v.self.stats.jumpRange;
        const all = v.galaxy.sectors.flatMap((sec) => sec.systems.map((sys) => ({ id: sys.id, name: sys.name, pos: sys.pos, tags: sys.tags ?? [] })));
        const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
        const start = all.find((x) => x.id === v.system.id);
        // Breadth first over the systems in range, so that the system with a base that takes the fewest jumps wins.
        const prev = new Map([[start.id, null]]);
        const queue = [start];
        let goal = null;
        while (queue.length && !goal) {
          const a = queue.shift();
          for (const b of all) {
            if (prev.has(b.id) || dist(a, b) > range) continue;
            prev.set(b.id, a);
            if (b.tags.includes('base')) { goal = b; break; }
            queue.push(b);
          }
        }
        const hops = [];
        for (let x = goal; x && prev.get(x.id); x = prev.get(x.id)) hops.unshift({ id: x.id, name: x.name });
        return { range, hops };
      });
      if (!route.hops.length) throw new Error(`${P.who}: no other system with a ground base within the drive range of ${route.range} ly`);
      P.log(`no base here; jumping ${route.hops.map((h) => h.name).join(' -> ')}`);
      await foldHops({ page, shot: P.shot, log: P.log, fail: P.fail, problems, who: `landing (${P.who})` }, route.hops, null);
      base = await baseOf(page);
      if (!base) await P.fail('the system with the base tag has no base site');
    }
    P.log(`base ${base.name} (site ${base.id}) on body ${base.body}, ${(base.dist / 1000).toFixed(0)} km away`);
    await page.evaluate((id) => window.primacy2.game.setNav(id), base.id);

    const held = {};
    let phase = 'transfer';
    let everCruise = false;
    let lastEngage = 0;
    let lastLog = 0;
    let shotDone = false;
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 20 * 60_000) await P.fail('the base was not reached in cruise in time');
      const s = await page.evaluate(([id, ph]) => window.__L.cruiseAim(id, ph), [base.id, phase]);
      if (!s) {
        const d = await P.dump();
        if (d?.mode === MODE.destroyed) throw new ShipLost(`${P.who}: the ship was lost on the way to the base`);
        await P.fail('lost sight of the base');
      }
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        P.log(`${phase}: ${JSON.stringify({ aim: s.label, aimKm: Math.round(s.aimDist / 1000), centreKm: Math.round(s.centreDist / 1000), speedKms: +(s.speed / 1000).toFixed(1), off: Math.round(s.off), detour: s.detour, mode: s.mode })}`);
      }
      if (s.mode === MODE.cruise) {
        everCruise = true;
        const aligned = s.off < 140;
        let want = null;
        if (phase === 'transfer') {
          // Slow down toward a waypoint: about an eighth of the distance per second at most.
          const ceiling = Math.max(s.aimDist / 8, 45_000);
          if (aligned && s.speed < ceiling * 0.5) want = 'KeyW';
          else if (s.speed > ceiling) want = 'KeyS';
        } else if (aligned) {
          want = 'KeyW';  // the drive's own limit above the ground does the slowing
        } else if (s.speed > 20_000) {
          want = 'KeyS';
        }
        await throttleKeys(page, held, want);
        if (phase === 'transfer' && s.near) { phase = 'dive'; P.log(`above the pad at ${Math.round(s.centreDist / 1000)} km from the centre, diving at it`); }
        if (!shotDone && s.centreDist < 6 * s.R) { shotDone = true; await P.shot(orbitShot); }
      } else if (s.mode === MODE.normal) {
        if (everCruise && s.surface === base.body) break;  // the drive ended cruise at the ceiling
        if (Date.now() - lastEngage > 9000) {
          lastEngage = Date.now();
          await throttleKeys(page, held, null);
          await page.evaluate(() => window.primacy2.game.toggleCruise());
          await page.waitForTimeout(5500);
          continue;
        }
      } else if (s.mode === MODE.destroyed) {
        throw new ShipLost(`${P.who}: the ship was lost on the way to the base`);
      }
      await page.waitForTimeout(80);
    }
    await throttleKeys(page, held, null);
    // What the pilot saw at the drop: the notice only stays on the screen for a few seconds. Then hold the ship still.
    P.dropNotice = '';
    for (let i = 0; i < 20 && !/reiseflug beendet|cruise ended/i.test(P.dropNotice); i++) {
      P.dropNotice = await page.$eval('.notices', (n) => n.innerText).catch(() => '');
      if (!/reiseflug beendet|cruise ended/i.test(P.dropNotice)) await page.waitForTimeout(50);
    }
    P.drop = await P.status();
    // The throttle setpoint of cruise carries over into normal flight, where flight assist flies the ship
    // forward at that fraction of its top speed, here at the ground (see the report). Hold still instead.
    P.dropThrottle = await page.evaluate((h) => {
      const g = window.primacy2.game;
      const t = g.input.throttle;
      g.input.throttle = 0;
      window.__L.setServo({ alt: h, vcap: 0 });
      return t;
    }, Math.max(P.drop.height, 50));
    P.log(`dropped at the ceiling with the throttle setpoint at ${P.dropThrottle.toFixed(2)}, ${P.drop.vs.toFixed(0)} m/s vertical`);
    return base;
  };

  // ---- the pilots ---------------------------------------------------------------------------
  const A = await newPilot('lander', `Lander ${stamp}`);
  const B = await newPilot('crasher', `Crasher ${stamp}`);
  let rates = null;
  try {
    // Both fly to the ground at the same time; the second waits above it until the first has landed.
    const [baseA, baseB] = await Promise.all([flyToBase(A, '40-landing-orbit'), flyToBase(B, '40b-landing-orbit-crasher')]);
    if (baseA.id !== baseB.id) problems.push(`landing: the pilots found different bases (${baseA.id} and ${baseB.id})`);
    const base = baseA;

    // 2. The drop: cruise ended by the game at the ceiling, with its notice.
    const drop = A.drop;
    const notice = A.dropNotice;
    A.log(`dropped at the ceiling: height ${drop.height.toFixed(0)} m, vertical ${drop.vs.toFixed(1)} m/s, ground ${drop.gs.toFixed(1)} m/s, notice ${JSON.stringify(notice.replace(/\s+/g, ' ').trim())}`);
    A.check(drop.mode === MODE.normal && !drop.landed, 'cruise ended in normal flight over the ground', `after the drop the mode should be normal flight, got ${drop.mode}`);
    A.check(/reiseflug beendet/i.test(notice), 'the HUD says in German that the cruise ended at the ceiling', `no German cruise-ended notice after the drop, notices: ${JSON.stringify(notice)}`);
    {
      const hud = await A.hud();
      const height = hud?.cells.find((c) => /HÖHE ÜBER GRUND/.test(c.label));
      A.check(!!height && /\d/.test(height.num), `the HUD shows the height above ground after the drop (${JSON.stringify(height)}; HUD cells ${JSON.stringify(hud?.cells.map((c) => c.label))})`, `no HÖHE ÜBER GRUND cell with a number after the drop: ${JSON.stringify(hud)}`);
      A.check(A.english(hud?.text ?? '').length === 0, 'no English HUD words after the drop', `English words on a German HUD after the drop: ${JSON.stringify(A.english(hud?.text ?? ''))}`);
    }
    A.check(drop.height > 500, `the drop is high above the ground (${drop.height.toFixed(0)} m)`, `the drop should be well above the ground, height ${drop.height}`);
    await A.shot('41-landing-after-drop');
    await B.shot('41b-landing-after-drop-crasher');
    // Both pilots hold still where the drive dropped them; the crasher stays there until it is needed.

    // 3. Descent: the pilot's controller holds the ship level and flies it to a point 350 m beside the pad.
    const hullBefore = drop.hull;
    await A.page.evaluate(() => window.__L.fpsStart());
    await A.page.evaluate((id) => window.__L.setServo({ site: id, off: 350, land: true }), base.id);
    let shotMid = false;
    let shot300 = false, shot300Pending = null, hud300 = null;
    const landedState = await A.until('descending', (s) => {
      if (!shotMid && s.height < 1500) { shotMid = true; A.shot('42-landing-descent').catch(() => {}); }
      if (!shot300 && s.height < 320 && s.height > 5) { shot300 = true; shot300Pending = A.shot('42b-landing-300m').then(() => A.hud()).then((h) => { hud300 = h; }).catch(() => {}); }
      return s.mode === MODE_LANDED;
    }, 8 * 60_000);
    const frames = await A.page.evaluate(() => window.__L.fpsStop());
    await shot300Pending;
    A.check(shot300, 'the descent passed 300 m and was photographed there', 'the descent never showed a height under 320 m');
    {
      const cell = hud300?.cells.find((c) => /HÖHE ÜBER GRUND/.test(c.label));
      A.check(!!cell && /\d/.test(cell.num) && hud300.cells.some((c) => /SINKRATE/.test(c.label)) && hud300.cells.some((c) => /FAHRT ÜBER GRUND/.test(c.label)), `at 300 m the HUD shows height, sink rate and ground speed (${JSON.stringify(hud300?.cells)})`, `the HUD at 300 m lacks height, sink rate or ground speed: ${JSON.stringify(hud300)}`);
      A.check(A.english(hud300?.text ?? '').length === 0, 'no English HUD words at 300 m', `English words on a German HUD at 300 m: ${JSON.stringify(A.english(hud300?.text ?? ''))}`);
    }
    rates = frameRates(frames);
    if (landedState.mode === MODE.destroyed) await A.fail('the lander was destroyed');
    await A.page.evaluate(() => window.__L.setServo({ liftoff: false }));
    await A.page.waitForTimeout(500);
    const landedNow = await A.page.evaluate(() => {
      const v = window.primacy2.game.view;
      const sh = v.surface?.ship;
      return { mode: v.mode, landed: sh?.landed, hull: v.self.state.hull, hullMax: v.self.stats.hullMax, vs: sh?.verticalSpeed, gs: sh?.groundSpeed, slope: sh?.slope, height: sh?.height, pos: sh?.pos };
    });
    A.log(`landed: ${JSON.stringify({ ...landedNow, pos: undefined })}`);
    A.check(landedNow.mode === MODE_LANDED && landedNow.landed === true, 'the client reports the ship landed (mode 5, surface.ship.landed)', `the ship should be landed, got ${JSON.stringify({ ...landedNow, pos: undefined })}`);
    A.check(landedNow.hull === hullBefore && landedNow.hull === landedNow.hullMax, `the hull took no damage (${landedNow.hull} of ${landedNow.hullMax})`, `the hull changed on the way down: ${hullBefore} before, ${landedNow.hull} landed, maximum ${landedNow.hullMax}`);
    A.check(Math.abs(landedNow.height) < 1e-3 && Math.abs(landedNow.vs) < 0.01 && landedNow.gs < 0.05, 'landed means height 0 and no speed over the ground', `a landed ship should have height 0 and no speed, got ${JSON.stringify({ ...landedNow, pos: undefined })}`);
    const pad = await A.page.evaluate((id) => window.primacy2.game.view.sites.find((s) => s.def.id === id).def.ground.pos, base.id);
    const distPad = (p) => Math.hypot(p[0] - pad[0], p[1] - pad[1], p[2] - pad[2]);
    A.check(distPad(landedNow.pos) < 700, `it stands ${distPad(landedNow.pos).toFixed(0)} m from the pad centre`, `the ship should stand within 700 m of the pad, got ${distPad(landedNow.pos)} m`);
    {
      const hud = await A.hud();
      A.check(/GELANDET/i.test(hud?.mode ?? ''), `the HUD says landed in German (${JSON.stringify(hud?.mode)})`, `the HUD mode line should say GELANDET, got ${JSON.stringify(hud?.mode)}`);
      A.check(A.english(hud?.text ?? '').length === 0, 'no English HUD words while landed', `English words on a German HUD while landed: ${JSON.stringify(A.english(hud?.text ?? ''))}`);
    }
    await A.lookAtBase(base.id);
    await A.shot('43-landed-cockpit');
    await A.page.keyboard.press('KeyV');
    await A.page.waitForTimeout(900);
    await A.shot('44-landed-chase');
    await A.page.keyboard.press('KeyV');
    await A.page.waitForTimeout(500);

    // 4. Thirty seconds on the ground: the ship does not move relative to the base.
    const posAt = () => A.page.evaluate(() => { const v = window.primacy2.game.view; return { pos: v.surface?.ship.pos, mode: v.mode, hull: v.self?.state.hull }; });
    const p0 = await posAt();
    let drift = 0;
    for (let i = 0; i < 6; i++) {
      await A.page.waitForTimeout(5000);
      const p = await posAt();
      drift = Math.max(drift, Math.hypot(p.pos[0] - p0.pos[0], p.pos[1] - p0.pos[1], p.pos[2] - p0.pos[2]));
      if (p.mode !== MODE_LANDED || p.hull !== p0.hull) { drift = Infinity; break; }
    }
    A.check(drift < 0.01, `30 s on the ground: the ship moved ${drift.toExponential(1)} m in the body-fixed frame and stayed landed`, `the landed ship moved ${drift} m (or left the landed state) in 30 s`);
    await A.shot('45-landed-30s');

    // 6. The second pilot crashes on purpose, 150 m from the lander, while the lander watches.
    const crash = await (async () => {
      await B.page.evaluate((p) => {
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const n = Math.hypot(...p);
        const up = p.map((x) => x / n);
        let t = cross(up, [0, 1, 0]);
        if (Math.hypot(...t) < 1e-3) t = cross(up, [1, 0, 0]);
        const tl = Math.hypot(...t);
        window.__crashTarget = [p[0] + (t[0] / tl) * 150, p[1] + (t[1] / tl) * 150, p[2] + (t[2] / tl) * 150];
        window.__L.setServo({ target: window.__crashTarget, alt: 600, vcap: 100 });
      }, landedNow.pos);
      await B.until('crasher moving over the lander', (s) => s.hdist !== null && s.hdist < 20 && Math.abs(s.height - 600) < 25 && s.gs < 3, 6 * 60_000);
      const hullFull = (await B.status()).hull;
      // First a hard landing the ship survives: 18 m/s down.
      await B.page.evaluate(() => window.__L.setServo({ target: window.__crashTarget, sink: 18, vcap: 100 }));
      await B.until('crasher diving', (s) => s.hull < hullFull || s.mode === MODE_LANDED, 90_000, 5000);
      await B.page.waitForTimeout(1500);
      const hit1 = await B.status();
      const sink = -hit1.minVs;
      const side = hit1.recGs;
      const over = Math.hypot(Math.max(0, sink - 6), Math.max(0, side - 8));
      const predicted = 0.25 * Math.pow(over / 10, 1.5);
      const lost = (hullFull - hit1.hull) / hit1.hullMax;
      B.log(`hard landing: approach ${sink.toFixed(1)} m/s down, ${side.toFixed(1)} m/s along; excess ${over.toFixed(1)} m/s; the rule says ${(predicted * 100).toFixed(0)}% of the hull for a stock Wisp, the hull lost ${(lost * 100).toFixed(1)}% (${hullFull} -> ${hit1.hull} of ${hit1.hullMax})`);
      B.check(hit1.hull < hullFull && hit1.mode !== MODE.destroyed, `the 18 m/s landing damaged the hull (${hullFull} -> ${hit1.hull}) and the ship survived`, `an 18 m/s landing should damage the hull of a stock ship without destroying it: ${JSON.stringify({ hullFull, hit1: { ...hit1, pos: undefined, last: undefined } })}`);
      B.check(lost > predicted * 0.5 && lost < predicted * 1.6, `the loss (${(lost * 100).toFixed(1)}%) is within 0.5x to 1.6x of the rule's ${(predicted * 100).toFixed(1)}%`, `the hull loss ${(lost * 100).toFixed(1)}% does not fit the rule's ${(predicted * 100).toFixed(1)}% for an excess of ${over.toFixed(1)} m/s`);
      await B.shot('50-hard-landing-damaged');

      // Then up again and straight down at 70 m/s: that destroys the ship.
      await B.page.evaluate(() => window.__L.setServo({ target: window.__crashTarget, alt: 600, vcap: 100, liftoff: true }));
      await B.until('crasher climbing', (s) => s.mode === MODE.normal && Math.abs(s.height - 600) < 25 && s.gs < 3 && s.hdist < 20, 4 * 60_000);
      await B.page.evaluate(() => window.__L.setServo({ target: window.__crashTarget, sink: 70, vcap: 100 }));
      const t0 = Date.now();
      for (;;) {
        const d = await B.page.evaluate(() => ({ mode: window.primacy2.game.view?.mode, self: window.primacy2.game.view?.self != null }));
        if (d.mode === MODE.destroyed || !d.self) break;
        if (Date.now() - t0 > 90_000) await B.fail('the 70 m/s dive did not end the ship');
        await B.page.waitForTimeout(50);
      }
      const gone = await B.page.evaluate(() => ({ mode: window.primacy2.game.view?.mode, last: window.__L.last, fastest: -window.__L.rec.minVs }));
      await B.page.waitForTimeout(600);
      const crashNotice = await B.page.$eval('.notices', (n) => n.innerText).catch(() => '');
      B.log(`destroyed: last seen ${JSON.stringify({ ...gone.last, pos: undefined })}; notices ${JSON.stringify(crashNotice.replace(/\s+/g, ' ').trim().slice(0, 120))}`);
      await B.shot('51-crash-destroyed');
      B.check(gone.mode === MODE.destroyed, 'the 70 m/s dive destroyed the ship (mode 4)', `the ship should be destroyed, mode ${gone.mode}`);
      B.check(gone.fastest > 40, `it was descending at ${gone.fastest.toFixed(0)} m/s before it hit the ground`, `the crasher was not diving: fastest descent ${gone.fastest} m/s`);
      return gone.last;
    })();

    // The wreck is listed in the lander's contacts where the ship hit.
    await A.page.waitForFunction(() => window.primacy2.game.view?.ents.some((e) => e.info.kind === 6), null, { timeout: 15_000 }).catch(() => {});
    const wreck = await A.page.evaluate(() => {
      const v = window.primacy2.game.view;
      const w = v.ents.filter((e) => e.info.kind === 6).sort((p, q) => Math.hypot(...p.rel) - Math.hypot(...q.rel));
      if (!w.length || !v.surface?.ship) return null;
      // The wreck relative to the lander's ship in system axes, turned into body-fixed axes by the inverse body rotation.
      const rel = [w[0].rel[0] - v.self.rel[0], w[0].rel[1] - v.self.rel[1], w[0].rel[2] - v.self.rel[2]];
      const bf = window.__L.qun(v.surface.rot, rel);
      const p = v.surface.ship.pos;
      return { count: w.length, pos: [p[0] + bf[0], p[1] + bf[1], p[2] + bf[2]] };
    });
    if (!wreck) problems.push('landing (lander): the lander sees no wreck after the crash');
    else {
      const d = Math.hypot(wreck.pos[0] - crash.pos[0], wreck.pos[1] - crash.pos[1], wreck.pos[2] - crash.pos[2]);
      A.check(d < 80, `a wreck is listed ${d.toFixed(0)} m from where the crasher last was (${wreck.count} wreck(s) in view)`, `the wreck is ${d.toFixed(0)} m from the crash point, expected within 80 m`);
    }
    await A.shot('52-wreck-seen-from-lander');

    // 5. Lift off, fly to the pad, dock, market, undock.
    await A.page.evaluate((id) => window.__L.setServo({ site: id, off: 170, alt: 40, liftoff: true, vcap: 60 }), base.id);
    const lifted = await A.until('lifting off', (s) => s.mode === MODE.normal && s.height > 5, 30_000, 5000);
    A.check(lifted.mode === MODE.normal && !lifted.landed, `thrust up lifts the ship off (height ${lifted.height.toFixed(1)} m)`, `the ship did not lift off: ${JSON.stringify({ ...lifted, pos: undefined, last: undefined })}`);
    await A.shot('46-liftoff');
    await A.until('flying to the pad', (s) => s.hdist !== null && s.hdist < 25 && Math.abs(s.height - 40) < 15 && s.gs < 4, 4 * 60_000);
    await A.lookAtBase(base.id);
    await A.shot('47-at-the-pad');
    const nearPad = await A.page.evaluate(() => window.primacy2.game.view.surface.ship.pos);
    A.log(`at the pad: ${distPad(nearPad).toFixed(0)} m from its centre`);
    const prompt = await A.page.$eval('.prompt', (n) => n.innerText).catch(() => '');
    A.check(/dock/i.test(prompt), `the HUD offers docking at the pad (${JSON.stringify(prompt.trim())})`, `no dock prompt at the pad: ${JSON.stringify(prompt)}`);
    await A.page.evaluate(() => window.__L.setServo(null));
    const docked = await A.page.evaluate(() => window.primacy2.game.cmd({ k: 'dock' }));
    A.check(docked.ok === true, 'the dock command is accepted at the base', `docking at the base was refused: ${JSON.stringify(docked)}`);
    await A.page.waitForFunction(() => window.primacy2.game.view?.mode === 3, null, { timeout: 10_000 }).catch(() => A.fail('the ship did not dock at the base'));
    await A.page.waitForSelector('.panel.wide .scroll > table tbody tr', { timeout: 10_000 }).catch(() => A.fail('the market of the base did not open'));
    await A.page.waitForTimeout(1000);
    const headText = await A.page.$eval('.panel.wide header', (n) => n.innerText).catch(() => '');
    const rows = await A.page.$$eval('.panel.wide .scroll > table tbody tr:not(.lots)', (rs) => rs.length);
    A.check(headText.toLowerCase().includes(base.name.toLowerCase()) && rows > 0, `docked: the panel is headed ${JSON.stringify(headText.replace(/\s+/g, ' ').trim().slice(0, 60))} and the market lists ${rows} goods`, `the base panel should name ${base.name} and list goods: ${JSON.stringify(headText)}, ${rows} rows`);
    await A.shot('48-docked-at-base');
    await A.page.click('.panel header button.primary');
    await A.page.waitForFunction(() => window.primacy2.game.view?.mode === 0, null, { timeout: 10_000 }).catch(() => A.fail('the ship did not undock at the base'));
    await A.page.waitForTimeout(1500);
    const out = await A.page.evaluate(() => { const v = window.primacy2.game.view; return { pos: v.surface?.ship.pos, height: v.surface?.ship.height }; });
    A.check(out.pos && Math.abs(distPad(out.pos) - 750) < 250, `undocked ${out.pos ? distPad(out.pos).toFixed(0) : '?'} m from the pad centre`, `an undocked ship should be about 750 m from the pad, got ${out.pos ? distPad(out.pos) : null}`);
    await A.shot('49-undocked-at-base');
  } finally {
    await A.page.evaluate(() => window.__L?.setServo(null)).catch(() => {});
    await B.page.evaluate(() => window.__L?.setServo(null)).catch(() => {});
    await A.ctx.close().catch(() => {});
    await B.ctx.close().catch(() => {});
  }

  // 7. The frame rate of the descent.
  if (rates) {
    log(`frame rate during the descent (${rates.frames} frames in ${rates.seconds.toFixed(0)} s, a second pilot rendering at the same time): minimum ${rates.min?.toFixed(1)} fps over a second, median ${rates.median?.toFixed(1)} fps`);
    if ((rates.min ?? 99) < 30 || (rates.median ?? 99) < 30) findings.push(`frame rate below 30 during the landing descent: minimum ${rates.min?.toFixed(1)}, median ${rates.median?.toFixed(1)} fps`);
  }
}

const problems = [];
const findings = [];
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
  if (!JOURNEY_ONLY && !LANDING_ONLY) {  // the fight, insurance and flight checks; skipped when only the journey is wanted
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
  // The journey runs next, as a new pilot in a fresh browser context.
  if (!LANDING_ONLY) {
    for (let attempt = 1; ; attempt++) {
      try {
        await journey(browser, problems, steps);
        break;
      } catch (err) {
        if (!(err instanceof ShipLost) || attempt >= 4) throw err;
        console.log(`journey: ${err.message}; starting over with a new pilot (attempt ${attempt + 1})`);
      }
    }
  }
  // The landing runs last: two new pilots fly to a ground base.
  if (!JOURNEY_ONLY) {
    for (let attempt = 1; ; attempt++) {
      try {
        await landing(browser, problems, steps, findings);
        break;
      } catch (err) {
        if (!(err instanceof ShipLost) || attempt >= 3) throw err;
        console.log(`landing: ${err.message}; starting over with new pilots (attempt ${attempt + 1})`);
      }
    }
  }
} catch (err) {
  problems.push(`failed after [${steps.join(', ')}]: ${err.message}`);
} finally {
  await browser?.close().catch(() => {});
  stopServers(servers);
}
for (const f of findings) console.log(`finding: ${f}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('e2e ok');
process.exit(0);
