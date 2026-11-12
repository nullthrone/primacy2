/**
 * Weapons: firing hitscan, projectile and missile mounts, resolving delayed projectile impacts
 * and guiding missiles.
 */
import {
  Button,
  EntityFlag,
  EntityKind,
  FlightMode,
  MASS_LOCK_RADIUS,
  findSite,
  forwardOf,
  quat,
  v3,
  type AsteroidDef,
  type EntityInfo,
  type GameEvent,
  type SiteDef,
  type Vec3,
  type WeaponMount,
} from '@primacy2/shared';
import type { Ship } from '../../game.ts';
import type { SystemSim } from '../../sim.ts';
import { onAttack } from './law.ts';

const FIRE_MASK = Button.Fire1 | Button.Fire2;
/** A cooldown at or below this counts as elapsed (absorbs floating-point residue). */
const READY_EPS = 1e-6;
/** Seconds between `shot` events of a continuously firing beam. */
const BEAM_EVENT_INTERVAL = 0.2;
/** Seconds between "weapons locked" notices to one pilot. */
const LOCK_NOTICE_INTERVAL = 5;
/** A projectile still hits when its target strayed this far (plus its radius) from the predicted point, metres. */
const DODGE_MARGIN = 4;

export const MISSILE_TTL = 14;
/** Missile turn limit, rad/s. */
const MISSILE_TURN = 1.5;
/** A missile detonates this close to the hull of its target, metres. */
const MISSILE_FUSE = 15;
/** Against any other ship it needs a near-direct hit, metres. */
const MISSILE_CONTACT = 2;

/** A projectile in flight toward a predicted impact. */
interface Impact {
  /** Universe time of arrival. */
  due: number;
  zone: number;
  victim: number;
  by: number;
  dmg: number;
  shieldMul: number;
  hullMul: number;
  /** Predicted impact point relative to the zone anchor. */
  at: Vec3;
}

/** Guidance and warhead data carried in `SimObject.data` of a missile. */
interface MissileData {
  missile: true;
  from: number;
  target: number | null;
  dmg: number;
  shieldMul: number;
  hullMul: number;
  speed: number;
}

const impactsOf = new WeakMap<SystemSim, Impact[]>();
const lockNoticeAt = new WeakMap<Ship, number>();

const isField = (site: SiteDef): boolean => site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly';

/** The asteroids that can block shots in a zone, or null when the zone has none. */
function rocksOf(sim: SystemSim, zone: number): readonly AsteroidDef[] | null {
  const site = findSite(sim.def, zone);
  return site && isField(site) ? sim.asteroids(site.id) : null;
}

/**
 * Distance along a ray (unit `dir`) to a sphere, or -1 when it is missed or farther than `maxDist`.
 * A ray starting inside the sphere hits at distance 0.
 */
function raySphere(o: Readonly<Vec3>, dir: Readonly<Vec3>, c: Readonly<Vec3>, r: number, maxDist: number): number {
  const mx = c[0] - o[0];
  const my = c[1] - o[1];
  const mz = c[2] - o[2];
  const along = mx * dir[0] + my * dir[1] + mz * dir[2];
  if (along < -r || along - r > maxDist) return -1;
  const c2 = mx * mx + my * my + mz * mz - r * r;
  if (c2 <= 0) return 0;
  if (along <= 0) return -1;
  const disc = along * along - c2;
  if (disc < 0) return -1;
  const d = along - Math.sqrt(disc);
  return d <= maxDist ? d : -1;
}

/**
 * Squared closest distance to the origin of a point that ended the last `dt` seconds at `p`
 * moving with velocity `v`. Catches fast objects that would step over a small sphere.
 */
