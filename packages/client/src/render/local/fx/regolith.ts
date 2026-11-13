/**
 * Regolith thrown up from the ground of an airless body: by the jets and engines of a ship that
 * fires them at the ground from close above it, and in a burst by anything that strikes it.
 *
 * There is no air to hold dust, so nothing billows. Each grain leaves the place the exhaust hits
 * nearly along the surface, flies a flat ballistic arc under the body's own gravity and lies
 * still where it comes down; on a small moon that takes many seconds and carries it a long way.
 * What is drawn is a clump of dust per grain, as the streak it sweeps in a moment, spreading and
 * thinning as it flies. Dust shines only by the light that falls on it: the sun, or at night the
 * landing light of the pilot's ship.
 *
 * How hard a ship blows on the ground is read off its motion: whatever it accelerates by beyond
 * free fall, its thrusters push, and their gas leaves the other way. That covers the pilot's
 * keys, flight assist holding the ship up or braking its fall, and a lift-off alike. What moves
 * the dust is the force of the gas, so a freighter hovering on a heavy moon raises far more than
 * a scout on a light one.
 *
 * The ground under the pilot's ship comes from the frame view (height, normal); for other ships
 * and for events it is asked of the shared terrain, once each. Grains are not tested against the
 * terrain while they fly: a grain lands when its arc returns to the plane it was launched from.
 * Everything is kept in the axes of the zone's frame, as the other effects are (see `core.ts`);
 * dust exists only while that frame is the surface frame of the body below.
 *
 * A ground base keeps its landing pads swept: nothing rises from a pad's plate, and little from
 * the sintered apron around the base.
 */
import {
  EntityFlag, EntityKind, FlightMode, G, HULLS, SURFACE_ID_BASE, bodySurface, groundSiteRotation, quat, siteStructure, terrainSample,
} from '@primacy2/shared';
import type { BodySurface, GameEvent, Vec3 } from '@primacy2/shared';
import type { Lighting } from '../../../contracts.ts';
import {
  LAMP_DROP, LAMP_FORE, LAMP_FORWARD, LAMP_HALF_ANGLE, LAMP_PENUMBRA, TAU, clamp, clamp01, damp, groundAlbedo, landingLampIntensity,
  landingLampLevel, smooth,
} from '../util.ts';
import { QuadBatch } from './batch.ts';
import { Pool, rand, rotate, type Frame, type Track } from './core.ts';

const VERTEX = /* glsl */ `
attribute vec4 iA; // tail position (camera-relative), half width in metres
attribute vec4 iB; // head position
attribute vec4 iC; // radiance at the head, brightness of the tail relative to the head
uniform float uPix;
varying vec3 vCol;
varying vec4 vP;   // across -1..1, metres along from the tail, length, half width
varying float vTail;

void main() {
  vec3 a = (modelViewMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(iB.xyz, 1.0)).xyz;
  vec3 d = b - a;
  float len = length(d);
  vec3 dir = len > 1e-4 ? d / len : vec3(0.0, 1.0, 0.0);
  float end = position.y * 0.5 + 0.5;
  vec3 p = mix(a, b, end);
  vec3 side = cross(dir, p);
  float sl = length(side);
  side = sl > 1e-4 * length(p) ? side / sl : vec3(1.0, 0.0, 0.0);
  // Never thinner than a pixel; what a distant clump gains in width it loses in brightness.
  float w = max(iA.w, 0.8 * uPix * max(-p.z, 0.5));
  vec3 pos = p + side * (position.x * w) + dir * (position.y * w);
  vP = vec4(position.x, end * len + position.y * w, len, w);
  vCol = iC.rgb * (iA.w / w);
  vTail = iC.a;
  gl_Position = projectionMatrix * vec4(pos, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vCol;
varying vec4 vP;
varying float vTail;

void main() {
  float dy = (vP.y - clamp(vP.y, 0.0, vP.z)) / vP.w;
  float r2 = vP.x * vP.x + dy * dy;
  if (r2 >= 1.0) discard;
  // Dust has no core: an even haze that is gone at its rim.
  float soft = (1.0 - r2) * (1.0 - r2);
  float t = vP.z > 1e-4 ? clamp(vP.y / vP.z, 0.0, 1.0) : 1.0;
  gl_FragColor = vec4(vCol * soft * mix(vTail, 1.0, t), 1.0);
}`;

