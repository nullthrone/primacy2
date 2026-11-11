# PRIMACY2 architecture

PRIMACY2 is a federated space-sim MMORPG for the browser. Anyone can run a server.
Each server contributes a *sector* of star systems; servers that peer with each other
make their sectors visible and reachable to each other's players.

This document is the contract every package follows. If code and this document disagree,
fix one of them in the same change.

## 1. Packages

| Package | Runs in | Purpose |
|---|---|---|
| `packages/shared` | browser + Node | Types, protocol, deterministic simulation, universe generation, crypto. No DOM, no Node APIs. |
| `packages/server` | Node >= 22.13 | Authoritative simulation, persistence (`node:sqlite`), federation, serves the built client. |
| `packages/client` | browser | Three.js renderer, input, prediction, HUD and UI. |
| `assets/blender` | Blender 5.x | Python generator scripts for every model; exported GLB lands in `packages/client/public/models`. |

`shared` is consumed as TypeScript source (no build step). The server runs through `tsx`.
There are no native dependencies, so `npm install && npm start` works on Windows, macOS and Linux.

## 2. Conventions

- **Units:** SI everywhere in the simulation: metres, seconds, kilograms, radians, kelvin.
  Galaxy coordinates are light years. Money is integer credits.
- **Axes:** right-handed, +Y up. A ship's local frame is +X right, +Y up, **-Z forward**.
- **Quaternions** are `[x, y, z, w]` and rotate ship-local vectors into the frame axes.
- **Angular velocity** is a ship-local rotation vector (right-hand rule):
  pitch up = +X, yaw right = -Y, roll right (clockwise seen from behind) = -Z.
- **Input signs:** `thrust = [right, up, forward]` each in -1..1; `aim = [yawRight, pitchUp]` in radians
  for this tick; `roll` > 0 rolls right.
- **Models (glTF):** nose toward -Z, top toward +Y, 1 unit = 1 metre, origin at the centre of mass.
  In Blender that is nose toward +Y, top toward +Z.
- **Numbers on the wire:** the simulation is float64. Absolute positions are never sent or uploaded
  to the GPU as float32; the client subtracts the camera position in float64 first.
- **Determinism:** all procedural content derives from seeds through `Rng` in `shared/prng.ts`.
  Never use `Math.random()` in `shared`.
- **Time:** *universe time* `t` is seconds since `UNIVERSE_EPOCH_MS` on the wall clock (UTC).
  Orbital positions are pure functions of `t`, so every server and client agrees without syncing.

## 3. Space: scale, anchors and frames

Star systems are true scale. Bodies move on Kepler orbits ("on rails").

A ship's position is always stored **relative to an anchor**:

- **Body anchors** have ids `0..999` (the index into `SystemDef.bodies`).
- **Site anchors** have ids `>= 1000` (`SITE_ID_BASE + n`): stations, outposts, belt and ring
  mining sites, beacons, warp gates. A site follows its own Kepler orbit around a body.

The anchor frame is non-rotating and moves with the anchor. Because the anchor is in free fall,
the acceleration a ship feels in that frame is the **tidal** gravity:

    a = sum over bodies b of [ g_b(ship) - g_b(anchor) ]      (g_b(anchor) = 0 when b is the anchor itself)

Near a station this is almost zero (weightless, as in orbit); with a planet as anchor it is the
planet's full gravity. Compact objects use the Paczynski-Wiita potential `GM / (r - rs)^2`.

### Flight modes

| Mode | Physics | Anchor |
|---|---|---|
| `Normal` | Newtonian thrust and gravity. Flight assist is a controller on top. | Sticky. Chosen on arrival (cruise exit, undock, spawn). |
| `Cruise` | In-system FTL. Gravity is ignored; speed is limited by proximity to bodies. | The body whose sphere of influence contains the ship. |
| `Fold` | Inter-system jump tunnel. No position. | none |
| `Docked` | Inside a station. | the station site |

