/**
 * Client <-> server messages. JSON text frames carry `C2S` and `S2C`; binary frames carry
 * snapshots (see `snapshot.ts`). The server validates every field of every `C2S` message.
 */
import type { Signed } from './crypto.ts';
import type { ServerRules, TransferTicket, TrustLevel, GateLink } from './federation.ts';
import type { Vec3 } from './math.ts';
import type { Passport } from './pilot.ts';
import type { ShipInput } from './sim/types.ts';
import type { AbsorbLimit, ShipBinding } from './trade.ts';
import type { SiteDef, StationService, SystemDef, SystemSummary } from './universe/types.ts';

// ---------------------------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------------------------

export type ChatChannel = 'local' | 'system' | 'sector' | 'lattice' | 'wing' | 'direct';

export type Command =
  /** Engage or disengage cruise. `site` names the site to drop at when disengaging near one. */
  | { k: 'cruise'; on: boolean; site?: number }
  /** Start charging a fold jump to a system on this or any known server. */
  | { k: 'fold'; system: string }
  | { k: 'foldCancel' }
  /** Transit an active warp gate. The ship must be within range of the gate site. */
  | { k: 'gate'; site: number }
  /** Lock a combat target (entity id) or clear it. */
  | { k: 'target'; id: number | null }
  | { k: 'dock' }
  | { k: 'undock' }
  | { k: 'respawn' }
  | { k: 'chat'; ch: ChatChannel; text: string; to?: string }
  | { k: 'station' }
  | { k: 'galaxy' }
  | { k: 'buy'; c: string; n: number }
  | { k: 'sell'; c: string; n: number }
  | { k: 'refuel' }
  | { k: 'repair' }
  | { k: 'buyHull'; hull: string }
  | { k: 'fit'; slot: number; module: string | null }
  | { k: 'missionAccept'; id: string }
  | { k: 'missionAbandon'; id: string }
  | { k: 'missionComplete'; id: string }
  | { k: 'jettison'; c: string; n: number }
  /** Survey a body with the scanner. */
  | { k: 'scan'; body: number }
  | { k: 'sellData' }
  | { k: 'wing'; op: 'invite' | 'accept' | 'leave' | 'kick'; player?: string }
  /** Contribute cargo or local credits to a gate under construction at the docked station's system. */
  | { k: 'gateFund'; linkId: string; c?: string; n?: number; credits?: number }
  /** Give fuel to another ship within range (distress help). */
  | { k: 'giveFuel'; to: number; n: number };

export type C2S =
  | { t: 'hello'; proto: number }
  | { t: 'auth'; key: string; sig: string; name: string; ticket?: Signed<TransferTicket> }
  | { t: 'in'; i: ShipInput }
  | { t: 'ping'; c: number }
  | { t: 'cmd'; id: number; c: Command };

// ---------------------------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------------------------

/** `Wreck` is what a destroyed ship leaves behind; its `model` is the hull id of that ship. */
export const EntityKind = { Ship: 1, Loot: 2, Missile: 3, Station: 4, Gate: 5, Wreck: 6 } as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

/** Bit flags in a snapshot entity. */
export const EntityFlag = {
  Thrust: 1,
  Boost: 2,
  Firing: 4,
  Charging: 8,
  Cruise: 16,
  Wanted: 32,
  Mining: 64,
} as const;

export type NpcRole = 'trader' | 'pirate' | 'security' | 'miner';

/** Static facts about an entity, sent once when it enters the client's interest set. */
export interface EntityInfo {
  id: number;
  kind: EntityKind;
  name: string;
  /** Hull id for ships; model key otherwise. */
  model: string;
  radius: number;
  /** Player id when the ship is flown by a player. */
  player?: string;
  /** Home server id for visiting players. */
  home?: string;
  npc?: NpcRole;
  faction?: string;
  wing?: string;
  /** Commodity id for loot. */
  c?: string;
  n?: number;
}