class Haze extends QuadBatch {
  constructor(max: number) {
    super(max, ['iA', 'iB', 'iC'], VERTEX, FRAGMENT);
  }

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number,
      r: number, g: number, b: number, tail: number): void {
    const i = this.next();
    if (i < 0) return;
    const d = this.data;
    d[i] = ax; d[i + 1] = ay; d[i + 2] = az; d[i + 3] = width;
    d[i + 4] = bx; d[i + 5] = by; d[i + 6] = bz; d[i + 7] = 0;
    d[i + 8] = r; d[i + 9] = g; d[i + 10] = b; d[i + 11] = tail;
  }
}

interface Grain {
  /** Where it left the ground, relative to the zone anchor. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Gravity where it was launched, m/s^2. */
  gx: number; gy: number; gz: number;
  age: number;
  /** Seconds until its arc is back on the ground. */
  life: number;
  /** Half width of the clump at launch and at the end. */
  w0: number; w1: number;
  /** How much light the clump scatters, 0..1. */
  dense: number;
}

type HitEvent = Extract<GameEvent, { e: 'hit' }>;
type ShotEvent = Extract<GameEvent, { e: 'shot' }>;
type DestroyedEvent = Extract<GameEvent, { e: 'destroyed' }>;

const MAX_GRAINS = 4200;
/** Exhaust reaches the ground and moves dust from this far away, metres. */
const REACH = 40;
/** Grains per second under a ship blowing at full force right above the ground: the pilot's own, any other. */
const RATE_OWN = 520;
const RATE_OTHER = 160;
/** Thrust in newtons at which the dust is at its thickest; a Wisp hovering in a sixteenth of a g pushes a third of it. */
const FULL_FORCE = 70_000;
/** Other ships raise dust only this near the camera, metres. */
const OTHER_RANGE = 900;
/** A grain that is still flying after this many seconds has thinned out of sight. */
const MAX_FLIGHT = 9;
/** The streak a clump is drawn as covers this many seconds of its flight. */
const SHUTTER = 0.24;
/** How much of the light falling on it a fresh clump sends on; several overlap near the ship. */
const DENSITY = 0.26;
/** Share of the dust that loose ground gives which the sintered apron of a base gives. */
const APRON_DUST = 0.3;
/** Cosines of the edge of the landing light's cone and of the angle inside which it has its full strength. */
const LAMP_EDGE = Math.cos(LAMP_HALF_ANGLE);
const LAMP_CORE = Math.cos(LAMP_HALF_ANGLE * (1 - LAMP_PENUMBRA));
/** An event this close above the ground strikes it, metres. */
const STRIKE_HEIGHT = 0.8;
/** A ship blown up within this height throws up the ground under it. */
const BLAST_HEIGHT = 40;

// Scratch.
const B: Vec3 = [0, 0, 0];
const N: Vec3 = [0, 0, 0];
const SAMPLE = new Float64Array(2);
const TINT = [0.2, 0.2, 0.2];

