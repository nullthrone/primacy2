/**
 * The star as a directional light plus a weak ambient term, once per local scene. The sun casts a
 * shadow from an orthographic box that is locked to one focus object (a station, the pilot's ship,
 * the cockpit), so its texels do not crawl while the camera moves.
 */
import { AmbientLight, DirectionalLight, PCFShadowMap, type Object3D, type WebGLRenderer } from 'three';
import type { Lighting } from '../../../contracts.ts';

/** Scene-referred gain of the ambient level; kept low so shadows stay close to black. */
const AMBIENT_GAIN = 0.35;

export class SunRig {
  readonly sun = new DirectionalLight(0xffffff, 1);
  readonly ambient = new AmbientLight(0xffffff, 0);
  private mapSize = 0;
  private half = 0;
  private fade = 1;

  constructor(parent: Object3D) {
    parent.add(this.sun, this.sun.target, this.ambient);
    this.sun.shadow.radius = 1;
    this.sun.shadow.camera.near = 0;
  }

  static prepare(renderer: WebGLRenderer): void {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
  }

  /** Colour and intensity of both lights. */
  setLight(light: Lighting): void {
    this.sun.color.setRGB(light.sunColor[0], light.sunColor[1], light.sunColor[2]);
    this.sun.intensity = light.sunIntensity;
    this.ambient.intensity = light.ambient * AMBIENT_GAIN;
  }

  /**
   * Aims the light and its shadow box at a focus point (camera-relative, metres). `half` is the
   * half-width of the box across the light direction, `depth` how far toward the sun it reaches
   * for casters; `mapSize` 0 turns the shadow off.
   */
  aim(light: Lighting, fx: number, fy: number, fz: number, half: number, depth: number, mapSize: number, dt: number): void {
    const sun = this.sun;
    const d = light.sunDir;
    sun.target.position.set(fx, fy, fz);
    sun.position.set(fx + d[0] * depth, fy + d[1] * depth, fz + d[2] * depth);
    sun.target.updateMatrixWorld();

    const on = mapSize > 0 && half > 0;
    if (sun.castShadow !== on) sun.castShadow = on;
    if (!on) return;

    const shadow = sun.shadow;
    if (mapSize !== this.mapSize) {
      this.mapSize = mapSize;
      shadow.mapSize.set(mapSize, mapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
    if (half !== this.half) {
      // A different focus: the shadow fades back in instead of popping.
      if (this.half > 0 && Math.abs(half - this.half) > 0.25 * this.half) this.fade = 0;
      this.half = half;
      const cam = shadow.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.far = depth + half * 1.5;
      cam.updateProjectionMatrix();
      // Offsets along the surface normal in world units: about a texel and a half.
      shadow.normalBias = (2 * half / mapSize) * 1.5;
      shadow.bias = -0.00015;
    }
    this.fade = Math.min(1, this.fade + dt * 2.5);
    shadow.intensity = this.fade;
  }
}
