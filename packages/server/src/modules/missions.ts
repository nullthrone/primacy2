/**
 * Mission boards. Each station offers a few jobs that change every half hour of universe time:
 * deliveries, ore requests, pirate bounties and survey contracts. Missions are local to a server.
 */
import { COMMODITIES, FlightMode, findSite, rngFor, v3, type MissionView, type SiteDef } from '@primacy2/shared';
import { fail, ok, type GameModule, type Player } from '../game.ts';
import type { SystemSim } from '../sim.ts';
import type { World } from '../world.ts';

interface Mission extends MissionView {
  /** System and site that issued the mission. */
  system: string;
  site: number;
  /** Credits held as security for cargo handed to the pilot; returned on delivery. */
  deposit: number;
  /** Body to survey, for survey missions. */
  body?: number;
}

interface MissionData {
  active: Mission[];
  /** Ids of missions finished or abandoned, so the same offer cannot be taken twice. */
  done: string[];
}

/** Offers change every this many seconds of universe time. */
const SLOT_S = 1800;
const MAX_ACTIVE = 5;
/** An accepted mission must be finished within this many seconds. */
const TIME_LIMIT_S = 3 * 3600;

const DELIVERY_GOODS = ['machinery', 'electronics', 'medicine', 'food', 'textiles', 'alloys', 'polymers', 'fuel_cells', 'hull_plates'];
const ORE_GOODS = ['iron_ore', 'copper_ore', 'titanium_ore', 'silicates', 'ice'];

const data = (p: Player): MissionData => p.data<MissionData>('missions', () => ({ active: [], done: [] }));

/** The offers of a station for the time slot containing `t`. Deterministic, so every pilot sees the same board. */
export function offersFor(world: World, sim: SystemSim, site: SiteDef, t: number): Mission[] {
  const slot = Math.floor(t / SLOT_S);
  const rng = rngFor(site.seed, 'missions', sim.def.id, slot);
  const count = site.kind === 'station' ? 4 : 2;
  const out: Mission[] = [];
  const base = { system: sim.def.id, site: site.id, expires: (slot + 1) * SLOT_S, deposit: 0 };
  const localDest = sim.def.sites.filter((s) => s.id !== site.id && s.services?.includes('market'));
  const farDest: { system: string; name: string; pos: [number, number, number]; site: SiteDef }[] = [];
  for (const def of world.defs.values()) {
    if (def.id === sim.def.id) continue;
    const s = def.sites.find((x) => x.services?.includes('market'));
    if (s) farDest.push({ system: def.id, name: def.name, pos: def.pos, site: s });
  }
  const planets = sim.def.bodies.filter((b) => b.kind !== 'star');

  for (let i = 0; i < count; i++) {
    const id = `${sim.def.id}/${site.id}/${slot}/${i}`;
    const roll = rng.float();
    if (roll < 0.45 && (localDest.length || farDest.length)) {
      const c = rng.pick(DELIVERY_GOODS);
      const n = rng.int(2, 8);
      const price = COMMODITIES[c]!.price;
      const far = farDest.length > 0 && (localDest.length === 0 || rng.chance(0.4));
      if (far) {
        const d = rng.pick(farDest);
        const ly = v3.dist(sim.def.pos, d.pos);
        out.push({
          ...base, id, kind: 'delivery', c, n, deposit: Math.round(price * n * 1.2),
          title: `Deliver ${n} t of ${COMMODITIES[c]!.name} to ${d.name}`,
          text: `${d.site.name} in the ${d.name} system is waiting for this shipment. The cargo is loaded on acceptance against a deposit.`,
          reward: Math.round(1500 + 320 * ly + 90 * n), destSystem: d.system, destSite: d.site.id, destName: `${d.site.name}, ${d.name}`,
        });
      } else {
        const d = rng.pick(localDest);
        out.push({
          ...base, id, kind: 'delivery', c, n, deposit: Math.round(price * n * 1.2),
          title: `Deliver ${n} t of ${COMMODITIES[c]!.name} to ${d.name}`,
          text: `A short haul inside this system. The cargo is loaded on acceptance against a deposit.`,
          reward: Math.round(500 + 70 * n), destSystem: sim.def.id, destSite: d.id, destName: d.name,
        });
      }
    } else if (roll < 0.65) {
      const c = rng.pick(ORE_GOODS);
      const n = rng.int(4, 12);
      out.push({
        ...base, id, kind: 'mining', c, n,
        title: `Wanted: ${n} t of ${COMMODITIES[c]!.name}`,
        text: `Bring the ore to ${site.name}. Any source will do.`,
        reward: Math.round(COMMODITIES[c]!.price * n * 1.7 + 300), destSystem: sim.def.id, destSite: site.id, destName: site.name,
      });
    } else if (roll < 0.85 || planets.length === 0) {
      const n = rng.int(2, 4);
      out.push({
        ...base, id, kind: 'bounty', n, progress: 0,
        title: `Destroy ${n} pirates in ${sim.def.name}`,
        text: `Pirates are harassing traffic in this system. Payment on proof of ${n} kills.`,
        reward: 1300 * n, destSystem: sim.def.id,
      });
    } else {
      const b = rng.pick(planets);
      out.push({
        ...base, id, kind: 'survey', body: b.id,
        title: `Survey ${b.name}`,
        text: `Fly to ${b.name} and scan it with a survey scanner, then report back.`,
        reward: 1100, destSystem: sim.def.id, destName: b.name,
      });
    }
  }
  return out;
}