export type GameEvent =
  /** A weapon fired. `to` is the entity hit, `at` the impact or end point relative to the zone anchor. */
  | { e: 'shot'; from: number; w: string; slot: number; to?: number; at: Vec3 }
  | { e: 'hit'; id: number; by?: number; dmg: number; shield: boolean; at: Vec3 }
  | { e: 'destroyed'; id: number; by?: number; at: Vec3 }
  /** A mining laser is cutting asteroid `ast` at this site. */
  | { e: 'mine'; from: number; ast: number; at: Vec3 }
  /** Remaining ore fraction of an asteroid changed (0 = depleted). */
  | { e: 'ast'; ast: number; left: number }
  /** A salvage beam from ship `from` is cutting up wreck `id`; `at` is the point on the wreck it touches. */
  | { e: 'salvage'; from: number; id: number; at: Vec3 }
  | { e: 'cruise'; id: number; on: boolean; at: Vec3 }
  | { e: 'fold'; id: number; out: boolean; at: Vec3 }
  | { e: 'dock'; id: number; docked: boolean }
  | { e: 'scoop'; id: number; c: string; n: number }
  | { e: 'respawn'; id: number };

export interface MarketRow {
  c: string;
  stock: number;
  /** Price the pilot pays per tonne; 0 when the station does not sell it. */
  buy: number;
  /** Price the station pays per tonne. */
  sell: number;
  /** -1 surplus .. +1 shortage. */
  demand: number;
}

/** Reply data of the `sell` command. */
export interface SellResult {
  /** Tonnes sold. May be fewer than asked for; `limit` says why. */
  n: number;
  /** Credits paid, after the tariff. */
  total: number;
  /** Credits withheld as tariff. */
  tariff: number;
  /**
   * What stopped the sale short of the amount asked for: the rest of the cargo is sealed, the
   * partner's trade balance is exhausted, or the pilot's import licence is used up. Null when
   * everything asked for was sold.
   */
  limit: AbsorbLimit | 'missing' | null;
  /** Server id of the origin whose goods hit the limit. */
  limitOrigin: string | null;
}

/** What the cargo of one origin in the docked pilot's hold counts as on this server. */
export interface ImportInfo {
  /** Origin server id (the label on the goods). */
  origin: string;
  name: string;
  /** Effective tier of the origin here. */
  tier: TrustLevel;
  /** Trade units of imports from this origin that can still be absorbed; null when unlimited. */
  allowance: number | null;
  /** Tonnes from this origin in the hold. */
  tonnes: number;
  /** Tonnes of those that are sealed: they can only be carried out again or jettisoned. */
  sealed: number;
}

export type MissionKind = 'delivery' | 'courier' | 'bounty' | 'mining' | 'survey' | 'rescue';

export interface MissionView {
  id: string;
  kind: MissionKind;
  title: string;
  text: string;
  reward: number;
  /** Destination system id (may be on another server) and site anchor id. */
  destSystem?: string;
  destSite?: number;
  destName?: string;
  c?: string;
  n?: number;
  /** 0..n progress towards the goal. */
  progress?: number;
  /** Universe time (s) the offer or mission expires. */
  expires: number;
  accepted?: boolean;
}

export interface GateProjectView {
  link: GateLink;
  /** Remaining local requirements. */
  needCredits: number;
  needMaterials: Record<string, number>;
  remoteProgress: number;
  peerName: string;
}

export interface StationView {
  site: number;
  name: string;
  services: StationService[];
  faction?: string;
  market: MarketRow[];
  /** Module ids on sale. */
  modules: string[];
  /** Hull ids on sale. */
  hulls: string[];
  missions: MissionView[];
  fuelPrice: number;
  repairPrice: number;
  /** Credits offered for unsold survey data. */
  dataValue: number;
  gateProjects: GateProjectView[];
  /** Tariff rate applied to the pilot's foreign cargo, per origin server id. */
  tariffs: Record<string, number>;
  /** Per origin, what the foreign and sealed cargo in the pilot's hold counts as here. */
  imports: ImportInfo[];
}

