/**
 * Missiles are entities drawn by the objects part; here they get what makes them visible from afar:
 * a flare at the nozzle and a trail of hot exhaust that reddens and fades behind them.
 *
 * This part also notices a missile going off. The server takes the missile out of the world and
 * sends a plain hit, nothing that says a warhead burst. So a missile that is gone from the view
 * beside something it can have gone off at is handed to the blasts part as a detonation (see
 * `detonations.ts`); one that is gone in empty space ran out of fuel or out of sight, and shows
 * nothing.
 */
import { Group } from 'three';
import { EntityKind } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
import { rotate, type Frame } from './core.ts';
import { detonations } from './detonations.ts';
import { groundBelow, type GroundBelow } from './ground.ts';
import type { Ribbons } from './ribbons.ts';
import type { Sprites } from './sprites.ts';

const SAMPLES = 40;
/** Seconds between trail samples, and how long a sample stays visible. */
const STEP = 0.025;
const FADE = 0.9;
/** Seconds of exhaust behind the nozzle that are still dense: the trail is drawn wider there, which gives it body. */
const DENSE = 0.3;
const MAX_TRAILS = 16;
/**
 * A missile that vanishes within this many metres of a hull went off there. The server's fuse is
 * 15 m; the rest allows for the view running a little behind, which grows with the missile's speed.
 */
const FUSE = 25;
const FUSE_LAG = 0.15;

interface Trail {
  id: number;
  live: boolean;
  seen: number;
  /** Where the missile was when last seen, relative to the zone anchor, and its velocity. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Set once it is gone and that has been looked at, so it goes off only once. */
  gone: boolean;
  /** Ring of past nozzle positions (anchor coordinates) and when they were taken; `head` is the newest. */
  px: Float64Array; py: Float64Array; pz: Float64Array; pt: Float64Array;
  head: number;
  count: number;
}

const T: Vec3 = [0, 0, 0];
const GB: GroundBelow = { h: 0, ux: 0, uy: 1, uz: 0, g: 0 };
const fade = (age: number): number => {
  const k = 1 - age / FADE;
  return k > 0 ? k * k : 0;
};

export class Missiles {
  /** What this family draws besides the shared streaks and discs; the effects part hangs it into the scene. */
  readonly group = new Group();
  private readonly trails: Trail[] = Array.from({ length: MAX_TRAILS }, () => ({
    id: 0, live: false, seen: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, gone: false,
    px: new Float64Array(SAMPLES), py: new Float64Array(SAMPLES), pz: new Float64Array(SAMPLES), pt: new Float64Array(SAMPLES),
    head: 0, count: 0,
  }));

  constructor(private readonly f: Frame, private readonly ribbons: Ribbons, private readonly sprites: Sprites) {}

  private trailOf(id: number): Trail | null {
    let free: Trail | null = null;
    for (let i = 0; i < MAX_TRAILS; i++) {
      const t = this.trails[i]!;
      if (t.live && t.id === id) return t;
      if (!t.live && !free) free = t;
    }
    if (free) { free.id = id; free.live = true; free.gone = false; free.count = 0; free.head = 0; }
    return free;
  }

