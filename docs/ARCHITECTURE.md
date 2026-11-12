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
- **Power distribution:** the reactor output is split between SYS (shields), ENG (engines) and
  WEP (weapons) in half-pips: each holds 0 to 8 and the three always sum to 12. The default is 4/4/4,
  where every effect is exactly 1. The setting is packed into `ShipInput.pips`, so the client's
  prediction replays it, and the applied value is copied into `ShipState.pips`. WEP scales the energy
  every weapon draws (1.3 with no pips, 0.7 with eight), mining and salvage lasers included.
- **Heat signature:** every ship in normal space has a signature, 1 for a reference-sized ship idling
  with shields up. It grows with hull radius, with heat stored (up to a limit), with thruster output
  and boost, and rises when the shields are down. A ship in cruise is visible everywhere in the
  system; a docked, folding or destroyed ship has none. The server computes it each tick
  (`shipSignature` in `shared/sim/signature.ts`).
- **Detection:** an observer picks up a target out to `sensorRange * sqrt(signature)`, never less
  than `VISUAL_RANGE` (1.5 km). A contact already held is kept 10 % farther out. Snapshots list only
  what the recipient detects (`canDetect`). Wrecks are not subject to detection.
- **Silent running:** the pilot can switch the ship to silent. The signature is multiplied by 0.08,
  but the shields are switched off and bleed away, and the radiators close, so heat builds. The
  shields return only a full recharge delay after silent running ends.
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

That is not enough, because an operator can change the code of his own server and give himself any
goods or ships, and no other server can check how goods came to be. So every server trusts only its
own books and limits what foreign goods and ships can turn into here. Credits are local to each
server; value moves between servers only as cargo and ships, and the rules below decide what those
are worth on arrival.

**Tiers.** A server rates every other server: `union`, `partner`, `visitor` or `blocked`. A server the
operator has not rated is a visitor (`defaultTrust`).

| Tier | Effect |
|---|---|
| `union` | Goods and ships move freely, no tariff, no balance. It takes effect only when both servers rate each other union and publish the same rules fingerprint; otherwise the relation is treated as `partner`. |
| `partner` | Trade under the trade balance below, plus the tariff on sales. |
| `visitor` | Pilots may enter, but all their cargo is sealed. |
| `blocked` | No entry. |

The ids a server rates union or partner, the class limits and the fingerprint are published in its
descriptor (`trade`), so the origin server can refuse a jump before it starts.

**Attribution on arrival.** First the pilot's own goods are recognised (next paragraph). For the rest,
the tier of the server that issued the transfer ticket decides what each cargo lot is called here. A
lot that is already sealed stays sealed, whoever sends it.

- From a visitor, every lot is sealed and keeps its label.
- From a partner, a lot labelled with the issuer's id or with this server's id becomes an import
  attributed to the issuer. A lot with any other label is sealed, so goods cannot be washed through an
  honest server in between.
- From a union member, labels are believed, and each label is rated by this server's own tier for that
  label: this server's id is local, a union member's id is free, a partner's id is an import against
  that partner's balance, anything else is sealed. A label is never rewritten to the sender's id.

What a lot counts as is decided at the moment of use (sealed mark first, then own id is local, then
the current tier of the label), so a rating changed later applies to goods already in the hold.

**Own goods coming back.** When a pilot leaves, this server remembers the local, unsealed cargo on
board, in tonnes by commodity. When the pilot returns, lots under this server's label are local goods
again, commodity by commodity, up to the tonnes that left, and the export booked for them is taken
back. A seal set on the way does not count against them, so a trip through a sector that admits
visitors only does not destroy a pilot's own goods. The match is by commodity and not by value:
otherwise a round trip through another server would turn the cheapest local goods into any other goods
of the same value, as local goods, past the tariff, the licence and the trade balance. Whatever exceeds
what left, or is of another kind, is attributed like any other lot.

**Sealed cargo.** Sealed cargo cannot be turned into value here in any way. It can be carried out
again or jettisoned. The mark stays through jettison, scooping, wrecks, pods cut from wrecks, merging
cargo, saving and the transfer ticket. It also stays on every later server, because otherwise minted
goods could be given the label of a server that believes them; the one exception is the pilot's own
goods coming home, above. Lots merge only when commodity, label and seal all match.

**Trade balance.** For every partner this server keeps, in its own books and in trade units (tonnes
times the commodity's catalog price):

    imports absorbed from P  <=  exports to P  +  credit line of P

An export is local, unsealed cargo on a transfer ticket to P, booked only when P redeems the ticket,
and taken back if the pilot is recalled because P went silent. An import is absorbed when it is turned
into value here: sold, delivered for a mission, donated to a gate. The credit line is `tradeCredit`, or
the entry for that server in `tradeCredits`, plus `gateTradeCredit` while an active warp gate links the
two servers. Imports from union members and from this server itself are not counted.

**Import licence.** Per pilot, imports can be absorbed only up to `importLicenceBase` plus
`importLicenceRate` times the pilot's non-trade income earned on this server: mission rewards (not the
returned deposit), bounties on NPCs, the sale of exploration data and the trade-unit value of ore the
pilot mines here. Trade revenue does not count, and neither does the reward of a delivery or mining
mission for the share of the shipment that was not made here: handing in imported goods is a sale by
another name, and counting it would let the licence feed itself. Union goods need no licence. A sale or
delivery is filled in whole tonnes up to the smaller of the partner's remaining allowance and the
pilot's remaining licence, and the reply says which limit applied.

