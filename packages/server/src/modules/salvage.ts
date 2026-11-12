/**
 * Salvage: a destroyed ship leaves a wreck holding its cargo, scrap and some of its fitted parts.
 * A pilot with a mining laser cuts the wreck open with the tool trigger; its contents float out as
 * ordinary cargo pods that anyone can scoop. Nothing is created or lost on the way: what comes out
 * of a wreck is exactly what went into it (apart from pods that time out in space).
 */
import {
  Button, COMMODITIES, EntityFlag, EntityKind, FlightMode, HULLS, MODULES, STARTER_HULL, findSite, forwardOf, v3, weaponEnergyMul,
  type CargoItem, type EntityInfo, type Vec3,
} from '@primacy2/shared';
import type { GameModule, Ship, SimObject } from '../game.ts';
import type { SystemSim } from '../sim.ts';

/** How long a wreck lasts, universe seconds. */
export const WRECK_LIFETIME = 900;
/** Wrecks a zone keeps; the oldest goes first. */
export const MAX_WRECKS = 12;
/** Tonnes of scrap per tonne-thousand of hull mass: one tonne per this many kilograms. */
const KG_PER_SCRAP_TONNE = 4000;
/** Chance that a fitted module survives as salvageable parts. */
const PART_CHANCE = 0.4;
/** Tonnes released per second per point of mining laser damage. */
const TONNES_PER_POWER = 0.1;
/** Seconds between beam events sent to clients. */
const EVENT_EVERY = 0.25;

/** What a recovered module turns into. Existing commodities stand in for the salvaged parts. */
const PART_FOR_SLOT: Record<string, string> = {
  weapon: 'machinery', thruster: 'machinery', shield: 'electronics', fold: 'electronics',
  reactor: 'reactor_parts', utility: 'alloys',
};

/** Module-owned state of a wreck object (`SimObject.data`). */
export interface WreckData {
  /** What is still inside. Stacks keep the origin server of the goods. */
  contents: CargoItem[];
  /** Tonnes the wreck held when it was made. */
  total: number;
  /** Fraction of the contents still inside; the snapshot sends it as the wreck's hull value. */
  fill: number;
  /** Universe time the wreck was made. */
  bornAt: number;
  /** Tonnes cut loose but not yet released as a pod. */
  buffer: number;
  /** Universe time of the last beam event sent for this wreck. */
  lastEvent: number;
}

export const wreckData = (o: SimObject): WreckData | null =>
  o.kind === EntityKind.Wreck && o.data && typeof o.data === 'object' ? (o.data as WreckData) : null;

const tonnesIn = (items: readonly CargoItem[]): number => items.reduce((sum, it) => sum + it.n, 0);

/** Stacks merge only when commodity, origin and the sealed mark all match. */
function addStack(list: CargoItem[], c: string, n: number, origin: string, sealed = false): void {
  const have = list.find((it) => it.c === c && it.origin === origin && (it.sealed === true) === sealed);
  if (have) have.n += n;
  else list.push(sealed ? { c, n, origin, sealed: true } : { c, n, origin });
}

/** Whether the ship is the starter hull with exactly its stock fit. */
function isStockStarter(ship: Ship): boolean {
  const lo = ship.loadout;
  const stock = HULLS[STARTER_HULL]!.stock;
  return lo.hull === STARTER_HULL && lo.modules.length === stock.length && lo.modules.every((m, i) => m === stock[i]);
}

