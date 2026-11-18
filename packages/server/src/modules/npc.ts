/**
 * NPC traffic: keeps a small population of traders, miners, patrols and pirates in the zones
 * where pilots are, and flies them. The piloting itself is in `npc/ai.ts`.
 */
import {
  COMMODITIES,
  FlightMode,
  computeShipStats,
  findSite,
  isSurfaceAnchor,
  newShipState,
  quat,
  starterLoadout,
  v3,
  type NpcRole,
  type Rng,
  type Security,
  type SiteDef,
  type Vec3,
} from '@primacy2/shared';
import { newShip, type GameModule, type Ship } from '../game.ts';
import type { SystemSim } from '../sim.ts';
import { NpcBrain, THINK_EVERY, steer, think } from './npc/ai.ts';

export { NpcBrain } from './npc/ai.ts';

export const MAX_NPCS_PER_ZONE = 8;
export const MAX_NPCS_PER_SYSTEM = 24;
/** NPCs are removed from a zone that has had no pilot for this long, seconds. */
export const NPC_DESPAWN_SECONDS = 60;
/** NPCs added to one zone per population check, so a zone fills over a few seconds. */
const SPAWNS_PER_CHECK = 2;

const ROLES: readonly NpcRole[] = ['trader', 'security', 'miner', 'pirate'];
type Quota = Partial<Record<NpcRole, number>>;

/** How many NPCs of each role belong at a site. Pirates grow bolder as security drops. */
function quotaFor(site: SiteDef, security: Security): Quota | null {
  switch (site.kind) {
    case 'station':
      return security === 'secure' ? { trader: 3, security: 2 }
        : security === 'frontier' ? { trader: 2, security: 1 }
        : { trader: 2, pirate: 2 };
    case 'outpost':
      return security === 'secure' ? { trader: 2, security: 1 }
        : security === 'frontier' ? { trader: 1, security: 1, pirate: 1 }
        : { trader: 1, pirate: 2 };
    case 'belt':
    case 'ring':
    case 'anomaly':
      return security === 'secure' ? { miner: 3, pirate: 1 }
        : security === 'frontier' ? { miner: 2, pirate: 2 }
        : { miner: 1, pirate: 4 };
    default:
      return null;
  }
}

/** Legal manufactured goods a trader may carry. */
const TRADE_GOODS = Object.values(COMMODITIES)
  .filter((c) => !c.illegal && c.category !== 'ore' && c.category !== 'exotic' && c.category !== 'illegal')
  .map((c) => c.id);

const CALLSIGNS = ['Altair', 'Brisa', 'Corvid', 'Dunlin', 'Ember', 'Fathom', 'Garnet', 'Halcyon', 'Isolde', 'Juno', 'Kestrel', 'Lumen', 'Merrow', 'Nadir', 'Osprey', 'Petrel', 'Quill', 'Rook', 'Sable', 'Tern', 'Umbra', 'Vesper', 'Wren', 'Zephyr'];
const ROLE_TITLE: Record<NpcRole, string> = { trader: 'Hauler', miner: 'Prospector', security: 'Patrol', pirate: 'Raider' };

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng.float() * list.length) % list.length]!;

/** Zone anchor id -> universe time a pilot was last seen there, per simulation. */
const seenOf = new WeakMap<SystemSim, Map<number, number>>();

/** A free spot 3 to 12 km from the centre of the site, clear of the structure and of asteroids. */
function spawnPoint(sim: SystemSim, site: SiteDef | undefined, rng: Rng): Vec3 {
  const rocks = site ? sim.asteroids(site.id) : [];
  let pos: Vec3 = [0, 0, 0];
  for (let i = 0; i < 8; i++) {
    pos = v3.scale(rng.unitVector(), rng.range(3_000, 12_000));
    let free = true;
    for (const a of rocks) {
      const reach = a.radius + 120;
      if (v3.distSq(a.pos, pos) < reach * reach) {
        free = false;
        break;
      }
    }
    if (free) break;
  }
  return pos;
}

/**
 * Creates an NPC ship of a role in a zone and adds it to the simulation. Without `at` it appears
 * at a free spot 3 to 12 km from the centre of the site.
 */
