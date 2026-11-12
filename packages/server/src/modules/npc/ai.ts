/**
 * NPC pilots: what a ship wants (decided a few times per second) and how it flies there (inputs
 * set every tick). NPCs fly through the same inputs as players, so they obey the same physics.
 */
import {
  Button,
  FlightMode,
  findSite,
  forwardOf,
  quat,
  v3,
  type AsteroidDef,
  type NpcRole,
  type Rng,
  type ShipStats,
  type SiteDef,
  type Vec3,
} from '@primacy2/shared';
import type { Ship } from '../../game.ts';
import type { SystemSim } from '../../sim.ts';

/** Decisions are taken every this many ticks, staggered by ship id. */
export const THINK_EVERY = 5;
/** Largest aim change requested per tick, radians. */
const MAX_AIM_STEP = 0.08;
/** Hostiles are noticed within this distance, metres. */
const ACQUIRE_RANGE = 8_000;
/** Pirates turn on a patrol that comes this close, metres. */
const PATROL_ALERT_RANGE = 4_000;
/** NPCs do not stray farther than this from the centre of their site, metres. */
const LEASH = 15_000;
/** Weapons are held on the trigger while the target is this close to the nose. */
const COS_FIRE = Math.cos((4 * Math.PI) / 180);
/** Fighters run for good below this hull fraction. */
const FLEE_HULL = 0.25;
/** A hit keeps a ship alarmed for this long, seconds. */
const ALARM_SECONDS = 20;
/** A target that dropped off the sensors is hunted where it was last seen for this long, seconds. */
export const LOSE_TARGET_AFTER = 4;
/** Within this distance of its goal a ship has arrived, metres. */
const ARRIVE = 200;
/** Ships slow down over this distance before their goal, metres. */
const SLOW_DIST = 1_500;
const CRUISE = 0.6;

type Mode = 'wander' | 'attack' | 'evade' | 'flee';

/** AI state of one NPC ship, kept in `ship.brain`. */
export class NpcBrain {
  /** Credits paid to a pilot who destroys this ship (pirates). Read by the combat module. */
  bounty = 0;
  mode: Mode = 'wander';
  /** Waypoint relative to the zone anchor. */
  goal: Vec3 = [0, 0, 0];
  hasGoal = false;
  /** Universe time until which the ship stays at its waypoint; 0 while under way. */
  holdUntil = 0;
  /** Universe time after which an unreached waypoint is given up. */
  goalDeadline = 0;
  /** Unit direction the nose should point along. */
  dir: Vec3 = [0, 0, -1];
  /** Forward speed setpoint as a fraction of top speed; negative backs off. */
  speed = 0;
  /** Brake and boost buttons chosen by the last decision. */
  buttons = 0;
  /** True while the ship steers around a rock or a structure. */
  avoiding = false;
  /** The ship has run away and should be taken out of the simulation. */
  leave = false;
  /** Universe time until which the trigger may be held, and until which it then rests. */
  fireUntil = 0;
  restUntil = 0;
  /** Universe time the target was last picked up by the sensors, and where it was then. */
  seenAt = -Infinity;
  seenPos: Vec3 = [0, 0, 0];
  /** Reach of the primary and secondary weapons, metres; 0 without any. */
  readonly range1: number;
  readonly range2: number;

  constructor(
    readonly role: NpcRole,
    /** Anchor id of the zone the ship belongs to. */
    readonly zone: number,
    stats: ShipStats,
  ) {
    let r1 = 0;
    let r2 = 0;
    for (const w of stats.weapons) {
      if (w.group === 1) r1 = Math.max(r1, w.range);
      else if (w.group === 2) r2 = Math.max(r2, w.range);
    }
    this.range1 = r1;
    this.range2 = r2;
  }
}

const clampTo = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

const isField = (site: SiteDef): boolean => site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly';

/** Distance NPCs keep from the structure at the centre of a site, metres. */
export function clearanceOf(site: SiteDef | undefined): number {
  if (!site) return 0;
  return site.kind === 'station' ? 900 : site.kind === 'outpost' ? 600 : site.model ? 400 : 0;
}

/** A live ship in the same zone, by id. */
function shipInZone(sim: SystemSim, id: number | null, zone: number): Ship | null {
  if (id === null) return null;
  const o = sim.ships.get(id);
  return o && !o.gone && o.state.mode === FlightMode.Normal && o.state.anchor === zone ? o : null;
}

