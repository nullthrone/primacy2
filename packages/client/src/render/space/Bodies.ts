/**
 * Celestial bodies of the current system: stars, planets and moons with atmospheres and rings,
 * neutron stars with jets, black holes and asteroid belts. Bodies are drawn far to near in one pass
 * without a depth buffer: every surface is an exact ray-sphere intersection, and rings test the
 * planet analytically, so the order alone gives correct occlusion at any distance.
 */
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, Matrix3, Matrix4,
  Mesh, Points, Quaternion, RingGeometry, ShaderMaterial, SphereGeometry, Vector3, Vector4,
} from 'three';
import type { CubeTexture, IUniform } from 'three';
import type { BeltDef, BodyDef } from '@primacy2/shared';
import type { BodyView } from '../../contracts.ts';
import { BlackHoleVisual } from './BlackHole.ts';
import { GLSL_NOISE } from './glsl.ts';
import { dominantStar, effectiveLum, hexToLinear, starColor } from './lighting.ts';
import { ATMO_FRAG, PLANET_FRAG, PLANET_TYPE, RING_FRAG, SPHERE_GLSL, WORLD_VERT } from './planetShader.ts';
import { bodyAxis, seedFloat, seededRandom, type SpaceFrame, type ViewParams } from './types.ts';
import { Glow, NO_DEPTH, SAFE_DIST, compress, glare, smoothstep, type Visual } from './visual.ts';

const SPHERE = new SphereGeometry(1, 96, 48);
const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();
const tmpM = new Matrix4();

/** Noise octaves a surface of `px` pixels radius can show without aliasing, capped by quality. */
function octaves(px: number, quality: number): number {
  const cap = quality === 0 ? 5 : quality === 1 ? 7 : 8;
  return Math.min(cap, Math.max(2, Math.floor(Math.log2(Math.max(px, 1))) - 1));
}

/** Rotation from system axes into the body's own frame at universe time `time`. */
function bodyRotation(def: BodyDef, tilt: Quaternion, time: number, out: Matrix3): void {
  const turns = def.rotPeriod !== 0 ? (time / def.rotPeriod) % 1 : 0;
  tmpQ.setFromAxisAngle(UP, turns * Math.PI * 2).premultiply(tilt).invert();
  out.setFromMatrix4(tmpM.makeRotationFromQuaternion(tmpQ));
}

function tiltQuaternion(def: BodyDef): Quaternion {
  const a = bodyAxis(def);
  return new Quaternion().setFromUnitVectors(UP, new Vector3(a[0], a[1], a[2]));
}

// ---------------------------------------------------------------------------------------------
// Planets and moons
// ---------------------------------------------------------------------------------------------

class PlanetVisual implements Visual {
  readonly group = new Group();
  private readonly center = new Vector3();
  private readonly tilt: Quaternion;
  private readonly shared: Record<string, IUniform>;
  private readonly material: ShaderMaterial;
  private readonly surface: Mesh;
  private atmoMat: ShaderMaterial | null = null;
  private atmo: Mesh | null = null;
  private ringMat: ShaderMaterial | null = null;
  private ring: Mesh | null = null;
  private readonly point: Glow;
  private readonly atmoStrength: number;
  private readonly shell: number;

