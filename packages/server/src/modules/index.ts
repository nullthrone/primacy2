import type { GameModule } from '../game.ts';
import { cargoModule } from './cargo.ts';
import { combatModule } from './combat.ts';
import { commsModule } from './comms.ts';
import { coreModule } from './core.ts';
import { economyModule } from './economy.ts';
import { explorationModule } from './exploration.ts';
import { gatesModule } from './gates.ts';
import { insuranceModule } from './insurance.ts';
import { miningModule } from './mining.ts';
import { salvageModule, salvageRelease } from './salvage.ts';
import { missionsModule } from './missions.ts';
import { npcModule } from './npc.ts';

/**
 * The gameplay modules a standard server runs. Hooks run in this order every tick:
 * NPC decisions first, then weapons and tools, then everything that reacts to their results.
 */
export function defaultModules(): GameModule[] {
  return [
    coreModule,
    npcModule,
    combatModule,
    // Salvage runs before mining so it can hold the trigger back from a rock behind a wreck;
    // the release module gives it back right after.
    salvageModule,
    miningModule,
    salvageRelease,
    cargoModule,
    insuranceModule,
    economyModule,
    explorationModule,
    missionsModule,
    gatesModule,
    commsModule,
  ];
}
