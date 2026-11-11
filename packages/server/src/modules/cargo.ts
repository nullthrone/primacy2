/**
 * Cargo in space: jettisoning, scooping floating canisters and ship-to-ship fuel transfer.
 */
import { COMMODITIES, EntityKind, FlightMode, SCOOP_RANGE, forwardOf, v3 } from '@primacy2/shared';
import { fail, ok, type GameModule } from '../game.ts';

/** Fuel can be handed over within this distance, metres. */
const FUEL_TRANSFER_RANGE = 600;

export const cargoModule: GameModule = {
  name: 'cargo',

  commands: {
    jettison(p, cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim || ship.state.mode !== FlightMode.Normal) return fail('Cargo can only be jettisoned in normal flight.');
      if (!Object.hasOwn(COMMODITIES, cmd.c)) return fail('Unknown commodity.');
      const taken = p.removeCargo(cmd.c, cmd.n);
      const n = taken.reduce((sum, it) => sum + it.n, 0);
      if (n <= 0) return fail('You do not carry that.');
      // Canisters leave through the rear, drifting away slowly.
      const back = v3.neg(forwardOf(ship.state.rot));
      const pos = v3.addScaled(ship.state.pos, back, ship.stats.radius + 8);
      const vel = v3.addScaled(ship.state.vel, back, 12);
      const pod = sim.spawnLoot(ship.state.anchor, pos, vel, cmd.c, n);
      // Remember where the goods came from so tariffs still apply after a pickup.
      pod.data = { origins: taken, droppedBy: ship.id, at: sim.time };
      world.pushPilot(p);
      return ok({ n });
    },

    giveFuel(p, cmd, world) {
      const ship = p.ship;
      const sim = p.sim;
      if (!ship || !sim || ship.state.mode !== FlightMode.Normal) return fail('Fuel transfer needs normal flight.');
      const other = sim.ships.get(cmd.to);
      if (!other || other === ship || other.state.mode !== FlightMode.Normal || other.state.anchor !== ship.state.anchor) {
        return fail('No such ship nearby.');
      }
      if (v3.dist(other.state.pos, ship.state.pos) > FUEL_TRANSFER_RANGE) return fail('Too far away for a fuel line.');
      const room = other.stats.fuelCap - other.state.fuel;
      // Never give away the last tonne: the helper must not strand itself.
      const n = Math.min(cmd.n, Math.floor(ship.state.fuel - 1), Math.floor(room));
      if (n <= 0) return fail(room < 1 ? 'Their tank is full.' : 'You have no fuel to spare.');
      ship.state.fuel -= n;
      other.state.fuel += n;
      other.player?.notice('info', 'fuel_received', `${p.name} transferred ${n} t of fuel to you.`);
      if (other.player) world.pushPilot(other.player);
      world.pushPilot(p);
      return ok({ n });
    },
  },

  postStep(sim) {
    if (sim.objects.size === 0) return;
    for (const o of sim.objects.values()) {
      if (o.kind !== EntityKind.Loot || !o.info.c || !o.info.n) continue;
      const data = o.data as { origins?: { c: string; n: number; origin: string }[]; droppedBy?: number; at?: number } | undefined;
      for (const ship of sim.shipsInZone(o.anchor)) {
        const p = ship.player;
        if (!p || ship.gone) continue;
        // A ship does not immediately scoop back what it just threw out.
        if (data?.droppedBy === ship.id && sim.time - (data.at ?? 0) < 6) continue;
        if (v3.distSq(ship.state.pos, o.pos) > SCOOP_RANGE * SCOOP_RANGE) continue;
        let got = 0;
        const stacks = data?.origins ?? [{ c: o.info.c, n: o.info.n, origin: sim.world.id }];
        for (const st of stacks) {
          const added = p.addCargo(st.c, st.n, st.origin);
          st.n -= added;
          got += added;
        }
        if (got <= 0) continue;
        o.info.n -= got;
        sim.emit(o.anchor, { e: 'scoop', id: ship.id, c: o.info.c, n: got });
        sim.world.pushPilot(p);
        if (o.info.n <= 0) {
          sim.removeObject(o.id);
          break;
        }
        if (data?.origins) data.origins = stacks.filter((s) => s.n > 0);
      }
    }
  },
};
