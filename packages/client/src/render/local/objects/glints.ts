/**
 * Points of light: navigation lamps, and whole ships and stations once they are too far away to
 * resolve. Everything is one `Points` draw whose buffers are refilled each frame. Sizes are worked
 * out on the CPU in device pixels, so a point never gets smaller than the screen can show.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
  type Vector3,
} from 'three';
import type { Lighting } from '../../../contracts.ts';

const CAPACITY = 1024;
/** Smallest sprite radius in pixels that still reads as a steady point. */
const MIN_PX = 1.3;
const MAX_PX = 160;
/** Points beyond the far plane (400 km) are drawn at this distance in their direction. */
const FAR_CLAMP = 380_000;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 tint;
attribute float psize;
varying vec3 vTint;
void main() {
  vTint = tint;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  gl_PointSize = psize;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vTint;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float q = dot(c, c);
  if (q > 1.0) discard;
  // A bright core over half the sprite, fading to nothing at its edge.
  float a = exp(-q * 6.0) * (1.0 - q);
  gl_FragColor = vec4(vTint * a, 1.0);
}`;

export class Glints {
  readonly points: Points;
  private readonly pos = new Float32Array(CAPACITY * 3);
  private readonly tint = new Float32Array(CAPACITY * 3);
  private readonly size = new Float32Array(CAPACITY);
  private readonly geo = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private count = 0;
  private sunX = 0;
  private sunY = 0;
  private sunZ = 1;
  private sunR = 1;
  private sunG = 1;
  private sunB = 1;

  constructor() {
    const dyn = (a: Float32Array, n: number): BufferAttribute => {
      const attr = new BufferAttribute(a, n);
      attr.setUsage(DynamicDrawUsage);
      return attr;
    };
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('tint', dyn(this.tint, 3));
    this.geo.setAttribute('psize', dyn(this.size, 1));
    this.mat = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  begin(light: Lighting): void {
    this.count = 0;
    this.sunX = light.sunDir[0];
    this.sunY = light.sunDir[1];
    this.sunZ = light.sunDir[2];
    this.sunR = light.sunColor[0] * light.sunIntensity;
    this.sunG = light.sunColor[1] * light.sunIntensity;
    this.sunB = light.sunColor[2] * light.sunIntensity;
  }

  private push(x: number, y: number, z: number, r: number, g: number, b: number, px: number): void {
    const i = this.count;
    if (i >= CAPACITY) return;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.tint[i * 3] = r;
    this.tint[i * 3 + 1] = g;
    this.tint[i * 3 + 2] = b;
    // The shader's core covers half the sprite radius; the point size is a diameter.
    this.size[i] = Math.min(MAX_PX, px) * 4;
    this.count = i + 1;
  }

  /**
   * A lamp of `radius` metres at a camera-relative position. Up close it has its real size; far
   * away it stays a point and dims with distance, slower than physics would have it so that a
   * strobe still marks its ship or station from kilometres away.
   */
  addLamp(p: Vector3, r: number, g: number, b: number, radius: number, radiance: number, pxPerRad: number): void {
    const dist = p.length();
    if (dist < 0.5) return;
    const px = (radius / dist) * pxPerRad;
    const k = radiance * Math.min(1, Math.pow(px / MIN_PX, 0.8));
    if (k < 0.02) return;
    // Pulled a little toward the camera so the lamp is not buried in the surface it sits on.
    const pull = (dist > FAR_CLAMP ? FAR_CLAMP / dist : 1) * (1 - Math.min(0.5, (0.3 + 0.002 * dist) / dist));
    this.push(p.x * pull, p.y * pull, p.z * pull, r * k, g * k, b * k, Math.max(MIN_PX, px));
  }

  /**
   * A sunlit body of `radius` metres seen from `dist` metres as a single point: as bright as its
   * lit side, scaled by how much of a pixel it covers. `glow` is radiance of its own (windows,
   * lamps) that keeps a station findable on its night side; `fade` 0..1 blends the point in.
   */
  addBody(p: Vector3, dist: number, radius: number, albedo: number, glow: number, fade: number, pxPerRad: number): void {
    if (fade <= 0 || dist < 1) return;
    const px = (radius / dist) * pxPerRad;
    const cosPhase = -(p.x * this.sunX + p.y * this.sunY + p.z * this.sunZ) / dist;
    const lit = 0.5 + 0.5 * cosPhase;
    const cover = Math.min(1, (px / MIN_PX) * (px / MIN_PX));
    const k = (albedo / Math.PI) * lit * Math.sqrt(lit) * cover * fade;
    const own = glow * cover * fade;
    const r = this.sunR * k + own, g = this.sunG * k + own * 0.9, b = this.sunB * k + own * 0.75;
    if (r + g + b < 0.004) return;
    const s = dist > FAR_CLAMP ? FAR_CLAMP / dist : 1;
    this.push(p.x * s, p.y * s, p.z * s, r, g, b, Math.max(MIN_PX, px));
  }

  end(): void {
    this.geo.setDrawRange(0, this.count);
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('tint').needsUpdate = true;
    this.geo.getAttribute('psize').needsUpdate = true;
    this.points.visible = this.count > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