export class Regolith {
  readonly mesh: Haze['mesh'];
  private readonly haze = new Haze(MAX_GRAINS);
  private readonly pool = new Pool<Grain>(MAX_GRAINS, () => ({
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, gx: 0, gy: 0, gz: 0, age: 0, life: 1, w0: 0.4, w1: 2, dense: 0.2,
  }));
  /** Fractions of a grain carried to the next frame, per emitter: own jets, own engine, other ships. */
  private readonly owed = [0, 0, 0];
  /** The pilot's ship a frame ago, to tell a touchdown and how hard it was. */
  private wasHeight = Infinity;
  private wasSink = 0;
  private wasSpeed = 0;
  /** Its velocity a frame ago and its smoothed acceleration, in zone axes; `moving` false until there is a frame to compare with. */
  private moving = false;
  private pvx = 0;
  private pvy = 0;
  private pvz = 0;
  private ax = 0;
  private ay = 0;
  private az = 0;
  /** Pads and aprons of the bases on the body below: per pad or apron its centre (zone axes), its radius and 1 for a pad, 0 for an apron. */
  private swept: Float64Array = new Float64Array(0);
  private sweptFor: BodySurface | null = null;
  /** Colour of the ground under the pilot's ship, linear reflectance. */
  private readonly albedo = [0.2, 0.2, 0.2];

  constructor(private readonly frame: Frame) {
    this.mesh = this.haze.mesh;
    // Drawn before the lights of the other effects, which shine through it.
    this.mesh.renderOrder = -1;
  }

  /** The ground the zone's frame belongs to, or null when dust has no place: away from a landable body, or in another frame. */
  private ground(): BodySurface | null {
    const view = this.frame.view;
    const s = view.surface;
    const self = view.self;
    if (!s || !self || self.state.anchor !== SURFACE_ID_BASE + s.body) return null;
    return bodySurface(view.system, s.body);
  }

  /**
   * How much dust the ground gives at an anchor-relative point: 1 for loose regolith, less on the
   * apron of a base, 0 on the plate of a landing pad.
   */
  private loose(ground: BodySurface, x: number, y: number, z: number): number {
    if (this.sweptFor !== ground) {
      // Built once per body: where the pads and aprons of its bases lie.
      const list: number[] = [];
      for (const site of ground.sites) {
        const def = siteStructure(site);
        if (!site.ground || !def) continue;
        const rot = groundSiteRotation(site);
        list.push(site.ground.pos[0], site.ground.pos[1], site.ground.pos[2], def.bound, 0);
        for (const pad of def.pads ?? []) {
          const at = quat.rotate(rot, pad.pos);
          list.push(site.ground.pos[0] + at[0], site.ground.pos[1] + at[1], site.ground.pos[2] + at[2], pad.r, 1);
        }
      }
      this.swept = Float64Array.from(list);
      this.sweptFor = ground;
    }
    const s = this.swept;
    let share = 1;
    for (let i = 0; i < s.length; i += 5) {
      const dx = x - s[i]!, dy = y - s[i + 1]!, dz = z - s[i + 2]!;
      if (dx * dx + dy * dy + dz * dz > s[i + 3]! * s[i + 3]!) continue;
      if (s[i + 4]! > 0) return 0;
      share = APRON_DUST;
    }
    return share;
  }

  /** Height of an anchor-relative point above the ground beneath it; also leaves the unit vector up in `N`. */
  private heightAt(ground: BodySurface, x: number, y: number, z: number): number {
    const r = Math.sqrt(x * x + y * y + z * z) || 1;
    N[0] = x / r; N[1] = y / r; N[2] = z / r;
    terrainSample(ground.terrain, N[0], N[1], N[2], 0, SAMPLE);
    return r - ground.radius - SAMPLE[0]!;
  }

  /** Surface gravity of the body under the zone, m/s^2. */
  private gravity(ground: BodySurface): number {
    const body = this.frame.view.system.bodies[ground.body]!;
    return Math.max(0.05, (G * body.mass) / (body.radius * body.radius));
  }

