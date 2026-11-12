/**
 * Model cache of the objects part. Every model is loaded once and kept as a template; what is
 * drawn are clones that share the template's geometry and materials. A model that fails to load
 * is replaced by a plain stand-in of the right size, with one warning per key.
 */
import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { modelUrl } from '../assets.ts';

/** Every lit material of the part, so the sky reflection reaches all of them, clones included. */
export class MaterialRegistry {
  private readonly all = new Set<MeshStandardMaterial>();
  private env: Texture | null = null;

  has(m: MeshStandardMaterial): boolean {
    return this.all.has(m);
  }

  add<T extends MeshStandardMaterial>(m: T): T {
    if (this.all.has(m)) return m;
    this.all.add(m);
    // The renderer tone-maps once, in its final pass.
    m.toneMapped = false;
    m.envMap = this.env;
    return m;
  }

  /** Hands the prefiltered sky to every material; cheap when it has not changed. */
  setEnv(tex: Texture | null): void {
    if (tex === this.env) return;
    this.env = tex;
    // The renderer notices a changed environment map by itself and picks the matching program.
    for (const m of this.all) m.envMap = tex;
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    this.all.clear();
  }
}

/** An engine nozzle: exit position in model space and the radius of the glowing disc. */
export interface Nozzle {
  readonly pos: Vector3;
  readonly radius: number;
}

/** An attitude thruster on the hull surface, firing along `dir` (pointing away from the hull). */
export interface Jet {
  readonly pos: Vector3;
  readonly dir: Vector3;
}

export interface Model {
  readonly key: string;
  /** Never added to a scene; `instantiate` clones it. */
  readonly template: Object3D;
  /** Radius of the sphere around the origin that contains the model, metres. */
  readonly radius: number;
  readonly engines: readonly Nozzle[];
  readonly lamps: readonly Vector3[];
  readonly jets: readonly Jet[];
  readonly standIn: boolean;
  /** Mean diffuse reflectance, for the point drawn when the model is too far away to resolve. */
  readonly albedo: number;
}

export const isEmissive = (m: { name: string }): boolean => m.name.startsWith('emissive');

const SOOT = new Color(0.035, 0.03, 0.027);

/**
 * Adapts the plain values the models are exported with to how they are lit here. Under a black
 * sky a metal has nothing to reflect but the sun's highlight, so painted hull plating is treated
 * as mostly paint; lamps get a dark housing, so one that is switched off does not shine in
 * sunlight; and the accent strips are taken down from signage to running lights.
 */
function tune(m: MeshStandardMaterial, cockpit: boolean): void {
  const n = m.name;
  if (n.startsWith('hull_primary') || n.startsWith('hull_accent')) m.metalness *= 0.4;
  else if (n.startsWith('hull_secondary')) m.metalness *= 0.6;
  else if (n.startsWith('emissive')) {
    m.color.multiplyScalar(n === 'emissive_engine' ? 0.03 : 0.12);
    if (n === 'emissive_accent') m.emissiveIntensity *= 0.5;
    if (n === 'emissive_engine') m.emissiveIntensity *= 0.22;
    // Instrument lighting fills half the pilot's view; it must not outshine what is outside.
    if (cockpit) m.emissiveIntensity *= 0.45;
  }
}

function standIn(key: string, size: number): Object3D {
  const root = new Group();
  root.name = key;
  // A cockpit stand-in would only block the pilot's view.
  if (size <= 0) return root;
  const geo: BufferGeometry = key.startsWith('asteroid')
    ? new IcosahedronGeometry(size, 1)
    : key.startsWith('ship_')
      ? new BoxGeometry(size * 0.9, size * 0.4, size * 1.7)
      : new BoxGeometry(size * 1.1, size * 1.1, size * 1.1);
  const mat = new MeshStandardMaterial({ color: 0x565a60, roughness: 0.8, metalness: 0.2, flatShading: true });
  mat.name = 'stand_in';
  root.add(new Mesh(geo, mat));
  return root;
}

export class ModelLibrary {
  readonly materials = new MaterialRegistry();
  private readonly loader = new GLTFLoader();
  private readonly models = new Map<string, Model>();
  private readonly pending = new Map<string, Promise<Model>>();
  private readonly wrecks = new Map<MeshStandardMaterial, MeshStandardMaterial>();
  private readonly geometries = new Set<BufferGeometry>();

  /** The model when it has finished loading (possibly as a stand-in). */
  get(key: string): Model | undefined {
    return this.models.get(key);
  }

  /** Starts loading a model that turned up at run time; `size` is the stand-in size in metres. */
  request(key: string, size: number): void {
    if (!this.models.has(key) && !this.pending.has(key)) void this.load(key, size);
  }

