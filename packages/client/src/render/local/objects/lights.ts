/**
 * The star as a directional light plus a weak ambient term, once per local scene. The sun casts a
 * shadow from an orthographic box that is locked to one focus object (a station, the pilot's ship,
 * the cockpit), so its texels do not crawl while the camera moves. Outside the cockpit a very weak
 * light at the camera keeps a hull readable when the sun is behind it.
 */
import { AmbientLight, DirectionalLight, PCFShadowMap, PointLight, type Object3D, type WebGLRenderer } from 'three';
import type { Lighting } from '../../../contracts.ts';

/** Scene-referred gain of the ambient level: low, so shadows stay near black but keep their shape. */
const AMBIENT_GAIN = 1;
/**
 * Strength of the eye light as a fraction of the sun. Enough that a hull seen with the sun behind
 * it keeps its shape against black space, far too little to soften the hard-lit look.
 */
const EYE_GAIN = 0.04;

export class SunRig {
  readonly sun = new DirectionalLight(0xffffff, 1);
  readonly ambient = new AmbientLight(0xffffff, 0);
  /**
   * A faint neutral light at the camera, which is the origin of the scene. It casts no shadow and
   * does not fall off with distance, so surfaces facing the viewer are never fully black.
   */
  readonly eye = new PointLight(0xffffff, 0, 0, 0);
  private mapSize = 0;
  private half = 0;
  private depth = 0;
  private fade = 1;

  /** `fill` is ambient light of the place itself, such as the glow of a cockpit's instruments. */
  constructor(parent: Object3D, private readonly fill = 0) {
    parent.add(this.sun, this.sun.target, this.ambient);
    // A place with a glow of its own, such as the cockpit, is readable without the eye light.
    if (fill === 0) parent.add(this.eye);
    this.sun.shadow.radius = 1;
    this.sun.shadow.camera.near = 0;
  }

  static prepare(renderer: WebGLRenderer): void {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
  }

  /**
   * Sets both lights and aims the sun and its shadow box at a focus point (camera-relative,
   * metres). `half` is the half-width of the box across the light direction and `depth` how far
   * toward the sun it reaches for shadow casters; `mapSize` 0 turns the shadow off.
   */
  update(light: Lighting, fx: number, fy: number, fz: number, half: number, depth: number, mapSize: number, dt: number): void {
    const sun = this.sun;
    sun.color.setRGB(light.sunColor[0], light.sunColor[1], light.sunColor[2]);
    sun.intensity = light.sunIntensity;
    this.ambient.intensity = light.ambient * AMBIENT_GAIN + this.fill;
    this.eye.intensity = light.sunIntensity * EYE_GAIN;

    const d = light.sunDir;
    sun.target.position.set(fx, fy, fz);
    sun.position.set(fx + d[0] * depth, fy + d[1] * depth, fz + d[2] * depth);

    const on = mapSize > 0 && half > 0;
    if (sun.castShadow !== on) sun.castShadow = on;
    if (!on) {
      this.half = 0;
      return;
    }

    const shadow = sun.shadow;
    if (mapSize !== this.mapSize) {
      this.mapSize = mapSize;
      shadow.mapSize.set(mapSize, mapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
    if (half !== this.half || depth !== this.depth) {
      // A different focus: the shadow fades back in instead of popping.
      if (Math.abs(half - this.half) > 0.25 * half) this.fade = 0;
      this.half = half;
      this.depth = depth;
      const cam = shadow.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.far = depth + half * 1.5;
      cam.updateProjectionMatrix();
      // Both offsets are a texel and a half in world units, whatever the size of the box.
      const texel = (2 * half) / mapSize;
      shadow.normalBias = texel * 1.5;
      shadow.bias = (-texel * 1.5) / cam.far;
    }
    this.fade = Math.min(1, this.fade + dt * 2.5);
    shadow.intensity = this.fade;
  }
}
