/**
 * Development page for the local layer: the real layer over the real space renderer, fed with
 * synthetic frame views, so ships, structures and effects can be worked on without a server.
 *
 *   /dev/local.html?scene=ships|chase|cockpit|station|outpost|gate|beacon|belt|fight|surface
 *
 * Scenes
 *   ships    every hull in a row, turning slowly; `hull=<id>` shows that one alone and close
 *   chase    the pilot's own ship from the chase camera, cycling through thrust, boost and strafing
 *   cockpit  cockpit camera with two ships and a station ahead
 *   station, outpost, gate, beacon   the structure from `dist` metres
 *   belt     inside an asteroid field with a miner cutting a rock that runs dry
 *   fight    five ships circling and shooting, a missile, cargo pods, a kill every twelve seconds
 *            (the wreck stays for three seconds and is salvaged), ships arriving by fold and
 *            leaving by cruise
 *   surface  the pilot's ship over a real generated landable body near one of its ground bases,
 *            flying or standing on the ground. The frame view is the one the game builds there
 *            (the ship is in the surface frame of the body, everything is turned into system
 *            axes, `view.surface` is filled in). With it a second ship on the ground, one in the
 *            air, a wreck and a cargo pod at rest, and a hit and a blast on the ground at fixed
 *            spots, to see that they stay there while the body turns.
 *
 * Options
 *   parts=objects,fx   parts of the layer to load (default both); a broken part is left out
 *   hull=<id>          the pilot's ship (default wisp); self=0 for none
 *   cam=chase|cockpit  camera mode (default chase; the cockpit scene defaults to cockpit)
 *   thrust=fwd|back|left|right|up|down|boost|none   fixes the pilot's input in the chase scene
 *   fire=1             the pilot's own ship fires its first weapon (fight scene)
 *   dist, phase, elev  camera distance in metres, angle from the sun and elevation in degrees
 *   gate=planned|building|active|dormant, progress=0..1   state of the gate
 *   t=<seconds>        start value of the scene clock, to look at a later moment
 *   q=0..2, bloom=0, and the effect overrides cruise, fold, charge, kind, dil, heat, hit
 *   universe=<label>   server Alpha of the fixed test universe <label> instead of the demo sector
 *                      (16 is what scripts/e2e.mjs plays in; its capital has the ground base)
 *
 * Options of the surface scene
 *   state=flying|landed  the pilot's ship (default flying); landed fails where the ground is too steep
 *   alt=<m>              height of the ship's lowest point above the ground (default 40, flying only)
 *   east, north=<m>      where, from the centre of the pad (default 220 m east); or
 *   lat, lon=<deg>       anywhere on the body, in its own axes
 *   tod=<hours>          local solar time at the ship, 0..24, 12 = noon (default 10)
 *   heading, pitch=<deg> nose clockwise from north and above the horizon (default: toward the pad, level)
 *   speed, climb=<m/s>   the ship flies on at that speed over the ground and rate of climb
 *   rate=<n>             universe seconds per second (default 1); 600 shows the sun move
 *   look=<yaw>,<pitch>   free look in degrees
 *   base=<n>             which ground base of the demo sector (default 0)
 *   ground=<sys>,<body>  instead of a generated base: a stand-in base on that landable body of
 *                        system <sys> of the sector (at its south pole), to look at any ground
 *   extras=0             without the other ships, the wreck, the pod and the effects
 *   info=0               without the readout of the view data in the corner
 *   stats=1              a readout of the terrain part: tiles, levels, time per frame
 *
 * Any scene
 *   hud=1                the game's real HUD over the scene (`lang=en|de`), fed with the scene's
 *                        frame views; see `dev/hud.ts`
 *
 * `window.__ready` turns true after thirty frames; `window.__clock` is the scene clock;
 * `window.__view` is the frame view last drawn and, in the surface scene, `window.__place` the
 * place it was made for (see `SurfacePlace`).
 */
