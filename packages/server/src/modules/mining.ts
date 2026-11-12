/**
 * Mining: lasers cut ore out of asteroids at belt, ring and anomaly sites. The ore floats out as
 * cargo canisters that any ship can scoop, so mining invites both cooperation and piracy.
 */
import { Button, EntityFlag, EntityKind, FlightMode, findSite, forwardOf, v3, weaponEnergyMul, type AsteroidDef, type GameEvent } from '@primacy2/shared';
import type { GameModule, Player, Ship } from '../game.ts';
import type { SystemSim } from '../sim.ts';

/** Tonnes of ore per second per point of mining laser power. */
const YIELD_PER_POWER = 0.012;
/** Floating canisters allowed per zone before ore goes straight into the hold. */
const MAX_PODS = 40;
/** Fraction of an asteroid's ore that grows back per hour. */
const REGROW_PER_HOUR = 0.25;
const SAVE_EVERY_S = 30;

interface Cut {
  /** Tonnes cut loose but not yet released as a canister. */
  buffer: number;
  /** Universe time of the last beam event sent for this ship. */
  lastEvent: number;
}

interface FieldDoc {
  /** Universe time the field was last saved. */
  t: number;
  left: number[];
}

const cuts = new WeakMap<Ship, Cut>();
/** Site whose depletion state each pilot has been sent. */
const synced = new WeakMap<Player, string>();
const dirty = new Map<string, number>();

const fieldKey = (sim: SystemSim, siteId: number): string => `${sim.def.id}/${siteId}`;

/** Remaining-ore array of a site, loaded from storage (with regrowth applied) on first use. */
function leftOf(sim: SystemSim, siteId: number, rocks: readonly AsteroidDef[]): Float32Array {
  let left = sim.asteroidLeft.get(siteId);
  if (left) return left;
  left = new Float32Array(rocks.length).fill(1);
  const doc = sim.world.store.getDoc<FieldDoc>('rocks', fieldKey(sim, siteId));
  if (doc && Array.isArray(doc.left) && doc.left.length === rocks.length) {
    const grown = Math.max(0, (sim.time - doc.t) / 3600) * REGROW_PER_HOUR;
    for (let i = 0; i < left.length; i++) {
      const v = Number(doc.left[i]);
      left[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v) + grown) : 1;
    }
  }
  sim.asteroidLeft.set(siteId, left);
  return left;
}

/** The rock a mining beam from `ship` would hit: nearest one inside the cone and range, or -1. */
function aimedRock(ship: Ship, rocks: readonly AsteroidDef[], left: Float32Array, range: number, gimbal: number): number {
  const fwd = forwardOf(ship.state.rot);
  const p = ship.state.pos;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < rocks.length; i++) {
    if (left[i]! <= 0) continue;
    const a = rocks[i]!;
    const d = v3.sub(a.pos, p);
    const dist = v3.len(d);
    const surface = dist - a.radius;
    if (surface > range || surface >= bestDist) continue;
    // The beam hits when the nose points within the gimbal cone of any part of the rock.
    const cos = v3.dot(d, fwd) / Math.max(dist, 1e-6);
    const angular = Math.asin(Math.min(1, a.radius / Math.max(dist, a.radius)));
    if (Math.acos(Math.max(-1, Math.min(1, cos))) <= gimbal + angular) {
      best = i;
      bestDist = surface;
    }
  }
  return best;
}

