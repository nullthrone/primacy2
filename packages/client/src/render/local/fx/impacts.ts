/**
 * What a hit looks like, and what it leaves. On a shield the shot is swallowed (`shell.ts`). On
 * the hull it leaves a scar that glows and cools (`scars.ts`), throws sparks as a cone away from
 * the plating and, when it was heavy, lets out a puff of gas (`vents.ts`); and it lights the hull
 * around it for an instant. A ship that has taken much shows it without being hit (`wounds.ts`).
 */
import { Group } from 'three';
import { EntityKind, MODULES } from '@primacy2/shared';
import type { GameEvent, Vec3 } from '@primacy2/shared';
import { clamp, smooth } from '../util.ts';
import { rand, randCone, rotate, type Frame, type Track } from './core.ts';
import { strike, toLocal } from './hull.ts';
import { effectLights } from './lights.ts';
import type { Flashes, Sparks } from './particles.ts';
import { Scars } from './scars.ts';
import { SHELL, Shell } from './shell.ts';
import { GLOW } from './sprites.ts';
import { Vents } from './vents.ts';
import { Wounds } from './wounds.ts';

type HitEvent = Extract<GameEvent, { e: 'hit' }>;

// The light of what landed, by weapon; the colours `weapons.ts` draws the shots in.
const HOT: Readonly<Vec3> = [1.0, 0.27, 0.08];
const COLD: Readonly<Vec3> = [0.2, 0.72, 1.0];
const TRACER: Readonly<Vec3> = [1.0, 0.8, 0.46];
const RAIL: Readonly<Vec3> = [0.6, 0.79, 1.0];
/** When nothing is known of the shot. */
const PLAIN: Readonly<Vec3> = [1.0, 0.92, 0.82];
/** The light a shield throws on the hull under it. */
const SHIELD: Readonly<Vec3> = [0.3, 0.58, 1.0];

/** What is kept of a ship between frames. */
interface Seen {
  /** Shield fraction a frame ago: a shield falls in the frame in which this was above zero and is not any more. */
  shield: number;
  seen: number;
  /** Where its shield was last hit, in its own axes, and when; the fall starts there. */
  lx: number; ly: number; lz: number;
  hitAt: number;
  /** Who hit its shield last, and how many of that one's hits came in quick succession. */
  by: number;
  run: number;
}

const HULL_SPARKS = [6, 10, 16] as const;
/** From this damage on a hit lets gas out of the hull: a missile and a rail slug do, cannon rounds do not. */
const HEAVY = 100;

const D: Vec3 = [0, 0, 0];
const L: Vec3 = [0, 0, 0];
const E: Vec3 = [0, 0, 0];
const P: Vec3 = [0, 0, 0];
const N: Vec3 = [0, 0, 0];
const W: Vec3 = [0, 0, 0];

export class Impacts {
  /** What this family draws besides the shared streaks and discs; the effects part hangs it into the scene. */
  readonly group = new Group();
  private readonly shell = new Shell();
  private readonly scars = new Scars();
  private readonly vents = new Vents();
  private readonly wounds = new Wounds();
  private readonly ships = new Map<number, Seen>();
  /** The weapon each ship last fired whose shots take time to arrive: their hits come frames after the shot. */
  private readonly slow = new Map<number, string>();
  private pruned = 0;
  private readonly prune = (s: Seen, id: number): void => {
    if (this.f.now - s.seen > 6) this.ships.delete(id);
  };

  constructor(private readonly f: Frame, private readonly sparks: Sparks, private readonly flashes: Flashes) {
    this.group.add(this.shell.mesh, this.scars.mesh, this.vents.mesh);
  }

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
    const by = ev.by !== undefined ? f.tracks.get(ev.by) : undefined;
    if (!exact) {
      if (by) { nx = by.x - cx; ny = by.y - cy; nz = by.z - cz; } else { nx = -f.zx - cx; ny = -f.zy - cy; nz = -f.zz - cz; }
      d = Math.hypot(nx, ny, nz);
    }
    if (d < 1e-6) { nx = 0; ny = 1; nz = 0; d = 1; }
    nx /= d; ny /= d; nz /= d;
    // About 0.8 for a pulse bolt, 1.7 for a few cannon rounds, 3.2 for a missile, 3.6 for a rail slug.
    const power = Math.sqrt(clamp(ev.dmg / 20, 0.4, 13));
    const weapon = this.weaponOf(ev);
    const kind = weapon?.weapon?.kind;
    const light = !weapon || !kind ? PLAIN
      : kind === 'pulse' || kind === 'beam' ? (weapon.tier >= 2 ? COLD : HOT)
        : kind === 'cannon' && (weapon.weapon?.speed ?? 0) >= 5000 ? RAIL : TRACER;