export function spawnNpc(sim: SystemSim, zone: number, role: NpcRole, at?: Readonly<Vec3>): Ship {
  // NPC traffic does not fly near the ground: its piloting knows nothing of terrain.
  if (isSurfaceAnchor(zone)) throw new Error(`NPC ships are not spawned in a surface frame (zone ${zone})`);
  const world = sim.world;
  const rng = world.random();
  const site = findSite(sim.def, zone);
  const hull = role === 'trader' ? 'drover' : role === 'miner' ? 'delver' : role === 'security' ? 'lancet' : rng.chance(0.5) ? 'wisp' : 'lancet';
  const loadout = starterLoadout(hull);
  const stats = computeShipStats(loadout);
  const state = newShipState(stats);
  state.mode = FlightMode.Normal;
  state.anchor = zone;
  state.pos = at ? v3.clone(at) : spawnPoint(sim, site, rng);
  state.rot = quat.fromAxisAngle([0, 1, 0], rng.range(0, Math.PI * 2));

  const ship = newShip(world.allocId(), `${ROLE_TITLE[role]} ${pick(rng, CALLSIGNS)}`, loadout, stats, state);
  ship.npc = role;
  ship.faction = role === 'pirate' ? 'Pirates' : (site?.faction ?? sim.def.faction ?? 'Independent');
  const brain = new NpcBrain(role, zone, stats);
  if (role === 'pirate') {
    // Pirates are outlaws everywhere: anyone may attack them and collect.
    ship.wanted = true;
    brain.bounty = (hull === 'lancet' ? 800 : 300) + 100 * Math.floor(rng.float() * 5);
  }
  ship.brain = brain;

  const origin = world.id;
  if (role === 'trader') {
    const a = pick(rng, TRADE_GOODS);
    const b = pick(rng, TRADE_GOODS);
    ship.cargo.push({ c: a, n: 4 + Math.floor(rng.float() * 12), origin });
    if (b !== a) ship.cargo.push({ c: b, n: 3 + Math.floor(rng.float() * 8), origin });
  } else if (role === 'miner') {
    const rocks = site ? sim.asteroids(site.id) : [];
    const ore = rocks.length > 0 ? pick(rng, rocks).ore : 'iron_ore';
    if (Object.hasOwn(COMMODITIES, ore)) ship.cargo.push({ c: ore, n: 4 + Math.floor(rng.float() * 14), origin });
  }
  sim.addShip(ship);
  return ship;
}

/** Removes NPCs nobody is around to see and tops up the zones where pilots are. */
function populate(sim: SystemSim, t: number): void {
  let seen = seenOf.get(sim);
  if (!seen) seenOf.set(sim, (seen = new Map()));

  const occupied: number[] = [];
  for (const zone of sim.activeZones()) {
    if (!sim.zoneHasPlayers(zone)) continue;
    occupied.push(zone);
    seen.set(zone, t);
  }

  // Count per home zone and role; collect first, because removing changes the ship list.
  const npcs: Ship[] = [];
  for (const ship of sim.ships.values()) if (ship.brain instanceof NpcBrain) npcs.push(ship);
  const counts = new Map<number, Quota & { total: number }>();
  let total = 0;
  for (const ship of npcs) {
    const b = ship.brain as NpcBrain;
    let last = seen.get(b.zone);
    if (last === undefined) {
      // Placed by hand in a zone no pilot has visited: the clock starts now.
      seen.set(b.zone, (last = t));
    }
    if (b.leave || ship.state.mode !== FlightMode.Normal || ship.state.anchor !== b.zone || t - last > NPC_DESPAWN_SECONDS) {
      sim.removeShip(ship);
      continue;
    }
    let c = counts.get(b.zone);
    if (!c) counts.set(b.zone, (c = { total: 0 }));
    c.total++;
    c[b.role] = (c[b.role] ?? 0) + 1;
    total++;
  }
  for (const [zone, last] of seen) if (t - last > NPC_DESPAWN_SECONDS) seen.delete(zone);

  for (const zone of occupied) {
    if (total >= MAX_NPCS_PER_SYSTEM) break;
    const site = findSite(sim.def, zone);
    const quota = site ? quotaFor(site, sim.def.security) : null;
    if (!quota) continue;
    let c = counts.get(zone);
    if (!c) counts.set(zone, (c = { total: 0 }));
    let spawned = 0;
    for (const role of ROLES) {
      const want = quota[role] ?? 0;
      while ((c[role] ?? 0) < want && c.total < MAX_NPCS_PER_ZONE && total < MAX_NPCS_PER_SYSTEM && spawned < SPAWNS_PER_CHECK) {
        spawnNpc(sim, zone, role);
        c[role] = (c[role] ?? 0) + 1;
        c.total++;
        total++;
        spawned++;
      }
    }
  }
}

export const npcModule: GameModule = {
  name: 'npc',

  preStep(sim, t) {
    for (const ship of sim.ships.values()) {
      const b = ship.brain;
      if (!(b instanceof NpcBrain) || ship.gone || ship.state.mode !== FlightMode.Normal) continue;
      if ((sim.tickCount + ship.id) % THINK_EVERY === 0) think(sim, ship, b, t);
      steer(sim, ship, b);
    }
  },

  slowTick(sim, t) {
    populate(sim, t);
  },
};