Ships in `Normal` mode that share an anchor form a **zone**: they collide, fight and see each other.
Ships in `Cruise` share the system-wide cruise layer and see each other as contacts only.

### Flight model

- **Flight assist on (default):** the pilot commands a velocity in ship axes; the assist fires
  thrusters (limited per axis) to reach it and cancels gravity when thrust allows. Releasing the keys
  brakes to a stop relative to the anchor. Speed is limited to the hull's rated speed.
- **Flight assist off:** keys are raw thrust. No speed limit other than relativity
  (acceleration is divided by gamma^3). Orbits and slingshots work.
- **Rotation** is always assisted: mouse movement accumulates in an aim buffer that the ship works
  off at its turn-rate limit, so light ships feel like a first-person shooter and heavy ships lag.
- **Time dilation:** each ship integrates with `dt * dilation`, where dilation combines
  gravitational (`sqrt(1 - rs/r)`) and velocity (`1/gamma`) factors.

## 4. Federation

### Identity

- A **server** owns an Ed25519 key. `serverId` = first 16 base32 chars of `sha256(publicKey)`.
- A **player** owns an Ed25519 key generated in the browser. `playerId` is derived the same way.
  There are no accounts and no passwords; a player proves ownership by signing a server challenge.

### Descriptors and gossip

Every server publishes a signed `ServerDescriptor` (name, public URL, sector position, system list,
direct links, gates). Servers exchange their own descriptor and every descriptor they know.
A descriptor is self-certifying (`id` must match the signing key), so it can be relayed by anyone.
The galaxy map a client sees is the union of all descriptors its server knows.

### Sector placement

A sector's position is chosen once, on first start, and then persisted:

1. `sector.position` in the config, if the operator set one; otherwise
2. next to the first reachable bootstrap peer, close enough that the starter hull can jump across; otherwise
3. a position derived from the server id inside the core region.

### Travel between servers

- **Fold jump:** any system of any known server can be targeted if it is within the hull's jump range.
- **Warp gates** bridge distances beyond jump range. A gate is a joint construction project: both
  servers must fund their half with materials and credits before the pair activates.

Both end in a **handoff**:

1. The origin server removes the ship, marks the player *in transit* and signs a `TransferTicket`
   containing the player's `Passport` (ship, cargo, pilot record).
2. The client connects to the destination server, authenticates with its own key and presents the ticket.
3. The destination verifies signature, issuer, destination binding, expiry and nonce, asks the issuer
   to redeem the nonce (one-time use), then **sanitises** the passport and spawns the ship.

### Trust

Any server may be hostile. A receiving server therefore never accepts raw statistics:
ship capabilities are re-derived from hull and module ids using its own catalog, cargo is clamped to
capacity, and unknown ids are dropped.

Credits are **local to each server**. Value moves between servers as physical cargo, which bounds
what a hostile server can inject to one cargo hold per visit. Operators assign each peer a trust level:

| Level | Effect on arrivals |
|---|---|
| `trusted` | Passport accepted; cargo sells at full price. |
| `neutral` (default) | Passport accepted after sanitising; imported cargo pays a tariff. |
| `restricted` | Ship accepted, cargo impounded. |
| `blocked` | Handoff refused. |

## 5. Netcode

- WebSocket per client. Control messages are JSON; snapshots are binary (`shared/snapshot.ts`).
- The server simulates at `TICK_RATE` (30 Hz) and sends a snapshot every `SNAPSHOT_EVERY` ticks.
- The client sends one `ShipInput` per tick, predicts its own ship with the same `stepShip`
  and reconciles against the acknowledged input sequence. Other entities are interpolated.
- Snapshot entity positions are float32 offsets from the recipient's own position; the recipient's
  own state is float64.

## 6. Naming

PRIMACY2 uses its own vocabulary: **cruise** (in-system FTL), **fold** (inter-system jump),
**warp gate** (inter-sector bridge), **sector** (one server's systems), **pilot** (a player).
Hull names: Wisp, Lancet, Drover, Delver, Wayfarer, Bulwark.
