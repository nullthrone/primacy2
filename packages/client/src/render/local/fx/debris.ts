/**
 * Wreckage thrown out by an explosion: solid chunks that tumble apart on straight lines, lit by the
 * sun and glowing from the heat of the blast for their first moments. The shapes come from the
 * models `debris_0` .. `debris_3` when those exist and from generated shards otherwise.
 */
import {
  BufferGeometry, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Mesh,
  OctahedronGeometry, ShaderMaterial, TetrahedronGeometry, Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Vec3 } from '@primacy2/shared';
import type { Lighting } from '../../../contracts.ts';
import { modelUrl } from '../assets.ts';
import { TAU, hash2, seeded } from '../util.ts';
import { Pool, rand, randDir, type Frame } from './core.ts';

const VERTEX = /* glsl */ `
attribute float iHeat;
varying vec3 vN;
varying float vHeat;

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vN = mat3(m) * normal; // chunks are scaled evenly, so this only needs normalising
  vHeat = iHeat;
  gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform float uAmbient;
varying vec3 vN;
varying float vHeat;

void main() {
  vec3 n = normalize(vN);
  vec3 albedo = vec3(0.2, 0.2, 0.21);
  vec3 lit = albedo * (uSun * max(dot(n, uSunDir), 0.0) + uAmbient);
  // Torn metal comes out of the blast glowing and cools through orange to dull red.
  vec3 glow = mix(vec3(1.0, 0.12, 0.02), vec3(1.0, 0.55, 0.2), vHeat) * vHeat * vHeat * 5.0;
  gl_FragColor = vec4(lit + glow, 1.0);
}`;

interface Chunk {
  shape: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Unit spin axis, angle and rate in rad/s. */
  ax: number; ay: number; az: number; angle: number; spin: number;
  size: number;
  age: number; life: number;
}

const SHAPES = 4;
const PER_SHAPE = 20;
const D: Vec3 = [0, 0, 0];

/** A jagged plate or splinter with a bounding radius of one metre. */
function shard(seed: number): BufferGeometry {
  const rnd = seeded(seed);
  const base = seed % 3 === 0 ? new TetrahedronGeometry(1, 1) : seed % 3 === 1 ? new OctahedronGeometry(1, 0) : new IcosahedronGeometry(1, 0);
  // These geometries repeat their corner points per face, so the displacement is derived from the
  // position itself and a shared corner stays shared.
  const sx = 0.55 + 0.45 * rnd(), sy = 0.12 + 0.3 * rnd(), sz = 0.4 + 0.6 * rnd();
  const pos = base.getAttribute('position');
  let far = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = Math.round(x * 97) * 8191 + Math.round(y * 97) * 131 + Math.round(z * 97);
    const px = (x + (hash2(key, seed) - 0.5) * 0.6) * sx;
    const py = (y + (hash2(key, seed + 11) - 0.5) * 0.6) * sy;
    const pz = (z + (hash2(key, seed + 23) - 0.5) * 0.6) * sz;
    pos.setXYZ(i, px, py, pz);
    far = Math.max(far, Math.hypot(px, py, pz));
  }
  base.scale(1 / far, 1 / far, 1 / far);
  base.computeVertexNormals();
  return base;
}

/** The largest mesh of a model file as one geometry, or null when the file is not there or not a model. */
async function loadShape(loader: GLTFLoader, key: string): Promise<BufferGeometry | null> {
  try {
    const res = await fetch(modelUrl(key));
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    // The dev server answers a missing file with its HTML page; a binary glTF starts with "glTF".
    if (data.byteLength < 12 || new DataView(data).getUint32(0, true) !== 0x46546c67) return null;
    const gltf = await loader.parseAsync(data, '');
    gltf.scene.updateMatrixWorld(true);
    let best: Mesh | null = null;
    gltf.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (!best || mesh.geometry.getAttribute('position').count > best.geometry.getAttribute('position').count) best = mesh;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    });
    const found = best as Mesh | null;
    if (!found) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', found.geometry.getAttribute('position').clone());
    const normal = found.geometry.getAttribute('normal');
    if (normal) geometry.setAttribute('normal', normal.clone());
    geometry.setIndex(found.geometry.getIndex()?.clone() ?? null);
    geometry.applyMatrix4(found.matrixWorld);
    if (!normal) geometry.computeVertexNormals();
    return geometry;
  } catch {
    return null;
  }
}

export class Debris {
  readonly group = new Group();
  private readonly pool = new Pool<Chunk>(SHAPES * PER_SHAPE, () => ({
    shape: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 1, az: 0, angle: 0, spin: 0, size: 1, age: 0, life: 1,
  }));
  private readonly sunDir = new Vector3(0, 1, 0);
  private readonly sun = new Vector3(1, 1, 1);
  private readonly ambient = { value: 0.02 };
  private readonly material = new ShaderMaterial({
    toneMapped: false,
    uniforms: { uSunDir: { value: this.sunDir }, uSun: { value: this.sun }, uAmbient: this.ambient },
    vertexShader: VERTEX, fragmentShader: FRAGMENT,
  });
  private readonly meshes: InstancedMesh<BufferGeometry, ShaderMaterial>[] = [];
  private readonly heats: InstancedBufferAttribute[] = [];
  private readonly counts = new Int32Array(SHAPES);
  private disposed = false;

