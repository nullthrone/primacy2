/**
 * Exploration: surveying bodies with a scanner, first-discovery records and selling survey data.
 */
import { FlightMode, absolutePosition, bodyState, findSite, v3, type BodyDef } from '@primacy2/shared';
import { fail, ok, type GameModule, type Player } from '../game.ts';

interface ExplorationData {
  /** System ids visited on this server. */
  visited: string[];
  /** Surveys not yet sold: `systemId/bodyId`, with whether it was a first discovery. */
  scans: { key: string; first: boolean }[];
  /** Keys of surveys already sold; a body pays once per pilot. */
  sold: string[];
}

interface Discovery {
  by: string;
  name: string;
  at: number;
}

const data = (p: Player): ExplorationData => p.data<ExplorationData>('exploration', () => ({ visited: [], scans: [], sold: [] }));

/** Credits paid for the survey of a body, before the first-discovery bonus. */
export function surveyValue(b: BodyDef): number {
  switch (b.cls) {
    case 'BH': return 6000;
    case 'NS': return 4000;
    case 'WD': return 1500;
    case 'terran': return 2600;
    case 'ocean': return 1900;
    case 'gas': return 900;
    case 'icegiant': return 800;
    case 'lava': return 600;
    default: return b.kind === 'star' ? 400 : 350;
  }
}

/** A survey works from within this distance of the body's centre, metres. */
export const scanRange = (b: BodyDef): number => b.radius * 40 + 2e7;

function pendingValue(p: Player, world: { defs: Map<string, { bodies: BodyDef[] }> }): number {
  let total = 0;
  for (const s of data(p).scans) {
    const sep = s.key.lastIndexOf('/');
    const body = world.defs.get(s.key.slice(0, sep))?.bodies[Number(s.key.slice(sep + 1))];
    if (body) total += surveyValue(body) * (s.first ? 2 : 1);
  }
  return total;
}

export const explorationModule: GameModule = {
  name: 'exploration',

  commands: {
    scan(p, cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim) return fail('no ship');
      if (ship.state.mode !== FlightMode.Normal && ship.state.mode !== FlightMode.Cruise) return fail('Surveys need the ship in flight.');
      if (!ship.stats.scanner) return fail('A survey scanner is not fitted.');
      const body = sim.def.bodies[cmd.body];
      if (!body) return fail('No such body.');
      const dist = v3.dist(absolutePosition(ship.state, sim.def, sim.time), bodyState(sim.def, body.id, sim.time).pos);
      if (dist > scanRange(body)) return fail('Too far away for a survey.');
      const d = data(p);
      const key = `${sim.def.id}/${body.id}`;
      if (d.sold.includes(key) || d.scans.some((s) => s.key === key)) return fail('You have already surveyed this body.');
      let first = false;
      if (!world.store.getDoc<Discovery>('discovery', key)) {
        first = true;
        world.store.putDoc('discovery', key, { by: p.id, name: p.name, at: world.host.now() } satisfies Discovery);
        p.rec.passport.stats.discoveries += 1;
        p.notice('info', 'first_discovery', `First survey of ${body.name}: your name is on the record.`);
      }
      d.scans.push({ key, first });
      world.pushPilot(p);
      return ok({ first, value: surveyValue(body) * (first ? 2 : 1) });
    },

    sellData(p, _cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim || ship.state.mode !== FlightMode.Docked) return fail('Survey data is sold at a station.');
      const site = findSite(sim.def, ship.state.anchor);
      if (!site?.services?.includes('cartography')) return fail('This station does not buy survey data.');
      const d = data(p);
      const value = pendingValue(p, world);
      if (value <= 0) return fail('You have no survey data to sell.');
      p.rec.credits += value;
      world.trade.creditIncome(p, value, 'data');
      for (const s of d.scans) d.sold.push(s.key);
      if (d.sold.length > 5000) d.sold.splice(0, d.sold.length - 5000);
      d.scans = [];
      world.pushPilot(p);
      world.pushStation(p);
      return ok({ credits: value });
    },
  },

  onPlayerEnterSystem(p, sim) {
    const d = data(p);
    if (!d.visited.includes(sim.def.id)) d.visited.push(sim.def.id);
  },

  pilotView(p, view) {
    const d = data(p);
    view.visited = d.visited;
    view.scans = d.scans.map((s) => {
      const sep = s.key.lastIndexOf('/');
      return [s.key.slice(0, sep), Number(s.key.slice(sep + 1))];
    });
  },

  stationView(p, sim, siteId, view) {
    const site = findSite(sim.def, siteId);
    if (site?.services?.includes('cartography')) view.dataValue = pendingValue(p, sim.world);
  },
};
