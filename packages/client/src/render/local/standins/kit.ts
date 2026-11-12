/**
 * Geometry kit for the procedural stand-in models. Parts are collected per material name and
 * merged into one mesh per material, so a stand-in costs a handful of draw calls. Stand-ins use
 * the same conventions as the GLB models (material names, `engine_N` / `hardpoint_N` / `light_N` /
 * `dock_N` empties), so the rest of the layer treats both alike.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type V3 = [number, number, number];

/** One cross-section of a lofted hull: a chamfered rectangle in the XY plane at `z`. */
export interface Section {
  z: number;
  /** Full width and height. */
  w: number;
  h: number;
  x?: number;
  y?: number;
  /** Width of the top and bottom edge as a fraction of `w` (1 = rectangle, smaller = sloped flanks). */
  tw?: number;
  bw?: number;
}

/** Non-indexed geometry with `position` and `normal` only, so every part merges with every other. */
function normalise(geo: BufferGeometry): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/** Reverses the winding of a non-indexed geometry in place. */
function flipWinding(g: BufferGeometry): BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as BufferAttribute;
    const arr = a.array as Float32Array;
    const n = a.itemSize;
    for (let i = 0; i + 3 * n <= arr.length; i += 3 * n) {
      for (let k = 0; k < n; k++) {
        const t = arr[i + n + k]!;
        arr[i + n + k] = arr[i + 2 * n + k]!;
        arr[i + 2 * n + k] = t;
      }
    }
  }
  return g;
}

/**
 * Skins a sequence of rings (each a flat xyz array with the same number of points) into a closed,
 * flat-shaded solid. The winding is fixed afterwards from the signed volume, so callers do not
 * have to care about ring orientation.
 */
export function skin(rings: number[][], closedLoop = false): BufferGeometry {
  const n = rings[0]!.length / 3;
  const pos: number[] = [];
  const tri = (a: number[], ai: number, b: number[], bi: number, c: number[], ci: number): void => {
    pos.push(a[ai * 3]!, a[ai * 3 + 1]!, a[ai * 3 + 2]!, b[bi * 3]!, b[bi * 3 + 1]!, b[bi * 3 + 2]!, c[ci * 3]!, c[ci * 3 + 1]!, c[ci * 3 + 2]!);
  };
  const last = closedLoop ? rings.length : rings.length - 1;
  for (let r = 0; r < last; r++) {
    const a = rings[r]!, b = rings[(r + 1) % rings.length]!;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      tri(a, k, a, k1, b, k1);
      tri(a, k, b, k1, b, k);
    }
  }
  if (!closedLoop) {
    const first = rings[0]!, end = rings[rings.length - 1]!;
    for (let k = 1; k + 1 < n; k++) {
      tri(first, 0, first, k + 1, first, k);
      tri(end, 0, end, k, end, k + 1);
    }
  }
  const g = new BufferGeometry();
  const arr = new Float32Array(pos);
  g.setAttribute('position', new BufferAttribute(arr, 3));
  // Six times the signed volume; negative means the faces point inward.
  let vol = 0;
  for (let i = 0; i < arr.length; i += 9) {
    const ax = arr[i]!, ay = arr[i + 1]!, az = arr[i + 2]!;
    const bx = arr[i + 3]!, by = arr[i + 4]!, bz = arr[i + 5]!;
    const cx = arr[i + 6]!, cy = arr[i + 7]!, cz = arr[i + 8]!;
    vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (vol < 0) flipWinding(g);
  g.computeVertexNormals();
  return g;
}

function sectionRing(s: Section, chamfer: number): number[] {
  const a = s.w / 2, b = s.h / 2, x = s.x ?? 0, y = s.y ?? 0;
  const cx = chamfer * s.w, cy = Math.min(chamfer * s.h, b);
  const xt = Math.max(0, a * (s.tw ?? 1) - cx), xb = Math.max(0, a * (s.bw ?? 1) - cx);
  return [
    x + xb, y - b, s.z, x + a, y - b + cy, s.z, x + a, y + b - cy, s.z, x + xt, y + b, s.z,
    x - xt, y + b, s.z, x - a, y + b - cy, s.z, x - a, y - b + cy, s.z, x - xb, y - b, s.z,
  ];
}

/** A hull lofted through chamfered cross-sections along Z. */
export function loft(sections: Section[], chamfer = 0.2): BufferGeometry {
  return skin(sections.map((s) => sectionRing(s, chamfer)));
}

/** A chamfered box centred on the origin. */
export function box(w: number, h: number, d: number, chamfer = 0.08): BufferGeometry {
  return loft([{ z: -d / 2, w, h }, { z: d / 2, w, h }], chamfer);
}

export interface WingSpec {
  /** Centre of the root and tip chord. */
  root: V3;
  tip: V3;
  /** Chord (length along Z) at root and tip. */
  cr: number;
  ct: number;
  /** Thickness at root and tip. */
  tr: number;
  tt: number;
}

