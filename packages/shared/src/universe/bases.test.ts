import { describe, expect, it } from 'vitest';
import { HULLS, computeShipStats, starterLoadout } from '../catalog.ts';
import { BASE_MAX_GRAVITY, BASE_PAD_BLEND, BASE_PAD_RADIUS, DT, G, MASS_LOCK_RADIUS, SITE_ID_BASE, SURFACE_ID_BASE } from '../constants.ts';
import { upOf, v3 } from '../math.ts';
import { hashString, Rng } from '../prng.ts';
import { newShipState, simulateShip } from '../sim/ship.ts';
import { isMassLocked, placeAtSite } from '../sim/transitions.ts';
import { FlightMode, type ShipInput } from '../sim/types.ts';
import { collideStructure, GROUND_BASE_STRUCTURE, siteStructure, STRUCTURES } from '../structures.ts';
import { generateSector, summarize, upsertGateSite } from './generate.ts';
import { anchorState, bodyState, findSite, surfaceAnchor } from './orbits.ts';
import { bodySurface, groundAltitude, nearestGroundSite } from './surface.ts';
import { isLandable, terrainHeight, terrainParams, terrainRelief } from './terrain.ts';
import type { BodyDef, SiteDef, SystemDef } from './types.ts';

const wisp = computeShipStats(starterLoadout('wisp'));

/**
 * One number per system for everything the generator made before there were ground bases:
 * `hashString(JSON.stringify(system))`, captured from the code as it was before bases were added
 * (commit 546c1e1), for four sectors of 24 systems around [10, -2, 33] with radius 18.
 */
const BEFORE_BASES: Record<string, number[]> = {
  'aaaaaaaaaaaaaaaa/primacy': [
    2115847764, 975444451, 2323262549, 3679016931, 2446993891, 1150582987, 491738963, 602952148, 714392772, 871373316, 58340023, 2577368537,
    3663042550, 1110412799, 1505305922, 2182360956, 1538213729, 4147238884, 2175423782, 4090416613, 3007887925, 758349530, 511770778, 3782979697,
  ],
  'bcdefghijklmnopq/second-seed': [
    1600726398, 1985260262, 2648129395, 2923142251, 234861788, 4159936389, 2824584605, 594455265, 4039078760, 2153560761, 2003661099, 922595963,
    1861096728, 600723310, 1576657456, 2765458436, 3943878630, 3287134201, 2486970870, 2961775432, 4256375000, 777287133, 1820795371, 3730593748,
  ],
  'q2w3e4r5t6y7abcd/': [
    4140429042, 2017846324, 4091121899, 2282731691, 1732216457, 1785816414, 821817447, 2655354363, 3876485631, 2778682305, 1117585767, 257309275,
    3432405119, 1601772181, 1559545335, 4227800850, 2184259019, 1681432973, 3657582565, 2234832898, 2689054839, 3454063059, 2372806093, 3028088610,
  ],
  'primacytwoserver/the quick brown fox': [
    2004391800, 2671336086, 2121135385, 2255670871, 3600881248, 3827493334, 567301386, 3814489199, 119163051, 2623865244, 3654621526, 1746848958,
    26224198, 2457159702, 447331388, 2129695250, 2769880448, 3619342391, 2591979461, 3361967002, 272720713, 2376289744, 1077073519, 2719927843,
  ],
};

const SECTORS: SystemDef[][] = Object.keys(BEFORE_BASES).map((key) => {
  const cut = key.indexOf('/');
  return generateSector({ serverId: key.slice(0, cut), seed: key.slice(cut + 1), center: [10, -2, 33], radius: 18, count: 24 });
});
/** More systems for anything statistical. */
const MANY: SystemDef[] = [...SECTORS.flat()];
for (let k = 0; k < 6; k++) MANY.push(...generateSector({ serverId: `baseserver${k}`, seed: `base${k}`, center: [0, 0, 0], radius: 18, count: 48 }));

const basesOf = (sys: SystemDef): SiteDef[] => sys.sites.filter((s) => s.kind === 'base');
const gravity = (b: BodyDef): number => (G * b.mass) / (b.radius * b.radius);
/** Bodies a base may stand on: landable and light enough. */
const hostsOf = (sys: SystemDef): BodyDef[] => sys.bodies.filter((b) => isLandable(b) && gravity(b) <= BASE_MAX_GRAVITY);
const ALL_BASES: { sys: SystemDef; site: SiteDef }[] = MANY.flatMap((sys) => basesOf(sys).map((site) => ({ sys, site })));