function dockedSite(p: Player): { sim: SystemSim; site: SiteDef } | null {
  const ship = p.ship;
  if (!ship || !p.sim || ship.state.mode !== FlightMode.Docked) return null;
  const site = findSite(p.sim.def, ship.state.anchor);
  return site ? { sim: p.sim, site } : null;
}

/** Drops missions whose time ran out. */
function prune(p: Player, t: number): MissionData {
  const d = data(p);
  d.active = d.active.filter((m) => m.expires > t);
  if (d.done.length > 400) d.done.splice(0, d.done.length - 400);
  return d;
}

function surveyed(p: Player, key: string): boolean {
  const ex = p.rec.data.exploration as { scans?: { key: string }[]; sold?: string[] } | undefined;
  return !!ex && ((ex.sold ?? []).includes(key) || (ex.scans ?? []).some((s) => s.key === key));
}

export const missionsModule: GameModule = {
  name: 'missions',

  commands: {
    missionAccept(p, cmd, world) {
      const at = dockedSite(p);
      if (!at || !at.site.services?.includes('missions')) return fail('There is no mission board here.');
      const d = prune(p, at.sim.time);
      const offer = offersFor(world, at.sim, at.site, at.sim.time).find((m) => m.id === cmd.id);
      if (!offer) return fail('That offer is no longer available.');
      if (d.done.includes(offer.id) || d.active.some((m) => m.id === offer.id)) return fail('You have already taken this job.');
      if (d.active.length >= MAX_ACTIVE) return fail('You cannot take on more missions.');
      if (offer.kind === 'delivery' && offer.c && offer.n) {
        if (p.cargoFree() < offer.n) return fail('Not enough free cargo space for the shipment.');
        if (p.rec.credits < offer.deposit) return fail(`The deposit for this cargo is ${offer.deposit} credits.`);
        p.rec.credits -= offer.deposit;
        p.addCargo(offer.c, offer.n, world.id, false);
      }
      d.active.push({ ...offer, accepted: true, expires: at.sim.time + TIME_LIMIT_S });
      world.pushPilot(p);
      world.pushStation(p);
      return ok();
    },

    missionAbandon(p, cmd, world) {
      const d = data(p);
      const i = d.active.findIndex((m) => m.id === cmd.id);
      if (i < 0) return fail('No such mission.');
      d.done.push(d.active[i]!.id);
      d.active.splice(i, 1);
      world.pushPilot(p);
      world.pushStation(p);
      return ok();
    },

    missionComplete(p, cmd, world) {
      const at = dockedSite(p);
      if (!at) return fail('Missions are completed at a station.');
      const d = prune(p, at.sim.time);
      const i = d.active.findIndex((m) => m.id === cmd.id);
      const m = d.active[i];
      if (!m) return fail('No such mission.');
      let pay = m.reward;
      if (m.kind === 'delivery' || m.kind === 'mining') {
        if (m.destSystem !== at.sim.def.id || m.destSite !== at.site.id) return fail(`This has to be delivered to ${m.destName}.`);
        if (!m.c || !m.n || p.cargoCount(m.c) < m.n) return fail('You do not carry the full shipment.');
        p.removeCargo(m.c, m.n);
        pay += m.deposit;
      } else if (m.kind === 'bounty') {
        if ((m.progress ?? 0) < (m.n ?? 1)) return fail(`Only ${m.progress ?? 0} of ${m.n} confirmed so far.`);
      } else if (m.kind === 'survey') {
        if (!surveyed(p, `${m.system}/${m.body}`)) return fail(`${m.destName} has not been surveyed yet.`);
      } else {
        return fail('This mission cannot be completed here.');
      }
      p.rec.credits += pay;
      d.done.push(m.id);
      d.active.splice(i, 1);
      p.notice('info', 'mission_done', `Mission complete: ${pay} credits paid.`);
      world.pushPilot(p);
      world.pushStation(p);
      return ok({ credits: pay });
    },
  },

  onShipDestroyed(sim, ship, by) {
    const p = by?.player;
    if (!p || ship.npc !== 'pirate') return;
    let changed = false;
    for (const m of data(p).active) {
      if (m.kind === 'bounty' && m.destSystem === sim.def.id && (m.progress ?? 0) < (m.n ?? 1)) {
        m.progress = (m.progress ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) sim.world.pushPilot(p);
  },

  pilotView(p, view) {
    view.missions = data(p).active;
  },

  stationView(p, sim, siteId, view) {
    const site = findSite(sim.def, siteId);
    if (!site?.services?.includes('missions')) return;
    const d = prune(p, sim.time);
    view.missions = offersFor(sim.world, sim, site, sim.time).filter((m) => !d.done.includes(m.id) && !d.active.some((a) => a.id === m.id));
  },
};
