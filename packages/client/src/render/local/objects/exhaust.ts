/**
 * Engine exhaust in vacuum: a tight, faint, blue-white cone behind each nozzle that brightens and
 * lengthens with thrust, with a standing row of shock diamonds near the nozzle, and short puffs
 * from the attitude jets. No smoke and no flame: the gas is thin and only its hot core shows.
 *
 * All plumes of a frame are one instanced draw. Each instance is two quads: one stretched along the
 * plume axis and turned toward the camera, and a round glow at the nozzle that takes over when the
 * camera looks straight down the axis, where the first quad has no width.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  type Vector3,
} from 'three';

const CAPACITY = 384;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 iPosR;   // nozzle position (camera-relative), nozzle radius
attribute vec4 iAxisL;  // direction the gas leaves in, plume length
attribute vec4 iLook;   // brightness, seed, shock diamonds 0..1, boost 0..1
varying vec2 vUv;
varying float vKind;
varying vec4 vLook;
varying float vRadii;
void main() {
  vec3 o = iPosR.xyz;
  float r = iPosR.w;
  vec3 ax = iAxisL.xyz;
  float len = iAxisL.w;
  // 1 when the camera looks along the plume, 0 when it sees it from the side.
  float facing = abs(dot(ax, normalize(o + ax * len * 0.25)));
  vKind = position.z;
  vLook = iLook;
  vRadii = len / r;
  vec4 mv;
  if (position.z < 0.5) {
    float u = position.x;
    vec3 along = o + ax * (u * len - r * 0.15);
    vec3 side = cross(ax, along);
    float sl = length(side);
    side = sl > 1e-6 ? side / sl : vec3(0.0);
    // The cone opens slowly: thin gas in vacuum spreads, but only the core is hot enough to see.
    float w = r * mix(1.5, 3.4, u);
    mv = viewMatrix * vec4(along + side * position.y * w, 1.0);
    vUv = vec2(u, position.y);
    vLook.x *= 1.0 - facing * facing * facing * facing;
  } else {
    mv = viewMatrix * vec4(o + ax * r * 0.25, 1.0);
    mv.xy += position.xy * r * 2.8;
    vUv = position.xy;
    vLook.x *= 0.3 + 0.7 * facing * facing;
  }
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
varying vec2 vUv;
varying float vKind;
varying vec4 vLook;
varying float vRadii;
void main() {
  #include <logdepthbuf_fragment>
  float level = vLook.x;
  vec3 cool = vec3(0.36, 0.58, 1.0);
  vec3 hot = mix(vec3(0.74, 0.86, 1.0), vec3(0.95, 0.97, 1.0), vLook.w);
  vec3 col;
  if (vKind < 0.5) {
    float u = vUv.x;
    // The quad is wider than the cone; v is measured in cone half-widths.
    float v = vUv.y * 2.4;
    float x = u * vRadii;
    float tip = pow(clamp(1.0 - u, 0.0, 1.0), 1.7);
    float start = smoothstep(0.0, 0.02, u);
    float core = exp(-v * v * 5.5) * tip;
    float sheath = exp(-v * v * 1.1) * tip * tip * 0.16;
    // Shock diamonds: evenly spaced bright knots on the axis that weaken downstream.
    float wave = 0.5 + 0.5 * cos(x * 1.75 - 1.2);
    float knots = wave * wave * wave * exp(-x * 0.13) * exp(-v * v * 13.0) * vLook.z * 1.6;
    float flicker = 1.0 + 0.06 * sin(uTime * 41.0 + vLook.y * 6.3 + x * 0.9) + 0.04 * sin(uTime * 67.0 + vLook.y * 2.1);
    float glow = (core + sheath + knots) * start * flicker;
    col = mix(cool, hot, clamp(core + knots, 0.0, 1.0)) * glow * level;
  } else {
    float q = dot(vUv, vUv);
    if (q > 1.0) discard;
    float g = exp(-q * 9.0) + 0.12 * exp(-q * 2.5);
    col = mix(cool, hot, exp(-q * 14.0)) * g * (1.0 - q) * level * 0.5;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class Exhaust {
  readonly mesh: Mesh;
  private readonly geo = new InstancedBufferGeometry();
  private readonly posR = new Float32Array(CAPACITY * 4);
  private readonly axisL = new Float32Array(CAPACITY * 4);
  private readonly look = new Float32Array(CAPACITY * 4);
  private readonly mat: ShaderMaterial;
  private count = 0;
  private diamonds = 1;

  constructor() {
    // Corner layout: x along (0..1) or across, y across (-1..1), z 0 for the plume quad, 1 for the nozzle glow.
    const corners = new Float32Array([
      0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]);
    this.geo.setAttribute('position', new BufferAttribute(corners, 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const inst = (a: Float32Array): InstancedBufferAttribute => {
      const attr = new InstancedBufferAttribute(a, 4);
      attr.setUsage(DynamicDrawUsage);
      return attr;
    };
    this.geo.setAttribute('iPosR', inst(this.posR));
    this.geo.setAttribute('iAxisL', inst(this.axisL));
    this.geo.setAttribute('iLook', inst(this.look));
    this.geo.instanceCount = 0;
    this.mat = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uTime: { value: 0 } },
      blending: AdditiveBlending, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  /** `clock` is wrapped page time in seconds; `quality` 0 drops the shock diamonds. */
  begin(clock: number, quality: number): void {
    this.count = 0;
    this.diamonds = quality > 0 ? 1 : 0;
    (this.mat.uniforms.uTime as { value: number }).value = clock;
  }

  private push(p: Vector3, dir: Vector3, radius: number, length: number, level: number, seed: number, diamonds: number, boost: number): void {
    const i = this.count;
    if (i >= CAPACITY) return;
    const o = i * 4;
    this.posR[o] = p.x;
    this.posR[o + 1] = p.y;
    this.posR[o + 2] = p.z;
    this.posR[o + 3] = radius;
    this.axisL[o] = dir.x;
    this.axisL[o + 1] = dir.y;
    this.axisL[o + 2] = dir.z;
    this.axisL[o + 3] = length;
    this.look[o] = level;
    this.look[o + 1] = seed % 97;
    this.look[o + 2] = diamonds;
    this.look[o + 3] = boost;
    this.count = i + 1;
  }

  /** A main engine at `p` blowing along `dir`; `thrust` and `boost` are 0..1. */
  add(p: Vector3, dir: Vector3, radius: number, thrust: number, boost: number, seed: number): void {
    const length = radius * (4 + 13 * thrust + 14 * boost * thrust);
    this.push(p, dir, radius, length, thrust * (0.55 + 0.75 * boost), seed, this.diamonds, boost);
  }

  /** An attitude jet: a short, soft puff. */
  addJet(p: Vector3, dir: Vector3, radius: number, level: number, seed: number): void {
    this.push(p, dir, radius, radius * (5 + 13 * level), level * 0.7, seed, 0, 0);
  }

  end(): void {
    this.geo.instanceCount = this.count;
    this.geo.getAttribute('iPosR').needsUpdate = true;
    this.geo.getAttribute('iAxisL').needsUpdate = true;
    this.geo.getAttribute('iLook').needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
