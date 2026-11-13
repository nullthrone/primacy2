/**
 * Runs the shared package as it was before the landing work (commit 546c1e1, extracted by
 * `git archive` to a directory given as OLD_ROOT) and as it is now, in one process, and compares:
 *
 *   1. the generator: every body, belt, site and id of every system, with the ground bases left out;
 *      and what a warp gate added later gets as its anchor id;
 *   2. scripted flights around bodies that cannot be landed on, and at stations: states, hazards,
 *      cruise limits and mass locks, tick by tick.
 *
 * Usage: OLD_ROOT=/path/to/old npx tsx tests/tools/compare-old-new.mts
 */
import { pathToFileURL } from 'node:url';
import * as NEW from '../../packages/shared/src/index.ts';

const OLD_ROOT = process.env.OLD_ROOT;
if (!OLD_ROOT) throw new Error('set OLD_ROOT to the extracted tree of commit 546c1e1');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OLD: any = await import(pathToFileURL(`${OLD_ROOT}/packages/shared/src/index.ts`).href);

type Lib = typeof NEW;
const lib = (l: unknown): Lib => l as Lib;

// ---------------------------------------------------------------------------------------------
// 1. The generator
// ---------------------------------------------------------------------------------------------

const SECTORS: { serverId: string; seed: string; center: [number, number, number]; radius: number; count: number }[] = [];
for (const [serverId, seed] of [
  ['aaaaaaaaaaaaaaaa', 'primacy'], ['bcdefghijklmnopq', 'second-seed'], ['q2w3e4r5t6y7abcd', ''], ['primacytwoserver', 'the quick brown fox'],
] as const) SECTORS.push({ serverId, seed, center: [10, -2, 33], radius: 18, count: 24 });
for (let k = 0; k < 24; k++) SECTORS.push({ serverId: `cmpserver${k}abcdefg`, seed: `cmp-${k}`, center: [k, 2 * k, -k], radius: 18, count: 48 });

let systems = 0;
let mismatching = 0;
let withBases = 0;
let gateIdShifted = 0;
const gate = { linkId: 'link-a-b', peer: 'peer', remoteSystem: 'x:0', state: 'active', progress: 1, remoteProgress: 1 } as const;
const first: string[] = [];
for (const sec of SECTORS) {
  const olds = lib(OLD).generateSector(sec);
  const news = NEW.generateSector(sec);
  for (let i = 0; i < olds.length; i++) {
    systems++;
    const o = olds[i]!;
    const n = news[i]!;
    const nNoBases = { ...n, sites: n.sites.filter((s) => s.kind !== 'base') };
    const same = JSON.stringify(o) === JSON.stringify(nNoBases);
    if (!same) {
      mismatching++;
      if (first.length < 3) first.push(`${n.id}`);
    }
    if (n.sites.some((s) => s.kind === 'base')) withBases++;
    // A warp gate is added to a system after it is generated; compare the anchor id it gets.
    const og = lib(OLD).upsertGateSite(o, { ...gate }, [1, 0, 0]);
    const ng = NEW.upsertGateSite(n, { ...gate }, [1, 0, 0]);
    const ogJson = JSON.stringify({ ...og, id: 0 });
    const ngJson = JSON.stringify({ ...ng, id: 0 });
    if (ogJson !== ngJson) throw new Error(`gate site differs apart from its id in ${n.id}`);
    if (og.id !== ng.id) gateIdShifted++;
  }
}
console.log(`GENERATOR: ${systems} systems; with the bases left out ${systems - mismatching} are identical to before, ${mismatching} differ ${first.join(' ')}`);
console.log(`GENERATOR: ${withBases} systems have a ground base; the anchor id a gate added later gets is different from before in ${gateIdShifted} systems`);

// ---------------------------------------------------------------------------------------------
// 2. Scripted flights
// ---------------------------------------------------------------------------------------------

const hullStats = (l: Lib) => l.computeShipStats(l.starterLoadout('wisp'));
const DT = NEW.DT;

/** A deterministic input script: a few phases of thrust, turning and boost. */
function input(l: Lib, tick: number, cruise: boolean): any {
  const phase = Math.floor(tick / 60) % 5;
  return {
    seq: tick,
    thrust: cruise ? [0, 0, 0] : [phase === 1 ? 0.5 : 0, phase === 3 ? -0.4 : 0, phase === 0 ? 1 : phase === 2 ? -0.7 : 0.2],
    aim: [phase === 1 ? 0.01 : 0, phase === 3 ? -0.008 : 0],
    roll: phase === 4 ? 0.3 : 0,
    throttle: cruise ? 1 : phase === 0 ? 0.6 : 0,
    buttons: (phase === 2 ? l.Button.Boost : 0) | (phase === 3 ? l.Button.FaOff : 0),
  };
}

interface Scene {
  label: string;
  cruise: boolean;
  start(l: Lib, sys: any): any;
}

function dirOf(i: number): [number, number, number] {
  const a = i * 2.399963;
  const y = Math.cos(i * 1.3);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return [r * Math.cos(a), y, r * Math.sin(a)];
}