/** A tapered slab with sharp leading and trailing edges: wings, fins, radiators. */
export function wing(s: WingSpec): BufferGeometry {
  const span = new Vector3(s.tip[0] - s.root[0], s.tip[1] - s.root[1], s.tip[2] - s.root[2]);
  const n = new Vector3(0, 0, 1).cross(span).normalize();
  if (n.lengthSq() === 0) n.set(0, 1, 0);
  const ring = (p: V3, c: number, t: number): number[] => {
    const out: number[] = [];
    const pts: [number, number][] = [[-c / 2, 0], [-c * 0.18, t / 2], [c * 0.3, t / 2], [c / 2, 0], [c * 0.3, -t / 2], [-c * 0.18, -t / 2]];
    for (const [dz, dn] of pts) out.push(p[0] + n.x * dn, p[1] + n.y * dn, p[2] + dz);
    return out;
  };
  return skin([ring(s.root, s.cr, s.tr), ring(s.tip, s.ct, s.tt)]);
}

/** Cylinder along Z: radius `r0` at the front (-Z) end, `r1` at the rear, smooth-shaded. */
export function cyl(r0: number, r1: number, len: number, seg = 14, open = false): BufferGeometry {
  return normalise(new CylinderGeometry(r1, r0, len, seg, 1, open).rotateX(Math.PI / 2));
}

/** Cylinder along Y with radius `r0` at the bottom and `r1` at the top; `flat` gives faceted sides. */
export function cylY(r0: number, r1: number, h: number, seg = 16, flat = false): BufferGeometry {
  const g = normalise(new CylinderGeometry(r1, r0, h, seg, 1));
  if (flat) g.computeVertexNormals();
  return g;
}

export function sphere(r: number, w = 14, h = 10): BufferGeometry {
  return normalise(new SphereGeometry(r, w, h));
}

/** Disc facing +Z. */
export function disc(r: number, seg = 14): BufferGeometry {
  return normalise(new CircleGeometry(r, seg));
}

/** Torus around the Y axis. */
export function torusY(major: number, minor: number, tube = 8, seg = 48, arc = Math.PI * 2): BufferGeometry {
  return normalise(new TorusGeometry(major, minor, tube, seg, arc).rotateX(Math.PI / 2));
}

/**
 * A ring with a chamfered rectangular cross-section swept around the Y axis.
 * `w` is the radial width, `h` the height along Y; `from`/`to` limit the arc (radians).
 */
export function ringY(major: number, w: number, h: number, seg = 48, chamfer = 0.2, from = 0, to = Math.PI * 2): BufferGeometry {
  const full = to - from >= Math.PI * 2 - 1e-6;
  const rings: number[][] = [];
  const count = full ? seg : seg + 1;
  for (let i = 0; i < count; i++) {
    const a = from + ((to - from) * i) / seg;
    const c = Math.cos(a), s = Math.sin(a);
    const flat = sectionRing({ z: 0, w, h }, chamfer);
    const ring: number[] = [];
    for (let k = 0; k < flat.length; k += 3) {
      const r = major + flat[k]!;
      ring.push(r * c, flat[k + 1]!, -r * s);
    }
    rings.push(ring);
  }
  return skin(rings, full);
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();

/** Transforms a geometry in place: scale, then rotate (XYZ Euler, radians), then translate. */
export function place(geo: BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): BufferGeometry {
  _q.setFromEuler(_e.set(rx, ry, rz));
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  geo.applyMatrix4(_m);
  return geo;
}

/** Mirror image across the YZ plane (a new geometry). */
export function mirrorX(geo: BufferGeometry): BufferGeometry {
  const g = normalise(geo).clone();
  g.applyMatrix4(_m.makeScale(-1, 1, 1));
  return flipWinding(g);
}

export class Kit {
  private readonly parts = new Map<string, BufferGeometry[]>();
  private readonly empties: Object3D[] = [];
  private readonly counters = new Map<string, number>();

  /** Adds a part. `tint` scales the material colour for this part through vertex colours. */
  add(mat: string, geo: BufferGeometry, tint = 1): this {
    const g = normalise(geo);
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).fill(tint), 3));
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(g);
    return this;
  }

  /** Adds a part and its mirror image across the YZ plane. */
  sym(mat: string, geo: BufferGeometry, tint = 1): this {
    const g = normalise(geo);
    const m = mirrorX(g);
    return this.add(mat, g, tint).add(mat, m, tint);
  }

  /** Adds an attachment point named `<prefix>_<n>`; `size` is stored for effects that scale with it. */
  empty(prefix: string, x: number, y: number, z: number, size = 0): Object3D {
    const i = this.counters.get(prefix) ?? 0;
    this.counters.set(prefix, i + 1);
    const o = new Object3D();
    o.name = `${prefix}_${i}`;
    o.position.set(x, y, z);
    if (size > 0) o.userData.size = size;
    this.empties.push(o);
    return o;
  }

  /** Merges the parts into one mesh per material. Materials are looked up by name. */
  build(materials: Record<string, Material>, name: string): Group {
    const group = new Group();
    group.name = name;
    for (const [mat, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const material = materials[mat];
      if (!material) throw new Error(`stand-in ${name}: unknown material ${mat}`);
      const mesh = new Mesh(merged, material);
      mesh.name = mat;
      group.add(mesh);
    }
    for (const e of this.empties) group.add(e);
    return group;
  }
}