  /**
   * Launches `count` grains from around the point (x, y, z) on ground with the unit normal n.
   * They leave between `low` and `high` radians above the surface at up to `speed` m/s, in all
   * directions along it, leaning toward (bx, by, bz) by its length (a vector along the ground).
   * `spread` is the radius of the patch they start from, `size` scales the clumps.
   */
  private launch(
    count: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, g: number,
    low: number, high: number, speed: number, bx: number, by: number, bz: number, spread: number, size: number, dense: number,
  ): void {
    // Two unit vectors along the ground.
    const ax = Math.abs(nx) < 0.8 ? 1 : 0, ay = ax ? 0 : 1;
    const d = ax * nx + ay * ny;
    let ux = ax - nx * d, uy = ay - ny * d, uz = -nz * d;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
    // Straight up at the place; the ground may slope a little against it.
    const r = Math.hypot(x, y, z) || 1;
    const upx = x / r, upy = y / r, upz = z / r;
    const lean = Math.max(0.2, nx * upx + ny * upy + nz * upz);
    for (let i = 0; i < count; i++) {
      const p = this.pool.take();
      if (!p) return;
      const turn = Math.random() * TAU;
      const c = Math.cos(turn), s = Math.sin(turn);
      let hx = ux * c + wx * s + bx, hy = uy * c + wy * s + by, hz = uz * c + wz * s + bz;
      const hl = Math.hypot(hx, hy, hz) || 1;
      hx /= hl; hy /= hl; hz /= hl;
      // Most of the dust leaves low; a little is thrown higher.
      const k = Math.random();
      const rise = low + (high - low) * k * k;
      const v = speed * (0.25 + 0.75 * Math.random());
      const flat = v * Math.cos(rise), up = v * Math.sin(rise);
      const from = spread * Math.sqrt(Math.random());
      p.x = x + hx * from; p.y = y + hy * from; p.z = z + hz * from;
      p.vx = hx * flat + nx * up; p.vy = hy * flat + ny * up; p.vz = hz * flat + nz * up;
      p.gx = -upx * g; p.gy = -upy * g; p.gz = -upz * g;
      p.age = 0;
      p.life = Math.min(MAX_FLIGHT, Math.max(0.25, (2 * up) / (g * lean)));
      p.w0 = size * rand(0.2, 0.45);
      p.w1 = p.w0 + size * rand(0.8, 2.4);
      p.dense = dense * rand(0.5, 1);
    }
  }

  /**
   * A burst from something striking the ground at an anchor-relative point: `strength` is about
   * the speed of the blow in m/s.
   */
  private burst(ground: BodySurface, x: number, y: number, z: number, strength: number): void {
    // Onto the ground beneath the point, straight up as the normal: an impact does not ask for more.
    const h = this.heightAt(ground, x, y, z);
    const gx = x - N[0] * h, gy = y - N[1] * h, gz = z - N[2] * h;
    const k = clamp(strength, 0.5, 40) * this.loose(ground, gx, gy, gz);
    if (k <= 0) return;
    this.launch(Math.round(clamp(k * 14, 6, 420)), gx, gy, gz, N[0], N[1], N[2], this.gravity(ground),
      0.1, 1.15, 3 + k * 1.7, 0, 0, 0, 0.4 + k * 0.12, 1.4 + k * 0.08, DENSITY * 1.15);
  }

  /** A hit that lands on the ground: a ship striking it, a missile going off there, fire that hit a ship standing on it. */
  hit(ev: HitEvent): void {
    const ground = this.ground();
    if (!ground || this.heightAt(ground, ev.at[0], ev.at[1], ev.at[2]) > STRIKE_HEIGHT) return;
    this.burst(ground, ev.at[0], ev.at[1], ev.at[2], clamp(ev.dmg / 4, 2, 32));
  }

  /** A shot that found no target and ended in the ground. */
  shot(ev: ShotEvent): void {
    if (ev.to !== undefined) return;
    const ground = this.ground();
    if (!ground || this.heightAt(ground, ev.at[0], ev.at[1], ev.at[2]) > STRIKE_HEIGHT) return;
    this.burst(ground, ev.at[0], ev.at[1], ev.at[2], 2.5);
  }

