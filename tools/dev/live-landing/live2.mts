/**
 * Live check of landing in the real client: starts one game server in this process (the fixed
 * test identity "Landing", which has a ground base in its capital), opens the built client in
 * headless Chromium, logs a pilot in, moves the ship to the base on the server and then flies it
 * with the page's own keyboard: touch down, stand, dock, undock, lift off. Reads the frame view
 * of the game core at each step and saves screenshots.
 *
 *   npx tsx live.ts <out dir> [port]      (run from the repository root, after `npm run build`)
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startServer } from 'file:///C:/Claude%20Code/LOCAL/primacy2/.claude/worktrees/primacy2-space-simulator-b9a0b8/packages/server/src/server.ts';
import { newShip } from 'file:///C:/Claude%20Code/LOCAL/primacy2/.claude/worktrees/primacy2-space-simulator-b9a0b8/packages/server/src/game.ts';
import {
  FlightMode, anchorFrame, bodySurface, computeShipStats, groundAltitude, groundSiteRotation, newShipState, publicKeyOf, quat, reanchor, sha256Hex, starterLoadout,
  surfaceAnchor, v3, type ShipState, type Vec3,
} from 'file:///C:/Claude%20Code/LOCAL/primacy2/.claude/worktrees/primacy2-space-simulator-b9a0b8/packages/shared/src/index.ts';

const require = createRequire('C:/Claude Code/LOCAL/primacy2/.claude/worktrees/primacy2-space-simulator-b9a0b8/package.json');
const { chromium } = require('playwright') as typeof import('playwright');

const out = process.argv[2] ?? 'live-shots';
const port = Number(process.argv[3] ?? 8431);
mkdirSync(out, { recursive: true });

const secretKey = sha256Hex('primacy2-test:Landing');
const server = await startServer(
  { name: 'Landing', host: '127.0.0.1', port, dataDir: ':memory:', systems: 8 },
  { keys: { secretKey, publicKey: publicKeyOf(secretKey) }, log: () => {} },
);
const world = server.world;
const def = world.defs.get(`${world.id}:0`)!;
const base = def.sites.find((s) => s.kind === 'base')!;
const body = def.bodies[base.ground!.body]!;
const surface = bodySurface(def, body.id)!;
const zone = surfaceAnchor(body.id);
const padRot = groundSiteRotation(base);
const padPoint = (east: number, north: number, up: number): Vec3 => v3.add(base.ground!.pos, quat.rotate(padRot, [east, up, -north]));
console.log(`server ${server.url}: ${def.name}, base ${base.name} on ${body.name} (day ${(body.rotPeriod / 3600).toFixed(1)} h)`);

const problems: string[] = [];
const note = (ok: boolean, what: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) problems.push(what);
};

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

type Probe = {
  mode: number; anchor: number; vel: number; stateVel: number; inCam: Vec3; height: number; vspeed: number; ground: number; landed: boolean;
  camHeight: number; ents: { id: number; flags: number; fromShip: Vec3 }[]; hull: number; zoneRot: number[] | null; prompt: string[]; fromBase: Vec3 | null; selfVel: number[] | null; time: number;
};
/** What the frame view says right now. Positions of entities are relative to the ship, in the body's own axes. */
// Given to the page as text: the bundler of this script must not rewrite it.
const PROBE = `(() => {
  const g = window.primacy2.game;
  const v = g.view;
  if (!v) return null;
  function unrot(q, p) {
    const x = p[0], y = p[1], z = p[2]; const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
  }
  const s = v.surface;
  const self = v.self;
  return {
    mode: v.mode, anchor: self ? self.state.anchor : -1,
    vel: self ? Math.hypot(...self.vel) : -1, stateVel: self ? Math.hypot(...self.state.vel) : -1,
    inCam: self ? unrot(v.camera.rot, self.rel) : [0, 0, 0],
    height: s && s.ship ? s.ship.height : NaN, vspeed: s && s.ship ? s.ship.verticalSpeed : NaN, ground: s && s.ship ? s.ship.groundSpeed : NaN,
    landed: !!(s && s.ship && s.ship.landed), camHeight: s ? s.camHeight : NaN,
    ents: self && s ? v.ents.map((e) => ({ id: e.id, flags: e.flags, fromShip: unrot(s.rot, [e.rel[0] - self.rel[0], e.rel[1] - self.rel[1], e.rel[2] - self.rel[2]]) })) : [],
    hull: self ? self.state.hull / self.stats.hullMax : -1, zoneRot: v.zoneRot,
    fromBase: self && s ? (() => { const b = v.sites.find((x) => x.def.kind === 'base' && x.def.ground.body === s.body); return b ? unrot(s.rot, [self.rel[0] - b.rel[0], self.rel[1] - b.rel[1], self.rel[2] - b.rel[2]]) : null; })() : null,
    selfVel: self ? self.vel.slice() : null, time: v.time,
    prompt: [...document.querySelectorAll('.prompt')].map((el) => el.textContent || ''),
  };
})()`;
const probe = (): Promise<Probe | null> => page.evaluate(PROBE) as Promise<Probe | null>;
const until = (expr: string, ms = 20_000): Promise<boolean> => page.waitForFunction(expr, null, { timeout: ms }).then(() => true, () => false);
const dist = (a: Vec3 | number[], b: Vec3 | number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

try {
  await page.goto(server.url, { waitUntil: 'load' });
  await page.fill('.start-card input', 'Lander');
  await page.click('.start-card button.primary');
  note(await until('window.primacy2?.game?.view?.mode === 3'), 'the pilot is logged in and docked at home');
  await page.evaluate('window.primacy2.game.input.testMode = true');

  const player = [...world.players.values()][0]!;
  const ship = player.ship!;
  const sim = player.sim!;
  // Two more ships at the pad, without pilots: one standing on it, one hovering.
  const mk = (pos: Vec3, landed: boolean): number => {
    const loadout = starterLoadout(landed ? 'drover' : 'lancet');
    const stats = computeShipStats(loadout);
    const st = newShipState(stats);
    Object.assign(st, { anchor: zone, rot: quat.clone(padRot), mode: landed ? FlightMode.Landed : FlightMode.Normal });
    st.pos = landed ? v3.scale(v3.normalize(pos), v3.len(pos) - groundAltitude(surface, pos) + stats.belly) : pos;
    const other = newShip(world.allocId(), landed ? 'Parked' : 'Hover', loadout, stats, st);
    sim.addShip(other);
    return other.id;
  };
  const parkedId = mk(padPoint(160, 60, 0), true);
  const hoverId = mk(padPoint(120, 260, 180), false);

  // From the dock to four metres over the pad, flight assist holding it there. The client is
  // told that it left the station, as the undock command would.
  Object.assign(ship.state, { mode: FlightMode.Normal, anchor: zone, pos: padPoint(220, 0, ship.stats.belly + 4), vel: [0, 0, 0], rot: quat.clone(padRot) });
  player.send({ t: 'station', s: null });
  note(await until('window.primacy2.game.view?.mode === 0 && window.primacy2.game.view.self?.state.anchor === ' + zone), 'the client follows into the surface frame');
  // The first landing is watched from the chase camera, the second one from the cockpit.
  await page.evaluate("window.primacy2.game.setCameraMode('chase')");
  note((await page.evaluate('window.primacy2.game.view.camera.mode')) === 'chase', 'chase camera selected');
  await page.waitForTimeout(1500);
  let p = (await probe())!;
  note(Math.abs(p.height - 4) < 0.5 && p.vel < 0.3 && p.ground < 0.3, `hovering: height ${p.height.toFixed(2)} m, speed in the view ${p.vel.toFixed(3)} m/s, over the ground ${p.ground.toFixed(3)} m/s`);
  note(p.ents.some((e) => e.id === parkedId && (e.flags & 128) !== 0) && p.ents.some((e) => e.id === hoverId && (e.flags & 128) === 0), `sees the parked ship (landed flag) and the hovering one: ${JSON.stringify(p.ents.map((e) => [e.id, e.flags]))}`);
  const parked0 = p.ents.find((e) => e.id === parkedId)!.fromShip;
  await page.screenshot({ path: `${out}/1-hover.png` });

  // Touch down: flight assist off, and the ship falls the four metres.
  await page.keyboard.press('KeyZ');
  const landedOk = await until('window.primacy2.game.view?.mode === 5', 15_000);
  await page.keyboard.press('KeyZ');
  note(landedOk, 'falls four metres with flight assist off and lands (predicted and confirmed)');
  await page.waitForTimeout(1500);
  p = (await probe())!;
  note(p.landed && Math.abs(p.height) < 0.01 && p.vel === 0 && p.hull > 0.999, `landed: height ${p.height.toExponential(2)} m, velocity in the view ${p.vel}, hull ${(p.hull * 100).toFixed(1)} %`);
  note(ship.state.mode === FlightMode.Landed, 'the server has the ship landed too');
  // The view against the server's own numbers (both in the body-fixed axes of the surface frame).
  const truthBase = v3.sub(ship.state.pos, base.ground!.pos);
  note(dist(p.fromBase!, truthBase) < 0.02, `ship relative to the base, from the view turned back into body axes: off the server's vector by ${dist(p.fromBase!, truthBase).toExponential(2)} m (the vector is ${v3.len(truthBase).toFixed(1)} m long)`);
  const truthParked = v3.sub(sim.ships.get(parkedId)!.state.pos, ship.state.pos);
  const seenParked = p.ents.find((e) => e.id === parkedId)!.fromShip;
  note(dist(seenParked, truthParked) < 0.2, `parked ship relative to ours: off the server's vector by ${dist(seenParked, truthParked).toExponential(2)} m (${v3.len(truthParked).toFixed(1)} m apart)`);
  const truthRot = anchorFrame(def, zone, p.time).rot;
  const rotOff = Math.hypot(...p.zoneRot!.map((x, i) => x - truthRot[i]!));
  note(rotOff < 1e-9 && Math.abs(truthRot[3]) < 0.999999, `zoneRot is the rotation of the surface frame at the view's time (off by ${rotOff.toExponential(1)}, w ${truthRot[3].toFixed(4)})`);

  // Stand for twenty seconds: the camera must not move against the ship, the neighbours stay put.
  const first = p;
  let worstCam = 0;
  let worstEnt = 0;
  let contactsLost = 0;
  let worstBase = 0;
  let worstVel = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < Number(process.env.LIVE_STAND_MS ?? 30_000)) {
    const q = (await probe())!;
    worstCam = Math.max(worstCam, dist(q.inCam, first.inCam));
    const e = q.ents.find((x) => x.id === parkedId);
    if (!e) contactsLost++;
    else worstEnt = Math.max(worstEnt, dist(e.fromShip, first.ents.find((x) => x.id === parkedId)!.fromShip));
    if (q.mode !== 5) problems.push(`mode ${q.mode} while standing`);
    worstBase = Math.max(worstBase, dist(q.fromBase!, first.fromBase!));
    worstVel = Math.max(worstVel, Math.hypot(...q.selfVel!));
    await page.waitForTimeout(50);
  }
  note(worstBase < 1e-3 && worstVel === 0 && dist(first.fromBase!, [0, 0, 0]) > 100, `over 30 s the ship stayed ${worstBase.toExponential(2)} m from its place relative to the base in body-fixed axes (it stands ${dist(first.fromBase!, [0, 0, 0]).toFixed(1)} m from the pad centre); largest |self.vel| ${worstVel}`);
  note(worstCam < 1e-3, `steady camera over 30 s: the ship moved ${worstCam.toExponential(2)} m in the camera's axes at most`);
  note(worstEnt < 0.05 && contactsLost === 0, `the parked ship stayed put relative to ours (${worstEnt.toExponential(2)} m), contacts never dropped (${contactsLost} probes without it)`);
  p = (await probe())!;
  note(p.prompt.length > 0, `dock prompt shown while standing on the pad: ${JSON.stringify(p.prompt)}`);
  await page.screenshot({ path: `${out}/2-landed.png` });

  // The same from the cockpit for a few seconds.
  await page.evaluate("window.primacy2.game.setCameraMode('cockpit')");
  await page.waitForTimeout(500);
  const cockpit0 = (await probe())!;
  let worstCockpit = 0;
  for (let i = 0; i < 60; i++) {
    worstCockpit = Math.max(worstCockpit, dist((await probe())!.inCam, cockpit0.inCam));
    await page.waitForTimeout(50);
  }
  note(worstCockpit < 1e-3, `steady in the cockpit too: ${worstCockpit.toExponential(2)} m over 3 s`);
  await page.screenshot({ path: `${out}/2b-landed-cockpit.png` });

  // Dock from the ground, look at the orbiting camera, undock.
  await page.keyboard.press('KeyF');
  note(await until('window.primacy2.game.view?.mode === 3'), 'docks at the base from where it stands');
  await page.waitForTimeout(1200);
  p = (await probe())!;
  note(p.camHeight >= 59.9, `docked camera ${p.camHeight.toFixed(1)} m above the ground`);
  const stationName = (await page.evaluate("document.querySelector('.panel header')?.textContent ?? ''")) as string;
  note(stationName.includes(base.name), `station panel of the base is open: "${stationName.trim().slice(0, 60)}"`);
  await page.screenshot({ path: `${out}/3-docked.png` });
  await page.click('.panel header button.primary');
  note(await until('window.primacy2.game.view?.mode === 0'), 'undocks into normal flight');
  await page.waitForTimeout(1500);
  p = (await probe())!;
  note(p.anchor === zone && p.height > 600 && p.height < 800 && p.vel < 1, `after undocking: ${p.height.toFixed(0)} m over the pad in the surface frame, ${p.vel.toFixed(2)} m/s`);
  await page.screenshot({ path: `${out}/4-undocked.png` });

  // The velocity marker: flying straight ahead under flight assist the ship moves along its nose,
  // so from the cockpit the marker must sit at the reticle. Projected from the raw state velocity
  // (axes of the turning frame) it would be somewhere else.
  await page.evaluate("window.primacy2.game.setCameraMode('cockpit')");
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  const mk2 = (await page.evaluate(`(() => {
    const g = window.primacy2.game; const v = g.view; const el = document.querySelector('.velocity');
    const nums = el ? (el.getAttribute('style') || '').match(/-?[0-9.]+(?=px)/g) : null;
    const m = nums && nums.length >= 2 ? [null, nums[0], nums[1]] : null;
    const speed = Math.hypot(...v.self.state.vel);
    const raw = g.project([v.self.rel[0] + v.self.state.vel[0] * 1000 / speed, v.self.rel[1] + v.self.state.vel[1] * 1000 / speed, v.self.rel[2] + v.self.state.vel[2] * 1000 / speed]);
    return { x: m ? +m[1] : NaN, y: m ? +m[2] : NaN, w: innerWidth, h: innerHeight, speed, viewSpeed: Math.hypot(...v.self.vel), zoneW: v.zoneRot[3], raw: [raw.x, raw.y, raw.behind], anchor: v.self.state.anchor, style: el ? el.getAttribute('style') : 'no element' };
  })()`)) as { x: number; y: number; w: number; h: number; speed: number; viewSpeed: number; zoneW: number; raw: [number, number, boolean]; anchor: number; style: string };
  await page.screenshot({ path: `${out}/4b-velocity-marker.png` });
  await page.keyboard.up('KeyW');
  const offCentre = Math.hypot(mk2.x - mk2.w / 2, mk2.y - mk2.h / 2);
  const rawOff = Math.hypot(mk2.raw[0] - mk2.w / 2, mk2.raw[1] - mk2.h / 2);
  note(mk2.anchor === zone && mk2.speed > 20 && offCentre < 60 && Math.abs(mk2.speed - mk2.viewSpeed) < 1e-6, `velocity marker ${offCentre.toFixed(0)} px from the reticle at ${mk2.speed.toFixed(0)} m/s straight ahead in the surface frame (zoneRot w ${mk2.zoneW.toFixed(3)}); from the raw state velocity it would be ${rawOff.toFixed(0)} px off${mk2.raw[2] ? ', behind the camera' : ''}; style "${mk2.style}"`);
  await page.waitForTimeout(2500);

  // Down again by the server's hand, land, then lift off with the up key.
  Object.assign(ship.state, { mode: FlightMode.Normal, anchor: zone, pos: padPoint(220, 30, ship.stats.belly + 3), vel: [0, 0, 0], rot: quat.clone(padRot) });
  await page.waitForTimeout(800);
  await page.keyboard.press('KeyZ');
  await until('window.primacy2.game.view?.mode === 5', 15_000);
  await page.keyboard.press('KeyZ');
  await page.waitForTimeout(500);
  await page.keyboard.down('Space');
  const lifted = await until('window.primacy2.game.view?.mode === 0', 5000);
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  await page.waitForTimeout(2500);
  p = (await probe())!;
  note(lifted && p.height > 1 && !p.landed && ship.state.mode === FlightMode.Normal, `lifts off on the up key: ${p.height.toFixed(1)} m above the ground, hovering at ${p.vel.toFixed(2)} m/s`);
  const parked1 = p.ents.find((e) => e.id === parkedId);
  note(!!parked1, 'the parked ship is still among the contacts after touchdown and lift-off');
  void parked0;
  await page.screenshot({ path: `${out}/5-liftoff.png` });

  // Through the boundary of the surface frame from above, watched from the chase camera: the
  // ship is put into the non-rotating frame of the body 300 m above the boundary, at rest over
  // the ground but sinking at 150 m/s, flight assist off.
  await page.evaluate("window.primacy2.game.setCameraMode('chase')");
  await page.keyboard.press('KeyZ');
  const high: ShipState = {
    ...ship.state, mode: FlightMode.Normal, anchor: zone, pos: v3.scale(v3.normalize(base.ground!.pos), surface.enter + 300),
    vel: v3.scale(v3.normalize(base.ground!.pos), -150), rot: quat.clone(padRot), angVel: [0, 0, 0],
  };
  reanchor(high, def, body.id, sim.time);
  Object.assign(ship.state, high);
  note(await until('window.primacy2.game.view?.self?.state.anchor === ' + body.id, 5000), `the client follows into the body frame above the boundary (speed there ${v3.len(high.vel).toFixed(0)} m/s in the non-rotating frame)`);
  await page.waitForTimeout(300);
  await page.evaluate(`(() => {
    const g = window.primacy2.game; window.__rec = []; window.__recDone = false; const t0 = performance.now();
    function unrot(q, p) {
      const x = p[0], y = p[1], z = p[2]; const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
    }
    function step() {
      const v = g.view;
      if (v && v.self && v.surface && v.surface.ship) {
        window.__rec.push({
          t: performance.now() - t0, anchor: v.self.state.anchor, height: v.surface.ship.height, ground: v.surface.ship.groundSpeed,
          vs: v.surface.ship.verticalSpeed, inCam: unrot(v.camera.rot, v.self.rel), cam: v.camera.rot.slice(), vel: Math.hypot(...v.self.vel),
          body: Math.hypot(...v.bodies[v.surface.body].rel), zone: v.zoneRot ? v.zoneRot.slice() : null,
        });
      }
      if (performance.now() - t0 < 6000) requestAnimationFrame(step); else window.__recDone = true;
    }
    requestAnimationFrame(step);
  })()`);
  await until('window.__recDone === true', 15_000);
  type Rec = { t: number; anchor: number; height: number; ground: number; vs: number; inCam: number[]; cam: number[]; vel: number; body: number; zone: number[] | null };
  const rec = (await page.evaluate('window.__rec')) as Rec[];
  await page.keyboard.press('KeyZ');
  const cross = rec.findIndex((r) => r.anchor === zone);
  note(cross > 5 && cross < rec.length - 5 && rec[0]!.anchor === body.id, `crossed into the surface frame in sample ${cross} of ${rec.length}`);
  if (cross > 5) {
    const angle = (a: number[], b: number[]): number => 2 * Math.acos(Math.min(1, Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)));
    let jumpCam = 0, jumpRot = 0, jumpHeight = 0, jumpGround = 0, jumpBody = 0, worstStep = 0;
    for (let i = 1; i < rec.length; i++) {
      const a = rec[i - 1]!, b = rec[i]!;
      const dt = (b.t - a.t) / 1000;
      worstStep = Math.max(worstStep, dt);
      jumpCam = Math.max(jumpCam, dist(a.inCam, b.inCam));
      jumpRot = Math.max(jumpRot, angle(a.cam, b.cam));
      // What is left of the change of height after the sink rate is taken out.
      jumpHeight = Math.max(jumpHeight, Math.abs(b.height - a.height - 0.5 * (a.vs + b.vs) * dt));
      jumpGround = Math.max(jumpGround, Math.abs(b.ground - a.ground));
      jumpBody = Math.max(jumpBody, Math.abs(b.body - a.body - 0.5 * (a.vs + b.vs) * dt));
    }
    const before = rec[cross - 1]!, after = rec[cross]!;
    note(jumpCam < 0.05 && jumpRot < 0.01, `chase camera continuous through the crossing: ship moved ${jumpCam.toExponential(2)} m in camera axes between frames at most, camera turned ${jumpRot.toExponential(2)} rad at most`);
    note(jumpHeight < 3 && jumpBody < 3 && jumpGround < 2, `ground data continuous: height off its sink rate by ${jumpHeight.toFixed(3)} m at most, distance to the body centre by ${jumpBody.toFixed(3)} m, ground speed steps ${jumpGround.toFixed(3)} m/s (longest frame ${(worstStep * 1000).toFixed(0)} ms)`);
    note(before.zone !== null && after.zone !== null && Math.abs(before.zone[3]! - 1) < 1e-12 && Math.abs(after.zone[3]! - 1) > 1e-6, `zoneRot: identity in the body frame, the body's rotation in the surface frame (w ${after.zone?.[3]?.toFixed(4)})`);
    console.log(`      speed in the view: ${before.vel.toFixed(1)} m/s in the body frame, ${after.vel.toFixed(1)} m/s in the surface frame; over the ground ${before.ground.toFixed(2)} and ${after.ground.toFixed(2)} m/s, sinking ${(-before.vs).toFixed(1)} and ${(-after.vs).toFixed(1)} m/s`);
  }

  // The cruise-drop prompt with the base as nav target: shown in cruise where normal flight would
  // be in the surface frame of its body (below surface.enter), not shown high above that.
  await page.evaluate('window.primacy2.game.setNav(' + base.id + ')');
  const cruiseAt = async (height: number): Promise<{ prompts: string[]; mode: number; r: number }> => {
    const toSys = anchorFrame(def, zone, sim.time).rot;
    const up = v3.normalize(base.ground!.pos);
    const side = v3.normalize(v3.cross(up, [0.3, 0.9, 0.1]));
    Object.assign(ship.state, {
      mode: FlightMode.Cruise, anchor: body.id, pos: quat.rotate(toSys, v3.scale(up, body.radius + height)), vel: [0, 0, 0], angVel: [0, 0, 0],
      rot: quat.lookRotation(quat.rotate(toSys, side), quat.rotate(toSys, up)), throttle: 0, cruiseSpeed: 300, chargeKind: 0, charge: 0,
    });
    await until('window.primacy2.game.view?.mode === 1', 5000);
    await page.waitForTimeout(700);
    return (await page.evaluate(`(() => { const v = window.primacy2.game.view; return { prompts: [...document.querySelectorAll('.prompt')].map((el) => el.textContent || ''), mode: v.mode, r: v.surface ? Math.hypot(...v.surface.cam) : -1 }; })()`)) as { prompts: string[]; mode: number; r: number };
  };
  const low = await cruiseAt(0.5 * (surface.enter - body.radius));
  await page.screenshot({ path: `${out}/6-cruise-drop-prompt.png` });
  note(low.mode === 1 && low.r < surface.enter && low.prompts.some((x) => /drop out of cruise/i.test(x)), `in cruise ${((low.r - body.radius) / 1000).toFixed(1)} km up (surface frame begins at ${((surface.enter - body.radius) / 1000).toFixed(1)} km) with the base as nav target: prompts ${JSON.stringify(low.prompts)}`);
  await page.keyboard.press('KeyJ');
  note(await until('window.primacy2.game.view?.mode === 0 && window.primacy2.game.view.self?.state.anchor === ' + zone, 5000), 'the cruise key pressed there drops the ship into the surface frame of the body the base stands on');
  const highUp = await cruiseAt(3 * (surface.enter - body.radius));
  note(highUp.mode === 1 && highUp.r > surface.enter && !highUp.prompts.some((x) => /drop out of cruise/i.test(x)), `in cruise ${((highUp.r - body.radius) / 1000).toFixed(1)} km up: prompts ${JSON.stringify(highUp.prompts)}`);
} catch (err) {
  problems.push(`script failed: ${(err as Error).stack ?? err}`);
} finally {
  await browser.close();
  await server.stop();
}
if (problems.length) {
  console.log('PROBLEMS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('live check ok');
process.exit(0);