/** Whoever shot this ship recently, else the ship it is fighting. */
function threatOf(sim: SystemSim, ship: Ship, t: number): Ship | null {
  if (t - ship.lastHitAt < ALARM_SECONDS) {
    const attacker = shipInZone(sim, ship.lastHitBy, ship.state.anchor);
    if (attacker && attacker !== ship) return attacker;
  }
  const target = shipInZone(sim, ship.target, ship.state.anchor);
  return target !== ship ? target : null;
}

/**
 * The ship a fighter should engage: whoever attacked it, otherwise the nearest prey within
 * sensor reach. Pirates hunt pilots (laden ones first) and traders; patrols hunt the wanted.
 */
function pickTarget(sim: SystemSim, ship: Ship, b: NpcBrain, t: number): Ship | null {
  const pos = ship.state.pos;
  let best: Ship | null = null;
  let bestScore = Infinity;
  for (const o of sim.shipsInZone(ship.state.anchor)) {
    if (o === ship || o.gone || o.state.mode !== FlightMode.Normal) continue;
    const d = v3.dist(o.state.pos, pos);
    if (d > ACQUIRE_RANGE) continue;
    // Only what the sensors pick up can be hunted; a ship running silent slips through.
    if (!sim.detects(ship, o, o.id === ship.target)) continue;
    let bias = 0;
    if (o.id === ship.lastHitBy && t - ship.lastHitAt < ALARM_SECONDS) bias = -4_000;
    else if (b.role === 'pirate') {
      if (o.player) bias = o.cargo.length > 0 ? -3_000 : -500;
      // A patrol that comes close is fought rather than waited for; prey is still preferred.
      else if (o.npc === 'security') {
        if (d > PATROL_ALERT_RANGE) continue;
        bias = 500;
      } else if (o.npc !== 'trader') continue;
    } else if (!(o.wanted || o.npc === 'pirate')) continue;
    // Stay on the current target unless another is clearly the better choice.
    const score = d + bias - (o.id === ship.target ? 1_500 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

/**
 * Direction that leads around a sphere when flying along `dir` from `pos` would enter it within
 * `look` metres, or null when the way is clear. Inside the sphere the way out wins.
 */
function avoidSphere(pos: Readonly<Vec3>, dir: Readonly<Vec3>, c: Readonly<Vec3>, r: number, look: number): Vec3 | null {
  const toC = v3.sub(c, pos);
  const d2 = v3.lenSq(toC);
  if (d2 < r * r) {
    const out: Vec3 = d2 > 1e-6 ? v3.scale(toC, -1 / Math.sqrt(d2)) : [0, 1, 0];
    return v3.normalize(v3.addScaled(out, dir, 0.3));
  }
  const along = v3.dot(toC, dir);
  if (along <= 0 || along > look + r) return null;
  // From the closest point of the path to the centre of the sphere.
  const perp = v3.addScaled(toC, dir, -along);
  const miss = v3.len(perp);
  if (miss >= r) return null;
  let side: Vec3;
  if (miss > 1e-3) side = v3.scale(perp, -1 / miss);
  else side = v3.normalize(v3.cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const via = v3.addScaled(c, side, r * 1.15);
  const out = v3.normalize(v3.sub(via, pos));
  return v3.lenSq(out) > 0 ? out : null;
}

/** Like `avoidSphere` for the nearest asteroid in the way; `margin` is added to every rock. */
function avoidRocks(pos: Readonly<Vec3>, dir: Readonly<Vec3>, rocks: readonly AsteroidDef[], margin: number, look: number): Vec3 | null {
  let nearest: AsteroidDef | null = null;
  let nearestAlong = Infinity;
  for (const a of rocks) {
    const r = a.radius + margin;
    const reach = look + r;
    const x = a.pos[0] - pos[0];
    if (x > reach || x < -reach) continue;
    const y = a.pos[1] - pos[1];
    if (y > reach || y < -reach) continue;
    const z = a.pos[2] - pos[2];
    if (z > reach || z < -reach) continue;
    const d2 = x * x + y * y + z * z;
    if (d2 < r * r) {
      nearest = a;
      break;
    }
    const along = x * dir[0] + y * dir[1] + z * dir[2];
    if (along <= 0 || along > reach || along >= nearestAlong) continue;
    if (d2 - along * along < r * r) {
      nearest = a;
      nearestAlong = along;
    }
  }
  return nearest ? avoidSphere(pos, dir, nearest.pos, nearest.radius + margin, look) : null;
}

/** Chooses the next waypoint of a ship with nothing urgent to do. */
function nextWaypoint(ship: Ship, b: NpcBrain, rng: Rng, site: SiteDef | undefined, rocks: readonly AsteroidDef[] | null): void {
  b.hasGoal = true;
  b.holdUntil = 0;
  if (b.role === 'miner' && rocks && rocks.length > 0) {
    // A rock close enough to the centre of the field to work on.
    for (let i = 0; i < 6; i++) {
      const rock = rocks[Math.floor(rng.float() * rocks.length) % rocks.length]!;
      if (v3.lenSq(rock.pos) > 12_000 * 12_000) continue;
      b.goal = v3.addScaled(rock.pos, rng.unitVector(), rock.radius + ship.stats.radius + 150);
      return;
    }
  }
  const inner = clearanceOf(site) + 600;
  b.goal = v3.scale(rng.unitVector(), rng.range(inner, 9_000));
}

/** Takes the ship's decision: what it is doing, where its nose should point and how fast to go. */
export function think(sim: SystemSim, ship: Ship, b: NpcBrain, t: number): void {
  const s = ship.state;
  const stats = ship.stats;
  const rng = sim.world.random();
  const site = findSite(sim.def, s.anchor);
  const rocks = site && isField(site) ? sim.asteroids(site.id) : null;
  const threat = threatOf(sim, ship, t);
  let target: Ship | null = null;
  /** The target is off the sensors and is being looked for where it was last seen. */
  let lost = false;

  if (b.role === 'pirate' || b.role === 'security') {
    const shield = stats.shieldMax > 0 ? s.shield / stats.shieldMax : 1;
    if (s.hull < stats.hullMax * FLEE_HULL) b.mode = 'flee';
    // Break off when the shields are gone and come back once they are half restored.
    else if (threat && (shield <= 0 || (b.mode === 'evade' && shield < 0.5))) b.mode = 'evade';
    else {
      target = pickTarget(sim, ship, b, t);
      if (target) {
        b.seenAt = t;
        b.seenPos = v3.clone(target.state.pos);
      } else {
        // A target that went dark is not forgotten at once: head for where it was last seen.
        const old = shipInZone(sim, ship.target, s.anchor);
        if (old && t - b.seenAt < LOSE_TARGET_AFTER && !sim.detects(ship, old, true)) {
          target = old;
          lost = true;
        }
      }
      b.mode = target ? 'attack' : 'wander';
    }
  } else {
    b.mode = threat ? 'flee' : 'wander';
  }

  let dest: Readonly<Vec3>;
  let speed = CRUISE;
  let buttons = 0;
  if (b.mode === 'attack' && target) {
    ship.target = target.id;
    dest = lost ? b.seenPos : target.state.pos;
    const dist = v3.dist(dest, s.pos);
    const reach = stats.radius + target.stats.radius;
    const standoff = Math.max(reach + 250, b.range1 * 0.25);
    // Close in fast, hold the range, and back off before ramming.
    speed = dist > standoff * 2 ? 1 : dist > standoff ? 0.5 : dist > reach + 120 ? 0.1 : -0.4;
    // Fire in bursts with pauses: sustained perfect fire would end every fight in two seconds.
    if (t >= b.restUntil) {
      b.fireUntil = t + rng.range(0.8, 1.6);
      b.restUntil = b.fireUntil + rng.range(0.7, 1.6);
    }
  } else {
    if (b.mode !== 'evade') ship.target = null;
    if (b.mode === 'wander') {
      const arrived = b.hasGoal && v3.distSq(s.pos, b.goal) < ARRIVE * ARRIVE;
      if (arrived && b.holdUntil === 0) b.holdUntil = t + (b.role === 'miner' ? rng.range(20, 60) : rng.range(2, 10));
      if (!b.hasGoal || (b.holdUntil > 0 && t >= b.holdUntil) || t > b.goalDeadline) {
        nextWaypoint(ship, b, rng, site, rocks);
        b.goalDeadline = t + 180;
      }
    } else {
      // Run from the threat, or straight out when nobody is chasing, but stay inside the site.
      let away = threat ? v3.sub(s.pos, threat.state.pos) : v3.clone(s.pos);
      if (v3.lenSq(away) < 1) away = forwardOf(s.rot);
      let to = v3.addScaled(s.pos, v3.normalize(away), 4_000);
      if (v3.lenSq(to) > LEASH * LEASH) to = v3.scale(v3.normalize(to), LEASH);
      b.goal = to;
      b.hasGoal = false;
      speed = 1;
      buttons |= Button.Boost;
      if (b.mode === 'flee') {
        // A beaten ship that got away leaves the area.
        if (v3.lenSq(s.pos) > (LEASH - 1_500) ** 2 && t - ship.lastHitAt > ALARM_SECONDS) b.leave = true;
      }
    }
    dest = b.goal;
    const dist = v3.dist(dest, s.pos);
    if (dist < ARRIVE) {
      speed = 0;
      buttons |= Button.Brake;
    } else if (dist < SLOW_DIST) {
      speed *= Math.max(dist / SLOW_DIST, 0.12);
    }
  }

  const to = v3.sub(dest, s.pos);
  const dist = v3.len(to);
  const dir = dist > 1 ? v3.scale(to, 1 / dist) : b.dir;
  const look = clampTo(v3.len(s.vel) * 5, 300, 1_500);
  const clearance = clearanceOf(site);
  let around: Vec3 | null = null;
  if (clearance > 0) around = avoidSphere(s.pos, dir, [0, 0, 0], clearance + stats.radius, look);
  if (!around && rocks) around = avoidRocks(s.pos, dir, rocks, stats.radius + 40, look);
  b.avoiding = around !== null;
  if (around) {
    // Getting clear comes first: keep moving, and never brake to a halt inside a keep-out zone.
    speed = Math.max(speed, 0.35);
    buttons &= ~Button.Brake;
  }
  b.dir = around ?? dir;
  b.speed = speed;
  b.buttons = buttons;
}

/** Turns the last decision into this tick's input: aim deltas, forward thrust and triggers. */
export function steer(sim: SystemSim, ship: Ship, b: NpcBrain): void {
  const s = ship.state;
  const inp = ship.input;
  let dir: Readonly<Vec3> = b.dir;
  let buttons = b.buttons;

  if (b.mode === 'attack') {
    const target = shipInZone(sim, ship.target, s.anchor);
    // Tracking and gunnery need the target on the sensors; without it the ship keeps flying
    // toward the last known position chosen by `think`.
    if (target && sim.detects(ship, target, true)) {
      b.seenAt = sim.time;
      b.seenPos[0] = target.state.pos[0];
      b.seenPos[1] = target.state.pos[1];
      b.seenPos[2] = target.state.pos[2];
      const to = v3.sub(target.state.pos, s.pos);
      const dist = v3.len(to);
      if (dist > 1) {
        const toN = v3.scale(to, 1 / dist);
        // Track the target every tick; decisions are too coarse for gunnery.
        if (!b.avoiding) dir = toN;
        if (sim.time < b.fireUntil && v3.dot(forwardOf(s.rot), toN) >= COS_FIRE) {
          if (dist <= b.range1) buttons |= Button.Fire1;
          if (dist <= b.range2) buttons |= Button.Fire2;
        }
      }
    }
  }

  // The wanted direction in ship axes: -Z is ahead, +X right, +Y up.
  const local = quat.unrotate(s.rot, dir);
  const yaw = Math.atan2(local[0], -local[2]);
  const pitch = Math.atan2(local[1], Math.hypot(local[0], local[2]));
  // The ship works a pending aim buffer off by itself; only ask for what is still missing.
  inp.aim[0] = clampTo(yaw - s.aim[0], -MAX_AIM_STEP, MAX_AIM_STEP);
  inp.aim[1] = clampTo(pitch - s.aim[1], -MAX_AIM_STEP, MAX_AIM_STEP);
  inp.roll = 0;

  // Thrust along the nose only once it points roughly the right way; backing off needs no aim.
  const aligned = -local[2];
  const forward = b.speed <= 0 ? b.speed : aligned > 0.9 ? b.speed : aligned > 0.5 ? b.speed * 0.35 : 0;
  inp.thrust[0] = 0;
  inp.thrust[1] = 0;
  inp.thrust[2] = forward;
  inp.throttle = 0;
  inp.buttons = buttons;
}
