/**
 * The world of one server: its systems, online pilots, the tick loop, logins and handoffs.
 */
import {
  ChargeKind,
  DT,
  FOLD_TUNNEL_TIME,
  FlightMode,
  PEER_TIMEOUT_MS,
  Rng,
  SITE_ID_BASE,
  UNIVERSE_EPOCH_MS,
  findSite,
  foldFuelCost,
  isValidAnchor,
  issueTicket,
  newPassport,
  newShipState,
  placeAtFoldArrival,
  placeAtSite,
  quat,
  randomNonce,
  sanitizePassport,
  v3,
  verifyTicket,
  type Arrival,
  type Command,
  type GalaxyView,
  type KeyPair,
  type PilotView,
  type S2C,
  type SectorView,
  type ServerDescriptor,
  type ShipState,
  type Signed,
  type SiteDef,
  type StationView,
  type SystemDef,
  type TransferTicket,
} from '@primacy2/shared';
import type { ServerConfig } from './config.ts';
import type { Federation, KnownServer } from './federation.ts';
import { Player, newShip, type CommandHandler, type CommandResult, type Connection, type GameModule, type Ship } from './game.ts';
import { SystemSim } from './sim.ts';
import type { PlayerRecord, Store } from './store.ts';

export interface WorldHost {
  readonly id: string;
  readonly keys: KeyPair;
  readonly config: ServerConfig;
  readonly store: Store;
  readonly fed: Federation;
  now(): number;
  log(msg: string): void;
  descriptor(): Signed<ServerDescriptor>;
}

export type LoginResult =
  | { ok: true; player: Player }
  | { ok: false; code: 'ticket' | 'banned' | 'full' | 'elsewhere' | 'internal'; msg: string; redirect?: { server: string; url: string } };

const IDLE_SIM_TICKS = 30 * 30;
const AUTOSAVE_TICKS = 30 * 20;

export class World {
  readonly sims = new Map<string, SystemSim>();
  readonly defs = new Map<string, SystemDef>();
  readonly players = new Map<string, Player>();
  readonly modules: GameModule[];
  tickCount = 0;
  private nextId = 1;
  private readonly commands = new Map<string, CommandHandler>();
  private readonly rng: Rng;

  constructor(
    readonly host: WorldHost,
    defs: SystemDef[],
    modules: GameModule[],
  ) {
    for (const d of defs) this.defs.set(d.id, d);
    this.modules = modules;
    this.rng = new Rng(host.id + ':' + host.now());
    for (const m of modules) {
      for (const [kind, fn] of Object.entries(m.commands ?? {})) {
        if (this.commands.has(kind)) throw new Error(`command "${kind}" is handled by two modules`);
        this.commands.set(kind, fn as CommandHandler);
      }
    }
    for (const m of modules) m.init?.(this);
  }

  get id(): string {
    return this.host.id;
  }
  get store(): Store {
    return this.host.store;
  }
  get fed(): Federation {
    return this.host.fed;
  }
  get config(): ServerConfig {
    return this.host.config;
  }

  /** Universe time in seconds. */
  time(): number {
    return (this.host.now() - UNIVERSE_EPOCH_MS) / 1000;
  }

  allocId(): number {
    const id = this.nextId++;
    if (this.nextId > 0xfffffff0) this.nextId = 1;
    return id;
  }

  random(): Rng {
    return this.rng;
  }

  /** The simulation of a system, created on first use. Throws for unknown system ids. */
  sim(systemId: string): SystemSim {
    let s = this.sims.get(systemId);
    if (!s) {
      const def = this.defs.get(systemId);
      if (!def) throw new Error(`unknown system ${systemId}`);
      s = new SystemSim(this, def);
      this.sims.set(systemId, s);
    }
    return s;
  }

  /** The capital system and its main station: where new pilots start and stranded pilots respawn. */
  capital(): { system: SystemDef; site: SiteDef } {
    const system = this.defs.get(`${this.id}:0`)!;
    const site =
      system.sites.find((s) => s.kind === 'station') ?? system.sites.find((s) => s.kind === 'outpost') ?? system.sites[0];
    if (!site) throw new Error('the capital system has no site to spawn at');
    return { system, site };
  }

  // -------------------------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------------------------