  /** A missile that was in the view a frame ago and is not now: tells the blasts part if it went off. */
  private vanished(t: Trail): void {
    const f = this.f;
    // One that was shot down has its own event, and the blasts part draws that.
    const events = f.view.events;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.e === 'destroyed' && ev.id === t.id) return;
    }
    // Where it is now, had it flown on.
    const x = t.x + t.vx * f.dt, y = t.y + t.vy * f.dt, z = t.z + t.vz * f.dt;
    const reach = FUSE + FUSE_LAG * Math.hypot(t.vx, t.vy, t.vz);
    let near = groundBelow(f, x, y, z, GB) && GB.h < reach;
    if (!near) {
      for (const o of f.tracks.values()) {
        if (o.id === t.id || o.kind === EntityKind.Missile || f.now - o.seen > 0.5) continue;
        if (Math.hypot(o.x - x, o.y - y, o.z - z) < o.radius + reach) { near = true; break; }
      }
    }
    if (near) detonations.push(x, y, z, t.vx, t.vy, t.vz);
  }

  update(): void {
    const f = this.f, ribbons = this.ribbons, sprites = this.sprites;
    const ents = f.view.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      if (e.info.kind !== EntityKind.Missile) continue;
      const m = f.tracks.get(e.id);
      const trail = this.trailOf(e.id);
      if (!m || !trail) continue;
      // The nozzle is at the back end of the missile.
      rotate(m, 0, 0, 1, T);
      const nx = m.x + T[0] * m.radius, ny = m.y + T[1] * m.radius, nz = m.z + T[2] * m.radius;
      trail.seen = f.now;
      // A new missile under an id that was used before starts over.
      trail.gone = false;
      trail.x = m.x; trail.y = m.y; trail.z = m.z;
      trail.vx = m.vx; trail.vy = m.vy; trail.vz = m.vz;
      const h = trail.head;
      if (trail.count > 0) {
        // A missile that jumps (a new one reusing the id) starts a fresh trail.
        const gap = Math.hypot(nx - trail.px[h]!, ny - trail.py[h]!, nz - trail.pz[h]!);
        if (gap > 40 + Math.hypot(m.vx, m.vy, m.vz) * 0.25) trail.count = 0;
      }
      if (trail.count === 0 || f.now - trail.pt[h]! >= STEP) {
        const n = trail.count === 0 ? h : (h + 1) % SAMPLES;
        trail.px[n] = nx; trail.py[n] = ny; trail.pz[n] = nz; trail.pt[n] = f.now;
        trail.head = n;
        if (trail.count < SAMPLES) trail.count++;
      }

      // The flare flickers like a burning motor; a short plume points backward from it.
      const flick = 0.85 + 0.15 * Math.sin(f.now * 73 + e.id) * Math.sin(f.now * 41);
      const cx = nx + f.zx, cy = ny + f.zy, cz = nz + f.zz;
      sprites.glow(cx, cy, cz, 3.8 * flick, 12 * flick, 9 * flick, 5.6 * flick);
      const L = 10 * flick;
      ribbons.seg(cx + T[0] * L, cy + T[1] * L, cz + T[2] * L, cx, cy, cz, 0.8, 9, 5.2, 2.1, 0, 1);
      // The stretch from the newest sample to the nozzle keeps the trail attached between samples.
      const k = fade(f.now - trail.pt[trail.head]!);
      const hx = trail.px[trail.head]! + f.zx, hy = trail.py[trail.head]! + f.zy, hz = trail.pz[trail.head]! + f.zz;
      ribbons.seg(hx, hy, hz, cx, cy, cz, 0.6, 4.4, 2.5, 1.1, k, 0);
      ribbons.seg(hx, hy, hz, cx, cy, cz, 1.5, 0.9, 0.45, 0.16, k, 0);
    }

    for (let i = 0; i < MAX_TRAILS; i++) {
      const t = this.trails[i]!;
      if (!t.live) continue;
      if (t.seen !== f.now && !t.gone) {
        t.gone = true;
        this.vanished(t);
      }
      if (f.now - t.seen > FADE + 0.1) { t.live = false; continue; }
      // Segments from each sample to the next newer one. Exhaust dims and reddens as it ages, and
      // while it is young and dense a wider, fainter streak lies around it.
      for (let j = 0; j < t.count - 1; j++) {
        const b = (t.head - j + SAMPLES) % SAMPLES, a = (b - 1 + SAMPLES) % SAMPLES;
        const age = f.now - t.pt[b]!;
        const kb = fade(age);
        if (kb <= 0) break;
        const tail = fade(f.now - t.pt[a]!) / kb;
        const ax = t.px[a]! + f.zx, ay = t.py[a]! + f.zy, az = t.pz[a]! + f.zz;
        const bx = t.px[b]! + f.zx, by = t.py[b]! + f.zy, bz = t.pz[b]! + f.zz;
        ribbons.seg(ax, ay, az, bx, by, bz, 0.6, 4.4 * kb, 2.5 * kb * (0.5 + 0.5 * kb), 1.1 * kb * kb, tail, 0);
        if (age < DENSE) {
          const d = 1 - age / DENSE;
          ribbons.seg(ax, ay, az, bx, by, bz, 1.5, 0.9 * d, 0.45 * d, 0.16 * d, Math.max(0, 1 - (f.now - t.pt[a]!) / DENSE) / d, 0);
        }
      }
    }
  }

  clear(): void {
    for (let i = 0; i < MAX_TRAILS; i++) this.trails[i]!.live = false;
  }

  /** Frees what `group` holds. */
  dispose(): void {}
}
