import type { GameModule } from '../game.ts';
import { cargoModule } from './cargo.ts';
import { combatModule } from './combat.ts';
import { commsModule } from './comms.ts';
import { coreModule } from './core.ts';
import { economyModule } from './economy.ts';
import { explorationModule } from './exploration.ts';
import { gatesModule } from './gates.ts';
import { miningModule } from './mining.ts';
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
    miningModule,
    cargoModule,
    economyModule,
    explorationModule,
    missionsModule,
    gatesModule,
    commsModule,
  ];
}
