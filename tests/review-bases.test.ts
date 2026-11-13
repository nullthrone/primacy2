/**
 * Review of the landing core, shared part: where the generator puts ground bases. Every base of
 * several generated sectors is looked at for the ground its pad stands on.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_PAD_BLEND,
  BASE_PAD_RADIUS,
  LAND_MAX_SLOPE,
  bodySurface,
  generateSector,
  terrainHeight,
  terrainNormal,
  terrainParams,
  v3,
  type SiteDef,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';

/** The four sectors the generator tests use, 24 systems each, and more of 48 for a larger sample. */
const NAMED: [string, string][] = [
  ['aaaaaaaaaaaaaaaa', 'primacy'],
  ['bcdefghijklmnopq', 'second-seed'],
  ['q2w3e4r5t6y7abcd', ''],
  ['primacytwoserver', 'the quick brown fox'],
];
const named: SystemDef[] = NAMED.flatMap(([serverId, seed]) => generateSector({ serverId, seed, center: [10, -2, 33], radius: 18, count: 24 }));
const more: SystemDef[] = [];
for (let k = 0; k < 20; k++) more.push(...generateSector({ serverId: `padscan${k}abcdefghij`, seed: `pad-${k}`, center: [0, 0, 0], radius: 18, count: 48 }));

interface PadReport {
  system: string;
  body: number;
  /** Largest slope (rise over run, 20 m baseline) anywhere within the pad radius. */
  padSlope: number;
  /** Largest slope in the blend ring from the pad edge to its outer edge. */
  ringSlope: number;
  /** Largest height difference between the pad level and the terrain at the outer edge of the ring, metres. */
  edgeStep: number;
  /** Largest difference between the pad level and the untouched natural terrain on the pad edge, metres: how much the pad had to cut or fill. */
  cutFill: number;
}

function report(sys: SystemDef, site: SiteDef): PadReport {
  const body = sys.bodies[site.ground!.body]!;
  const surface = bodySurface(sys, body.id)!;
  const natural = terrainParams(body);
  const dir = v3.normalize(site.ground!.pos);
  // Two axes along the ground at the pad.
  const east = v3.normalize(v3.cross(dir, [0, 1, 0]));
  const north = v3.cross(dir, east);
  const padLevel = terrainHeight(surface.terrain, dir[0], dir[1], dir[2]);
  const at = (d: number, bearing: number): Vec3 => {
    const p = v3.add(v3.scale(dir, body.radius + padLevel), v3.add(v3.scale(east, d * Math.cos(bearing)), v3.scale(north, d * Math.sin(bearing))));
    return v3.normalize(p);
  };
  const n: Vec3 = [0, 0, 0];
  let padSlope = 0;
  let ringSlope = 0;
  let edgeStep = 0;
  let cutFill = 0;
  for (let b = 0; b < 48; b++) {
    const bearing = (b / 48) * 2 * Math.PI;
    for (const d of [50, 150, 250, 350, BASE_PAD_RADIUS]) {
      const u = at(d, bearing);
      padSlope = Math.max(padSlope, terrainNormal(surface.terrain, u[0], u[1], u[2], 20, n));
    }
    for (let d = BASE_PAD_RADIUS; d <= BASE_PAD_RADIUS + BASE_PAD_BLEND; d += 40) {
      const u = at(d, bearing);
      ringSlope = Math.max(ringSlope, terrainNormal(surface.terrain, u[0], u[1], u[2], 20, n));
    }
    const edge = at(BASE_PAD_RADIUS + BASE_PAD_BLEND, bearing);
    edgeStep = Math.max(edgeStep, Math.abs(terrainHeight(surface.terrain, edge[0], edge[1], edge[2]) - padLevel));
    const rim = at(BASE_PAD_RADIUS, bearing);
    cutFill = Math.max(cutFill, Math.abs(terrainHeight(natural, rim[0], rim[1], rim[2]) - padLevel));
  }
  return { system: sys.id, body: body.id, padSlope, ringSlope, edgeStep, cutFill };
}

const reports = (systems: SystemDef[]): PadReport[] =>
  systems.flatMap((sys) => sys.sites.filter((s) => s.ground).map((site) => report(sys, site)));

const worst = (list: PadReport[], key: keyof Omit<PadReport, 'system' | 'body'>): PadReport => list.reduce((a, b) => (b[key] > a[key] ? b : a));
const deg = (slope: number): string => ((Math.atan(slope) * 180) / Math.PI).toFixed(1);

describe('the ground under generated ground bases', () => {
  it('every pad is flat and the ring around it does not stand a ship on its tail', () => {
    for (const [label, systems] of [['four named sectors', named], ['twenty more sectors', more]] as const) {
      const list = reports(systems);
      const p = worst(list, 'padSlope');
      const r = worst(list, 'ringSlope');
      const e = worst(list, 'edgeStep');
      const c = worst(list, 'cutFill');
      console.log(
        `${label}: ${list.length} bases. Worst slope on the pad ${deg(p.padSlope)} deg (${p.system}); ` +
        `worst slope in the blend ring ${deg(r.ringSlope)} deg (${r.system}); ` +
        `worst height difference pad level to the outer edge of the ring ${e.edgeStep.toFixed(1)} m (${e.system}); ` +
        `worst cut or fill at the pad edge ${c.cutFill.toFixed(1)} m (${c.system})`,
      );
      expect(list.length).toBeGreaterThan(label === 'four named sectors' ? 10 : 100);
      // The pad is flat: a ship can always stand on it.
      expect(p.padSlope, `${label}: pad slope`).toBeLessThan(0.02);
      // The ring may not be landable everywhere, but it is never a wall.
      expect(r.ringSlope, `${label}: ring slope`).toBeLessThan(Math.tan((45 * Math.PI) / 180));
    }
    expect(LAND_MAX_SLOPE).toBeGreaterThan(0.36);
  });
});
