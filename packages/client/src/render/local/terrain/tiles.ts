/**
 * The ground tiles of one body: a quadtree on each face of the cube sphere, refined toward the
 * camera. Each frame the tree is walked from the six faces down; a tile is split while the camera
 * is nearer than two of its edge lengths, down to cells of about a metre and a half. Tiles are
 * baked by the worker pool, a parent always before its children, and a tile is replaced by its
 * four children only when all four are there, so the ground is never missing a piece.
 *
 * No seams and no jumps: the vertices of a tile slide onto the parent's surface over the last
 * part of the distance at which the parent takes over (see `material.ts`), so neighbours of
 * different levels meet exactly; where they cannot (a tile still loading next to a finished one)
 * a skirt under every tile edge closes the gap.
 *
 * Tiles are positioned in float64: a tile's vertices are small numbers in its own frame, and the
 * frame's origin minus the camera position is worked out here each frame.
 */
import { BufferAttribute, BufferGeometry, Group, Matrix3, Matrix4, Mesh, Vector2, Vector3 } from 'three';
import type { DataTexture, ShaderMaterial } from 'three';
import { terrainMax, terrainMin, type TerrainParams } from '@primacy2/shared';
import { gridDetail, tileIndexCount, tileIndices, tileOrder, tileUvs, type TileBake } from './bake.ts';
import { FACES, deepestLevel, directionToFace, faceDirection, tileFrame, tileSize, tileSpan } from './cube.ts';
import { DETAIL_PERIOD, mapTexture, tileMaterial, type GroundUniforms } from './material.ts';
import type { Job, TerrainPool } from './pool.ts';

/** Mesh cells along the edge of a tile. */
export const CELLS = 32;
/** The deepest level has cells between this many metres and twice that. */
const FINEST = 1.25;
/** A tile is split while the camera is nearer than this many of its edge lengths ... */
const SPLIT = 2;
/** ... and stays split until the camera is this much farther again, so a boundary does not flap. */
const KEEP = 1.1;
/**
 * Vertices start sliding onto the parent's surface at this fraction of the distance at which the
 * parent takes over. It cannot be much earlier: a tile next to a split one must still be on its
 * own surface along their common edge, which can be as far as `SPLIT * KEEP + sqrt(2)` of its
 * edge lengths from the camera, that is 0.9 of the `2 * SPLIT` lengths at which its parent takes over.
 */
const MORPH_START = 0.91;
/** Ground outside the view is kept this many times coarser by distance. */
const OUTSIDE = 2.5;
/** Seconds a new tile takes to settle from its parent's surface onto its own. */
const FADE_IN = 0.5;
/**
 * Tiles beyond this distance (m) are drawn far to near, each back to front: out there a step of
 * the depth buffer is tens of metres and more, and past the far plane of the local scene all
 * ground has one depth. Nearer tiles are drawn nearest first, so they hide what is behind them
 * before it is shaded.
 */
const FAR_ORDER = 2000;
const INDICES = tileIndexCount(CELLS);
/** The first indices of every drawing order are the skirt (`tileIndices`). */
const SKIRT_INDICES = 4 * CELLS * 6;
/**
 * Tiles beyond this distance (m) are drawn without their skirt. A skirt hangs from the very edge
 * it shares with the neighbour's surface, so close to that edge the depth buffer has to tell the
 * two apart: at 20 km one of its steps is about 50 m, half a pixel on the ground, and from there
 * on skirts showed through the ground beside them as specks along the tile edges and, at the
 * limb, as whole patches. What a skirt is for, a gap beside a tile that is still settling, is at
 * that distance a pixel or two wide for half a second, with the far view of the body behind it.
 */
const SKIRT_RANGE = 20_000;
/** Baked tiles handed to the GPU per frame at most. */
const UPLOADS = 4;
/** Seconds after which tiles nobody asked for are dropped. */
const IDLE = 4;
/** No map texel is smaller than this (m): the terrain has nothing that small to show. */
const MIN_TEXEL = 0.6;

const NONE = 0;
const WAITING = 1;
const BAKED = 2;
const READY = 3;

