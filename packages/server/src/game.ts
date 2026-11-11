/**
 * Core game objects shared by the simulation and the gameplay modules.
 */
import {
  NEUTRAL_INPUT,
  cargoTonnes,
  computeShipStats,
  encodeMsg,
  type CargoItem,
  type Command,
  type EntityInfo,
  type EntityKind,
  type Hazards,
  type Loadout,
  type NpcRole,
  type PilotView,
  type Quat,
  type S2C,
  type ShipInput,
  type ShipState,
  type ShipStats,
  type StationView,
  type Vec3,
} from '@primacy2/shared';
import type { KnownServer } from './federation.ts';
import type { PlayerRecord } from './store.ts';
import type { SystemSim } from './sim.ts';
import type { World } from './world.ts';

/** Transport for one connected client. Implemented by the WebSocket session. */
export interface Connection {
  send(text: string): void;
  sendBinary(data: ArrayBuffer): void;
  close(reason: string): void;
}

/** Zone id for ships in cruise: they share one system-wide layer. */
export const CRUISE_ZONE = -2;
/** Zone id for ships that are in no zone (fold tunnel, docked, dead). */
export const NO_ZONE = -1;

export interface Ship {
  id: number;
  name: string;
  state: ShipState;
  stats: ShipStats;
  loadout: Loadout;
  /** Input applied on the next tick. */
  input: ShipInput;
  player: Player | null;
  npc: NpcRole | null;
  /** Module-owned AI state for NPC ships. */
  brain?: unknown;
  faction?: string;
  /** Cargo hold. For player ships this is the passport's cargo array itself. */
  cargo: CargoItem[];
  /** Entity id of the locked target, or null. */
  target: number | null;
  /** Seconds until each weapon mount can fire again; index-aligned with `stats.weapons`. */
  cooldowns: number[];
  /** `EntityFlag` bits, recomputed every tick. */
  flags: number;
  hazards: Hazards | null;
  /** Destination of a fold jump being charged or in progress. */
  fold: { system: string; server: string | null; distance: number } | null;
  /** Seconds left in the fold tunnel (same-server jumps). */
  tunnel: number;
  /** Galactic position of the system a fold jump started from; orients the arrival point. */
  foldFrom: Vec3 | null;
  wanted: boolean;
  lastHitBy: number | null;
  /** Universe time of the last hit taken. */
  lastHitAt: number;
  /** Removed from the simulation; kept only so stale references can detect it. */
  gone: boolean;
}

/** A simple non-ship entity: floating cargo, a missile. Modules give it behaviour in their tick. */
export interface SimObject {
  id: number;
  kind: EntityKind;
  /** Anchor id of the zone it lives in. */
  anchor: number;
  pos: Vec3;
  vel: Vec3;
  rot: Quat;
  radius: number;
  info: EntityInfo;
  /** Seconds until it disappears. */
  ttl: number;
  /** Module-owned data. */
  data?: unknown;
}

export class Player {
  conn: Connection | null = null;
  ship: Ship | null = null;
  sim: SystemSim | null = null;
  /** Entity ids the client has been told about. */
  readonly known = new Set<number>();
  /** Inputs received but not yet applied, oldest first. */
  readonly inputs: ShipInput[] = [];
  /** Sequence number of the last input applied. */
  ackSeq = 0;
  stats: ShipStats;
  /** Station view the pilot currently has open (while docked). */
  dockedAt: number | null = null;
  /** Events queued for the next snapshot. */
  private noticeBudget = 20;

  constructor(readonly rec: PlayerRecord) {
    this.stats = computeShipStats(rec.passport.ship.loadout);
  }

  get id(): string {
    return this.rec.id;
  }

  get name(): string {
    return this.rec.passport.name;
  }

  send(msg: S2C): void {
    this.conn?.send(encodeMsg(msg));
  }

  notice(level: 'info' | 'warn' | 'danger', code: string, text: string): void {
    if (this.noticeBudget <= 0) return;
    this.noticeBudget--;
    this.send({ t: 'notice', level, code, text });
  }

  /** Called once per second so a misbehaving loop cannot flood the client with notices. */
  refillNotices(): void {
    this.noticeBudget = 20;
  }

  /** Recomputes cached ship stats after the loadout changed and updates the live ship. */
  refit(): void {
    this.stats = computeShipStats(this.rec.passport.ship.loadout);
    if (this.ship) {
      const s = this.ship;
      s.stats = this.stats;
      s.loadout = this.rec.passport.ship.loadout;
      s.cooldowns = this.stats.weapons.map(() => 0);
      s.state.hull = Math.min(s.state.hull, this.stats.hullMax);
      s.state.shield = Math.min(s.state.shield, this.stats.shieldMax);
      s.state.energy = Math.min(s.state.energy, this.stats.energyMax);
      s.state.fuel = Math.min(s.state.fuel, this.stats.fuelCap);
    }
  }