function sweptDistSq(p: Readonly<Vec3>, v: Readonly<Vec3>, dt: number): number {
  const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  let back = vv > 0 ? (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / vv : 0;
  back = back < 0 ? 0 : back > dt ? dt : back;
  const x = p[0] - v[0] * back;
  const y = p[1] - v[1] * back;
  const z = p[2] - v[2] * back;
  return x * x + y * y + z * z;
}

/** Time for a projectile of `speed` to meet a target at relative position `to` moving with `vel`, or -1. */
function interceptTime(to: Readonly<Vec3>, vel: Readonly<Vec3>, speed: number): number {
  const a = v3.lenSq(vel) - speed * speed;
  const b = 2 * v3.dot(to, vel);
  const c = v3.lenSq(to);
  if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  const t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : -1;
}

/** The ship's locked target if it is a live ship in the same zone. */
function lockedTarget(sim: SystemSim, ship: Ship): Ship | null {
  if (ship.target === null) return null;
  const t = sim.ships.get(ship.target);
  if (!t || t === ship || t.gone || t.state.mode !== FlightMode.Normal || t.state.anchor !== ship.state.anchor) return null;
  return t;
}

/**
 * Direction a mount fires in: at the locked target (or its lead position for projectiles) when
 * that lies within range and the gimbal cone, otherwise straight along the nose.
 */
function aimDir(m: WeaponMount, origin: Readonly<Vec3>, fwd: Vec3, target: Ship | null): Vec3 {
  if (!target) return fwd;
  let to = v3.sub(target.state.pos, origin);
  if (m.speed > 0 && m.kind !== 'missile') {
    const t = interceptTime(to, target.state.vel, m.speed);
    if (t < 0) return fwd;
    to = v3.addScaled(to, target.state.vel, t);
  }
  const d = v3.len(to);
  if (d < 1e-3 || d > m.range) return fwd;
  return v3.dot(to, fwd) / d >= Math.cos(m.gimbal) ? v3.scale(to, 1 / d) : fwd;
}

/**
 * First thing a shot meets within `range`: a ship (returned) or an asteroid (ship null, shorter
 * distance). For projectiles (`speed` > 0) ships are tested where they will be on arrival.
 */
function trace(
  sim: SystemSim, shooter: Ship, origin: Readonly<Vec3>, dir: Readonly<Vec3>, range: number, speed: number,
  rocks: readonly AsteroidDef[] | null,
): { ship: Ship | null; dist: number } {
  let best = range;
  let hit: Ship | null = null;
  for (const o of sim.shipsInZone(shooter.state.anchor)) {
    if (o === shooter || o.gone || o.state.mode !== FlightMode.Normal) continue;
    let c: Readonly<Vec3> = o.state.pos;
    if (speed > 0) c = v3.addScaled(c, o.state.vel, v3.dist(origin, c) / speed);
    const d = raySphere(origin, dir, c, o.stats.radius, best);
    if (d >= 0) {
      best = d;
      hit = o;
    }
  }
  if (rocks) {
    for (const a of rocks) {
      const d = raySphere(origin, dir, a.pos, a.radius, best);
      if (d >= 0 && d < best) {
        best = d;
        hit = null;
      }
    }
  }
  return { ship: hit, dist: best };
}

/** Damages `victim` on behalf of `attacker`, applying the law first. */
export function strike(
  sim: SystemSim, attacker: Ship | null, victim: Ship, dmg: number, shieldMul: number, hullMul: number, at: Vec3, silent = false,
): void {
  if (victim.gone || victim.state.mode !== FlightMode.Normal) return;
  if (attacker) onAttack(sim, attacker, victim);
  sim.damage(victim, dmg, { by: attacker, shieldMul, hullMul, at, silent });
}

function launchMissile(sim: SystemSim, ship: Ship, m: WeaponMount, slot: number, origin: Vec3, fwd: Vec3, target: Ship | null): void {
  // A lock outside the seeker cone or beyond range is not passed on: the missile flies straight.
  let lock: Ship | null = null;
  if (target) {
    const to = v3.sub(target.state.pos, origin);
    const d = v3.len(to);
    if (d > 1e-3 && d <= m.range && v3.dot(to, fwd) / d >= Math.cos(m.gimbal)) lock = target;
  }
  const speed = m.speed + Math.max(0, v3.dot(ship.state.vel, fwd));
  const id = sim.world.allocId();
  const info: EntityInfo = { id, kind: EntityKind.Missile, name: 'Missile', model: 'missile', radius: 1 };
  const data: MissileData = {
    missile: true, from: ship.id, target: lock ? lock.id : null, dmg: m.damage, shieldMul: m.shieldMul, hullMul: m.hullMul, speed,
  };
  sim.addObject({
    id, kind: EntityKind.Missile, anchor: ship.state.anchor, pos: v3.clone(origin), vel: v3.scale(fwd, speed),
    rot: quat.clone(ship.state.rot), radius: 1, info, ttl: MISSILE_TTL, data,
  });
  const ev: Extract<GameEvent, { e: 'shot' }> = { e: 'shot', from: ship.id, w: m.id, slot, at: v3.clone(origin) };
  if (lock) ev.to = lock.id;
  sim.emit(ship.state.anchor, ev);
}

/**
 * Fires every ready mount of the held groups. Returns true while the ship is actually shooting
 * (a mount fired this tick or is between the shots of a burst).
 */
function fire(sim: SystemSim, ship: Ship, buttons: number, dt: number): boolean {
  const s = ship.state;
  const zone = s.anchor;
  const site = findSite(sim.def, zone);
  // Station defences jam weapons around stations in secure space; the patrols are exempt.
  if (
    site && sim.def.security === 'secure' && (site.kind === 'station' || site.kind === 'outpost') &&
    ship.npc !== 'security' && v3.lenSq(s.pos) < MASS_LOCK_RADIUS * MASS_LOCK_RADIUS
  ) {
    const p = ship.player;
    if (p && sim.time - (lockNoticeAt.get(ship) ?? -1e12) >= LOCK_NOTICE_INTERVAL) {
      lockNoticeAt.set(ship, sim.time);
      p.notice('warn', 'weapons_locked', 'Weapons are locked this close to a station in secure space.');
    }
    return false;
  }

  const rocks = site && isField(site) ? sim.asteroids(site.id) : null;
  const fwd = forwardOf(s.rot);
  const target = lockedTarget(sim, ship);
  const mounts = ship.stats.weapons;
  const cd = ship.cooldowns;
  let firing = false;

  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]!;
    if (m.group === 3 || m.kind === 'mining') continue;
    if ((buttons & (m.group === 1 ? Button.Fire1 : Button.Fire2)) === 0) continue;
    const beam = m.kind === 'beam';
    const wait = cd[i] ?? 0;
    if (!beam && wait > READY_EPS) {
      firing = true;
      continue;
    }
    // Beams cost and deal their per-second figures continuously; everything else per shot.
    const scale = beam ? dt : 1;
    const energy = m.energy * scale;
    const heat = m.heat * scale;
    if (s.energy < energy || s.heat + heat > ship.stats.heatCap) continue;
    s.energy -= energy;
    s.heat += heat;
    firing = true;
    const origin = v3.add(s.pos, quat.rotate(s.rot, m.offset));

    if (m.kind === 'missile') {
      cd[i] = wait + 1 / Math.max(m.rate, 0.01);
      launchMissile(sim, ship, m, i, origin, fwd, target);
      continue;
    }

    const dir = aimDir(m, origin, fwd, target);
    const speed = m.speed > 0 ? m.speed : 0;
    const hit = trace(sim, ship, origin, dir, m.range, speed, rocks);
    const at = v3.addScaled(origin, dir, hit.dist);

    // A beam reports itself a few times per second; its damage in between is applied silently.
    let report = true;
    if (beam) {
      report = wait <= READY_EPS;
      if (report) cd[i] = wait + BEAM_EVENT_INTERVAL;
    } else {
      // Adding to the (slightly negative) remainder keeps the average rate exact at any tick rate.
      cd[i] = wait + 1 / Math.max(m.rate, 0.01);
    }
    if (report) {
      const ev: Extract<GameEvent, { e: 'shot' }> = { e: 'shot', from: ship.id, w: m.id, slot: i, at };
      if (hit.ship) ev.to = hit.ship.id;
      sim.emit(zone, ev);
    }
    if (!hit.ship) continue;

    if (speed > 0) {
      let list = impactsOf.get(sim);
      if (!list) impactsOf.set(sim, (list = []));
      list.push({
        due: sim.time + hit.dist / speed, zone, victim: hit.ship.id, by: ship.id,
        dmg: m.damage, shieldMul: m.shieldMul, hullMul: m.hullMul, at: v3.clone(at),
      });
    } else {
      strike(sim, ship, hit.ship, m.damage * scale, m.shieldMul, m.hullMul, at, !report);
    }
  }
  return firing;
}

