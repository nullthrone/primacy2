/**
 * Core commands every server has: flight mode changes, fold jumps, docking, respawn, chat,
 * targeting and the galaxy map.
 */
import {
  ChargeKind,
  DOCK_MAX_SPEED,
  DOCK_RANGE,
  FlightMode,
  MAX_CHAT_LENGTH,
  canEngageCruise,
  disengageCruise,
  findSite,
  foldFuelCost,
  placeAtSite,
  quat,
  v3,
  type ChatChannel,
  type ChatMessage,
} from '@primacy2/shared';
import { CRUISE_ZONE, fail, ok, type GameModule, type Player } from '../game.ts';
import type { World } from '../world.ts';

/** Removes control characters and trims; chat is plain text. */
export function cleanChat(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_LENGTH);
}

const lastChat = new WeakMap<Player, { at: number; burst: number }>();

/** Token bucket: five messages at once, then one per 1.5 seconds. */
function chatAllowed(p: Player, now: number): boolean {
  const st = lastChat.get(p) ?? { at: now, burst: 5 };
  st.burst = Math.min(5, st.burst + (now - st.at) / 1500);
  st.at = now;
  lastChat.set(p, st);
  if (st.burst < 1) return false;
  st.burst -= 1;
  return true;
}

export function deliverChat(world: World, from: Player, ch: ChatChannel, text: string, to?: string): boolean {
  const m: ChatMessage = { ch, from: { id: from.id, name: from.name }, text, at: world.host.now() };
  const msg = { t: 'chat', m } as const;
  switch (ch) {
    case 'local': {
      const sim = from.sim;
      const ship = from.ship;
      if (!sim || !ship) return false;
      const zone = sim.zoneOf(ship);
      for (const p of sim.players) {
        if (p === from || (p.ship && sim.zoneOf(p.ship) === zone && zone !== -1)) p.send(msg);
      }
      return true;
    }
    case 'system':
      if (!from.sim) return false;
      for (const p of from.sim.players) p.send(msg);
      return true;
    case 'direct': {
      const target = to ? world.players.get(to) : undefined;
      if (!target) return false;
      target.send(msg);
      if (target !== from) from.send(msg);
      return true;
    }
    default:
      // `sector`, and `lattice` when no comms module relays it further.
      world.broadcast(msg);
      return true;
  }
}