  /** A ship blown up on or just above the ground. */
  destroyed(ev: DestroyedEvent): void {
    const ground = this.ground();
    if (!ground || this.heightAt(ground, ev.at[0], ev.at[1], ev.at[2]) > BLAST_HEIGHT) return;
    this.burst(ground, ev.at[0], ev.at[1], ev.at[2], 34);
  }

  /**
   * Dust from one exhaust: gas leaving the point O (anchor-relative) along the unit vector e at
   * `level` 0..1, over ground through the point (gx, gy, gz) with the unit normal n.
   */
  private wash(
    ground: BodySurface, slot: number, rate: number, level: number, clear: number,
    ox: number, oy: number, oz: number, ex: number, ey: number, ez: number,
    gx: number, gy: number, gz: number, nx: number, ny: number, nz: number, g: number,
  ): void {
    if (level < 0.02) return;
    const into = -(ex * nx + ey * ny + ez * nz);
    // Exhaust that leaves along the ground, or away from it, moves nothing.
    if (into < 0.1) return;
    const along = ((ox - gx) * nx + (oy - gy) * ny + (oz - gz) * nz) / into;
    // `clear` is how far from the origin the nozzles are: the hull's own size does not count.
    const near = 1 - clamp01((along - clear) / REACH);
    if (near <= 0) return;
    // Where the gas meets the ground.
    const hx = ox + ex * along, hy = oy + ey * along, hz = oz + ez * along;
    const strength = level * Math.pow(near, 1.3) * Math.min(1, into * 2.5);
    this.owed[slot] = this.owed[slot]! + strength * rate * this.frame.dt * this.loose(ground, hx, hy, hz);
    const count = Math.floor(this.owed[slot]!);
    if (count <= 0) return;
    this.owed[slot] = this.owed[slot]! - count;
    // Which way it is deflected along the ground.
    const sx = ex + nx * into, sy = ey + ny * into, sz = ez + nz * into;
    this.launch(count, hx, hy, hz, nx, ny, nz, g, 0.03, 0.3, 9 + 34 * strength, sx * 1.3, sy * 1.3, sz * 1.3,
      0.5 + 0.2 * Math.max(0, along - clear), 1, DENSITY);
  }