  /** Advances the whole world by one simulation tick. */
  step(): void {
    this.tickCount++;
    const t = this.time();
    for (const [id, sim] of this.sims) {
      sim.tick(t, DT);
      if (sim.idleTicks > IDLE_SIM_TICKS && sim.players.size === 0) this.sims.delete(id);
    }
    if (this.tickCount % 150 === 0) {
      const now = this.host.now();
      for (const m of this.modules) m.worldTick?.(this, now);
    }
    if (this.tickCount % AUTOSAVE_TICKS === 0) {
      for (const p of this.players.values()) this.save(p);
      this.store.pruneNonces(this.host.now());
    }
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  pilotView(p: Player): PilotView {
    const view: PilotView = {
      id: p.id,
      name: p.name,
      credits: p.rec.credits,
      passport: p.rec.passport,
      bounty: 0,
      wanted: false,
      reputation: {},
      missions: [],
      visited: [],
      scans: [],
      wing: null,
      homeSite: p.rec.homeSite,
      homeSystem: p.rec.homeSystem,
    };
    for (const m of this.modules) m.pilotView?.(p, view);
    return view;
  }

  /** Sends the pilot their complete own state. Call after anything in it changed. */
  pushPilot(p: Player): void {
    this.syncPassport(p);
    p.send({ t: 'pilot', p: this.pilotView(p) });
  }

  stationView(p: Player): StationView | null {
    const ship = p.ship;
    if (!ship || !p.sim || ship.state.mode !== FlightMode.Docked) return null;
    const site = findSite(p.sim.def, ship.state.anchor);
    if (!site) return null;
    const view: StationView = {
      site: site.id, name: site.name, services: site.services ?? [], faction: site.faction,
      market: [], modules: [], hulls: [], missions: [], fuelPrice: 0, repairPrice: 0, dataValue: 0,
      gateProjects: [], tariffs: {},
    };
    for (const m of this.modules) m.stationView?.(p, p.sim, site.id, view);
    return view;
  }

  pushStation(p: Player): void {
    p.send({ t: 'station', s: this.stationView(p) });
  }

  galaxyView(): GalaxyView {
    const own = this.host.descriptor().body;
    const sectors: SectorView[] = [
      {
        id: own.id, name: own.name, url: own.url, pos: own.pos, radius: own.radius, online: true, linked: true,
        trust: 'trusted', players: this.players.size, systems: own.systems, links: own.links, gates: own.gates,
      },
    ];
    for (const k of this.fed.known.values()) {
      const trust = this.fed.trustOf(k.id);
      if (trust === 'blocked') continue;
      sectors.push({
        id: k.id, name: k.desc.name, url: k.desc.url, pos: k.desc.pos, radius: k.desc.radius,
        online: this.fed.isOnline(k), linked: k.linked, trust, players: k.desc.online,
        systems: k.desc.systems, links: k.desc.links, gates: k.desc.gates,
      });
    }
    return { self: this.id, sectors };
  }

  broadcast(msg: S2C): void {
    for (const p of this.players.values()) p.send(msg);
  }

  // -------------------------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------------------------

  /**
   * Admits an authenticated connection. `key` has already been proven by the challenge signature.
   * With a ticket, the pilot arrives from another server; without one, they resume or start here.
   */
  async login(conn: Connection, key: string, playerId: string, name: string, ticket: Signed<TransferTicket> | undefined): Promise<LoginResult> {
    if (this.players.size >= this.config.maxPlayers && !this.players.has(playerId)) {
      return { ok: false, code: 'full', msg: 'This sector is full.' };
    }
    let rec = this.store.loadPlayer(playerId);
    let arrival: Arrival | null = null;
    let from: KnownServer | null = null;

    if (ticket) {
      const res = await this.acceptTicket(ticket, key, playerId, rec);
      if (!res.ok) return { ok: false, code: 'ticket', msg: res.msg };
      rec = res.rec;
      arrival = res.arrival;
      from = res.from;
    } else if (!rec) {
      const cap = this.capital();
      rec = {
        id: playerId, key, passport: newPassport(playerId, name, this.id), credits: this.config.startCredits,
        status: 'here', system: cap.system.id, ship: null, homeSystem: cap.system.id, homeSite: cap.site.id,
        data: {}, createdAt: this.host.now(), updatedAt: this.host.now(),
      };
    } else if (rec.status === 'transit') {
      // The pilot came back before the ticket was redeemed: void it. A later redemption attempt fails.
      rec.status = 'here';
      delete rec.away;
    } else if (rec.status === 'away' && rec.away) {
      const dest = this.fed.known.get(rec.away.server);
      const reachable = dest && this.host.now() - dest.lastSeen < PEER_TIMEOUT_MS * 4;
      if (dest && reachable) {
        return {
          ok: false, code: 'elsewhere', msg: `Your ship is in ${dest.desc.name}.`,
          redirect: { server: dest.id, url: dest.desc.url },
        };
      }
      // The sector the pilot left for is gone: restore the ship as it was when it departed.
      this.host.log(`recalling ${rec.passport.name}: sector ${rec.away.server} is unreachable`);
      rec.status = 'here';
      delete rec.away;
    }

    // One connection per pilot: a newer login replaces the older one.
    const old = this.players.get(playerId);
    if (old) {
      old.conn?.close('Signed in from another connection.');
      this.detach(old);
    }

    const player = new Player(rec);
    player.conn = conn;
    this.players.set(playerId, player);
    try {
      this.place(player, arrival);
    } catch (err) {
      this.players.delete(playerId);
      this.host.log(`login placement failed for ${playerId}: ${(err as Error).stack ?? err}`);
      return { ok: false, code: 'internal', msg: 'Could not place your ship.' };
    }
    if (from) for (const m of this.modules) m.onArrival?.(player, from);
    this.save(player);
    return { ok: true, player };
  }

  private async acceptTicket(
    signed: Signed<TransferTicket>,
    key: string,
    playerId: string,
    existing: PlayerRecord | undefined,
  ): Promise<{ ok: true; rec: PlayerRecord; arrival: Arrival; from: KnownServer } | { ok: false; msg: string }> {
    const now = this.host.now();
    const v = verifyTicket(signed, { selfId: this.id, playerKey: key, nowMs: now });
    if (!v.ok) return { ok: false, msg: `Transfer refused: ${v.reason}.` };
    const t = v.value;
    const issuer = this.fed.known.get(t.issuer);
    if (!issuer) return { ok: false, msg: 'Transfer refused: the issuing sector is unknown here.' };
    const trust = this.fed.trustOf(t.issuer);
    if (trust === 'blocked') return { ok: false, msg: 'Transfer refused: the issuing sector is blocked here.' };
    if (!this.defs.has(t.arrival.system)) return { ok: false, msg: 'Transfer refused: unknown destination system.' };
    if (t.arrival.kind === 'gate' && (t.arrival.site === undefined || !findSite(this.defs.get(t.arrival.system)!, t.arrival.site))) {
      return { ok: false, msg: 'Transfer refused: unknown destination gate.' };
    }
    if (!this.store.claimNonce(t.nonce, t.expiresAt + 60_000)) return { ok: false, msg: 'Transfer refused: ticket already used.' };

    let redeemed = false;
    try {
      redeemed = await this.fed.redeem(issuer, t.nonce, playerId);
    } catch {
      // Only a fully trusted issuer is believed on its signature alone when it cannot be asked.
      if (trust !== 'trusted') {
        this.store.releaseNonce(t.nonce);
        return { ok: false, msg: 'Transfer refused: the issuing sector did not answer.' };
      }
      redeemed = true;
    }
    if (!redeemed) return { ok: false, msg: 'Transfer refused: the issuing sector did not confirm the ticket.' };

    const passport = sanitizePassport(t.passport, playerId, { issuer: t.issuer, impoundCargo: trust === 'restricted' });
    passport.seq += 1;
    const firstVisit = !existing;
    if (firstVisit) passport.stats.sectors += 1;
    const rec: PlayerRecord = existing ?? {
      id: playerId, key, passport, credits: 0, status: 'here', system: t.arrival.system, ship: null,
      homeSystem: null, homeSite: null, data: {}, createdAt: now, updatedAt: now,
    };
    rec.key = key;
    rec.passport = passport;
    rec.status = 'here';
    delete rec.away;
    rec.system = t.arrival.system;
    rec.ship = null;
    return { ok: true, rec, arrival: t.arrival, from: issuer };
  }

  /** Puts a pilot's ship into the world: at a ticket arrival point, at its saved state, or docked at home. */
  private place(p: Player, arrival: Arrival | null): void {
    const rec = p.rec;
    const t = this.time();
    const stats = p.stats;
    const fresh = newShipState(stats);
    fresh.hull = Math.min(stats.hullMax, Math.max(1, rec.passport.ship.hull));
    fresh.fuel = Math.min(stats.fuelCap, Math.max(0, rec.passport.ship.fuel));
    let state: ShipState = fresh;
    let systemId = rec.system;

    if (arrival) {
      systemId = arrival.system;
      const def = this.defs.get(systemId)!;
      if (arrival.kind === 'gate' && arrival.site !== undefined) {
        placeAtSite(state, def, arrival.site, t, this.rng, 2_500);
      } else {
        const dir = arrival.from ? v3.normalize(v3.sub(arrival.from, def.pos)) : null;
        placeAtFoldArrival(state, def, t, dir && v3.lenSq(dir) > 0 ? dir : null, this.rng);
      }
    } else {
      const def = this.defs.get(systemId);
      const saved = rec.ship;
      if (def && saved && isUsableState(saved, def)) {
        state = { ...fresh, ...saved, pos: [...saved.pos], vel: [...saved.vel], rot: [...saved.rot], angVel: [...saved.angVel], aim: [0, 0] };
        state.hull = saved.mode === FlightMode.Dead ? 0 : Math.min(stats.hullMax, Math.max(1, saved.hull));
        state.shield = Math.min(stats.shieldMax, Math.max(0, saved.shield));
        state.fuel = Math.min(stats.fuelCap, Math.max(0, saved.fuel));
        state.chargeKind = ChargeKind.None;
        state.charge = 0;
      } else {
        const home = this.homeOf(rec);
        systemId = home.system.id;
        dockState(state, home.site.id);
      }
    }

    rec.system = systemId;
    const sim = this.sim(systemId);
    const ship = newShip(this.allocId(), p.name, rec.passport.ship.loadout, stats, state);
    ship.player = p;
    ship.cargo = rec.passport.ship.cargo;
    p.ship = ship;
    p.sim = sim;
    p.known.clear();
    p.inputs.length = 0;
    sim.addShip(ship);
  }

  private homeOf(rec: PlayerRecord): { system: SystemDef; site: SiteDef } {
    const def = rec.homeSystem ? this.defs.get(rec.homeSystem) : undefined;
    const site = def && rec.homeSite !== null ? findSite(def, rec.homeSite) : undefined;
    return def && site ? { system: def, site } : this.capital();
  }

  /** Sends everything a freshly placed pilot needs: system, own state and, when docked, the station. */
  greet(p: Player): void {
    if (!p.sim || !p.ship) return;
    p.send({ t: 'system', def: p.sim.def, self: p.ship.id });
    for (const m of this.modules) m.onPlayerEnterSystem?.(p, p.sim);
    this.pushPilot(p);
    if (p.ship.state.mode === FlightMode.Docked) this.pushStation(p);
  }

  /** Copies the live ship's hull and fuel into the passport. Cargo already lives there. */
  syncPassport(p: Player): void {
    if (!p.ship) return;
    p.rec.passport.ship.hull = Math.max(0, p.ship.state.hull);
    p.rec.passport.ship.fuel = Math.max(0, p.ship.state.fuel);
  }

  save(p: Player): void {
    this.syncPassport(p);
    if (p.ship && p.rec.status === 'here') {
      const s = p.ship.state;
      // A ship caught in a fold tunnel is saved as already arrived; `place` handles the rest.
      p.rec.ship = s.mode === FlightMode.Fold ? null : { ...s, pos: [...s.pos], vel: [...s.vel], rot: [...s.rot], angVel: [...s.angVel], aim: [0, 0] };
      p.rec.system = p.sim?.def.id ?? p.rec.system;
    }
    this.store.savePlayer(p.rec);
  }

  /** Removes a pilot's ship from the simulation without saving. */
  private detach(p: Player): void {
    for (const m of this.modules) m.onPlayerLeave?.(p);
    if (p.ship && p.sim) p.sim.removeShip(p.ship);
    p.sim?.players.delete(p);
    p.ship = null;
    p.sim = null;
    p.conn = null;
  }

  /** The connection of a pilot closed. */
  logout(p: Player): void {
    if (this.players.get(p.id) !== p) return;
    this.save(p);
    this.detach(p);
    this.players.delete(p.id);
  }

  saveAll(): void {
    for (const p of this.players.values()) this.save(p);
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  async handleCommand(p: Player, cmd: Command): Promise<CommandResult> {
    const fn = this.commands.get(cmd.k);
    if (!fn) return { ok: false, err: 'not available on this server' };
    try {
      return await fn(p, cmd as never, this);
    } catch (err) {
      this.host.log(`command ${cmd.k} failed: ${(err as Error).stack ?? err}`);
      return { ok: false, err: 'internal error' };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Travel
  // -------------------------------------------------------------------------------------------

  /** Resolves a system id on this or any known server to its summary and owning server (null = this server). */
  resolveSystem(systemId: string): { pos: [number, number, number]; name: string; server: KnownServer | null } | null {
    const own = this.defs.get(systemId);
    if (own) return { pos: own.pos, name: own.name, server: null };
    const sep = systemId.indexOf(':');
    if (sep < 0) return null;
    const k = this.fed.known.get(systemId.slice(0, sep));
    const s = k?.desc.systems.find((x) => x.id === systemId);
    return k && s ? { pos: s.pos, name: s.name, server: k } : null;
  }

  /** A fold charge completed: spend the fuel and leave the system. */
  startFold(ship: Ship, sim: SystemSim): void {
    const fold = ship.fold;
    const p = ship.player;
    ship.fold = null;
    if (!fold) return;
    const cost = foldFuelCost(fold.distance, ship.stats);
    if (!(ship.state.fuel >= cost)) {
      p?.notice('warn', 'fold_fuel', 'Not enough fuel for the jump.');
      return;
    }
    const target = this.resolveSystem(fold.system);
    if (!target) {
      p?.notice('warn', 'fold_lost', 'The destination is no longer known.');
      return;
    }
    ship.state.fuel -= cost;
    sim.emit(sim.zoneOf(ship), { e: 'fold', id: ship.id, out: true, at: v3.clone(ship.state.pos) });
    if (p) {
      p.rec.passport.stats.jumps++;
      p.rec.passport.stats.distance += fold.distance;
    }

    if (target.server) {
      if (!p) return;
      const res = this.handoff(p, target.server, { kind: 'fold', system: fold.system, from: sim.def.pos });
      if (!res.ok) {
        ship.state.fuel += cost;
        p.notice('warn', 'fold_refused', res.err);
      }
      return;
    }

    // Same server: the ship spends the tunnel time in the destination simulation, outside any zone.
    const from = sim.def.pos;
    sim.removeShip(ship);
    const dest = this.sim(fold.system);
    ship.state.mode = FlightMode.Fold;
    ship.state.anchor = -1;
    ship.state.vel = [0, 0, 0];
    ship.state.cruiseSpeed = 0;
    ship.tunnel = FOLD_TUNNEL_TIME;
    ship.fold = { system: fold.system, server: null, distance: fold.distance };
    ship.foldFrom = from;
    dest.addShip(ship);
    if (p) {
      p.sim = dest;
      p.rec.system = dest.def.id;
      p.known.clear();
      p.send({ t: 'system', def: dest.def, self: ship.id });
      for (const m of this.modules) m.onPlayerEnterSystem?.(p, dest);
      this.pushPilot(p);
    }
  }

  /** The tunnel of a same-server fold ended: the ship appears near the primary of the destination. */
  arriveFromFold(ship: Ship, sim: SystemSim): void {
    const from = ship.foldFrom;
    ship.foldFrom = null;
    const dir = from ? v3.normalize(v3.sub(from, sim.def.pos)) : null;
    placeAtFoldArrival(ship.state, sim.def, sim.time, dir && v3.lenSq(dir) > 0 ? dir : null, this.rng);
    ship.fold = null;
    ship.tunnel = 0;
    sim.emit(sim.zoneOf(ship), { e: 'fold', id: ship.id, out: false, at: v3.clone(ship.state.pos) });
  }

  /**
   * Sends a pilot to another server: issues a transfer ticket, removes the ship from this world
   * and marks the pilot in transit. The record stays so the pilot can come back.
   */
  handoff(p: Player, dest: KnownServer, arrival: Arrival): { ok: true } | { ok: false; err: string } {
    if (this.fed.trustOf(dest.id) === 'blocked') return { ok: false, err: 'That sector is blocked by this server.' };
    if (!this.fed.isOnline(dest)) return { ok: false, err: 'That sector is not answering.' };
    if (!p.ship) return { ok: false, err: 'No ship.' };
    this.syncPassport(p);
    const now = this.host.now();
    const nonce = randomNonce();
    const ticket = issueTicket(
      { issuer: this.id, dest: dest.id, playerKey: p.rec.key, passport: p.rec.passport, arrival, nonce, nowMs: now },
      this.host.keys,
    );
    // Remember where the ship was, so a cancelled or failed transfer puts it back there.
    this.save(p);
    p.rec.status = 'transit';
    p.rec.away = { server: dest.id, nonce, expiresAt: ticket.body.expiresAt, since: now };
    this.store.savePlayer(p.rec);
    p.send({ t: 'handoff', server: dest.id, url: dest.desc.url, ticket });
    const conn = p.conn;
    this.detach(p);
    this.players.delete(p.id);
    // Give the client a moment to read the handoff before the socket closes.
    setTimeout(() => conn?.close('Transferred to another sector.'), 3_000).unref?.();
    return { ok: true };
  }

  /** Another server asks to redeem a ticket this server issued. Succeeds once per ticket. */
  redeemTicket(fromServer: string, nonce: unknown, playerId: unknown): boolean {
    if (typeof nonce !== 'string' || typeof playerId !== 'string') return false;
    const rec = this.store.loadPlayer(playerId);
    if (!rec || !rec.away || rec.away.server !== fromServer || rec.away.nonce !== nonce) return false;
    if (rec.status === 'away') return true; // a retry of a redemption that already succeeded
    if (rec.status !== 'transit') return false;
    if (this.host.now() > rec.away.expiresAt + 60_000) return false;
    if (this.players.has(playerId)) return false; // the pilot is back here; the ticket is void
    rec.status = 'away';
    this.store.savePlayer(rec);
    return true;
  }

  /** Respawns a dead pilot docked at their home station with a repaired ship. */
  respawn(p: Player): boolean {
    const ship = p.ship;
    if (!ship || !p.sim || ship.state.mode !== FlightMode.Dead) return false;
    const home = this.homeOf(p.rec);
    p.sim.removeShip(ship);
    const state = newShipState(p.stats);
    state.fuel = Math.max(ship.state.fuel, p.stats.fuelCap * 0.25);
    dockState(state, home.site.id);
    ship.state = state;
    ship.fold = null;
    ship.target = null;
    const sim = this.sim(home.system.id);
    sim.addShip(ship);
    p.sim = sim;
    p.rec.system = home.system.id;
    p.known.clear();
    p.inputs.length = 0;
    this.greet(p);
    return true;
  }
}

function dockState(state: ShipState, siteId: number): void {
  state.mode = FlightMode.Docked;
  state.anchor = siteId;
  state.pos = [0, 0, 0];
  state.vel = [0, 0, 0];
  state.angVel = [0, 0, 0];
  state.rot = quat.identity();
  state.cruiseSpeed = 0;
  state.throttle = 0;
}

/** Whether a saved ship state can be loaded into this system as it is. */
function isUsableState(s: ShipState, def: SystemDef): boolean {
  if (!s || typeof s !== 'object') return false;
  if (s.mode !== FlightMode.Normal && s.mode !== FlightMode.Cruise && s.mode !== FlightMode.Docked && s.mode !== FlightMode.Dead) return false;
  if (!Array.isArray(s.pos) || !Array.isArray(s.vel) || !Array.isArray(s.rot) || !Array.isArray(s.angVel)) return false;
  if (!v3.isFinite(s.pos) || !v3.isFinite(s.vel) || !quat.isFinite(s.rot) || !v3.isFinite(s.angVel)) return false;
  if (!isValidAnchor(def, s.anchor)) return false;
  if (s.mode === FlightMode.Docked && s.anchor < SITE_ID_BASE) return false;
  return true;
}
