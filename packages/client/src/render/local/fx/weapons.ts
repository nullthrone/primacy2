/**
 * Weapon fire and tool beams. Pulse bolts, cannon tracers and rail slugs are rounds that cross from
 * the muzzle to their end point; beam lasers, mining lasers and salvage torches are held beams that
 * the server reports several times per second and that are kept alive in between.
 *
 * Every weapon has a shape of its own, drawn with the kinds in `shots.ts`: a pulse laser throws a
 * short bolt with a white head, a cannon tracer rounds behind a jet of muzzle gas, a rail gun an
 * instant line that tears into a fading trail, with a ring of light at its muzzle. A beam ignites
 * from the muzzle outward, carries waves of brightness to its target and leaves an afterglow when
 * it is cut. The tools leave something where they work: the mining beam a spot that goes on
 * glowing, droplets and a jet of gas, the torch a hard arc that flickers on the wreck.
 */
import { Group } from 'three';
import { MODULES } from '@primacy2/shared';
import type { GameEvent, Vec3 } from '@primacy2/shared';
import { TAU, clamp, smooth } from '../util.ts';
import { Pool, rand, randCone, type Frame, type Track } from './core.ts';
import { effectLights } from './lights.ts';
import type { Sprites } from './sprites.ts';
import type { Flashes, Sparks } from './particles.ts';
import type { Ribbons } from './ribbons.ts';
import { SHELL as SHIELD_SHELL } from './shell.ts';
import { BEAM, BOLT, JET, Shots, WAKE } from './shots.ts';

type ShotEvent = Extract<GameEvent, { e: 'shot' }>;
type MineEvent = Extract<GameEvent, { e: 'mine' }>;
type SalvageEvent = Extract<GameEvent, { e: 'salvage' }>;

// Colour by weapon family, linear RGB at unit brightness.
const HOT: Readonly<Vec3> = [1.0, 0.27, 0.08];
const COLD: Readonly<Vec3> = [0.2, 0.72, 1.0];
const TRACER: Readonly<Vec3> = [1.0, 0.8, 0.46];
const GAS: Readonly<Vec3> = [1.0, 0.66, 0.3];
const RAIL: Readonly<Vec3> = [0.6, 0.79, 1.0];
const MINING: Readonly<Vec3> = [1.0, 0.5, 0.16];
const SALVAGE: Readonly<Vec3> = [0.32, 0.6, 1.0];

/** What a round looks like: a plain streak (what `streak` starts, for other effects), or one of the weapons. */
const PLAIN = 0, PULSE = 1, SHELL = 2, SLUG = 3;

/** Something that crosses from a to b once: a bolt of `len` metres that may leave a fading line behind. */
interface Round {
  shape: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  age: number;
  /** Seconds the head takes for the whole way. */
  flight: number;
  len: number;
  /** Seconds the line behind the bolt stays visible, and its brightness relative to the bolt. */
  after: number; afterGain: number;
  w: number;
  r: number; g: number; b: number;
  /** Radius of the glare carried at the head of the bolt, 0 for none. */
  glare: number;
  seed: number;
}

/** What shows at a muzzle for a moment: the glint of a laser's lens, the gas of a cannon, the ring of a rail gun. */
const LENS = 0, BLAST = 1, COIL = 2;

interface Muzzle {
  kind: number;
  /** The ship that fired; the place is relative to it. */
  from: number;
  x: number; y: number; z: number;
  /** Direction of fire. */
  dx: number; dy: number; dz: number;
  age: number; life: number;
  size: number;
  r: number; g: number; b: number;
  seed: number;
}

const WEAPON = 0, MINE = 1, TORCH = 2;
/** How the end of a held beam is stored: relative to its target, relative to the shooter, or as a fixed point. */
const ON_TARGET = 0, FROM_SHOOTER = 1, FIXED = 2;

interface Beam {
  key: number;
  kind: number;
  from: number;
  slot: number;
  to: number;
  mode: number;
  ex: number; ey: number; ez: number;
  /** Centre and radius of the rock being cut, when the reported end point is not on its surface. */
  cx: number; cy: number; cz: number; body: number;
  /** True when the reported end point lies on the surface of the target rather than at its centre. */
  exact: boolean;
  last: number;
  born: number;
  /** Fractions of a spark and of a droplet carried over to the next frame. */
  carry: number; drip: number;
  /** Colour family of a weapon beam: cold cyan or hot orange-red. */
  cold: boolean;
}

/** A place the mining beam has heated: it glows on and cools when the beam has moved away. */
interface Scar {
  key: number;
  /** The entity the place is on (and then relative to), or -1 for a place in the zone. */
  on: number;
  x: number; y: number; z: number;
  /** Where the beam was before it came here, when that is near: the cut between the two glows as a seam. */
  px: number; py: number; pz: number; joined: boolean;
  /** 1 under the beam, falling to 0. */
  heat: number;
  /** Effect time at which the beam was last on it. */
  fed: number;
  /** Metres it is drawn toward the camera, so the rough surface it lies on does not swallow it. */
  lift: number;
}