export const coreModule: GameModule = {
  name: 'core',
  commands: {
    cruise(p, cmd) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim) return fail('no ship');
      const s = ship.state;
      if (cmd.on) {
        if (s.mode === FlightMode.Cruise) return ok();
        const can = canEngageCruise(s, sim.def, sim.time);
        if (!can.ok) {
          return fail(
            can.reason === 'masslock' ? 'Mass-locked: move away from the structure.'
              : can.reason === 'fuel' ? 'No fuel.'
              : can.reason === 'charging' ? 'A drive is already charging.'
              : 'Cruise is not available now.',
          );
        }
        s.chargeKind = ChargeKind.Cruise;
        s.charge = 0;
        return ok();
      }
      if (s.chargeKind === ChargeKind.Cruise) {
        s.chargeKind = ChargeKind.None;
        s.charge = 0;
        return ok();
      }
      if (s.mode !== FlightMode.Cruise) return ok();
      const res = disengageCruise(s, sim.def, sim.time, cmd.site);
      sim.emit(res.anchor, { e: 'cruise', id: ship.id, on: false, at: v3.clone(s.pos) });
      sim.emit(CRUISE_ZONE, { e: 'cruise', id: ship.id, on: false, at: [0, 0, 0] });
      if (res.emergency) {
        p.notice('danger', 'emergency_drop', 'Emergency drop: hull stressed.');
        sim.damage(ship, ship.stats.hullMax * 0.12, { bypassShield: true });
      }
      return ok({ anchor: res.anchor });
    },

    fold(p, cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim) return fail('no ship');
      const s = ship.state;
      if (s.mode !== FlightMode.Normal && s.mode !== FlightMode.Cruise) return fail('The fold drive cannot charge now.');
      if (s.chargeKind !== ChargeKind.None) return fail('A drive is already charging.');
      if (cmd.system === sim.def.id) return fail('You are already in that system.');
      const target = world.resolveSystem(cmd.system);
      if (!target) return fail('Unknown system.');
      const distance = v3.dist(sim.def.pos, target.pos);
      const cost = foldFuelCost(distance, ship.stats);
      if (!Number.isFinite(cost)) return fail(`Out of range: ${distance.toFixed(1)} ly, drive reaches ${ship.stats.jumpRange.toFixed(1)} ly.`);
      if (s.fuel < cost) return fail(`Not enough fuel: the jump needs ${cost.toFixed(1)} t.`);
      if (s.mode === FlightMode.Normal) {
        const can = canEngageCruise(s, sim.def, sim.time);
        if (!can.ok && can.reason === 'masslock') return fail('Mass-locked: move away from the structure.');
      }
      if (target.server) {
        if (world.fed.trustOf(target.server.id) === 'blocked') return fail('That sector is blocked by this server.');
        if (!world.fed.isOnline(target.server)) return fail('That sector is not answering.');
      }
      ship.fold = { system: cmd.system, server: target.server?.id ?? null, distance };
      s.chargeKind = ChargeKind.Fold;
      s.charge = 0;
      return ok({ distance, fuel: cost, name: target.name });
    },

    foldCancel(p) {
      const ship = p.ship;
      if (!ship) return fail('no ship');
      if (ship.state.chargeKind === ChargeKind.Fold) {
        ship.state.chargeKind = ChargeKind.None;
        ship.state.charge = 0;
        ship.fold = null;
      }
      return ok();
    },

    target(p, cmd) {
      const ship = p.ship;
      if (!ship || !p.sim) return fail('no ship');
      if (cmd.id !== null && !p.sim.ships.has(cmd.id)) return fail('No such contact.');
      ship.target = cmd.id === ship.id ? null : cmd.id;
      return ok();
    },

    dock(p, _cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim) return fail('no ship');
      const s = ship.state;
      if (s.mode !== FlightMode.Normal) return fail('Docking needs normal flight.');
      const site = findSite(sim.def, s.anchor);
      if (!site || (site.kind !== 'station' && site.kind !== 'outpost')) return fail('No station here.');
      if (v3.len(s.pos) > (site.radius ?? 300) + DOCK_RANGE) return fail('Too far from the station.');
      if (v3.len(s.vel) > DOCK_MAX_SPEED) return fail('Too fast to dock.');
      const zone = sim.zoneOf(ship);
      s.mode = FlightMode.Docked;
      s.pos = [0, 0, 0];
      s.vel = [0, 0, 0];
      s.angVel = [0, 0, 0];
      s.chargeKind = ChargeKind.None;
      s.charge = 0;
      ship.fold = null;
      ship.target = null;
      p.rec.homeSystem = sim.def.id;
      p.rec.homeSite = site.id;
      sim.emit(zone, { e: 'dock', id: ship.id, docked: true });
      for (const m of world.modules) m.onDock?.(p, sim, site.id);
      world.pushPilot(p);
      world.pushStation(p);
      world.save(p);
      return ok({ site: site.id });
    },

    undock(p, _cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim) return fail('no ship');
      const s = ship.state;
      if (s.mode !== FlightMode.Docked) return fail('Not docked.');
      const site = findSite(sim.def, s.anchor);
      if (!site) return fail('The station is gone.');
      placeAtSite(s, sim.def, site.id, sim.time, world.random(), (site.radius ?? 300) + 500);
      // Leave the bay facing outward: half a turn about the ship's own up axis.
      s.rot = quat.mul(s.rot, [0, 1, 0, 0]);
      sim.emit(site.id, { e: 'dock', id: ship.id, docked: false });
      p.send({ t: 'station', s: null });
      return ok();
    },

    respawn(p, _cmd, world) {
      return world.respawn(p) ? ok() : fail('You are not dead.');
    },

    chat(p, cmd, world) {
      const text = cleanChat(cmd.text);
      if (!text) return fail('Empty message.');
      if (!chatAllowed(p, world.host.now())) return fail('You are sending messages too quickly.');
      return deliverChat(world, p, cmd.ch, text, cmd.to) ? ok() : fail('Nobody to deliver to.');
    },

    galaxy(p, _cmd, world) {
      p.send({ t: 'galaxy', g: world.galaxyView() });
      return ok();
    },

    station(p, _cmd, world) {
      world.pushStation(p);
      return ok();
    },
  },
};