/** The digest of one scene: states every 20 ticks, hazards and cruise limits every 20 ticks, mass locks and cruise answers. */
function fly(l: Lib, sys: any, scene: Scene, ticks: number): string {
  const stats = hullStats(l);
  const s = scene.start(l, sys);
  const out: unknown[] = [];
  let t = 1e6;
  for (let i = 0; i < ticks; i++) {
    if (scene.cruise && i === 0) {
      const can = l.canEngageCruise(s, sys, t);
      out.push(['can', can.ok, can.ok ? '' : (can as any).reason]);
      if (can.ok) l.engageCruise(s, sys, t);
    }
    const env = l.simulateShip(s, input(l, i, s.mode === l.FlightMode.Cruise), stats, sys, t, DT);
    t += DT;
    if (i % 20 === 0) {
      const h = l.hazardsAt(env, s, stats);
      out.push([s.mode, s.anchor, s.pos, s.vel, s.rot, s.cruiseSpeed, s.hull, s.heat, h, l.cruiseSpeedLimit(env, s.pos, stats), l.isMassLocked(s, sys, t)]);
    }
    if (s.mode === l.FlightMode.Dead) break;
  }
  return JSON.stringify(out);
}

// The gates above were added to those systems; the flights use freshly generated ones.
const pairs: { o: any; n: any }[] = [];
for (const sec of SECTORS) {
  const olds = lib(OLD).generateSector(sec);
  const news = NEW.generateSector(sec);
  for (let i = 0; i < olds.length; i++) pairs.push({ o: olds[i], n: news[i] });
}
const isLandable = (b: any): boolean => NEW.isLandable(b);
let scenes = 0;
let identical = 0;
const differing: string[] = [];
let classA = 0;
let classB = 0;
function compare(sysO: any, sysN: any, scene: Scene, ticks: number): void {
  scenes++;
  const a = fly(lib(OLD), sysO, scene, ticks);
  const b = fly(NEW, sysN, scene, ticks);
  if (a === b) identical++;
  else if (differing.length < 6) differing.push(`${sysN.id} ${scene.label}`);
}

for (const { o, n } of pairs) {
  const landable = n.bodies.filter(isLandable);
  const sc: Scene[] = [];
  const cruiseOk = landable.length === 0;
  if (cruiseOk) classA++;
  else classB++;
  // Around every body that cannot be landed on, near and far; in cruise only where nothing can be landed on.
  for (const b of n.bodies) {
    if (isLandable(b)) continue;
    for (const [k, f] of [1.03, 1.2, 2.5, 12].entries()) {
      for (const cruise of cruiseOk ? [false, true] : [false]) {
        sc.push({
          label: `${cruise ? 'cruise' : 'normal'} at ${f}R of body ${b.id} (${b.kind})`, cruise,
          start(l, sys) {
            const s = l.newShipState(hullStats(l));
            const base = l.bodyState(sys, b.id, 1e6);
            void base;
            const anchor = cruise ? b.id : l.pickNormalAnchor(sys, l.anchorState(sys, b.id, 1e6).pos.map((x: number, j: number) => x + dirOf(k + b.id)[j]! * b.radius * f) as any, 1e6);
            s.anchor = anchor;
            const centre = l.anchorState(sys, b.id, 1e6).pos;
            const abs = centre.map((x: number, j: number) => x + dirOf(k + b.id)[j]! * b.radius * f);
            const here = l.anchorState(sys, anchor, 1e6).pos;
            s.pos = abs.map((x: number, j: number) => x - here[j]!) as any;
            s.vel = dirOf(k + 3).map((x: number) => x * 20) as any;
            s.rot = l.quat.lookRotation(l.v3.neg(dirOf(k + b.id))) as any;
            return s;
          },
        });
      }
    }
  }
  // At every station or outpost: placed 3 km out, flown, with the cruise answer asked for.
  for (const site of n.sites) {
    if (site.kind !== 'station' && site.kind !== 'outpost' && site.kind !== 'gate' && site.kind !== 'beacon') continue;
    // Only where the station's parent is not a landable body's neighbour in the surface frame: the parent itself is not landable here.
    if (isLandable(n.bodies[site.orbit.parent])) continue;
    sc.push({
      label: `normal at ${site.kind} ${site.id}`, cruise: false,
      start(l, sys) {
        const s = l.newShipState(hullStats(l));
        l.placeAtSite(s, sys, site.id, 1e6, new (l as any).Rng(7), 3_000);
        return s;
      },
    });
  }
  // Keep the run short: the first few scenes of each system.
  const chosen = sc.filter((_, idx) => idx % Math.max(1, Math.floor(sc.length / 6)) === 0).slice(0, 8);
  for (const scene of chosen) compare(o, n, scene, scene.cruise ? 900 : 400);
}
console.log(`FLIGHTS: ${scenes} scripted flights (${classA} systems without any landable body, ${classB} with one, flown only in normal flight around bodies that cannot be landed on and at stations whose parent cannot be landed on): ${identical} identical tick by tick, ${scenes - identical} differ ${differing.join(' | ')}`);
