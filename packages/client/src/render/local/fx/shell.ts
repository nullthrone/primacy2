/**
 * The shield of a ship, which shows only where something touches it. A shot is swallowed: the
 * shell gives way under it, the light of the shot is drawn into the dent, and a soft dome of the
 * shell's own light flashes up around it and drains off toward its rim. A held beam ends in a spot
 * that tints the shell around it for as long as it is held. A shield that is nearly down answers
 * paler, in patches, and stutters; and when it falls, light runs once over the whole shell, which
 * tears into shreds behind it.
 *
 * One sphere per contact, lit only around the place touched, a smooth membrane throughout. Both of
 * its faces are drawn and tested against the depth of the ship inside: a hit on the far side is
 * seen through the shell, dimmer, and the hull stands in front of it.
 */
import { DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, ShaderMaterial, SphereGeometry } from 'three';
import type { Vec3 } from '@primacy2/shared';
import { ADDITIVE } from './batch.ts';
import { Pool, rotate, type Frame, type Track } from './core.ts';

const VERTEX = /* glsl */ `
attribute vec4 iImpact; // unit direction from the centre to the contact (zone axes); phase 0..1, or the level of a held spot
attribute vec4 iTint;   // radiance of the shell's own light, kind (0 hit, 1 held, 2 collapse)
attribute vec4 iShot;   // radiance of the light that landed, how weak the shield is 0..1
attribute vec4 iAux;    // seed, time, angular size of the dome (radians), 1 when the camera is inside the shell
varying vec3 vN;
varying vec3 vToCam;
varying vec4 vImpact;
varying vec4 vTint;
varying vec4 vShot;
varying vec4 vAux;

void main() {
  vec3 n = normalize(position);
  float ang = acos(clamp(dot(n, iImpact.xyz), -1.0, 1.0));
  // The shell gives way under the shot and comes back; under a held beam it stays pressed in.
  float t = iImpact.w;
  float give = iTint.a < 0.5 ? smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.12, 0.6, t))
    : iTint.a < 1.5 ? 0.5 * t : 0.0;
  float w = 0.3 * iAux.z;
  vec3 p = position * (1.0 - 0.09 * give * exp(-ang * ang / (w * w)));
  vec4 local = instanceMatrix * vec4(p, 1.0);
  vN = n;
  // The camera sits at the origin of the scene. Taken before the part is turned (in a surface
  // frame the effects are kept in the body's axes), so it is in the same axes as the normal.
  vToCam = -local.xyz;
  vImpact = iImpact;
  vTint = iTint;
  vShot = iShot;
  vAux = iAux;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * local;
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vN;
varying vec3 vToCam;
varying vec4 vImpact;
varying vec4 vTint;
varying vec4 vShot;
varying vec4 vAux;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

void main() {
  vec3 n = normalize(vN);
  vec3 axis = vImpact.xyz;
  float c = clamp(dot(n, axis), -1.0, 1.0);
  float ang = acos(c);
  float kind = vTint.a, t = vImpact.w, weak = vShot.a;
  float seed = vAux.x, time = vAux.y, size = vAux.z;
  // The way along the shell that leads away from the contact. Noise laid out along it and moved
  // outward is light that flows off in tongues, with no ring anywhere.
  vec3 away = n - axis * c;
  float al = length(away);
  away = al > 1e-4 ? away / al : vec3(0.0);
  // A shell of light is brightest where it is seen edge-on.
  float edge = pow(1.0 - abs(dot(n, normalize(vToCam))), 2.0);
  vec3 col;

  if (kind < 0.5) {
    float a = ang / size;
    // A soft dome that is there almost at once and widens a little while it lasts.
    // How far its light gets differs from one direction to the next, so its edge is no circle.
    float reach = 0.75 + 0.6 * noise(away * 2.6 + seed * 31.0);
    float w = (0.45 + 0.3 * smoothstep(0.0, 0.3, t) + 0.55 * t) * mix(1.0, reach, smoothstep(0.0, 0.25, t));
    float dome = exp(-a * a / (w * w));
    // It empties from the middle, where the shell gave way: what is left of the light stands ever
    // nearer the rim, and breaks into tongues as it goes.
    float front = mix(-0.5, 1.5, smoothstep(0.04, 0.95, t)) * mix(1.0, reach, 0.6);
    float left = smoothstep(front - 0.5, front + 0.3, a);
    float s1 = noise(away * 2.0 + axis * (a * 0.9 - t * 1.8) + seed * 31.0);
    float s2 = noise(away * 5.0 + axis * (a * 2.0 - t * 3.2) - seed * 13.0);
    float streak = 0.6 * s1 + 0.4 * s2;
    // Spread over more of the shell it is thinner.
    float flow = mix(1.0, 0.4 + 1.6 * streak, smoothstep(0.05, 0.5, t) * smoothstep(0.1, 0.45, a)) / (1.0 + 1.2 * t);
    // The light of the shot itself, shrinking into the middle of the dent and gone.
    float sink = smoothstep(0.0, 0.2, t);
    float shot = exp(-a * a / mix(0.03, 0.0008, sink)) * (1.0 - sink) * (1.0 - sink);
    float limb = 0.55 + 0.45 * edge;
    col = vTint.rgb * (dome * left * flow * pow(1.0 - t, 2.0) * smoothstep(0.0, 0.04, t) * limb) + vShot.rgb * shot;
  } else if (kind < 1.5) {
    // A held beam: the spot it ends in, and the shell around it taking on its colour while light
    // streams away from the spot without pause.
    float flick = 0.86 + 0.14 * sin(time * 91.0 + seed * 40.0) * sin(time * 57.0 + 1.3);
    float core = exp(-ang * ang / 0.003) * flick;
    float s1 = noise(away * 3.2 + axis * (ang * 2.4 - time * 2.2) + seed * 31.0);
    float s2 = noise(away * 7.5 + axis * (ang * 5.0 - time * 3.6) - seed * 13.0);
    float streak = 0.65 * s1 + 0.35 * s2;
    float around = exp(-ang * ang / (0.3 * size * size)) * mix(1.0, 0.4 + 1.6 * streak * streak, smoothstep(0.04, 0.3, ang));
    float limb = 0.55 + 0.45 * edge;
    col = (vShot.rgb * core + (vTint.rgb * 0.4 + vShot.rgb * 0.07) * around * limb) * t;
  } else {
    // The fall of the shield: a band of light that sets out where the last shot landed and runs
    // once over the shell to the far pole. Behind it the shell is in shreds, thin fibres drawn out
    // along the way the light went, which are gone a moment later.
    float front = 3.5 * smoothstep(0.0, 0.6, t);
    float behind = front - ang;
    float band = smoothstep(-0.18, 0.0, behind) * exp(-max(behind, 0.0) * 5.0);
    float fibre = noise(away * 5.0 + axis * (ang * 1.5) + seed * 17.0) * 0.6 + noise(away * 12.0 + axis * (ang * 3.0) - seed * 5.0) * 0.4;
    float shreds = step(0.0, behind) * exp(-behind * 1.6) * smoothstep(0.5, 0.72, fibre);
    // Mostly its edge: a whole shell lit face-on would be a disc, not a membrane.
    float limb = 0.2 + 0.8 * edge;
    col = vTint.rgb * (band * (0.55 + 0.9 * fibre) + shreds * 0.7) * limb * (1.0 - smoothstep(0.6, 1.0, t));
  }

  // A weak shield: holes in what it shows, a stutter like a failing lamp, and the colour gone out of it.
  float thin = noise(n * 4.5 + seed * 17.0);
  float holes = mix(1.0, smoothstep(0.36, 0.6, thin), weak);
  float beat = step(0.42, fract(sin(floor(time * 34.0) * 12.9898 + seed * 78.233) * 43758.5453));
  col *= holes * mix(1.0, 0.2 + 0.8 * beat, weak) * (1.0 - 0.5 * weak);
  col = mix(col, vec3(dot(col, vec3(0.3, 0.45, 0.25))) * 0.7, 0.7 * weak);

  // The far side is seen through the shell, so it is dimmer. From inside, where the pilot of the
  // ship sits, the shell fills the view: there it is a veil, not a wall of light.
  col *= gl_FrontFacing ? 1.0 : mix(0.3, 0.2, vAux.w);
  gl_FragColor = vec4(col, 1.0);
}`;