const M: Vec3 = [0, 0, 0];
const C: Vec3 = [0, 0, 0];
const D: Vec3 = [0, 0, 0];
const A: Vec3 = [0, 0, 0];
const E1: Vec3 = [0, 0, 0];
const E2: Vec3 = [0, 0, 0];
const SPARK_RATE = [0.4, 0.7, 1] as const;
/** Lobes of a cannon's muzzle gas by quality; from ahead they are the points of a star. */
const LOBES = [3, 4, 5] as const;
/** Seconds a beam takes to reach its end when it is switched on. */
const IGNITE = 0.06;
/** Seconds the trail of a rail slug takes to fade. */
const WAKE_LIFE = 0.9;

/** Two unit vectors at right angles to the unit vector d and to each other, into `E1` and `E2`. */
function across(dx: number, dy: number, dz: number): void {
  // Any vector that is not along d gives a first one.
  let x = -dz, y = 0, z = dx;
  if (Math.abs(dy) > 0.9) { x = 0; y = dz; z = -dy; }
  const l = Math.hypot(x, y, z) || 1;
  E1[0] = x / l; E1[1] = y / l; E1[2] = z / l;
  E2[0] = dy * E1[2] - dz * E1[1]; E2[1] = dz * E1[0] - dx * E1[2]; E2[2] = dx * E1[1] - dy * E1[0];
}

/**
 * An uneven flicker between 0 and 1 that changes `rate` times a second, read from the effect time,
 * so a frame drawn twice at one moment shows the same light.
 */
