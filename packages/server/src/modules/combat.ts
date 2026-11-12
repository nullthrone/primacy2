/**
 * Combat: weapons fire, missiles, the law (wanted status and bounties) and what a destroyed
 * ship leaves behind. The parts live in `combat/weapons.ts` and `combat/law.ts`.
 */
import { COMMODITIES, FlightMode, HULLS, MODULES, v3, type Loadout } from '@primacy2/shared';
import type { GameModule, Player, Ship } from '../game.ts';
import type { SystemSim } from '../sim.ts';
import { lawOf, onKill, refreshWanted } from './combat/law.ts';
import { stepImpacts, stepMissiles, stepWeapons } from './combat/weapons.ts';

/** Share of the ship's catalog value a destroyed pilot pays as insurance excess. */
export const INSURANCE_EXCESS = 0.05;
const MAX_LOOT_PODS = 6;
/** Fastest a loot pod drifts away from the wreck, m/s. */
const LOOT_SPREAD = 15;

/** Catalog price of a hull and everything fitted to it. */
export function shipValue(loadout: Loadout): number {
  let value = Object.hasOwn(HULLS, loadout.hull) ? HULLS[loadout.hull]!.price : 0;
  for (const id of loadout.modules) {
    if (typeof id === 'string' && Object.hasOwn(MODULES, id)) value += MODULES[id]!.price;
  }
  return value;
}

/** Throws up to half of a destroyed ship's cargo into space as loot pods. */
function dropLoot(sim: SystemSim, ship: Ship): void {
  if (ship.state.mode !== FlightMode.Normal) return;
  const stacks = ship.cargo.filter((it) => Object.hasOwn(COMMODITIES, it.c) && Number.isInteger(it.n) && it.n > 0);
  let budget = Math.floor(stacks.reduce((sum, it) => sum + it.n, 0) / 2);
  const rng = sim.world.random();
  let pods = 0;
  for (const it of stacks) {
    if (budget <= 0 || pods >= MAX_LOOT_PODS) break;
    const n = Math.min(Math.ceil(it.n / 2), budget);
    const dir = rng.unitVector();
    const pos = v3.addScaled(ship.state.pos, dir, ship.stats.radius * 0.5);
    // The pods do not inherit the wreck's speed: they stay where a pilot can collect them.
    const pod = sim.spawnLoot(ship.state.anchor, pos, v3.scale(dir, rng.range(2, LOOT_SPREAD)), it.c, n);
    // Keep the origin so tariffs still apply when the goods are sold.
    pod.data = { origins: [{ c: it.c, n, origin: typeof it.origin === 'string' ? it.origin : sim.world.id }] };
    budget -= n;
    pods++;
  }
}

/** Charges a destroyed pilot the insurance excess, never more than the credits they have. */
function chargeInsurance(p: Player, ship: Ship): void {
  const credits = Math.max(0, Math.floor(p.rec.credits));
  const excess = Math.min(Math.floor(shipValue(ship.loadout) * INSURANCE_EXCESS), credits);
  p.rec.credits = credits - excess;
  if (excess > 0) p.notice('warn', 'insurance', `Ship replaced. Insurance excess charged: ${excess} cr.`);
}

export const combatModule: GameModule = {
  name: 'combat',

  postStep(sim, _t, dt) {
    stepWeapons(sim, dt);
    stepImpacts(sim);
    stepMissiles(sim, dt);
  },

  slowTick(sim, t) {
    for (const p of sim.players) {
      // The pilot's own view carries the wanted flag, so tell them when it lapses.
      if (refreshWanted(p, t)) sim.world.pushPilot(p);
    }
  },

  onPlayerEnterSystem(p, sim) {
    // A simulation that has not ticked yet has no time of its own: ask the world.
    refreshWanted(p, sim.world.time());
  },

  onShipDestroyed(sim, ship, by) {
    dropLoot(sim, ship);
    const killer = by && by !== ship ? by : null;
    onKill(sim, killer, ship);
    const kp = killer?.player;
    if (kp) {
      kp.rec.passport.stats.kills++;
      sim.world.pushPilot(kp);
    }
    // The core pushes the victim's view itself once the ship is marked dead.
    if (ship.player) chargeInsurance(ship.player, ship);
  },

  pilotView(p, view) {
    const law = lawOf(p);
    view.bounty = law.bounty;
    view.wanted = p.sim ? law.wantedUntil > p.sim.world.time() : (p.ship?.wanted ?? false);
  },
};
