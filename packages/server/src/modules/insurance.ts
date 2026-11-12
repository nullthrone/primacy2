/**
 * Insurance: a destroyed pilot keeps hull and loadout (the cargo is in the wreck). The respawn
 * command returns them to their home station in the same ship, repaired and refuelled, for a
 * deductible. A pilot who cannot pay is issued the free starter ship and keeps their credits.
 */
import { HULLS, MODULES, starterLoadout, FlightMode, type Loadout } from '@primacy2/shared';
import { fail, ok, type GameModule, type Player } from '../game.ts';
import { markShipBound } from '../trade.ts';
import type { World } from '../world.ts';

/** Catalog price of a hull and everything fitted to it. */
function fitValue(loadout: Loadout): number {
  let value = Object.hasOwn(HULLS, loadout.hull) ? HULLS[loadout.hull]!.price : 0;
  for (const id of loadout.modules) {
    if (typeof id === 'string' && Object.hasOwn(MODULES, id)) value += MODULES[id]!.price;
  }
  return value;
}

/** The deductible for a ship with this fit: `rate` of the hull price plus the fitted modules, whole credits. */
export function deductible(loadout: Loadout, rate: number): number {
  return Math.round(fitValue(loadout) * rate);
}

export const insuranceModule: GameModule = {
  name: 'insurance',

  commands: {
    respawn(p: Player, _cmd, world: World) {
      const ship = p.ship;
      if (!ship || !p.sim || ship.state.mode !== FlightMode.Dead) return fail('You are not dead.');
      const cost = deductible(p.rec.passport.ship.loadout, world.config.insuranceRate);
      const credits = Math.floor(p.rec.credits);
      const pays = credits >= cost;
      if (pays) {
        p.rec.credits = credits - cost;
      } else {
        // Nothing is charged; the pilot starts over with the free hull and its stock fit.
        p.rec.passport.ship.loadout = starterLoadout();
        p.refit();
        // The free starter is a handout, not something the pilot paid for: it refunds nothing when
        // sold or swapped, or two pilots could pump credits out of repeated deaths. A ship that is
        // replaced for the deductible stays as bound as it was.
        markShipBound(p.rec, world.id, world.host.now());
      }
      if (!world.respawn(p)) return fail('You are not dead.');
      // Repaired and refuelled: the ship leaves the yard with full tanks.
      ship.state.fuel = p.stats.fuelCap;
      if (!pays) p.notice('warn', 'insurance', `You cannot cover the ${cost} cr deductible. A starter ship was issued; your credits are untouched.`);
      else if (cost > 0) p.notice('info', 'insurance', `Ship replaced. Insurance deductible charged: ${cost} cr.`);
      else p.notice('info', 'insurance', 'Ship replaced. No deductible was charged.');
      world.pushPilot(p);
      world.save(p);
      return ok({ charged: pays ? cost : 0, starter: !pays });
    },
  },

  pilotView(p, view) {
    view.rebuy = deductible(p.rec.passport.ship.loadout, p.sim?.world.config.insuranceRate ?? 0);
  },
};