/** Counts weapon cooldowns down and fires the mounts of every ship holding a trigger. */
export function stepWeapons(sim: SystemSim, dt: number): void {
  for (const ship of sim.ships.values()) {
    const cd = ship.cooldowns;
    if (cd.length === 0) continue;
    const buttons = ship.input.buttons & FIRE_MASK;
    const held = buttons !== 0 && !ship.gone && ship.state.mode === FlightMode.Normal;
    for (let i = 0; i < cd.length; i++) {
      const v = cd[i]!;
      // While the trigger is held the overshoot below zero is kept for this tick, so the next
      // cooldown can start from it; otherwise the weapon simply becomes ready.
      if (v > 0) cd[i] = held ? v - dt : Math.max(0, v - dt);
    }
    if (buttons === 0) continue;
    // The core sets the flag from the trigger alone; make it say whether shots really leave.
    ship.flags &= ~EntityFlag.Firing;
    if (!held) continue;
    if (fire(sim, ship, buttons, dt)) ship.flags |= EntityFlag.Firing;
    for (let i = 0; i < cd.length; i++) if (cd[i]! < 0) cd[i] = 0;
  }
}

/** Applies the projectiles that arrive this tick. */
export function stepImpacts(sim: SystemSim): void {
  const list = impactsOf.get(sim);
  if (!list || list.length === 0) return;
  const t = sim.time;
  let keep = 0;
  for (let i = 0; i < list.length; i++) {
    const im = list[i]!;
    if (im.due > t) {
      list[keep++] = im;
      continue;
    }
    const victim = sim.ships.get(im.victim);
    if (!victim || victim.gone || victim.state.mode !== FlightMode.Normal || victim.state.anchor !== im.zone) continue;
    // The shell flew to where the target was heading; one that changed course far enough is missed.
    const reach = victim.stats.radius * 2 + DODGE_MARGIN;
    if (v3.distSq(victim.state.pos, im.at) > reach * reach) continue;
    const by = sim.ships.get(im.by) ?? null;
    strike(sim, by, victim, im.dmg, im.shieldMul, im.hullMul, im.at);
  }
  list.length = keep;
}

