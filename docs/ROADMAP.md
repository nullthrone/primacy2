# Roadmap

State of the project, what the owner has decided, the order in which it is built, and what is
known to be open. Written on 2026-11-13 after the moon-landing work; keep it current, because new
work sessions start from this file. The reports of the engineers that built each part are in
`docs/reports/` (JSON, one per role).

## 1. Where the project stands

Built, tested and played through in the browser by `scripts/e2e.mjs` (fixed universe 16):

- Flight, combat, ship loss and insurance, wrecks, cruise, the maps.
- Trade between two servers: buying, a fold jump with the handoff to the second server, selling
  as an import with the tariff withheld, the flight home.
- Landing on an airless moon: cruise down to the ceiling, descent, touchdown, 30 s at rest, lift-off,
  docking at the ground base, a hard landing on purpose with damage and a wreck.

What "played" does not cover for the landing: it was one rocky moon in daylight. Nothing was judged
in motion (only stills), not at night, not on ice or desert bodies, not on large planets.

Built and covered by server tests, never played in the browser: mining, salvaging a wreck,
missions, NPC behaviour, warp gates.

Tests: 606 pass, 2 are marked as expected failures on purpose (see section 4).

## 2. What the owner has decided and is not built yet

The decisions were made in interviews; the wording here is the specification.

### Docking (replaces "fly within 1.5 km and press F")

- Request clearance, fly to the assigned pad, set down with the landing physics; a lift takes the
  ship into the hangar, then the station menu opens. Launch is the reverse.
- Automatic docking only through a purchasable landing computer (a module that takes a slot).
- Outposts, small stations and ground bases rest. Large ring stations turn: the pilot flies in
  along the spin axis and matches roll only. That needs a station model with an interior.
- Pads are truly scarce: a pad stays taken while the pilot is docked. On logout, or after about
  15 minutes idle, the ship goes into deep storage and the pad is freed; on login the pilot
  requests a pad again. No pad size classes: every pad takes every hull.
- NPC ships use the pads for real, with the same autopilot as the landing computer.
- Customs: a patrol ship scans approaching ships; the chance depends on the heat signature, so
  silent running lets smugglers through. Contraband found: confiscated and fined; fleeing or
  firing: wanted.
- Traffic rules (speed limit near stations, fines for ramming, blocking a pad, firing) enforced by
  patrols of the station's faction, with station turrets and reinforcements.
- Vulnerable everywhere: stations defend themselves but can be attacked in every system. This
  replaces the weapons lock near stations and bases in secure systems.
- Fines are deducted at once; a shortfall is a debt to that faction: no clearance at its stations
  except to pay. Landing anyway or repeated offences: wanted, with a bounty.
- Ground bases follow the same pad rules as outposts. The base model already has four pads
  (`GROUND_BASE_STRUCTURE.pads` in `packages/shared/src/structures.ts`, empties `pad_1..pad_4` in
  the model, checked equal on 2026-11-13).

### Gameplay depth for the MVP

- Mining "read and hit": a prospector scan shows veins; laser on the vein with the rock's heat in
  a window yields a multiple, overheating destroys the vein.
- Missions: bounty hunt for a named target that must be found, smuggling past customs, rescue and
  distress calls, escort of NPC freighters; chains.
- Exploration: timed scans whose value depends on closeness and line of sight, first discoverers
  named on the server's map; finds in space; finds on the ground of landable moons; exploration
  data as a trade good.
- Living economy: NPC freighters fly real routes and change stock, intercepting them makes
  shortage, events shift prices for hours. No production chains.
- Wings and pilot-to-pilot trade.
- NPC behaviour: pirates demand cargo before they shoot, evasive combat, traders worth robbing,
  radio calls.
- Faction reputation: better mission boards and pay, prices and fees, access (no clearance at bad
  standing, special ships and modules at good standing), rivalries; the faction's police attacks
  at very bad standing.
- Module damage: damaged modules work worse; station repair costs credits and some time;
  emergency repair in flight with spare parts.
- Fuel scooping as a manoeuvre with rising heat; refuelling and repair at a station take time.
- Tactical modules: point defence, jammer, cargo scanner, interdictor. Interdiction out of cruise
  is a duel; wanted at once in secure systems, only on attack in frontier systems, free in lawless
  ones; NPC pirates and patrols use it too.
