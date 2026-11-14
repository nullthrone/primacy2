/**
 * The star as a directional light plus a weak ambient term, once per local scene. The sun casts a
 * shadow from an orthographic box that is locked to one focus object (a station, the pilot's ship,
 * the cockpit), so its texels do not crawl while the camera moves. Outside the cockpit a very weak
 * light at the camera keeps a hull readable when the sun is behind it.
 *
 * The cockpit has light of its own (`CabinGlow`): most of the time the sun stands behind or below
 * the pilot and reaches nothing in view, and then the instruments are what the cabin is seen by.
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
  /** Light thrown back by the place itself while the sun shines into it; added to the ambient term each frame. */
  bounce = 0;
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
    this.ambient.intensity = light.ambient * AMBIENT_GAIN + this.fill + this.bounce;
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

/** Colour of the instrument lighting as it falls on the panels: the cyan of the strips, thinned toward white. */
const GLOW_COLOR = 0xb2d6ee;
/**
 * Where the glow comes from, in the axes of the cockpit model (the pilot's eye at the origin,
 * ahead toward -Z, metres), and how strong each source is. A source stands for a group of lit
 * strips and keys and sits a hand's breadth off them, so the light falls off across the panel
 * they are set in and is gone a metre away:
 *   the light line along the foot of the windshield, three sections
 *   the displays on the instrument face, centre and both wings
 *   the keys of the two side consoles
 */
const GLOW: readonly (readonly [number, number, number, number])[] = [
  [0, -0.12, -1.0, 1],
  [-0.9, -0.12, -0.9, 0.7],
  [0.9, -0.12, -0.9, 0.7],
  [0, -0.5, -0.36, 1.1],
  [-0.92, -0.28, -0.16, 0.8],
  [0.92, -0.28, -0.16, 0.8],
];
/** Luminous intensity of a source of strength one, scene-referred. */
const GLOW_LEVEL = 0.075;
/** Reach of a source, metres; three lets the light run out smoothly toward it. */
const GLOW_REACH = 2.4;
/** Share of the sunlight entering through the canopy that the cabin throws back onto itself, as ambient light. */
const BOUNCE = 0.025;

/**
 * The cockpit's own light: the glow of the instruments as a few small cool lights without
 * shadows, fixed to the cabin, and the measure of sunlight the cabin scatters when the sun shines
 * in through the canopy. Both are far below what lights the world outside, so space stays the
 * brightest thing in view, and neither softens the shadows the sun throws across the dashboard.
 */
export class CabinGlow {
  private readonly lamps: PointLight[] = [];

  /** `cabin` is the group the cockpit model hangs in; the lamps turn with it. */
  constructor(cabin: Object3D) {
    for (const [x, y, z, level] of GLOW) {
      const lamp = new PointLight(GLOW_COLOR, GLOW_LEVEL * level, GLOW_REACH, 2);
      lamp.position.set(x, y, z);
      this.lamps.push(lamp);
      cabin.add(lamp);
    }
  }

  /**
   * Ambient light to add in the cabin for a sun of strength `sun` that stands at (x, y, z) in the
   * cabin's own axes (a unit vector; ahead is -Z, up is +Y). The canopy opens ahead, above and to
   * the sides; from behind and from below the hull is in the way.
   */
  static bounce(sun: number, x: number, y: number, z: number): number {
    const open = Math.min(1, Math.max(0, 0.45 - 0.9 * z + 0.7 * y - 0.15 * Math.abs(x)));
    return sun * open * BOUNCE;
  }
}
