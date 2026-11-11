/**
 * Assembles a PRIMACY2 server: identity, sector, world, federation, HTTP and WebSocket endpoints.
 */
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  GAME_VERSION,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  TICK_RATE,
  chooseSectorCenter,
  computeShipStats,
  generateKeyPair,
  generateSector,
  idFromPublicKey,
  sectorOffsets,
  signDescriptor,
  starterLoadout,
  summarize,
  type GateLink,
  type KeyPair,
  type ServerDescriptor,
  type Signed,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import { makeConfig, type ServerConfig } from './config.ts';
import { Federation, type FetchLike } from './federation.ts';
import type { GameModule } from './game.ts';
import { createHttpHandler } from './http.ts';
import { defaultModules } from './modules/index.ts';
import { Session } from './session.ts';
import { Store } from './store.ts';
import { World } from './world.ts';

export interface ServerOptions {
  /** Wall clock in milliseconds. Tests inject a controllable clock. */
  now?: () => number;
  /** Run the simulation on a timer. Tests set this to false and call `tick()` themselves. */
  autoTick?: boolean;
  log?: (msg: string) => void;
  fetch?: FetchLike;
  /** Gameplay modules; defaults to the full set. */
  modules?: GameModule[];
}

export interface PrimacyServer {
  readonly id: string;
  readonly config: ServerConfig;
  readonly world: World;
  readonly fed: Federation;
  readonly store: Store;
  /** Base URL the server is reachable at (resolved after listening). */
  readonly url: string;
  descriptor(): Signed<ServerDescriptor>;
  /** Advances the simulation by one tick. */
  tick(): void;
  /** Connects to the configured peers. Resolves when the first round has finished. */
  peer(): Promise<void>;
  stop(): Promise<void>;
}

/** Starts a server and resolves once it accepts connections. */
export async function startServer(over: Partial<ServerConfig> = {}, opts: ServerOptions = {}): Promise<PrimacyServer> {
  let config = makeConfig(over);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`));

  let dbPath = ':memory:';
  if (config.dataDir !== ':memory:') {
    const dir = resolve(config.dataDir);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, 'primacy2.sqlite');
  }
  const store = new Store(dbPath);

  let keys = store.getKv<KeyPair>('identity');
  if (!keys) {
    keys = generateKeyPair();
    store.setKv('identity', keys);
  }
  const id = idFromPublicKey(keys.publicKey);

  // Listen first so that the public URL is known even with an ephemeral port (port 0).
  let handler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | null = null;
  const http: HttpServer = createHttpServer((req, res) => {
    if (!handler) {
      res.writeHead(503, { 'retry-after': '2' }).end('starting');
      return;
    }
    void handler(req, res);
  });
  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(config.port, config.host, () => ok());
  });
  const port = (http.address() as AddressInfo).port;
  if (!over.publicUrl) config = makeConfig({ ...over, port, publicUrl: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}` });
  else config = makeConfig({ ...over, port });

  let world: World | null = null;
  let cached: { at: number; signed: Signed<ServerDescriptor> } | null = null;
  let defs: SystemDef[] = [];
  let sectorPos: Vec3 = [0, 0, 0];

  const descriptor = (): Signed<ServerDescriptor> => {
    const t = now();
    if (cached && t - cached.at < 1500) return cached.signed;
    const gates: GateLink[] = [];
    for (const def of defs) {
      for (const site of def.sites) {
        if (site.gate) {
          gates.push({
            linkId: site.gate.linkId, system: def.id, site: site.id, peer: site.gate.peer,
            remoteSystem: site.gate.remoteSystem, state: site.gate.state, progress: site.gate.progress,
          });
        }
      }
    }
    const desc: ServerDescriptor = {
      v: 1, id, name: config.name, url: config.publicUrl, proto: PROTOCOL_VERSION, version: GAME_VERSION,
      pos: sectorPos, radius: config.sectorRadius,
      systems: defs.map(summarize),
      links: fed.links().map((k) => k.id),
      gates,
      rules: { openPeering: config.openPeering, defaultTrust: config.defaultTrust, tariff: config.tariff },
      online: world?.players.size ?? 0,
      updatedAt: t,
    };
    cached = { at: t, signed: signDescriptor(desc, keys!) };
    return cached.signed;
  };

  const fed = new Federation({ id, keys, config, store, now, descriptor, log }, opts.fetch);

  // Sector placement happens once; afterwards the position is part of the server's identity.
  const offsets = sectorOffsets(id, config.seed, config.sectorRadius, config.systems);
  const storedPos = store.getKv<Vec3>('sectorPos');
  if (storedPos) {
    sectorPos = storedPos;
  } else {
    const reach = computeShipStats(starterLoadout()).jumpRange;
    if (config.position) {
      sectorPos = config.position;
    } else {
      let placed: Vec3 | null = null;
      const deadline = Date.now() + (config.peers.length ? config.bootstrapWaitMs : 0);
      while (!placed && config.peers.length) {
        for (const url of config.peers) {
          const probed = await fed.probe(url);
          if (!probed) continue;
          const peer = probed.desc.body;
          placed = chooseSectorCenter({
            serverId: id, offsets, radius: config.sectorRadius, reach,
            peer: { pos: peer.pos, radius: peer.radius, systems: peer.systems },
            others: probed.known.filter((d) => d.body.id !== peer.id && d.body.id !== id).map((d) => ({ pos: d.body.pos, radius: d.body.radius })),
          });
          log(`sector placed next to ${peer.name} (${peer.id})`);
          break;
        }
        if (placed || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!placed) {
        if (config.peers.length) log('no bootstrap peer answered; placing the sector standalone');
        placed = chooseSectorCenter({ serverId: id, offsets, radius: config.sectorRadius, reach, peer: null, others: [] });
      }
      sectorPos = placed;
    }
    store.setKv('sectorPos', sectorPos);
  }

  defs = generateSector({ serverId: id, seed: config.seed, center: sectorPos, radius: config.sectorRadius, count: config.systems });
  world = new World({ id, keys, config, store, fed, now, log, descriptor }, defs, opts.modules ?? defaultModules());
  const theWorld = world;
  fed.onChange = () => {
    cached = null;
  };

  handler = createHttpHandler(theWorld, fed, config.clientDir);
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  wss.on('connection', (ws) => new Session(ws, theWorld));

  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.autoTick !== false) {
    const stepMs = 1000 / TICK_RATE;
    let next = performance.now() + stepMs;
    timer = setInterval(() => {
      const t = performance.now();
      let steps = 0;
      // Catch up after a stall, but never spiral: at most five ticks per timer callback.
      while (t >= next && steps < 5) {
        try {
          theWorld.step();
        } catch (err) {
          log(`tick failed: ${(err as Error).stack ?? err}`);
        }
        next += stepMs;
        steps++;
      }
      if (t - next > 1000) next = t + stepMs;
    }, stepMs / 2);
    fed.start();
  }

  log(`sector "${config.name}" (${id}) with ${defs.length} systems at ${config.publicUrl}`);

  return {
    id, config, world: theWorld, fed, store,
    url: config.publicUrl,
    descriptor,
    tick: () => theWorld.step(),
    async peer() {
      await Promise.all(config.peers.map((url) => fed.peerWith(url)));
    },
    async stop() {
      if (timer) clearInterval(timer);
      fed.stop();
      theWorld.saveAll();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((ok) => wss.close(() => ok()));
      await new Promise<void>((ok) => {
        http.close(() => ok());
        http.closeAllConnections?.();
      });
      store.close();
    },
  };
}