import { Button, EntityFlag, EntityKind, HULLS, SITE_ID_BASE, STRUCTURES, anchorState, isLandable, quat, terrainHeight, terrainParams, v3 } from '@primacy2/shared';
import type { GameEvent, GateState, Quat, SiteDef, SystemDef, Vec3 } from '@primacy2/shared';
import type { EntityView, FrameFx, FrameView } from '../contracts.ts';
import { createLocalLayer } from '../render/local/index.ts';
import type { PartName } from '../render/local/part.ts';
import { terrainDebug } from '../render/local/terrain/index.ts';
import { createRenderer } from '../render/Renderer.ts';
import { demoGalaxy, demoSector, fixedSector, makeSurfaceView, makeView, type FakeViewOptions, type SurfacePlace, type SurfaceViewOptions } from './fakeView.ts';

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'ships';
const str = (key: string, fallback: string): string => params.get(key) || fallback;
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  return v === null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v);
};
const rad = (deg: number): number => (deg * Math.PI) / 180;

const T0 = 1_000_000;
const HULL_IDS = Object.keys(HULLS);
// `universe=<label>` shows server Alpha of that fixed test universe instead of the demo sector;
// 16 is the one the browser test plays in, with a ground base in its capital (`base=0`).
const systems = params.get('universe') ? fixedSector(params.get('universe')!) : demoSector();
const galaxy = demoGalaxy(systems);
const graphics = { quality: Math.min(2, Math.max(0, Math.round(num('q', 2)))) as 0 | 1 | 2, bloom: params.get('bloom') !== '0' };
const fxOverride: Partial<FrameFx> = {
  cruise: num('cruise', 0),
  fold: num('fold', 0),
  charge: num('charge', 0),
  chargeKind: num('kind', 0),
  dilation: num('dil', 1),
  heat: num('heat', 0.1),
  hitFlash: num('hit', 0),
};

// ---------------------------------------------------------------------------------------------
// Places and cameras
// ---------------------------------------------------------------------------------------------

interface Place { sys: SystemDef; site: SiteDef }

function findPlace(pred: (s: SiteDef) => boolean): Place | null {
  for (const sys of systems) {
    const site = sys.sites.find(pred);
    if (site) return { sys, site };
  }
  return null;
}

/** The place with its site replaced by a changed copy. */
function patchSite(p: Place, patch: Partial<SiteDef>): Place {
  const site = { ...p.site, ...patch };
  return { sys: { ...p.sys, sites: p.sys.sites.map((s) => (s.id === site.id ? site : s)) }, site };
}

/** A site carrying the structure `model`; made from a station when the demo sector has none. */
function structure(model: string): Place {
  const hit = findPlace((s) => s.model === model);
  if (hit && model !== 'gate') return hit;
  const base = hit ?? findPlace((s) => s.kind === 'station')!;
  const radius = STRUCTURES[model]?.bound ?? 300;
  if (model === 'gate') {
    return patchSite(base, {
      kind: 'gate', model, radius, name: 'Dev Gate',
      gate: {
        linkId: 'dev-link', peer: 'peerpeerpeerpeer', remoteSystem: 'remote-system',
        state: str('gate', 'active') as GateState, progress: num('progress', 1), remoteProgress: 1,
      },
    });
  }
  return patchSite(base, { kind: model === 'beacon' ? 'beacon' : 'outpost', model, radius });
}

/** Unit direction from a site, `phase` degrees away from its star and `elev` degrees above that plane. */
function sunSide(p: Place, phase: number, elev: number): Vec3 {
  const toSun = v3.normalize(v3.sub(anchorState(p.sys, 0, T0).pos, anchorState(p.sys, p.site.id, T0).pos));
  const side = v3.normalize(v3.cross(toSun, [0, 1, 0]));
  const up = v3.cross(side, toSun);
  const flat = v3.add(v3.scale(toSun, Math.cos(rad(phase))), v3.scale(side, Math.sin(rad(phase))));
  return v3.normalize(v3.add(v3.scale(flat, Math.cos(rad(elev))), v3.scale(up, Math.sin(rad(elev)))));
}

/** A camera looking at a site's anchor. */
interface Rig { place: Place; offset: Vec3; rot: Quat }

function rig(place: Place, dist: number, phase = 50, elev = 18): Rig {
  const offset = v3.scale(sunSide(place, num('phase', phase), num('elev', elev)), num('dist', dist));
  return { place, offset, rot: quat.lookRotation(v3.neg(offset)) };
}

