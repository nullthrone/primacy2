/**
 * Weapon fire and tool beams. Pulse bolts, cannon tracers and rail slugs are rounds that cross from
 * the muzzle to their end point; beam lasers, mining lasers and salvage torches are held beams that
 * the server reports several times per second and that are kept alive in between.
 */
import { MODULES } from '@primacy2/shared';
import type { GameEvent, Vec3 } from '@primacy2/shared';
import { clamp, smooth } from '../util.ts';
import { Pool, rand, randCone, type Frame, type Track } from './core.ts';
import { GLOW, type Sprites } from './sprites.ts';
import type { Flashes, Sparks } from './particles.ts';
import type { Ribbons } from './ribbons.ts';

type ShotEvent = Extract<GameEvent, { e: 'shot' }>;
type MineEvent = Extract<GameEvent, { e: 'mine' }>;
type SalvageEvent = Extract<GameEvent, { e: 'salvage' }>;

// Colour by weapon family, linear RGB at unit brightness.
const HOT: Readonly<Vec3> = [1.0, 0.27, 0.08];
const COLD: Readonly<Vec3> = [0.2, 0.72, 1.0];
const TRACER: Readonly<Vec3> = [1.0, 0.8, 0.46];
const RAIL: Readonly<Vec3> = [0.6, 0.79, 1.0];
const MINING: Readonly<Vec3> = [1.0, 0.5, 0.16];
const SALVAGE: Readonly<Vec3> = [0.32, 0.6, 1.0];

/** Something that crosses from a to b once: a bolt of `len` metres that may leave a fading line behind. */
interface Round {
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
  /** Fraction of a spark carried over to the next frame. */
  carry: number;
  /** Colour family of a weapon beam: cold cyan or hot orange-red. */
  cold: boolean;
}

const M: Vec3 = [0, 0, 0];
const C: Vec3 = [0, 0, 0];
const D: Vec3 = [0, 0, 0];
const SPARK_RATE = [0.4, 0.7, 1] as const;

export class Weapons {
  private readonly rounds = new Pool<Round>(192, () => ({
    ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, age: 0, flight: 0, len: 0, after: 0, afterGain: 0, w: 0.3, r: 0, g: 0, b: 0, glare: 0,
  }));
  private readonly beams = new Pool<Beam>(32, () => ({
    key: 0, kind: WEAPON, from: 0, slot: 0, to: -1, mode: FIXED, ex: 0, ey: 0, ez: 0, cx: 0, cy: 0, cz: 0, body: 0,
    exact: false, last: 0, born: 0, carry: 0, cold: true,
  }));

  constructor(private readonly f: Frame, private readonly ribbons: Ribbons, private readonly sprites: Sprites,
              private readonly sparks: Sparks, private readonly flashes: Flashes) {}

