/**
 * Missiles are entities drawn by the objects part; here they get what makes them visible from afar:
 * a flare at the nozzle and a short trail of hot exhaust that fades behind them.
 */
import { EntityKind } from '@primacy2/shared';
import type { Vec3 } from '@primacy2/shared';
import { rotate, type Frame } from './core.ts';
import type { Ribbons } from './ribbons.ts';
import type { Sprites } from './sprites.ts';

const SAMPLES = 24;
/** Seconds between trail samples, and how long a sample stays visible. */
const STEP = 0.025;
const FADE = 0.5;
const MAX_TRAILS = 16;

interface Trail {
  id: number;
  live: boolean;
  seen: number;
  /** Ring of past nozzle positions (anchor coordinates) and when they were taken; `head` is the newest. */
  px: Float64Array; py: Float64Array; pz: Float64Array; pt: Float64Array;
  head: number;
  count: number;
}

const T: Vec3 = [0, 0, 0];
const fade = (age: number): number => {
  const k = 1 - age / FADE;
  return k > 0 ? k * k : 0;
};

export class Missiles {
  private readonly trails: Trail[] = Array.from({ length: MAX_TRAILS }, () => ({
    id: 0, live: false, seen: 0,
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
    if (free) { free.id = id; free.live = true; free.count = 0; free.head = 0; }
    return free;
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
      sprites.glow(cx, cy, cz, 3.4 * flick, 11 * flick, 8.2 * flick, 5 * flick);
      const L = 9 * flick;
      ribbons.seg(cx + T[0] * L, cy + T[1] * L, cz + T[2] * L, cx, cy, cz, 0.7, 8, 4.6, 1.8, 0, 1);
      // The stretch from the newest sample to the nozzle keeps the trail attached between samples.
      const k = fade(f.now - trail.pt[trail.head]!);
      ribbons.seg(trail.px[trail.head]! + f.zx, trail.py[trail.head]! + f.zy, trail.pz[trail.head]! + f.zz, cx, cy, cz,
        0.45, 3.2, 1.7, 0.7, k, 0);
    }

    for (let i = 0; i < MAX_TRAILS; i++) {
      const t = this.trails[i]!;
      if (!t.live) continue;
      if (f.now - t.seen > FADE + 0.1) { t.live = false; continue; }
      // Segments from each sample to the next newer one, dimming with the age of the exhaust.
      for (let j = 0; j < t.count - 1; j++) {
        const b = (t.head - j + SAMPLES) % SAMPLES, a = (b - 1 + SAMPLES) % SAMPLES;
        const kb = fade(f.now - t.pt[b]!);
        if (kb <= 0) break;
        const ka = fade(f.now - t.pt[a]!);
        ribbons.seg(t.px[a]! + f.zx, t.py[a]! + f.zy, t.pz[a]! + f.zz, t.px[b]! + f.zx, t.py[b]! + f.zy, t.pz[b]! + f.zz,
          0.45, 3.2 * kb, 1.7 * kb, 0.7 * kb, ka / kb, 0);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < MAX_TRAILS; i++) this.trails[i]!.live = false;
  }
}