The base (default 2,000 trade units, about one small hold) exists because a pilot who arrives in a
sector for the first time has no credits there and, in a stock starter ship, neither a mining laser nor
a scanner nor the deposit for a delivery: without it the only way to a first sale would be combat. Free
key pairs multiply the base, but all pilots together stay within the partner's trade balance, which is
the bound that matters. An operator who wants every pilot to earn the licence first sets it to 0.

**Bound ships.** A ship that arrives from a server that is not a union member is bound: hull and fitted
modules refund nothing when sold or swapped here, and its wreck yields no scrap and no parts. A ship
from a union member is bound only where that member says so. Parts the pilot buys here become local.
This server remembers the hull and modules of each ship that leaves it (except into a union) and
recognises the same ship on return: what matches, and was local then, is local again, so an honest
pilot does not lose the home ship by visiting a neighbour. The free starter ship issued after a
destruction is bound, so it refunds nothing: otherwise a pilot could die without credits, sell the
free ship's modules and repeat. A ship replaced for the deductible stays as bound as it was.

**Class limits.** Each tier has a limit on the largest hull, by catalog price, that may enter
(`shipLimit`; none for union). The limits are published, so the origin refuses the fold command before
any fuel is spent; the destination checks again before it redeems the ticket. A ship the destination
recognises as its own is exempt. The galaxy view carries, per sector, the tier that sector applies to
ships from here and its hull limit (`entryTier`, `entryHullCap`), so the map says before a jump what
will happen to cargo and ship.

**Rules fingerprint.** A hash of the catalog tables and every constant in `shared/constants.ts`,
including the game and protocol versions. Two servers form a customs union only if both publish the
same fingerprint, so a changed rule or a version bump dissolves the union until both sides update.
Server settings such as the tariff are not part of it.

**What the model does not prevent.**

- A lying union member. A union is for operators who know each other: a member that mints goods or
  ships gives them to every other member for free.
- A cheat who plays as an ideal trader within the limits. A dishonest partner can still sell goods it
  invented, up to the balance and the pilot's licence; the limits are what bound it. Exposure to one
  partner is its credit line plus what it has really bought from this server.
- Free key pairs: every new pilot starts with `startCredits` and a refundable starter ship here, as
  before. That is a source of local credits the trade model does not bound.
- A rating a server keeps private. A descriptor lists only the ids rated union and partner; a server
  that treats one visitor differently from its published default shows that only on arrival.

### Wrecks, salvage and insurance

A ship destroyed in normal space leaves a wreck for 900 seconds (a zone keeps at most 12; the oldest
goes first). The wreck holds the ship's whole cargo with the origin of each stack, scrap in proportion
to hull mass and, by chance, parts for fitted modules. Scrap and parts are the only goods that enter
the economy this way. A pilot's stock starter ship, which insurance hands out for free, leaves none, so
it cannot be destroyed and salvaged for credits; neither does a bound hull or a bound module. A pilot with a mining laser cuts a wreck open with
the tool trigger and its contents float out as ordinary cargo pods that anyone can scoop; origins
travel with the goods, and so does the seal, so tariffs and the trade balance still apply when they are sold. Cargo is conserved from the kill to
the pods. A ship destroyed in cruise or in a fold tunnel leaves no wreck and its cargo is lost.

Destruction charges nothing. The `respawn` command returns the pilot to their home station in the same
ship, repaired and refuelled, for a deductible of `insuranceRate` (server setting, default 0.05) times
the catalog price of hull and fitted modules. A pilot who cannot pay is issued the free starter ship
and keeps their credits. Credits stay local to each server, as before.

## 5. Netcode

- WebSocket per client. Control messages are JSON; snapshots are binary (`shared/snapshot.ts`).
- The server simulates at `TICK_RATE` (30 Hz) and sends a snapshot every `SNAPSHOT_EVERY` ticks.
- The client sends one `ShipInput` per tick, predicts its own ship with the same `stepShip`
  and reconciles against the acknowledged input sequence. Other entities are interpolated.
- The protocol version is 3. The snapshot's own-ship block carries the power setting (`pips`) and the
  ship's heat signature (`sig`).
- Snapshot entity positions are float32 offsets from the recipient's own position; the recipient's
  own state is float64.

## 6. Naming

PRIMACY2 uses its own vocabulary: **cruise** (in-system FTL), **fold** (inter-system jump),
**warp gate** (inter-sector bridge), **sector** (one server's systems), **pilot** (a player).
Hull names: Wisp, Lancet, Drover, Delver, Wayfarer, Bulwark.
