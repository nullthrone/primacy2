# Hosting a sector

> Early development: peering, sector placement, handoff, trade ratings, warp gates and tariffs work
> today.

Every PRIMACY2 server adds a sector of star systems to the shared galaxy. You need Node.js 22.13 or
newer; there is nothing to compile.

```sh
git clone https://github.com/nullthrone/primacy2.git
cd primacy2
npm install
npm start
```

`npm start` builds the client and starts the server on port 8420. Open `http://localhost:8420`.

## Configuration

Create `primacy2.config.json` in the directory you start the server from. Every key is optional.

```json
{
  "name": "Kepler Verge",
  "port": 8420,
  "publicUrl": "https://sector.example.org",
  "seed": "any text you like",
  "systems": 16,
  "peers": ["https://another-sector.example.net"],
  "openPeering": true,
  "defaultTrust": "visitor",
  "trust": { "<server id>": "partner" },
  "tariff": 0.12,
  "maxPlayers": 200,
  "insuranceRate": 0.05
}
```

| Key | Meaning |
|---|---|
| `name` | Sector name on the galaxy map (1 to 48 characters). |
| `port`, `host` | Where the server listens. |
| `publicUrl` | The address other servers and players reach you at. It must be exactly `http(s)://host[:port]`. |
| `seed` | Seed of your procedural systems. Changing it later changes every system. |
| `systems` | Number of star systems, 1 to 64. |
| `sectorRadius` | Size of the sector in light years (default 18). |
| `position` | `[x, y, z]` in light years to place the sector yourself. See "Where your sector appears". |
| `peers` | Servers to link with on start. |
| `openPeering` | Whether servers you did not list may link with you. |
| `defaultTrust`, `trust` | How you rate other servers: `partner`, `visitor` or `blocked` as the default, and any of those or `union` per server id in `trust`. See "Trust". `defaultTrust: "union"` is refused. |
| `tariff` | Share of the sale price withheld on imported cargo from `partner` servers (default 0.12). Union goods pay none. |
| `tradeCredit` | Trade units (tonnes times catalog price) a partner may be in deficit with you: imports from it may exceed what you exported to it by this much (default 50000). |
| `tradeCredits` | The same per server, e.g. `{ "<server id>": 200000 }`. Replaces `tradeCredit` for that server. |
| `gateTradeCredit` | Extra credit line, added while an active warp gate links you to that server (default 250000). |
| `importLicenceRate` | How many trade units of imports a pilot may sell or deliver per unit of non-trade income earned on your server (default 1). |
| `shipLimit` | Largest hull allowed to enter, as a hull id, per tier: `{ "partner": null, "visitor": "drover" }`. `null` means no limit. The default keeps the two dearest hulls out of visitors' reach. |
| `gates` | Warp gates you want to build, e.g. `[{ "peer": "<server id>", "system": 4 }]`. See "Warp gates". |
| `acceptGates`, `maxGates` | Whether linked servers may propose gates to you, and how many gates the sector may hold (default 6). |
| `insuranceRate` | Deductible a pilot pays to get a destroyed ship back, as a share (0 to 1, default 0.05) of the catalog price of hull and fitted modules. A pilot who cannot pay gets the free starter ship and keeps their credits. Set 0 for free replacements. |
| `maxConnectionsPerIp` | Simultaneous connections from one address (default 16). |
| `trustProxy` | Set to `true` behind a reverse proxy that sets `X-Forwarded-For`, so limits apply per player instead of per proxy. |
| `dataDir` | Where the database lives (default `./data`). Back this directory up. |

The same settings can be given on the command line (`npm run server -- --port=9000 --name="My Sector"`)
or as environment variables (`PRIMACY2_PORT`, `PRIMACY2_NAME`, `PRIMACY2_PUBLIC_URL`, `PRIMACY2_PEERS`,
`PRIMACY2_DATA_DIR`, `PRIMACY2_SEED`, `PRIMACY2_SYSTEMS`).

## Being reachable

Players and other servers must be able to open your `publicUrl`.

- **At home:** forward the port on your router, or use a tunnel (for example Cloudflare Tunnel or
  Tailscale Funnel) and put the tunnel address in `publicUrl`.