    if (ev.shield && t) {
      this.onShield(ev, t, nx, ny, nz, power, kind, light);
      return;
    }
    if (t && (t.kind === EntityKind.Ship || t.kind === EntityKind.Wreck)) {
      this.onHull(ev, t, by, exact, nx, ny, nz, power);
      return;
    }

    // Anything else (a missile that went into the ground, a ship no longer in view): a flash, an
    // ember and sparks where it was reported.
    const ox = exact ? ev.at[0] - cx : nx * radius * 0.45;
    const oy = exact ? ev.at[1] - cy : ny * radius * 0.45;
    const oz = exact ? ev.at[2] - cz : nz * radius * 0.45;
    const flash = this.flashes.spawn(GLOW, t ? ox : cx + ox, t ? oy : cy + oy, t ? oz : cz + oz, 0.09, 0.9 * power, 2.6 * power, 1.0, 0.78, 0.5, 12);
    const ember = this.flashes.spawn(GLOW, flash.x, flash.y, flash.z, 0.5, 0.8 * power, 0.4 * power, 1.0, 0.36, 0.08, 4);
    if (t) { flash.follow = t.id; ember.follow = t.id; }
    this.spray(cx + ox, cy + oy, cz + oz, t, nx, ny, nz, 0.8, power);
  }

  /** The shot is swallowed by the shield of `t`; (nx, ny, nz) points from the centre to where it landed. */
  private onShield(ev: HitEvent, t: Track, nx: number, ny: number, nz: number, power: number, kind: string | undefined, light: Readonly<Vec3>): void {
    const f = this.f;
    toLocal(t, nx, ny, nz, L);
    const s = this.seen(t.id, this.fraction(t.id));
    const weak = 1 - smooth(0.08, 0.4, this.fraction(t.id));
    const from = ev.by ?? -1;
    // A held beam is told by its weapon; a shot of which nothing is known, by hits that follow one
    // another as fast as a beam reports itself.
    s.run = s.by === from && f.now - s.hitAt < 0.16 ? s.run + 1 : 0;
    s.by = from; s.hitAt = f.now;
    s.lx = L[0]; s.ly = L[1]; s.lz = L[2];
    if (kind === 'beam' || (kind === undefined && (s.run >= 2 || this.shell.held(t.id, from)))) {
      this.shell.hold(t, from, L[0], L[1], L[2], weak, light, 7, f.now);
      return;
    }
    this.shell.hit(t, L[0], L[1], L[2], power, weak, light, 3 + 1.2 * power);

    // The shot's own light at the place, for the instant before it is gone into the shell. Not when
    // the place is on the far side: a thin hull would not hide it.
    const r = t.radius * SHELL;
    const px = t.x + nx * r + f.zx, py = t.y + ny * r + f.zy, pz = t.z + nz * r + f.zz;
    const facing = -(nx * px + ny * py + nz * pz) / (Math.hypot(px, py, pz) || 1);
    const face = smooth(-0.2, 0.3, facing);
    if (face > 0) this.scars.glint(t, L[0] * r, L[1] * r, L[2] * r, light[0], light[1], light[2], 0.4 + 0.3 * power, 0.2, 7 * face);
    // And the dome's light on the hull beneath it.
    effectLights.pulse(nx * r * 0.85, ny * r * 0.85, nz * r * 0.85, SHIELD[0], SHIELD[1], SHIELD[2],
      0.45 * power * t.radius * t.radius * (1 - 0.5 * weak), 2.4 * t.radius, 0.3, t.id);
  }

  /** The shot goes into the hull of `t`. */
  private onHull(ev: HitEvent, t: Track, by: Track | undefined, exact: boolean, nx: number, ny: number, nz: number, power: number): void {
    const f = this.f;
    // The reported place relative to the centre, and the way the shot was travelling: from the
    // attacker through that place, or straight in when the attacker is not known.
    const px = exact ? ev.at[0] - t.x : nx * t.radius, py = exact ? ev.at[1] - t.y : ny * t.radius, pz = exact ? ev.at[2] - t.z : nz * t.radius;
    let dx = -nx, dy = -ny, dz = -nz;
    if (by && by !== t) { dx = t.x + px - by.x; dy = t.y + py - by.y; dz = t.z + pz - by.z; }
    toLocal(t, px, py, pz, L);
    toLocal(t, dx, dy, dz, E);
    strike(t.radius, L[0], L[1], L[2], E[0], E[1], E[2], P, N);
    rotate(t, P[0], P[1], P[2], W);
    rotate(t, N[0], N[1], N[2], D);
    const wx = W[0], wy = W[1], wz = W[2];
    const ux = D[0], uy = D[1], uz = D[2];

    // The light of the hit on the plating around it, from a little off the surface: a light in the
    // skin lights nothing. By the square of the power, so that pulse bolts leave the few lights
    // there are to what is heavier.
    const off = 1 + 0.08 * t.radius;
    effectLights.pulse(wx + ux * off, wy + uy * off, wz + uz * off, 1.0, 0.8, 0.55, 30 * power * power, 8 + 6 * power, 0.12 + 0.05 * power, t.id);
    // What the pilot sees of a hit on his own ship from inside it is not drawn here; the light is.
    if (t.own && f.view.camera.mode === 'cockpit') return;

    this.scars.spawn(t, P[0], P[1], P[2], N[0], N[1], N[2], 0.3 + 0.35 * power, Math.min(3, 2 + 0.3 * power), 9 + 2 * power);

    // The flash stands off the plating toward the camera, or the hull would cut it in half; and a
    // hit on the far side of the hull shows none.
    let vx = -(t.x + wx + f.zx), vy = -(t.y + wy + f.zy), vz = -(t.z + wz + f.zz);
    const vd = Math.hypot(vx, vy, vz) || 1;
    vx /= vd; vy /= vd; vz /= vd;
    const face = smooth(-0.3, 0.2, ux * vx + uy * vy + uz * vz);
    if (face > 0) {
      const lift = Math.min(0.25 * t.radius, 0.5 * vd);
      const flash = this.flashes.spawn(GLOW, wx + ux * 0.4 + vx * lift, wy + uy * 0.4 + vy * lift, wz + uz * 0.4 + vz * lift,
        0.08 + 0.02 * power, 0.8 * power, 2.4 * power, 1.0, 0.82, 0.6, 12 * face);
      flash.follow = t.id;
    }
    this.spray(t.x + wx + ux * 0.3, t.y + wy + uy * 0.3, t.z + wz + uz * 0.3, t, ux, uy, uz, 0.55, power);

    if (ev.dmg >= HEAVY) {
      const len = 0.35 * t.radius + 1.6 * power;
      this.vents.puff(t, P[0], P[1], P[2], N[0], N[1], N[2], len, 0.24 * len, 0.9 + 0.1 * power, 0.5 + 0.06 * power);
    }
  }

  /** Sparks from (x, y, z) in anchor coordinates, as a cone around the unit vector n; more, larger and faster with `power`. */
  private spray(x: number, y: number, z: number, t: Track | undefined, nx: number, ny: number, nz: number, spread: number, power: number): void {
    const vx = t ? t.vx : 0, vy = t ? t.vy : 0, vz = t ? t.vz : 0;
    const count = Math.round(HULL_SPARKS[this.f.quality] * clamp(power, 0.7, 2.6));
    const w = 0.06 + 0.03 * power, fast = 0.7 + 0.25 * power;
    for (let i = 0; i < count; i++) {
      randCone(nx, ny, nz, spread, D);
      const v = rand(16, 62) * fast;
      this.sparks.spawn(x, y, z, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, rand(0.3, 0.9), w, 8, 5.6, 2.6, 0.04);
    }
    // A heavy hit also knocks out a few pieces that are larger, slower and glow for longer.
    const chunks = power > 1.5 ? Math.round(1.5 * power) : 0;
    for (let i = 0; i < chunks; i++) {
      randCone(nx, ny, nz, spread, D);
      const v = rand(5, 16);
      this.sparks.spawn(x, y, z, vx + D[0] * v, vy + D[1] * v, vz + D[2] * v, rand(0.8, 1.5), 1.8 * w, 9, 6, 2.6, 0.05);
    }
  }

  /**
   * The weapon a hit came from, when it can be told: a shot that is there at once is reported
   * right before its hit; of the others the attacker's last is remembered.
   */
  private weaponOf(ev: HitEvent): (typeof MODULES)[string] | undefined {
    if (ev.by === undefined) return undefined;
    const events = this.f.view.events;
    const prev = events[events.indexOf(ev) - 1];
    if (prev && prev.e === 'shot' && prev.from === ev.by && prev.to === ev.id) return MODULES[prev.w];
    const w = this.slow.get(ev.by);
    return w !== undefined ? MODULES[w] : undefined;
  }

  /** Shield fraction of a ship in view, 0..1. */
  private fraction(id: number): number {
    const view = this.f.view;
    const self = view.self;
    if (self && self.id === id) return self.stats.shieldMax > 0 ? self.state.shield / self.stats.shieldMax : 0;
    const ents = view.ents;
    for (let i = 0; i < ents.length; i++) if (ents[i]!.id === id) return ents[i]!.shield;
    return 0;
  }

  /** What is kept of ship `id`; made at first sight with the shield it has then. */
  private seen(id: number, shield: number): Seen {
    let s = this.ships.get(id);
    if (!s) {
      s = { shield, seen: this.f.now, lx: 0, ly: 0, lz: 0, hitAt: -1e9, by: -1, run: 0 };
      this.ships.set(id, s);
    }
    return s;
  }

  /** Notes the shield of a ship this frame, and lets it fall when it has just gone. */
  private watch(id: number, shield: number): void {
    const f = this.f;
    const s = this.seen(id, shield);
    if (s.shield > 0 && shield <= 0) {
      const t = f.tracks.get(id);
      if (t) {
        // From where it was last hit; from the side that faces the camera when that was long ago.
        if (f.now - s.hitAt > 3) {
          toLocal(t, -f.zx - t.x, -f.zy - t.y, -f.zz - t.z, L);
          const l = Math.hypot(L[0], L[1], L[2]) || 1;
          s.lx = L[0] / l; s.ly = L[1] / l; s.lz = L[2] / l;
        }
        this.shell.collapse(t, s.lx, s.ly, s.lz);
      }
    }
    s.shield = shield;
    s.seen = f.now;
  }

  update(): void {
    const f = this.f;
    const view = f.view;
    const events = view.events;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.e !== 'shot') continue;
      const weapon = MODULES[ev.w]?.weapon;
      if (weapon && (weapon.speed > 0 || weapon.kind === 'missile')) this.slow.set(ev.from, ev.w);
    }
    const ents = view.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      if (e.info.kind === EntityKind.Ship) this.watch(e.id, e.shield);
    }
    const self = view.self;
    if (self) this.watch(self.id, self.stats.shieldMax > 0 ? self.state.shield / self.stats.shieldMax : 0);
    if (f.now - this.pruned > 2) {
      this.pruned = f.now;
      this.ships.forEach(this.prune);
      if (this.slow.size > 256) this.slow.clear();
    }

    this.shell.update(f);
    this.scars.update(f);
    this.vents.begin();
    this.wounds.update(f, this.sparks, this.flashes, this.vents);
    this.vents.update(f);
    this.vents.end();
  }

  clear(): void {
    this.shell.clear();
    this.scars.clear();
    this.vents.clear();
    this.ships.clear();
    this.slow.clear();
  }

  dispose(): void {
    this.shell.dispose();
    this.scars.dispose();
    this.vents.dispose();
  }
}
