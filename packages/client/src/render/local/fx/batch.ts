/**
 * The drawing primitive under most effects: a pool of instanced quads that is refilled every frame
 * and drawn in one call. Each instance carries three vec4 attributes; the subclasses decide what
 * they mean.
 */
import {
  AddEquation, BufferAttribute, CustomBlending, DoubleSide, DynamicDrawUsage, InstancedBufferGeometry,
  InstancedInterleavedBuffer, InterleavedBufferAttribute, Mesh, OneFactor, ShaderMaterial, Vector2, ZeroFactor,
} from 'three';
import type { Camera, ShaderMaterialParameters, WebGLRenderer } from 'three';

/**
 * Material settings of everything that emits light: added onto the colour buffer, hidden behind
 * solid objects, never writing depth, and leaving the alpha of the target alone.
 */
export const ADDITIVE: ShaderMaterialParameters = {
  transparent: true, depthTest: true, depthWrite: false, toneMapped: false, side: DoubleSide,
  blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
  blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
};

const size = new Vector2();

/** Width of one pixel of the current render target, in metres at one metre from the camera. */
export function pixelAngle(renderer: WebGLRenderer, camera: Camera): number {
  const target = renderer.getRenderTarget();
  const height = target ? target.height : renderer.getDrawingBufferSize(size).y;
  return 2 / (camera.projectionMatrix.elements[5]! * Math.max(1, height));
}

/** Floats per instance. */
export const STRIDE = 12;

export class QuadBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  protected readonly data: Float32Array;
  protected count = 0;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly range = { start: 0, count: 0 };

  constructor(protected readonly max: number, names: readonly [string, string, string], vertexShader: string, fragmentShader: string) {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.data = new Float32Array(max * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
    names.forEach((name, i) => geometry.setAttribute(name, new InterleavedBufferAttribute(this.buffer, 4, i * 4)));
    geometry.instanceCount = 0;

    // The shaders keep thin and distant shapes at least a pixel wide, for which they need the pixel size.
    const uPix = { value: 0.001 };
    const material = new ShaderMaterial({ ...ADDITIVE, uniforms: { uPix }, vertexShader, fragmentShader });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      uPix.value = pixelAngle(renderer, camera);
      material.uniformsNeedUpdate = true;
    };
  }

  /** Empties the batch at the start of a frame. */
  begin(): void {
    this.count = 0;
  }

  /** Offset of the next instance in `data`, or -1 when the batch is full. */
  protected next(): number {
    return this.count < this.max ? this.count++ * STRIDE : -1;
  }

  /** Uploads what was written this frame. */
  end(): void {
    const n = this.count;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    this.range.count = n * STRIDE;
    const ranges = this.buffer.updateRanges;
    if (ranges.length === 0) ranges.push(this.range);
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
