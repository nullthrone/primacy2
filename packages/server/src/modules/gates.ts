/**
 * Warp gates: bridges between two sectors that are too far apart to jump between.
 *
 * A gate is a joint project of two linked servers. One proposes it (operator configuration), the
 * other accepts, and a construction site appears in a system on each side. Pilots of each server
 * pay for their own half with credits and materials. The pair opens when both halves are
 * complete and goes dormant while the other server is unreachable. Flying through the ring of an
 * open gate hands the pilot over to the server on the far side.
 */
import {
  COMMODITIES,
  FlightMode,
  GATE_COST,
  upsertGateSite,
  v3,
  type GateInfo,
  type GateProjectView,
  type GateState,
  type SystemDef,
} from '@primacy2/shared';
import type { KnownServer } from '../federation.ts';
import { fail, ok, type GameModule, type Player } from '../game.ts';
import type { World } from '../world.ts';

interface GateProject {
  linkId: string;
  peer: string;
  /** Local system id and site id of this end. */
  system: string;
  site: number;
  /** Far end, once the peer has answered. */
  remoteSystem: string;
  remoteSite: number | null;
  state: GateState;
  paidCredits: number;
  paidMaterials: Record<string, number>;
  /** Far end's construction progress as last reported, 0..1. */
  remoteProgress: number;
  /** Credits' worth contributed per pilot id. */
  contributors: Record<string, { name: string; value: number }>;
}

type GateMessage =
  | { op: 'propose'; linkId: string; system: string; site: number }
  | { op: 'status'; linkId: string; progress: number; system: string; site: number };

interface State {
  projects: Map<string, GateProject>;
  /** Wall-clock time of the last status exchange per link. */
  lastSync: Map<string, number>;
  /** Last automatic transit attempt per pilot, to avoid retrying every tick. */
  lastTransit: WeakMap<Player, number>;
}

const states = new WeakMap<World, State>();
const STATUS_EVERY_MS = 15_000;
/** A ship this close to the centre of an open gate is taken through. */
const TRANSIT_RADIUS = 160;

/** One gate per pair of servers; both sides derive the same id. */
export const gateLinkId = (a: string, b: string): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

function costs(world: World): { credits: number; materials: Record<string, number>; total: number } {
  const k = world.config.gateCostScale;
  const credits = Math.max(1, Math.round(GATE_COST.credits * k));
  const materials: Record<string, number> = {};
  let total = credits;
  for (const [c, n] of Object.entries(GATE_COST.materials)) {
    materials[c] = Math.max(1, Math.round(n * k));
    total += materials[c]! * (COMMODITIES[c]?.price ?? 0);
  }
  return { credits, materials, total };
}

function progressOf(world: World, p: GateProject): number {
  const c = costs(world);
  let paid = Math.min(p.paidCredits, c.credits);
  let complete = p.paidCredits >= c.credits;
  for (const [id, need] of Object.entries(c.materials)) {
    const have = Math.min(p.paidMaterials[id] ?? 0, need);
    paid += have * (COMMODITIES[id]?.price ?? 0);
    if (have < need) complete = false;
  }
  return complete ? 1 : Math.min(0.999, paid / c.total);
}

function save(world: World, p: GateProject): void {
  world.store.putDoc('gates', p.linkId, p);
}

/** Creates or refreshes the site of a project in its system and tells everyone who can see it. */
function syncSite(world: World, p: GateProject): void {
  const def = world.defs.get(p.system);
  if (!def) return;
  const peer = world.fed.known.get(p.peer);
  const info: GateInfo = {
    linkId: p.linkId, peer: p.peer, remoteSystem: p.remoteSystem, state: p.state,
    progress: progressOf(world, p), remoteProgress: p.remoteProgress,
  };
  const towards = peer ? v3.sub(peer.desc.pos, def.pos) : ([1, 0, 0] as [number, number, number]);
  const site = upsertGateSite(def, info, towards);
  site.name = `Gate to ${peer?.desc.name ?? p.peer.slice(0, 6)}`;
  p.site = site.id;
  world.siteChanged(def.id, site);
}