  constructor(private readonly def: BodyDef) {
    this.tilt = tiltQuaternion(def);
    const axis = bodyAxis(def);
    const giant = def.cls === 'gas' || def.cls === 'icegiant';
    const base = hexToLinear(def.color);
    const atmoColor = hexToLinear(def.atmo ? def.atmo.color : 0xffffff);
    this.atmoStrength = def.atmo ? (1 - Math.exp(-def.atmo.density * 1.4)) * (giant ? 0.7 : 1) : 0;
    this.shell = giant ? 0.03 : 0.035 + 0.03 * this.atmoStrength;
    const rings = def.rings;
    this.shared = {
      uCenter: { value: this.center }, uRadius: { value: 1 }, uPix: { value: 0.001 }, uFade: { value: 1 },
      uSunDir: { value: new Vector3(0, 1, 0) }, uSun: { value: new Vector3(1, 1, 1) },
      uRing: { value: new Vector4(rings ? rings.inner / def.radius : 0, rings ? rings.outer / def.radius : 0, rings ? (rings.seed % 977) * 0.37 : 0, rings ? 1 : 0) },
      uRingN: { value: new Vector3(axis[0], axis[1], axis[2]) },
      uAtmoColor: { value: new Vector3(atmoColor[0], atmoColor[1], atmoColor[2]) }, uAtmo: { value: this.atmoStrength },
    };
    const seed = seedFloat(def.seed);
    const par = new Vector4();
    if (def.cls === 'terran') par.set(0.06, 0.0, 0, 1);
    else if (def.cls === 'ocean') par.set(0.36, -0.04, 0, def.habitable ? 1 : 0);
    else if (def.cls === 'desert') par.set(def.temp < 330 ? 1 : 0, 0, 0, 0);
    else if (def.cls === 'gas') par.set(5.5 + (def.seed % 5), 1, 1, 0);
    else if (def.cls === 'icegiant') par.set(2.5, 0.32, 0.45, 0);
    this.material = new ShaderMaterial({
      vertexShader: WORLD_VERT, fragmentShader: PLANET_FRAG,
      defines: { TYPE: PLANET_TYPE[def.cls as keyof typeof PLANET_TYPE] ?? 0 },
      uniforms: {
        ...this.shared, uRot: { value: new Matrix3() }, uBase: { value: new Vector3(base[0], base[1], base[2]) },
        uSeed: { value: seed }, uOct: { value: 6 }, uTime: { value: 0 }, uCloudPhase: { value: 0 }, uPar: { value: par },
      },
      ...NO_DEPTH,
    });
    this.surface = new Mesh(SPHERE, this.material);
    this.surface.renderOrder = 1;
    this.surface.frustumCulled = false;
    this.group.add(this.surface);

    if (this.atmoStrength > 0.02) {
      this.atmoMat = new ShaderMaterial({
        vertexShader: WORLD_VERT, fragmentShader: ATMO_FRAG, uniforms: { ...this.shared, uAtmoR: { value: 1 } },
        side: BackSide, blending: AdditiveBlending, ...NO_DEPTH,
      });
      this.atmo = new Mesh(SPHERE, this.atmoMat);
      this.atmo.renderOrder = 0;
      this.atmo.frustumCulled = false;
      this.group.add(this.atmo);
    }
    if (rings) {
      const ringColor = hexToLinear(rings.color);
      this.ringMat = new ShaderMaterial({
        vertexShader: WORLD_VERT, fragmentShader: RING_FRAG,
        uniforms: { ...this.shared, uRingColor: { value: new Vector3(ringColor[0], ringColor[1], ringColor[2]) } },
        side: DoubleSide, ...NO_DEPTH,
      });
      // In planet radii, in the equatorial plane; slightly oversized, the shader cuts the exact edges.
      this.ring = new Mesh(new RingGeometry((rings.inner / def.radius) * 0.98, (rings.outer / def.radius) * 1.02, 128, 1), this.ringMat);
      this.ring.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(axis[0], axis[1], axis[2]));
      this.ring.renderOrder = 2;
      this.ring.frustumCulled = false;
      this.group.add(this.ring);
    }
    const m = Math.max(base[0], base[1], base[2], 1e-3);
    this.point = new Glow([0.35 + 0.65 * base[0] / m, 0.35 + 0.65 * base[1] / m, 0.35 + 0.65 * base[2] / m]);
    this.point.mesh.renderOrder = 3;
    this.group.add(this.point.mesh);
  }

  update(body: BodyView, frame: SpaceFrame, params: ViewParams): void {
    const def = this.def;
    const k = compress(body, this.center);
    const radius = def.radius * k;
    const px = def.radius / body.dist / params.pixAngle;
    const fade = smoothstep(1.0, 2.5, px);
    const s = this.shared;
    s.uRadius!.value = radius;
    s.uPix!.value = params.pixAngle;
    s.uFade!.value = fade;

    // The star that lights this body, with its flux compressed so the outer system stays readable.
    const star = dominantStar(frame.bodies, body.rel);
    let lit = 0.5;
    if (star) {
      (s.uSunDir!.value as Vector3).set(star.dir[0], star.dir[1], star.dir[2]);
      const i = Math.min(2.2, Math.max(0.55, 1.3 * Math.pow(star.flux, 0.12)));
      (s.uSun!.value as Vector3).set((0.4 + 0.6 * star.color[0]) * i, (0.4 + 0.6 * star.color[1]) * i, (0.4 + 0.6 * star.color[2]) * i);
      // Fraction of the visible disc that is lit.
      lit = 0.5 - 0.5 * (star.dir[0] * body.rel[0] + star.dir[1] * body.rel[1] + star.dir[2] * body.rel[2]) / Math.max(body.dist, 1);
    }

    const resolved = fade > 0;
    this.surface.visible = resolved;
    if (this.atmo) this.atmo.visible = resolved;
    if (this.ring) this.ring.visible = resolved;
    if (resolved) {
      const u = this.material.uniforms;
      bodyRotation(def, this.tilt, frame.time, u.uRot!.value as Matrix3);
      u.uOct!.value = octaves(px, params.quality);
      u.uTime!.value = params.clock;
      u.uCloudPhase!.value = (params.clock * 0.0015) % (Math.PI * 2);
      // The mesh is a little larger than the sphere so the shader can anti-alias the limb.
      this.surface.position.copy(this.center);
      this.surface.scale.setScalar(radius * 1.004 + 2 * params.pixAngle * SAFE_DIST);
      if (this.atmo && this.atmoMat) {
        const top = radius * (1 + this.shell);
        this.atmoMat.uniforms.uAtmoR!.value = top;
        this.atmo.position.copy(this.center);
        this.atmo.scale.setScalar(top * 1.004);
      }
      if (this.ring) {
        this.ring.position.copy(this.center);
        this.ring.scale.setScalar(radius);
      }
    }
    // Too small to resolve: a point whose brightness follows apparent size and phase.
    const pointFade = 1 - smoothstep(1.5, 3.0, px);
    const gain = Math.min(3, Math.max(def.kind === 'moon' ? 0.12 : 0.5, 1.8 * Math.sqrt(px))) * (0.3 + 0.7 * lit) * pointFade;
    const res = params.height / 1080;
    this.point.set(this.center, params, 8 * res, 0, 1.2 * res, gain, 0.06);
  }

  dispose(): void {
    this.material.dispose();
    this.atmoMat?.dispose();
    this.ringMat?.dispose();
    this.ring?.geometry.dispose();
    this.point.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------

const STAR_FRAG = /* glsl */ `
uniform float uFade;
uniform mat3 uRot;
uniform vec3 uColor;
uniform float uTime;
uniform float uSeed;
uniform int uOct;
uniform float uGain;
varying vec3 vWorld;
${GLSL_NOISE}
${SPHERE_GLSL}
void main() {
  vec3 d = normalize(vWorld);
  vec3 n;
  float cov = sphereHit(d, n);
  if (cov <= 0.0) discard;
  vec3 nb = uRot * n;
  float ndv = max(dot(n, -d), 0.0);
  vec3 p = nb * 4.0 + uSeed;
  float t = uTime * 0.04;
  int lo = min(uOct, 4);
  // Slow convection cells, sharp granulation between them, and fine boiling detail.
  float cells = fbm(p + vec3(0.0, t, 0.0), lo);
  float gran = ridged(p * 7.0 + vec3(t * 2.0, 0.0, -t) + cells, uOct);
  float fine = uOct >= 6 ? fbm(p * 28.0 + vec3(0.0, t * 6.0, 0.0), 3) : 0.0;
  float spotField = fbm(p * 0.55 + 13.0 + t * 0.15, lo);
  float spots = smoothstep(0.26, 0.40, spotField) * smoothstep(0.75, 0.40, abs(nb.y));
  float bright = 0.78 + 0.55 * cells + 0.70 * (gran - 0.45) + 0.20 * fine;
  bright += 0.35 * smoothstep(0.10, 0.0, abs(spotField - 0.22));
  // Limb darkening; the limb is also cooler and redder.
  float limb = 0.22 + 0.78 * pow(ndv, 0.7);
  vec3 col = mix(uColor, uColor * vec3(1.0, 0.55, 0.30), (1.0 - ndv) * 0.5) * bright * limb;
  col *= 1.0 - 0.8 * spots;
  gl_FragColor = vec4(col * uGain, cov * uFade);
}
`;

class StarVisual implements Visual {
  readonly group = new Group();
  private readonly center = new Vector3();
  private readonly tilt: Quaternion;
  private readonly material: ShaderMaterial;
  private readonly surface: Mesh;
  private readonly glow: Glow;

  constructor(private readonly def: BodyDef) {
    this.tilt = tiltQuaternion(def);
    const c = starColor(def);
    const hot = smoothstep(2500, 12000, def.temp);
    this.material = new ShaderMaterial({
      vertexShader: WORLD_VERT, fragmentShader: STAR_FRAG,
      uniforms: {
        uCenter: { value: this.center }, uRadius: { value: 1 }, uPix: { value: 0.001 }, uFade: { value: 1 },
        // The surface colour is more saturated than the light the star casts, so its class shows.
        uRot: { value: new Matrix3() }, uTime: { value: 0 },
        uColor: { value: new Vector3(Math.pow(c[0], 1.6), Math.pow(c[1], 1.6), Math.pow(c[2], 1.6)) },
        // Bright enough to bloom, low enough that granulation and the darker limb survive tone mapping.
        uSeed: { value: seedFloat(def.seed) }, uOct: { value: 6 }, uGain: { value: 1.05 + 2.0 * hot },
      },
      ...NO_DEPTH,
    });
    this.surface = new Mesh(SPHERE, this.material);
    this.surface.frustumCulled = false;
    this.surface.renderOrder = 0;
    this.glow = new Glow([0.25 + 0.75 * c[0], 0.25 + 0.75 * c[1], 0.25 + 0.75 * c[2]], 0.35);
    this.glow.mesh.renderOrder = 1;
    this.group.add(this.surface, this.glow.mesh);
  }

  update(body: BodyView, frame: SpaceFrame, params: ViewParams): void {
    const def = this.def;
    const k = compress(body, this.center);
    const radius = def.radius * k;
    const px = def.radius / body.dist / params.pixAngle;
    const u = this.material.uniforms;
    this.surface.visible = px > 0.8;
    if (this.surface.visible) {
      u.uRadius!.value = radius;
      u.uPix!.value = params.pixAngle;
      u.uFade!.value = smoothstep(0.8, 2.0, px);
      u.uOct!.value = octaves(px, params.quality);
      u.uTime!.value = params.clock;
      bodyRotation(def, this.tilt, frame.time, u.uRot!.value as Matrix3);
      this.surface.position.copy(this.center);
      this.surface.scale.setScalar(radius * 1.004 + 2 * params.pixAngle * SAFE_DIST);
    }
    const flux = effectiveLum(def) / (4 * Math.PI * body.dist * body.dist) / 1361;
    const g = glare(flux, params);
    const size = Math.max(g.sizePx, px * 3.2);
    // Up close the disc itself is the light; the corona around it is toned down.
    const t = smoothstep(3, 40, px);
    const gain = g.gain * (1 - t) + 0.4 * t;
    const sigma = Math.max(1.3 * (params.height / 1080), (size - px) * (0.035 + 0.09 * t));
    this.glow.set(this.center, params, size, px, sigma, gain, 0.4);
  }

  dispose(): void {
    this.material.dispose();
    this.glow.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Neutron stars
// ---------------------------------------------------------------------------------------------

const JET_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAlong;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(modelMatrix) * normal;
  vAlong = uv.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
// A cone of glowing gas: brightest seen through its middle, fading along its length, with knots moving outward.
const JET_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAlong;
void main() {
  float facing = abs(dot(normalize(vNormal), normalize(vWorld)));
  float body = pow(facing, 1.6);
  float fade = pow(1.0 - vAlong, 1.8) * smoothstep(0.0, 0.015, vAlong);
  float knots = 0.72 + 0.28 * sin(vAlong * 46.0 - uTime * 5.0) * sin(vAlong * 17.0 - uTime * 2.3 + 1.0);
  gl_FragColor = vec4(uColor * uGain * body * fade * knots, 1.0);
}
`;

function jetGeometry(width: number): CylinderGeometry {
  // Apex at the origin, opening along +Y to unit length.
  const geo = new CylinderGeometry(width, width * 0.02, 1, 40, 1, true);
  geo.translate(0, 0.5, 0);
  return geo;
}

class NeutronVisual implements Visual {
  readonly group = new Group();
  private readonly center = new Vector3();
  private readonly glow: Glow;
  private readonly jets: Mesh[] = [];
  private readonly jetMats: ShaderMaterial[] = [];
  private readonly geos: CylinderGeometry[] = [];

  constructor(private readonly def: BodyDef) {
    const c = starColor(def);
    this.glow = new Glow([0.3 + 0.7 * c[0], 0.3 + 0.7 * c[1], 0.3 + 0.7 * c[2]], 0.5);
    this.glow.mesh.renderOrder = 2;
    this.group.add(this.glow.mesh);
    if (def.jets) {
      const jc = hexToLinear(def.jets.color);
      const axis = bodyAxis(def);
      const ax = new Vector3(axis[0], axis[1], axis[2]);
      // A wide faint sheath and a narrow bright core, on both poles.
      for (const [width, gain] of [[0.085, 0.55], [0.022, 2.6]] as const) {
        const geo = jetGeometry(width);
        const mat = new ShaderMaterial({
          vertexShader: JET_VERT, fragmentShader: JET_FRAG,
          uniforms: { uColor: { value: new Vector3(jc[0], jc[1], jc[2]) }, uGain: { value: gain }, uTime: { value: 0 } },
          side: DoubleSide, blending: AdditiveBlending, ...NO_DEPTH,
        });
        this.geos.push(geo);
        this.jetMats.push(mat);
        for (const sign of [1, -1]) {
          const mesh = new Mesh(geo, mat);
          mesh.quaternion.setFromUnitVectors(UP, ax.clone().multiplyScalar(sign));
          mesh.frustumCulled = false;
          mesh.renderOrder = 1;
          this.jets.push(mesh);
          this.group.add(mesh);
        }
      }
    }
  }

  update(body: BodyView, _frame: SpaceFrame, params: ViewParams): void {
    const k = compress(body, this.center);
    const flux = effectiveLum(this.def) / (4 * Math.PI * body.dist * body.dist) / 1361;
    const g = glare(flux, params);
    const res = params.height / 1080;
    // The star itself is never resolved: a hard white core inside a blue glare.
    this.glow.set(this.center, params, g.sizePx * 0.8, 0, Math.max(1.3 * res, g.sizePx * 0.02), g.gain * 0.5, 0.22);
    const length = this.def.jets ? this.def.jets.length * k : 0;
    const visible = length / SAFE_DIST / params.pixAngle > 3;
    for (const mesh of this.jets) {
      mesh.visible = visible;
      mesh.position.copy(this.center);
      mesh.scale.setScalar(length);
    }
    for (const mat of this.jetMats) mat.uniforms.uTime!.value = params.clock;
  }

  dispose(): void {
    this.glow.dispose();
    for (const mat of this.jetMats) mat.dispose();
    for (const geo of this.geos) geo.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Asteroid belts
// ---------------------------------------------------------------------------------------------

const BELT_VERT = /* glsl */ `
attribute float aRand;
uniform float uPx;
uniform float uNear;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Rocks near the camera are drawn by the local scene, so the points fade out there.
  vAlpha = smoothstep(uNear, uNear * 4.0, length(mv.xyz)) * (0.35 + 0.65 * aRand);
  gl_PointSize = uPx * (0.8 + 0.9 * aRand);
  gl_Position = projectionMatrix * mv;
}
`;
const BELT_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(uColor * vAlpha * smoothstep(0.5, 0.15, r), 1.0);
}
`;
const BELT_TINT = { rock: [0.55, 0.47, 0.40], metal: [0.52, 0.56, 0.62], ice: [0.55, 0.66, 0.78] } as const;

/** A belt seen from afar: a faint ring of points in the reference plane around its parent body. */
class BeltVisual {
  readonly points: Points;
  private readonly material: ShaderMaterial;
  private readonly tint: Vector3;

  constructor(private readonly def: BeltDef, quality: number) {
    const count = quality === 0 ? 5000 : quality === 1 ? 10000 : 18000;
    const rnd = seededRandom(def.seed);
    const pos = new Float32Array(count * 3);
    const rand = new Float32Array(count);
    const inner = def.inner / def.outer;
    for (let i = 0; i < count; i++) {
      // Uniform over the annulus, thinned toward both edges; unit length is the outer radius.
      let r = 0;
      for (let tries = 0; tries < 4; tries++) {
        r = Math.sqrt(inner * inner + rnd() * (1 - inner * inner));
        const x = (r - inner) / (1 - inner);
        if (rnd() < 0.25 + 3 * x * (1 - x)) break;
      }
      const a = rnd() * Math.PI * 2;
      pos[i * 3] = r * Math.cos(a);
      pos[i * 3 + 1] = ((rnd() + rnd() + rnd()) / 3 - 0.5) * (def.height / def.outer);
      pos[i * 3 + 2] = r * Math.sin(a);
      rand[i] = rnd();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aRand', new BufferAttribute(rand, 1));
    const tint = BELT_TINT[def.kind];
    this.tint = new Vector3(tint[0], tint[1], tint[2]).multiplyScalar(0.11);
    this.material = new ShaderMaterial({
      vertexShader: BELT_VERT, fragmentShader: BELT_FRAG,
      uniforms: { uColor: { value: this.tint.clone() }, uPx: { value: 1.5 }, uNear: { value: 1 } },
      blending: AdditiveBlending, ...NO_DEPTH,
    });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 0;
  }

  update(frame: SpaceFrame, params: ViewParams): void {
    const parent = frame.bodies[this.def.parent];
    if (!parent) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    // Scale so the far side of the belt stays inside the camera's range.
    const k = 5000 / (parent.dist + this.def.outer);
    this.points.position.set(parent.rel[0] * k, parent.rel[1] * k, parent.rel[2] * k);
    this.points.scale.setScalar(this.def.outer * k);
    // Seen edge-on all points pile up into a thin line, so the belt is dimmed there.
    const above = Math.abs(parent.rel[1]) / Math.max(parent.dist, 1);
    (this.material.uniforms.uColor!.value as Vector3).copy(this.tint).multiplyScalar(0.3 + 0.7 * smoothstep(0.03, 0.35, above));
    this.material.uniforms.uPx!.value = 1.6 * (params.height / 1080);
    this.material.uniforms.uNear!.value = this.def.outer * 0.004 * k;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------------------------

export class Bodies {
  /** Everything this layer draws; lives in the celestial scene. */
  readonly group = new Group();
  private visuals: Visual[] = [];
  private belts: BeltVisual[] = [];
  private system: unknown = null;
  private signature = '';
  private readonly order: number[] = [];

  constructor(private readonly sky: () => CubeTexture | null) {}

  update(frame: SpaceFrame, params: ViewParams): void {
    this.sync(frame, params.quality);
    const bodies = frame.bodies;
    // Far to near: nearer bodies are drawn over farther ones.
    this.order.length = 0;
    for (let i = 0; i < this.visuals.length && i < bodies.length; i++) this.order.push(i);
    this.order.sort((a, b) => bodies[b]!.dist - bodies[a]!.dist);
    for (let rank = 0; rank < this.order.length; rank++) {
      const i = this.order[rank]!;
      const visual = this.visuals[i]!;
      visual.group.renderOrder = rank + 1;
      visual.update(bodies[i]!, frame, params);
    }
    for (const belt of this.belts) belt.update(frame, params);
  }

  /** Rebuilds the visuals when the system (or the quality level that sizes them) changed. */
  private sync(frame: SpaceFrame, quality: number): void {
    if (frame.system === this.system && this.signature.endsWith(`|${quality}`)) return;
    this.system = frame.system;
    let signature = frame.system.id;
    for (const b of frame.system.bodies) signature += `,${b.cls}${b.seed}${b.rings ? 'r' : ''}${b.disk ? 'd' : ''}`;
    signature += `|${frame.system.belts.length}|${quality}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.clear();
    for (const def of frame.system.bodies) {
      let visual: Visual;
      if (def.cls === 'BH') visual = new BlackHoleVisual(def, this.sky);
      else if (def.cls === 'NS') visual = new NeutronVisual(def);
      else if (def.kind === 'star') visual = new StarVisual(def);
      else visual = new PlanetVisual(def);
      this.visuals.push(visual);
      this.group.add(visual.group);
    }
    for (const def of frame.system.belts) {
      const belt = new BeltVisual(def, quality);
      this.belts.push(belt);
      this.group.add(belt.points);
    }
  }

  private clear(): void {
    for (const v of this.visuals) {
      this.group.remove(v.group);
      v.dispose();
    }
    for (const b of this.belts) {
      this.group.remove(b.points);
      b.dispose();
    }
    this.visuals = [];
    this.belts = [];
  }

  dispose(): void {
    this.clear();
  }
}