/** Number of projectiles in flight (for tests and diagnostics). */
export function pendingImpacts(sim: SystemSim): number {
  return impactsOf.get(sim)?.length ?? 0;
}

/** Guides missiles toward their targets and detonates them. The core has already moved them this tick. */
export function stepMissiles(sim: SystemSim, dt: number): void {
  if (sim.objects.size === 0) return;
  for (const o of sim.objects.values()) {
    if (o.kind !== EntityKind.Missile) continue;
    const d = o.data as MissileData | undefined;
    if (!d || d.missile !== true) continue;

    // Proximity fuse against the target, contact fuse against anything else in the way.
    let hit: Ship | null = null;
    for (const sh of sim.shipsInZone(o.anchor)) {
      if (sh.id === d.from || sh.gone || sh.state.mode !== FlightMode.Normal) continue;
      const fuse = sh.stats.radius + (sh.id === d.target ? MISSILE_FUSE : MISSILE_CONTACT);
      const rel = v3.sub(o.pos, sh.state.pos);
      if (rel[0] > 400 || rel[0] < -400 || rel[1] > 400 || rel[1] < -400 || rel[2] > 400 || rel[2] < -400) continue;
      if (sweptDistSq(rel, v3.sub(o.vel, sh.state.vel), dt) <= fuse * fuse) {
        hit = sh;
        break;
      }
    }
    if (hit) {
      sim.removeObject(o.id);
      const shooter = sim.ships.get(d.from) ?? null;
      strike(sim, shooter, hit, d.dmg, d.shieldMul, d.hullMul, v3.clone(o.pos));
      continue;
    }

    // Asteroids give cover from missiles too.
    const rocks = rocksOf(sim, o.anchor);
    let blocked = false;
    if (rocks) {
      for (const a of rocks) {
        const x = o.pos[0] - a.pos[0];
        const reach = a.radius + 40;
        if (x > reach || x < -reach) continue;
        if (sweptDistSq([x, o.pos[1] - a.pos[1], o.pos[2] - a.pos[2]], o.vel, dt) < a.radius * a.radius) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) {
      sim.removeObject(o.id);
      continue;
    }

    const target = d.target !== null ? sim.ships.get(d.target) : undefined;
    if (!target || target.gone || target.state.mode !== FlightMode.Normal || target.state.anchor !== o.anchor) continue;
    const speed = v3.len(o.vel);
    if (!(speed > 1e-3)) continue;
    const cur = v3.scale(o.vel, 1 / speed);
    const to = v3.sub(target.state.pos, o.pos);
    // Aim at where the target will be when the missile gets there (capped so a far target does not mislead it).
    const lead = v3.addScaled(to, target.state.vel, Math.min(v3.len(to) / d.speed, 3));
    const want = v3.normalize(lead);
    if (v3.lenSq(want) === 0) continue;
    const cos = Math.max(-1, Math.min(1, v3.dot(cur, want)));
    const maxTurn = MISSILE_TURN * dt;
    let dir: Vec3;
    if (Math.acos(cos) <= maxTurn) {
      dir = want;
    } else {
      // Rotate the heading toward the wanted direction by the turn limit.
      let perp = v3.addScaled(want, cur, -cos);
      let pl = v3.len(perp);
      if (pl < 1e-6) {
        perp = v3.cross(cur, Math.abs(cur[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
        pl = v3.len(perp);
      }
      dir = v3.normalize(v3.addScaled(v3.scale(cur, Math.cos(maxTurn)), perp, Math.sin(maxTurn) / pl));
    }
    o.vel = v3.scale(dir, d.speed);
    o.rot = quat.lookRotation(dir);
  }
}