/** The local system closest to a point in the galaxy. */
function nearestSystem(world: World, pos: readonly [number, number, number]): SystemDef {
  let best: SystemDef | null = null;
  let bestD = Infinity;
  for (const def of world.defs.values()) {
    const d = v3.dist(def.pos, pos);
    if (d < bestD) {
      bestD = d;
      best = def;
    }
  }
  return best!;
}

function setState(world: World, p: GateProject, state: GateState): void {
  if (p.state === state) return;
  p.state = state;
  save(world, p);
  syncSite(world, p);
  if (state === 'active') {
    const name = world.fed.known.get(p.peer)?.desc.name ?? 'another sector';
    world.broadcast({ t: 'notice', level: 'info', code: 'gate_open', text: `The warp gate to ${name} is open.` });
  }
}

/** Derives the state of a project from both halves' progress and the peer's reachability. */
function evaluate(world: World, p: GateProject): void {
  const peer = world.fed.known.get(p.peer);
  const done = progressOf(world, p) >= 1 && p.remoteProgress >= 1 && p.remoteSite !== null;
  if (!done) {
    if (p.state === 'active' || p.state === 'dormant') setState(world, p, 'building');
    return;
  }
  setState(world, p, peer && peer.linked && world.fed.isOnline(peer) ? 'active' : 'dormant');
}

async function exchangeStatus(world: World, st: State, p: GateProject, peer: KnownServer): Promise<void> {
  st.lastSync.set(p.linkId, world.host.now());
  try {
    const reply = (await world.fed.send(peer, 'gate', {
      op: 'status', linkId: p.linkId, progress: progressOf(world, p), system: p.system, site: p.site,
    } satisfies GateMessage)) as { ok?: boolean; progress?: unknown; system?: unknown; site?: unknown };
    if (reply.ok !== true) return;
    applyRemote(world, p, peer, reply.progress, reply.system, reply.site);
  } catch {
    // The peer is unreachable; `evaluate` turns an open gate dormant once it times out.
  }
  evaluate(world, p);
}

/** Takes over what the far end reports about itself, after checking it. */
function applyRemote(world: World, p: GateProject, peer: KnownServer, progress: unknown, system: unknown, site: unknown): void {
  let changed = false;
  if (typeof progress === 'number' && progress >= 0 && progress <= 1 && progress !== p.remoteProgress) {
    p.remoteProgress = progress;
    changed = true;
  }
  if (typeof system === 'string' && system.startsWith(peer.id + ':') && peer.desc.systems.some((s) => s.id === system) && system !== p.remoteSystem) {
    p.remoteSystem = system;
    changed = true;
  }
  if (typeof site === 'number' && Number.isInteger(site) && site >= 0 && site !== p.remoteSite) {
    p.remoteSite = site;
    changed = true;
  }
  if (changed) {
    save(world, p);
    syncSite(world, p);
  }
}

function transit(world: World, p: Player, project: GateProject): { ok: true } | { ok: false; err: string } {
  if (project.state !== 'active' || project.remoteSite === null) return { ok: false, err: 'This gate is not open.' };
  const peer = world.fed.known.get(project.peer);
  if (!peer) return { ok: false, err: 'The far side of this gate is unknown.' };
  return world.handoff(p, peer, { kind: 'gate', system: project.remoteSystem, site: project.remoteSite });
}