/** Moves everything a destroyed ship carries, plus scrap and parts, into a new wreck. */
function makeWreck(sim: SystemSim, ship: Ship): void {
  // Only ships in normal space leave a wreck; in cruise there is no place to put one.
  if (ship.state.mode !== FlightMode.Normal) return;
  const contents: CargoItem[] = [];
  for (const it of ship.cargo) {
    if (!Object.hasOwn(COMMODITIES, it.c) || !Number.isInteger(it.n) || it.n <= 0) continue;
    addStack(contents, it.c, it.n, typeof it.origin === 'string' ? it.origin : sim.world.id, it.sealed === true);
  }
  // The goods now belong to the wreck.
  ship.cargo.length = 0;

  const hull = Object.hasOwn(HULLS, ship.stats.hull) ? HULLS[ship.stats.hull]! : null;
  // A pilot's stock starter ship is what insurance hands out for free, so it yields no scrap and no
  // parts: otherwise two pilots could destroy and salvage free ships for credits.
  const worthless = !!ship.player && isStockStarter(ship);
  if (!worthless) addStack(contents, 'scrap', Math.max(1, Math.round((hull?.mass ?? 0) / KG_PER_SCRAP_TONNE)), sim.world.id);
  const rng = sim.world.random();
  for (const id of worthless ? [] : ship.loadout.modules) {
    if (typeof id !== 'string' || !Object.hasOwn(MODULES, id)) continue;
    if (rng.range(0, 1) < PART_CHANCE) addStack(contents, PART_FOR_SLOT[MODULES[id]!.slot] ?? 'alloys', 1, sim.world.id);
  }

  const total = tonnesIn(contents);
  const id = sim.world.allocId();
  const info: EntityInfo = {
    id, kind: EntityKind.Wreck, name: `Wreck of ${ship.name}`, model: ship.stats.hull, radius: ship.stats.radius,
  };
  const data: WreckData = { contents, total, fill: 1, bornAt: sim.time, buffer: 0, lastEvent: -1 };
  const anchor = ship.state.anchor;
  sim.addObject({
    id, kind: EntityKind.Wreck, anchor, pos: v3.clone(ship.state.pos), vel: v3.clone(ship.state.vel),
    rot: [...ship.state.rot], radius: ship.stats.radius, info, ttl: WRECK_LIFETIME, data,
  });

  // A zone keeps a dozen wrecks: the oldest ones fade away first.
  const wrecks = wrecksIn(sim, anchor).sort((a, b) => wreckData(a)!.bornAt - wreckData(b)!.bornAt || a.id - b.id);
  for (let i = 0; i < wrecks.length - MAX_WRECKS; i++) sim.removeObject(wrecks[i]!.id);
}

function wrecksIn(sim: SystemSim, anchor: number): SimObject[] {
  const list: SimObject[] = [];
  for (const o of sim.objects.values()) if (o.anchor === anchor && wreckData(o)) list.push(o);
  return list;
}

/** Distance from the ship to the surface of a sphere the nose points at, or Infinity when it misses. */
function beamHit(ship: Ship, centre: Vec3, radius: number, range: number, gimbal: number): number {
  const d = v3.sub(centre, ship.state.pos);
  const dist = v3.len(d);
  const surface = dist - radius;
  if (surface > range) return Infinity;
  const cos = v3.dot(d, forwardOf(ship.state.rot)) / Math.max(dist, 1e-6);
  const angular = Math.asin(Math.min(1, radius / Math.max(dist, radius)));
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= gimbal + angular ? Math.max(0, surface) : Infinity;
}

/** Distance to the nearest asteroid in the beam, or Infinity (mining.ts decides what it actually cuts). */
function rockInBeam(sim: SystemSim, zone: number, ship: Ship, range: number, gimbal: number): number {
  const site = findSite(sim.def, zone);
  if (!site || (site.kind !== 'belt' && site.kind !== 'ring' && site.kind !== 'anomaly')) return Infinity;
  const left = sim.asteroidLeft.get(zone);
  const rocks = sim.asteroids(zone);
  let best = Infinity;
  for (let i = 0; i < rocks.length; i++) {
    if (left && left[i]! <= 0) continue;
    best = Math.min(best, beamHit(ship, rocks[i]!.pos, rocks[i]!.radius, range, gimbal));
  }
  return best;
}

/** Fire3 bits taken off ships this tick so mining.ts leaves them alone; given back by `salvageRelease`. */
const withheld: { ship: Ship; buttons: number }[] = [];