- **HTTPS:** a page loaded over `https://` can only open `wss://` connections. If any server in your
  neighbourhood is served over HTTPS, players arriving from it cannot hand over to a plain `http://`
  server. Put the server behind a TLS-terminating reverse proxy (Caddy, nginx, a tunnel) once it is public.
  WebSocket connections use the path `/ws`.

## Where your sector appears

The position is decided once, on the first start, and stored in the database:

1. `position` from the configuration, if set.
2. Otherwise next to the first server in `peers` that answers, close enough that the starter hull can
   jump across.
3. Otherwise at a position derived from your server id inside the core region.

Sectors that are too far apart for fold jumps can be bridged with a warp gate, which both servers
have to build together.

## Warp gates

A warp gate joins one of your systems to a system of a linked server, whatever the distance.
It is a joint project: list the other server under `gates`, and once it accepts, a construction site
appears in both sectors. Pilots on each side deliver the materials and credits for their half at a
station in the gate's system. The pair opens when both halves are complete, and goes dormant while
the other server is offline.

## Trust

Your server never accepts statistics from another server. A visiting ship is rebuilt from hull and
module ids using your own catalog, cargo is cut to what the hull can carry, and unknown items are
dropped. Credits never cross: each server keeps its own balance for every pilot.

Because any operator can give himself goods and ships on his own server, you cannot check what a
visitor carries. Instead you rate each server, and the rating limits what its cargo and ships can turn
into on yours.

| Rating | Arrivals from that server |
|---|---|
| `union` | Goods and ships move freely, no tariff. Only in force when you rate each other union and publish the same rules fingerprint; otherwise treated as `partner`. |
| `partner` | Cargo is an import: it sells at your tariff, within the trade balance and the pilot's import licence. Ships are bound: they refund nothing in the shipyard. |
| `visitor` (default) | The pilot may enter, but all cargo is sealed: it can be carried out again or jettisoned, nothing else. Ships are bound. |
| `blocked` | Refused. The server also disappears from your galaxy map. |

Server ids are shown at start-up and at `/api/status`.

### Rating a peer

Put the id in `trust`:

```json
{ "trust": { "<id of a neighbour you trade with>": "partner", "<id of a nuisance>": "blocked" } }
```

Restart the server for the change to apply. Cargo already in a hold is judged at the moment it is
used, so lowering a rating takes effect on goods that arrived earlier.

For a partner you can set a bigger credit line in `tradeCredits`. A partner's goods sell only as far
as you have exported goods to it (or its credit line reaches), and only as far as the pilot has earned
here through missions, bounties on NPCs, survey data and mining. The pilot's station view shows the
allowance, and the pilot view shows the licence.

### Forming a customs union

A union is for operators who know and trust each other. Both operators:

1. Rate the other server `union` in `trust`.
2. Run the same version of the game with the same catalog and constants. Your rules fingerprint is in
   your descriptor under `trade.fingerprint`; if the two differ, the relation stays `partner`.

Whichever side changes a rule or updates the game first breaks the union until the other follows.
Inside a union ships and goods move freely, so a member that cheats can give everyone in the union
anything: only join operators you would trust with your economy.

### What trust cannot do

A partner you rate can still invent goods on its own server and sell them to you, within the credit
line, the licence and the tariff; a union member can do it without limits. Visitors cannot sell
anything. Link openly while you are exploring; rate partners one by one once your economy matters to
you, and leave `defaultTrust` at `visitor`. A ship's class limit (`shipLimit`) is published in your
descriptor, so a pilot is told before the jump when his ship is too large for your sector.

## Identity and backups

The database in `dataDir` holds your server key. The key *is* your sector: other servers know you
by it, and pilots who left through your sector return to it. If you lose the database, you lose the
sector's identity and its pilots' local records. Never share the database file.

## Endpoints

| Path | Purpose |
|---|---|
| `/` | The game client. |
| `/ws` | WebSocket for players. |
| `/api/status` | Name, id, player count (JSON). |
| `/fed/descriptor`, `/fed/known` | This server's signed descriptor and the descriptors it knows. |
| `/fed/hello`, `/fed/gossip`, `/fed/redeem`, `/fed/x/<topic>` | Signed server-to-server requests. |