/** A point given in camera axes (x right, y up, z metres ahead) as a camera-relative position. */
const ahead = (r: Rig, x: number, y: number, z: number): Vec3 => quat.rotate(r.rot, [x, y, -z]);

/** A camera-relative position as a position relative to the zone anchor, as events carry it. */
const toZone = (r: Rig, rel: Vec3): Vec3 => v3.add(rel, r.offset);

function shipEnt(id: number, hull: string, rel: Vec3, rot: Quat, extra: Partial<EntityView> = {}): EntityView {
  return {
    id,
    info: { id, kind: EntityKind.Ship, name: `${HULLS[hull]?.name ?? hull} ${id}`, model: hull, radius: HULLS[hull]?.radius ?? 10, npc: 'trader' },
    rel, vel: [0, 0, 0], rot, flags: EntityFlag.Thrust, hull: 1, shield: 1, ...extra,
  };
}

function base(r: Rig, clock: number, dt: number, o: Partial<FakeViewOptions> = {}): FrameView {
  const cameraMode = str('cam', sceneName === 'cockpit' ? 'cockpit' : 'chase') === 'cockpit' ? 'cockpit' : 'chase';
  const hull = params.get('self') === '0' ? null : str('hull', 'wisp');
  const radius = HULLS[hull ?? 'wisp']?.radius ?? 10;
  const selfRel = cameraMode === 'chase' ? ahead(r, 0, -radius * 0.9, radius * 4.2) : quat.rotate(r.rot, [0, -0.9, 2.2]);
  return makeView({
    system: r.place.sys, anchor: r.place.site.id, offset: r.offset, rot: r.rot,
    time: T0 + clock, clock, dt, galaxy, fx: fxOverride, graphics, cameraMode, hull, selfRel, ...o,
  });
}

// ---------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------

type SceneFn = (clock: number, dt: number) => FrameView;

function ships(): SceneFn {
  const r = rig(structure('station_ring'), 6000);
  const one = params.get('hull');
  const list = one ? [one] : HULL_IDS;
  return (clock, dt) => {
    const ents = list.map((hull, i) => {
      const radius = HULLS[hull]?.radius ?? 10;
      const rel = one ? ahead(r, 0, 0, radius * 3.4) : ahead(r, (i - (list.length - 1) / 2) * 64, -4, 190);
      const turn = quat.mul(quat.fromAxisAngle([1, 0, 0], 0.3), quat.fromAxisAngle([0, 1, 0], clock * num('spin', 0.35) + i * 0.9));
      return shipEnt(10 + i, hull, rel, quat.mul(r.rot, turn));
    });
    return base(r, clock, dt, { hull: null, ents });
  };
}

const THRUSTS: Record<string, { thrust: Vec3; boost?: boolean }> = {
  fwd: { thrust: [0, 0, 1] },
  boost: { thrust: [0, 0, 1], boost: true },
  back: { thrust: [0, 0, -1] },
  left: { thrust: [-1, 0, 0] },
  right: { thrust: [1, 0, 0] },
  up: { thrust: [0, 1, 0] },
  down: { thrust: [0, -1, 0] },
  none: { thrust: [0, 0, 0] },
};
const THRUST_CYCLE = ['fwd', 'boost', 'none', 'left', 'right', 'up', 'down', 'back'];

function chase(): SceneFn {
  const r = rig(structure('station_ring'), 5000);
  return (clock, dt) => {
    const view = base(r, clock, dt);
    const fixed = params.get('thrust');
    const key = fixed && THRUSTS[fixed] ? fixed : THRUST_CYCLE[Math.floor(clock / 2.5) % THRUST_CYCLE.length]!;
    const t = THRUSTS[key]!;
    if (view.self) {
      view.self.input = { seq: 0, thrust: t.thrust, aim: [0, 0], roll: 0, throttle: 0, buttons: t.boost ? Button.Boost : 0 };
      view.fx.boosting = !!t.boost;
    }
    return view;
  };
}