class Tile {
  children: Tile[] | null = null;
  state = NONE;
  job: Job | null = null;
  bake: TileBake | null = null;
  mesh: Mesh<BufferGeometry, ShaderMaterial> | null = null;
  texture: DataTexture | null = null;
  /** Origin and axes of the tile frame (`tileFrame`). */
  readonly frame = new Float64Array(12);
  /** Box around the tile in its frame: estimated from the terrain's bounds until the tile is baked. */
  readonly box = new Float64Array(6);
  /** Angle between the directions of the tile centre and its farthest corner. */
  gamma = 0;
  maxH = 0;
  /** Clock time the tile was last wanted, last selected as a leaf, last put in the view, and first drawn. */
  used = 0;
  leaf = -1;
  drawn = -1;
  born = -1;
  split = false;
  dist = 0;
  /** Drawing order of the tile this frame (`tileOrder`), by where the camera is in its frame. */
  order = 0;
  /** Position in the list of all tiles. */
  slot = -1;

  constructor(readonly face: number, readonly level: number, readonly ix: number, readonly iy: number, readonly parent: Tile | null) {}
}

/** Numbers about the ground for the development page and for measurements. */
export interface GroundStats {
  /** Tiles on the GPU, tiles drawn this frame, tiles being baked or waiting for the GPU. */
  loaded: number;
  drawn: number;
  waiting: number;
  /** Deepest level drawn this frame and the deepest the body has. */
  level: number;
  deepest: number;
  /** Tiles uploaded this frame; milliseconds spent choosing tiles and uploading. */
  uploads: number;
  selectMs: number;
  uploadMs: number;
  /** Tiles baked and uploaded so far. */
  total: number;
}

const D = new Float64Array(3);
const F3 = new Float64Array(3);
const basis = new Matrix4();
const vx = new Vector3();
const vy = new Vector3();
const vz = new Vector3();