function crackle(now: number, rate: number, key: number): number {
  const h = Math.sin(Math.floor(now * rate) * 12.9898 + key * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

export class Weapons {
  /** What this family draws besides the shared streaks and discs; the effects part hangs it into the scene. */
  readonly group = new Group();
  private readonly shots = new Shots(768);
  private readonly rounds = new Pool<Round>(192, () => ({
    shape: PLAIN, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, age: 0, flight: 0, len: 0, after: 0, afterGain: 0, w: 0.3,
    r: 0, g: 0, b: 0, glare: 0, seed: 0,
  }));
  private readonly muzzles = new Pool<Muzzle>(64, () => ({
    kind: LENS, from: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, age: 0, life: 1, size: 1, r: 0, g: 0, b: 0, seed: 0,
  }));
  private readonly beams = new Pool<Beam>(32, () => ({
    key: 0, kind: WEAPON, from: 0, slot: 0, to: -1, mode: FIXED, ex: 0, ey: 0, ez: 0, cx: 0, cy: 0, cz: 0, body: 0,
    exact: false, last: 0, born: 0, carry: 0, drip: 0, cold: true,
  }));
  private readonly scars = new Pool<Scar>(48, () => ({
    key: 0, on: -1, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, joined: false, heat: 0, fed: 0, lift: 0,
  }));

  constructor(private readonly f: Frame, private readonly ribbons: Ribbons, private readonly sprites: Sprites,
              private readonly sparks: Sparks, _flashes: Flashes) {
    this.group.add(this.shots.mesh);
  }

  shot(ev: ShotEvent): void {
    const def = MODULES[ev.w];
    const weapon = def?.weapon;
    const src = this.f.tracks.get(ev.from);
    if (!def || !weapon || !src) return;
    this.f.muzzle(src, ev.slot, M);
    const at = this.aim(ev);
    const dist = Math.hypot(at[0] - M[0], at[1] - M[1], at[2] - M[2]);
    const laser = def.tier >= 2 ? COLD : HOT;
    switch (weapon.kind) {
      case 'pulse':
        // Seen from the ship that fired, a bolt is end-on and all but hidden behind its own head. So
        // the way the pilot's own bolt went glows on for a moment; anyone else's is the bolt alone.
        this.round(PULSE, at, clamp(dist / 6000, 0.05, 0.1), Math.min(dist * 0.3, 40), src.own ? 0.13 : 0, 0.1, 0.42, laser, 12, 1.5);
        this.muzzle(LENS, src, at, laser, 1.3, 0.08, 50);
        break;
      case 'cannon':
        if (weapon.speed >= 5000) {
          // A rail slug is too fast to follow; what the eye keeps is the line it drew.
          this.round(SLUG, at, dist / weapon.speed, 0, WAKE_LIFE, 0, 0.4, RAIL, 8, 1.6);
          this.muzzle(COIL, src, at, RAIL, 2.6, 0.26, 420);
        } else {
          this.round(SHELL, at, dist / Math.max(weapon.speed, 100), weapon.speed * 0.014, 0, 0, 0.24, TRACER, 11, 0.7);
          this.muzzle(BLAST, src, at, TRACER, 3.4, 0.055, 110);
        }
        break;
      case 'beam': {
        const b = this.hold(src.id * 64 + (ev.slot & 31), WEAPON, src, ev.slot, ev.to ?? -1, at);
        if (b) b.cold = def.tier >= 2;
        break;
      }
      case 'mining':
        // The same key as a `mine` event, so a server that sends both still shows one beam.
        this.hold(src.id * 64 + 62, MINE, src, ev.slot, ev.to ?? -1, at);
        break;
      case 'missile':
        // The missile itself is an entity; see missiles.ts.
        break;
    }
  }

  /**
   * Where a shot from the muzzle in `M` ends: where the server says, or, at a ship whose shield is
   * up, on the shell of that shield where it faces the shooter. The shield swallows the shot.
   */
  private aim(ev: ShotEvent): Readonly<Vec3> {
    const to = ev.to ?? -1;
    const target = to >= 0 ? this.f.tracks.get(to) : undefined;
    if (!target || !this.shielded(to)) return ev.at;
    this.f.surface(target, M[0], M[1], M[2], SHIELD_SHELL, A);
    return A;
  }

  /** True when the ship `id` has its shield up. */
  private shielded(id: number): boolean {
    const view = this.f.view;
    if (view.self && view.self.id === id) return view.self.state.shield > 0;
    const ents = view.ents;
    for (let i = 0; i < ents.length; i++) if (ents[i]!.id === id) return ents[i]!.shield > 0;
    return false;
  }

  mine(ev: MineEvent): void {
    const src = this.f.tracks.get(ev.from);
    if (!src) return;
    const b = this.hold(src.id * 64 + 62, MINE, src, this.toolSlot(src), -1, ev.at);
    const rock = this.f.view.field?.rocks[ev.ast];
    if (!b || !rock) return;
    const off = Math.hypot(ev.at[0] - rock.pos[0], ev.at[1] - rock.pos[1], ev.at[2] - rock.pos[2]);
    if (off < 0.5 * rock.radius) {
      b.cx = rock.pos[0]; b.cy = rock.pos[1]; b.cz = rock.pos[2];
      b.body = rock.radius;
    }
  }

  salvage(ev: SalvageEvent): void {
    const src = this.f.tracks.get(ev.from);
    if (src) this.hold(src.id * 64 + 63, TORCH, src, this.toolSlot(src), ev.id, ev.at);
  }

  /** The mount of the own ship's mining laser, so its tool beams start there; -1 (the nose) otherwise. */
  private toolSlot(src: Track): number {
    const mounts = src.own ? this.f.view.self?.stats.weapons : undefined;
    if (mounts) for (let i = 0; i < mounts.length; i++) if (mounts[i]!.kind === 'mining') return i;
    return -1;
  }

  /** Starts a round of `shape` from the muzzle in `M` to `at`. */
  private round(shape: number, at: Readonly<Vec3>, flight: number, len: number, after: number, afterGain: number, w: number,
                c: Readonly<Vec3>, gain: number, glare: number): void {
    const s = this.start(M[0], M[1], M[2], at[0], at[1], at[2], flight, len, after, afterGain, w, c[0] * gain, c[1] * gain, c[2] * gain, glare);
    if (s) s.shape = shape;
  }

  /**
   * A bolt of `len` metres that crosses from a to b (anchor coordinates) in `flight` seconds and
   * leaves a line that fades over `after` seconds, starting at `afterGain` of the bolt's brightness.
   */
  streak(ax: number, ay: number, az: number, bx: number, by: number, bz: number, flight: number, len: number,
         after: number, afterGain: number, w: number, r: number, g: number, b: number, glare: number): void {
    this.start(ax, ay, az, bx, by, bz, flight, len, after, afterGain, w, r, g, b, glare);
  }

  private start(ax: number, ay: number, az: number, bx: number, by: number, bz: number, flight: number, len: number,
                after: number, afterGain: number, w: number, r: number, g: number, b: number, glare: number): Round | null {
    const s = this.rounds.take();
    if (!s) return null;
    s.shape = PLAIN;
    s.ax = ax; s.ay = ay; s.az = az;
    s.bx = bx; s.by = by; s.bz = bz;
    s.age = 0; s.flight = flight; s.len = len; s.after = after; s.afterGain = afterGain; s.w = w;
    s.r = r; s.g = g; s.b = b; s.glare = glare; s.seed = Math.random() * 100;
    return s;
  }

  /**
   * What shows at the muzzle in `M` when a shot toward `at` leaves it, and the light it throws
   * back on the ship that fired (`light` at its start, falling to nothing over 1.5 lives).
   */
  private muzzle(kind: number, src: Track, at: Readonly<Vec3>, c: Readonly<Vec3>, size: number, life: number, light: number): void {
    const f = this.f;
    let dx = at[0] - M[0], dy = at[1] - M[1], dz = at[2] - M[2];
    const d = Math.hypot(dx, dy, dz) || 1;
    dx /= d; dy /= d; dz /= d;
    const m = this.muzzles.take();
    if (m) {
      m.kind = kind; m.from = src.id;
      m.x = M[0] - src.x; m.y = M[1] - src.y; m.z = M[2] - src.z;
      m.dx = dx; m.dy = dy; m.dz = dz;
      // The pilot's own muzzle is close to the camera in either view; what shows there is kept small.
      m.age = 0; m.life = life; m.size = src.own ? size * 0.5 : size; m.seed = Math.random();
      m.r = c[0]; m.g = c[1]; m.b = c[2];
    }
    // A light in the skin lights nothing, and the muzzle of another ship is its nose: the light
    // stands a little ahead of it and off toward the camera, on the side of the hull that is seen.
    let sx = -f.zx - M[0], sy = -f.zy - M[1], sz = -f.zz - M[2];
    const along = sx * dx + sy * dy + sz * dz;
    sx -= dx * along; sy -= dy * along; sz -= dz * along;
    const side = Math.hypot(sx, sy, sz);
    const off = side > 1 ? Math.min(0.3 * src.radius, 0.5 * side) / side : 0;
    const ahead = 0.1 * src.radius;
    // The pilot's own muzzle is a few metres from the cabin, which takes its light through the canopy: half is plenty.
    effectLights.pulse(M[0] - src.x + dx * ahead + sx * off, M[1] - src.y + dy * ahead + sy * off, M[2] - src.z + dz * ahead + sz * off,
      c[0], c[1], c[2], src.own ? 0.5 * light : light, 10 + 1.5 * src.radius, life * 1.5, src.id);
  }

  /** Starts or refreshes the beam `key` from `src` to `at`. */
  private hold(key: number, kind: number, src: Track, slot: number, to: number, at: Readonly<Vec3>): Beam | null {
    const f = this.f;
    let b: Beam | null = null;
    for (let i = 0; i < this.beams.count; i++) if (this.beams.items[i]!.key === key) b = this.beams.items[i]!;
    // A beam that is fired again while its afterglow fades ignites anew.
    const stale = b !== null && f.now - b.last > (b.kind === WEAPON ? 0.14 : 0.3);
    if (!b) {
      b = this.beams.take();
      if (!b) return null;
      b.key = key; b.born = f.now; b.carry = 0; b.drip = 0;
    } else if (stale) {
      b.born = f.now;
    }
    b.kind = kind; b.from = src.id; b.slot = slot; b.to = to; b.last = f.now; b.body = 0;
    const target = to >= 0 ? f.tracks.get(to) : undefined;
    if (target) {
      // Follow the target between events. The server may report its centre instead of the place touched.
      b.mode = ON_TARGET;
      b.ex = at[0] - target.x; b.ey = at[1] - target.y; b.ez = at[2] - target.z;
      b.exact = Math.hypot(b.ex, b.ey, b.ez) > 0.3 * target.radius;
    } else if (kind === WEAPON) {
      // A beam into empty space turns with the ship that holds it.
      b.mode = FROM_SHOOTER;
      b.ex = at[0] - src.x; b.ey = at[1] - src.y; b.ez = at[2] - src.z;
    } else {
      b.mode = FIXED;
      b.ex = at[0]; b.ey = at[1]; b.ez = at[2];
    }
    return b;
  }

  update(): void {
    this.shots.begin();
    this.updateRounds();
    this.updateMuzzles();
    this.updateBeams();
    this.updateScars();
    this.shots.end();
  }

  private updateRounds(): void {
    const f = this.f, shots = this.shots;
    const items = this.rounds.items;
    for (let i = this.rounds.count - 1; i >= 0; i--) {
      const s = items[i]!;
      s.age += f.dt;
      const dx = s.bx - s.ax, dy = s.by - s.ay, dz = s.bz - s.az;
      const dist = Math.hypot(dx, dy, dz) || 1;
      const ox = s.ax + f.zx, oy = s.ay + f.zy, oz = s.az + f.zz;
      if (s.shape === SLUG) {
        // The whole line at once; the shader lights it up to where the slug is and ages it from there.
        if (s.age >= s.flight + s.after) { this.rounds.free(i); continue; }
        shots.seg(WAKE, ox, oy, oz, ox + dx, oy + dy, oz + dz, s.w, s.r, s.g, s.b, s.flight / s.after, s.age / s.after);
        if (s.age < s.flight) {
          const h = s.age / s.flight;
          shots.dot(ox + dx * h, oy + dy * h, oz + dz * h, s.glare, s.r, s.g, s.b, 0.9);
        }
        continue;
      }
      const head = s.flight > 0 ? (s.age / s.flight) * (dist + s.len) : dist + s.len;
      const flying = head - s.len < dist;
      if (!flying && s.age >= s.after) { this.rounds.free(i); continue; }
      const h1 = Math.min(head, dist) / dist;
      const hx = ox + dx * h1, hy = oy + dy * h1, hz = oz + dz * h1;
      if (flying) {
        const h0 = Math.max(head - s.len, 0) / dist;
        const tx = ox + dx * h0, ty = oy + dy * h0, tz = oz + dz * h0;
        if (s.shape === PULSE) {
          shots.seg(BOLT, tx, ty, tz, hx, hy, hz, s.w, s.r, s.g, s.b, 0.75, 0.05);
          shots.dot(hx, hy, hz, s.glare, s.r * 0.5, s.g * 0.5, s.b * 0.5, 0.6);
        } else if (s.shape === SHELL) {
          // A tracer is a burning charge in the base of the shell: a bead of light, never quite steady.
          const k = 0.8 + 0.2 * Math.sin(f.now * 173 + s.seed);
          shots.seg(BOLT, tx, ty, tz, hx, hy, hz, s.w, s.r * k * 0.8, s.g * k * 0.8, s.b * k * 0.8, 0.4, 0);
          shots.dot(hx, hy, hz, s.glare, s.r * k, s.g * k, s.b * k, 0.9);
        } else {
          this.ribbons.seg(tx, ty, tz, hx, hy, hz, s.w, s.r, s.g, s.b, 0.1, 1);
          if (s.glare > 0) this.sprites.glow(hx, hy, hz, s.glare, s.r * 0.5, s.g * 0.5, s.b * 0.5);
        }
      }
      if (s.age < s.after) {
        const k = 1 - s.age / s.after;
        const gain = s.afterGain * k * k;
        if (s.shape === PULSE) shots.seg(BOLT, ox, oy, oz, hx, hy, hz, s.w * 0.5, s.r * gain, s.g * gain, s.b * gain, 0, 1);
        else this.ribbons.seg(ox, oy, oz, hx, hy, hz, s.w * 0.6, s.r * gain, s.g * gain, s.b * gain, 1, 1);
      }
    }
  }

  private updateMuzzles(): void {
    const f = this.f, shots = this.shots;
    const items = this.muzzles.items;
    for (let i = this.muzzles.count - 1; i >= 0; i--) {
      const m = items[i]!;
      m.age += f.dt;
      const host = f.tracks.get(m.from);
      if (!host || m.age >= m.life) { this.muzzles.free(i); continue; }
      const t = m.age / m.life, u = 1 - t;
      const grow = 1 - u * u * u;
      const x = host.x + m.x + f.zx, y = host.y + m.y + f.zy, z = host.z + m.z + f.zz;
      if (m.kind === LENS) {
        // A laser burns no powder: its muzzle shows the glint of the lens and nothing else.
        const k = 9 * u * u;
        shots.dot(x, y, z, m.size * (0.7 + 0.5 * grow), m.r * k, m.g * k, m.b * k, 0.85);
      } else if (m.kind === BLAST) {
        // Powder gas: a jet ahead of the barrel and shorter ones thrown out sideways by the muzzle
        // brake. From ahead those are the points of a star; it is gone in three frames.
        const k = 11 * u * u;
        const r = GAS[0] * k, g = GAS[1] * k, b = GAS[2] * k;
        const len = m.size * (0.45 + 0.55 * grow);
        shots.seg(JET, x, y, z, x + m.dx * len, y + m.dy * len, z + m.dz * len, 0.17 * len, r, g, b, 0, 0.9);
        across(m.dx, m.dy, m.dz);
        const n = LOBES[f.quality];
        const lobe = 0.42 * len;
        for (let j = 0; j < n; j++) {
          const a = (m.seed + j / n) * TAU;
          const ca = Math.cos(a) * 0.94, sa = Math.sin(a) * 0.94;
          const lx = m.dx * 0.34 + E1[0] * ca + E2[0] * sa, ly = m.dy * 0.34 + E1[1] * ca + E2[1] * sa, lz = m.dz * 0.34 + E1[2] * ca + E2[2] * sa;
          shots.seg(JET, x, y, z, x + lx * lobe, y + ly * lobe, z + lz * lobe, 0.2 * lobe, r * 0.8, g * 0.8, b * 0.8, 0, 0.7);
        }
        shots.dot(x, y, z, 0.22 * m.size, r * 0.7, g * 0.7, b * 0.7, 0.9);
      } else {
        // The coils of a rail gun leave a ring of glowing gas around the barrel that widens and thins.
        const k = 2.6 * u * u * u;
        shots.ring(x + m.dx * 0.4, y + m.dy * 0.4, z + m.dz * 0.4, m.dx, m.dy, m.dz, m.size * (0.18 + 0.82 * grow),
          m.r * k, m.g * k, m.b * k, 0.04 + 0.1 * t);
        const blink = 16 * u * u * u * u * u * u;
        shots.dot(x, y, z, 0.75 * m.size, m.r * blink, m.g * blink, m.b * blink, 0.9);
      }
    }
  }

  private updateBeams(): void {
    const f = this.f, shots = this.shots;
    const items = this.beams.items;
    // Wave trains run on the effect time; kept small, so the shader's sines stay exact.
    const time = f.now % 8;
    for (let i = this.beams.count - 1; i >= 0; i--) {
      const b = items[i]!;
      const src = f.tracks.get(b.from);
      const since = f.now - b.last;
      // Weapon beams are reported about ten times per second, tool beams about four times. A weapon
      // beam that is cut drops out at once and leaves an afterglow; a tool beam dies down.
      const hold = b.kind === WEAPON ? 0.14 : 0.3, gone = b.kind === WEAPON ? 0.58 : 0.56;
      if (!src || since > gone) { this.beams.free(i); continue; }
      const level = b.kind === WEAPON ? 1 - smooth(hold, hold + 0.05, since) : 1 - smooth(hold, gone, since);
      f.muzzle(src, b.slot, M);

      // E is where the line ends, C where it touches something (and `touch` whether it does).
      let ex = b.ex, ey = b.ey, ez = b.ez;
      let touch = true;
      C[0] = ex; C[1] = ey; C[2] = ez;
      const target = b.mode === ON_TARGET ? f.tracks.get(b.to) : undefined;
      if (target && b.kind === WEAPON && this.shielded(b.to)) {
        // The shield swallows the beam: it ends on the shell, where that faces the muzzle.
        f.surface(target, M[0], M[1], M[2], SHIELD_SHELL, C);
        ex = C[0]; ey = C[1]; ez = C[2];
      } else if (target) {
        if (b.exact) {
          ex += target.x; ey += target.y; ez += target.z;
          C[0] = ex; C[1] = ey; C[2] = ez;
        } else {
          // Aim at the centre and let the hull hide the rest; the glare sits where the hull roughly is.
          ex = target.x; ey = target.y; ez = target.z;
          f.surface(target, M[0], M[1], M[2], 0.5, C);
        }
      } else if (b.mode === ON_TARGET) {
        this.beams.free(i);
        continue;
      } else if (b.mode === FROM_SHOOTER) {
        ex += src.x; ey += src.y; ez += src.z;
        touch = false;
      } else if (b.body > 0) {
        const nx = M[0] - b.cx, ny = M[1] - b.cy, nz = M[2] - b.cz;
        const k = (b.body * 0.8) / (Math.hypot(nx, ny, nz) || 1);
        ex = b.cx; ey = b.cy; ez = b.cz;
        C[0] = b.cx + nx * k; C[1] = b.cy + ny * k; C[2] = b.cz + nz * k;
      }

      const sx = M[0] + f.zx, sy = M[1] + f.zy, sz = M[2] + f.zz;
      const cx = C[0] + f.zx, cy = C[1] + f.zy, cz = C[2] + f.zz;
      let tx = ex + f.zx, ty = ey + f.zy, tz = ez + f.zz;
      // The beam grows out of the muzzle when it is switched on; until it has arrived it touches nothing.
      const reach = clamp((f.now - b.born) / IGNITE, 0, 1);
      if (reach < 1) {
        tx = sx + (tx - sx) * reach; ty = sy + (ty - sy) * reach; tz = sz + (tz - sz) * reach;
        touch = false;
      }
      // The waves along the beam are its life; on top of them only a slight shimmer of the whole.
      const flick = level * (0.94 + 0.06 * Math.sin(f.now * 91 + b.key) * Math.sin(f.now * 57 + 1.3));
      // Unit vector from where the beam touches back to the muzzle.
      let nx = sx - cx, ny = sy - cy, nz = sz - cz;
      const nd = Math.hypot(nx, ny, nz) || 1;
      nx /= nd; ny /= nd; nz /= nd;

      if (b.kind === WEAPON) {
        const c = b.cold ? COLD : HOT;
        if (level > 0) {
          const g = 9 * flick;
          shots.seg(BEAM, sx, sy, sz, tx, ty, tz, 0.48, c[0] * g, c[1] * g, c[2] * g, level, time);
          shots.dot(sx, sy, sz, 1.5, c[0] * 6 * flick, c[1] * 6 * flick, c[2] * 6 * flick, 0.8);
          if (reach < 1) shots.dot(tx, ty, tz, 1.1, c[0] * 12 * flick, c[1] * 12 * flick, c[2] * 12 * flick, 0.9);
          if (touch) shots.dot(cx, cy, cz, 2.4, c[0] * 9 * flick, c[1] * 9 * flick, c[2] * 9 * flick, 0.9);
          // Both ends tint the plating around them, a few metres and no more. The one at the far end
          // stands off the hull it touches, toward the muzzle: a light in the skin lights nothing.
          effectLights.add(sx, sy, sz, c[0], c[1], c[2], 18 * flick, 8);
          if (touch) effectLights.add(cx + nx * 1.2, cy + ny * 1.2, cz + nz * 1.2, c[0], c[1], c[2], 45 * flick, 11);
        }
        if (since > hold) {
          // Cut: the core is gone at once. What stays for a moment is the sheath, wider, dimmer and
          // deeper in colour, as the gas the beam went through lets go of its light.
          const k = 1 - (since - hold) / (gone - hold);
          const g = 2.6 * k * k;
          shots.seg(BEAM, sx, sy, sz, tx, ty, tz, 0.48 * (1.7 - 0.7 * k), c[0] * g, c[1] * g * (0.5 + 0.5 * k), c[2] * g * (0.5 + 0.5 * k), 0, time);
          shots.dot(sx, sy, sz, 1.2, c[0] * g, c[1] * g * k, c[2] * g * k, 0);
        }
      } else if (b.kind === MINE) {
        const g = 7 * flick;
        shots.seg(BEAM, sx, sy, sz, tx, ty, tz, 0.8, MINING[0] * g, MINING[1] * g, MINING[2] * g, 0.45 * level, time * 0.6);
        shots.dot(sx, sy, sz, 1.6, 5 * flick, 2.6 * flick, 0.9 * flick, 0.6);
        if (!touch) continue;
        shots.dot(cx, cy, cz, 2.5, 10 * flick, 5.6 * flick, 2 * flick, 0.6);
        effectLights.add(cx + nx * 1.5, cy + ny * 1.5, cz + nz * 1.5, 1, 0.6, 0.25, 70 * flick, 16);
        this.heat(b, target ? b.to : -1, target);
        // Rock that boils off leaves as a thin jet of gas, away from the surface and a little off
        // the beam, or the beam would hide it; it wavers as the cut bites.
        across(nx, ny, nz);
        const lean = 0.45 * Math.sin(b.key * 2.4), tilt = 0.45 * Math.cos(b.key * 2.4);
        const jx = nx + E1[0] * lean + E2[0] * tilt, jy = ny + E1[1] * lean + E2[1] * tilt, jz = nz + E1[2] * lean + E2[2] * tilt;
        const jl = (5.5 + 2.5 * crackle(f.now, 24, b.key)) * level;
        shots.seg(JET, cx, cy, cz, cx + jx * jl, cy + jy * jl, cz + jz * jl, 0.11 * jl, 2.2 * level, 1.5 * level, 0.95 * level, 0, 0.5);
        this.shower(b, 45, 6, 30, 0.4, 1.1, 0.09, 7, 4.2, 1.4, 0.05, level);
        this.drip(b, 26, level);
      } else {
        // The torch: hardly a beam at all, and at its end a small hard arc that never burns evenly.
        const g = 0.7 * flick;
        shots.seg(BEAM, sx, sy, sz, tx, ty, tz, 0.18, SALVAGE[0] * g, SALVAGE[1] * g, SALVAGE[2] * g, 0.3 * level, time);
        shots.dot(sx, sy, sz, 0.8, 1.4 * flick, 2.1 * flick, 3.2 * flick, 0.5);
        const q = crackle(f.now, 47, b.key);
        const arc = level * (q < 0.14 ? 0.12 : 0.4 + 0.6 * q * q);
        shots.dot(cx, cy, cz, 0.55, 9 * arc, 12 * arc, 16 * arc, 1);
        shots.dot(cx, cy, cz, 2.4, 1.1 * arc, 1.7 * arc, 2.8 * arc, 0.2);
        // Welding light: hard, blue-white and as unsteady as the arc, on whatever is around it.
        effectLights.add(cx + nx * 1.5, cy + ny * 1.5, cz + nz * 1.5, 0.62, 0.8, 1, 200 * arc, 34);
        this.shower(b, 110, 10, 45, 0.15, 0.45, 0.05, 6, 4.6, 2.8, 0.03, level);
      }
    }
  }

  /** Sparks thrown back from the contact point in `C` toward the muzzle in `M`, `rate` per second. */
  private shower(b: Beam, rate: number, v0: number, v1: number, life0: number, life1: number, w: number,
                 r: number, g: number, bl: number, trail: number, level: number): void {
    const f = this.f;
    let nx = M[0] - C[0], ny = M[1] - C[1], nz = M[2] - C[2];
    const d = Math.hypot(nx, ny, nz) || 1;
    nx /= d; ny /= d; nz /= d;
    b.carry += rate * SPARK_RATE[f.quality] * level * f.dt;
    while (b.carry >= 1) {
      b.carry -= 1;
      randCone(nx, ny, nz, 0.9, D);
      const v = rand(v0, v1);
      this.sparks.spawn(C[0], C[1], C[2], D[0] * v, D[1] * v, D[2] * v, rand(life0, life1), w, r, g, bl, trail);
    }
  }

  /** Droplets of molten rock from the contact point in `C`: slow, fat, and glowing for a second or two as they drift off. */
  private drip(b: Beam, rate: number, level: number): void {
    const f = this.f;
    let nx = M[0] - C[0], ny = M[1] - C[1], nz = M[2] - C[2];
    const d = Math.hypot(nx, ny, nz) || 1;
    nx /= d; ny /= d; nz /= d;
    b.drip += rate * SPARK_RATE[f.quality] * level * f.dt;
    while (b.drip >= 1) {
      b.drip -= 1;
      randCone(nx, ny, nz, 1.6, D);
      const v = rand(1.5, 8);
      this.sparks.spawn(C[0], C[1], C[2], D[0] * v, D[1] * v, D[2] * v, rand(0.9, 2.2), 0.14, 8, 3.6, 0.8, 0.012);
    }
  }

  /** Heats the place in `C` under beam `b`: the scar already there, or a new one when the beam has moved on. */
  private heat(b: Beam, on: number, host: Track | undefined): void {
    const f = this.f;
    const x = host ? C[0] - host.x : C[0], y = host ? C[1] - host.y : C[1], z = host ? C[2] - host.z : C[2];
    const items = this.scars.items;
    let s: Scar | null = null, last: Scar | null = null, coldest = 0;
    for (let i = 0; i < this.scars.count; i++) {
      const k = items[i]!;
      if (k.key === b.key && k.on === on) {
        if (Math.hypot(k.x - x, k.y - y, k.z - z) < 0.3) s = k;
        if (!last || k.fed > last.fed) last = k;
      }
      if (k.heat < items[coldest]!.heat) coldest = i;
    }
    if (!s) {
      // The beam has moved on from the place it heated last. When every scar is in use the coldest makes room.
      const px = last ? last.x : x, py = last ? last.y : y, pz = last ? last.z : z;
      s = this.scars.take() ?? items[coldest]!;
      s.key = b.key; s.on = on; s.x = x; s.y = y; s.z = z; s.heat = 0.35;
      s.px = px; s.py = py; s.pz = pz;
      s.joined = last !== null && Math.hypot(px - x, py - y, pz - z) < 4;
      s.lift = b.body > 0 ? 0.1 * b.body : 0.4;
    }
    s.heat = Math.min(1, s.heat + f.dt / 0.3);
    s.fed = f.now;
  }

  private updateScars(): void {
    const f = this.f, shots = this.shots;
    const items = this.scars.items;
    for (let i = this.scars.count - 1; i >= 0; i--) {
      const s = items[i]!;
      const host = s.on >= 0 ? f.tracks.get(s.on) : undefined;
      // Left alone it cools as hot rock does: fast at first, then for seconds as a dull red.
      if (s.fed !== f.now) s.heat -= s.heat * (0.5 + 1.3 * s.heat) * f.dt;
      if (s.heat < 0.03 || (s.on >= 0 && !host)) { this.scars.free(i); continue; }
      let x = s.x + f.zx, y = s.y + f.zy, z = s.z + f.zz;
      if (host) { x += host.x; y += host.y; z += host.z; }
      const d = Math.hypot(x, y, z) || 1;
      const k = 1 - Math.min(s.lift, 0.5 * d) / d;
      const h = s.heat;
      // From yellow-white through orange to a red that is barely there.
      const r = 10 * h, g = 6 * h * h, b = 2.4 * h * h * h;
      shots.dot(x * k, y * k, z * k, 0.45 + 0.75 * h, r, g, b, 0.6 * h * h);
      if (s.joined) {
        const ox = x + s.px - s.x, oy = y + s.py - s.y, oz = z + s.pz - s.z;
        shots.seg(BOLT, ox * k, oy * k, oz * k, x * k, y * k, z * k, 0.3 + 0.3 * h, r * 0.7, g * 0.7, b * 0.7, 0, 1);
      }
    }
  }

  clear(): void {
    this.rounds.count = 0;
    this.muzzles.count = 0;
    this.beams.count = 0;
    this.scars.count = 0;
  }

  /** Frees what `group` holds. */
  dispose(): void {
    this.shots.dispose();
  }
}
