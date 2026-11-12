/**
 * What a hit looks like. On shields: a ripple of light that runs outward from the impact over part
 * of a sphere around the ship. On the hull: a small flash, a spot that glows for a moment and a few
 * flecks flying off.
 */
import {
  DynamicDrawUsage, FrontSide, InstancedBufferAttribute, InstancedMesh, ShaderMaterial, SphereGeometry,
} from 'three';
import type { GameEvent, Vec3 } from '@primacy2/shared';
import { clamp } from '../util.ts';
import { ADDITIVE } from './batch.ts';
import { Pool, rand, randCone, type Frame } from './core.ts';
import type { Flashes, Sparks } from './particles.ts';
import { GLOW } from './sprites.ts';

type HitEvent = Extract<GameEvent, { e: 'hit' }>;

const SHIELD_VERTEX = /* glsl */ `
attribute vec4 iImpact; // unit direction from the centre to the impact, age 0..1
attribute vec3 iTint;
varying vec3 vN;
varying vec3 vToCam;
varying vec4 vImpact;
varying vec3 vTint;

void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(position);
  vToCam = -world.xyz; // the camera sits at the origin of the scene
  vImpact = iImpact;
  vTint = iTint;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SHIELD_FRAGMENT = /* glsl */ `
varying vec3 vN;
varying vec3 vToCam;
varying vec4 vImpact;
varying vec3 vTint;

