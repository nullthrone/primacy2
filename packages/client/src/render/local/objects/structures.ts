/**
 * Built structures at sites: wheel stations, outposts, gates and beacons. They stand at the site
 * anchor with their axis along system +Y and spin about it. A structure too small to resolve is a
 * point of light; one that is near enough is the model, with slow strobes at its lamp positions.
 *
 * A gate shows its state: planned and building gates stand in their scaffold while the ring grows
 * in four arcs, an active gate carries the portal membrane, a dormant one is a dark ring.
 */
import { STRUCTURES } from '@primacy2/shared';
import type { GateState } from '@primacy2/shared';
import {
  CustomBlending,
  DoubleSide,
  Group,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import type { FrameView, Lighting } from '../../../contracts.ts';
import { TAU, clamp, clamp01, damp, wrap } from '../util.ts';
import type { Glints } from './glints.ts';
import { isEmissive, type Model, type ModelLibrary } from './models.ts';

/** A structure is drawn as its model above this projected radius in pixels, as a point below. */
const MODEL_ABOVE_PX = 2;
const POINT_BELOW_PX = 7;
/** The model must fit inside the far plane (400 km) or it is drawn as a point only. */
const FAR_LIMIT = 395_000;
const STROBE_PERIOD = 3.2;

const PORTAL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uRadius;
varying vec2 vP;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vT;
varying vec3 vB;
void main() {
  // The membrane spans the ring in the model's XZ plane.
  vP = position.xz / uRadius;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  mat3 rot = mat3(modelMatrix);
  vN = rot * vec3(0.0, 1.0, 0.0);
  vT = rot * vec3(1.0, 0.0, 0.0);
  vB = rot * vec3(0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

/**
 * The portal is a film of light stretched across the ring and pinned at its rim. It is nearly
 * clear face-on and brightens toward grazing angles like a soap film; slow drum-skin waves run
 * through it, the sun glints off their slopes, and the rim where it is anchored burns brightest.
 */
const PORTAL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uOn;
uniform vec3 uSun;
uniform vec3 uSunColor;
varying vec2 vP;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vT;
varying vec3 vB;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Displacement of the film: a few standing drum modes and a slow drift, held to zero at the rim.
float height(vec2 p) {
  float r = length(p);
  float a = atan(p.y, p.x);
  float h = 0.55 * cos(r * 19.0 - uTime * 0.8) * (1.0 - 0.6 * r);
  h += 0.28 * cos(r * 31.0 + uTime * 0.55 + 3.0 * a);
  h += 0.24 * cos(r * 12.0 - uTime * 0.33 - 5.0 * a + 1.3);
  h += 0.55 * (vnoise(p * 4.0 + vec2(uTime * 0.06, -uTime * 0.045)) - 0.5);
  return h * (1.0 - smoothstep(0.80, 1.0, r));
}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vP);
  if (r > 1.0) discard;
  const float e = 0.005;
  float h = height(vP);
  vec2 grad = vec2(height(vP + vec2(e, 0.0)) - h, height(vP + vec2(0.0, e)) - h) / e;
  vec3 n = normalize(normalize(vN) - (normalize(vT) * grad.x + normalize(vB) * grad.y) * 0.012);
  vec3 v = normalize(-vWorld);
  float ndv = abs(dot(n, v));
  float fres = pow(1.0 - ndv, 3.0);

  // Interference fringes, as on a soap film: bands that follow the film's thickness and shift
  // with the viewing angle. They carry the colour; the film itself is almost clear.
  float film = h * 2.2 + ndv * 4.0 + r * 1.2;
  float fringe = 0.5 + 0.5 * cos(film * 3.1);
  vec3 tint = mix(vec3(0.02, 0.20, 0.50), vec3(0.14, 0.52, 0.78), fringe);
  tint = mix(tint, vec3(0.30, 0.26, 0.70), 0.25 * (0.5 + 0.5 * cos(film * 1.3 + 2.0)));

  // Face-on the film is a faint haze that thickens toward the rim; at grazing angles it turns
  // into a bright sheet, which is what gives the flat surface its depth as the camera moves.
  float haze = 0.035 + 0.11 * r * r * r;
  float body = (haze + 0.42 * fres) * (0.55 + 0.45 * fringe);

  // The anchored rim: a hard bright line, with fine tension ripples just inside it.
  float edge = 1.0 - r;
  float ripple = 0.5 + 0.5 * cos(edge * 260.0 - uTime * 1.6);
  float rim = exp(-edge * 90.0) * 2.4 + exp(-edge * 16.0) * (0.22 + 0.2 * ripple);

  // The sun, mirrored in the rippling film: a hard glint with a soft skirt.
  vec3 refl = reflect(-v, n * sign(dot(n, v)));
  float mirror = max(dot(refl, uSun), 0.0);
  float glint = pow(mirror, 300.0) * 6.0 + pow(mirror, 30.0) * 0.1;

  vec3 col = tint * (body + rim) + vec3(0.75, 0.92, 1.0) * rim * 0.4 + uSunColor * glint;
  float alpha = clamp(0.02 + 0.30 * fres + 0.25 * rim, 0.0, 0.7);
  gl_FragColor = vec4(col * uOn, alpha * uOn);
}`;

const REVEAL_FRAG = /* glsl */ `
#include <clipping_planes_fragment>
if (uReveal < 0.999 && fract((atan(vRevealXZ.y, vRevealXZ.x) * 0.15915494 + 0.5) * 4.0) > uReveal) discard;`;

/** A copy of a ring material that only draws the part of the ring that has been built so far. */
function revealMaterial(src: MeshStandardMaterial, reveal: { value: number }): MeshStandardMaterial {
  const m = src.clone();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = reveal;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRevealXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRevealXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uReveal;\nvarying vec2 vRevealXZ;')
      .replace('#include <clipping_planes_fragment>', REVEAL_FRAG);
  };
  m.customProgramCacheKey = () => 'gate-reveal';
  return m;
}

interface GateParts {
  ringMeshes: Mesh[];
  scaffold: Object3D | null;
  portal: Mesh | null;
  portalMat: ShaderMaterial | null;
  reveal: { value: number };
  glowMats: MeshStandardMaterial[];
  glowFull: number[];
  on: number;
}

interface Built {
  siteId: number;
  modelName: string;
  model: Model;
  obj: Object3D;
  gate: GateParts | null;
  /** A beacon's own copies of its lantern materials, flashed in time with its strobe. */
  pulseMats: MeshStandardMaterial[];
  pulseFull: number[];
  seen: number;
}

const tmp = new Vector3();
const Y = new Vector3(0, 1, 0);

export class Structures {
  readonly group = new Group();
  private readonly bySite = new Map<number, Built>();
  private readonly active: Built[] = [];
  private readonly free = new Map<string, Built[]>();
  private readonly portalMats: ShaderMaterial[] = [];
  private frame = 0;
  /** The structure that is largest on screen, for the shadow focus; `focusBound` 0 when none. */
  readonly focusPos = new Vector3();
  focusBound = 0;
  focusDist = 0;

  constructor(private readonly lib: ModelLibrary, private readonly glints: Glints) {}

  private build(model: Model, modelName: string): Built {
    const obj = this.lib.instantiate(model);
    const built: Built = { siteId: 0, modelName, model, obj, gate: null, pulseMats: [], pulseFull: [], seen: 0 };
    if (modelName === 'beacon') {
      obj.traverse((o) => {
        const mesh = o as Mesh;
        const src = mesh.material as MeshStandardMaterial | undefined;
        if (!mesh.isMesh || !src?.isMeshStandardMaterial || src.name !== 'emissive_light') return;
        const own = this.lib.materials.add(src.clone());
        built.pulseMats.push(own);
        built.pulseFull.push(src.emissiveIntensity);
        mesh.material = own;
      });
    }
    if (modelName !== 'gate') return built;

    const gate: GateParts = {
      ringMeshes: [], scaffold: obj.getObjectByName('scaffold') ?? null, portal: null, portalMat: null,
      reveal: { value: 1 }, glowMats: [], glowFull: [], on: 0,
    };
    const copies = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    obj.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.name === 'portal') {
        gate.portal = mesh;
        return;
      }
      for (let p: Object3D | null = mesh; p; p = p.parent) if (p === gate.scaffold) return;
      const src = mesh.material as MeshStandardMaterial;
      if (!src.isMeshStandardMaterial) return;
      let own = copies.get(src);
      if (!own) {
        own = this.lib.materials.add(revealMaterial(src, gate.reveal));
        copies.set(src, own);
        if (isEmissive(src)) {
          gate.glowMats.push(own);
          gate.glowFull.push(src.emissiveIntensity);
        }
      }
      mesh.material = own;
      gate.ringMeshes.push(mesh);
    });
    const portal = gate.portal as Mesh | null;
    if (portal) {
      portal.geometry.computeBoundingSphere();
      const mat = new ShaderMaterial({
        vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
        uniforms: {
          uRadius: { value: portal.geometry.boundingSphere?.radius || 400 },
          uTime: { value: 0 }, uOn: { value: 0 },
          uSun: { value: new Vector3(0, 1, 0) }, uSunColor: { value: new Vector3(1, 1, 1) },
        },
        transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
        blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
      });
      portal.material = mat;
      portal.renderOrder = 5;
      portal.castShadow = false;
      portal.receiveShadow = false;
      gate.portalMat = mat;
      this.portalMats.push(mat);
    }
    built.gate = gate;
    return built;
  }

  private release(b: Built): void {
    this.group.remove(b.obj);
    let list = this.free.get(b.modelName);
    if (!list) {
      list = [];
      this.free.set(b.modelName, list);
    }
    list.push(b);
  }

  update(view: FrameView, light: Lighting, pxPerRad: number): void {
    const frame = ++this.frame;
    this.focusBound = 0;
    let focusAngle = 0;
    const sites = view.sites;

    for (let i = 0; i < sites.length; i++) {
      const sv = sites[i]!;
      const def = sv.def;
      const name = def.model;
      if (!name) continue;
      const spec = STRUCTURES[name];
      const bound = spec?.bound ?? def.radius ?? 100;
      const dist = Math.max(sv.dist, 1);
      const px = (bound / dist) * pxPerRad;
      // Most sites of a system are millions of kilometres away; those never touch a mesh.
      if (px < 0.01) continue;
      const state: GateState | null = def.gate ? def.gate.state : null;
      const lit = state !== 'dormant' && state !== 'planned';
      tmp.set(sv.rel[0], sv.rel[1], sv.rel[2]);

      const near = px > MODEL_ABOVE_PX && dist + bound < FAR_LIMIT;
      const model = this.lib.get(name);
      if (!near || !model) {
        // Open structures fill about a third of their bounding disc; lit windows keep them findable in shadow.
        this.glints.addBody(tmp, dist, bound * 0.55, model?.albedo ?? 0.2, lit ? 0.35 : 0.02, 1, pxPerRad);
        if (!model) this.lib.request(name, bound);
        continue;
      }
      if (px < POINT_BELOW_PX) {
        this.glints.addBody(tmp, dist, bound * 0.55, model.albedo, lit ? 0.35 : 0.02, clamp01((POINT_BELOW_PX - px) / 4), pxPerRad);
      }

      let b = this.bySite.get(def.id);
      if (b && b.modelName !== name) {
        b.seen = -1;
        this.bySite.delete(def.id);
        b = undefined;
      }
      if (!b) {
        b = this.free.get(name)?.pop() ?? this.build(model, name);
        b.siteId = def.id;
        this.bySite.set(def.id, b);
        this.active.push(b);
        this.group.add(b.obj);
      }
      b.seen = frame;

      const obj = b.obj;
      obj.position.copy(tmp);
      obj.quaternion.setFromAxisAngle(Y, wrap(view.time * (spec?.spin ?? 0), TAU));
      obj.updateMatrix();

      if (b.pulseMats.length) {
        // The lantern flares up with each strobe and dies down to an ember in between.
        const level = 0.05 + Math.exp(-wrap(view.time, 2) * 5);
        for (let k = 0; k < b.pulseMats.length; k++) b.pulseMats[k]!.emissiveIntensity = b.pulseFull[k]! * level;
      }
      if (b.gate) this.updateGate(b.gate, state ?? 'active', def.gate?.progress ?? 1, view, light);
      if (view.graphics.quality > 0 || px > 40) this.lamps(b, name, bound, state, view, pxPerRad);

      const angle = bound / dist;
      if (angle > focusAngle) {
        focusAngle = angle;
        this.focusPos.copy(tmp);
        this.focusBound = bound;
        this.focusDist = dist;
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i]!;
      if (b.seen === frame) continue;
      if (this.bySite.get(b.siteId) === b) this.bySite.delete(b.siteId);
      this.release(b);
      this.active[i] = this.active[this.active.length - 1]!;
      this.active.pop();
    }
  }

  private updateGate(g: GateParts, state: GateState, progress: number, view: FrameView, light: Lighting): void {
    const rising = state === 'planned' || state === 'building';
    const reveal = state === 'planned' ? 0 : state === 'building' ? clamp01(progress) : 1;
    g.reveal.value = reveal;
    if (g.scaffold) g.scaffold.visible = rising;
    for (let k = 0; k < g.ringMeshes.length; k++) {
      const mesh = g.ringMeshes[k]!;
      mesh.visible = reveal > 0.001;
      // The shadow pass does not know about the unbuilt arcs.
      mesh.castShadow = reveal > 0.999 && !isEmissive(mesh.material as MeshStandardMaterial);
    }
    // The ring's own lights: full when active, work lights while building, dead when dormant.
    const glow = state === 'active' ? 1 : state === 'building' ? 0.35 : 0;
    for (let k = 0; k < g.glowMats.length; k++) g.glowMats[k]!.emissiveIntensity = g.glowFull[k]! * glow;

    g.on = damp(g.on, state === 'active' ? 1 : 0, 1.2, view.dt);
    if (g.portal && g.portalMat) {
      g.portal.visible = g.on > 0.003;
      const u = g.portalMat.uniforms;
      (u.uTime as { value: number }).value = wrap(view.clock, 7200);
      (u.uOn as { value: number }).value = g.on;
      (u.uSun as { value: Vector3 }).value.set(light.sunDir[0], light.sunDir[1], light.sunDir[2]);
      const k = light.sunIntensity;
      (u.uSunColor as { value: Vector3 }).value.set(light.sunColor[0] * k, light.sunColor[1] * k, light.sunColor[2] * k);
    }
  }

  /** Strobes at the lamp positions: a dim steady red, and a white flash that runs from lamp to lamp. */
  private lamps(b: Built, name: string, bound: number, state: GateState | null, view: FrameView, pxPerRad: number): void {
    const lamps = b.model.lamps;
    const m = b.obj.matrix;
    const beacon = name === 'beacon';
    const radius = beacon ? 0.7 : clamp(bound * 0.004, 0.5, 3.5);
    const period = beacon ? 2 : STROBE_PERIOD;
    const quiet = state === 'dormant' || state === 'planned';
    for (let k = 0; k < lamps.length; k++) {
      tmp.copy(lamps[k]!).applyMatrix4(m);
      const phase = wrap(view.time - k * 0.4, period);
      const flash = !quiet && phase < 0.12;
      if (flash) {
        const amber = state === 'building';
        this.glints.addLamp(tmp, 1, amber ? 0.62 : 0.95, amber ? 0.15 : 0.86, radius, beacon ? 16 : 12, pxPerRad);
      } else {
        this.glints.addLamp(tmp, 1, 0.13, 0.07, radius * 0.6, quiet ? 2 : 3.5, pxPerRad);
      }
    }
  }

  dispose(): void {
    for (const m of this.portalMats) m.dispose();
    this.portalMats.length = 0;
    this.group.clear();
    this.bySite.clear();
    this.active.length = 0;
    this.free.clear();
  }
}