  cargoFree(): number {
    return Math.max(0, Math.floor(this.stats.cargoCap) - cargoTonnes(this.rec.passport.ship.cargo));
  }

  /** Adds cargo, merging with an existing stack of the same commodity and origin. Returns tonnes actually added. */
  addCargo(c: string, n: number, origin: string): number {
    const add = Math.min(Math.floor(n), this.cargoFree());
    if (add <= 0) return 0;
    const cargo = this.rec.passport.ship.cargo;
    const have = cargo.find((it) => it.c === c && it.origin === origin);
    if (have) have.n += add;
    else cargo.push({ c, n: add, origin });
    return add;
  }

  /** Tonnes of a commodity on board, across all origins. */
  cargoCount(c: string): number {
    return this.rec.passport.ship.cargo.reduce((sum, it) => (it.c === c ? sum + it.n : sum), 0);
  }

  /**
   * Removes up to `n` tonnes of a commodity. Returns the removed stacks (with their origins),
   * so the caller can price each origin separately.
   */
  removeCargo(c: string, n: number): CargoItem[] {
    const cargo = this.rec.passport.ship.cargo;
    const taken: CargoItem[] = [];
    let left = Math.floor(n);
    for (let i = cargo.length - 1; i >= 0 && left > 0; i--) {
      const it = cargo[i]!;
      if (it.c !== c) continue;
      const take = Math.min(left, it.n);
      it.n -= take;
      left -= take;
      taken.push({ c, n: take, origin: it.origin });
      if (it.n <= 0) cargo.splice(i, 1);
    }
    return taken;
  }

  /** Module-owned persistent data for this pilot on this server. */
  data<T extends object>(module: string, init: () => T): T {
    const d = this.rec.data[module];
    if (d && typeof d === 'object') return d as T;
    const fresh = init();
    this.rec.data[module] = fresh;
    return fresh;
  }
}

export function newShip(id: number, name: string, loadout: Loadout, stats: ShipStats, state: ShipState): Ship {
  return {
    id, name, state, stats, loadout,
    input: { ...NEUTRAL_INPUT, thrust: [0, 0, 0], aim: [0, 0] },
    player: null, npc: null, cargo: [], target: null,
    cooldowns: stats.weapons.map(() => 0),
    flags: 0, hazards: null, fold: null, tunnel: 0, foldFrom: null, wanted: false,
    lastHitBy: null, lastHitAt: -1e9, gone: false,
  };
}

export type CommandResult = { ok: true; data?: unknown } | { ok: false; err: string };
export type CommandHandler<K extends Command['k'] = Command['k']> = (
  player: Player,
  cmd: Extract<Command, { k: K }>,
  world: World,
) => CommandResult | Promise<CommandResult>;

export const ok = (data?: unknown): CommandResult => ({ ok: true, data });
export const fail = (err: string): CommandResult => ({ ok: false, err });

/**
 * A gameplay module. The core calls these hooks; every hook is optional.
 * Modules keep their own state and persist through `world.store` documents or `player.data`.
 */
export interface GameModule {
  name: string;
  /** Called once after the world is built. Register federation topics here. */
  init?(world: World): void;
  /** Command handlers by command kind. A kind may only be handled by one module. */
  commands?: { [K in Command['k']]?: CommandHandler<K> };
  /** Before ships are stepped: set NPC inputs here. */
  preStep?(sim: SystemSim, t: number, dt: number): void;
  /** After ships are stepped and collided: weapons, mining, pickups. */
  postStep?(sim: SystemSim, t: number, dt: number): void;
  /** About once per second per active system. */
  slowTick?(sim: SystemSim, t: number): void;
  /** About every five seconds for the whole world, whether or not anyone is online. */
  worldTick?(world: World, nowMs: number): void;
  onShipDestroyed?(sim: SystemSim, ship: Ship, by: Ship | null): void;
  onPlayerEnterSystem?(player: Player, sim: SystemSim): void;
  onPlayerLeave?(player: Player): void;
  onDock?(player: Player, sim: SystemSim, site: number): void;
  /** Add this module's part to the station view of a docked pilot. */
  stationView?(player: Player, sim: SystemSim, site: number, view: StationView): void;
  /** Add this module's part to the pilot's own view. */
  pilotView?(player: Player, view: PilotView): void;
  /** A ship arrived from another server (after sanitising). */
  onArrival?(player: Player, from: KnownServer): void;
}
