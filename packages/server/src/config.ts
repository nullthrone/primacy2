import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SECTOR_RADIUS,
  HULLS,
  MAX_SYSTEMS_PER_SECTOR,
  TRUST_LEVELS,
  defaultShipLimit,
  isValidId,
  isValidServerUrl,
  type TrustLevel,
  type Vec3,
} from '@primacy2/shared';

export interface ServerConfig {
  /** Sector name shown on the galaxy map. */
  name: string;
  host: string;
  port: number;
  /** URL other servers and players reach this server at, e.g. `https://example.org`. */
  publicUrl: string;
  /** Directory for the database. `:memory:` keeps nothing. */
  dataDir: string;
  /** Seed for the procedural sector. Changing it changes every system. */
  seed: string;
  /** Number of star systems in the sector. */
  systems: number;
  sectorRadius: number;
  /** Fixed sector centre in galactic light years. Chosen automatically on first start when absent. */
  position?: Vec3;
  /** Base URLs of servers to peer with on start. */
  peers: string[];
  /** Accept peering requests from servers that are not listed in `peers` or `trust`. */
  openPeering: boolean;
  /** Rating of servers without an entry in `trust`: `partner`, `visitor` or `blocked`. */
  defaultTrust: TrustLevel;
  /**
   * Per-server ratings, keyed by server id: `union`, `partner`, `visitor` or `blocked`.
   * `union` only takes effect while the other server rates this one `union` too and runs the same rules.
   */
  trust: Record<string, TrustLevel>;
  /** Tariff rate on cargo imported from `partner` servers, 0..1. */
  tariff: number;
  /** Trade units (tonnes times catalog price) a partner's imports may exceed this server's exports to it. */
  tradeCredit: number;
  /** Credit lines for single servers, keyed by server id; each replaces `tradeCredit` for that server. */
  tradeCredits: Record<string, number>;
  /** Extra credit line while an active warp gate links this server and the partner. */
  gateTradeCredit: number;
  /**
   * Trade units of imports every pilot may have absorbed here without having earned anything yet:
   * about one small hold, so that a first trade run into a partner sector can be sold. All pilots
   * together stay within the partner's trade balance, which is what bounds a flood of new pilots;
   * 0 makes every pilot earn the licence first.
   */
  importLicenceBase: number;
  /** Trade units of imports a pilot may have absorbed per credit of non-trade income earned here, on top of the base. */
  importLicenceRate: number;
  /**
   * Largest hull, as a hull id, that a ship from a partner or from a visitor may have; hulls with
   * a higher catalog price are turned away. `null` is no limit. Customs union members have none.
   */
  shipLimit: { partner: string | null; visitor: string | null };
  /** Share (0..1) of ship and fit value a destroyed pilot pays to get the ship back. */
  insuranceRate: number;
  maxPlayers: number;
  /** Simultaneous connections accepted from one address. */
  maxConnectionsPerIp: number;
  /** Set when the server runs behind a reverse proxy that sets X-Forwarded-For. */
  trustProxy: boolean;
  /** Credits a new pilot starts with. */
  startCredits: number;
  /** Directory with the built client; served at `/`. */
  clientDir: string;
  /** Milliseconds to wait for a bootstrap peer before placing the sector standalone. */
  bootstrapWaitMs: number;
  /**
   * Warp gates this server wants to build. `peer` is the id of a linked server; `system` is the
   * index of the local system that hosts this end (default: the one closest to the peer).
   */
  gates: { peer: string; system?: number }[];
  /** Accept gate proposals from linked servers rated `partner` or `union`. */
  acceptGates: boolean;
  /** Upper limit of warp gates in this sector, proposed and accepted together. */
  maxGates: number;
  /** Multiplier on what this sector's half of a warp gate costs (credits and materials). */
  gateCostScale: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  name: 'Unnamed Sector',
  host: '0.0.0.0',
  port: 8420,
  publicUrl: '',
  dataDir: './data',
  seed: 'primacy2',
  systems: 16,
  sectorRadius: DEFAULT_SECTOR_RADIUS,
  peers: [],
  openPeering: true,
  defaultTrust: 'visitor',
  trust: {},
  tariff: 0.12,
  tradeCredit: 50_000,
  tradeCredits: {},
  gateTradeCredit: 250_000,
  importLicenceBase: 2_000,
  importLicenceRate: 1,
  shipLimit: defaultShipLimit(),
  insuranceRate: 0.05,
  maxPlayers: 200,
  maxConnectionsPerIp: 16,
  trustProxy: false,
  startCredits: 2_500,
  clientDir: resolve(import.meta.dirname, '../../client/dist'),
  bootstrapWaitMs: 8_000,
  gates: [],
  acceptGates: true,
  maxGates: 6,
  gateCostScale: 1,
};

const LEVELS = new Set<string>(TRUST_LEVELS);
/** Names the ratings had before the trade model; a config that still uses one is told the new name. */
const OLD_LEVELS: Record<string, string> = { trusted: 'union', neutral: 'partner', restricted: 'visitor' };

function levelProblem(key: string, level: unknown): string | null {
  if (typeof level === 'string' && LEVELS.has(level)) return null;
  if (typeof level === 'string' && Object.hasOwn(OLD_LEVELS, level)) return `${key}: "${level}" is now called "${OLD_LEVELS[level]}"`;
  return `${key} must be union, partner, visitor or blocked`;
}