  shot(ev: ShotEvent): void {
    const def = MODULES[ev.w];
    const weapon = def?.weapon;
    const src = this.f.tracks.get(ev.from);
    if (!def || !weapon || !src) return;
    this.f.muzzle(src, ev.slot, M);
    const at = ev.at;
    const dist = Math.hypot(at[0] - M[0], at[1] - M[1], at[2] - M[2]);
    const laser = def.tier >= 2 ? COLD : HOT;
    switch (weapon.kind) {
      case 'pulse':
        this.round(at, clamp(dist / 6000, 0.04, 0.1), Math.min(dist * 0.35, 45), 0.16, 0.1, 0.42, laser, 12, 2.4);
        this.muzzleFlash(src, laser, 1.5, 9, 0.07);
        break;
      case 'cannon':
        if (weapon.speed >= 5000) {
          // A rail slug is too fast to follow; what the eye keeps is the line it drew.
          this.round(at, dist / weapon.speed, Math.min(dist * 0.6, 240), 0.6, 0.4, 0.45, RAIL, 14, 3.5);
          this.muzzleFlash(src, RAIL, 4, 16, 0.12);
        } else {
          this.round(at, dist / Math.max(weapon.speed, 100), weapon.speed * 0.02, 0, 0, 0.3, TRACER, 9, 1.3);
          this.muzzleFlash(src, TRACER, 1.3, 7, 0.05);
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

  /** Starts a round from the muzzle in `M` to `at`. */
  private round(at: Readonly<Vec3>, flight: number, len: number, after: number, afterGain: number, w: number,
                c: Readonly<Vec3>, gain: number, glare: number): void {
    this.streak(M[0], M[1], M[2], at[0], at[1], at[2], flight, len, after, afterGain, w, c[0] * gain, c[1] * gain, c[2] * gain, glare);
  }

  /**
   * A bolt of `len` metres that crosses from a to b (anchor coordinates) in `flight` seconds and
   * leaves a line that fades over `after` seconds, starting at `afterGain` of the bolt's brightness.
   */
  streak(ax: number, ay: number, az: number, bx: number, by: number, bz: number, flight: number, len: number,
         after: number, afterGain: number, w: number, r: number, g: number, b: number, glare: number): void {
    const s = this.rounds.take();
    if (!s) return;
    s.ax = ax; s.ay = ay; s.az = az;
    s.bx = bx; s.by = by; s.bz = bz;
    s.age = 0; s.flight = flight; s.len = len; s.after = after; s.afterGain = afterGain; s.w = w;
    s.r = r; s.g = g; s.b = b; s.glare = glare;
  }

  /** A flash at the muzzle in `M` that stays with the shooter. */
  private muzzleFlash(src: Track, c: Readonly<Vec3>, size: number, gain: number, life: number): void {
    // The pilot's own muzzle is close to the camera in either view; its flash is kept small.
    const s = src.own ? size * 0.45 : size;
    const p = this.flashes.spawn(GLOW, M[0] - src.x, M[1] - src.y, M[2] - src.z, life, s, s * 1.6, c[0], c[1], c[2], gain);
    p.follow = src.id;
  }

  /** Starts or refreshes the beam `key` from `src` to `at`. */
  private hold(key: number, kind: number, src: Track, slot: number, to: number, at: Readonly<Vec3>): Beam | null {
    const f = this.f;
    let b: Beam | null = null;
    for (let i = 0; i < this.beams.count; i++) if (this.beams.items[i]!.key === key) b = this.beams.items[i]!;
    if (!b) {
      b = this.beams.take();
      if (!b) return null;
      b.key = key; b.born = f.now; b.carry = 0;
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
    this.updateRounds();
    this.updateBeams();
  }

  private updateRounds(): void {
    const f = this.f, ribbons = this.ribbons;
    const items = this.rounds.items;
    for (let i = this.rounds.count - 1; i >= 0; i--) {
      const s = items[i]!;
      s.age += f.dt;
      const dx = s.bx - s.ax, dy = s.by - s.ay, dz = s.bz - s.az;
      const dist = Math.hypot(dx, dy, dz) || 1;
      const head = s.flight > 0 ? (s.age / s.flight) * (dist + s.len) : dist + s.len;
      const flying = head - s.len < dist;
      if (!flying && s.age >= s.after) { this.rounds.free(i); continue; }
      const ox = s.ax + f.zx, oy = s.ay + f.zy, oz = s.az + f.zz;
      const h1 = Math.min(head, dist) / dist;
      if (flying) {
        const h0 = Math.max(head - s.len, 0) / dist;
        ribbons.seg(ox + dx * h0, oy + dy * h0, oz + dz * h0, ox + dx * h1, oy + dy * h1, oz + dz * h1, s.w, s.r, s.g, s.b, 0.1, 1);
        if (s.glare > 0) this.sprites.glow(ox + dx * h1, oy + dy * h1, oz + dz * h1, s.glare, s.r * 0.5, s.g * 0.5, s.b * 0.5);
      }
      if (s.age < s.after) {
        const k = 1 - s.age / s.after;
        const gain = s.afterGain * k * k;
        ribbons.seg(ox, oy, oz, ox + dx * h1, oy + dy * h1, oz + dz * h1, s.w * 0.6, s.r * gain, s.g * gain, s.b * gain, 1, 1);
      }
    }
  }

  private updateBeams(): void {
    const f = this.f, ribbons = this.ribbons, sprites = this.sprites;
    const items = this.beams.items;
    for (let i = this.beams.count - 1; i >= 0; i--) {
      const b = items[i]!;
      const src = f.tracks.get(b.from);
      const since = f.now - b.last;
      // Weapon beams are reported about ten times per second, tool beams about four times.
      const hold = b.kind === WEAPON ? 0.14 : 0.3, gone = b.kind === WEAPON ? 0.36 : 0.56;
      if (!src || since > gone) { this.beams.free(i); continue; }
      const level = (1 - smooth(hold, gone, since)) * Math.min(1, 0.3 + (f.now - b.born) / 0.06);
      f.muzzle(src, b.slot, M);

      // E is where the line ends, C where it touches something (and `touch` whether it does).
      let ex = b.ex, ey = b.ey, ez = b.ez;
      let touch = true;
      C[0] = ex; C[1] = ey; C[2] = ez;
      const target = b.mode === ON_TARGET ? f.tracks.get(b.to) : undefined;
      if (target) {
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

      const flick = level * (0.86 + 0.14 * Math.sin(f.now * 91 + b.key) * Math.sin(f.now * 57 + 1.3));
      const sx = M[0] + f.zx, sy = M[1] + f.zy, sz = M[2] + f.zz;
      const tx = ex + f.zx, ty = ey + f.zy, tz = ez + f.zz;
      const cx = C[0] + f.zx, cy = C[1] + f.zy, cz = C[2] + f.zz;
      if (b.kind === WEAPON) {
        const c = b.cold ? COLD : HOT;
        const g = 9 * flick;
        ribbons.seg(sx, sy, sz, tx, ty, tz, 0.5, c[0] * g, c[1] * g, c[2] * g, 1, 1);
        sprites.glow(sx, sy, sz, 1.6, c[0] * 6 * flick, c[1] * 6 * flick, c[2] * 6 * flick);
        if (touch) sprites.glow(cx, cy, cz, 2.6, c[0] * 8 * flick, c[1] * 8 * flick, c[2] * 8 * flick);
      } else if (b.kind === MINE) {
        const g = 7 * flick;
        ribbons.seg(sx, sy, sz, tx, ty, tz, 0.8, MINING[0] * g, MINING[1] * g, MINING[2] * g, 1, 1);
        ribbons.seg(sx, sy, sz, tx, ty, tz, 0.3, 6 * flick, 5.4 * flick, 4.2 * flick, 1, 1);
        sprites.glow(sx, sy, sz, 1.8, 5 * flick, 2.6 * flick, 0.9 * flick);
        sprites.glow(cx, cy, cz, 4.2, 12 * flick, 7 * flick, 2.6 * flick);
        this.shower(b, 70, 6, 30, 0.4, 1.1, 0.09, 7, 4.2, 1.4, 0.05, level);
      } else {
        const g = 1.8 * flick;
        ribbons.seg(sx, sy, sz, tx, ty, tz, 0.2, SALVAGE[0] * g, SALVAGE[1] * g, SALVAGE[2] * g, 1, 1);
        sprites.glow(sx, sy, sz, 0.9, 1.4 * flick, 2.1 * flick, 3.2 * flick);
        sprites.glow(cx, cy, cz, 1.8, 5 * flick, 7 * flick, 10 * flick);
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

  clear(): void {
    this.rounds.count = 0;
    this.beams.count = 0;
  }
}
