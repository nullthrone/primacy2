import { AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import type { Group } from 'three';
import type { BodyView } from '../../contracts.ts';
import { GLSL_NOISE } from './glsl.ts';
import type { SpaceFrame, ViewParams } from './types.ts';

/**
 * Every body is drawn at this distance from the camera, scaled down by the same factor as its
 * position, so direction and apparent size are unchanged and float32 never sees metres to light-hours.
 */
export const SAFE_DIST = 1000;

/** What draws one celestial body. Its group's render order is its far-to-near rank. */
export interface Visual {
  readonly group: Group;
  update(body: BodyView, frame: SpaceFrame, params: ViewParams): void;
  dispose(): void;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Writes the body's compressed centre to `out` and returns the scale factor (scene units per metre). */
export function compress(body: BodyView, out: Vector3): number {
  const k = SAFE_DIST / Math.max(body.dist, 1);
  out.set(body.rel[0] * k, body.rel[1] * k, body.rel[2] * k);
  return k;
}

/** Material flags shared by everything in the celestial pass: painter's order, no depth buffer. */
export const NO_DEPTH = { transparent: true, depthTest: false, depthWrite: false } as const;

/** One quad for all camera-facing sprites and full-screen passes. */
export const QUAD = new PlaneGeometry(2, 2);

const GLOW_VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  vec4 mv = viewMatrix * vec4(uCenter, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;

// Radial glow: a tight core at the limb (or the centre of a point source) and a wide soft halo.
const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uCore;
uniform float uGain;
uniform float uSig;
uniform float uHalo;
uniform float uRays;
uniform float uTime;
varying vec2 vUv;
${GLSL_NOISE}
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float e = max(r - uCore, 0.0) / max(1.0 - uCore, 1e-3);
  float win = (1.0 - e) * (1.0 - e);
  float core = exp(-e * e / (uSig * uSig));
  float halo = uHalo / (1.0 + e * e * 180.0) + uHalo * 0.25 / (1.0 + e * e * 12.0);
  float rays = 1.0;
  if (uRays > 0.0) {
    vec2 dir = vUv / max(r, 1e-4);
    float a = gnoise(vec3(dir * 2.5, uTime * 0.05)) + 0.5 * gnoise(vec3(dir * 7.0, uTime * 0.08 + 4.0));
    rays = max(1.0 + uRays * a * smoothstep(0.0, 0.2, e), 0.0);
  }
  // Over the disc of a resolved star the sprite only adds a thin veil.
  float inside = mix(0.07, 1.0, smoothstep(uCore * 0.85, uCore, r));
  gl_FragColor = vec4(uColor * uGain * (core + halo * rays) * win * inside, 1.0);
}
`;

/** A camera-facing additive glow: the glare of a star, or a body too small to resolve. */
export class Glow {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(color: readonly [number, number, number], rays = 0) {
    this.material = new ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      uniforms: {
        uCenter: { value: new Vector3() }, uSize: { value: 1 }, uColor: { value: new Vector3(color[0], color[1], color[2]) },
        uCore: { value: 0 }, uGain: { value: 1 }, uSig: { value: 0.1 }, uHalo: { value: 0.3 }, uRays: { value: rays },
        uTime: { value: 0 },
      },
      blending: AdditiveBlending, ...NO_DEPTH,
    });
    this.mesh = new Mesh(QUAD, this.material);
    this.mesh.frustumCulled = false;
  }

  /**
   * @param sizePx half size of the sprite in pixels
   * @param corePx radius in pixels of the body's disc (0 for a point)
   * @param sigmaPx width of the bright core in pixels
   */
  set(center: Vector3, params: ViewParams, sizePx: number, corePx: number, sigmaPx: number, gain: number, halo: number): void {
    const u = this.material.uniforms;
    (u.uCenter!.value as Vector3).copy(center);
    u.uSize!.value = sizePx * params.pixAngle * SAFE_DIST;
    const core = Math.min(0.95, corePx / sizePx);
    u.uCore!.value = core;
    u.uSig!.value = sigmaPx / (sizePx * (1 - core));
    u.uGain!.value = gain;
    u.uHalo!.value = halo;
    u.uTime!.value = params.clock;
    this.mesh.visible = gain > 0.002;
  }

  dispose(): void {
    this.material.dispose();
  }
}

/**
 * Size and strength of a light source's glare from the flux reaching the camera
 * (in multiples of sunlight at 1 AU). Both are compressed: a sun at 1 AU dazzles, a star seen from
 * the outer system is still the brightest point in the sky.
 */
export function glare(flux: number, params: ViewParams): { sizePx: number; gain: number } {
  const l10 = Math.log10(Math.max(flux, 1e-12));
  const res = params.height / 1080;
  return {
    sizePx: Math.min(260, Math.max(6, 70 * Math.pow(10, 0.25 * l10))) * res,
    gain: Math.min(30, Math.max(3, 14 * Math.pow(10, 0.2 * l10))),
  };
}