/** The pilot's own persistent state as the client sees it. */
export interface PilotView {
  id: string;
  name: string;
  /** Credits on this server. */
  credits: number;
  passport: Passport;
  /** Outstanding bounty on the pilot here. */
  bounty: number;
  wanted: boolean;
  reputation: Record<string, number>;
  missions: MissionView[];
  /** System ids the pilot has visited on this server. */
  visited: string[];
  /** Body scans not yet sold: `[systemId, bodyId]`. */
  scans: [string, number][];
  wing: { id: string; members: { id: string; name: string }[] } | null;
  /** Site id of the last station docked at (respawn point). */
  homeSite: number | null;
  homeSystem: string | null;
  /** Deductible the pilot would pay right now to get this ship back after losing it. */
  rebuy: number;
  /**
   * Import licence on this server, in trade units (tonnes times catalog price): `cap` is what
   * the pilot's non-trade income here allows in total, `used` what has been absorbed so far.
   */
  licence: { cap: number; used: number };
  /**
   * Parts of the ship that are bound here (brought from a server outside the customs union):
   * they refund nothing and leave no scrap or parts. Null when nothing is bound.
   */
  shipBound: ShipBinding | null;
}

export interface SectorView {
  id: string;
  name: string;
  url: string;
  pos: Vec3;
  radius: number;
  /** True when this server has heard from the sector recently. */
  online: boolean;
  /** True when the sector is directly peered with this server. */
  linked: boolean;
  /** The rating this server's operator gave the sector. */
  trust: TrustLevel;
  /** The tier that actually applies: `trust`, or `partner` while a customs union is not mutual. */
  tier: TrustLevel;
  /** Whether the sector publishes the same rules fingerprint as this server. */
  rulesMatch: boolean;
  /** Trade units of imports from the sector that can still be absorbed here; null when unlimited. */
  allowance: number | null;
  players: number;
  systems: SystemSummary[];
  links: string[];
  gates: GateLink[];
}

export interface GalaxyView {
  /** Id of the server that produced the view. */
  self: string;
  sectors: SectorView[];
}

export interface ChatMessage {
  ch: ChatChannel;
  from: { id: string; name: string; server?: string };
  text: string;
  /** Milliseconds since the Unix epoch. */
  at: number;
}

export type AuthFailCode = 'proto' | 'signature' | 'ticket' | 'banned' | 'full' | 'elsewhere' | 'internal';

export type NoticeLevel = 'info' | 'warn' | 'danger';

export type S2C =
  | { t: 'challenge'; nonce: string; server: { id: string; name: string; proto: number; version: string } }
  /**
   * Authentication failed. With code `elsewhere` the pilot's ship is in another sector and
   * `redirect` says where to connect instead.
   */
  | { t: 'authFail'; code: AuthFailCode; msg: string; redirect?: { server: string; url: string } }
  | { t: 'welcome'; pilot: PilotView; server: { id: string; name: string; rules: ServerRules }; universeTime: number; tick: number }
  /** The pilot entered a system. `self` is the entity id of the pilot's ship. */
  | { t: 'system'; def: SystemDef; self: number }
  /** A site changed (gate progress, new construction). */
  | { t: 'site'; system: string; site: SiteDef }
  | { t: 'ent+'; e: EntityInfo[] }
  | { t: 'ent-'; ids: number[] }
  | { t: 'ev'; e: GameEvent[] }
  | { t: 'pilot'; p: Partial<PilotView> }
  | { t: 'station'; s: StationView | null }
  | { t: 'galaxy'; g: GalaxyView }
  | { t: 'chat'; m: ChatMessage }
  | { t: 'res'; id: number; ok: boolean; err?: string; data?: unknown }
  | { t: 'pong'; c: number; s: number; u: number }
  /** Continue on another server: connect to `url`, authenticate, present `ticket`. */
  | { t: 'handoff'; server: string; url: string; ticket: Signed<TransferTicket> }
  | { t: 'notice'; level: NoticeLevel; code: string; text: string }
  | { t: 'kick'; reason: string };

/** Text signed by the client to authenticate: binds the challenge to the server it came from. */
export const authMessage = (nonce: string, serverId: string): string => `${serverId}:${nonce}`;

export const encodeMsg = (m: C2S | S2C): string => JSON.stringify(m);
