/**
 * Space dust: a sparse cloud of motes around the camera, the pilot's main sense of speed in normal
 * flight. The motes are fixed relative to the zone anchor and repeat in a box around the camera, so
 * the cloud never runs out. Each is drawn as the streak it sweeps during one exposure: a dot at
 * rest, a line at speed.
 *
 * In development builds `?dust=<m/s>` forces a forward speed, because the dev pages do not move.
 */
import {
  BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, Vector3,
} from 'three';
import type { Vec3 } from '@primacy2/shared';
import type { Lighting } from '../../../contracts.ts';
import { damp, smooth, wrap } from '../util.ts';
import { ADDITIVE, pixelAngle } from './batch.ts';
import { rotate, type Frame, type Track } from './core.ts';

const VERTEX = /* glsl */ `
attribute vec4 iSeed; // place in the repeating box 0..1, brightness 0..1
uniform vec3 uOffset;
uniform float uBox;
uniform vec3 uStreak;
uniform vec3 uColor;
uniform float uPix;
varying vec3 vCol;
varying vec4 vP;

void main() {
  vec3 c = (fract(iSeed.xyz + uOffset) - 0.5) * uBox;
  float dist = length(c);
  // Fade toward the edge of the box, where motes wrap around, and right in front of the lens.
  float fade = (1.0 - smoothstep(0.32, 0.5, dist / uBox)) * smoothstep(1.5, 5.0, dist);
  vec3 a = (modelViewMatrix * vec4(c + uStreak, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(c, 1.0)).xyz;
  vec3 d = b - a;
  float len = length(d);
  vec3 dir = len > 1e-4 ? d / len : vec3(0.0, 1.0, 0.0);
  float end = position.y * 0.5 + 0.5;
  vec3 p = mix(a, b, end);
  vec3 side = cross(dir, p);
  float sl = length(side);
  side = sl > 1e-4 * length(p) ? side / sl : vec3(1.0, 0.0, 0.0);
  // A mote is far smaller than a pixel: it is drawn a pixel wide and dimmer the farther it is.
  float w = 0.85 * uPix * max(-p.z, 0.5);
  vec3 pos = p + side * (position.x * w) + dir * (position.y * w);
  vP = vec4(position.x, end * len + position.y * w, len, w);
  vCol = uColor * fade * (0.35 + 0.65 * iSeed.w) * min(1.0, 9.0 / dist);
  gl_Position = projectionMatrix * vec4(pos, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vCol;
varying vec4 vP;

void main() {
  float dy = (vP.y - clamp(vP.y, 0.0, vP.z)) / vP.w;
  float r2 = vP.x * vP.x + dy * dy;
  if (r2 >= 1.0) discard;
  float t = vP.z > 1e-4 ? clamp(vP.y / vP.z, 0.0, 1.0) : 1.0;
  gl_FragColor = vec4(vCol * exp(-r2 * 2.5) * (1.0 - r2) * mix(0.25, 1.0, t), 1.0);
}`;

const COUNTS = [350, 700, 1200] as const;
const BOX = 110;
/** Exposure time in seconds: how much of its path a mote smears into a streak. */
const SHUTTER = 1 / 55;
const MAX_STREAK = 14;

const FORCED = import.meta.env.DEV && typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('dust') ?? 0) || 0 : 0;
const V: Vec3 = [0, 0, 0];

export class Dust {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly offset = new Vector3();
  private readonly streak = new Vector3();
  private readonly color = new Vector3();
  /** Distance flown under the forced dev speed, in box lengths. */
  private readonly flown: Vec3 = [0, 0, 0];
  private level = 0;

  constructor() {
    const max = COUNTS[2];
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(max * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geometry.setAttribute('iSeed', new InstancedBufferAttribute(seeds, 4));
    geometry.instanceCount = max;
    const uPix = { value: 0.001 };
    const material = new ShaderMaterial({
      ...ADDITIVE,
      uniforms: { uOffset: { value: this.offset }, uBox: { value: BOX }, uStreak: { value: this.streak }, uColor: { value: this.color }, uPix },
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      uPix.value = pixelAngle(renderer, camera);
      material.uniformsNeedUpdate = true;
    };
  }

  update(f: Frame, light: Lighting): void {
    const view = f.view;
    // Camera velocity relative to the anchor: the pilot's ship carries the camera.
    const self = view.self;
    let vx = self ? self.state.vel[0] : 0, vy = self ? self.state.vel[1] : 0, vz = self ? self.state.vel[2] : 0;
    if (FORCED !== 0) {
      const own: Track | undefined = self ? f.tracks.get(self.id) : undefined;
      if (own) {
        rotate(own, 0, 0, -FORCED, V);
        vx = V[0]; vy = V[1]; vz = V[2];
        this.flown[0] = wrap(this.flown[0] - (vx * f.dt) / BOX, 1);
        this.flown[1] = wrap(this.flown[1] - (vy * f.dt) / BOX, 1);
        this.flown[2] = wrap(this.flown[2] - (vz * f.dt) / BOX, 1);
      }
    }
    const speed = Math.hypot(vx, vy, vz);

    // Cruise has its own streaks, drawn behind everything near (render/post/Cruise.ts), and fold
    // its tunnel in the final pass; the dust steps aside for them.
    const want = view.fx.cruise > 0 || view.fx.fold > 0 ? 0 : 1;
    this.level = damp(this.level, want, 4, f.dt);
    this.mesh.visible = this.level > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.geometry.instanceCount = COUNTS[f.quality];

    // A mote at anchor position p is seen at p + zone; only the fraction of a box length matters.
    this.offset.set(wrap(f.zx / BOX + this.flown[0], 1), wrap(f.zy / BOX + this.flown[1], 1), wrap(f.zz / BOX + this.flown[2], 1));
    const smear = Math.min(SHUTTER, MAX_STREAK / Math.max(speed, 1e-3));
    this.streak.set(vx * smear, vy * smear, vz * smear);
    // Sunlit grains: barely there at rest, plain to see once they streak.
    const gain = (0.4 + 0.3 * smooth(5, 160, speed)) * this.level * Math.min(1.5, light.sunIntensity / 3 + 0.25);
    this.color.set(light.sunColor[0] * gain, light.sunColor[1] * gain, light.sunColor[2] * gain);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
