/**
 * Authoritative simulation of one star system: ships, floating objects, zones, collisions,
 * environmental hazards and the snapshots sent to the pilots in it.
 */
import {
  Button,
  ChargeKind,
  EntityFlag,
  EntityKind,
  FOLD_TUNNEL_TIME,
  FlightMode,
  OVERHEAT_DAMAGE,
  SNAPSHOT_EVERY,
  STRUCTURES,
  TIDAL_DAMAGE_THRESHOLD,
  ZONE_VIEW_RADIUS,
  absolutePosition,
  accelerationAt,
  buildStepEnv,
  canDetect,
  canEngageCruise,
  collideStructure,
  disengageCruise,
  encodeSnapshot,
  engageCruise,
  findSite,
  generateAsteroids,
  hazardsAt,
  isSurfaceAnchor,
  shieldDamageMul,
  simulateShip,
  terrainHeight,
  v3,
  type AsteroidDef,
  type EntityInfo,
  type GameEvent,
  type SnapshotEntity,
  type StepEnv,
  type StructureDef,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import { CRUISE_ZONE, NO_ZONE, inSpace, type Player, type Ship, type SimObject } from './game.ts';
import { CRASH_CREDIT_SECONDS, IMPACT_EPISODE, collideBase, impactFraction, padPose, zoneSurface } from './ground.ts';
import type { World } from './world.ts';

const INPUT_QUEUE_MAX = 5;

export interface DamageOptions {
  by?: Ship | null;
  shieldMul?: number;
  hullMul?: number;
  /** Skip shields entirely (heat, tidal forces, collisions with terrain). */
  bypassShield?: boolean;
  /** Impact point relative to the zone anchor, for effects. Defaults to the ship position. */
  at?: Vec3;
  /** Do not emit a hit event (continuous environmental damage). */
  silent?: boolean;
}

export class SystemSim {
  readonly ships = new Map<number, Ship>();
  readonly objects = new Map<number, SimObject>();
  readonly players = new Set<Player>();
  /** Remaining ore fraction (0..1) per asteroid, per site id. Absent means untouched. */
  readonly asteroidLeft = new Map<number, Float32Array>();
  tickCount = 0;
  /** Universe time the current ship states belong to: the end of the tick being processed. */
  time = 0;
  /** Consecutive ticks without any pilot; the world drops the simulation when this grows large. */
  idleTicks = 0;

  private readonly asteroidCache = new Map<number, AsteroidDef[]>();
  private readonly zones = new Map<number, Ship[]>();
  private readonly events = new Map<number, GameEvent[]>();
  private readonly absCache = new Map<number, Vec3>();
  /**
   * Per ship: the share of its hull that recent ground impacts have cost and are still
   * remembered (they fade with IMPACT_EPISODE), and the universe time of the last one.
   */
  private readonly groundHits = new WeakMap<Ship, { paid: number; at: number }>();

  constructor(
    readonly world: World,
    readonly def: SystemDef,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Queries used by modules
  // -------------------------------------------------------------------------------------------

  /**
   * The zone a ship is in: the anchor of a ship in normal flight or standing on the ground (a
   * surface frame is a zone of its own), the cruise layer for a ship in cruise, none otherwise.
   */
  zoneOf(ship: Ship): number {
    const m = ship.state.mode;
    return inSpace(ship.state) ? ship.state.anchor : m === FlightMode.Cruise ? CRUISE_ZONE : NO_ZONE;
  }

  /** Ships currently in a zone. The array is owned by the simulation; do not keep or mutate it. */
  shipsInZone(zone: number): readonly Ship[] {
    return this.zones.get(zone) ?? [];
  }

  /** Anchor ids of all normal-space zones that currently contain at least one ship. */
  activeZones(): number[] {
    return [...this.zones.keys()].filter((z) => z >= 0);
  }

  /** Whether any pilot (not NPC) is in the zone. */
  zoneHasPlayers(zone: number): boolean {
    return this.shipsInZone(zone).some((s) => s.player !== null);
  }

  /** The asteroid field of a mining site (cached). Empty for other sites. */
  asteroids(siteId: number): readonly AsteroidDef[] {
    let list = this.asteroidCache.get(siteId);
    if (!list) {
      const site = findSite(this.def, siteId);
      list = site ? generateAsteroids(this.def, site) : [];
      this.asteroidCache.set(siteId, list);
    }
    return list;
  }

  /** Queues an event for every pilot in a zone; delivered with the next snapshot. */
  emit(zone: number, ev: GameEvent): void {
    if (zone === NO_ZONE) return;
    let list = this.events.get(zone);
    if (!list) this.events.set(zone, (list = []));
    if (list.length < 400) list.push(ev);
  }

  /** Barycentric position of a ship, cached for the current tick. */
  absPos(ship: Ship): Vec3 {
    let p = this.absCache.get(ship.id);
    if (!p) {
      p = absolutePosition(ship.state, this.def, this.time);
      this.absCache.set(ship.id, p);
    }
    return p;
  }

  /** Whether the pilots of two ships fly in the same wing (`World.wings`). */
  private sameWing(a: Ship, b: Ship): boolean {
    if (!a.player || !b.player) return false;
    const wing = this.world.wings.get(a.player.id);
    return wing !== undefined && wing === this.world.wings.get(b.player.id);
  }

  /**
   * Whether `observer` picks up `target` right now: by its heat signature on the observer's
   * sensors (`canDetect`), or because both fly in the same wing. Both ships must be in the same
   * zone. Pass `known` for a contact the observer already holds; it is kept a little farther out.
   */
  detects(observer: Ship, target: Ship, known = false): boolean {
    if (this.sameWing(observer, target)) return true;
    const dist = observer.state.mode === FlightMode.Cruise
      ? v3.dist(this.absPos(observer), this.absPos(target))
      : v3.dist(observer.state.pos, target.state.pos);
    return canDetect(observer.stats, dist, target.state.sig, known);
  }

  // -------------------------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------------------------

  addShip(ship: Ship): void {
    ship.gone = false;
    this.ships.set(ship.id, ship);
    if (ship.player) {
      this.players.add(ship.player);
      this.idleTicks = 0;
    }
  }

  removeShip(ship: Ship): void {
    ship.gone = true;
    this.ships.delete(ship.id);
    if (ship.player) this.players.delete(ship.player);
  }

  addObject(o: SimObject): void {
    this.objects.set(o.id, o);
  }

  removeObject(id: number): void {
    this.objects.delete(id);
  }

  /** Spawns a floating cargo canister in a zone. */
  spawnLoot(anchor: number, pos: Vec3, vel: Vec3, c: string, n: number, ttl = 600): SimObject {
    const id = this.world.allocId();
    const info: EntityInfo = { id, kind: EntityKind.Loot, name: c, model: 'cargo_pod', radius: 2, c, n };
    const o: SimObject = { id, kind: EntityKind.Loot, anchor, pos: v3.clone(pos), vel: v3.clone(vel), rot: [0, 0, 0, 1], radius: 2, info, ttl };
    this.addObject(o);
    return o;
  }

  // -------------------------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------------------------

  /** Applies damage to shields first, then hull, and destroys the ship when the hull is gone. */
  damage(ship: Ship, amount: number, opts: DamageOptions = {}): void {
    const s = ship.state;
    if (ship.gone || !(amount > 0) || (!inSpace(s) && s.mode !== FlightMode.Cruise)) return;
    const zone = this.zoneOf(ship);
    let left = amount;
    let total = 0;
    let onShield = false;
    if (!opts.bypassShield && s.shield > 0) {
      // Power to the shields (SYS) hardens them against every kind of hit.
      const mul = (opts.shieldMul ?? 1) * shieldDamageMul(s.pips);
      const absorbed = Math.min(s.shield, left * mul);
      s.shield -= absorbed;
      total += absorbed;
      left -= mul > 0 ? absorbed / mul : left;
      onShield = true;
    }
    if (left > 1e-9) {
      const d = left * (opts.hullMul ?? 1);
      s.hull -= d;
      total += d;
      onShield = false;
    }
    s.shieldDelay = ship.stats.shieldDelay;
    if (opts.by) {
      ship.lastHitBy = opts.by.id;
      ship.lastHitAt = this.time;
    }
    if (!opts.silent) {
      this.emit(zone, { e: 'hit', id: ship.id, by: opts.by?.id, dmg: Math.round(total * 10) / 10, shield: onShield, at: opts.at ?? v3.clone(s.pos) });
    }
    if (s.hull <= 0) this.destroy(ship, opts.by ?? null);
  }

  /** Destroys a ship. Pilots are left in `Dead` mode until they respawn; NPC ships are removed. */
  destroy(ship: Ship, by: Ship | null): void {
    if (ship.gone || ship.state.mode === FlightMode.Dead) return;
    const zone = this.zoneOf(ship);
    this.emit(zone, { e: 'destroyed', id: ship.id, by: by?.id, at: v3.clone(ship.state.pos) });
    ship.state.hull = 0;
    ship.state.shield = 0;
    for (const m of this.world.modules) m.onShipDestroyed?.(this, ship, by);
    if (ship.player) {
      const p = ship.player;
      ship.state.mode = FlightMode.Dead;
      ship.state.vel = [0, 0, 0];
      ship.state.chargeKind = ChargeKind.None;
      ship.state.charge = 0;
      ship.fold = null;
      p.rec.passport.stats.deaths++;
      p.rec.passport.ship.cargo.length = 0;
      // The pilot's own client is told directly: a dead ship is in no zone.
      p.send({ t: 'ev', e: [{ e: 'destroyed', id: ship.id, by: by?.id, at: v3.clone(ship.state.pos) }] });
      this.world.pushPilot(p);
    } else {
      this.removeShip(ship);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------------------------

  tick(t: number, dt: number): void {
    this.tickCount++;
    this.time = t;
    this.absCache.clear();
    this.idleTicks = this.players.size > 0 ? 0 : this.idleTicks + 1;

    this.takeInputs();
    this.rebuildZones();
    for (const m of this.world.modules) m.preStep?.(this, t, dt);

    for (const ship of [...this.ships.values()]) {
      if (ship.gone) continue;
      const s = ship.state;
      ship.flags = 0;
      if (inSpace(s) || s.mode === FlightMode.Cruise) {
        // States belong to t - dt before the step and to t after it.
        const env = simulateShip(s, ship.input, ship.stats, this.def, t - dt, dt);
        // NPC traffic stays out of surface frames: one that strays below the height where the
        // shared step moves ships into the frame of the ground has left its area and is taken out.
        if (ship.npc !== null && isSurfaceAnchor(s.anchor)) {
          this.removeShip(ship);
          continue;
        }
        if (env.cruiseDrop) this.cruiseDropped(ship);
        if ((env.impact ?? 0) > 0) this.groundImpact(ship, env.impact!, t);
        if (ship.gone || s.mode === FlightMode.Dead) continue;
        if (s.mode === FlightMode.Landed && s.chargeKind !== ChargeKind.None) {
          // A drive cannot charge on the ground: touching down ends a charge in progress.
          s.chargeKind = ChargeKind.None;
          s.charge = 0;
          ship.fold = null;
          ship.player?.notice('info', 'charge_landed', 'Drive charge cancelled: the ship has landed.');
        }
        ship.hazards = hazardsAt(env, s, ship.stats);
        this.applyHazards(ship, t, dt);
        if (!ship.gone && s.chargeKind !== ChargeKind.None && s.charge >= 1) this.completeCharge(ship, t);
        this.setFlags(ship);
      } else {
        // Docked, destroyed or in a fold tunnel: not in space, so there is nothing to detect.
        s.sig = 0;
        if (s.mode === FlightMode.Fold) {
          ship.tunnel -= dt;
          if (ship.tunnel <= 0) this.world.arriveFromFold(ship, this);
        }
      }
    }

    this.absCache.clear();
    this.rebuildZones();
    this.collide();
    this.stepObjects(dt);
    for (const m of this.world.modules) m.postStep?.(this, t, dt);

    if (this.tickCount % 30 === 0) {
      for (const m of this.world.modules) m.slowTick?.(this, t);
      for (const p of this.players) p.refillNotices();
    }
    if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots(t);
  }

  private takeInputs(): void {
    for (const p of this.players) {
      const ship = p.ship;
      if (!ship) continue;
      // Never apply more than one input per tick (that would be a speed hack); when the client
      // runs ahead, fold the oldest inputs into the next one so mouse movement is not lost.
      while (p.inputs.length > INPUT_QUEUE_MAX) {
        const dropped = p.inputs.shift()!;
        const next = p.inputs[0]!;
        next.aim[0] += dropped.aim[0];
        next.aim[1] += dropped.aim[1];
      }
      const next = p.inputs.shift();
      if (next) {
        ship.input = next;
        p.ackSeq = next.seq;
      } else {
        // No fresh input: keep the held keys but do not repeat the mouse movement.
        ship.input = { ...ship.input, aim: [0, 0] };
      }
    }
  }

  private rebuildZones(): void {
    this.zones.clear();
    for (const ship of this.ships.values()) {
      const z = this.zoneOf(ship);
      if (z === NO_ZONE) continue;
      let list = this.zones.get(z);
      if (!list) this.zones.set(z, (list = []));
      list.push(ship);
    }
  }

  /** Cruise ended because the ship came below the cruise ceiling of a landable body (no harm done). */
  private cruiseDropped(ship: Ship): void {
    const s = ship.state;
    this.emit(CRUISE_ZONE, { e: 'cruise', id: ship.id, on: false, at: [0, 0, 0] });
    this.emit(s.anchor, { e: 'cruise', id: ship.id, on: false, at: v3.clone(s.pos) });
    ship.player?.notice('info', 'cruise_ceiling', 'Cruise ended: below the cruise ceiling.');
  }

  /**
   * A ship hit the ground `impact` m/s harder than a landing allows. The hull takes the damage
   * directly (see `impactFraction` for the rule). A contact is charged for what it adds to the
   * share of earlier ones that is still remembered, so a scrape of many weakening contacts costs
   * once and repeated slams cost again as the memory of the last one fades.
   */
  private groundImpact(ship: Ship, impact: number, t: number): void {
    const s = ship.state;
    let hit = this.groundHits.get(ship);
    if (!hit) this.groundHits.set(ship, (hit = { paid: 0, at: t }));
    if (t > hit.at) hit.paid *= Math.exp(-(t - hit.at) / IMPACT_EPISODE);
    hit.at = t;
    const share = impactFraction(ship.stats, impact);
    if (share <= hit.paid) return;
    const amount = (share - hit.paid) * ship.stats.hullMax;
    hit.paid = share;
    // The contact point is under the ship, a belly's height toward the body centre.
    const r = v3.len(s.pos);
    const at = r > 0 ? v3.scale(s.pos, 1 - ship.stats.belly / r) : v3.clone(s.pos);
    if (s.hull <= amount) ship.player?.notice('danger', 'crash', 'Crashed into the ground.');
    // Whoever hit the ship a moment ago gets the credit if the ground finishes it.
    const hunter = ship.lastHitBy !== null && t - ship.lastHitAt <= CRASH_CREDIT_SECONDS ? this.ships.get(ship.lastHitBy) : undefined;
    this.damage(ship, amount, { bypassShield: true, at, by: hunter && !hunter.gone ? hunter : null });
  }

  private setFlags(ship: Ship): void {
    const s = ship.state;
    const i = ship.input;
    if (s.mode === FlightMode.Landed) {
      // Standing on the ground: nothing burns and nothing fires, whatever keys are held.
      ship.flags = EntityFlag.Landed | (ship.wanted ? EntityFlag.Wanted : 0);
      return;
    }
    let f = 0;
    if (Math.abs(i.thrust[0]) + Math.abs(i.thrust[1]) + Math.abs(i.thrust[2]) > 0.1 || Math.abs(s.throttle) > 0.05) f |= EntityFlag.Thrust;
    if (s.boost > 0) f |= EntityFlag.Boost;
    if (s.chargeKind !== ChargeKind.None) f |= EntityFlag.Charging;
    if (s.mode === FlightMode.Cruise) f |= EntityFlag.Cruise;
    if (ship.wanted) f |= EntityFlag.Wanted;
    if (i.buttons & (Button.Fire1 | Button.Fire2)) f |= EntityFlag.Firing;
    ship.flags = f;
  }

  private applyHazards(ship: Ship, t: number, dt: number): void {
    const h = ship.hazards!;
    const s = ship.state;
    if (h.lethal) {
      ship.player?.notice('danger', 'crushed', 'Crushed by tidal forces.');
      this.destroy(ship, null);
      return;
    }
    if (h.insideBody >= 0) {
      if (s.mode !== FlightMode.Cruise) {
        ship.player?.notice('danger', 'impact', 'Collided with a celestial body.');
        this.destroy(ship, null);
        return;
      }
      // Cruising into a body: the drive fails just above the surface and the hull takes the shock.
      const body = this.def.bodies[h.insideBody]!;
      const zoneBefore = this.zoneOf(ship);
      disengageCruise(s, this.def, t);
      if (s.anchor === body.id) {
        const dir = v3.lenSq(s.pos) > 0 ? v3.normalize(s.pos) : ([0, 1, 0] as Vec3);
        s.pos = v3.scale(dir, body.radius * 1.08);
      }
      s.vel = [0, 0, 0];
      this.emit(zoneBefore, { e: 'cruise', id: ship.id, on: false, at: v3.clone(s.pos) });
      ship.player?.notice('danger', 'emergency_drop', 'Emergency drop: too close to a body.');
      this.damage(ship, ship.stats.hullMax * 0.25, { bypassShield: true });
      return;
    }
    if (h.tidal > TIDAL_DAMAGE_THRESHOLD) {
      this.damage(ship, (h.tidal - TIDAL_DAMAGE_THRESHOLD) * 0.6 * dt, { bypassShield: true, silent: true });
    }
    if (!ship.gone && s.heat > ship.stats.heatCap) {
      this.damage(ship, (s.heat - ship.stats.heatCap) * OVERHEAT_DAMAGE * dt, { bypassShield: true, silent: true });
    }
  }

  private completeCharge(ship: Ship, t: number): void {
    const s = ship.state;
    const kind = s.chargeKind;
    s.chargeKind = ChargeKind.None;
    s.charge = 0;
    if (kind === ChargeKind.Cruise) {
      if (s.mode !== FlightMode.Normal) return;
      const can = canEngageCruise(s, this.def, t);
      if (!can.ok) {
        ship.player?.notice(
          'warn', 'cruise_' + can.reason,
          can.reason === 'masslock' ? 'Mass-locked: move away from the structure.'
            : can.reason === 'ground' ? 'Too close to the ground: climb above the cruise ceiling.'
            : 'Cruise unavailable.',
        );
        return;
      }
      this.emit(this.zoneOf(ship), { e: 'cruise', id: ship.id, on: true, at: v3.clone(s.pos) });
      engageCruise(s, this.def, t);
    } else if (kind === ChargeKind.Fold) {
      this.world.startFold(ship, this);
    }
  }

  private collide(): void {
    for (const [zone, ships] of this.zones) {
      if (zone < 0) continue;
      const site = findSite(this.def, zone);
      const structure = site?.model && Object.hasOwn(STRUCTURES, site.model) ? STRUCTURES[site.model]! : null;
      const rocks = site && (site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly') ? this.asteroids(site.id) : null;
      // In a surface zone the ground bases of the body stand somewhere on the ground.
      const bases = zoneSurface(this.def, zone)?.sites ?? null;

      for (const ship of ships) {
        if (ship.gone) continue;
        // A ship standing on the ground is not moved by anything: the flight step does not look
        // at the terrain again until it lifts off.
        if (ship.state.mode === FlightMode.Landed) continue;
        if (structure && v3.lenSq(ship.state.pos) < (structure.bound + ship.stats.radius) ** 2) this.bounceOffStructure(ship, structure);
        if (bases) {
          for (const base of bases) {
            const hit = collideBase(padPose(base), ship.state.pos, ship.stats.radius);
            if (!hit) continue;
            v3.addScaledIn(ship.state.pos, hit.normal, hit.depth + 0.05);
            this.reflect(ship, hit.normal, v3.addScaled(ship.state.pos, hit.normal, -ship.stats.radius));
            if (ship.gone) break;
          }
          if (ship.gone) continue;
        }
        if (rocks) {
          const p = ship.state.pos;
          const r = ship.stats.radius;
          for (const a of rocks) {
            const reach = a.radius + r;
            const dx = p[0] - a.pos[0];
            if (dx > reach || dx < -reach) continue;
            const dy = p[1] - a.pos[1];
            if (dy > reach || dy < -reach) continue;
            const dz = p[2] - a.pos[2];
            if (dx * dx + dy * dy + dz * dz < reach * reach) {
              this.bounceOffSphere(ship, a.pos, a.radius);
              if (ship.gone) break;
            }
          }
        }
      }

      for (let i = 0; i < ships.length; i++) {
        const a = ships[i]!;
        if (a.gone) continue;
        for (let j = i + 1; j < ships.length; j++) {
          const b = ships[j]!;
          if (b.gone) continue;
          const reach = a.stats.radius + b.stats.radius;
          const d = v3.sub(b.state.pos, a.state.pos);
          const distSq = v3.lenSq(d);
          if (distSq >= reach * reach || distSq === 0) continue;
          const dist = Math.sqrt(distSq);
          const n = v3.scale(d, 1 / dist);
          const rel = v3.dot(v3.sub(b.state.vel, a.state.vel), n);
          const ma = a.stats.mass;
          const mb = b.stats.mass;
          // A ship standing on the ground does not give way: the other one takes the whole push
          // and bounce. Both still take the damage of the collision.
          const ia = a.state.mode === FlightMode.Landed ? 0 : 1 / ma;
          const ib = b.state.mode === FlightMode.Landed ? 0 : 1 / mb;
          if (ia + ib === 0) continue;
          const overlap = reach - dist;
          v3.addScaledIn(a.state.pos, n, (-overlap * ia) / (ia + ib));
          v3.addScaledIn(b.state.pos, n, (overlap * ib) / (ia + ib));
          if (rel < 0) {
            const impulse = (-(1 + 0.4) * rel) / (ia + ib);
            v3.addScaledIn(a.state.vel, n, -impulse * ia);
            v3.addScaledIn(b.state.vel, n, impulse * ib);
            const speed = -rel;
            if (speed > 6) {
              const dmg = (speed - 6) ** 2 * 0.012;
              this.damage(a, (dmg * mb) / (ma + mb) * 2, { by: b.player ? b : null });
              this.damage(b, (dmg * ma) / (ma + mb) * 2, { by: a.player ? a : null });
            }
          }
        }
      }
    }
  }

  /** Pushes a ship out of a site structure, reflects its velocity and applies impact damage. */
  private bounceOffStructure(ship: Ship, def: StructureDef): void {
    const s = ship.state;
    const hit = collideStructure(def, s.pos, ship.stats.radius);
    if (!hit) return;
    v3.addScaledIn(s.pos, hit.normal, hit.depth + 0.05);
    this.reflect(ship, hit.normal, v3.addScaled(s.pos, hit.normal, -ship.stats.radius));
  }

  /** Pushes a ship out of a static sphere, reflects its velocity and applies impact damage. */
  private bounceOffSphere(ship: Ship, centre: Readonly<Vec3>, radius: number): void {
    const s = ship.state;
    const d = v3.sub(s.pos, centre);
    const reach = radius + ship.stats.radius;
    const distSq = v3.lenSq(d);
    if (distSq >= reach * reach) return;
    const dist = Math.sqrt(distSq);
    const n: Vec3 = dist > 1e-6 ? v3.scale(d, 1 / dist) : [0, 1, 0];
    s.pos = v3.addScaled(centre, n, reach + 0.05);
    this.reflect(ship, n, v3.addScaled(centre, n, radius));
  }

  /** Bounces a ship off a static surface with outward normal `n`; `at` is the contact point for effects. */
  private reflect(ship: Ship, n: Readonly<Vec3>, at: Vec3): void {
    const s = ship.state;
    const vn = v3.dot(s.vel, n);
    if (vn >= 0) return;
    v3.addScaledIn(s.vel, n, -(1 + 0.3) * vn);
    // Scraping along a surface bleeds off some tangential speed as well.
    s.vel = v3.scale(s.vel, 0.92);
    const speed = -vn;
    if (speed > 5) this.damage(ship, (speed - 5) ** 2 * 0.02, { at });
  }

  /**
   * Moves the floating objects. In space they drift on straight lines. In a surface zone they
   * fall under what a body in free fall feels there and stop where they meet the terrain: wrecks
   * and cargo pods come to rest, a missile goes off.
   */
  private stepObjects(dt: number): void {
    let envs: Map<number, StepEnv> | null = null;
    for (const o of this.objects.values()) {
      o.ttl -= dt;
      if (o.ttl <= 0) {
        this.objects.delete(o.id);
        continue;
      }
      const surface = zoneSurface(this.def, o.anchor);
      if (!surface) {
        v3.addScaledIn(o.pos, o.vel, dt);
        continue;
      }
      if (o.resting) continue;
      let env = (envs ??= new Map()).get(o.anchor);
      if (!env) envs.set(o.anchor, (env = buildStepEnv(this.def, o.anchor, this.time - dt)));
      v3.addScaledIn(o.vel, accelerationAt(env, o.pos, o.vel), dt);
      v3.addScaledIn(o.pos, o.vel, dt);

      // Above the highest ground of the body the terrain need not be asked.
      const belly = o.belly ?? o.radius;
      const r2 = v3.lenSq(o.pos);
      if (r2 >= (surface.top + belly) ** 2) continue;
      const r = Math.sqrt(r2);
      if (!(r > 0)) continue;
      const floor = surface.radius + terrainHeight(surface.terrain, o.pos[0] / r, o.pos[1] / r, o.pos[2] / r) + belly;
      if (r >= floor) continue;
      v3.copy(o.pos, v3.scale(o.pos, floor / r));
      if (o.kind === EntityKind.Missile) {
        // Shown to the pilots around as a hit on the ground where the missile went in.
        const dmg = (o.data as { dmg?: number } | undefined)?.dmg ?? 0;
        this.emit(o.anchor, { e: 'hit', id: o.id, dmg, shield: false, at: v3.clone(o.pos) });
        this.objects.delete(o.id);
        continue;
      }
      o.vel = [0, 0, 0];
      o.resting = true;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------------------------

  private shipInfo(ship: Ship): EntityInfo {
    const info: EntityInfo = { id: ship.id, kind: EntityKind.Ship, name: ship.name, model: ship.stats.hull, radius: ship.stats.radius };
    if (ship.player) {
      info.player = ship.player.id;
      if (ship.player.rec.passport.home !== this.world.id) info.home = ship.player.rec.passport.home;
    }
    if (ship.npc) info.npc = ship.npc;
    if (ship.faction) info.faction = ship.faction;
    return info;
  }

  private sendSnapshots(t: number): void {
    const viewSq = ZONE_VIEW_RADIUS * ZONE_VIEW_RADIUS;
    for (const p of this.players) {
      const me = p.ship;
      if (!me || !p.conn) continue;
      const zone = this.zoneOf(me);
      const ents: SnapshotEntity[] = [];
      const added: EntityInfo[] = [];
      const seen = new Set<number>();

      if (zone !== NO_ZONE) {
        const cruise = zone === CRUISE_ZONE;
        const origin = cruise ? this.absPos(me) : me.state.pos;
        for (const o of this.shipsInZone(zone)) {
          if (o === me || o.gone) continue;
          const rel = v3.sub(cruise ? this.absPos(o) : o.state.pos, origin);
          const distSq = v3.lenSq(rel);
          if (!cruise && distSq > viewSq) continue;
          // Another ship is a contact only while this pilot's sensors pick it up (or it is a wing
          // mate). Cargo pods, missiles and wrecks below are not subject to this.
          if (!this.sameWing(me, o) && !canDetect(me.stats, Math.sqrt(distSq), o.state.sig, p.known.has(o.id))) continue;
          seen.add(o.id);
          if (!p.known.has(o.id)) added.push(this.shipInfo(o));
          ents.push({
            id: o.id, flags: o.flags,
            hull: o.state.hull / o.stats.hullMax,
            shield: o.stats.shieldMax > 0 ? o.state.shield / o.stats.shieldMax : 0,
            pos: rel, vel: o.state.vel, rot: o.state.rot,
          });
        }
        if (!cruise) {
          for (const o of this.objects.values()) {
            if (o.anchor !== zone) continue;
            const rel = v3.sub(o.pos, origin);
            if (v3.lenSq(rel) > viewSq) continue;
            seen.add(o.id);
            if (!p.known.has(o.id)) added.push(o.info);
            // A wreck's hull value is the fraction of its contents still inside.
            const fill = o.kind === EntityKind.Wreck ? (o.data as { fill?: number } | undefined)?.fill : undefined;
            ents.push({ id: o.id, flags: 0, hull: fill ?? 1, shield: 0, pos: rel, vel: o.vel, rot: o.rot });
          }
        }
      }

      const removed: number[] = [];
      for (const id of p.known) if (!seen.has(id)) removed.push(id);
      for (const id of removed) p.known.delete(id);
      for (const e of added) p.known.add(e.id);
      if (added.length) p.send({ t: 'ent+', e: added });
      if (removed.length) p.send({ t: 'ent-', ids: removed });

      let evs = this.events.get(zone);
      // A surface zone is the whole shell around a body, hundreds or thousands of kilometres across.
      // An event that says where it happened (and who) goes only to pilots within view of it, so a
      // hit or a shot does not give away a ship on the other side of the moon.
      if (evs && isSurfaceAnchor(zone)) evs = evs.filter((ev) => !('at' in ev) || v3.distSq(ev.at, me.state.pos) <= viewSq);
      if (evs && evs.length) p.send({ t: 'ev', e: evs });

      p.conn.sendBinary(encodeSnapshot({ tick: this.world.tickCount, ackSeq: p.ackSeq, time: t, self: me.state, ents }));
    }
    this.events.clear();
  }
}

export { FOLD_TUNNEL_TIME };
