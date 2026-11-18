/**
 * The asteroid field of the mining site the pilot is at: one instanced mesh per rock variant. The
 * models have a bounding radius of one metre and are scaled by each rock's radius; every rock
 * turns about its own axis. A rock that has been mined out is darker and a little smaller, as if
 * its bright crust had been stripped off.
 */
import {
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Mesh,
} from 'three';
import type { FieldView, FrameView } from '../../../contracts.ts';
import { TAU, smooth, wrap } from '../util.ts';
import type { ModelLibrary } from './models.ts';

const VARIANTS = 4;
/** Rocks smaller than this on screen (radius in pixels) are left out. */
const MIN_PX = 0.6;
const FAR_LIMIT = 390_000;

const pos = new Vector3();
const scale = new Vector3();
const axis = new Vector3();
const quat = new Quaternion();
const mat = new Matrix4();

export class Rocks {
  readonly group = new Group();
  private readonly meshes: (InstancedMesh | null)[] = [null, null, null, null];
  private readonly counts = [0, 0, 0, 0];
  private rocks: FieldView['rocks'] | null = null;

  constructor(private readonly lib: ModelLibrary) {}

  /** Sizes the instanced meshes for a field; runs when the pilot arrives at a different field. */
  private allocate(rocks: FieldView['rocks']): void {
    const need = [0, 0, 0, 0];
    for (let i = 0; i < rocks.length; i++) need[rocks[i]!.variant & 3]!++;
    for (let v = 0; v < VARIANTS; v++) {
      const old = this.meshes[v] ?? null;
      const want = need[v]!;
      if (old && old.instanceMatrix.count >= want) continue;
      if (old) {
        this.group.remove(old);
        old.dispose();
        this.meshes[v] = null;
      }
      if (!want) continue;
      const model = this.lib.get(`asteroid_${v}`);
      let source: Mesh | null = null;
      model?.template.traverse((o) => {
        if (!source && (o as Mesh).isMesh) source = o as Mesh;
      });
      const src = source as Mesh | null;
      if (!src) continue;
      const mesh = new InstancedMesh(src.geometry, src.material, Math.ceil(want / 64) * 64);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3).fill(1), 3);
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Instances are spread over kilometres; the mesh as a whole is never culled.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.meshes[v] = mesh;
      this.group.add(mesh);
    }
  }

  update(view: FrameView, pxPerRad: number): void {
    const field = view.field;
    if (!field || !field.rocks.length) {
      for (let v = 0; v < VARIANTS; v++) {
        const mesh = this.meshes[v];
        if (mesh) mesh.visible = false;
      }
      return;
    }
    if (field.rocks !== this.rocks) {
      this.rocks = field.rocks;
      this.allocate(field.rocks);
    }
    const rocks = field.rocks;
    const left = field.left;
    const ox = field.rel[0], oy = field.rel[1], oz = field.rel[2];
    this.counts.fill(0);

    for (let i = 0; i < rocks.length; i++) {
      const rock = rocks[i]!;
      const v = rock.variant & 3;
      const mesh = this.meshes[v];
      if (!mesh) continue;
      const x = ox + rock.pos[0], y = oy + rock.pos[1], z = oz + rock.pos[2];
      const dist = Math.hypot(x, y, z);
      if (dist > FAR_LIMIT || rock.radius * pxPerRad < MIN_PX * dist) continue;
      const n = this.counts[v]!;
      if (n >= mesh.instanceMatrix.count) continue;
      this.counts[v] = n + 1;

      const fresh = smooth(0.02, 0.4, left[i] ?? 1);
      pos.set(x, y, z);
      axis.set(rock.axis[0], rock.axis[1], rock.axis[2]);
      quat.setFromAxisAngle(axis, wrap(rock.phase + rock.spin * view.time, TAU));
      scale.setScalar(rock.radius * (0.86 + 0.14 * fresh));
      mat.compose(pos, quat, scale).toArray(mesh.instanceMatrix.array, n * 16);
      const tint = mesh.instanceColor!.array;
      tint[n * 3] = 0.34 + 0.66 * fresh;
      tint[n * 3 + 1] = 0.33 + 0.67 * fresh;
      tint[n * 3 + 2] = 0.34 + 0.66 * fresh;
    }

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      if (!mesh) continue;
      mesh.count = this.counts[v]!;
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v]?.dispose();
      this.meshes[v] = null;
    }
    this.group.clear();
    this.rocks = null;
  }
}