/** Merges overrides into the defaults and validates the result. Throws with a readable message. */
export function makeConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  const c: ServerConfig = {
    ...DEFAULT_CONFIG, ...over,
    trust: { ...(over.trust ?? {}) }, peers: [...(over.peers ?? [])], gates: [...(over.gates ?? [])],
    tradeCredits: { ...(over.tradeCredits ?? {}) },
    shipLimit: { ...DEFAULT_CONFIG.shipLimit, ...(over.shipLimit ?? {}) },
  };
  if (!c.publicUrl) c.publicUrl = `http://localhost:${c.port}`;
  c.publicUrl = c.publicUrl.replace(/\/+$/, '');
  const problems: string[] = [];
  if (typeof c.name !== 'string' || c.name.length < 1 || c.name.length > 48) problems.push('name must be 1..48 characters');
  if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535) problems.push('port must be 0..65535');
  if (!isValidServerUrl(c.publicUrl)) problems.push(`publicUrl "${c.publicUrl}" must look like http(s)://host[:port]`);
  if (!Number.isInteger(c.systems) || c.systems < 1 || c.systems > MAX_SYSTEMS_PER_SECTOR) {
    problems.push(`systems must be 1..${MAX_SYSTEMS_PER_SECTOR}`);
  }
  if (!(c.sectorRadius >= 4 && c.sectorRadius <= 200)) problems.push('sectorRadius must be 4..200 light years');
  if (c.position && !(Array.isArray(c.position) && c.position.length === 3 && c.position.every(Number.isFinite))) {
    problems.push('position must be [x, y, z] in light years');
  }
  const defaultProblem = levelProblem('defaultTrust', c.defaultTrust);
  if (defaultProblem) problems.push(defaultProblem);
  else if (c.defaultTrust === 'union') problems.push('defaultTrust cannot be union: a customs union is agreed per server, in trust');
  for (const [id, level] of Object.entries(c.trust)) {
    const p = levelProblem(`trust.${id}`, level);
    if (p) problems.push(p);
  }
  const isUnits = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e12;
  if (!isUnits(c.tradeCredit)) problems.push('tradeCredit must be a number of trade units, 0 or more');
  for (const [id, units] of Object.entries(c.tradeCredits)) {
    if (!isValidId(id)) problems.push(`tradeCredits: "${id}" is not a server id`);
    else if (!isUnits(units)) problems.push(`tradeCredits.${id} must be a number of trade units, 0 or more`);
  }
  if (!isUnits(c.gateTradeCredit)) problems.push('gateTradeCredit must be a number of trade units, 0 or more');
  if (!isUnits(c.importLicenceBase)) problems.push('importLicenceBase must be a number of trade units, 0 or more');
  if (!(typeof c.importLicenceRate === 'number' && c.importLicenceRate >= 0 && c.importLicenceRate <= 1000)) {
    problems.push('importLicenceRate must be 0..1000');
  }
  for (const tier of ['partner', 'visitor'] as const) {
    const hull = c.shipLimit[tier];
    if (hull !== null && !(typeof hull === 'string' && Object.hasOwn(HULLS, hull))) {
      problems.push(`shipLimit.${tier} must be a hull id (${Object.keys(HULLS).join(', ')}) or null`);
    }
  }
  for (const p of c.peers) if (!isValidServerUrl(p.replace(/\/+$/, ''))) problems.push(`peer "${p}" is not a valid server URL`);
  c.peers = c.peers.map((p) => p.replace(/\/+$/, ''));
  if (!(c.tariff >= 0 && c.tariff <= 1)) problems.push('tariff must be 0..1');
  if (!(c.insuranceRate >= 0 && c.insuranceRate <= 1)) problems.push('insuranceRate must be 0..1');
  for (const g of c.gates) {
    if (!g || typeof g.peer !== 'string' || !/^[a-z2-7]{16}$/.test(g.peer)) problems.push('gates[].peer must be a server id');
    else if (g.system !== undefined && !(Number.isInteger(g.system) && g.system >= 0 && g.system < c.systems)) {
      problems.push(`gates[].system must be a system index below ${c.systems}`);
    }
  }
  if (!Number.isInteger(c.maxGates) || c.maxGates < 0 || c.maxGates > 32) problems.push('maxGates must be 0..32');
  if (!(c.gateCostScale >= 0.0001 && c.gateCostScale <= 100)) problems.push('gateCostScale must be 0.0001..100');
  if (problems.length) throw new Error('Invalid configuration:\n  - ' + problems.join('\n  - '));
  return c;
}

/**
 * Loads configuration from a JSON file (default `primacy2.config.json` in the working directory),
 * then applies `PRIMACY2_*` environment variables and `--key=value` command line arguments.
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const args = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(a);
    if (m) args.set(m[1]!, m[2] ?? 'true');
  }
  const file = resolve(args.get('config') ?? env.PRIMACY2_CONFIG ?? 'primacy2.config.json');
  let over: Partial<ServerConfig> = {};
  if (existsSync(file)) {
    try {
      over = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServerConfig>;
    } catch (err) {
      throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
    }
  }
  const pick = (key: string): string | undefined => args.get(key) ?? env['PRIMACY2_' + key.toUpperCase()];
  const name = pick('name');
  if (name) over.name = name;
  const port = pick('port');
  if (port) over.port = Number(port);
  const host = pick('host');
  if (host) over.host = host;
  const url = pick('publicUrl') ?? env.PRIMACY2_PUBLIC_URL;
  if (url) over.publicUrl = url;
  const dataDir = pick('dataDir') ?? env.PRIMACY2_DATA_DIR;
  if (dataDir) over.dataDir = dataDir;
  const seed = pick('seed');
  if (seed) over.seed = seed;
  const systems = pick('systems');
  if (systems) over.systems = Number(systems);
  const peers = pick('peers');
  if (peers) over.peers = peers.split(',').map((s) => s.trim()).filter(Boolean);
  return makeConfig(over);
}
