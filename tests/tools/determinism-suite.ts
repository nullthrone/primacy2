/**
 * The calculations whose results must be bit for bit the same in every engine: the terrain
 * height, tone, normal and relief of landable bodies (pads included, every detail level, cold and
 * after the engine has optimised the code), and a few landings flown through the shared step. The
 * results are returned as the hexadecimal bit patterns of the float64 values.
 *
 * Run by tests/tools/terrain-browser.mjs in Node and in Chromium, which compares them.
 */
import {
  DT,
  Button,
  FlightMode,
  bodySurface,
  computeShipStats,
  generateSector,
  isLandable,
  newShipState,
  quat,
  simulateShip,
  starterLoadout,
  surfaceAnchor,
  terrainHeight,
  terrainMax,
  terrainMin,
  terrainNormal,
  terrainRelief,
  terrainSample,
  v3,
  type BodyDef,
  type SystemDef,
  type Vec3,
} from '../../packages/shared/src/index.ts';
import { LANDING_PLANET, landingSystem } from '../../packages/shared/src/sim/fixtures.ts';

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const hex = (x: number): string => {
  f64[0] = x;
  return u64[0]!.toString(16).padStart(16, '0');
};

interface Subject {
  label: string;
  body: BodyDef;
  surface: NonNullable<ReturnType<typeof bodySurface>>;
  padDir: Vec3 | null;
}

/** Landable bodies of different kinds (some with a ground base, so with a pad) from generated sectors. */
function subjects(): Subject[] {
  const found = new Map<string, Subject>();
  const sectors: SystemDef[] = [];
  for (const [serverId, seed] of [['aaaaaaaaaaaaaaaa', 'primacy'], ['bcdefghijklmnopq', 'second-seed'], ['q2w3e4r5t6y7abcd', '']] as const) {
    sectors.push(...generateSector({ serverId, seed, center: [10, -2, 33], radius: 18, count: 24 }));
  }
  for (const sys of sectors) {
    for (const body of sys.bodies) {
      if (!isLandable(body)) continue;
      const surface = bodySurface(sys, body.id)!;
      const pad = surface.sites[0]?.ground?.pos ?? null;
      const key = pad ? `${body.cls} with a pad` : body.cls;
      if (!found.has(key)) {
        found.set(key, {
          label: `${key} (${sys.id} body ${body.id}, radius ${Math.round(body.radius / 1000)} km)`,
          body,
          surface,
          padDir: pad ? v3.normalize(pad) : null,
        });
      }
    }
  }
  return [...found.values()].slice(0, 5);
}

/** Unit directions made with integer arithmetic and one square root only, the same in every engine. */
function directions(n: number, around: Vec3 | null): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; out.length < n; i++) {
    let a = ((i * 7919 + 13) % 2003) / 1001.5 - 1;
    let b = ((i * 104729 + 7) % 2011) / 1005.5 - 1;
    let c = ((i * 1299709 + 3) % 2017) / 1008.5 - 1;
    if (around && i % 2 === 0) {
      // Close to a pad: a small offset (up to about 1.5 km on a 1,000 km body) from its centre.
      a = around[0] + a * 1.2e-3;
      b = around[1] + b * 1.2e-3;
      c = around[2] + c * 1.2e-3;
    }
    const l = Math.sqrt(a * a + b * b + c * c);
    if (l < 0.1) continue;
    out.push([a / l, b / l, c / l]);
  }
  return out;
}

/** All terrain queries for one set of inputs, as bit patterns. */
function terrainBits(s: Subject, dirs: Vec3[]): string[] {
  const out: string[] = [];
  const sample = new Float64Array(2);
  const n: Vec3 = [0, 0, 0];
  const p = s.surface.terrain;
  out.push(hex(terrainMin(p)), hex(terrainMax(p)));
  for (const [x, y, z] of dirs) {
    for (const detail of [0, 1, 2, 3]) out.push(hex(terrainHeight(p, x, y, z, detail)));
    terrainSample(p, x, y, z, 0, sample);
    out.push(hex(sample[0]!), hex(sample[1]!));
    out.push(hex(terrainNormal(p, x, y, z, 20, n)), hex(n[0]), hex(n[1]), hex(n[2]));
    out.push(hex(terrainRelief(p, x, y, z, 150)));
  }
  return out;
}

/** A ship dropped onto the ground of the fixture planet in several ways, flown through `simulateShip`; the state every 400 ticks and at touchdown. */
function landings(): string[] {
  const sys = landingSystem();
  const stats = computeShipStats(starterLoadout('wisp'));
  const anchor = surfaceAnchor(LANDING_PLANET);
  const out: string[] = [];
  const cases: { dir: Vec3; alt: number; sink: number; side: number; thrust: number }[] = [
    { dir: [0.6, 0.48, 0.64], alt: 400, sink: -4, side: 0, thrust: 0 },
    { dir: [0.1, 0.9, 0.42], alt: 900, sink: -30, side: 12, thrust: 0.5 },
    { dir: [-0.5, 0.2, 0.84], alt: 250, sink: -2, side: 40, thrust: 0.2 },
    { dir: [0.7, -0.3, -0.64], alt: 60, sink: -60, side: 0, thrust: 0 },
  ];
  for (const c of cases) {
    const s = newShipState(stats);
    const up = v3.normalize(c.dir);
    s.anchor = anchor;
    s.pos = v3.scale(up, sys.bodies[LANDING_PLANET]!.radius + 3000 + c.alt);
    const along = v3.normalize(v3.cross(up, [0, 0, 1]));
    s.vel = v3.add(v3.scale(up, c.sink), v3.scale(along, c.side));
    s.rot = quat.lookRotation(along, up);
    s.fa = false;
    let t = 5e6;
    for (let i = 0; i < 4000; i++) {
      simulateShip(s, { seq: i, thrust: [0, i % 200 < 100 ? 0 : c.thrust, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: Button.FaOff }, stats, sys, t, DT);
      t += DT;
      if (i % 400 === 399 || s.mode === FlightMode.Landed || s.mode === FlightMode.Dead) {
        out.push(`${i}:${s.mode}`, ...s.pos.map(hex), ...s.vel.map(hex), ...s.rot.map(hex), hex(s.hull));
        if (s.mode === FlightMode.Landed || s.mode === FlightMode.Dead) break;
      }
    }
  }
  return out;
}

export interface SuiteResult {
  engine: string;
  /** Per subject: cold results, then results of the same queries after 150,000 warm-up calls. */
  terrain: Record<string, { cold: string[]; warm: string[] }>;
  landings: string[];
  values: number;
}

export function runSuite(engine: string): SuiteResult {
  const terrain: SuiteResult['terrain'] = {};
  let values = 0;
  for (const s of subjects()) {
    const dirs = directions(320, s.padDir);
    const cold = terrainBits(s, dirs);
    // Warm-up on other directions, enough for the optimising compiler to take over.
    const warmDirs = directions(2000, s.padDir);
    let acc = 0;
    for (let k = 0; k < 75; k++) for (const [x, y, z] of warmDirs) acc += terrainHeight(s.surface.terrain, x, y, z, 0);
    if (acc === 12345.678) console.log('unlikely');
    const warm = terrainBits(s, dirs);
    terrain[s.label] = { cold, warm };
    values += cold.length;
  }
  const l = landings();
  return { engine, terrain, landings: l, values: values + l.length };
}