  /** `light` is the light that reaches the camera; `sunlight` how much of the sun that is, 0..1. */
  update(f: Frame, light: Lighting, sunlight: number): void {
    const view = f.view;
    const ground = this.ground();
    const self = view.self;
    const ship = view.surface?.ship;
    const own: Track | undefined = self ? f.tracks.get(self.id) : undefined;
    // The landing lamp of the pilot's ship: its strength (0 when it is off), where it hangs and
    // the unit vector along its beam, in zone axes.
    let lamp = 0;
    let lampX = 0, lampY = 0, lampZ = 0;
    let beamX = 0, beamY = -1, beamZ = 0;

    if (ground && self && ship && own) {
      const g = this.gravity(ground);
      const r = Math.hypot(own.x, own.y, own.z) || 1;
      const upx = own.x / r, upy = own.y / r, upz = own.z / r;
      const under = ship.height + self.stats.belly;
      const gx = own.x - upx * under, gy = own.y - upy * under, gz = own.z - upz * under;
      f.toZone(ship.normal[0], ship.normal[1], ship.normal[2], N);
      const nx = N[0], ny = N[1], nz = N[2];

      // The colour of the dust is the colour of the ground it was.
      terrainSample(ground.terrain, upx, upy, upz, 0, SAMPLE);
      const body = view.system.bodies[ground.body]!;
      groundAlbedo(body.color, body.cls, SAMPLE[1]!, TINT);
      this.albedo[0] = TINT[0]!; this.albedo[1] = TINT[1]!; this.albedo[2] = TINT[2]!;

      const landed = view.mode === FlightMode.Landed;
      const flying = !landed && view.mode === FlightMode.Normal;
      // Acceleration over the ground from one frame to the next, smoothed: corrections from the
      // server arrive as small jumps of the velocity. More than any hull can do is such a jump.
      if (flying && this.moving && f.dt > 1e-4) {
        let ix = (own.vx - this.pvx) / f.dt, iy = (own.vy - this.pvy) / f.dt, iz = (own.vz - this.pvz) / f.dt;
        const most = 3 * Math.max(self.stats.accelFwd, self.stats.accelVert, 1);
        const il = Math.hypot(ix, iy, iz);
        if (il > most) { ix *= most / il; iy *= most / il; iz *= most / il; }
        this.ax = damp(this.ax, ix, 10, f.dt); this.ay = damp(this.ay, iy, 10, f.dt); this.az = damp(this.az, iz, 10, f.dt);
      } else {
        this.ax = 0; this.ay = 0; this.az = 0;
      }
      this.moving = flying;
      this.pvx = own.vx; this.pvy = own.vy; this.pvz = own.vz;

      if (flying && ship.height < REACH + self.stats.radius) {
        // What the thrusters push with: the acceleration seen plus what gravity would have taken.
        const px = this.ax + upx * g, py = this.ay + upy * g, pz = this.az + upz * g;
        const push = Math.hypot(px, py, pz);
        const level = Math.pow(Math.min(1, (push * self.stats.mass) / FULL_FORCE), 0.7);
        if (push > 1e-3) {
          this.wash(ground, 0, RATE_OWN, level, self.stats.belly, own.x, own.y, own.z, -px / push, -py / push, -pz / push, gx, gy, gz, nx, ny, nz, g);
        }
        // The main engines at full burn with the ship held back (at its speed limit, say) still
        // blow out of the stern, though nothing accelerates.
        const burn = clamp01(Math.max(self.input.thrust[2], self.input.throttle));
        if (burn > 0.5) {
          rotate(own, 0, 0, 1, B);
          this.wash(ground, 1, RATE_OWN, 0.5 * burn, self.stats.radius * 0.8, own.x, own.y, own.z, B[0], B[1], B[2], gx, gy, gz, nx, ny, nz, g);
        }
      }

      // Touching the ground throws up a ring of dust, the harder the more.
      if (ship.height <= 0.05 && this.wasHeight > 0.3) {
        const blow = Math.max(0, -this.wasSink) + 0.4 * this.wasSpeed;
        if (blow > 0.4) this.burst(ground, gx, gy, gz, blow * 1.6);
      }
      this.wasHeight = ship.height;
      this.wasSink = ship.verticalSpeed;
      this.wasSpeed = ship.groundSpeed;

      // The landing light, for dust at night: the lamp of `objects/landing.ts`, under the nose
      // with its beam leaning forward, by the numbers the two share.
      if (view.mode === FlightMode.Normal || landed) {
        lamp = landingLampIntensity(ship.height, landingLampLevel(ship.height), sunlight);
        const below = self.stats.belly + LAMP_DROP;
        const fore = LAMP_FORE * self.stats.radius;
        const down = Math.cos(LAMP_FORWARD), ahead = Math.sin(LAMP_FORWARD);
        rotate(own, 0, 0, -1, B);
        lampX = own.x + B[0] * fore; lampY = own.y + B[1] * fore; lampZ = own.z + B[2] * fore;
        beamX = B[0] * ahead; beamY = B[1] * ahead; beamZ = B[2] * ahead;
        rotate(own, 0, 1, 0, B);
        lampX -= B[0] * below; lampY -= B[1] * below; lampZ -= B[2] * below;
        beamX -= B[0] * down; beamY -= B[1] * down; beamZ -= B[2] * down;
      }

      // Other ships hovering low: flight assist holds them up too.
      const ents = view.ents;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i]!;
        if (e.info.kind !== EntityKind.Ship || e.flags & EntityFlag.Landed) continue;
        if (Math.abs(e.rel[0]) + Math.abs(e.rel[1]) + Math.abs(e.rel[2]) > OTHER_RANGE) continue;
        const t = f.tracks.get(e.id);
        if (!t) continue;
        const hull = HULLS[e.info.model];
        const belly = hull?.belly ?? 0.2 * e.info.radius;
        const h = this.heightAt(ground, t.x, t.y, t.z) - belly;
        if (h > REACH) continue;
        const ux = N[0], uy = N[1], uz = N[2];
        const below = h + belly;
        // Its weight, and more while it is seen burning its thrusters.
        const force = (hull?.mass ?? 60_000) * g * (e.flags & (EntityFlag.Thrust | EntityFlag.Boost) ? 2 : 1);
        const level = Math.pow(Math.min(1, force / FULL_FORCE), 0.7);
        this.wash(ground, 2, RATE_OTHER, level, belly, t.x, t.y, t.z, -ux, -uy, -uz, t.x - ux * below, t.y - uy * below, t.z - uz * below, ux, uy, uz, g);
      }
    } else {
      this.wasHeight = Infinity;
      this.moving = false;
    }

    // Fly and draw.
    const haze = this.haze;
    haze.begin();
    const items = this.pool.items;
    // A matte surface in the light E sends on E * albedo / pi; a clump sends on its share of that.
    const k = 1 / Math.PI;
    const sr = light.sunColor[0] * light.sunIntensity, sg = light.sunColor[1] * light.sunIntensity, sb = light.sunColor[2] * light.sunIntensity;
    const ar = this.albedo[0]! * k, ag = this.albedo[1]! * k, ab = this.albedo[2]! * k;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const p = items[i]!;
      p.age += f.dt;
      if (p.age >= p.life) { this.pool.free(i); continue; }
      const t = p.age;
      const t0 = Math.max(0, t - SHUTTER);
      const hx = p.x + p.vx * t + 0.5 * p.gx * t * t, hy = p.y + p.vy * t + 0.5 * p.gy * t * t, hz = p.z + p.vz * t + 0.5 * p.gz * t * t;
      const tx = p.x + p.vx * t0 + 0.5 * p.gx * t0 * t0, ty = p.y + p.vy * t0 + 0.5 * p.gy * t0 * t0, tz = p.z + p.vz * t0 + 0.5 * p.gz * t0 * t0;
      const u = t / p.life;
      const w = p.w0 + (p.w1 - p.w0) * Math.sqrt(u);
      // The same dust over a growing area: it thins as the clump spreads, and is gone as it settles.
      const thin = (p.w0 / w) * (1 - u) * (1 - u) * Math.min(1, t * 12) * p.dense * 3;
      let er = sr, eg = sg, eb = sb;
      if (lamp > 0) {
        // Inside the cone of the lamp, by the distance from it, as the lamp itself falls off.
        const dx = hx - lampX, dy = hy - lampY, dz = hz - lampZ;
        const dd = dx * dx + dy * dy + dz * dz;
        const along = dx * beamX + dy * beamY + dz * beamZ;
        if (along > 0 && along * along > LAMP_EDGE * LAMP_EDGE * dd) {
          const d = Math.sqrt(dd);
          const fall = (lamp * smooth(LAMP_EDGE, LAMP_CORE, along / d)) / Math.max(d, 1);
          er += fall; eg += fall * 0.9; eb += fall * 0.74;
        }
      }
      haze.seg(tx + f.zx, ty + f.zy, tz + f.zz, hx + f.zx, hy + f.zy, hz + f.zz, w,
        ar * er * thin, ag * eg * thin, ab * eb * thin, 0.35);
    }
    haze.end();
  }

  clear(): void {
    this.pool.count = 0;
    this.wasHeight = Infinity;
    this.moving = false;
  }

  dispose(): void {
    this.haze.dispose();
  }
}
