# Hosting a sector

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
  "defaultTrust": "neutral",
  "trust": { "<server id>": "trusted" },
  "tariff": 0.12,
  "maxPlayers": 200
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
| `defaultTrust`, `trust` | How arrivals from other servers are treated. See "Trust". |
| `tariff` | Share of the sale price withheld on cargo imported from `neutral` servers. |
| `gates` | Warp gates you want to build, e.g. `[{ "peer": "<server id>", "system": 4 }]`. See "Warp gates". |
| `acceptGates`, `maxGates` | Whether linked servers may propose gates to you, and how many gates the sector may hold (default 6). |
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

| Level | Arrivals from that server |
|---|---|
| `trusted` | Accepted. Their cargo sells at full price. |
| `neutral` | Accepted. Their cargo pays your tariff when sold. |
| `restricted` | The ship is accepted, its cargo is impounded. |
| `blocked` | Refused. The server also disappears from your galaxy map. |

Server ids are shown at start-up and at `/api/status`.

What trust cannot do: a server you accept arrivals from can still invent pilots and ships within the
limits above (any hull from the catalog, one full hold of cargo per arrival). Tariffs, impounding and
blocking are how you limit that. Link openly while you are exploring; tighten `defaultTrust` and
`openPeering` once your economy matters to you.

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