void main() {
  vec3 n = normalize(vN);
  float ang = acos(clamp(dot(n, vImpact.xyz), -1.0, 1.0));
  float t = vImpact.w, u = 1.0 - t;
  // A hot spot where the shot landed, a front running outward from it, and fine ripples behind the front.
  float front = 0.18 + 1.5 * t;
  float spot = exp(-ang * ang / 0.07);
  float ring = exp(-pow((ang - front) / 0.085, 2.0));
  float behind = 1.0 - smoothstep(front - 0.12, front, ang);
  float ripples = 0.5 + 0.5 * sin(ang * 52.0 - t * 26.0);
  // A shell of light is brightest where it is seen edge-on.
  float limb = 0.3 + 0.7 * pow(1.0 - abs(dot(n, normalize(vToCam))), 2.0);
  float light = spot * u * u * u * 5.0 + (ring * 1.7 + behind * ripples * 0.4) * u * u * limb;
  // The flare never wraps around to the far side.
  light *= smoothstep(2.0, 1.2, ang);
  gl_FragColor = vec4(vTint * light, 1.0);
}`;

interface Flare {
  id: number;
  dx: number; dy: number; dz: number;
  age: number;
  gain: number;
}

const MAX_FLARES = 24;
const FLARE_LIFE = 0.5;
const SHIELD: Readonly<Vec3> = [0.3, 0.58, 1.0];

/** Shield flares: unit spheres scaled to 1.15 ship radii, lit only around the impact. */
class Shields {
  readonly mesh: InstancedMesh<SphereGeometry, ShaderMaterial>;
  private readonly pool = new Pool<Flare>(MAX_FLARES, () => ({ id: 0, dx: 0, dy: 1, dz: 0, age: 0, gain: 1 }));
  private readonly impact = new InstancedBufferAttribute(new Float32Array(MAX_FLARES * 4), 4);
  private readonly tint = new InstancedBufferAttribute(new Float32Array(MAX_FLARES * 3), 3);

  constructor() {
    const geometry = new SphereGeometry(1, 40, 24);
    this.impact.setUsage(DynamicDrawUsage);
    this.tint.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iImpact', this.impact);
    geometry.setAttribute('iTint', this.tint);
    const material = new ShaderMaterial({ ...ADDITIVE, side: FrontSide, vertexShader: SHIELD_VERTEX, fragmentShader: SHIELD_FRAGMENT });
    this.mesh = new InstancedMesh(geometry, material, MAX_FLARES);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  spawn(id: number, dx: number, dy: number, dz: number, gain: number): void {
    // When all are in use the new flare replaces the oldest, which is nearly spent.
    let p = this.pool.take();
    if (!p) {
      p = this.pool.items[0]!;
      for (let i = 1; i < this.pool.count; i++) if (this.pool.items[i]!.age > p.age) p = this.pool.items[i]!;
    }
    p.id = id; p.dx = dx; p.dy = dy; p.dz = dz; p.age = 0; p.gain = gain;
  }

  update(f: Frame): void {
    const items = this.pool.items;
    const m = this.mesh.instanceMatrix.array, impact = this.impact.array, tint = this.tint.array;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      if (p.age >= FLARE_LIFE || !f.tracks.has(p.id)) this.pool.free(i);
    }
    const n = this.pool.count;
    for (let i = 0; i < n; i++) {
      const p = items[i]!;
      const host = f.tracks.get(p.id)!;
      const s = host.radius * 1.15;
      const o = i * 16;
      m[o] = s; m[o + 5] = s; m[o + 10] = s; m[o + 15] = 1;
      m[o + 12] = host.x + f.zx; m[o + 13] = host.y + f.zy; m[o + 14] = host.z + f.zz;
      impact[i * 4] = p.dx; impact[i * 4 + 1] = p.dy; impact[i * 4 + 2] = p.dz; impact[i * 4 + 3] = p.age / FLARE_LIFE;
      tint[i * 3] = SHIELD[0] * p.gain; tint[i * 3 + 1] = SHIELD[1] * p.gain; tint[i * 3 + 2] = SHIELD[2] * p.gain;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.impact.needsUpdate = true;
      this.tint.needsUpdate = true;
    }
  }

  clear(): void {
    this.pool.count = 0;
  }
}

const D: Vec3 = [0, 0, 0];
const HULL_SPARKS = [4, 7, 10] as const;

export class Impacts {
  private readonly shields = new Shields();
  readonly mesh = this.shields.mesh;

  constructor(private readonly f: Frame, private readonly sparks: Sparks, private readonly flashes: Flashes) {}

  hit(ev: HitEvent): void {
    const f = this.f;
    const t = f.tracks.get(ev.id);
    const radius = t ? t.radius : 8;
    const cx = t ? t.x : ev.at[0], cy = t ? t.y : ev.at[1], cz = t ? t.z : ev.at[2];

    // Direction from the centre of the ship to the impact. The server may report the centre itself;
    // the shot then came from the attacker, or failing that is shown on the side facing the camera.
    let nx = ev.at[0] - cx, ny = ev.at[1] - cy, nz = ev.at[2] - cz;
    let d = Math.hypot(nx, ny, nz);
    const exact = d > 0.3 * radius;
    if (!exact) {
      const by = ev.by !== undefined ? f.tracks.get(ev.by) : undefined;
      if (by) { nx = by.x - cx; ny = by.y - cy; nz = by.z - cz; } else { nx = -f.zx - cx; ny = -f.zy - cy; nz = -f.zz - cz; }
      d = Math.hypot(nx, ny, nz);
    }
    if (d < 1e-6) { nx = 0; ny = 1; nz = 0; d = 1; }
    nx /= d; ny /= d; nz /= d;
    const power = Math.sqrt(clamp(ev.dmg / 20, 0.4, 6));

    if (ev.shield && t) {
      this.shields.spawn(t.id, nx, ny, nz, power);
      const r = radius * 1.15;
      const p = this.flashes.spawn(GLOW, nx * r, ny * r, nz * r, 0.1, 1.0 * power, 2.4 * power, 0.45, 0.7, 1.0, 7);
      p.follow = t.id;
      return;
    }

    // Offset of the impact from the centre: as reported, or where the hull roughly is.
    const ox = exact ? ev.at[0] - cx : nx * radius * 0.45;
    const oy = exact ? ev.at[1] - cy : ny * radius * 0.45;
    const oz = exact ? ev.at[2] - cz : nz * radius * 0.45;
    const flash = this.flashes.spawn(GLOW, t ? ox : cx + ox, t ? oy : cy + oy, t ? oz : cz + oz, 0.09, 0.9 * power, 2.6 * power, 1.0, 0.78, 0.5, 12);
    const ember = this.flashes.spawn(GLOW, flash.x, flash.y, flash.z, 0.5, 0.8 * power, 0.4 * power, 1.0, 0.36, 0.08, 4);
    if (t) { flash.follow = t.id; ember.follow = t.id; }
    const count = Math.round(HULL_SPARKS[f.quality] * Math.min(power, 2));
    const vx = t ? t.vx : 0, vy = t ? t.vy : 0, vz = t ? t.vz : 0;
    for (let i = 0; i < count; i++) {
      randCone(nx, ny, nz, 0.8, D);
      const v = rand(14, 70);
      this.sparks.spawn(cx + ox, cy + oy, cz + oz, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v,
        rand(0.25, 0.7), 0.07, 7, 5, 2.4, 0.035);
    }
  }

  update(): void {
    this.shields.update(this.f);
  }

  clear(): void {
    this.shields.clear();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