const HIT = 0, HELD = 1, COLLAPSE = 2;

interface Contact {
  id: number;
  kind: number;
  /** Direction from the centre to the contact, in the ship's own axes, so it turns with the ship. */
  dx: number; dy: number; dz: number;
  age: number; life: number;
  /** Angular radius of the dome, radians. */
  size: number;
  gain: number;
  weak: number;
  /** Radiance of the light that landed. */
  sr: number; sg: number; sb: number;
  seed: number;
  /** Held spots: who holds it, and the effect time of its last report. */
  by: number; last: number;
}

const MAX_CONTACTS = 28;
/** Radius of the shell in ship radii. */
export const SHELL = 1.15;
/** The shell's own light: a cold blue; and what is left of it when the shield is failing. */
const SHIELD: Readonly<Vec3> = [0.26, 0.56, 1.0];
const PALE: Readonly<Vec3> = [0.62, 0.78, 1.0];
/** A held beam is reported about ten times a second: it holds this long after a report and is gone after that. */
const HOLD = 0.14, GONE = 0.36;

const D: Vec3 = [0, 0, 0];

export class Shell {
  readonly mesh: InstancedMesh<SphereGeometry, ShaderMaterial>;
  private readonly pool = new Pool<Contact>(MAX_CONTACTS, () => ({
    id: 0, kind: HIT, dx: 0, dy: 1, dz: 0, age: 0, life: 1, size: 0.6, gain: 1, weak: 0, sr: 0, sg: 0, sb: 0, seed: 0, by: -1, last: 0,
  }));
  private readonly impact = new InstancedBufferAttribute(new Float32Array(MAX_CONTACTS * 4), 4);
  private readonly tint = new InstancedBufferAttribute(new Float32Array(MAX_CONTACTS * 4), 4);
  private readonly shot = new InstancedBufferAttribute(new Float32Array(MAX_CONTACTS * 4), 4);
  private readonly aux = new InstancedBufferAttribute(new Float32Array(MAX_CONTACTS * 4), 4);

