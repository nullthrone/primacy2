import { CustomBlending, Group, Matrix3, Matrix4, Mesh, OneFactor, OneMinusSrcAlphaFactor, Quaternion, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { CubeTexture } from 'three';
import type { BodyDef } from '@primacy2/shared';
import type { BodyView } from '../../contracts.ts';
import { GLSL_NOISE } from './glsl.ts';
import { effectiveLum, hexToLinear } from './lighting.ts';
import { bodyAxis, type SpaceFrame, type ViewParams } from './types.ts';
import { Glow, NO_DEPTH, QUAD, glare, smoothstep, type Visual } from './visual.ts';

/** Radius of the sphere inside which rays are bent, in Schwarzschild radii. Outside it rays are straight. */
const LENS_RADIUS = 40;

const VERT = /* glsl */ `
uniform mat3 uCamRot;
uniform vec2 uTan;
varying vec3 vDir;
void main() {
  vDir = uCamRot * vec3(position.xy * uTan, -1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// All lengths are in Schwarzschild radii with the hole at the origin. Photon paths in the
// Schwarzschild metric follow d2x/dt2 = -1.5 h^2 x / r^5 (h = |x cross v|), which is integrated
// step by step inside the lens sphere. The accretion disk is the plane through the hole normal to
// uAxis; bent rays can cross it several times, which draws the far side arching over the shadow.
const FRAG = /* glsl */ `
uniform samplerCube uSky;
uniform vec3 uCam;
uniform vec3 uAxis;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uInner;
uniform float uOuter;
uniform float uLogSpan;
uniform float uLens;
uniform vec3 uColor;
uniform float uTime;
uniform float uStepK;
uniform int uSteps;
uniform int uOct;
uniform float uFade;
varying vec3 vDir;
${GLSL_NOISE}

vec3 skyAt(vec3 dir) {
  vec4 s = textureLod(uSky, dir, 0.0);
  return s.rgb + s.a * vec3(0.92, 0.96, 1.0);
}

// Streaks along the orbit direction; a is the azimuth, l the natural log of the radius.
float diskNoise(float a, float l) {
  vec2 cs = vec2(cos(a), sin(a));
  float s = 0.0, amp = 0.5, f = 1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= uOct) break;
    s += amp * gnoise(vec3(cs * 1.7 * f, l * 4.5 * f + 3.1 * float(i)));
    amp *= 0.55;
    f *= 2.3;
  }
  return s;
}

// Emission and opacity of the disk where a ray travelling along rd crosses it at pc. Premultiplied.
vec4 diskSample(vec3 pc, vec3 rd) {
  float r = length(pc);
  if (r <= uInner || r >= uOuter) return vec4(0.0);
  float l = log(r / uInner);
  float lr = l / uLogSpan;
  float ang = atan(dot(pc, uE2), dot(pc, uE1));
  // Inner orbits are faster. Two copies of the pattern, half a cycle apart, are cross-faded so
  // the shear never winds the streaks up without limit.
  float om = 0.55 * pow(r / uInner, -1.5);
  float ta = mod(uTime, 16.0), tb = mod(uTime + 8.0, 16.0);
  float wa = 1.0 - abs(ta / 8.0 - 1.0);
  float spiral = ang + l * 1.5;
  float na = diskNoise(spiral - om * (ta - 8.0), l);
  float nb = diskNoise(spiral - om * (tb - 8.0) + 2.4, l + 7.0);
  float n = mix(nb, na, wa);
  // Grazing views would alias the streaks; flatten them there.
  float graze = smoothstep(0.0, 0.06, abs(dot(rd, uAxis)));
  float streak = clamp(0.5 + n * 1.35 * (0.35 + 0.65 * graze), 0.0, 1.0);

  float heat = clamp(1.0 - lr + n * 0.10, 0.0, 1.0);
  vec3 col = mix(vec3(0.42, 0.06, 0.015), vec3(1.0, 0.33, 0.07), smoothstep(0.0, 0.42, heat));
  col = mix(col, vec3(1.0, 0.74, 0.40), smoothstep(0.40, 0.72, heat));
  col = mix(col, vec3(0.86, 0.92, 1.0), smoothstep(0.72, 1.0, heat));
  float edge = smoothstep(0.0, 0.035, lr) * (1.0 - smoothstep(0.80, 1.0, lr));
  float inten = 16.0 * exp(-lr * 6.2) * (0.10 + 0.90 * streak * streak) * edge;

  // Doppler beaming and gravitational redshift: the side moving toward the viewer is brighter and bluer.
  float beta = sqrt(0.5 / max(r, 1.0));
  vec3 orbit = normalize(cross(uAxis, pc));
  float shift = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(orbit, -rd)) * sqrt(max(1.0 - 1.0 / r, 0.0));
  inten *= shift * shift * shift;
  col *= mix(vec3(1.0), vec3(0.72, 1.0, 1.5), clamp((shift - 1.0) * 1.3, -1.0, 1.0));

  float alpha = clamp((0.20 + 0.80 * streak) * mix(0.30, 0.97, smoothstep(0.75, 0.15, lr)) * edge, 0.0, 1.0);
  return vec4(col * uColor * inten * alpha, alpha);
}