  /** Loads a model. Never rejects: a failure yields a stand-in. */
  load(key: string, size: number): Promise<Model> {
    const have = this.models.get(key);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetch(key, size);
      this.pending.set(key, p);
    }
    return p;
  }

  private async fetch(key: string, size: number): Promise<Model> {
    let model: Model;
    try {
      const gltf = await this.loader.loadAsync(modelUrl(key));
      model = this.prepare(key, gltf.scene, false);
    } catch (err) {
      console.warn(`objects: model "${key}" did not load, drawing a stand-in`, err);
      model = this.prepare(key, standIn(key, size), true);
    }
    this.models.set(key, model);
    this.pending.delete(key);
    return model;
  }

  private prepare(key: string, template: Object3D, isStandIn: boolean): Model {
    template.updateMatrixWorld(true);
    const enginePos: Vector3[] = [];
    const lamps: Vector3[] = [];
    const glow: Mesh[] = [];
    const solid: Mesh[] = [];
    let albedoSum = 0;
    let albedoWeight = 0;

    template.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        const mat = mesh.material as MeshStandardMaterial;
        this.geometries.add(mesh.geometry);
        if (mat.isMeshStandardMaterial && !this.materials.has(mat)) tune(this.materials.add(mat), key.startsWith('cockpit'));
        const emissive = isEmissive(mat);
        mesh.castShadow = !emissive && mat.name !== 'portal';
        mesh.receiveShadow = !emissive && mat.name !== 'portal';
        if (mat.name === 'emissive_engine') glow.push(mesh);
        if (!emissive && mat.name !== 'portal') {
          solid.push(mesh);
          const w = mesh.geometry.getAttribute('position')?.count ?? 1;
          albedoSum += w * (0.2126 * mat.color.r + 0.7152 * mat.color.g + 0.0722 * mat.color.b);
          albedoWeight += w;
        }
      } else if (/^engine_\d/.test(o.name)) {
        enginePos.push(o.getWorldPosition(new Vector3()));
      } else if (/^light_\d/.test(o.name)) {
        lamps.push(o.getWorldPosition(new Vector3()));
      }
    });

    const box = new Box3().setFromObject(template);
    const radius = box.isEmpty() ? 1 : Math.max(box.min.length(), box.max.length());
    const engines = nozzles(enginePos, glow, radius);
    const jets = key.startsWith('ship_') && !isStandIn ? attitudeJets(solid, box) : [];
    // The baked occlusion in the vertex colours takes roughly a fifth off the base colour.
    const albedo = albedoWeight > 0 ? (albedoSum / albedoWeight) * 0.8 : 0.2;
    return { key, template, radius, engines, lamps, jets, standIn: isStandIn, albedo };
  }

  /** A fresh copy of the model that shares its geometry and materials. Its nodes never move. */
  instantiate(model: Model): Object3D {
    const copy = model.template.clone(true);
    copy.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    return copy;
  }

  /** The burnt-out version of a hull material: sooty, rough, with every lamp dead. */
  wreckMaterial(src: MeshStandardMaterial): MeshStandardMaterial {
    let m = this.wrecks.get(src);
    if (!m) {
      m = src.clone();
      if (isEmissive(src)) {
        m.emissiveIntensity = 0;
        m.color.copy(SOOT);
      } else {
        m.color.multiplyScalar(0.3).lerp(SOOT, 0.55);
        m.metalness *= 0.35;
      }
      m.roughness = 0.94;
      m.envMapIntensity = 0.3;
      this.wrecks.set(src, m);
      this.materials.add(m);
    }
    return m;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.clear();
    this.materials.dispose();
    this.models.clear();
    this.wrecks.clear();
  }
}

/**
 * Pairs every engine empty with the radius of the glowing disc around it, measured from the
 * vertices of the engine-glow meshes nearest to it.
 */
function nozzles(positions: Vector3[], glow: Mesh[], modelRadius: number): Nozzle[] {
  const radii = positions.map(() => 0);
  const v = new Vector3();
  for (const mesh of glow) {
    const attr = mesh.geometry.getAttribute('position');
    if (!attr) continue;
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
      let best = -1;
      let bestDist = Infinity;
      for (let k = 0; k < positions.length; k++) {
        const d = v.distanceToSquared(positions[k]!);
        if (d < bestDist) { bestDist = d; best = k; }
      }
      if (best < 0) continue;
      const p = positions[best]!;
      const r = Math.hypot(v.x - p.x, v.y - p.y);
      if (r > radii[best]!) radii[best] = r;
    }
  }
  const fallback = Math.max(0.08, modelRadius * 0.05);
  return positions.map((pos, i) => ({ pos, radius: radii[i]! > 0 ? Math.min(radii[i]!, modelRadius * 0.25) : fallback }));
}

/**
 * Finds places for attitude thrusters by casting rays at the hull: fore and aft on each side,
 * above and below, plus a retro pair at the nose. The jets sit on the real surface, so their
 * exhaust starts at the hull and not in empty space.
 */
function attitudeJets(solid: Mesh[], box: Box3): Jet[] {
  const jets: Jet[] = [];
  if (!solid.length || box.isEmpty()) return jets;
  const ray = new Raycaster();
  const origin = new Vector3();
  const dir = new Vector3();
  const reach = box.min.distanceTo(box.max) + 1;
  const cy = (box.min.y + box.max.y) / 2;
  const fore = box.min.z * 0.55;
  const aft = box.max.z * 0.55;
  const cast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void => {
    // The ray starts outside the hull and flies inward; the jet fires the opposite way.
    origin.set(ox - dx * reach, oy - dy * reach, oz - dz * reach);
    dir.set(dx, dy, dz);
    ray.set(origin, dir);
    ray.far = reach * 2;
    const hit = ray.intersectObjects(solid, false)[0];
    if (hit) jets.push({ pos: hit.point.clone(), dir: new Vector3(-dx, -dy, -dz) });
  };
  for (const z of [fore, aft]) {
    cast(0, cy, z, 1, 0, 0);
    cast(0, cy, z, -1, 0, 0);
    cast(0, cy, z, 0, 1, 0);
    cast(0, cy, z, 0, -1, 0);
  }
  const side = Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * 0.3;
  cast(side, cy, 0, 0, 0, 1);
  cast(-side, cy, 0, 0, 0, 1);
  return jets;
}