export const salvageModule: GameModule = {
  name: 'salvage',

  onShipDestroyed(sim, ship) {
    makeWreck(sim, ship);
  },

  postStep(sim, t, dt) {
    if (sim.objects.size === 0) return;
    for (const zone of sim.activeZones()) {
      let wrecks: SimObject[] | null = null;
      for (const ship of sim.shipsInZone(zone)) {
        if (ship.gone || ship.state.mode !== FlightMode.Normal || !(ship.input.buttons & Button.Fire3)) continue;
        let power = 0, range = 0, gimbal = 0, energy = 0, heat = 0, lasers = 0;
        for (const w of ship.stats.weapons) {
          if (w.kind !== 'mining') continue;
          lasers++;
          power += w.damage;
          range = Math.max(range, w.range);
          gimbal = Math.max(gimbal, w.gimbal);
          energy += w.energy;
          heat += w.heat;
        }
        if (lasers === 0) continue;
        wrecks ??= wrecksIn(sim, zone);
        let wreck: SimObject | null = null;
        let wreckDist = Infinity;
        for (const w of wrecks) {
          if (sim.objects.get(w.id) !== w) continue;
          const d = beamHit(ship, w.pos, w.radius, range, gimbal);
          if (d < wreckDist) { wreck = w; wreckDist = d; }
        }
        if (!wreck) continue;
        // When a rock is in the beam too, the nearer of the two is cut. If that is the wreck, the
        // mining trigger is held back for the rest of this tick.
        const rockDist = rockInBeam(sim, zone, ship, range, gimbal);
        if (rockDist < wreckDist) continue;
        if (rockDist < Infinity) {
          withheld.push({ ship, buttons: ship.input.buttons });
          ship.input.buttons &= ~Button.Fire3;
        }

        const s = ship.state;
        energy *= weaponEnergyMul(s.pips);
        if (s.energy < energy * dt) continue;
        s.energy -= energy * dt;
        s.heat += heat * dt;
        ship.flags |= EntityFlag.Mining;
        cut(sim, t, ship, wreck, power * TONNES_PER_POWER * dt);
      }
    }
  },
};

/** Lets the wreck give up `tonnes` of its contents as pods next to it. */
function cut(sim: SystemSim, t: number, ship: Ship, wreck: SimObject, tonnes: number): void {
  const d = wreckData(wreck)!;
  const toShip = v3.normalize(v3.sub(ship.state.pos, wreck.pos));
  const face = v3.addScaled(wreck.pos, toShip, wreck.radius);
  if (t - d.lastEvent >= EVENT_EVERY) {
    d.lastEvent = t;
    sim.emit(wreck.anchor, { e: 'salvage', from: ship.id, id: wreck.id, at: face });
  }
  d.buffer += tonnes;
  const rng = sim.world.random();
  for (const stack of d.contents) {
    if (d.buffer < 1) break;
    const take = Math.min(Math.floor(d.buffer), stack.n);
    if (take <= 0) continue;
    stack.n -= take;
    d.buffer -= take;
    const drift = v3.add(v3.add(wreck.vel, v3.scale(toShip, rng.range(6, 12))), v3.scale(rng.unitVector(), 2));
    const pod = sim.spawnLoot(wreck.anchor, v3.addScaled(face, toShip, 6), drift, stack.c, take);
    // The origin and the sealed mark travel with the goods.
    const lot: CargoItem = { c: stack.c, n: take, origin: stack.origin };
    if (stack.sealed) lot.sealed = true;
    pod.data = { origins: [lot] };
  }
  d.contents = d.contents.filter((it) => it.n > 0);
  const left = tonnesIn(d.contents);
  d.fill = d.total > 0 ? left / d.total : 0;
  if (left === 0) sim.removeObject(wreck.id);
}

/**
 * Registered right after mining: hands back the trigger bits `salvageModule` withheld, so the
 * ship's input is unchanged when the tick ends.
 */
export const salvageRelease: GameModule = {
  name: 'salvage-release',
  postStep() {
    for (const w of withheld) w.ship.input.buttons = w.buttons;
    withheld.length = 0;
  },
};