function cockpit(): SceneFn {
  const r = rig(structure('station_ring'), 4200);
  return (clock, dt) => base(r, clock, dt, {
    ents: [
      shipEnt(10, 'lancet', ahead(r, -45, 12, 240), quat.mul(r.rot, quat.fromAxisAngle([0, 1, 0], 2.4 + clock * 0.1))),
      shipEnt(11, 'drover', ahead(r, 120, -30, 620), quat.mul(r.rot, quat.fromAxisAngle([0, 1, 0], 1.2))),
    ],
    targetId: 10,
  });
}

function structureScene(model: string): SceneFn {
  const r = rig(structure(model), (STRUCTURES[model]?.bound ?? 300) * 2.4, 50, 20);
  return (clock, dt) => base(r, clock, dt);
}

function belt(): SceneFn {
  const place = findPlace((s) => s.kind === 'belt') ?? findPlace((s) => s.kind === 'ring');
  if (!place) throw new Error('the demo sector has no mining site');
  const r = rig(place, 900, 55, 12);
  return (clock, dt) => {
    const minerRel = ahead(r, -60, -15, 260);
    const view = base(r, clock, dt, { ents: [shipEnt(20, 'delver', minerRel, r.rot, { flags: EntityFlag.Mining })] });
    const field = view.field;
    if (field && field.rocks.length) {
      // The miner works the rock nearest to it; the rock runs dry over forty seconds and starts over.
      const miner = toZone(r, minerRel);
      let best = 0;
      let bestDist = Infinity;
      field.rocks.forEach((rock, i) => {
        const d = v3.dist(rock.pos, miner);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      const left = 1 - (clock % 40) / 40;
      field.left[best] = left;
      // The server reports a mining beam about four times per second.
      if (Math.floor(clock * 4) !== Math.floor((clock - dt) * 4)) {
        view.events.push({ e: 'mine', from: 20, ast: best, at: v3.clone(field.rocks[best]!.pos) }, { e: 'ast', ast: best, left });
      }
    }
    return view;
  };
}

function fight(): SceneFn {
  const r = rig(structure('station_ring'), 8000);
  const hulls = ['lancet', 'wisp', 'bulwark', 'wayfarer', 'lancet'];
  const weapons = ['pulse_1', 'beam_1', 'cannon_1', 'rail_1', 'pulse_2'];
  const rates = [4, 8, 5, 0.5, 4.5];
  const KILL_PERIOD = 12;
  const centre: Vec3 = [0, 0, 420];
  /** Camera-axes position and velocity of fighter `k`: each flies its own tilted circle. */
  const path = (k: number, clock: number): { pos: Vec3; vel: Vec3 } => {
    const radius = 110 + 55 * k;
    const w = (k % 2 ? -1 : 1) * (0.5 - 0.05 * k);
    const a = clock * w + k * 1.3;
    const tilt = 0.35 * k - 0.7;
    const c = Math.cos(a), s = Math.sin(a);
    return {
      pos: [centre[0] + radius * c, centre[1] + radius * s * Math.sin(tilt), centre[2] + radius * s * Math.cos(tilt)],
      vel: [-radius * w * s, radius * w * c * Math.sin(tilt), radius * w * c * Math.cos(tilt)],
    };
  };
  const ticked = (clock: number, dt: number, perSecond: number): boolean => Math.floor(clock * perSecond) !== Math.floor((clock - dt) * perSecond);

  return (clock, dt) => {
    const events: GameEvent[] = [];
    const cycle = clock % KILL_PERIOD;
    const rels: Vec3[] = [];
    const ents: EntityView[] = [];
    for (let k = 0; k < hulls.length; k++) {
      const p = path(k, clock);
      const rel = ahead(r, p.pos[0], p.pos[1], p.pos[2]);
      rels.push(rel);
      // Fighter 1 is worn down over each period and is gone for its last three seconds.
      const victim = k === 1;
      if (victim && cycle > KILL_PERIOD - 3) continue;
      const wear = victim ? cycle / (KILL_PERIOD - 3) : 0;
      const vel = quat.rotate(r.rot, [p.vel[0], p.vel[1], -p.vel[2]]);
      ents.push(shipEnt(30 + k, hulls[k]!, rel, quat.lookRotation(vel, quat.rotate(r.rot, [0, 1, 0])), {
        vel, hull: victim ? Math.max(0.02, 1 - Math.max(0, wear - 0.4) / 0.6) : 1, shield: victim ? Math.max(0, 1 - wear / 0.4) : 0.8,
        flags: EntityFlag.Thrust | EntityFlag.Firing | (k === 0 ? EntityFlag.Boost : 0) | (k === 3 ? EntityFlag.Wanted : 0),
        info: { id: 30 + k, kind: EntityKind.Ship, name: `Fighter ${k}`, model: hulls[k]!, radius: HULLS[hulls[k]!]?.radius ?? 10, npc: k === 3 ? 'pirate' : 'security' },
      }));
    }
    const victimAlive = cycle <= KILL_PERIOD - 3;
    if (!victimAlive && cycle - dt <= KILL_PERIOD - 3) events.push({ e: 'destroyed', id: 31, by: 30, at: toZone(r, rels[1]!) });
    if (cycle < dt) events.push({ e: 'respawn', id: 31 });

    // Everyone shoots at the next fighter; a beam is held for two seconds out of five.
    for (let k = 0; k < hulls.length; k++) {
      const to = (k + 1) % hulls.length;
      if ((k === 1 || to === 1) && !victimAlive) continue;
      const beam = weapons[k] === 'beam_1';
      if (beam && clock % 5 > 2) continue;
      if (!ticked(clock + k * 0.37, dt, rates[k]!)) continue;
      const targetRel = rels[to]!;
      const miss = !beam && Math.floor(clock * rates[k]! + k) % 3 === 0;
      const at = miss ? v3.add(targetRel, v3.scale(v3.normalize(v3.sub(targetRel, rels[k]!)), 900)) : targetRel;
      events.push({ e: 'shot', from: 30 + k, w: weapons[k]!, slot: 0, to: miss ? undefined : 30 + to, at: toZone(r, at) });
      if (!miss) {
        const shielded = to === 1 ? cycle / (KILL_PERIOD - 3) < 0.4 : true;
        events.push({ e: 'hit', id: 30 + to, by: 30 + k, dmg: 20, shield: shielded, at: toZone(r, targetRel) });
      }
    }

    // A missile flies from fighter 3 to fighter 4 every four seconds.
    const m = (clock % 4) / 4;
    const from = rels[3]!, target = rels[4]!;
    const missileRel = v3.lerp(from, target, m);
    const missileVel = v3.scale(v3.normalize(v3.sub(target, from)), 650);
    ents.push({
      id: 50, info: { id: 50, kind: EntityKind.Missile, name: 'Missile', model: 'missile', radius: 1 },
      rel: missileRel, vel: missileVel, rot: quat.lookRotation(missileVel), flags: EntityFlag.Thrust, hull: 1, shield: 0,
    });
    if (clock % 4 < dt) events.push({ e: 'hit', id: 34, by: 33, dmg: 210, shield: true, at: toZone(r, target) });

    // What is left of fighter 1 stays where it died, and fighter 2 cuts it up.
    if (!victimAlive) {
      const wreckRel = (() => { const p = path(1, clock - (cycle - (KILL_PERIOD - 3))); return ahead(r, p.pos[0], p.pos[1], p.pos[2]); })();
      ents.push({
        id: 80, info: { id: 80, kind: EntityKind.Wreck, name: 'Wreck of Fighter 1', model: hulls[1]!, radius: HULLS[hulls[1]!]?.radius ?? 10 },
        rel: wreckRel, vel: [0, 0, 0], rot: quat.mul(r.rot, quat.fromAxisAngle(v3.normalize([0.4, 1, 0.2]), cycle * 0.25)),
        flags: 0, hull: 1 - (cycle - (KILL_PERIOD - 3)) / 3, shield: 0,
      });
      if (ticked(clock, dt, 4)) events.push({ e: 'salvage', from: 32, id: 80, at: toZone(r, wreckRel) });
    }

    // Cargo pods tumble near the camera.
    for (let i = 0; i < 3; i++) {
      ents.push({
        id: 60 + i, info: { id: 60 + i, kind: EntityKind.Loot, name: 'iron', model: 'cargo_pod', radius: 2, c: 'iron', n: 4 + i },
        rel: ahead(r, -70 + i * 22, -18 + i * 9, 150 + i * 30), vel: [0, 0, 0],
        rot: quat.mul(r.rot, quat.fromAxisAngle(v3.normalize([1, 0.6 * i, 0.3]), clock * (0.3 + 0.1 * i))), flags: 0, hull: 1, shield: 0,
      });
    }

    // Traffic: a ship folds in every nine seconds, another engages cruise in between.
    if (ticked(clock, dt, 1 / 9)) events.push({ e: 'fold', id: 70, out: false, at: toZone(r, ahead(r, 260, 90, 700)) });
    if (ticked(clock + 4.5, dt, 1 / 9)) events.push({ e: 'cruise', id: 71, on: true, at: toZone(r, ahead(r, -300, -60, 600)) });

    const view = base(r, clock, dt, { ents, targetId: 30 });
    const own = view.self;
    if (own && params.get('fire') === '1' && own.stats.weapons[0] && ticked(clock, dt, 4)) {
      events.push({ e: 'shot', from: own.id, w: own.stats.weapons[0].id, slot: 0, to: 30, at: toZone(r, rels[0]!) });
    }
    view.events = events;
    return view;
  };
}

/** What the surface scene last drew, for the readout and for scripts. */
let surfacePlace: SurfacePlace | null = null;

/**
 * A base that the generator did not build, on any landable body: `spec` is "<system index>,<body
 * id>". It stands at the south pole, out of the way of whatever `lat` and `lon` look at; like
 * every base it flattens the ground under itself.
 */
function standInBase(spec: string): Place {
  const [s, b] = spec.split(',').map((x) => Math.round(Number(x) || 0));
  const sys = systems[Math.min(systems.length - 1, Math.max(0, s ?? 0))]!;
  const body = sys.bodies[b ?? 0];
  if (!body || !isLandable(body)) throw new Error(`body ${b} of system ${s} cannot be landed on`);
  const r = body.radius + terrainHeight(terrainParams(body), 0, -1, 0);
  const site: SiteDef = {
    id: SITE_ID_BASE + sys.sites.length, kind: 'base', name: 'Dev Ground', seed: 1, frameRadius: 0, radius: 250,
    orbit: { parent: body.id, a: 0, e: 0, inc: 0, node: 0, argp: 0, m0: 0, period: 0 },
    ground: { body: body.id, pos: [0, -r, 0] },
  };
  return { sys: { ...sys, sites: [...sys.sites, site] }, site };
}

function surface(): SceneFn {
  const bases = systems.flatMap((sys) => sys.sites.filter((s) => s.ground !== undefined).map((site) => ({ sys, site })));
  const pick = params.get('ground') ? standInBase(str('ground', '0,0')) : bases[Math.min(bases.length - 1, Math.max(0, Math.round(num('base', 0))))];
  if (!pick) throw new Error('the demo sector has no ground base');
  const landed = str('state', 'flying') === 'landed';
  const opt = (key: string): number | undefined => (params.get(key) === null || params.get(key) === '' ? undefined : num(key, 0));
  const look = str('look', '0,0').split(',').map((x) => rad(Number(x) || 0));
  const fixed: SurfaceViewOptions = {
    system: pick.sys, site: pick.site, landed, hull: str('hull', 'wisp'),
    east: opt('east'), north: opt('north'), lat: opt('lat'), lon: opt('lon'), height: num('alt', 40),
    heading: opt('heading'), pitch: opt('pitch'), speed: opt('speed'), climb: opt('climb'),
    look: [look[0] ?? 0, look[1] ?? 0],
    cameraMode: str('cam', 'chase') === 'cockpit' ? 'cockpit' : 'chase',
    galaxy, fx: fxOverride, graphics,
  };
  // The scene starts at the hour asked for and runs on from there.
  const start = makeSurfaceView({ ...fixed, time: T0, hour: num('tod', 10) }).place.time;
  const clock0 = num('t', 10);
  const rate = num('rate', 1);
  const extras = params.get('extras') !== '0';
  // Events are timed against the clock of the frame before, not against `dt`, which is capped: a
  // long frame must not swallow the one blast it happens to span.
  let before = clock0;

  return (clock, dt) => {
    const since = clock - clock0;
    const { view, place } = makeSurfaceView({ ...fixed, time: start + since * rate, since, clock, dt });
    surfacePlace = place;
    const last = before;
    before = clock;
    const ticked = (perSecond: number): boolean => Math.floor(clock * perSecond) !== Math.floor(last * perSecond);
    if (!extras) return view;

    // Everything below is given in the surface frame of the body and so stays where it is on the
    // ground. Positions are metres east and north of the pad and above the ground.
    const parked = place.point(160, 60, HULLS.drover!.belly);
    const wreck = place.point(260, -70, HULLS.lancet!.belly);
    const pod = place.point(250, -52, 2);
    const hover = place.point(120, 260, 180);
    view.ents.push(
      { ...shipEnt(10, 'drover', place.rel(parked), place.standing(parked, 140)), flags: EntityFlag.Landed },
      { ...shipEnt(11, 'lancet', place.rel(hover), place.standing(hover, 250)), flags: 0 },
      {
        id: 80, info: { id: 80, kind: EntityKind.Wreck, name: 'Wreck of Lancet 12', model: 'lancet', radius: HULLS.lancet!.radius },
        rel: place.rel(wreck), vel: [0, 0, 0], rot: place.standing(wreck, 20), flags: 0, hull: 0.6, shield: 0,
      },
      {
        id: 60, info: { id: 60, kind: EntityKind.Loot, name: 'alloys', model: 'cargo_pod', radius: 2, c: 'alloys', n: 4 },
        rel: place.rel(pod), vel: [0, 0, 0], rot: place.standing(pod, 75), flags: 0, hull: 1, shield: 0,
      },
    );
    // A shot from the hovering ship into the ground beside the wreck four times a second, a hit
    // there, and every twelve seconds a ship blowing up on the ground a little farther off.
    const mark = place.point(300, -40, 0.5);
    if (ticked(4)) {
      view.events.push(
        { e: 'shot', from: 11, w: 'pulse_1', slot: 0, at: place.at(mark) },
        { e: 'hit', id: 80, by: 11, dmg: 20, shield: false, at: place.at(mark) },
      );
    }
    if (ticked(1 / 12)) view.events.push({ e: 'destroyed', id: 90, at: place.at(place.point(380, 90, 3)) });
    return view;
  };
}

/** A corner readout of what the frame view says about the ground: the numbers a renderer or HUD is given. */
function surfaceReadout(): (view: FrameView) => void {
  const box = document.createElement('pre');
  box.id = 'surface-info';
  box.style.cssText = 'position:fixed;left:12px;top:12px;margin:0;padding:8px 10px;font:12px/1.45 ui-monospace,Consolas,monospace;color:#cfd6dc;background:rgba(8,12,16,0.72);border:1px solid #2a343c;pointer-events:none;white-space:pre';
  document.body.appendChild(box);
  let next = 0;
  // Values that round to zero are shown as zero, not as "-0.00".
  const f = (x: number, digits = 1): string => (Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x).toFixed(digits);
  return (view) => {
    if (view.clock < next) return;
    next = view.clock + 0.2;
    const s = view.surface;
    const place = surfacePlace;
    if (!s || !place) {
      box.textContent = 'view.surface: null';
      return;
    }
    const ship = s.ship;
    const pad = view.sites.find((x) => x.def.id === place.site.id);
    box.textContent = [
      `${place.body.name}  (body ${s.body}, radius ${f(place.body.radius / 1000, 0)} km, day ${f(Math.abs(place.body.rotPeriod) / 3600)} h)`,
      `base          ${place.site.name}, ${f(pad?.dist ?? 0, 0)} m from the camera`,
      `local time    ${f(place.hour, 2)} h, sun ${f(place.sunElevation)} deg above the horizon`,
      `mode          ${ship?.landed ? 'landed' : 'flying'}`,
      `height        ${ship ? f(ship.height, 2) : '-'} m`,
      `vertical      ${ship ? f(ship.verticalSpeed, 2) : '-'} m/s`,
      `ground speed  ${ship ? f(ship.groundSpeed, 2) : '-'} m/s`,
      `slope         ${ship ? f((ship.slope * 180) / Math.PI) : '-'} deg`,
      `camera        ${f(s.camHeight, 2)} m above the ground, ${f(Math.hypot(s.cam[0], s.cam[1], s.cam[2]) / 1000, 3)} km from the centre`,
    ].join('\n');
  };
}

/** A corner readout of the terrain part (`stats=1`): how many tiles, how deep, and what the frame cost. */
function terrainReadout(): (view: FrameView) => void {
  const box = document.createElement('pre');
  box.id = 'terrain-info';
  box.style.cssText = 'position:fixed;right:12px;top:12px;margin:0;padding:8px 10px;font:12px/1.45 ui-monospace,Consolas,monospace;color:#cfd6dc;background:rgba(8,12,16,0.72);border:1px solid #2a343c;pointer-events:none;white-space:pre';
  document.body.appendChild(box);
  let next = 0;
  let worst = 0;
  let before = performance.now();
  return (view) => {
    const now = performance.now();
    worst = Math.max(worst, now - before);
    before = now;
    if (view.clock < next) return;
    next = view.clock + 0.25;
    const s = terrainDebug.stats;
    box.textContent = s ? [
      `tiles         ${s.drawn} drawn, ${s.loaded} loaded, ${s.waiting} waiting, ${s.total} baked so far`,
      `level         ${s.level} of ${s.deepest}, relief ${terrainDebug.relief.toFixed(2)}${terrainDebug.shown ? '' : ', not drawn'}`,
      `part update   ${terrainDebug.updateMs.toFixed(2)} ms (choosing ${s.selectMs.toFixed(2)}, uploading ${s.uploadMs.toFixed(2)})`,
      `longest frame ${worst.toFixed(1)} ms in the last quarter second`,
    ].join('\n') : 'terrain: no ground near';
    worst = 0;
  };
}

const SCENES: Record<string, () => SceneFn> = {
  ships,
  chase,
  cockpit,
  belt,
  fight,
  surface,
  station: () => structureScene('station_ring'),
  outpost: () => structureScene('station_outpost'),
  gate: () => structureScene('gate'),
  beacon: () => structureScene('beacon'),
};

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = createRenderer(canvas);
  const fit = (): void => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  fit();
  window.addEventListener('resize', fit);
  const parts = (params.get('parts') ?? 'objects,fx,terrain').split(',').filter((p): p is PartName => p === 'objects' || p === 'fx' || p === 'terrain');
  await renderer.init(createLocalLayer(parts));

  const scene = (SCENES[sceneName] ?? ships)();
  const readout = sceneName === 'surface' && params.get('info') !== '0' ? surfaceReadout() : null;
  const stats = params.get('stats') === '1' ? terrainReadout() : null;
  const hooks = window as unknown as {
    __ready: boolean; __clock: number; __view: FrameView; __place: SurfacePlace | null;
    __terrain: typeof terrainDebug; __frames: number[]; __work: number[];
  };
  // For measurements: what the terrain part is doing, and for the frames since a script last
  // emptied the lists the time from frame to frame and the time this page's own work took (ms).
  hooks.__terrain = terrainDebug;
  hooks.__frames = [];
  hooks.__work = [];
  if (params.get('hud') === '1') (await import('./hud.ts')).mountDevHud(() => hooks.__view ?? null, params.get('lang'));
  const start = performance.now();
  let last = num('t', 10);
  let frames = 0;
  let before = start;
  const frame = (): void => {
    const now = performance.now();
    const clock = num('t', 10) + (now - start) / 1000;
    const dt = Math.min(0.1, Math.max(1e-4, clock - last));
    last = clock;
    hooks.__clock = clock;
    const view = scene(clock, dt);
    hooks.__view = view;
    hooks.__place = surfacePlace;
    readout?.(view);
    renderer.render(view);
    stats?.(view);
    if (hooks.__frames.length < 100_000) {
      hooks.__frames.push(now - before);
      hooks.__work.push(performance.now() - now);
    }
    before = now;
    if (++frames === 30) hooks.__ready = true;
    requestAnimationFrame(frame);
  };
  frame();
}

void main();
