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
const NEW_LIB: Lib = NEW;
let limitAbs = 0;
let limitRel = 0;
let limitsRaised = 0;
const tally = new Map<string, number>();
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
  /** What the scene is, for the tally: flight mode, kind of body or site and its class. */
  kind: string;
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
function fly(l: Lib, sys: any, scene: Scene, ticks: number, shells: { id: number; exit: number }[]): { digest: string; margin: number; limitsWrong: number; limitsChanged: number } {
  const stats = hullStats(l);
  const s = scene.start(l, sys);
  const out: unknown[] = [];
  let t = 1e6;
  // How close the ship came to the surface-frame shell of a landable body: distance to its centre minus where its surface frame ends.
  let margin = Infinity;
  let limitsWrong = 0;
  let limitsChanged = 0;
  for (let i = 0; i < ticks; i++) {
    if (scene.cruise && i === 0) {
      const can = l.canEngageCruise(s, sys, t);
      out.push(['can', can.ok, can.ok ? '' : (can as any).reason]);
      if (can.ok) l.engageCruise(s, sys, t);
    }
    const env = l.simulateShip(s, input(l, i, s.mode === l.FlightMode.Cruise), stats, sys, t, DT);
    t += DT;
    if (shells.length > 0 && i % 5 === 0) {
      const abs = l.absolutePosition(s, sys, t);
      for (const sh of shells) margin = Math.min(margin, l.v3.dist(abs, l.bodyState(sys, sh.id, t).pos) - sh.exit);
    }
    if (i % 20 === 0) {
      const h = l.hazardsAt(env, s, stats);
      const limit = l.cruiseSpeedLimit(env, s.pos, stats);
      out.push([s.mode, s.anchor, s.pos, s.vel, s.rot, s.cruiseSpeed, s.hull, s.heat, h, l.isMassLocked(s, sys, t)]);
      // The cruise limit: before the landing work it was the smallest of K * (distance - radius) over all bodies,
      // clamped. Now landable bodies limit by their ceiling and may let it fall to 250 m/s; every other body must
      // limit exactly as before. The expected value is built here from the rule as it was.
      if (l === NEW_LIB) {
        let nonLandable = stats.cruiseMax;
        let landable = Infinity;
        for (const src of env.sources) {
          const d = l.v3.dist(s.pos, src.pos);
          if (src.surface) landable = Math.min(landable, Math.max(250, 0.28 * Math.max(0, d - src.surface.ceiling)));
          else nonLandable = Math.min(nonLandable, 0.28 * Math.max(0, d - (src.rs > 0 ? Math.max(src.radius, src.rs * l.COMPACT_KILL_FACTOR) : src.radius)));
        }
        if (!(nonLandable > l.CRUISE_MIN_SPEED)) nonLandable = l.CRUISE_MIN_SPEED;
        const expected = Math.min(nonLandable, landable);
        if (Math.abs(limit - expected) > 1e-9 * expected) limitsWrong++;
        // What it would have been before.
        let before = stats.cruiseMax;
        for (const src of env.sources) before = Math.min(before, 0.28 * Math.max(0, l.v3.dist(s.pos, src.pos) - (src.rs > 0 ? Math.max(src.radius, src.rs * l.COMPACT_KILL_FACTOR) : src.radius)));
        if (!(before > l.CRUISE_MIN_SPEED)) before = l.CRUISE_MIN_SPEED;
        if (limit !== before) {
          limitsChanged++;
          limitAbs = Math.max(limitAbs, Math.abs(limit - before));
          limitRel = Math.max(limitRel, Math.abs(limit - before) / before);
          if (limit > before) limitsRaised++;
        }
      }
    }
    if (s.mode === l.FlightMode.Dead) break;
  }
  return { digest: JSON.stringify(out), margin, limitsWrong, limitsChanged };
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
let classA = 0;
let classB = 0;
let nearShell = 0;
let limitsWrong = 0;
let limitsChanged = 0;
const leaks: string[] = [];
function compare(sysO: any, sysN: any, scene: Scene, ticks: number): void {
  scenes++;
  tally.set(scene.kind, (tally.get(scene.kind) ?? 0) + 1);
  const shells = sysN.bodies.filter(isLandable).map((b: any) => ({ id: b.id, exit: NEW.bodySurface(sysN, b.id)!.exit }));
  const a = fly(lib(OLD), sysO, scene, ticks, shells);
  const b = fly(NEW, sysN, scene, ticks, shells);
  limitsWrong += b.limitsWrong;
  limitsChanged += b.limitsChanged;
  if (a.digest === b.digest) identical++;
  else if (Math.min(a.margin, b.margin) <= 0) nearShell++;
  else leaks.push(`${sysN.id} ${scene.label} (closest to a surface-frame shell ${(Math.min(a.margin, b.margin) / 1000).toFixed(0)} km)`);
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
          kind: `${cruise ? 'cruise' : 'normal'} flight at ${b.kind} ${b.cls}${b.atmo ? ' with atmosphere' : ''}`,
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
      label: `normal at ${site.kind} ${site.id}`, cruise: false, kind: `normal flight at a ${site.kind}`,
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
console.log(`FLIGHTS: ${scenes} scripted flights (${classA} systems without any landable body, ${classB} with one; normal flight around bodies that cannot be landed on and at stations, cruise only in the systems without a landable body): ${identical} identical tick by tick; ${nearShell} differ and came inside the surface-frame shell of a landable body; ${leaks.length} differ without ever being inside one`);
for (const [kind, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)} ${kind}`);
console.log(`CRUISE LIMITS: largest change ${(limitAbs / 1000).toFixed(2)} km/s (${(100 * limitRel).toFixed(2)} % of the old limit), raised at ${limitsRaised} points;`);
console.log(`CRUISE LIMITS: in the new run the limit differed from the old rule at ${limitsChanged} sampled points (all at landable bodies by design) and from the rule as intended at ${limitsWrong}`);
for (const l of leaks.slice(0, 12)) console.log('  LEAK?', l);