  constructor() {
    const geometry = new SphereGeometry(1, 48, 28);
    for (const a of [this.impact, this.tint, this.shot, this.aux]) a.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iImpact', this.impact);
    geometry.setAttribute('iTint', this.tint);
    geometry.setAttribute('iShot', this.shot);
    geometry.setAttribute('iAux', this.aux);
    const material = new ShaderMaterial({ ...ADDITIVE, side: DoubleSide, vertexShader: VERTEX, fragmentShader: FRAGMENT });
    this.mesh = new InstancedMesh(geometry, material, MAX_CONTACTS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** A free contact; when all are in use the oldest shot is given up, which is nearly spent. */
  private take(): Contact {
    let p = this.pool.take();
    if (!p) {
      p = this.pool.items[0]!;
      for (let i = 1; i < this.pool.count; i++) {
        const q = this.pool.items[i]!;
        if (q.kind === HIT && (p.kind !== HIT || q.age / q.life > p.age / p.life)) p = q;
      }
    }
    p.seed = Math.random();
    p.by = -1;
    return p;
  }

  /**
   * A shot lands on the shield of `t`. (lx, ly, lz) is the unit direction from the centre to the
   * place, in the ship's axes; `power` is about 1 for a pulse bolt and 3.6 for a rail slug; `weak`
   * 0 for a sound shield to 1 for one about to fall; `shot` the radiance of what landed.
   */
  hit(t: Track, lx: number, ly: number, lz: number, power: number, weak: number, shot: Readonly<Vec3>, gain: number): void {
    // Fire hammering one place keeps one dome going instead of piling light into a solid bubble.
    let p: Contact | null = null;
    for (let i = 0; i < this.pool.count; i++) {
      const q = this.pool.items[i]!;
      if (q.id === t.id && q.kind === HIT && q.age < 0.2 && q.dx * lx + q.dy * ly + q.dz * lz > 0.92) p = q;
    }
    p ??= this.take();
    p.id = t.id; p.kind = HIT; p.dx = lx; p.dy = ly; p.dz = lz;
    p.age = 0; p.life = 0.5 + 0.12 * power;
    p.size = 0.3 + 0.09 * power;
    p.gain = 0.8 + 0.25 * power;
    p.weak = weak;
    p.sr = shot[0] * gain; p.sg = shot[1] * gain; p.sb = shot[2] * gain;
  }

  /** A beam held on the shield of `t` by `by`: starts the spot or keeps it alive and moves it along. */
  hold(t: Track, by: number, lx: number, ly: number, lz: number, weak: number, shot: Readonly<Vec3>, gain: number, now: number): void {
    let p: Contact | null = null;
    for (let i = 0; i < this.pool.count; i++) {
      const q = this.pool.items[i]!;
      if (q.id === t.id && q.kind === HELD && q.by === by) p = q;
    }
    if (!p) {
      p = this.take();
      p.age = 0;
    }
    p.id = t.id; p.kind = HELD; p.by = by; p.dx = lx; p.dy = ly; p.dz = lz;
    p.life = 1; p.size = 0.6; p.gain = 1.5; p.weak = weak; p.last = now;
    p.sr = shot[0] * gain; p.sg = shot[1] * gain; p.sb = shot[2] * gain;
  }

  /** True while `by` holds a beam on the shield of ship `id`. */
  held(id: number, by: number): boolean {
    for (let i = 0; i < this.pool.count; i++) {
      const q = this.pool.items[i]!;
      if (q.id === id && q.kind === HELD && q.by === by) return true;
    }
    return false;
  }

  /** The shield of `t` falls; the light sets out from (lx, ly, lz), a unit direction in the ship's axes. */
  collapse(t: Track, lx: number, ly: number, lz: number): void {
    const p = this.take();
    p.id = t.id; p.kind = COLLAPSE; p.dx = lx; p.dy = ly; p.dz = lz;
    p.age = 0; p.life = 0.8; p.size = 1; p.gain = 1.05; p.weak = 0;
    p.sr = 0; p.sg = 0; p.sb = 0;
  }

  update(f: Frame): void {
    const items = this.pool.items;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      const host = f.tracks.get(p.id);
      // A track outlives its ship by a few seconds; a shell does not.
      const over = p.kind === HELD ? f.now - p.last > GONE : p.age >= p.life;
      if (over || !host || host.seen < f.now) this.pool.free(i);
    }
    const n = this.pool.count;
    const m = this.mesh.instanceMatrix.array, impact = this.impact.array, tint = this.tint.array, shot = this.shot.array, aux = this.aux.array;
    const time = f.now % 97;
    for (let i = 0; i < n; i++) {
      const p = items[i]!;
      const host = f.tracks.get(p.id)!;
      const t = p.age / p.life;
      // The shreds of a fallen shield drift outward.
      const s = host.radius * SHELL * (p.kind === COLLAPSE ? 1 + 0.14 * t * t : 1);
      const x = host.x + f.zx, y = host.y + f.zy, z = host.z + f.zz;
      const o = i * 16, k = i * 4;
      m[o] = s; m[o + 5] = s; m[o + 10] = s; m[o + 15] = 1;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z;
      rotate(host, p.dx, p.dy, p.dz, D);
      impact[k] = D[0]; impact[k + 1] = D[1]; impact[k + 2] = D[2];
      let level = t;
      if (p.kind === HELD) {
        const since = f.now - p.last;
        level = Math.min(1, 0.3 + p.age / 0.08) * (since <= HOLD ? 1 : 1 - (since - HOLD) / (GONE - HOLD));
      }
      impact[k + 3] = level;
      const c = p.kind === COLLAPSE ? PALE : SHIELD;
      tint[k] = c[0] * p.gain; tint[k + 1] = c[1] * p.gain; tint[k + 2] = c[2] * p.gain; tint[k + 3] = p.kind;
      shot[k] = p.sr; shot[k + 1] = p.sg; shot[k + 2] = p.sb; shot[k + 3] = p.weak;
      aux[k] = p.seed; aux[k + 1] = time; aux[k + 2] = p.size;
      aux[k + 3] = x * x + y * y + z * z < s * s ? 1 : 0;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.impact.needsUpdate = true;
      this.tint.needsUpdate = true;
      this.shot.needsUpdate = true;
      this.aux.needsUpdate = true;
    }
  }

  clear(): void {
    this.pool.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