describe('what the generator made before ground bases', () => {
  it('is exactly what it was: every body, belt, site and id of every system', () => {
    let bases = 0;
    Object.keys(BEFORE_BASES).forEach((key, k) => {
      const hashes = SECTORS[k]!.map((sys) => {
        bases += basesOf(sys).length;
        return hashString(JSON.stringify({ ...sys, sites: sys.sites.filter((s) => s.kind !== 'base') }));
      });
      expect(hashes, key).toEqual(BEFORE_BASES[key]);
    });
    // The comparison did leave something out.
    expect(bases).toBeGreaterThan(10);
  });

  it('comes before the bases in the list of sites, so no anchor id moved', () => {
    for (const sys of MANY) {
      const first = sys.sites.findIndex((s) => s.kind === 'base');
      sys.sites.forEach((site, i) => {
        expect(site.id).toBe(SITE_ID_BASE + i);
        if (first >= 0 && i >= first) expect(site.kind).toBe('base');
      });
      expect(sys.bodies.length).toBeLessThan(SURFACE_ID_BASE);
    }
  });
});

describe('ground bases', () => {
  it('stand on landable bodies with at most 6 m/s^2', () => {
    expect(ALL_BASES.length).toBeGreaterThan(40);
    for (const { sys, site } of ALL_BASES) {
      const ground = site.ground!;
      expect(ground).toBeDefined();
      const body = sys.bodies[ground.body]!;
      expect(isLandable(body)).toBe(true);
      expect(gravity(body)).toBeLessThanOrEqual(BASE_MAX_GRAVITY);
      // No orbit and no zone of its own; the parent names the body.
      expect(site.orbit).toEqual({ parent: body.id, a: 0, e: 0, inc: 0, node: 0, argp: 0, m0: 0, period: 0 });
      expect(site.frameRadius).toBe(0);
    }
    // At most two in a system, on different bodies, with different names.
    for (const sys of MANY) {
      const bases = basesOf(sys);
      expect(bases.length).toBeLessThanOrEqual(2);
      expect(new Set(bases.map((b) => b.ground!.body)).size).toBe(bases.length);
      expect(new Set(sys.sites.map((s) => s.name)).size).toBe(sys.sites.length);
    }
  });

  it('stand on the ground: the pad is level at the height of the site', () => {
    for (const { sys, site } of ALL_BASES) {
      const body = sys.bodies[site.ground!.body]!;
      const r = v3.len(site.ground!.pos);
      const dir = v3.scale(site.ground!.pos, 1 / r);
      const natural = terrainParams(body);
      expect(Math.abs(r - body.radius - terrainHeight(natural, dir[0], dir[1], dir[2]))).toBeLessThan(1e-6);
      const surface = bodySurface(sys, body.id)!;
      expect(surface.sites).toContain(site);
      expect(Math.abs(groundAltitude(surface, site.ground!.pos))).toBeLessThan(1e-6);
      expect(terrainRelief(surface.terrain, dir[0], dir[1], dir[2], 0.95 * BASE_PAD_RADIUS)).toBeLessThan(1e-6);
      expect(nearestGroundSite(sys, body.id, site.ground!.pos)!.site).toBe(site);
      // The true position: on the body, moving with its ground.
      const t = 4.2e6;
      expect(Math.abs(v3.dist(anchorState(sys, site.id, t).pos, bodyState(sys, body.id, t).pos) - r)).toBeLessThan(0.01);
    }
  });

  it('are built on the most level of the spots tried', () => {
    const outer = BASE_PAD_RADIUS + BASE_PAD_BLEND;
    const chosen: number[] = [];
    const random: number[] = [];
    const rng = new Rng(17);
    for (const { sys, site } of ALL_BASES) {
      const body = sys.bodies[site.ground!.body]!;
      const natural = terrainParams(body);
      const dir = v3.normalize(site.ground!.pos);
      chosen.push(terrainRelief(natural, dir[0], dir[1], dir[2], outer) / outer);
      const other = v3.normalize([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]);
      random.push(terrainRelief(natural, other[0], other[1], other[2], outer) / outer);
    }
    const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
    expect(mean(chosen)).toBeLessThan(0.4 * mean(random));
    // No base has to cut a pad into anything like a crater wall.
    expect(Math.max(...chosen)).toBeLessThan(0.1);
  });

  it('offer what an outpost offers, sometimes an outfitter, under the faction of their system', () => {
    let outfitters = 0;
    const economies = new Set<string>();
    for (const { sys, site } of ALL_BASES) {
      expect(site.radius).toBe(GROUND_BASE_STRUCTURE.bound);
      for (const service of ['market', 'refuel', 'repair', 'missions'] as const) expect(site.services).toContain(service);
      expect(site.services).not.toContain('shipyard');
      expect(site.services!.length).toBe(site.services!.includes('outfit') ? 5 : 4);
      if (site.services!.includes('outfit')) outfitters++;
      expect(['mining', 'outpost']).toContain(site.economy);
      economies.add(site.economy!);
      expect(site.faction).toBe(sys.faction);
      expect(site.faction).toBeDefined();
      expect(/ (Landing|Base|Diggings|Field|Ground)$|^Fort /.test(site.name), site.name).toBe(true);
    }
    expect(economies.size).toBe(2);
    expect(outfitters).toBeGreaterThan(0.1 * ALL_BASES.length);
    expect(outfitters).toBeLessThan(0.6 * ALL_BASES.length);
  });

  it('name no model that is not built: every model of a generated site is a structure the client can load', () => {
    // The client loads the model of every entry of STRUCTURES at start and of every site that
    // names one; a key without a file is an error on every page. These are the models that
    // exist in packages/client/public/models; a new structure goes here when its file does.
    const built = ['station_ring', 'station_outpost', 'gate', 'beacon', 'base_ground'];
    expect(Object.keys(STRUCTURES).sort()).toEqual([...built].sort());
    for (const [key, def] of Object.entries(STRUCTURES)) expect(def.model).toBe(key);
    for (const sys of MANY) {
      for (const site of sys.sites) {
        if (site.model !== undefined) expect(built, `${site.kind} ${site.name}`).toContain(site.model);
        // A base is the ground base structure and nothing else is.
        expect(site.model === 'base_ground', `${site.kind} ${site.name}`).toBe(site.kind === 'base');
      }
    }
    const gate = upsertGateSite(
      generateSector({ serverId: 'aaaaaaaaaaaaaaaa', seed: 'primacy', center: [0, 0, 0], radius: 18, count: 2 })[1]!,
      { linkId: 'l', peer: 'peerpeerpeerpeer', remoteSystem: 'peerpeerpeerpeer:1', state: 'planned', progress: 0, remoteProgress: 0 }, [0, 0, 1],
    );
    expect(built).toContain(gate.model);
  });

  it('have four landing pads around the compound: numbered clockwise from north, clear of it and of each other', () => {
    const structure = GROUND_BASE_STRUCTURE;
    const pads = structure.pads!;
    expect(pads.length).toBe(4);
    // Pad 1 lies north (-Z), 2 east (+X), 3 south, 4 west.
    expect(pads.map((p) => [Math.sign(p.pos[0]), Math.sign(p.pos[2])])).toEqual([[0, -1], [1, 0], [0, 1], [-1, 0]]);
    const block = Math.max(...structure.colliders.map((c) => (c.kind === 'cylinder' ? c.r : 0)));
    const largest = Math.max(...Object.values(HULLS).map((h) => h.radius));
    for (const [i, pad] of pads.entries()) {
      const out = Math.hypot(pad.pos[0], pad.pos[2]);
      // On the ground, 130 to 230 m from the centre, about 80 m across.
      expect(pad.pos[1]).toBe(0);
      expect(out).toBeGreaterThanOrEqual(130);
      expect(out).toBeLessThanOrEqual(230);
      expect(pad.r).toBeGreaterThanOrEqual(38);
      expect(pad.r).toBeLessThanOrEqual(42);
      // Big enough for every hull, with room to miss the middle by.
      expect(pad.r).toBeGreaterThan(largest + 10);
      // The whole disc is clear of the compound, inside the bounding sphere and on the flattened ground.
      expect(out - pad.r).toBeGreaterThanOrEqual(block);
      expect(out + pad.r).toBeLessThanOrEqual(structure.bound);
      expect(out + pad.r).toBeLessThan(BASE_PAD_RADIUS);
      // The largest hull standing at the centre touches nothing of the structure.
      expect(collideStructure(structure, [pad.pos[0], HULLS.bulwark!.belly, pad.pos[2]], largest)).toBeNull();
      for (const other of pads.slice(i + 1)) {
        expect(Math.hypot(pad.pos[0] - other.pos[0], pad.pos[2] - other.pos[2])).toBeGreaterThan(pad.r + other.r + 2 * largest);
      }
    }
    // No other structure has pads so far.
    for (const [key, def] of Object.entries(STRUCTURES)) expect(def.pads === undefined, key).toBe(key !== 'base_ground');
  });

  it('have the shape their model is built to', () => {
    const structure = GROUND_BASE_STRUCTURE;
    expect(STRUCTURES.base_ground).toBe(structure);
    expect(structure.model).toBe('base_ground');
    expect(structure.bound).toBe(250);
    // It stands on the ground: nothing of it below the pad, and well inside the flat part.
    for (const c of structure.colliders) {
      expect(c.kind).toBe('cylinder');
      if (c.kind === 'cylinder') {
        expect(c.y0).toBeGreaterThanOrEqual(0);
        expect(c.r).toBeLessThan(0.5 * BASE_PAD_RADIUS);
      }
    }
    // The server finds the shape of any site through one function.
    const base = ALL_BASES[0]!.site;
    expect(siteStructure(base)).toBe(GROUND_BASE_STRUCTURE);
    const station = MANY.flatMap((s) => s.sites).find((s) => s.kind === 'station')!;
    expect(siteStructure(station)).toBe(STRUCTURES.station_ring);
    expect(siteStructure(MANY.flatMap((s) => s.sites).find((s) => s.kind === 'belt')!)).toBeNull();
    // A ship standing on the open pad is clear of the block; one over the middle is not.
    expect(collideStructure(structure, [200, 3, 0], 9)).toBeNull();
    expect(collideStructure(structure, [0, 45, 0], 9)).not.toBeNull();
  });

  it('are in the capital whenever it has a body to build on, in other inhabited systems by chance', () => {
    let capitals = 0;
    let possible = 0;
    let built = 0;
    for (const sys of MANY) {
      const bases = basesOf(sys);
      // The hosts as they were before the bases themselves took any.
      const hosts = hostsOf(sys);
      if (sys.faction === undefined) {
        // Nobody lives here: no base, so a system's faction and its station count still mean what they did.
        expect(bases.length).toBe(0);
        continue;
      }
      if (hosts.length === 0) {
        expect(bases.length).toBe(0);
        continue;
      }
      if (sys.id.endsWith(':0')) {
        capitals++;
        expect(bases.length, sys.id).toBeGreaterThanOrEqual(1);
      } else {
        possible++;
        if (bases.length > 0) built++;
      }
    }
    expect(capitals).toBeGreaterThan(5);
    expect(built / possible).toBeGreaterThan(0.25);
    expect(built / possible).toBeLessThan(0.55);
  });

  it('count as places to dock in the summary and tag the system', () => {
    let tagged = 0;
    for (const sys of MANY) {
      const bases = basesOf(sys).length;
      const summary = summarize(sys);
      expect(summary.stations).toBe(sys.stations + bases);
      expect(summary.tags.includes('base')).toBe(bases > 0);
      expect(summary.tags.length).toBeLessThanOrEqual(12);
      // The system itself keeps the count and the tags it always had.
      expect(sys.tags).not.toContain('base');
      expect(sys.stations).toBe(sys.sites.filter((s) => s.kind === 'station' || s.kind === 'outpost').length);
      // A system shows as inhabited on the map exactly when it has a station or an outpost, as before.
      expect(summary.stations > 0).toBe(sys.stations > 0);
      if (bases > 0) tagged++;
    }
    expect(tagged).toBeGreaterThan(30);
  });

  it('keep their ids when a warp gate is added later, and the gate gets the next one', () => {
    const sys = generateSector({ serverId: 'aaaaaaaaaaaaaaaa', seed: 'primacy', center: [10, -2, 33], radius: 18, count: 24 })
      .find((s) => basesOf(s).length > 0)!;
    const base = basesOf(sys)[0]!;
    const before = sys.sites.length;
    const surface = bodySurface(sys, base.ground!.body)!;
    const gate = upsertGateSite(sys, { linkId: 'link-1', peer: 'peerpeerpeerpeer', remoteSystem: 'peerpeerpeerpeer:4', state: 'planned', progress: 0, remoteProgress: 0 }, [1, 0, 0]);
    expect(gate.id).toBe(SITE_ID_BASE + before);
    expect(gate.orbit.a).toBeGreaterThan(0);
    expect(findSite(sys, base.id)).toBe(base);
    // The ground is rebuilt for the new list of sites and is the same ground.
    const again = bodySurface(sys, base.ground!.body)!;
    expect(again).not.toBe(surface);
    expect(again.sites).toEqual([base]);
    expect(groundAltitude(again, base.ground!.pos)).toBe(groundAltitude(surface, base.ground!.pos));
  });

  it('can be landed at: a ship placed over the pad comes down and stands on it', () => {
    const down: ShipInput = { seq: 0, thrust: [0, -4 / (0.7 * wisp.maxSpeed), 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0 };
    for (const { sys, site } of ALL_BASES.slice(0, 12)) {
      const s = newShipState(wisp);
      placeAtSite(s, sys, site.id, 1000, new Rng(site.seed), 60);
      expect(s.anchor).toBe(surfaceAnchor(site.ground!.body));
      expect(isMassLocked(s, sys, 1000)).toBe(true);
      expect(v3.dist(s.pos, site.ground!.pos)).toBeLessThan(MASS_LOCK_RADIUS);
      for (let i = 0; i < 40 / DT && s.mode === FlightMode.Normal; i++) simulateShip(s, down, wisp, sys, 1000 + i * DT, DT);
      expect(s.mode, `${sys.id} ${site.name}`).toBe(FlightMode.Landed);
      // On the pad, upright on the local vertical.
      expect(v3.dist(s.pos, site.ground!.pos)).toBeLessThan(BASE_PAD_RADIUS);
      expect(v3.dist(upOf(s.rot), v3.normalize(s.pos))).toBeLessThan(1e-6);
    }
  });
});