- Onboarding: a guided, paid, skippable mission chain from the home station in the real game.
- Pacing: about five hours of play to the first better ship (95,000 credits).
- Not chosen: harsher death, blasting and refining in mining, targeting subsystems, modules lost
  for good, pad size classes, touch controls.

### Controls and sound

- Gamepad and joystick/HOTAS support, with a binding screen, defaults for common pads, and menus
  usable by controller. It is the only way to play on mobile devices for now; no touch controls.
- Sound concept "you hear your ship, not space": structure-borne sound, cockpit, radio with a
  filter, sensor sonification for what happens outside, silence as a means. Sources that fit the
  AGPL repository: sounds rendered by scripts in the repository, CC0 packs, public-domain NASA
  recordings, voices from open local speech models, the owner's own phone recordings. An audition
  page lets the owner listen and rate; the game's audio is changed only after that.

### The owner's first play session (2026-11-14)

He played the game himself for the first time and reported. Good: the controls, the shadows, the
light effects "fairly well". To do, in his order of weight:

- **Sound effects** are his largest complaint (the procedural ones in `packages/client/src/audio`).
  Step 1 below replaces them.
- **Finding things.** He misses a target system and a direction indicator: after flying past a
  station it is hard to find again. State of the code on that day: stations, outposts, bases and
  gates are marked only while they are on screen; an arrow at the screen edge exists only for the
  navigation target (which is set in the navigation panel, key N) and for a locked ship.
- **What is in the system** (bodies, stations, other ships in range) must be visible somewhere.
  The navigation panel (N) and the contacts panel (Tab) hold that, but nothing on the HUD shows it
  or says that they exist.
- **Station menus** change their window size from tab to tab; all tabs get one size.
- **Cruise star streaks** are drawn over the whole screen (they are made in the final pass) and
  must be hidden by the cockpit and by other objects.
- **Light effects**: he asks for more magic; the rays of distant stars look plain.
- **Textures** are mostly not pretty, the sky box least of all.

## 3. Order of work

Each step is one work session with its own workflow runs.

1. **Sound library and controller support.** Both are side work for the cheaper model and do not
   touch each other. Sound: the listening tools, the synthesis library and first sound set, the
   downloads with a licence list, the audition page.
2. **First-play feedback** (see the list above). Two parts, both on the strongest model. Light and
   sky: star glare and rays, the sky box, textures, cruise streaks hidden by the cockpit; this
   touches only `packages/client/src/render` and can run beside step 1. Orientation: a target that
   is chosen without opening a panel, an indicator that always leads back to it, the system's
   contents on the HUD, one window size for the station menus; this touches the HUD and the
   interface and follows the controller work, which changes the same files.
3. **Docking.** Starts with two graphics repairs that landing on a pad by eye depends on: the
   ground near the ship is soft and smeared (see section 4), and the dust burst of a hard landing
   draws streaks across the sky. Then the core (clearance, pads, lift, autopilot, the turning ring
   station as a co-rotating frame, gate ids), the ring station model with an interior, police,
   customs, fines and debt, NPC docking.
4. **The world lives.** NPC behaviour, freighters and events, interdiction, faction reputation.
   Before the missions, because smuggling needs customs, escort needs freighters and pay needs
   reputation.
5. **Earning.** Mining, the new missions with the five-hour pacing, exploration.
6. **Ship.** Module damage, scooping, tactical modules.
7. **Playing together and onboarding.** Wings, pilot trade, and last the guided chain, because it
   teaches all the other systems.

Model split, set by the owner: the core (shared simulation, architecture), everything graphical
and the look of the UI stay on the strongest model; well-specified side work (server gameplay
modules, tests, browser runs, docs, tools) goes to the cheaper one. Limits are never a reason to
downgrade.

## 4. Known to be open

Defects seen and left in:

- The ground near the ship (300 m and below, and landed) looks soft and smeared at high sun, while
  the base is sharp. The small relief also ends in a visible band 70 to 110 m from a low camera.
