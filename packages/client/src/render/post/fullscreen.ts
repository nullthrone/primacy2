import { Mesh, OrthographicCamera, PlaneGeometry, Scene } from 'three';
import type { Material, WebGLRenderTarget, WebGLRenderer } from 'three';

/** Vertex shader for a quad that covers the whole target; `vUv` runs 0..1. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Draws one material over a whole render target (or the canvas when the target is null). */
export class FullscreenPass {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh = new Mesh(new PlaneGeometry(2, 2));

  constructor() {
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: WebGLRenderer, material: Material, target: WebGLRenderTarget | null): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