  constructor() {
    for (let s = 0; s < SHAPES; s++) this.setShape(s, shard(s + 5));
  }

  /** Looks for the debris models and swaps them in for the generated shards. Never fails. */
  async load(): Promise<void> {
    const loader = new GLTFLoader();
    for (let s = 0; s < SHAPES; s++) {
      const geometry = await loadShape(loader, `debris_${s}`);
      // In a built game a missing model costs a failed request, so stop asking after the first miss.
      if (!geometry) return;
      if (this.disposed) { geometry.dispose(); return; }
      this.setShape(s, geometry);
    }
  }

  private setShape(s: number, geometry: BufferGeometry): void {
    const old = this.meshes[s];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      old.dispose();
    }
    const heat = new InstancedBufferAttribute(new Float32Array(PER_SHAPE), 1);
    heat.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iHeat', heat);
    const mesh = new InstancedMesh(geometry, this.material, PER_SHAPE);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    this.meshes[s] = mesh;
    this.heats[s] = heat;
    this.group.add(mesh);
  }

  /** Throws `count` chunks out of a blast of a ship of `radius` metres at an anchor-relative point. */
  burst(x: number, y: number, z: number, radius: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const c = this.pool.take();
      if (!c) return;
      randDir(D);
      const v = radius * rand(0.8, 4.5);
      c.shape = i % SHAPES;
      c.x = x + D[0] * radius * 0.3; c.y = y + D[1] * radius * 0.3; c.z = z + D[2] * radius * 0.3;
      c.vx = D[0] * v; c.vy = D[1] * v; c.vz = D[2] * v;
      randDir(D);
      c.ax = D[0]; c.ay = D[1]; c.az = D[2];
      c.angle = rand(0, TAU);
      c.spin = rand(1.5, 7);
      c.size = radius * rand(0.1, 0.28);
      c.age = 0;
      c.life = rand(3.5, 6);
    }
  }

  update(f: Frame, light: Lighting): void {
    this.sunDir.set(light.sunDir[0], light.sunDir[1], light.sunDir[2]);
    // Matches a lit diffuse surface of the objects part: irradiance over pi.
    const k = light.sunIntensity / Math.PI;
    this.sun.set(light.sunColor[0] * k, light.sunColor[1] * k, light.sunColor[2] * k);
    this.ambient.value = 0.03 * light.ambient;

    const items = this.pool.items;
    this.counts.fill(0);
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const c = items[i]!;
      c.age += f.dt;
      if (c.age >= c.life) { this.pool.free(i); continue; }
      c.x += c.vx * f.dt; c.y += c.vy * f.dt; c.z += c.vz * f.dt;
      c.angle += c.spin * f.dt;
      const slot = this.counts[c.shape]!;
      if (slot >= PER_SHAPE) continue;
      this.counts[c.shape] = slot + 1;

      // Rotation about the spin axis, scaled; the chunk shrinks away at the end of its life.
      const left = (c.life - c.age) / 0.8;
      const s = c.size * (left < 1 ? left : 1);
      const cs = Math.cos(c.angle), sn = Math.sin(c.angle), t = 1 - cs;
      const m = this.meshes[c.shape]!.instanceMatrix.array;
      const o = slot * 16;
      m[o] = (t * c.ax * c.ax + cs) * s; m[o + 1] = (t * c.ax * c.ay + sn * c.az) * s; m[o + 2] = (t * c.ax * c.az - sn * c.ay) * s; m[o + 3] = 0;
      m[o + 4] = (t * c.ax * c.ay - sn * c.az) * s; m[o + 5] = (t * c.ay * c.ay + cs) * s; m[o + 6] = (t * c.ay * c.az + sn * c.ax) * s; m[o + 7] = 0;
      m[o + 8] = (t * c.ax * c.az + sn * c.ay) * s; m[o + 9] = (t * c.ay * c.az - sn * c.ax) * s; m[o + 10] = (t * c.az * c.az + cs) * s; m[o + 11] = 0;
      m[o + 12] = c.x + f.zx; m[o + 13] = c.y + f.zy; m[o + 14] = c.z + f.zz; m[o + 15] = 1;
      this.heats[c.shape]!.array[slot] = Math.exp(-c.age / 0.9);
    }
    for (let s = 0; s < SHAPES; s++) {
      const mesh = this.meshes[s]!;
      const n = this.counts[s]!;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        this.heats[s]!.needsUpdate = true;
      }
    }
  }

  clear(): void {
    this.pool.count = 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
  }
}