export const miningModule: GameModule = {
  name: 'mining',

  postStep(sim, t, dt) {
    for (const zone of sim.activeZones()) {
      const site = findSite(sim.def, zone);
      if (!site || (site.kind !== 'belt' && site.kind !== 'ring' && site.kind !== 'anomaly')) continue;
      const rocks = sim.asteroids(zone);
      if (rocks.length === 0) continue;
      let left: Float32Array | null = null;
      let pods = -1;

      for (const ship of sim.shipsInZone(zone)) {
        if (ship.gone || ship.state.mode !== FlightMode.Normal || !(ship.input.buttons & Button.Fire3)) continue;
        const lasers = ship.stats.weapons.filter((w) => w.kind === 'mining');
        if (lasers.length === 0) continue;
        left ??= leftOf(sim, zone, rocks);
        let power = 0;
        let range = 0;
        let gimbal = 0;
        let energy = 0;
        let heat = 0;
        for (const w of lasers) {
          power += w.damage;
          range = Math.max(range, w.range);
          gimbal = Math.max(gimbal, w.gimbal);
          energy += w.energy;
          heat += w.heat;
        }
        const s = ship.state;
        // The weapons power setting covers the tools too.
        energy *= weaponEnergyMul(s.pips);
        if (s.energy < energy * dt) continue;
        const idx = aimedRock(ship, rocks, left, range, gimbal);
        if (idx < 0) continue;
        s.energy -= energy * dt;
        s.heat += heat * dt;
        ship.flags |= EntityFlag.Mining;

        const rock = rocks[idx]!;
        const before = left[idx]!;
        const tonnes = Math.min(power * YIELD_PER_POWER * dt, before * rock.amount);
        left[idx] = Math.max(0, before - tonnes / rock.amount);
        dirty.set(fieldKey(sim, zone), t);

        const cut = cuts.get(ship) ?? { buffer: 0, lastEvent: -1 };
        cuts.set(ship, cut);
        cut.buffer += tonnes;
        const toShip = v3.normalize(v3.sub(s.pos, rock.pos));
        const face = v3.addScaled(rock.pos, toShip, rock.radius);
        if (t - cut.lastEvent >= 0.2) {
          cut.lastEvent = t;
          sim.emit(zone, { e: 'mine', from: ship.id, ast: idx, at: face });
        }
        // Tell clients when the rock visibly changed, and always when it is used up.
        if (left[idx] === 0 || Math.floor(before * 25) !== Math.floor(left[idx]! * 25)) {
          sim.emit(zone, { e: 'ast', ast: idx, left: left[idx]! });
        }
        while (cut.buffer >= 1) {
          cut.buffer -= 1;
          if (ship.player) ship.player.rec.passport.stats.mined += 1;
          if (pods < 0) {
            pods = 0;
            for (const o of sim.objects.values()) if (o.anchor === zone && o.kind === EntityKind.Loot) pods++;
          }
          if (pods >= MAX_PODS && ship.player) {
            if (ship.player.addCargo(rock.ore, 1, sim.world.id, false) > 0) sim.world.pushPilot(ship.player);
            continue;
          }
          const rng = sim.world.random();
          const drift = v3.add(v3.scale(toShip, rng.range(6, 12)), v3.scale(rng.unitVector(), 2));
          sim.spawnLoot(zone, v3.addScaled(face, toShip, 6), drift, rock.ore, 1, 420);
          pods++;
        }
      }
    }
  },

  slowTick(sim, t) {
    // Send each pilot the depletion state of the field they are in, once per visit.
    for (const p of sim.players) {
      const ship = p.ship;
      if (!ship || ship.state.mode !== FlightMode.Normal) continue;
      const left = sim.asteroidLeft.get(ship.state.anchor);
      const key = fieldKey(sim, ship.state.anchor);
      if (synced.get(p) === key) continue;
      const site = findSite(sim.def, ship.state.anchor);
      if (!site || (site.kind !== 'belt' && site.kind !== 'ring' && site.kind !== 'anomaly')) continue;
      const state = left ?? leftOf(sim, site.id, sim.asteroids(site.id));
      synced.set(p, key);
      const events: GameEvent[] = [];
      for (let i = 0; i < state.length && events.length < 300; i++) {
        if (state[i]! < 0.999) events.push({ e: 'ast', ast: i, left: state[i]! });
      }
      if (events.length) p.send({ t: 'ev', e: events });
    }
    // Persist fields that changed, at a modest rate.
    for (const [key, changedAt] of dirty) {
      if (!key.startsWith(sim.def.id + '/') || t - changedAt < 1) continue;
      const siteId = Number(key.slice(sim.def.id.length + 1));
      const left = sim.asteroidLeft.get(siteId);
      const last = sim.world.store.getDoc<FieldDoc>('rocks', key);
      if (left && (!last || t - last.t >= SAVE_EVERY_S || t - changedAt > 5)) {
        sim.world.store.putDoc('rocks', key, { t, left: Array.from(left, (x) => Math.round(x * 1000) / 1000) } satisfies FieldDoc);
        dirty.delete(key);
      }
    }
  },

  onPlayerLeave(p) {
    synced.delete(p);
  },
};
