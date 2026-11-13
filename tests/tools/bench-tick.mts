/**
 * Server tick time with 20 pilots hovering close to the ground of a landable body (in its surface
 * frame, so the terrain is sampled for every ship every tick) against 20 pilots at a station.
 * The pilots have a connection that discards what it is sent, so snapshots are built and encoded.
 *
 *   npx tsx tests/tools/bench-tick.mts
 */
import {
  DT,
  FlightMode,
  anchorBody,
  bodySurface,
  computeShipStats,
  groundAltitude,
  groundSiteRotation,
  newPassport,
  newShipState,
  quat,
  starterLoadout,
  surfaceAnchor,
  v3,
  type SiteDef,
  type Vec3,
} from '@primacy2/shared';
import { Player, newShip, type PlayerRecord, type Ship, type SystemSim } from '@primacy2/server';
import { Cluster } from '../harness.ts';

const c = new Cluster();
const S = await c.start({ name: 'Landing' });
const world = S.world;
const def = world.defs.get(`${world.id}:0`)!;
const sim: SystemSim = world.sim(def.id);
const base = def.sites.find((s) => s.kind === 'base')!;
const station = def.sites.find((s) => s.kind === 'station')!;
const body = def.bodies[base.ground!.body]!;
const surface = bodySurface(def, body.id)!;
const zone = surfaceAnchor(body.id);
const padRot = groundSiteRotation(base);
let n = 0;

function pilot(anchor: number, pos: Vec3, rot = quat.identity()): Ship {
  const id = `bench-${++n}`;
  const passport = newPassport(id, id, world.id);
  passport.ship.loadout = starterLoadout('wisp');
  const rec: PlayerRecord = {
    id, key: id, passport, credits: 0, status: 'here', system: def.id, ship: null, homeSystem: null, homeSite: null, data: {}, createdAt: 0, updatedAt: 0,
  };
  const p = new Player(rec);
  let sent = 0;
  p.conn = { send() { sent++; }, sendBinary() { sent++; }, close() {} };
  void sent;
  const state = newShipState(p.stats);
  state.anchor = anchor;
  state.pos = [...pos];
  state.rot = [...rot];
  const ship = newShip(world.allocId(), p.name, passport.ship.loadout, p.stats, state);
  ship.player = p;
  ship.cargo = passport.ship.cargo;
  p.ship = ship;
  p.sim = sim;
  sim.addShip(ship);
  world.players.set(id, p);
  return ship;
}

function measure(label: string, warm = 300, ticks = 900): void {
  const times: number[] = [];
  const total = warm + ticks;
  for (let i = 0; i < total; i++) {
    c.nowMs += DT * 1000;
    const t0 = process.hrtime.bigint();
    S.tick();
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (i >= warm) times.push(dt);
  }
  times.sort((a, b) => a - b);
  const q = (f: number): number => times[Math.min(times.length - 1, Math.floor(f * times.length))]!;
  const npcs = [...sim.ships.values()].filter((s) => s.npc !== null).length;
  const inZone = [...sim.ships.values()].filter((s) => s.player !== null && s.state.mode !== FlightMode.Docked).length;
  console.log(`${label}: median ${q(0.5).toFixed(3)} ms, p95 ${q(0.95).toFixed(3)} ms, max ${q(1).toFixed(3)} ms per tick (${ticks} ticks; ${inZone} pilots, ${npcs} NPC ships in the system; the tick budget is ${(DT * 1000).toFixed(1)} ms)`);
}

// Nobody anywhere: the cost of an idle simulation.
const keeper = pilot(station.id, [20_000, 0, 0]);
measure('1 pilot at a station (baseline)', 60, 300);

// 20 pilots at the station, 2 to 6 km out, hovering.
const atStation: Ship[] = [];
for (let k = 0; k < 20; k++) {
  const a = (k / 20) * Math.PI * 2;
  atStation.push(pilot(station.id, [Math.cos(a) * 4_000, Math.sin(k) * 800, Math.sin(a) * 4_000]));
}
measure('20 pilots at a station');
for (const s of atStation) {
  sim.removeShip(s);
  world.players.delete(s.player!.id);
}

// 20 pilots in the surface frame, 5 m over natural ground 1.5 to 6 km from the pad, hovering.
const onGround: Ship[] = [];
for (let k = 0; k < 20; k++) {
  const bearing = k * 0.7;
  const km = 1500 + (k % 5) * 900;
  const local: Vec3 = [Math.cos(bearing) * km, 0, Math.sin(bearing) * km];
  const flat = v3.add(base.ground!.pos, quat.rotate(padRot, local));
  const up = v3.normalize(flat);
  const stats = computeShipStats(starterLoadout('wisp'));
  const alt = groundAltitude(surface, flat);
  onGround.push(pilot(zone, v3.scale(up, v3.len(flat) - alt + stats.belly + 5), padRot));
}
measure('20 pilots hovering 5 m over the ground');
const sampleSteady = onGround.filter((s) => s.state.mode === FlightMode.Normal).length;
console.log(`(${sampleSteady} of the 20 were still in flight over the ground at the end of the run, ${onGround.length - sampleSteady} had landed or crashed)`);
void anchorBody;
void (base as SiteDef);
void keeper;
await c.stop();
process.exit(0);
