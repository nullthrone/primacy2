/**
 * Combat: weapons fire, missiles, the law (wanted status and bounties) and the kill bookkeeping.
 * The wreck is the salvage module's and the deductible the insurance module's. The parts live in
 * `combat/weapons.ts` and `combat/law.ts`.
 */
import type { GameModule } from '../game.ts';
import { lawOf, onKill, refreshWanted } from './combat/law.ts';
import { stepImpacts, stepMissiles, stepWeapons } from './combat/weapons.ts';

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
    const killer = by && by !== ship ? by : null;
    onKill(sim, killer, ship);
    const kp = killer?.player;
    if (kp) {
      kp.rec.passport.stats.kills++;
      sim.world.pushPilot(kp);
    }
  },

  pilotView(p, view) {
    const law = lawOf(p);
    view.bounty = law.bounty;
    view.wanted = p.sim ? law.wantedUntil > p.sim.world.time() : (p.ship?.wanted ?? false);
  },
};