- After a hard landing dark streaks fan across the sky (probably the dust burst).
- The ground casts no shadows on itself: no long crater and hill shadows at the terminator.
- A pale disc of 800 m radius around every base at noon (the pad's fixed tone); ice ridges read
  as scribble from 50 km; rays around fresh craters look painted from 500 m.
- Landing light: a night approach can be flown by eye from about 250 m; from the cockpit the
  dashboard hides most of the pool; a landed ship lights only a patch under its nose.
- Drover and Bulwark stand on the hull underside; their antenna and keel blade stand in the ground.
- Landed in cockpit view the nose cannot be turned, so a base beside the ship is only a marker.
- Undocking at a ground base puts the ship about 740 m up (goes away with the new docking).
- Commodity names stay English when German is set (they come from the catalog, not from i18n).
- Status bars, power display, key line and the top left block of the HUD have no backing and are
  hard to read over sunlit ground.
- Projectiles and beams end at the ground; salvage and mining beams and the base structure do not
  stop shots. A missile that hits the ground does no area damage.

Open findings with a test marked as an expected failure:

- Gate ids: a gate added to a system that has a ground base gets a different anchor id than
  before the landing work, because bases count as sites. Fix planned with the docking core: gates
  get an id range of their own. Only universes created before 2026-11-13 are affected.
- Between 300 and 390 km over a large body, a ship that came from above is in the body's frame and
  one from below in the surface frame; side by side they are in different zones.

Rules that contradict a later decision or need a follow-up:

- Weapons are jammed within 4 km of a station or base in secure systems. The owner decided
  "vulnerable everywhere"; remove the jam with the docking work.
- Docking at a base now needs a clear line to the pad; the refusal "No clear approach: the terrain
  is in the way." is not translated and the dock prompt does not anticipate it.
- Refused commands reach the client as English sentences that the HUD matches word for word. A
  code on the command reply would end that.

Never verified:

- The terrain in motion (popping, shimmer, cracks while tiles settle). Only a person flying a
  descent can judge it.
- Frame times in the built game, weak graphics cards (six lights are always in the scene), any
  browser but Chromium, a lost WebGL context, a quality switch during play.
- `buildView` in `packages/client/src/game/Game.ts` and the HUD wiring have no test in the suite;
  `tools/dev/live-landing/live2.mts` checks them against a real server (about 90 s) and
  `live_guards.py` runs it with single rules switched off.
- The generator is not bit-identical between browser and Node for some body radii (a power
  function). The game is not affected, because the client receives every system from its server
  and generates none itself; the dev pages generate locally and can differ in the last digit.
- A full-detail terrain sample costs 3.08 microseconds on an 8,000 km rocky planet, over the
  3 microsecond target.

Other notes:

- In 3 of 24 generated two-server universes a starter ship cannot reach the neighbouring sector
  from the capital at all (no path with jumps of 9 light years). Sector placement does not
  guarantee it.
- A brand-new pilot's starter ship can be sold and free key pairs multiply it: a source of local
  credits the trade model does not bound.

## 5. How the work is done

- Branch `claude/primacy2-space-simulator-b9a0b8`; pushes go to this branch only, never to `main`.
- `bash tools/dev/checkpoint.sh` (run in the background) commits and pushes the working tree
  every five minutes for eight hours. One loop at a time.
- `python tools/dev/guards.py <spec.json>` switches one rule off at a time, runs the tests that
  must catch it and restores the file; every new rule is seen failing once this way.
- `python tools/dev/journal.py <journal.jsonl>` prints the reports of a workflow run.
- The browser test plays in a fixed universe: `scripts/e2e.mjs` sets `PRIMACY2_FIXED_UNIVERSE=16`
  (see `scripts/dev.ts`). In it Alpha's capital has a ground base on a rocky moon of 1,057 km
  radius, and a secure Beta system with a station is one jump away. Switches:
  `PRIMACY2_JOURNEY_ONLY=1`, `PRIMACY2_LANDING_ONLY=1`.
- Whether the game ports are in use: `netstat -ano | grep -E ":(8420|8421) "`. Do not grep for
  the word LISTENING: this Windows prints the state in German.
- The Python environment for the audio tools is `.venv-audio` (ignored by git): PyTorch with CUDA
  on the RTX 5080. In the Hugging Face cache: `laion/larger_clap_general` (compares a sound with a
  description), `openai/whisper-small` (speech recognition), `Qwen/Qwen2-Audio-7B-Instruct`
  (describes audio), `parler-tts/parler-tts-mini-multilingual-v1.1` (voices by description),
  `ACE-Step/ACE-Step-v1-3.5B` (music). `stabilityai/stable-audio-open-1.0` is gated and needs the
  owner's own login. The owner's condition for downloads: at least 10 % of the disk stays free
  (on 2026-11-13: 271 GB free of 2,047 GB, so about 65 GB of room). None of the large models has
  been run yet, and the licence of each model and each downloaded sound is to be read and recorded
  before first use.