vec4 over(vec4 acc, vec4 s) {
  return vec4(acc.rgb + (1.0 - acc.a) * s.rgb, acc.a + (1.0 - acc.a) * s.a);
}

// Distance along a straight ray to the disk plane, or -1.
float planeHit(vec3 o, vec3 d) {
  float dn = dot(d, uAxis);
  if (abs(dn) < 1e-6) return -1.0;
  return -dot(o, uAxis) / dn;
}

void main() {
  vec3 d = normalize(vDir);
  float camR = length(uCam);
  float tca = -dot(uCam, d);
  float b = length(uCam + d * tca);
  bool inside = camR < uLens;
  bool enters = inside || (tca > 0.0 && b < uLens);
  vec4 acc = vec4(0.0);
  vec3 p = uCam;
  vec3 v = d;

  if (!inside) {
    // Straight flight up to the lens sphere (or forever): the disk is flat space out here.
    float tEnter = enters ? tca - sqrt(uLens * uLens - b * b) : 1e30;
    float tp = planeHit(uCam, d);
    if (tp > 0.0 && tp < tEnter) acc = over(acc, diskSample(uCam + d * tp, d));
    if (!enters) {
      if (acc.a <= 0.0) discard;
      gl_FragColor = vec4(acc.rgb, acc.a) * uFade;
      return;
    }
    p = uCam + d * tEnter;
  }

  bool captured = false;
  float rmin = 1e9;
  float h2 = dot(cross(p, v), cross(p, v));
  for (int i = 0; i < 320; i++) {
    if (i >= uSteps) break;
    float r2 = dot(p, p);
    float r = sqrt(r2);
    rmin = min(rmin, r);
    if (r < 1.0) { captured = true; break; }
    if (r > uLens * 1.001 && dot(p, v) > 0.0) break;
    // Steps shrink toward the hole and again around the photon sphere at 1.5.
    float dt = max(0.02, r * uStepK) * mix(0.4, 1.0, smoothstep(0.0, 2.5, abs(r - 1.5)));
    vec3 vn = v - 1.5 * h2 * p / (r2 * r2 * r) * dt;
    vec3 pn = p + vn * dt;
    float y0 = dot(p, uAxis), y1 = dot(pn, uAxis);
    if (y0 * y1 < 0.0) {
      acc = over(acc, diskSample(mix(p, pn, y0 / (y0 - y1)), normalize(vn)));
      if (acc.a > 0.995) break;
    }
    p = pn;
    v = vn;
  }

  // Weight of the lensing, fading to nothing at the edge of the lens sphere so no seam shows.
  float closest = tca > 0.0 ? b : camR;
  float w = 1.0 - smoothstep(0.6 * uLens, uLens, closest);
  vec3 sky = vec3(0.0);
  if (!captured) {
    vec3 vd = normalize(v);
    float tp = planeHit(p, vd);
    if (tp > 0.0 && acc.a < 0.995) acc = over(acc, diskSample(p + vd * tp, vd));
    sky = skyAt(normalize(mix(d, vd, w)));
    // Photon ring: light that grazed the photon sphere.
    float ring = exp(-(rmin - 1.5) * (rmin - 1.5) / 0.012);
    sky += vec3(1.0, 0.82, 0.60) * uColor * ring * 2.5;
  } else {
    w = 1.0;
  }
  float through = 1.0 - acc.a;
  gl_FragColor = vec4(acc.rgb + through * sky * w, 1.0 - through * (1.0 - w)) * uFade;
}
`;

/**
 * A black hole: gravitational lensing of the sky, the shadow, the photon ring and the accretion
 * disk, ray-marched per pixel in a full-screen pass. Far away it shrinks to a glowing point.
 */
export class BlackHoleVisual implements Visual {
  readonly group = new Group();
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly glow: Glow;
  private readonly center = new Vector3();
  private readonly rs: number;
  private readonly rotation = new Matrix4();
  private readonly quat = new Quaternion();

  constructor(private readonly def: BodyDef, private readonly sky: () => CubeTexture | null) {
    this.rs = def.rs !== undefined && def.rs > 0 ? def.rs : def.radius;
    const axis = bodyAxis(def);
    const ax = new Vector3(axis[0], axis[1], axis[2]);
    const e1 = new Vector3().crossVectors(ax, Math.abs(ax.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
    const e2 = new Vector3().crossVectors(ax, e1);
    const disk = def.disk;
    const inner = disk ? Math.max(disk.inner / this.rs, 1.5) : 0;
    const outer = disk ? Math.max(disk.outer / this.rs, inner * 1.5) : 0;
    const color = hexToLinear(disk ? disk.color : 0xffffff);
    this.material = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uSky: { value: null }, uCam: { value: new Vector3() }, uCamRot: { value: new Matrix3() }, uTan: { value: new Vector2() },
        uAxis: { value: ax }, uE1: { value: e1 }, uE2: { value: e2 },
        uInner: { value: inner }, uOuter: { value: outer }, uLogSpan: { value: disk ? Math.log(outer / inner) : 1 },
        uLens: { value: LENS_RADIUS }, uColor: { value: new Vector3(color[0], color[1], color[2]) },
        uTime: { value: 0 }, uStepK: { value: 0.08 }, uSteps: { value: 160 }, uOct: { value: 4 }, uFade: { value: 1 },
      },
      // Premultiplied output: lensed pixels replace the sky, plain disk pixels blend over what lies behind.
      blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, ...NO_DEPTH,
    });
    this.mesh = new Mesh(QUAD, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    this.glow = new Glow([color[0], color[1] * 0.86, color[2] * 0.72]);
    this.glow.mesh.renderOrder = 1;
    this.group.add(this.mesh, this.glow.mesh);
  }

  update(body: BodyView, frame: SpaceFrame, params: ViewParams): void {
    const u = this.material.uniforms;
    compress(body, this.center);
    const extent = Math.max(this.def.disk ? this.def.disk.outer : 0, this.rs * 6);
    const px = extent / body.dist / params.pixAngle;
    const cube = this.sky();
    this.mesh.visible = px > 1.5 && cube !== null;
    if (this.mesh.visible) {
      u.uSky!.value = cube;
      (u.uCam!.value as Vector3).set(-body.rel[0] / this.rs, -body.rel[1] / this.rs, -body.rel[2] / this.rs);
      const q = frame.camera.rot;
      this.rotation.makeRotationFromQuaternion(this.quat.set(q[0], q[1], q[2], q[3]));
      (u.uCamRot!.value as Matrix3).setFromMatrix4(this.rotation);
      const t = Math.tan((frame.camera.fov * Math.PI) / 360);
      (u.uTan!.value as Vector2).set((t * params.width) / params.height, t);
      u.uTime!.value = params.clock;
      u.uSteps!.value = params.quality === 0 ? 70 : params.quality === 1 ? 130 : 220;
      u.uStepK!.value = params.quality === 0 ? 0.15 : params.quality === 1 ? 0.10 : 0.065;
      u.uOct!.value = params.quality === 0 ? 3 : params.quality === 1 ? 4 : 5;
      u.uFade!.value = smoothstep(1.5, 4, px);
    }
    // Unresolved, the disk's light is a point like any star's.
    const flux = effectiveLum(this.def) / (4 * Math.PI * body.dist * body.dist) / 1361;
    const g = glare(flux, params);
    const fade = 1 - smoothstep(3, 60, px);
    this.glow.set(this.center, params, g.sizePx, 0, Math.max(1.1, g.sizePx * 0.03), g.gain * fade, 0.3);
  }

  dispose(): void {
    this.material.dispose();
    this.glow.dispose();
  }
}

function compress(body: BodyView, out: Vector3): void {
  const k = 1000 / Math.max(body.dist, 1);
  out.set(body.rel[0] * k, body.rel[1] * k, body.rel[2] * k);
}
