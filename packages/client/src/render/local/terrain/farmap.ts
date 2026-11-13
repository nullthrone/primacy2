/**
 * Far maps: the ground of a whole landable body baked into one cube texture (normals and tone
 * from the shared terrain, see `bakeFarRows`). The space layer draws the body from it, so what is
 * seen from orbit is the terrain a pilot later flies over, and the ground tiles blend into it at
 * height. A map is baked by the terrain workers the first time it is asked for and kept while it
 * is in use; a few bodies' worth are held at a time.
 *
 * The maps exist only once the terrain part has switched them on (`enableFarMaps`): without the
 * part every body keeps its procedural look.
 */
import { CubeTexture, DataTexture, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RGBAFormat } from 'three';
import { bodyTerrain, type SystemDef, type TerrainParams } from '@primacy2/shared';
import { FACES } from './cube.ts';
import { terrainPool, type Job } from './pool.ts';

/** Texels along the edge of a face. On the 1,057 km test moon one texel is 3.2 km. */
const SIZE = 512;
/** A face is baked in this many strips, so the workers stay free for ground tiles in between. */
const STRIPS = 8;
/** Maps kept at most, and seconds an unused one is kept at least. */
const KEEP = 4;
const IDLE = 20;
/** Far-map strips run after the tiles in view and before those outside it (see `Ground.visit`). */
const PRIORITY = 5e5;

export interface FarMap {
  /** The cube texture, or null while it is being baked. */
  texture: CubeTexture | null;
  /** Clock time (seconds since the page loaded) at which the texture was finished. */
  readyAt: number;
}

interface Entry extends FarMap {
  key: string;
  faces: Uint16Array[];
  jobs: Job[];
  left: number;
  used: number;
}

const entries = new Map<TerrainParams, Entry>();
let enabled = false;
let serial = 0;
let now = 0;

/** Switches far maps on. Called by the terrain part when it starts. */
export function enableFarMaps(): void {
  enabled = true;
}

/**
 * The far map of a body, or null when the body cannot be landed on or far maps are off. The
 * first call starts the bake; `texture` stays null until it is done. Call it in every frame the
 * map is drawn with: a map nobody asks for is dropped. `clock` is the page clock in seconds.
 */
export function farMap(sys: SystemDef, bodyId: number, clock: number): FarMap | null {
  if (!enabled) return null;
  const params = bodyTerrain(sys, bodyId);
  if (!params) return null;
  now = clock;
  let entry = entries.get(params);
  if (!entry) {
    const pool = terrainPool();
    if (!pool.available) return null;
    trim();
    const key = `far${++serial}`;
    const created: Entry = { key, texture: null, readyAt: 0, faces: [], jobs: [], left: FACES * STRIPS, used: clock };
    entry = created;
    entries.set(params, created);
    pool.body(key, params);
    const rows = SIZE / STRIPS;
    for (let face = 0; face < FACES; face++) {
      created.faces.push(new Uint16Array(SIZE * SIZE * 4));
      for (let strip = 0; strip < STRIPS; strip++) {
        created.jobs.push(pool.far(key, face, SIZE, strip * rows, rows, PRIORITY + face * STRIPS + strip, (data) => {
          if (!data || entries.get(params) !== created) return;
          created.faces[face]!.set(data, strip * rows * SIZE * 4);
          if (--created.left === 0) finish(created);
        }));
      }
    }
  }
  entry.used = clock;
  return entry;
}

function finish(entry: Entry): void {
  const faces = entry.faces.map((data) => new DataTexture(data, SIZE, SIZE, RGBAFormat, HalfFloatType));
  const cube = new CubeTexture(faces);
  cube.format = RGBAFormat;
  cube.type = HalfFloatType;
  cube.magFilter = LinearFilter;
  cube.minFilter = LinearMipmapLinearFilter;
  cube.generateMipmaps = true;
  cube.needsUpdate = true;
  entry.texture = cube;
  entry.readyAt = now;
  entry.jobs.length = 0;
  terrainPool().forget(entry.key);
}

/** Drops the maps that have gone unused longest, down to the number kept. */
function trim(): void {
  while (entries.size >= KEEP) {
    let oldest: TerrainParams | null = null;
    let at = Infinity;
    for (const [params, e] of entries) {
      if (e.used < at && now - e.used > IDLE) {
        at = e.used;
        oldest = params;
      }
    }
    if (!oldest) return;
    drop(oldest);
  }
}

function drop(params: TerrainParams): void {
  const e = entries.get(params);
  if (!e) return;
  entries.delete(params);
  for (const job of e.jobs) job.cancel();
  e.texture?.dispose();
  terrainPool().forget(e.key);
}

/** Frees every far map (the renderer is being torn down, or its context was lost). */
export function disposeFarMaps(): void {
  for (const params of [...entries.keys()]) drop(params);
}
