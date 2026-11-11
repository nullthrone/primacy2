# Server gameplay modules

Gameplay on the server is split into modules that plug into the core through the `GameModule`
interface in `packages/server/src/game.ts`. A module owns one file (plus an optional directory of
the same name) under `packages/server/src/modules/` and is registered in `modules/index.ts`.

## What the core provides

| Need | Use |
|---|---|
| React to a client command | `commands: { buy(player, cmd, world) { ... } }`; return `ok(data)` or `fail('message')`. A command kind belongs to exactly one module. |
| Run every tick | `preStep(sim, t, dt)` before ships move (set NPC inputs), `postStep(sim, t, dt)` after movement and collisions. |
| Run occasionally | `slowTick(sim, t)` about once per second per active system; `worldTick(world, nowMs)` about every five seconds for the whole world. |
| Ships in a zone | `sim.shipsInZone(anchorId)`, `sim.activeZones()`, `sim.zoneOf(ship)`, `sim.zoneHasPlayers(zone)`. |
| Hurt or destroy a ship | `sim.damage(ship, amount, { by, shieldMul, hullMul, at })`, `sim.destroy(ship, by)`. Never change `state.hull` directly. |
| Tell clients something happened | `sim.emit(zone, event)` (see `GameEvent` in `shared/protocol.ts`). |
| Floating cargo | `sim.spawnLoot(anchor, pos, vel, commodity, tonnes)`; the cargo module handles pickup. |
| Other objects (missiles) | `sim.addObject({...})`; the core moves them and removes them when `ttl` runs out. |
| Asteroids of a site | `sim.asteroids(siteId)` (positions and ore) and `sim.asteroidLeft` (remaining fraction per rock). |
| Pilot cargo and money | `player.addCargo`, `player.removeCargo`, `player.cargoCount`, `player.cargoFree`, `player.rec.credits`. Call `world.pushPilot(player)` after changing anything the pilot sees. |
| Change a pilot's ship fit | Edit `player.rec.passport.ship.loadout`, then `player.refit()`. |
| Per-pilot persistent data | `player.data('moduleName', () => initial)`. It is local to this server and never leaves it. |
| World-level persistent data | `world.store.getDoc / putDoc / listDocs(collection, id)`. |
| Add to what a docked pilot sees | `stationView(player, sim, siteId, view)`; add to the pilot's own view with `pilotView(player, view)`. |
| Talk to another server | `world.fed.handle(topic, fn)` in `init`, `world.fed.send(knownServer, topic, payload)`. Messages are signed and only accepted from linked servers. Treat every payload as hostile input. |
| Trust and tariffs | `world.fed.trustOf(serverId)`, `world.config.tariff`. Cargo carries its `origin` server id. |
| Send a pilot to another server | `world.handoff(player, knownServer, arrival)`. |
| Time | `sim.time` / `world.time()` are universe seconds; `world.host.now()` is wall-clock milliseconds. Never call `Date.now()` in a module: tests drive the clock. |
| Randomness | `world.random()` (an `Rng`). |

## Rules

- Validate everything that comes from a client or another server: ids against the catalog with
  `Object.hasOwn`, amounts as positive integers within what the pilot actually owns or can afford.
- Credits are integers and local to the server. No operation may create credits or cargo from nothing
  except the documented sources (mission rewards, mining, production).
- A module must not assume another module is present.
- Keep hooks cheap: `preStep` and `postStep` run thirty times per second for every active system.
