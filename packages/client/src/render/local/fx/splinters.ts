/**
 * The cloud a blast leaves behind: hundreds of splinters of torn hull that fly apart on straight
 * lines for seconds. Each comes out of the blast glowing white, cools through orange to a dull red
 * and after that only shows by the sun it catches as it tumbles: a faint grey fleck that flashes
 * whenever one of its faces turns the light toward the camera.
 *
 * A splinter is a few centimetres across, which at fighting range is far less than a pixel. So it
 * is never drawn smaller than a size on screen that it carries itself (about 2.5 pixels across
 * while it is hot), and gives up only part of the brightness that would cost: the cloud is meant
 * to be read from kilometres away, not to be measured.
 */
import type { Lighting } from '../../../contracts.ts';
import { TAU } from '../util.ts';
import { QuadBatch } from './batch.ts';
import { Pool, rand, type Frame } from './core.ts';

const VERTEX = /* glsl */ `
attribute vec4 iP; // centre (camera-relative), half length in metres
attribute vec4 iC; // radiance, smallest half size on screen in pixels
attribute vec4 iQ; // turn in the picture, width relative to the length, slant of its outline
uniform float uPix;
varying vec2 vUv;
varying vec3 vCol;
varying vec2 vReal; // how much of the drawn size is real, slant

void main() {
  vec3 c = (modelViewMatrix * vec4(iP.xyz, 1.0)).xyz;
  float size = max(iP.w, iC.a * uPix * max(-c.z, 0.5));
  // How much of the drawn size is the splinter itself: 1 near by, where it has a shape, and close
  // to 0 far away, where it is a dot held at its smallest size.
  float real = iP.w / size;
  float cs = cos(iQ.x), sn = sin(iQ.x);
  vec2 o = position.xy * vec2(1.0, mix(1.0, iQ.y, real));
  o = vec2(o.x * cs - o.y * sn, o.x * sn + o.y * cs) * size;
  vUv = position.xy;
  vReal = vec2(real, iQ.z);
  // The square root, not the square the area would ask for: see the note at the top. Near by,
  // where a splinter covers many pixels, it is a glowing piece of metal and not a lamp. One that
  // passes right by the camera fades instead of filling the view.
  vCol = iC.rgb * sqrt(real) * mix(1.0, 0.5, real) * smoothstep(0.6, 3.0, -c.z);
  gl_Position = projectionMatrix * vec4(c + vec3(o, 0.0), 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec2 vReal;

void main() {
  // Near by a sliver with pointed ends and a hard edge, each slanted its own way; held at its
  // smallest size a soft dot.
  float shard = smoothstep(1.0, 0.75, abs(vUv.x + vReal.y * vUv.y) + abs(vUv.y));
  float round = max(1.0 - dot(vUv, vUv), 0.0);
  float light = mix(round * round, shard, vReal.x);
  if (light <= 0.0) discard;
  gl_FragColor = vec4(vCol * light, 1.0);
}`;

export interface Splinter {
  /** Relative to the zone anchor. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Pull of the ground, m/s^2 along each axis; zero in space. */
  gx: number; gy: number; gz: number;
  age: number; life: number;
  /** Half length in metres. */
  size: number;
  /**
   * How hot it came out of the blast: above 1 white, 0.5 orange, 0.25 dull red. It cools by what
   * it radiates, which is a great deal while it is white and very little once it is red: the heat
   * is this over the cube root of (1 + age / `cool`). So the white is gone in a fraction of a
   * second and the dull red lasts.
   */
  heat: number;
  cool: number;
  /** Tumbling: the angle that decides when a face catches the sun, its rate, and the turn in the picture. */
  phase: number; spin: number; rot: number;
  /** How far its outline leans: no two slivers have the same shape. */
  slant: number;
}

const make = (): Splinter => ({
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, gx: 0, gy: 0, gz: 0, age: 0, life: 1, size: 0.05, heat: 1, cool: 1, phase: 0, spin: 1, rot: 0, slant: 0,
});

/** Half size on screen, pixels, below which a splinter is not drawn: when cold, and what heat adds. */
const FLOOR_COLD = 0.55;
const FLOOR_HOT = 0.7;
/** Seconds over which a splinter fades at the end of its life. */
const OUT = 1.2;

export class Splinters extends QuadBatch {
  private readonly pool: Pool<Splinter>;
  /** Handed out when the pool is full, so callers can set optional fields without checking. */
  private readonly spare = make();

  constructor(max: number) {
    super(max, ['iP', 'iC', 'iQ'], VERTEX, FRAGMENT);
    this.pool = new Pool(max, make);
  }

  /**
   * Starts a splinter and returns it, so the caller can give it a gravity. Position and velocity
   * relative to the zone anchor; `size` its half length in metres; `heat` and `cool` as in `Splinter`.
   */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number,
        heat: number, cool: number): Splinter {
    const p = this.pool.take() ?? this.spare;
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.gx = 0; p.gy = 0; p.gz = 0;
    p.age = 0; p.life = life; p.size = size; p.heat = heat; p.cool = cool;
    p.phase = rand(0, TAU); p.spin = rand(2, 9) * (Math.random() < 0.5 ? -1 : 1); p.rot = rand(0, TAU); p.slant = rand(-0.85, 0.85);
    return p;
  }

  /** Steps the splinters and writes them into the batch. `light` is the light that reaches the camera. */
  update(f: Frame, light: Lighting): void {
    this.begin();
    const items = this.pool.items;
    const d = this.data;
    const dt = f.dt;
    // A matt grey face in the sun, and the glint of a bare metal one that mirrors it for a moment.
    const sun = light.sunIntensity;
    const sr = light.sunColor[0] * sun, sg = light.sunColor[1] * sun, sb = light.sunColor[2] * sun;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += dt;
      if (p.age >= p.life) { this.pool.free(i); continue; }
      p.vx += p.gx * dt; p.vy += p.gy * dt; p.vz += p.gz * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const o = this.next();
      if (o < 0) continue;

      const left = (p.life - p.age) / OUT;
      const k = left < 1 ? left : 1;
      // Glowing metal: red first, green and blue only join when it is hotter. The red is kept
      // strong enough to bloom while the splinter is no more than dull red, or the cloud would be
      // lost against the stars long before it is dark.
      const heat = p.heat / Math.cbrt(1 + p.age / p.cool);
      const t = heat < 1.15 ? heat : 1.15;
      const t2 = t * t, t3 = t2 * t;
      const red = 16 * t * Math.sqrt(t);
      const turn = p.phase + p.spin * p.age;
      const s = Math.sin(turn);
      let glint = 0;
      if (s > 0) { const s2 = s * s, s4 = s2 * s2, s8 = s4 * s4; glint = s8 * s8; }
      const lit = 0.05 + 2 * glint;
      d[o] = p.x + f.zx; d[o + 1] = p.y + f.zy; d[o + 2] = p.z + f.zz; d[o + 3] = p.size;
      d[o + 4] = (red + sr * lit) * k; d[o + 5] = (14 * t3 + sg * lit) * k; d[o + 6] = (9 * t3 * t2 + sb * lit) * k;
      d[o + 7] = FLOOR_COLD + FLOOR_HOT * (t < 0.3 ? t / 0.3 : 1);
      // Seen now flat, now edge-on.
      d[o + 8] = p.rot + 0.37 * turn; d[o + 9] = 0.2 + 0.5 * Math.abs(Math.cos(0.61 * turn)); d[o + 10] = p.slant; d[o + 11] = 0;
    }
    this.end();
  }

  clear(): void {
    this.pool.count = 0;
  }
}