export const gatesModule: GameModule = {
  name: 'gates',

  init(world) {
    const st: State = { projects: new Map(), lastSync: new Map(), lastTransit: new WeakMap() };
    states.set(world, st);
    for (const { value } of world.store.listDocs<GateProject>('gates')) {
      if (!value || !world.defs.has(value.system)) continue;
      st.projects.set(value.linkId, value);
      syncSite(world, value);
    }

    world.fed.handle('gate', (from, payload) => {
      const m = payload as Partial<GateMessage> | null;
      const linkId = gateLinkId(world.id, from.id);
      if (!m || m.linkId !== linkId) return { ok: false, error: 'bad link id' };
      const trust = world.fed.trustOf(from.id);
      if (trust === 'blocked' || trust === 'restricted') return { ok: false, error: 'not trusted' };
      let p = st.projects.get(linkId);

      if (m.op === 'propose') {
        if (!p) {
          if (!world.config.acceptGates) return { ok: false, error: 'this sector does not accept gate proposals' };
          if (st.projects.size >= world.config.maxGates) return { ok: false, error: 'this sector has no room for another gate' };
          const remote = from.desc.systems.find((s) => s.id === m.system);
          if (!remote) return { ok: false, error: 'unknown system' };
          p = {
            linkId, peer: from.id, system: nearestSystem(world, remote.pos).id, site: -1, remoteSystem: remote.id,
            remoteSite: null, state: 'building', paidCredits: 0, paidMaterials: {}, remoteProgress: 0, contributors: {},
          };
          st.projects.set(linkId, p);
          world.host.log(`gate project with ${from.desc.name} accepted`);
        }
        applyRemote(world, p, from, undefined, m.system, m.site);
        if (p.state === 'planned') p.state = 'building';
        save(world, p);
        syncSite(world, p);
        return { ok: true, system: p.system, site: p.site, progress: progressOf(world, p) };
      }

      if (m.op === 'status') {
        if (!p) return { ok: false, error: 'no such project' };
        applyRemote(world, p, from, m.progress, m.system, m.site);
        evaluate(world, p);
        return { ok: true, system: p.system, site: p.site, progress: progressOf(world, p) };
      }
      return { ok: false, error: 'unknown operation' };
    });
  },

  worldTick(world, nowMs) {
    const st = states.get(world);
    if (!st) return;
    // Propose the gates the operator asked for, once the peer is linked and reachable.
    for (const want of world.config.gates) {
      const linkId = gateLinkId(world.id, want.peer);
      if (st.projects.has(linkId) || st.projects.size >= world.config.maxGates) continue;
      const peer = world.fed.known.get(want.peer);
      if (!peer || !peer.linked || !world.fed.isOnline(peer)) continue;
      const def = want.system !== undefined ? world.defs.get(`${world.id}:${want.system}`) : nearestSystem(world, peer.desc.pos);
      if (!def) continue;
      const p: GateProject = {
        linkId, peer: peer.id, system: def.id, site: -1, remoteSystem: peer.desc.systems[0]?.id ?? `${peer.id}:0`,
        remoteSite: null, state: 'planned', paidCredits: 0, paidMaterials: {}, remoteProgress: 0, contributors: {},
      };
      st.projects.set(linkId, p);
      syncSite(world, p);
      save(world, p);
      void world.fed
        .send(peer, 'gate', { op: 'propose', linkId, system: p.system, site: p.site } satisfies GateMessage)
        .then((reply) => {
          const r = reply as { ok?: boolean; system?: unknown; site?: unknown; progress?: unknown; error?: unknown };
          if (r.ok !== true) {
            world.host.log(`gate proposal to ${peer.desc.name} refused: ${String(r.error ?? 'no reason given')}`);
            st.projects.delete(linkId);
            world.store.deleteDoc('gates', linkId);
            return;
          }
          applyRemote(world, p, peer, r.progress, r.system, r.site);
          setState(world, p, 'building');
          save(world, p);
          syncSite(world, p);
        })
        .catch(() => {
          // Not reachable right now: forget the attempt and propose again on a later tick.
          st.projects.delete(linkId);
          world.store.deleteDoc('gates', linkId);
        });
    }
    for (const p of st.projects.values()) {
      if (p.state === 'planned') continue;
      const peer = world.fed.known.get(p.peer);
      if (peer && peer.linked && nowMs - (st.lastSync.get(p.linkId) ?? 0) >= STATUS_EVERY_MS) void exchangeStatus(world, st, p, peer);
      else evaluate(world, p);
    }
  },

  postStep(sim) {
    const st = states.get(sim.world);
    if (!st || st.projects.size === 0) return;
    for (const project of st.projects.values()) {
      if (project.system !== sim.def.id || project.state !== 'active') continue;
      for (const ship of sim.shipsInZone(project.site)) {
        const p = ship.player;
        if (!p || ship.gone || v3.lenSq(ship.state.pos) > TRANSIT_RADIUS * TRANSIT_RADIUS) continue;
        const now = sim.world.host.now();
        if (now - (st.lastTransit.get(p) ?? 0) < 5_000) continue;
        st.lastTransit.set(p, now);
        const res = transit(sim.world, p, project);
        if (!res.ok) p.notice('warn', 'gate_refused', res.err);
        // The zone's ship list is stale after a handoff; the next tick continues with the rest.
        return;
      }
    }
  },

  commands: {
    gate(p, cmd, world) {
      const st = states.get(world);
      const ship = p.ship;
      if (!st || !ship || !p.sim || ship.state.mode !== FlightMode.Normal || ship.state.anchor !== cmd.site) {
        return fail('You are not at a gate.');
      }
      const project = [...st.projects.values()].find((g) => g.system === p.sim!.def.id && g.site === cmd.site);
      if (!project) return fail('This is not a gate.');
      if (v3.len(ship.state.pos) > 600) return fail('Fly into the ring to use the gate.');
      const res = transit(world, p, project);
      return res.ok ? ok() : fail(res.err);
    },

    gateFund(p, cmd, world) {
      const st = states.get(world);
      const ship = p.ship;
      const sim = p.sim;
      if (!st || !ship || !sim || ship.state.mode !== FlightMode.Docked) return fail('Contributions are made at a station.');
      const project = st.projects.get(cmd.linkId);
      // Any station of the sector takes contributions: the gate's own system may have none.
      if (!project) return fail('No such gate project.');
      if (project.state !== 'building' && project.state !== 'planned') return fail('This gate is already complete.');
      const c = costs(world);
      let value = 0;
      if (cmd.credits !== undefined) {
        const give = Math.min(cmd.credits, c.credits - project.paidCredits, p.rec.credits);
        if (give <= 0) return fail(p.rec.credits <= 0 ? 'You have no credits to give.' : 'The gate needs no more credits.');
        p.rec.credits -= give;
        project.paidCredits += give;
        value += give;
      }
      if (cmd.c !== undefined && cmd.n !== undefined) {
        if (!Object.hasOwn(c.materials, cmd.c)) return fail('The gate does not need that material.');
        const need = c.materials[cmd.c]! - (project.paidMaterials[cmd.c] ?? 0);
        const give = Math.min(cmd.n, need, p.cargoCount(cmd.c));
        if (give <= 0) return fail(need <= 0 ? 'The gate needs no more of that.' : 'You do not carry that material.');
        p.removeCargo(cmd.c, give);
        project.paidMaterials[cmd.c] = (project.paidMaterials[cmd.c] ?? 0) + give;
        value += give * (COMMODITIES[cmd.c]?.price ?? 0);
      }
      if (value <= 0) return fail('Nothing to contribute.');
      const entry = project.contributors[p.id] ?? { name: p.name, value: 0 };
      entry.name = p.name;
      entry.value += value;
      project.contributors[p.id] = entry;
      save(world, project);
      syncSite(world, project);
      if (progressOf(world, project) >= 1) {
        world.broadcast({ t: 'notice', level: 'info', code: 'gate_half', text: 'Our half of the warp gate is complete.' });
        st.lastSync.set(project.linkId, 0);
      }
      evaluate(world, project);
      world.pushPilot(p);
      world.pushStation(p);
      return ok({ progress: progressOf(world, project) });
    },
  },

  stationView(_p, sim, _siteId, view) {
    const st = states.get(sim.world);
    if (!st) return;
    const c = costs(sim.world);
    for (const project of st.projects.values()) {
      const needMaterials: Record<string, number> = {};
      for (const [id, need] of Object.entries(c.materials)) needMaterials[id] = Math.max(0, need - (project.paidMaterials[id] ?? 0));
      const row: GateProjectView = {
        link: {
          linkId: project.linkId, system: project.system, site: project.site, peer: project.peer,
          remoteSystem: project.remoteSystem, state: project.state, progress: progressOf(sim.world, project),
        },
        needCredits: Math.max(0, c.credits - project.paidCredits),
        needMaterials,
        remoteProgress: project.remoteProgress,
        peerName: sim.world.fed.known.get(project.peer)?.desc.name ?? project.peer.slice(0, 6),
      };
      view.gateProjects.push(row);
    }
  },
};

/** For tests and tools: the gate projects of a world. */
export function gateProjects(world: World): GateProject[] {
  return [...(states.get(world)?.projects.values() ?? [])];
}