export class Ground {
  readonly group = new Group();
  readonly stats: GroundStats = { loaded: 0, drawn: 0, waiting: 0, level: 0, deepest: 0, uploads: 0, selectMs: 0, uploadMs: 0, total: 0 };
  private readonly radius: number;
  private readonly low: number;
  private readonly high: number;
  private readonly deepest: number;
  private readonly roots: Tile[] = [];
  private readonly all: Tile[] = [];
  private readonly arrived: Tile[] = [];
  private draw: Tile[] = [];
  private shown: Tile[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly index: BufferAttribute;
  private readonly uv: BufferAttribute;
  private scan = 0;
  private disposed = false;

  // The camera of the frame being worked on, in body-fixed axes.
  private readonly cam = new Float64Array(3);
  private readonly camDir = new Float64Array(3);
  private readonly planes = new Float64Array(12);
  private horizon = 0;
  private clock = 0;

  /**
   * `key` names the body in the pool; `texels` is the number of map texels per mesh cell (4 for
   * sharp ground, 2 on lower quality levels); `anisotropy` is for the map textures.
   */
  constructor(
    private readonly key: string,
    private readonly params: TerrainParams,
    private readonly pool: TerrainPool,
    private readonly uniforms: GroundUniforms,
    private readonly texels: number,
    private readonly anisotropy: number,
  ) {
    this.radius = params.radius;
    this.low = this.radius + terrainMin(params);
    this.high = terrainMax(params);
    this.deepest = deepestLevel(this.radius, CELLS, FINEST);
    this.stats.deepest = this.deepest;
    this.index = new BufferAttribute(tileIndices(CELLS), 1);
    this.uv = new BufferAttribute(tileUvs(CELLS), 2);
    pool.body(key, params);
    for (let face = 0; face < FACES; face++) this.roots.push(this.create(face, 0, 0, 0, null));
  }

  /** Map texels per mesh cell at a level: fewer at the deepest levels, where more would be finer than the terrain. */
  private texelsAt(level: number): number {
    let m = this.texels;
    while (m > 1 && tileSize(this.radius, level) / (CELLS * m) < MIN_TEXEL) m /= 2;
    return m;
  }

  private create(face: number, level: number, ix: number, iy: number, parent: Tile | null): Tile {
    const t = new Tile(face, level, ix, iy, parent);
    const f = t.frame;
    tileFrame(face, level, ix, iy, this.radius, f);
    // Until the tile is baked its box is what the terrain's bounds allow: nine points of the
    // tile at the lowest and at the highest possible ground.
    const span = tileSpan(level);
    const b = t.box;
    b[0] = b[1] = b[2] = Infinity;
    b[3] = b[4] = b[5] = -Infinity;
    let cos = 1;
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        faceDirection(face, -1 + (ix + i * 0.5) * span, -1 + (iy + j * 0.5) * span, D);
        cos = Math.min(cos, D[0]! * f[6]! + D[1]! * f[7]! + D[2]! * f[8]!);
        for (let k = 0; k < 2; k++) {
          const r = k === 0 ? this.low : this.radius + this.high;
          const px = D[0]! * r - f[0]!, py = D[1]! * r - f[1]!, pz = D[2]! * r - f[2]!;
          for (let c = 0; c < 3; c++) {
            const l = px * f[3 + c * 3]! + py * f[4 + c * 3]! + pz * f[5 + c * 3]!;
            if (l < b[c]!) b[c] = l;
            if (l > b[c + 3]!) b[c + 3] = l;
          }
        }
      }
    }
    t.gamma = Math.acos(Math.min(1, cos));
    t.maxH = this.high;
    t.slot = this.all.length;
    this.all.push(t);
    return t;
  }

  /** Distance from the camera to a tile's box, metres. Also leaves the camera in the tile frame in `F3`. */
  private distance(t: Tile): number {
    const f = t.frame;
    const cx = this.cam[0]! - f[0]!, cy = this.cam[1]! - f[1]!, cz = this.cam[2]! - f[2]!;
    const lx = cx * f[3]! + cy * f[4]! + cz * f[5]!;
    const ly = cx * f[6]! + cy * f[7]! + cz * f[8]!;
    const lz = cx * f[9]! + cy * f[10]! + cz * f[11]!;
    F3[0] = lx;
    F3[1] = ly;
    F3[2] = lz;
    const b = t.box;
    const dx = Math.max(b[0]! - lx, 0, lx - b[3]!);
    const dy = Math.max(b[1]! - ly, 0, ly - b[4]!);
    const dz = Math.max(b[2]! - lz, 0, lz - b[5]!);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * How far the sphere around a tile's box reaches into the view, metres: negative when it is
   * outside by that much. Uses the camera position `distance` left in `F3`.
   */
  private reach(t: Tile): number {
    const f = t.frame;
    const b = t.box;
    const lx = (b[0]! + b[3]!) * 0.5 - F3[0]!, ly = (b[1]! + b[4]!) * 0.5 - F3[1]!, lz = (b[2]! + b[5]!) * 0.5 - F3[2]!;
    const rx = lx * f[3]! + ly * f[6]! + lz * f[9]!;
    const ry = lx * f[4]! + ly * f[7]! + lz * f[10]!;
    const rz = lx * f[5]! + ly * f[8]! + lz * f[11]!;
    const hx = b[3]! - b[0]!, hy = b[4]! - b[1]!, hz = b[5]! - b[2]!;
    let reach = Infinity;
    const p = this.planes;
    for (let i = 0; i < 12; i += 3) reach = Math.min(reach, rx * p[i]! + ry * p[i + 1]! + rz * p[i + 2]!);
    return reach + 0.5 * Math.sqrt(hx * hx + hy * hy + hz * hz);
  }

  /** True when the body itself hides the whole tile from the camera; `margin` (radians) errs toward visible. */
  private hidden(t: Tile, margin: number): boolean {
    const f = t.frame;
    const cos = this.camDir[0]! * f[6]! + this.camDir[1]! * f[7]! + this.camDir[2]! * f[8]!;
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    // A point at the tile's highest ground is seen as far round as the horizon plus this.
    const beyond = Math.acos(Math.min(1, this.low / (this.radius + t.maxH)));
    return angle - t.gamma > this.horizon + beyond + margin;
  }

  private want(t: Tile, priority: number): void {
    if (t.state === WAITING) {
      if (t.job) t.job.priority = priority;
      return;
    }
    if (t.state !== NONE || !this.pool.available) return;
    const texels = this.texelsAt(t.level);
    t.state = WAITING;
    t.job = this.pool.tile(this.key, {
      face: t.face, level: t.level, ix: t.ix, iy: t.iy, cells: CELLS, texels,
      parentDetail: t.level > 0 ? gridDetail(this.radius, t.level - 1, CELLS, this.texelsAt(t.level - 1)) : 0,
    }, priority, (bake) => {
      t.job = null;
      if (this.disposed || t.slot < 0) return;
      if (!bake) {
        t.state = NONE;
        return;
      }
      t.bake = bake;
      t.state = BAKED;
      this.arrived.push(t);
    });
  }

  private upload(t: Tile): void {
    const bake = t.bake!;
    const f = t.frame;
    t.box.set(bake.box);
    t.maxH = bake.maxH;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(bake.positions, 3));
    geometry.setAttribute('aCoarse', new BufferAttribute(bake.coarse, 3));
    geometry.setAttribute('aH', new BufferAttribute(bake.heights, 2));
    geometry.setAttribute('uv', this.uv);
    geometry.setIndex(this.index);
    const texture = mapTexture(bake.map, bake.mapSize, this.anisotropy);
    // Once the map is on the GPU its copy here is of no more use, and it is three quarters of
    // what a tile holds in memory. (After a lost context every tile is baked again.)
    texture.onUpdate = () => {
      (texture.image as { data: Uint16Array | null }).data = null;
      bake.map = NO_MAP;
    };
    const material = this.materials.pop() ?? tileMaterial(this.uniforms);
    const u = material.uniforms;
    const parent = t.parent ?? t;
    const g = bake.mapSize - 1;
    u.uMap!.value = texture;
    (u.uUv!.value as Vector2).set(g / bake.mapSize, 0.5 / bake.mapSize);
    // The parent's map over this tile's quarter of it; a face tile is its own parent.
    const pg = (parent === t ? bake.mapSize : parent.bake!.mapSize) - 1;
    const part = parent === t ? 1 : 0.5;
    u.uMapParent!.value = parent === t ? texture : parent.texture;
    (u.uUvParent!.value as Vector3).set(
      (part * pg) / (pg + 1),
      ((parent === t ? 0 : (t.ix & 1) * 0.5) * pg + 0.5) / (pg + 1),
      ((parent === t ? 0 : (t.iy & 1) * 0.5) * pg + 0.5) / (pg + 1),
    );
    const range = 2 * SPLIT * tileSize(this.radius, t.level);
    (u.uMorph!.value as Vector3).set(t.level === 0 ? 0 : 1 / ((1 - MORPH_START) * range), MORPH_START * range, 0);
    (u.uToBody!.value as Matrix3).set(f[3]!, f[6]!, f[9]!, f[4]!, f[7]!, f[10]!, f[5]!, f[8]!, f[11]!);
    const mod = (x: number): number => ((x % DETAIL_PERIOD) + DETAIL_PERIOD) % DETAIL_PERIOD;
    (u.uOriginMod!.value as Vector3).set(mod(f[0]!), mod(f[1]!), mod(f[2]!));

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.quaternion.setFromRotationMatrix(basis.makeBasis(vx.set(f[3]!, f[4]!, f[5]!), vy.set(f[6]!, f[7]!, f[8]!), vz.set(f[9]!, f[10]!, f[11]!)));
    this.group.add(mesh);
    t.mesh = mesh;
    t.texture = texture;
    t.state = READY;
    t.born = -1;
    this.stats.loaded++;
    this.stats.total++;
  }

  private release(t: Tile): void {
    t.job?.cancel();
    t.job = null;
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      const material = t.mesh.material;
      material.uniforms.uMap!.value = null;
      material.uniforms.uMapParent!.value = null;
      this.materials.push(material);
      t.mesh = null;
      this.stats.loaded--;
    }
    t.texture?.dispose();
    t.texture = null;
    t.bake = null;
    t.state = NONE;
    // Out of the list of all tiles: the last one takes its place.
    const last = this.all.pop()!;
    if (last !== t) {
      this.all[t.slot] = last;
      last.slot = t.slot;
    }
    t.slot = -1;
  }

  private visit(t: Tile): void {
    t.used = this.clock;
    if (this.hidden(t, 0)) return;
    const dist = this.distance(t);
    const reach = this.reach(t);
    // A band around the view counts as in it for the level of detail, so turning the camera
    // finds the ground there nearly as fine as it will be.
    const near = reach > -0.4 * (dist + 1);
    const size = tileSize(this.radius, t.level);
    const limit = SPLIT * size * (t.split ? KEEP : 1) / (near ? 1 : OUTSIDE);
    if (t.level < this.deepest && dist < limit) {
      if (!t.children) {
        const x = t.ix * 2, y = t.iy * 2, l = t.level + 1;
        t.children = [this.create(t.face, l, x, y, t), this.create(t.face, l, x + 1, y, t), this.create(t.face, l, x, y + 1, t), this.create(t.face, l, x + 1, y + 1, t)];
      }
      let usable = true;
      const priority = (near ? 0 : 1e6) + (t.level + 1) * 1e3 + Math.min(dist / size, 900);
      for (const kid of t.children) {
        kid.used = this.clock;
        if (kid.state === READY) continue;
        // A child the body hides is not needed; one that is just coming over the horizon is asked for early.
        if (this.hidden(kid, 0.02)) continue;
        usable = false;
        this.want(kid, priority);
      }
      t.split = usable;
      if (usable) {
        for (const kid of t.children) this.visit(kid);
        return;
      }
    } else {
      t.split = false;
    }
    t.leaf = this.clock;
    if (reach >= 0) {
      t.dist = dist;
      // `reach` left the camera's place in the tile frame in F3.
      t.order = tileOrder(F3[0]!, F3[2]!, dist < FAR_ORDER);
      t.drawn = this.clock;
      this.draw.push(t);
    }
  }

  /**
   * Chooses, loads and places the tiles for one frame. `cam` is the camera in body-fixed axes
   * (metres from the centre, float64); `right`, `up` and `forward` are its axes there;
   * `tanY` is the tangent of half the vertical field of view and `aspect` width over height.
   * With `show` false nothing is drawn, but tiles are still loaded.
   */
  update(cam: ArrayLike<number>, right: ArrayLike<number>, up: ArrayLike<number>, forward: ArrayLike<number>, tanY: number, aspect: number, clock: number, show: boolean): void {
    const t0 = performance.now();
    const stats = this.stats;
    this.clock = clock;
    const camDist = Math.sqrt(cam[0]! * cam[0]! + cam[1]! * cam[1]! + cam[2]! * cam[2]!);
    for (let c = 0; c < 3; c++) {
      this.cam[c] = cam[c]!;
      this.camDir[c] = cam[c]! / camDist;
    }
    this.horizon = Math.acos(Math.min(1, this.low / camDist));
    // The four side planes of the view as inward normals; there is no far plane.
    const cosY = 1 / Math.sqrt(1 + tanY * tanY), sinY = tanY * cosY;
    const tanX = tanY * aspect;
    const cosX = 1 / Math.sqrt(1 + tanX * tanX), sinX = tanX * cosX;
    const p = this.planes;
    for (let c = 0; c < 3; c++) {
      p[c] = sinX * forward[c]! + cosX * right[c]!;
      p[3 + c] = sinX * forward[c]! - cosX * right[c]!;
      p[6 + c] = sinY * forward[c]! + cosY * up[c]!;
      p[9 + c] = sinY * forward[c]! - cosY * up[c]!;
    }

    // Baked tiles go to the GPU a few per frame, coarse ones first.
    stats.uploads = 0;
    const arrived = this.arrived;
    while (arrived.length > 0 && stats.uploads < UPLOADS) {
      let best = 0;
      for (let i = 1; i < arrived.length; i++) if (arrived[i]!.level < arrived[best]!.level) best = i;
      const t = arrived.splice(best, 1)[0]!;
      if (t.slot < 0 || t.state !== BAKED) continue;
      this.upload(t);
      stats.uploads++;
    }
    const t1 = performance.now();
    stats.uploadMs = t1 - t0;

    const draw = this.draw;
    draw.length = 0;
    for (const root of this.roots) {
      if (root.state === READY) this.visit(root);
      else this.want(root, 0);
    }

    draw.sort(byDistance);
    let level = 0;
    const n = show ? draw.length : 0;
    for (let i = 0; i < n; i++) {
      const t = draw[i]!;
      const mesh = t.mesh!;
      const f = t.frame;
      if (t.born < 0) t.born = clock;
      mesh.visible = true;
      mesh.position.set(f[0]! - cam[0]!, f[1]! - cam[1]!, f[2]! - cam[2]!);
      mesh.renderOrder = t.dist < FAR_ORDER ? 10 + i : 10 + n + (n - i);
      const skirt = t.dist < SKIRT_RANGE ? 0 : SKIRT_INDICES;
      mesh.geometry.setDrawRange(t.order * INDICES + skirt, INDICES - skirt);
      (mesh.material.uniforms.uMorph!.value as Vector3).z = Math.max(0, 1 - (clock - t.born) / FADE_IN);
      if (t.level > level) level = t.level;
    }
    // Whatever was drawn in the frame before and is not drawn now is hidden.
    for (const t of this.shown) {
      if (t.mesh && (t.drawn !== clock || !show)) t.mesh.visible = false;
    }
    this.draw = this.shown;
    this.shown = draw;

    this.evict();
    stats.drawn = n;
    stats.level = level;
    stats.waiting = this.pool.pending + arrived.length;
    stats.selectMs = performance.now() - t1;
  }

  /** Drops groups of four tiles that nobody has asked for in a while; a few are looked at per frame. */
  private evict(): void {
    const all = this.all;
    for (let i = 0; i < 48 && all.length > 0; i++) {
      this.scan = (this.scan + 1) % all.length;
      const t = all[this.scan]!;
      const kids = t.children;
      if (!kids) continue;
      let idle = true;
      for (const kid of kids) if (kid.children || this.clock - kid.used < IDLE) idle = false;
      if (!idle) continue;
      for (const kid of kids) this.release(kid);
      t.children = null;
      t.split = false;
    }
  }

  /**
   * Height above the mean radius (m) of the drawn mesh under the unit direction `dir` (body-fixed
   * axes), as the vertex shader places it this frame: with the slide toward the parent's surface
   * and the fade-in of a new tile. Null where no tile is loaded. For checks against the shared
   * terrain; `relief` scales the height as the shader does.
   */
  heightAt(dir: ArrayLike<number>, relief = 1): number | null {
    directionToFace(dir[0]!, dir[1]!, dir[2]!, D);
    const u = D[1]!, v = D[2]!;
    let t = this.roots[D[0]!]!;
    while (t.leaf !== this.clock) {
      if (!t.children || !t.split) return null;
      const span = tileSpan(t.level + 1);
      const ix = Math.min(2 ** (t.level + 1) - 1, Math.max(0, Math.floor((u + 1) / span)));
      const iy = Math.min(2 ** (t.level + 1) - 1, Math.max(0, Math.floor((v + 1) / span)));
      t = t.children[(ix & 1) + (iy & 1) * 2]!;
    }
    const bake = t.bake;
    if (!bake || !t.mesh) return null;
    const span = tileSpan(t.level);
    const gx = Math.min(CELLS - 1e-9, Math.max(0, ((u + 1) / span - t.ix) * CELLS));
    const gy = Math.min(CELLS - 1e-9, Math.max(0, ((v + 1) / span - t.iy) * CELLS));
    const ci = Math.floor(gx), cj = Math.floor(gy);
    const row = CELLS + 1;
    // The triangle of the cell the point is in: cells are cut from (i+1, j) to (i, j+1).
    const lower = gx - ci + (gy - cj) <= 1;
    const a = lower ? cj * row + ci : cj * row + ci + 1;
    const b = lower ? (cj + 1) * row + ci : (cj + 1) * row + ci;
    const c = lower ? cj * row + ci + 1 : (cj + 1) * row + ci + 1;
    const f = t.frame;
    const morph = t.mesh.material.uniforms.uMorph!.value as Vector3;
    const P = heightScratch;
    const ids = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const id = ids[k]!;
      const px = bake.positions[id * 3]!, py = bake.positions[id * 3 + 1]!, pz = bake.positions[id * 3 + 2]!;
      // To body-fixed axes, then the distance to the camera decides the slide, as in the shader.
      const bx = f[0]! + px * f[3]! + py * f[6]! + pz * f[9]!;
      const by = f[1]! + px * f[4]! + py * f[7]! + pz * f[10]!;
      const bz = f[2]! + px * f[5]! + py * f[8]! + pz * f[11]!;
      const d = Math.hypot(bx - this.cam[0]!, by - this.cam[1]!, bz - this.cam[2]!);
      const m = Math.max(Math.min(1, Math.max(0, (d - morph.y) * morph.x)), morph.z);
      const qx = px + (bake.coarse[id * 3]! - px) * m, qy = py + (bake.coarse[id * 3 + 1]! - py) * m, qz = pz + (bake.coarse[id * 3 + 2]! - pz) * m;
      let wx = f[0]! + qx * f[3]! + qy * f[6]! + qz * f[9]!;
      let wy = f[1]! + qx * f[4]! + qy * f[7]! + qz * f[10]!;
      let wz = f[2]! + qx * f[5]! + qy * f[8]! + qz * f[11]!;
      if (relief < 1) {
        const h = (bake.heights[id * 2]! + (bake.heights[id * 2 + 1]! - bake.heights[id * 2]!) * m) * (1 - relief);
        const l = Math.hypot(wx, wy, wz);
        wx -= (wx / l) * h;
        wy -= (wy / l) * h;
        wz -= (wz / l) * h;
      }
      P[k * 3] = wx;
      P[k * 3 + 1] = wy;
      P[k * 3 + 2] = wz;
    }
    // Where the line from the body centre along `dir` meets the plane of the triangle.
    const e1x = P[3]! - P[0]!, e1y = P[4]! - P[1]!, e1z = P[5]! - P[2]!;
    const e2x = P[6]! - P[0]!, e2y = P[7]! - P[1]!, e2z = P[8]! - P[2]!;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const along = nx * dir[0]! + ny * dir[1]! + nz * dir[2]!;
    if (Math.abs(along) < 1e-12) return null;
    return (nx * P[0]! + ny * P[1]! + nz * P[2]!) / along - this.radius;
  }

  /** Level of the tile that would be drawn under a direction this frame, or -1. */
  levelAt(dir: ArrayLike<number>): number {
    directionToFace(dir[0]!, dir[1]!, dir[2]!, D);
    let t = this.roots[D[0]!]!;
    while (t.leaf !== this.clock) {
      if (!t.children || !t.split) return -1;
      const span = tileSpan(t.level + 1);
      const ix = Math.min(2 ** (t.level + 1) - 1, Math.max(0, Math.floor((D[1]! + 1) / span)));
      const iy = Math.min(2 ** (t.level + 1) - 1, Math.max(0, Math.floor((D[2]! + 1) / span)));
      t = t.children[(ix & 1) + (iy & 1) * 2]!;
    }
    return t.level;
  }

  /** True once the six face tiles are on the GPU: from then on the whole body is covered. */
  get covered(): boolean {
    for (const root of this.roots) if (root.state !== READY) return false;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.all) {
      t.job?.cancel();
      t.mesh?.geometry.dispose();
      t.mesh?.material.dispose();
      t.texture?.dispose();
      t.slot = -1;
    }
    for (const material of this.materials) material.dispose();
    this.all.length = 0;
    this.arrived.length = 0;
    this.group.clear();
    this.pool.forget(this.key);
  }
}

const heightScratch = new Float64Array(9);
/** Stands in for the map of a tile whose map lives on the GPU only. */
const NO_MAP = new Uint16Array(0);
const byDistance = (a: Tile, b: Tile): number => a.dist - b.dist;
