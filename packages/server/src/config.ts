import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SECTOR_RADIUS,
  MAX_SYSTEMS_PER_SECTOR,
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
  defaultTrust: TrustLevel;
  /** Per-server trust overrides, keyed by server id. */
  trust: Record<string, TrustLevel>;
  /** Tariff rate on cargo imported from `neutral` peers, 0..1. */
  tariff: number;
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
  /** Accept gate proposals from linked servers that are not `restricted` or `blocked`. */
  acceptGates: boolean;
  /** Upper limit of warp gates in this sector, proposed and accepted together. */
  maxGates: number;
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
  defaultTrust: 'neutral',
  trust: {},
  tariff: 0.12,
  maxPlayers: 200,
  maxConnectionsPerIp: 16,
  trustProxy: false,
  startCredits: 2_500,
  clientDir: resolve(import.meta.dirname, '../../client/dist'),
  bootstrapWaitMs: 8_000,
  gates: [],
  acceptGates: true,
  maxGates: 6,
};

const TRUST_LEVELS = new Set(['trusted', 'neutral', 'restricted', 'blocked']);

/** Merges overrides into the defaults and validates the result. Throws with a readable message. */
export function makeConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  const c: ServerConfig = {
    ...DEFAULT_CONFIG, ...over,
    trust: { ...(over.trust ?? {}) }, peers: [...(over.peers ?? [])], gates: [...(over.gates ?? [])],
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
  if (!TRUST_LEVELS.has(c.defaultTrust)) problems.push('defaultTrust must be trusted, neutral, restricted or blocked');
  for (const [id, level] of Object.entries(c.trust)) {
    if (!TRUST_LEVELS.has(level)) problems.push(`trust.${id} has an unknown level "${level}"`);
  }
  for (const p of c.peers) if (!isValidServerUrl(p.replace(/\/+$/, ''))) problems.push(`peer "${p}" is not a valid server URL`);
  c.peers = c.peers.map((p) => p.replace(/\/+$/, ''));
  if (!(c.tariff >= 0 && c.tariff <= 1)) problems.push('tariff must be 0..1');
  for (const g of c.gates) {
    if (!g || typeof g.peer !== 'string' || !/^[a-z2-7]{16}$/.test(g.peer)) problems.push('gates[].peer must be a server id');
    else if (g.system !== undefined && !(Number.isInteger(g.system) && g.system >= 0 && g.system < c.systems)) {
      problems.push(`gates[].system must be a system index below ${c.systems}`);
    }
  }
  if (!Number.isInteger(c.maxGates) || c.maxGates < 0 || c.maxGates > 32) problems.push('maxGates must be 0..32');
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
