/**
 * Built structures at sites: wheel stations, outposts, gates, beacons and ground bases. Those in
 * orbit stand at the site anchor with their axis along system +Y and spin about it; a ground base
 * stands on its pad, up along the pad normal and turning with its body. A structure too small to
 * resolve is a point of light; one that is near enough is the model, with slow strobes at its lamp
 * positions.
 *
 * A gate shows its state: planned and building gates stand in their scaffold while the ring grows
 * in four arcs, an active gate carries the portal membrane, a dormant one is a dark ring.
 *
 * A ground base has lamps of its own instead of the strobes: pad edge lights, a beacon on the
 * mast, and floodlights that come on when the sun is down at the base. The floodlights of the
 * nearest base are real lights, so the pads, the compound and a ship standing there are lit at
 * night. What lies flat on the ground (apron, pads, markings) is drawn with a depth offset, layer
 * over layer, so it does not fight with the terrain drawn under it by another part.
 */
import { STRUCTURES, bodyRotation, groundSiteRotation } from '@primacy2/shared';
import type { GateState, SiteDef } from '@primacy2/shared';
import {
  CustomBlending,
  DoubleSide,
  Group,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PointLight,
  Quaternion,
  ShaderMaterial,
  SpotLight,
  Vector3,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import type { FrameView, Lighting } from '../../../contracts.ts';
import { TAU, clamp, clamp01, damp, smooth, wrap } from '../util.ts';
import type { Glints } from './glints.ts';
import { isEmissive, type Model, type ModelLibrary } from './models.ts';

/** A structure is drawn as its model above this projected radius in pixels, as a point below. */
const MODEL_ABOVE_PX = 2;
const POINT_BELOW_PX = 7;
/** The model must fit inside the far plane (400 km) or it is drawn as a point only. */
const FAR_LIMIT = 395_000;
const STROBE_PERIOD = 3.2;

/**
 * The flat layers of a ground structure by node name, bottom to top, with the depth offset each
 * is drawn with (in steps of the depth buffer, plus one pixel of slope). The terrain under them
 * has none, so the apron wins over the ground, the pads over the apron and paint over both, at
 * any distance, whatever is left of the depth buffer's precision there.
 */
const FLAT_LAYERS: readonly (readonly [string, number])[] = [['ground', -4], ['pads', -8], ['marks', -12]];
/** A ground base beyond the limb of its body is not drawn, unless the camera is this near (the terrain hides it then). */
const LIMB_NEAR = 20_000;
/** The pad may lie this far below the horizon of a smooth sphere and still be drawn: towers and rough ground. */
const LIMB_SLACK = 300;
/** Floodlights come on as the sine of the sun's height at the base falls from the first to the second value. */
const DUSK_HIGH = 0.06;
const DUSK_LOW = -0.02;
/** The real lights of a base are switched on within this distance and reach full strength a quarter nearer. */
const FLOOD_RANGE = 5000;
/** Luminous intensity of one pad's floodlight and of the work lights on the tower, scene-referred. */
const FLOOD_INTENSITY = 95;
const WORK_INTENSITY = 42;
/** How far each reaches, metres; both fall off with the distance, not its square (see `Structures`). */
const FLOOD_REACH = 280;
const WORK_REACH = 150;
/** Pad edge lights are told apart up to this distance; farther out only floodlights and beacon are drawn. */
const EDGE_LIGHT_RANGE = 9000;

const LAMP_FLOOD = 0;
const LAMP_EDGE = 1;
const LAMP_BEACON = 2;
const LAMP_WORK = 3;
const LAMP_DOOR = 4;
const LAMP_KINDS: Record<string, number> = { flood: LAMP_FLOOD, edge: LAMP_EDGE, beacon: LAMP_BEACON, work: LAMP_WORK, door: LAMP_DOOR };

/** A lamp of a ground structure in model space: `light_N` empties carry the kind and the pad they belong to. */
interface GroundLamp {
  pos: Vector3;
  kind: number;
  /** Pad number 1..n, or 0 for a lamp of the compound. */
  pad: number;
}

/** What a model says about its lamps and pads; read once per model. */
interface GroundPlan {
  lamps: GroundLamp[];
  /** Per pad: where its floodlight shines from (the middle of its masts) and the pad centre it is aimed at. */
  floodFrom: Vector3[];
  floodAt: Vector3[];
  /** Where the work lights over the compound hang, or null. */
  work: Vector3 | null;
}

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

/** The parts of a structure that stands on the ground of a body. */
interface GroundParts {
  plan: GroundPlan;
  /** The site this copy stands at and the orientation of that site's axes in the body-fixed axes of its body. */
  site: SiteDef | null;
  siteRot: Quaternion;
  /** Own copies of the floodlight glass: dark by day. */
  floodMats: MeshStandardMaterial[];
  floodFull: number[];
  /** 0 by day, 1 with the sun down at the base. */
  night: number;
}

interface Built {
  siteId: number;
  modelName: string;
  model: Model;
  obj: Object3D;
  gate: GateParts | null;
  ground: GroundParts | null;
  /** A beacon's own copies of its lantern materials, flashed in time with its strobe. */
  pulseMats: MeshStandardMaterial[];
  pulseFull: number[];
  seen: number;
}

const tmp = new Vector3();
const tmp2 = new Vector3();
const Y = new Vector3(0, 1, 0);

export class Structures {
  readonly group = new Group();
  private readonly bySite = new Map<number, Built>();
  private readonly active: Built[] = [];
  private readonly free = new Map<string, Built[]>();
  private readonly portalMats: ShaderMaterial[] = [];
  private readonly plans = new Map<Model, GroundPlan>();
  /**
   * The floodlights of the nearest ground base: one spot light per pad and a point light over the
   * compound. They are in the scene from the start and only change strength, because a light that
   * comes or goes makes the renderer rebuild every lit shader. One light stands for the lamps of
   * two masts, so it is given an even spread (strength falling with distance, not its square), as
   * a set of lamps aimed near and far gives; a single bare lamp would burn out the ground at its
   * foot and leave the pad dark.
   */
  private readonly floods: SpotLight[] = [];
  private readonly work = new PointLight(0xffe9c8, 0, WORK_REACH, 1);
  private frame = 0;
  /** The structure that is largest on screen, for the shadow focus; `focusBound` 0 when none. */
  readonly focusPos = new Vector3();
  focusBound = 0;
  focusDist = 0;

  constructor(private readonly lib: ModelLibrary, private readonly glints: Glints) {
    for (let i = 0; i < 4; i++) {
      const spot = new SpotLight(0xffe9c8, 0, FLOOD_REACH, 0.56, 0.6, 1);
      this.floods.push(spot);
      this.group.add(spot, spot.target);
    }
    this.group.add(this.work);
  }

  /** Lamps and pads of a ground structure, from the empties of its model. */
  private plan(model: Model, modelName: string): GroundPlan {
    const known = this.plans.get(model);
    if (known) return known;
    const plan: GroundPlan = { lamps: [], floodFrom: [], floodAt: [], work: null };
    const pads: Vector3[] = [];
    model.template.traverse((o) => {
      if (/^light_\d/.test(o.name)) {
        const data = o.userData as { p2_light?: string; p2_pad?: number };
        const kind = LAMP_KINDS[data.p2_light ?? ''];
        if (kind !== undefined) plan.lamps.push({ pos: o.getWorldPosition(new Vector3()), kind, pad: data.p2_pad ?? 0 });
      } else if (/^pad_\d+$/.test(o.name)) {
        pads[Number(o.name.slice(4)) - 1] = o.getWorldPosition(new Vector3());
      }
    });
    // A model without pad empties (a stand-in) falls back on the pads the structure is defined with.
    const defined = STRUCTURES[modelName]?.pads ?? [];
    for (let i = 0; i < Math.max(pads.length, defined.length); i++) {
      const at = pads[i] ?? new Vector3(defined[i]!.pos[0], defined[i]!.pos[1], defined[i]!.pos[2]);
      const from = new Vector3();
      let n = 0;
      for (const lamp of plan.lamps) {
        if (lamp.kind !== LAMP_FLOOD || lamp.pad !== i + 1) continue;
        from.add(lamp.pos);
        n++;
      }
      // Without masts of its own the pad is lit from above its inner edge.
      if (n > 0) from.multiplyScalar(1 / n);
      else from.copy(at).multiplyScalar(0.5).setY(36);
      plan.floodAt.push(at);
      plan.floodFrom.push(from);
    }
    plan.work = plan.lamps.find((l) => l.kind === LAMP_WORK)?.pos ?? null;
    this.plans.set(model, plan);
    return plan;
  }

  /** Prepares a copy of a ground structure: its flat layers and its floodlight glass. */
  private buildGround(obj: Object3D, model: Model, modelName: string): GroundParts {
    for (const [name, units] of FLAT_LAYERS) {
      const copies = new Map<MeshStandardMaterial, MeshStandardMaterial>();
      obj.getObjectByName(name)?.traverse((o) => {
        const mesh = o as Mesh;
        const src = mesh.material as MeshStandardMaterial | undefined;
        if (!mesh.isMesh || !src?.isMeshStandardMaterial) return;
        let own = copies.get(src);
        if (!own) {
          own = this.lib.materials.add(src.clone());
          own.polygonOffset = true;
          own.polygonOffsetFactor = -1;
          own.polygonOffsetUnits = units;
          copies.set(src, own);
        }
        mesh.material = own;
        // Flat on the ground: nothing for it to shade, and its own shadow would only flicker.
        mesh.castShadow = false;
      });
    }
    const ground: GroundParts = {
      plan: this.plan(model, modelName), site: null, siteRot: new Quaternion(), floodMats: [], floodFull: [], night: 0,
    };
    const floods = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    obj.traverse((o) => {
      const mesh = o as Mesh;
      const src = mesh.material as MeshStandardMaterial | undefined;
      if (!mesh.isMesh || !src?.isMeshStandardMaterial || src.name !== 'emissive_light_flood') return;
      let own = floods.get(src);
      if (!own) {
        own = this.lib.materials.add(src.clone());
        floods.set(src, own);
        ground.floodMats.push(own);
        ground.floodFull.push(src.emissiveIntensity);
      }
      mesh.material = own;
    });
    return ground;
  }

  private build(model: Model, modelName: string): Built {
    const obj = this.lib.instantiate(model);
    const built: Built = { siteId: 0, modelName, model, obj, gate: null, ground: null, pulseMats: [], pulseFull: [], seen: 0 };
    if (obj.getObjectByName('ground')) built.ground = this.buildGround(obj, model, modelName);
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

  /**
   * `light` is the light that reaches the camera (the sun dimmed to nothing on the night side of
   * the body it is near); `sun` is where the sun stands, seen or not, as a unit vector.
   */
  update(view: FrameView, light: Lighting, sun: readonly number[], pxPerRad: number): void {
    const frame = ++this.frame;
    this.focusBound = 0;
    let focusAngle = 0;
    const sites = view.sites;
    /** The ground base nearest to the camera whose floodlights are on, for the real lights. */
    let flood: Built | null = null;
    let floodDist = FLOOD_RANGE;

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

      // A base on the ground is hidden by its own body from most of the sky, and has day and night.
      /** 1 with the sun up at the structure, 0 with it down; always 1 in orbit. */
      let day = 1;
      const host = def.ground ? view.bodies[def.ground.body] : undefined;
      if (host) {
        // The pad as seen from the body centre; the camera is at minus the body's position.
        const ox = tmp.x - host.rel[0], oy = tmp.y - host.rel[1], oz = tmp.z - host.rel[2];
        const rr = ox * ox + oy * oy + oz * oz;
        const r = Math.sqrt(rr);
        if (dist > LIMB_NEAR && -(ox * host.rel[0] + oy * host.rel[1] + oz * host.rel[2]) < rr - r * LIMB_SLACK) continue;
        day = smooth(DUSK_LOW, DUSK_HIGH, (ox * sun[0]! + oy * sun[1]! + oz * sun[2]!) / r);
      }
      /** Light of its own that keeps a structure findable in shadow: windows, and at night the floodlights of a base. */
      const glow = !lit ? 0.02 : def.ground ? 0.08 + 0.3 * (1 - day) : 0.35;

      const near = px > MODEL_ABOVE_PX && dist + bound < FAR_LIMIT;
      const model = this.lib.get(name);
      if (!near || !model) {
        // Open structures fill about a third of their bounding disc; lit windows keep them findable in shadow.
        this.glints.addBody(tmp, dist, bound * 0.55, (model?.albedo ?? 0.2) * day, glow, 1, pxPerRad);
        if (!model) this.lib.request(name, bound);
        // Too far for its lamps to be told apart: one flash for the whole structure.
        const beacon = name === 'beacon';
        if (lit && wrap(view.time, beacon ? 2 : STROBE_PERIOD) < 0.12) {
          this.glints.addLamp(tmp, 1, 0.95, 0.86, beacon ? 0.7 : clamp(bound * 0.004, 0.5, 3.5), beacon ? 16 : 12, pxPerRad);
        }
        continue;
      }
      if (px < POINT_BELOW_PX) {
        this.glints.addBody(tmp, dist, bound * 0.55, model.albedo * day, glow, clamp01((POINT_BELOW_PX - px) / 4), pxPerRad);
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
      const ground = def.ground ? b.ground : null;
      if (ground && def.ground) {
        // Up along the pad normal, nose north: the site's axes, turned with the body.
        if (ground.site !== def) {
          const q = groundSiteRotation(def);
          ground.siteRot.set(q[0], q[1], q[2], q[3]);
          ground.site = def;
        }
        const surface = view.surface;
        // The view carries the rotation of the body the camera is near, which is this one in all but freak cases.
        const turn = surface && surface.body === def.ground.body ? surface.rot : bodyRotation(view.system.bodies[def.ground.body]!, view.time);
        obj.quaternion.set(turn[0], turn[1], turn[2], turn[3]).multiply(ground.siteRot);
        ground.night = 1 - day;
      } else {
        obj.quaternion.setFromAxisAngle(Y, wrap(view.time * (spec?.spin ?? 0), TAU));
      }
      obj.updateMatrix();

      if (b.pulseMats.length) {
        // The lantern flares up with each strobe and dies down to an ember in between.
        const level = 0.05 + Math.exp(-wrap(view.time, 2) * 5);
        for (let k = 0; k < b.pulseMats.length; k++) b.pulseMats[k]!.emissiveIntensity = b.pulseFull[k]! * level;
      }
      if (b.gate) this.updateGate(b.gate, state ?? 'active', def.gate?.progress ?? 1, view, light);
      if (ground) {
        for (let k = 0; k < ground.floodMats.length; k++) ground.floodMats[k]!.emissiveIntensity = ground.floodFull[k]! * ground.night;
        this.groundLamps(b, ground, dist, view, pxPerRad);
        if (ground.night > 0.01 && dist < floodDist) {
          flood = b;
          floodDist = dist;
        }
      } else if (view.graphics.quality > 0 || px > 40) {
        this.lamps(b, name, bound, state, view, pxPerRad);
      }

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
    this.floodlights(flood, floodDist, view.graphics.quality);
  }

  /** Puts the real lights on the masts of `b`, or switches them off when it is null. */
  private floodlights(b: Built | null, dist: number, quality: number): void {
    const ground = b?.ground;
    // The lowest quality level does without them; the lamps themselves still shine.
    const level = b && ground && quality > 0 ? ground.night * clamp01((FLOOD_RANGE - dist) / (FLOOD_RANGE * 0.25)) : 0;
    for (let i = 0; i < this.floods.length; i++) {
      const spot = this.floods[i]!;
      const from = ground?.plan.floodFrom[i];
      const at = ground?.plan.floodAt[i];
      if (!b || !from || !at || level <= 0) {
        spot.intensity = 0;
        continue;
      }
      spot.intensity = FLOOD_INTENSITY * level;
      spot.position.copy(from).applyMatrix4(b.obj.matrix);
      spot.target.position.copy(at).applyMatrix4(b.obj.matrix);
    }
    const work = ground?.plan.work;
    if (!b || !work || level <= 0) {
      this.work.intensity = 0;
      return;
    }
    this.work.intensity = WORK_INTENSITY * level;
    this.work.position.copy(work).applyMatrix4(b.obj.matrix);
  }

  /**
   * The lamps of a ground base as points of light. Edge lights and the beacon burn day and night;
   * floodlights and work lights only with the sun down. In daylight a lamp is a dim speck.
   */
  private groundLamps(b: Built, g: GroundParts, dist: number, view: FrameView, pxPerRad: number): void {
    const lamps = g.plan.lamps;
    const m = b.obj.matrix;
    const night = g.night;
    const dim = 0.35 + 0.65 * night;
    // The beacon on the mast: one second on, one off.
    const beacon = wrap(view.time, 2) < 1 ? 7 : 0.4;
    for (let k = 0; k < lamps.length; k++) {
      const lamp = lamps[k]!;
      if (lamp.kind === LAMP_EDGE && dist > EDGE_LIGHT_RANGE) continue;
      tmp2.copy(lamp.pos).applyMatrix4(m);
      switch (lamp.kind) {
        case LAMP_FLOOD:
          if (night > 0.01) this.glints.addLamp(tmp2, 1, 0.9, 0.74, 0.7, 11 * night, pxPerRad);
          break;
        case LAMP_WORK:
          if (night > 0.01) this.glints.addLamp(tmp2, 1, 0.9, 0.74, 0.6, 6 * night, pxPerRad);
          break;
        case LAMP_BEACON:
          this.glints.addLamp(tmp2, 1, 0.07, 0.03, 0.5, beacon, pxPerRad);
          break;
        case LAMP_DOOR:
          this.glints.addLamp(tmp2, 1, 0.62, 0.2, 0.15, 2.2 * dim, pxPerRad);
          break;
        default:
          this.glints.addLamp(tmp2, 0.72, 0.88, 1, 0.2, 3 * dim, pxPerRad);
      }
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
    this.plans.clear();
    this.group.clear();
    this.bySite.clear();
    this.active.length = 0;
    this.free.clear();
  }
}
