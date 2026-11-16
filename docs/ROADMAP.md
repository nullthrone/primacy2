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

Built on 2026-11-14 and played in the browser with a simulated controller by
`scripts/pad-check.mjs` (114 checks): controller support for flight, menus, station screens, maps
and a binding screen. No real controller has been used yet.

Built on 2026-11-14 beside the game and not yet in it: the sound library and the audition page on
which the owner listens and rates. On 2026-11-16 its manifest (`assets/audio/render/manifest.json`)
lists 148 sounds. Sixteen of them are the candidates of round 4, the category `source` (see section
2). Counted by the field `source` of each entry, the other 132 are 99 `synth` (rendered by scripts:
75 sounds, eleven of them direction samples for the owner to choose between, and 24 voice samples,
the twenty of the speech comparison and four countdown samples) and 33 `download` (files with a
licence list). The sixteen carry the same field: twelve `synth` (made by the two models) and four
`download` (the recordings), so the whole manifest reads 111 `synth` and 37 `download`. The game
itself still plays the old procedural sound. Since 2026-11-15 there is also a comparison of five
open speech models (`tools/voice`), with twenty voice samples on the audition page, and since
2026-11-16 a listening test of two sound models and CC0 recordings (`tools/sound`), with its
sixteen candidates as the first category of the page.

Tests, run on 2026-11-16: `npx vitest run` passes 807 tests in 47 files, with 2 more marked as
expected failures on purpose (see section 4). The audio tools have tests of their own in Python:
`unittest discover` passes 22 tests of the listening tools, 54 of the synthesis and 77 of the
downloads and the build (`tools/audio/tests`); the screening of sound candidates has 32
(`tools/sound/tests/test_screen.py` is a script, not a unittest module: run it with
`.venv-audio/Scripts/python.exe tools/sound/tests/test_screen.py`); the scoring of the voice
comparison is in `tools/voice/tests` and was not counted today. The browser check of the audition
page (`tools/dev/audition-check.mjs`, last run by the builder of the second round-4 run on
2026-11-16) passed 48 steps in a run limited to the sixteen candidates and two test files, with no
scenes. The last full run, on 2026-11-15, passed 52 steps, among them a recording of everything the
page plays with no click added by the page; the check has changed since and was not run in full
again (see section 4).

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
  recordings without voices, voices from open local speech models, the owner's own phone
  recordings. An audition page lets the owner listen and rate; the game's audio is changed only
  after that.
- Added by the owner on 2026-11-14 after his first listening: the high-energy events (a hit on the
  shield, the fold jump and its exit) must sound energetic, hissing and rushing, not dull; and the
  sound must have width and places (stereo, spatial), not sit in the middle. The direction for
  every sound, the rules it is checked against and the owner's words from each listening round
  are in `tools/audio/SOUND_DESIGN.md`.
- Added by the owner on 2026-11-15 after his second listening: many sounds are too muffled, "it
  feels like a submarine simulation and not like a space sim"; it is a game, and a sound may be
  clearer and larger than physics. The beds he heard stay as they are (he approved every one);
  the short events get an attack, a body and a tail, and energy always has a bass throb. No
  recorded voices of real people: the NASA radio traffic is struck. Voices come from our own
  pipeline of generated speech: in the radio, as the ship computer and as station staff, in
  English, able to speak text the game generates, with artificial voices only (no real person as
  template, his own voice included). What happens outside the ship stays a sensor signal: asked
  whether it may now be heard as real sound, he answered "not for now".

### Sound library and controller support (built on 2026-11-14)

The sound library, all of it outside the game's runtime:

- `tools/audio/listen`: tools with which an agent that cannot hear measures a sound (levels,
  loudness, spectrum, envelope, loop seam, two channels, a spectrogram picture), compares it with
  descriptions (CLAP), transcribes speech (Whisper) and has it described (Qwen2-Audio).
- `tools/audio/synth` and `tools/audio/build.py`: the synthesis library and one script per
  category; `tools/audio/sounds.json` is the list of the 75 sounds (64 before the direction samples
  of round 3) and what each is meant to be. The build renders them, checks every rule and writes
  the manifest. Rendered files are not in git; the build is deterministic and makes them again.
- `tools/audio/fetch.py`, `assets/audio/downloads.json`, `assets/audio/CREDITS.md`: 5 CC0 packs
  from kenney.nl and NASA recordings without voices (25 entries, about 160 MB, not in git,
  fetched again by the script with checksums), every file with its licence and where it was
  read. On 2026-11-16 ten CC0 items from opengameart.org were added for the sound-source test (35
  entries in all, 16 MB of archives; they are not in `selection.json`). 32 NASA entries with
  speech were struck on 2026-11-15 and are listed with the reason. 33
  files are picked for listening (`assets/audio/selection.json`). The build processes every
  picked file before anyone hears it: level from the table of the rendered sounds, no step at
  either end, loops crossfaded, a clipped source marked.
- The audition page (`packages/client/dev/audition.html`, a page of the dev server only): every
  sound alone, the engine levels on one thrust slider, a stage (mono, stereo, headphones, a room
  slider), four scenes (docking approach, combat, moon landing, fold jump), ratings that are
  saved to `assets/audio/ratings.json`, and a mark on sounds that changed since their rating.

Listening rounds (`assets/audio/rounds/` keeps what he heard in each; his words and the
measurements are in `tools/audio/SOUND_DESIGN.md`, section 4):

- Round 1 on 2026-11-14 (20 of 114 rated) approved the engine idle, the cruise chain, the fold
  charge and tunnel, the cabin and the missile warning, and rejected the shield hits, the fold
  jump and exit and the shields-down alarm; 20 sounds were reworked for it.
- Round 2 on 2026-11-15 (32 rated on the current files, 49 in all). He did not go through
  everything, "because above all we have to judge the big picture anew". Every bed he heard
  fits. Every dull short event is wrong, each with the same words ("as if someone knocked on a
  dull plastic container"): thruster pulses, hull hits, landing gear. The shield hits are close
  ("energetic must always have a bass throb as well"). Measured, the rejected events have 50 to
  83 % of their energy in the one octave from 125 to 250 Hz, no attack above 1 kHz and nothing
  below 60 Hz; an approved dull boom has depth, and rejected bright hits are tiny. So the answer
  is not "brighter" but "a shape and weight". He heard crackling: it was in the downloaded
  files (hard cuts, played 10 to 20 dB too loud) and in the page (a compressor as limiter,
  loops that started on a step); both are repaired.
- Round 3 (2026-11-15: eleven direction samples for hull hit, thruster pulse, landing gear and
  shield hit, and twenty voice samples), heard: seven ratings, all on voices. "The voices are
  really good", but the countdown did not count in seconds (measured: 0.18 to 0.75 s from number
  to number). His proposal is now the rule: speech that must keep time is made of single clips
  placed by a clock. A countdown built that way stands on the page in four versions (two models;
  the numbers spoken one by one, or cut out of one sentence; one second from number to number,
  measured to about 10 ms by three methods). Nobody has heard it yet.
  Of the direction samples he rated none and chose none: "we are slowly going in the right
  direction, but everything still sounds too artificial and boring. Are there no better local
  models for generating audio?" Asked which sample came nearest, he said he liked none of it and
  can only describe it badly. So no direction became a rule and nothing was rendered anew. He is
  no longer asked to describe sounds: he gets candidates and accepts or rejects them. Over three
  rounds the ratings show one pattern: long beds pass and short events fail, from every source
  (rendered by formula or recorded; the one short event he ever approved is a recorded low boom).
  The reworked fold jump, fold exit, shields-down alarm and cruise charge of round 1 are still
  unrated, and nothing was said yet about the stereo stage.

He offered to record household sounds with his phone: the list is `tools/audio/RECORDINGS.md`.

Not built: the game's runtime audio on the library (see section 3), the voice pipeline (only the
comparison of models exists), music (the model is downloaded and has never been run).

### Voices: a comparison of open speech models (2026-11-15)

`tools/voice` holds a comparison and no pipeline. About forty open models were looked at with the
licence read at the source (`tools/voice/CANDIDATES.md`; the dossiers are in
`docs/reports/2026-11-15/voice-dossiers.json`). Most fail a rule of the owner: non-commercial
terms, a gated repository, or only voices of real speakers. Five were run, each in its own
environment under `.venv-voice/`, on fifteen test lines (radio, ship computer, station staff,
invented names, numbers) in four invented voices. `tools/voice/RESULTS.md` has every figure;
nobody has heard a voice yet.

| model | voices | speed (below 1 is faster than real time) | open point |
|---|---|---|---|
| Qwen3-TTS (1.7B designs, 0.6B speaks) | built from a text description | 1.8 to 3.0 on the graphics card, 3.6 to 3.8 on 4 processor threads | too slow for live speech with the package as it is |
| Chatterbox-Nano (110M) | speaks in the designed Qwen3 voices | 0.65 to 0.79 on 4 threads, 0.53 to 0.70 on 8 | always embeds an inaudible watermark; 4.5 GB of memory |
| Kokoro (82M) | blends of the model's presets | 0.14 on 4 threads | where the presets come from is not documented; needs a GPL library for invented names |
| Kitten TTS 2 Mini (82M) | the model's presets | 0.15 on 4 threads | the makers do not say where the voices come from |
| Phonon 31M | the makers' designed fantasy characters | 0.07 on 4 threads; runs in a browser tab (65 MB) | no voice fits a role; slow speech with long pauses |

The speech recogniser read every model back with few errors on ordinary words; invented names
came back as written in 10 to 15 of 24 cases, which mixes the models' errors with the
recogniser's. Every model keeps a voice the same from line to line by the measure used.

What follows from it, for the owner to decide after listening: the voices are designed once with
Qwen3-TTS; what speaks while the game runs must be a small model, and only Chatterbox-Nano among
the five speaks in a designed voice on a processor. The small preset models are several times
faster and one runs in the browser, but their voices are not shown to be free of a real person
as template. Not tried: a small model that takes a designed voice and runs in the browser (one
candidate appeared the day before the comparison, ZONOS3-Mini; the provenance of its voice data
is unclear), text normalisation (numbers, units, call signs are written out by hand in the test
lines), and how the game asks for speech (ahead by the server, cached by content, or in the
browser).

Controller support: gamepads and joysticks through the Gamepad API feed the same input values as
keyboard and mouse (`packages/client/src/input/gamepad.ts`, pure logic with tests); binding codes
live beside the key codes in the settings; defaults for Xbox and PlayStation pads with Y as the
modifier for chords; a binding screen in the settings (assign by pressing or moving, dead zone,
curve and invert per axis, a throttle lever); menus, station screens and maps are driven by the
D-pad and A, B, LB, RB (`packages/client/src/ui/padnav.ts`); hints name the control of the device
last used; English and German. `docs/CLIENT.md`, section Controls, has the layout. A review found
21 defects, a second pass confirmed 19, and all 19 are fixed with tests.

### Sound sources: a listening test of two models and recordings (round 4, 2026-11-15 and 16)

`tools/sound` holds a listening test and no new library. Nobody listened to anything in it.

Why. After round 3 the owner said on 2026-11-15: "Wir gehen langsam in die richtige Richtung. Aber
es klingt alles noch zu künstlich und langweilig. Gibt es keine besseren lokalen Modelle zur
Audioton-Genese?" He is no longer asked to describe sounds; he gets candidates and accepts or
rejects them.

Approved. Asked whether two sound models and CC0 recordings (about 27 GB) may be downloaded for a
listening test, he answered "Ja, alle laden". That covers exactly three sources, and anything
beyond them needs a new yes: MOSS-SoundEffect v2.0 (Apache-2.0), Stable Audio 3 Small-SFX Base
(Stability AI Community License; its output is test material until he decides) and CC0 recordings
from OpenGameArt. No gated repository, no login, no token.

Delivered, for four families (hull hit, thruster pulse, landing gear, shield hit):

- MOSS: 72 candidates (3 prompts x seeds 11 to 16 per family), 48 kHz, one channel, 17 to 18 s each.
- Stable Audio 3: 72 candidates, 44.1 kHz, two channels, about 2 s each. The checkpoint is the one
  before the makers' last training stage (the finished one is gated).
- OpenGameArt: none in the first run, 21 excerpts of nine items in the second. In the first run
  `fetch.py` allowed only kenney.nl and nasa.gov, and the recordings agent's attempt to add the
  host was refused as a change to a safety control outside its file list. The orchestrator added
  the exact host (no subdomain) with tests, because the owner's approval named this source, and
  told him. An allow-list is changed by the orchestrator, visibly, never by a sub-agent.

First run (2026-11-15): of 144 files 53 were thrown out, sixteen were published. Its audit found
the generators sound (scope, licences, weight loading, four of four files made again identical)
and six faults in the choice: (a) at the page a two-channel file came out 3 dB quieter than a
one-channel file of the same loudness, so every Stable Audio pick was quieter than every MOSS pick;
(b) one gear pick was cut by the family's longest length while still loud; (c) one copy was 0.8 LU
off its target, the gain not measured again; (d) six hand skips were recorded only in a
git-ignored file; (e) 41 of 72 Stable Audio files were thrown out as clipped, by a clamp in the
makers' code after the decoder; (f) `publish.py` reordered the manifest to satisfy a page check.

Second run (2026-11-16), four builders. Stable Audio was made again, same seeds, decoded without
the clamp (50 of 72 files peak above 1, the highest 1.94). Screening changed: three equal samples
at the extreme count as clipped, the cut-off rule also holds at the family length, the hand skips
are a committed file (`tools/sound/skips.json`), and a copy is set by measurement to within 0.05
LU of the page level. Ten OpenGameArt items were fetched through `fetch.py`, each page read for
"License(s): CC0". Of 165 candidates 38 were thrown out (31 cut off, 6 several events, 1 music)
and 127 kept (MOSS 41, Stable Audio 66, recordings 20). The sixteen were published.

Independent check (`docs/reports/2026-11-16/sound-verify2-report.json`), seven points. Held by its
own measurements: level (page output estimated from loudness and measured gain: the family target
within 0.1 dB, one 0.41 s file 0.33 dB), the cuts (smallest margin 26.8 dB against 20 dB), Stable
Audio without the clamp (two files made again, bit-identical), the recordings (ten pages read, CC0
on each), the choice (a plain run gave the same sixteen) and scope (`ratings.json` unchanged by its
hash, the manifest of 148 sounds validates). It found one failing test (`test_screen.py` pinned the
six old skips) and eleven wrong or over-reaching sentences in the documents. Not verified by it:
how anything sounds, the page check (not re-run), whether the pack authors may release their packs
as CC0, whether the recordings are recordings, the route of the bytes through `fetch.py`.

The orchestrator then repaired the test (it checks the form of the skips; 32 of 32 pass), corrected
the sentences the check listed, looked at the sixteen spectrograms (no pick changed), measured that
MOSS presses loud output against full scale inside its decoder (a tanh: 49 of 72 raw files peak
above 0.99, the shield files have a crest of 3.6 to 11.1 dB, the published pick 7.7 dB; no pick was
changed, it is the model's own output), and changed the page so that the block of the four
recordings no longer says that they play at their own loudness.

The sixteen, per family a MOSS pick, a Stable Audio pick, a recording and one more generated pick
(ids and figures in `tools/sound/RESULTS.md`; "s16" is seed 16 of that prompt):

- Hull: MOSS hull_1 s16; Stable Audio hull_2 s11 and hull_1 s13; metal hit (rubberduck, 0.74 s).
- Thruster: MOSS thruster_2 s11 and thruster_1 s11; Stable Audio thruster_2 s12; steam hiss (bart).
- Gear: MOSS gear_2 s12; Stable Audio gear_3 s15 and gear_2 s15; lock click (rubberduck, 0.49 s).
- Shield: MOSS shield_3 s14; Stable Audio shield_3 s11 and shield_2 s16; spark (BMacZero, 0.26 s).

State on 2026-11-16. They stand on the audition page as its first category, "Klangquellen (Runde
4)", 0 of 16 rated: the twelve generated ones under "Von uns erzeugt", the four recordings in a
block below. He is asked to accept or reject each ("Passt" / "Falsch") and to describe nothing. The
four countdown samples (`voice_5_countdown_*`) are unheard as well. While he rates,
`assets/audio/render/source` is frozen: `screen.py`, `publish.py` and `tools/audio/build.py` are
not run on the real tree until his ratings are recorded the way round 3 was
(`assets/audio/rounds/round4.json` with the file hashes, `round4-ratings.json` with the ratings),
since a new publish changes ids or hashes and orphans ratings.

What follows, the orchestrator's plan and not his decision. If he accepts candidates of a source
for a family, the event sounds of that family are made anew from that source (more candidates from
the accepted prompts or items), and only then do the rules in `tools/audio` get new numbers, taken
from what he accepted. If Stable Audio wins anywhere, he first decides on its licence (registration
and a revenue cap for commercial use; the finished checkpoint is gated and needs a login, which is
his decision too). If he accepts nothing: Freesound CC0 with his own account, recordings made at
home, or other models, each needing a new yes. Not to be started without his word: the voice
pipeline, the game's runtime audio, a re-render of the event sounds, other downloads, music.

### The owner's first play session (2026-11-14)

He played the game himself for the first time and reported. Good: the controls, the shadows, the
light effects "fairly well". To do, in his order of weight:

- **Sound effects** are his largest complaint (the procedural ones in `packages/client/src/audio`).
  Step 1 below replaces them.
- **Finding things.** He misses a target system and a direction indicator: after flying past a
  station it is hard to find again. State of the code on that day: stations, outposts, bases and
  gates are marked only while they are on screen; an arrow at the screen edge exists only for the
  navigation target (which is set in the navigation panel, key N) and for a locked ship. Built on
  2026-11-14, see "Orientation on the HUD" below.
- **What is in the system** (bodies, stations, other ships in range) must be visible somewhere.
  The navigation panel (N) and the contacts panel (Tab) hold that, but nothing on the HUD shows it
  or says that they exist. Built on 2026-11-14, see below.
- **Station menus** changed their window size from tab to tab; all tabs get one size. Done on
  2026-11-14: the station screen is one window on every tab and its content scrolls inside.
- **Cruise star streaks** were drawn over the whole screen (they were made in the final pass) and
  had to be hidden by the cockpit and by other objects. Done on 2026-11-14: the streaks, the
  radial smear and the blue shift act on the sky alone, before anything else is drawn
  (`packages/client/src/render/post/Cruise.ts`), so bodies, ships, stations, the ground and the
  cockpit cover them and stay sharp. It costs nothing outside cruise and 0.27 ms per frame in
  cruise at 3840x2160 on the RTX 5080. The fold tunnel, the charge glow, the heat haze and the hit
  flash still lie over the whole frame, the cockpit included.
- **Light effects**: he asked for more magic; the rays of distant stars looked plain. Built on
  2026-11-14 as proposed to him and chosen by him ("your recommendations"): the glare of a star
  is light in the lens, drawn in the final pass (`packages/client/src/render/post/lens.ts`): a
  soft veil, a pale ring with a colour fringe, six thin rays as from a six-bladed aperture, each
  beaded with faint colour. It goes out softly when the star is covered: by a body (computed, with
  the reddening of an atmosphere), or by ships, stations, the ground and the cockpit (read from
  the depth buffer, which now keeps the local scene and the cockpit side by side, see
  `COCKPIT_DEPTH`). In the cockpit, fine scratches and dust in the canopy glass light up around a
  bright star. The bloom has two wider levels than before (eight), a longer faint tail, and takes
  3 % of the light below its threshold as a veil; it is still added on top of the picture, at
  about the old total. The exposure follows the light in view with the delay of an eye, within
  0.62 to 1.25 (`post/Exposure.ts`). Measured at 3840x2160 on the RTX 5080, old against new, with
  about 0.05 ms of noise between runs: the canopy scratches cost about 0.17 ms per frame while a
  sun shines into the cockpit; the glare itself, the exposure and the wider bloom cost nothing that
  can be measured (the whole bloom chain is about 0.07 ms, before and after).
- **The sky box** he liked least: the far stars were low in resolution and looked static. Built on
  2026-11-14: every star is a point of light of its own (`packages/client/src/render/space/Sky.ts`),
  48,000 of them at the highest quality level, with a real spread of brightness and colour, sharp
  at any resolution; the brightest show small rays in the pattern of the sun's glare. The sky is
  the same from every system (only the stars of the game's own systems move). The cube map holds
  only what is diffuse: the glow of the galactic band with its dust lanes and a few small pale
  nebulae. The new sky costs nothing that can be measured (a view without a sun: 2.16 ms per frame
  before, 2.13 ms after, at 3840x2160 on the RTX 5080).
- **Textures** were "mostly not pretty". He named planets from close up, the ground while
  landing, ships, stations, the cockpit and asteroids; what exactly bothers him he has not said,
  so the work followed what the pictures showed. Built on 2026-11-14 and 2026-11-15, all of it
  in the shader, with no image files and no change to the models:
  - Ships, stations, gates and bases: every `hull_*` material is cut into plates of varied size
    with thin joints, small differences in tone and gloss from plate to plate, stains and fine
    grain (`packages/client/src/render/local/objects/surface.ts`). The pattern is a function of
    the position on the model, because the models have no texture coordinates; plates fade out
    between 8 and 3 pixels of width. `hull_primary` is 14 % darker than it was.
  - Cockpit: readable at every quality level. Six small cool lamps at the lit strips, a neutral
    cabin fill and a bounce of the sun (`objects/lights.ts`); the `cockpit_*` materials are
    lighter, less metallic and plated like the hulls.
  - Asteroids: relief over two to four scales, mottling, sparse pits.
  - Planets from close up (`packages/client/src/render/space/planetShader.ts`): once a planet
    stands large in the view, clouds get lit relief on their tops and fray at their thin edges
    while a thick deck stays closed; coasts are crisp, land has fine relief, the sea a sun glint;
    giants get fine structure sheared along their bands; the glow of a lava planet resolves into
    rafts with glowing seams; rocky bodies get small craters. From 3.1 radii outward the picture
    is the same as before (compared at a frozen clock).
  - The ground while landing (`packages/client/src/render/local/terrain/material.ts`): from about
    100 m down to standing on it the ground has grain at five sizes from 6 cm to 16 m (a noise
    texture made in code), soft craters of 0.6 to 3.8 m, patches of tone, and stones of 10 to
    80 cm across, most of them small, that stand up, cast a shadow and show their flank to a low
    camera; close to the camera lies flat gravel. All of it is shading: the surface the ship lands
    on has not moved. Each size fades by the size of a pixel on the ground, which also removed
    the band at 70 to 110 m. From 2 km the picture is the same as before. Quality 0 draws grain
    and craters without stones.

  Cost at 3840x2160 on the RTX 5080, in ms per frame. The "after" values were measured again on
  the evening of 2026-11-15 on an idle card (4 % load before the run); the "before" values come
  from the workers, who measured old and new in turns.
  - Plating: 0.2 to 0.3 with a station filling the view (2.4 in all), nothing measurable on small
    ships and asteroids (an asteroid field 2.5).
  - Cockpit: 0.4 to 0.5 with its lamps (2.1 before, 2.6 after).
  - Planets: a ship over an ocean planet 13.1 before and 8.5 after (7.6 at quality 1), an
    earth-like planet from 1.15 radii 17.1 and 13.7. Work that is hidden is now skipped, which
    saves more than the detail costs. A gas giant 5.4 and 6.1, a rocky body 6.0 and 6.8 (the
    workers' values, not measured again). Frame times are even: the 99th percentile lies within
    12 % of the median.
  - Ground, detail switched off and on within one page: landed 3.23 and 3.54 (+0.31); 30 m up
    and looking down by 30 degrees 3.57 and 4.31 (+0.74), which is more than the 0.5 the detail
    was meant to cost. The tier of quality 0 costs +0.20 and +0.44 in the same two views.

  A measurement an hour earlier, while other programs held the card at 36 to 81 %, read up to
  four times these values; see section 5 for how to tell.
- After his next test he wants to be asked what to improve in light, sky and textures, with
  proposals of what more is possible.

### Orientation on the HUD (decided and built on 2026-11-14)

The owner was shown three sketches and chose:

- Indicator: arrows and a compass now, and a radar sphere as the step directly after them (ships
  in range as points with a stalk, places as marks on its rim). The radar sphere followed on the
  same day, see "The radar sphere" below.
- What the system holds: one line always, and a list that opens while stepping.
- With nothing chosen: every place to dock and every gate has its own small arrow, always.
- Choosing: keys of their own for places, T and G stay for ships, "target ahead" also takes
  places, and the D-pad steps on a controller.

Built: see `docs/CLIENT.md`, "Targets and direction indicators". In short: O and L (D-pad right
and left) step through the places, places to dock first; Y (D-pad up) takes what is ahead: a
ship, wreck or pod if one lies in the cone ahead, otherwise the place the nose points at, and with
nothing new the next ship; U (D-pad down) lets go of the ship first and of the place second. The chosen place and the locked ship are two targets side by side. Edge arrows, compass,
the panel of the place with closing speed and arrival, two system lines, the list.

Decided by the engineer, for the owner to overrule: D-pad left and right used to step through
ships; they now step through places, and a standard pad has no button left for stepping through
ships (see `docs/CLIENT.md`). The key line in the corner of the HUD became key caps in two columns
and no longer repeats the power keys (they stand beside the pips) or the lists (beside the system
lines). The navigation panel (N) lists places in the order of the stepping.

Decided by the owner on 2026-11-14, after the first build: "target ahead" takes a place only
while no ship, wreck or pod lies in the cone ahead (about 26 degrees around the nose). With one
there the press locks it, and the chosen place stays, so a press in a fight never replaces the
destination. The price: a station with traffic in front of it cannot be taken by pointing at it;
it is chosen with O and L.

Checked in a browser on the development page by `node tools/dev/orient-check.mjs` (1280 x 720,
German and English) and in the game by `scripts/e2e.mjs` (O, L, U, "target ahead" keeping the
chosen place with a ship in the cone and taking a place with none, with the keyboard) and
`scripts/pad-check.mjs` (the D-pad). Not checked: a real controller;
the look in motion (only stills were judged); arrows and compass in cruise, in a fight and near a
gate (no universe of the tests has a gate); the forward and back side buttons of a mouse (they are
the browser's back and forward buttons; the game now takes them while a pilot plays, which no
test presses). "By mouse" means those two buttons in flight and clicking in the panels N and Tab:
the pointer is captured in flight, so nothing on the HUD itself can be clicked.

One thing about the browser test is not explained. On 2026-11-14 `scripts/e2e.mjs` ran three times
with the same game code. Twice it stopped in the first minutes at a step that steers the ship with
the mouse hook ("could not bring the second pilot into view"; the second time the new step that
turns the nose at a station failed the same way). The third and a fourth time it passed in full,
the steering steps settling within seconds at 61 frames per second. The two failed runs had been
started as detached background jobs of an agent session, the two passing ones in the foreground;
whether that is the cause was not established. `scripts/pad-check.mjs` passed both times it ran.

### The radar sphere (built on 2026-11-14)

The last part of what the owner chose for orientation. What it shows and how it is drawn:
`docs/CLIENT.md`, "Targets and direction indicators". It only displays; no control was added.

Decided by the engineer, for the owner to overrule:

- It stands to the right of the speed readout. To the left, between the power display and the
  centre block, there are 146 px at 1280 x 720 and only 70 px over the ground; to the right there
  is room for an instrument 152 px wide in both cases, and the key caps in the corner did not have
  to move.
- The compass stays, to the left of the speed readout. The radar shows the chosen place and the
  locked ship too, so the two overlap in what they say; the compass is the finer aid for turning
  the nose onto one target (dead ahead is its middle), the radar the picture of everything around.
  Settled by the owner on 2026-11-15, asked whether the compass should stay beside the radar:
  "Kompass bleibt".
- The distance is logarithmic with fixed rings (100 m, 1 km, 10 km, rim at 100 km), not a range
  that switches: nothing on the instrument jumps, and a pod 200 m off and a ship 50 km off both
  have a place. The price is that the scale has to be read: the rings are named under it. A ship
  in cruise is detected across the whole system; whatever is farther than 100 km stands at the
  rim's distance in its direction, drawn hollow.
- Places are marks on the rim at their bearing in the ship's plane; a stalk with an arrowhead
  points up or down from each by how far the place lies above or below. The mark itself never
  leaves the rim, so that places and contacts cannot be mistaken for each other: a first version
  put the mark at the end of the stalk, where it stood among the contacts. The stalk of a place
  is compressed (at most 0.4 of the radius); the stalk of a contact is to scale.
- Below a view width of 900 px the radar is left out: the bottom row of the HUD has no layout for
  a phone yet and overlaps there already.

Checked by `node tools/dev/orient-check.mjs` at 1280 x 720 on the development page: every contact
and every mark stands where a calculation apart from the interface puts it, to 1.5 px (a ship
ahead, left and above; one behind, right and below; one 21 km below; one 407 km off); red for a
hostile ship, green for another pilot, a hollow amber square for a wreck, amber for a pod, the
ring on the locked ship; a mark per place to dock and per gate, the chosen place in amber, a
celestial body as the chosen place; with the camera turned 55 degrees away from the nose the
radar still shows the ship's axes; nothing lies over anything else in German and English, in the
system with 19 places, over the ground (also with controller hints). The geometry has unit tests
(`ui/orient.test.ts`). Not checked: the radar in the game with a server behind it (the browser
tests of the game, `scripts/pad-check.mjs` and `scripts/e2e.mjs`, do not look at it; they pass
with it on the HUD); the look in motion and in a
fight with many contacts; a real gate (the development page turns a beacon into one); cruise; a
view wider than 1920 px (the instrument grows with the interface's unit of size, as every HUD
block does); a ship standing on the ground, where the centre block holds other lines and the
radar hangs on its width; view widths between 900 and 1280 px, where the radar comes nearer to
the key caps than the 13 px it keeps over the ground at 1280; the chase camera (every check of
the radar uses the cockpit, where the ship is two metres from the camera).

The browser tests of the game start their own two servers on ports 8420 and 8421. On that day a
development stack of the owner's was up on those ports, so `scripts/dev.ts` now takes
`PRIMACY2_DEV_PORT` (Alpha on that port, Beta on the next) and `PRIMACY2_DEV_DATA` (a data
directory of its own), and both test scripts follow `PRIMACY2_DEV_PORT`. Run that way (ports 8430
and 8431, an empty data directory) `scripts/e2e.mjs` took 18 minutes and passed; it was started
in the foreground and went on in the background after ten minutes.

## 3. Order of work

Each step is one work session with its own workflow runs.

1. **Sound library and controller support.** Built on 2026-11-14 (see section 2). What is left of
   the sound, in this order: a source of short events that the owner accepts (round 3 chose no
   direction; in round 4 he accepts or rejects candidates from two generative models and from
   CC0 recordings, see `tools/sound`); the event sounds made anew from what he accepts and
   heard once more; the game's runtime audio rebuilt on the library (files instead of
   oscillators, the stage with places, two channels and the cabin's impulse response, levels as
   rendered); the voice pipeline, designed with him after he has heard the models (see "Voices"
   in section 2); music. The runtime audio and the design of the voice pipeline are core work
   for the strongest model; `docs/NEXT.md` is the brief. What is left of the controller: the
   owner's own test with a real pad.
2. **First-play feedback** (see the list above). Two parts, both on the strongest model. Light and
   sky: star glare and rays, the sky box, textures, cruise streaks hidden by the cockpit; this
   touches only `packages/client/src/render` and can run beside step 1. Of it the streaks, the
   light and the sky are built (2026-11-14) and wait for the owner's next test; the textures are built
   (2026-11-15) and wait for the same test. Orientation (a target that is chosen without opening a panel, an indicator that
   always leads back to it, the system's contents on the HUD, one window size for the station
   menus) is built (2026-11-14) and waits for the owner's next test. The radar sphere, the last
   part of what he chose for it, is built as well (2026-11-14) and waits for the same test.
3. **Docking.** Starts with a graphics repair that landing on a pad by eye depends on: the dust
   burst of a hard landing draws streaks across the sky. (The other one, the soft ground near the
   ship, was done with the textures on 2026-11-15.) Then the core (clearance, pads, lift, autopilot, the turning ring
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

- The ground near the ship, after the detail of 2026-11-15: the stones are painted, so the ship
  neither touches them nor is hidden by them, and a large one seen from close by is a block with
  a flat top. From the cockpit the ground beyond about 30 m stays smooth. The edge of a base's
  apron is hard against the new grain. In a low approach the detail costs 0.74 ms per frame at
  3840x2160, more than the 0.5 ms it was meant to.
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
- At phone size held sideways (844 x 390, played with a controller) the bottom row of the flight
  HUD overlaps: status bars, power display, compass and speed readout have no layout of their
  own for that width. Panels fit and scroll inside themselves.
- An arrow for a place and the label of another can lie close together when two places are in
  nearly the same direction; the nearer one keeps its label and the other shows the arrow only.
- Projectiles and beams end at the ground; salvage and mining beams and the base structure do not
  stop shots. A missile that hits the ground does no area damage.
- Surfaces of 2026-11-15. Hull plates do not follow the grooves that are modelled, because the
  models have no texture coordinates; on the dashboard wings of the cockpit, which are turned by
  30 degrees, the joints follow the model's axes and not the wing. The fracture planes of the
  asteroid models are large flat triangles and stay visible under the relief. A light hull still
  clips to white in full sun, and the shadow side of a hull is nearly black. At quality 0 the
  cockpit has no shadow map, so the sun in the cabin is scaled by how far the canopy is open to it.
- Planets from close up. The glow of a lava planet falls as the camera comes nearer than 2.4
  radii (to about 0.64 of the old value inside 1.25 radii, and slightly redder), because the full
  glow drowned the seams in bloom. The streaks of an ice giant are uniformly diagonal. From 1.05
  radii the clouds are softer than from a ship in low orbit, and at 1600x900 with quality 1 the
  cloud deck has texture of one scale only. Quality 0 keeps the old surface. Ice bodies with an
  atmosphere, the lights of the night side and everything on the baked maps are untouched.
- A planet that fills the view is the most expensive picture of the game: at 3840x2160 on the
  RTX 5080 a ship over an ocean planet takes 8.5 ms per frame and an earth-like planet from 1.15
  radii 13.7 ms, against 2.4 ms for a station filling the view. That is less than before the
  close-up work, but nobody has looked at what it means on a weak graphics card.
- The stars of the neighbouring systems are still soft discs without rays; only the sun of the
  system and the brightest points of the sky have the new glare.
- The fold tunnel, the charge glow, the heat haze and the hit flash are drawn over the whole
  frame, the cockpit included.
- Light in the lens: a black hole's disk has none; the core of a star that stays in the scene is
  not reddened by an atmosphere in front of it, only its glare is; a bright star of the sky that
  leaves the view loses its rays at once, because a point is clipped as a whole.
- On `dev/space.html` every scene counts as a cockpit view, so the scratches of the canopy glass
  show there although no cockpit is drawn.
- Controller: with no pointer lock, a key pressed while a stick is held switches the device to
  keys and the stick's thrust drops to zero until the stick has been at rest once. The help block
  for controllers names the default layout, not the pilot's own bindings (it says so). Two pads
  of the same model share one device key. After a menu or panel closes, an axis stays silent
  until it has been at rest once (so that a stick still held does not fly the ship): a slider or
  throttle bound as a plain axis rests at an end stop and so goes dead after every panel; only an
  axis bound as the throttle lever is exempt. A joystick or HOTAS pilot will meet this.
- Sound library: the radio filter fails its rule on speech clips shorter than about 3 s (the
  speech model mishears them even unfiltered; lines of 20 s pass with 0 to 9 % word errors). The
  rattles in the heavy hull hit sit at even distances. On the audition page the level of a point
  source in the Headphones setting against Mono and Stereo was never measured (Stereo uses a
  balance law that keeps a source ahead at the file's level). The intent texts on the page are
  English only.
- Sound library, since round 2: the rules in `tools/audio/synth/rules.py` still check one-shots
  of the structure and energy paths the old way (dull); round 3 chose no direction, so they get
  new numbers only when he has accepted a short event. Some rendered one-shots start on a sample that is not silence
  (the three shield hits, the fold jump and exit, which carry on from the sound before them, the
  radio squelch): the audition page fades such a start, the game's runtime will have to do the
  same or the files are changed at the re-render. The downloaded NASA recording of the SLS test
  firing is clipped in its source (marked; the owner rated it as fitting), and the recording of
  the laser shots is a row of hard snaps by nature. The speech recogniser finds no words in the
  eleven NASA recordings that are left, which does not prove that nobody speaks in them. Three
  downloads are loops (Cassini, the rover driving, Ingenuity): they wrap without a step, but
  the recordings of Cassini and of the rover change their own level by 4 to 7 dB near the cut,
  which may be heard as a pulse once per loop; other excerpts would cure it. The plasma hiss
  fades in and out by itself and is a one-shot for that reason.
- The click detector of the audition check (`packages/client/src/dev/audition/capture.ts`)
  compares a step with the steps around it. In loud dense noise a click that fits under full
  scale does not stand out by that measure and is not found; as far as a measurement can say it
  is masked there. The check's "no click from the page" holds within that limit.
- The measuring tools and rules of the sound library (`tools/audio/listen/measure.py`,
  `tools/audio/synth/rules.py`, `tools/audio/build.py`) have their own tests but were not
  reviewed by a second pair of eyes, and every "passes all rules" rests on them. One mismatch is
  known: the table of energy per band under-reports a hit at the very start of a file compared
  with the whole-file figure the rules use.

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
- Light and sky of 2026-11-14 in motion: how the glare fades while a strut or a hull passes the
  star, how fast the exposure follows, whether the canopy scratches distract. Seen only in still
  pictures of the dev pages. The frame keeps its depth as a texture next to a multisampled colour
  target and the final pass reads it in its vertex shader: tried in Chromium only.
- The surfaces of 2026-11-15 in motion: whether plates and grain shimmer or pop as they fade with
  distance, whether the relief of the clouds crawls and their shadows slide as a planet comes
  near, the limb of ocean worlds and giants from low orbit, whether grain and stones of the ground
  shimmer during a descent. Judged from still pictures of the dev pages only. Wrecks, pods,
  missiles and beacons were not looked at in full size. Also not looked at: the ground from 2 km
  at 3840x2160, the grain texture after a lost WebGL context, quality 0 on a weak card (it used
  to draw no ground detail and now draws grain and craters).
- Any sound by ear, except what the owner rated (49 of 114 after round 2; in round 3 seven voice
  samples and no direction sample; the countdown samples and the candidates of round 4 not
  yet). Every other judgement of the sound library and of
  the speech models comes from measurements, spectrogram pictures and models that listen.
- Round 4, the sound sources (2026-11-16; `tools/sound/RESULTS.md`, "What could not be judged"):
  - How any of the sixteen candidates sounds: nobody listened. The cuts were made by a level
    rule and the spectrograms show only plain faults.
  - Whether three of the four published recordings are recordings. Of them only the page of the
    spark says "recorded"; for the metal hit, the lock click and the steam hiss it is not
    established, though the page names them "Aufnahme". That the pack authors may release their
    packs as CC0 was not checked beyond the licence line of each page.
  - The licence of Stable Audio 3 is the owner's decision (see section 2). Its checkpoint is the
    one before the makers' last training stage, so a weak showing does not settle the model.
  - MOSS presses loud output against full scale inside its decoder (a tanh). The flat-top rule does
    not see it, it cannot be taken off afterwards, and how it sounds in the shield candidates was
    not judged.
  - Whether 20 dB at 50 ms is the right cut-off threshold for steady sounds: five MOSS files sit
    between 17 and 20 dB at the cap, and one kept file lies 1.8 dB from the rule.
  - The loudness matching of events under about 0.5 s rests on a convention: BS.1770 measures them
    in one or two 400 ms blocks, and a 1.5 ms ramp moved one value by 2.5 dB.
  - The capture part of `tools/dev/audition-check.mjs` for all 148 sounds and the four scenes was
    not run after the second publish of 2026-11-16 (only the sixteen and two test files, 48 steps).
- A real controller, joystick or throttle lever (every pad in the tests is a simulated one), the
  joystick preset, a phone, and any browser but Chromium for the controller and for the stage of
  the audition page.
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
- Frame time of a dev page: `node scripts/bench.mjs <name>=<url> ... --size=3840x2160` (needs
  `npm run dev:client`, port given as `5173:` in front of the url). It switches the frame limit
  off and reads a pixel back after every frame, so the interval is what CPU and graphics card need
  together; without the read-back the browser only queues frames and the number says nothing.
  The card must be idle: sample `nvidia-smi --query-gpu=utilization.gpu,power.draw --format=csv`
  before the run and measure a scene the change did not touch in the same run
  (`space.html?scene=menu&clock=20` takes 1.3 ms at 3840x2160 on the RTX 5080). The owner's
  browser and the tests of other sessions load the card, and on 2026-11-15 that read as up to
  four times the true frame time.
- The HUD's direction indicators and the station screen without a server:
  `node tools/dev/orient-check.mjs` (own Vite server, screenshots in `screenshots/orient/`), on the
  page `/dev/local.html?scene=orient&hud=1&cam=cockpit&universe=16`; `sys=1` is a system with 19
  places, `panel=station` a made-up station with all six tabs (`packages/client/src/dev/hud.ts`).
- Start `node scripts/e2e.mjs` in the foreground. Started as a detached background job of an
  agent session it failed twice on 2026-11-14 at its steering steps; in the foreground it passed
  (see "Orientation on the HUD").
- Whether the game ports are in use: `netstat -ano | grep -E ":(8420|8421) "`. Do not grep for
  the word LISTENING: this Windows prints the state in German.
- The Python environment for the audio tools is `.venv-audio` (ignored by git): PyTorch with CUDA
  on the RTX 5080. In the Hugging Face cache: `laion/larger_clap_general` (compares a sound with a
  description), `openai/whisper-small` (speech recognition), `Qwen/Qwen2-Audio-7B-Instruct`
  (describes audio), `parler-tts/parler-tts-mini-multilingual-v1.1` (voices by description),
  `ACE-Step/ACE-Step-v1-3.5B` (music). `stabilityai/stable-audio-open-1.0` is gated and needs the
  owner's own login. The owner's condition for downloads: at least 10 % of the disk stays free
  (on 2026-11-14: 259 GB free of 2,047 GB, so about 54 GB of room). Run so far: CLAP, Whisper and
  Qwen2-Audio (the last in 4-bit through bitsandbytes, about 6.4 GB of graphics memory); their
  licences (Apache-2.0) are in `tools/audio/MODELS.md`. The music model and the Parler speech
  model have not been run. The licence of each model and each downloaded sound is to be read and
  recorded before first use.
- The speech models of the comparison (2026-11-15) each have their own environment under
  `.venv-voice/<key>/` (ignored by git, made with `uv`, about 7 GB on disk together) and their weights
  in the Hugging Face cache (about 9 GB: Qwen3-TTS VoiceDesign 1.7B and Base 0.6B,
  Chatterbox-Nano, Kokoro-82M, Phonon 31M with its twelve designed character voices, Kitten TTS
  2 Mini). Nothing is installed into `.venv-audio`; a saved package list
  (`assets/audio/voice/venv-audio-freeze-before.txt`) proves it. `tools/voice/README.md` has the
  rules and how a model is run; timed runs go through `tools/voice/with_lock.py`. After the
  comparison 231 GB of 1.9 TB were free (the owner's limit is 10 %, so about 40 GB of room).
- The sound-source tools of round 4 (2026-11-15 and 16; `tools/sound/README.md` has the rules and
  `tools/sound/RESULTS.md` the figures). Each model has its own environment under
  `.venv-sound/<key>/` (keys `moss` and `sa3`, made with `uv`, ignored by git, about 16 GB in all);
  the MOSS model (11 GB) lies under `assets/audio/gen/moss/model`, the Stable Audio weights (4.5
  GB) under `.venv-sound/sa3/weights`, the recordings (16 MB of archives) in
  `assets/audio/downloads/oga-*`. Candidates lie under `assets/audio/gen/<key>/raw` with a
  `gen.json` of what was asked (ignored by git). A source is run with
  `.venv-sound/<key>/Scripts/python.exe tools/sound/adapters/<key>.py` (optional `--family hull`,
  `--seeds 11,12`; adapters `moss.py` and `sa3.py`; `oga.py` cuts the recordings and runs in
  `.venv-audio`). Every use of the graphics card goes through
  `.venv-audio/Scripts/python.exe tools/voice/with_lock.py --wait 3600 -- <command>`. Then
  `.venv-audio/Scripts/python.exe tools/sound/screen.py` throws out what is broken and picks four
  per family (the hand skips are in `tools/sound/skips.json`), and `tools/sound/publish.py` puts
  the picks on the page as the category `source`. While the owner rates round 4,
  `assets/audio/render/source` is frozen: `screen.py`, `publish.py` and `tools/audio/build.py` are
  not run on the real tree until his ratings are recorded (see section 2), because a new publish
  orphans them. `tools/audio/fetch.py` fetches only from https hosts on its list: kenney.nl,
  nasa.gov with its subdomains and, since 2026-11-15, opengameart.org (the exact host); the list
  is changed by the orchestrator, visibly, never by a sub-agent. Disk on 2026-11-16: 508 GB of 1.9
  TB free (the stop line of this work is 200 GB; the owner's condition is at least 10 %).
- The sound library: `tools/audio/README.md` (the listening tools), `tools/audio/synth/README.md`
  (how a sound is written), `tools/audio/SOUND_DESIGN.md` (the direction and the rules).
  Render everything: `.venv-audio/Scripts/python.exe tools/audio/build.py` (add `--describe` for
  the describing model, `--only id,id` for single sounds). Fetch the downloads again:
  `.venv-audio/Scripts/python.exe -I tools/audio/fetch.py` (`--check` verifies, `--credits`
  rewrites the licence list).
- The audition page: `npm run dev:client`, then `/dev/audition.html` on the port it prints. Its
  browser check, `node tools/dev/audition-check.mjs`, needs a dev server and the variable
  `AUDITION_RATINGS_FILE` pointing at a scratch file on both, so that the owner's ratings are
  never touched (see `docs/reports/2026-11-14/audition-space-report.json`). Since 2026-11-15 the
  check asks the server which file it writes and refuses to start if that is the owner's. It
  also records what the page really plays, after the limiter, and looks for clicks and clipped
  samples in it (about 20 minutes for everything; `AUDITION_CAPTURE=skip` leaves it out,
  `AUDITION_CAPTURE_ONLY=id,id` and `AUDITION_CAPTURE_SCENES=fold` narrow it).
- The voice samples on the audition page are put there by
  `.venv-audio/Scripts/python.exe tools/voice/publish.py` (and taken off with `--remove`).
- A sound without a fixed `place` is put at a new random direction on every play of the library
  page, and behind the listener it is made duller. Samples that are to be compared need a fixed
  place: the voice samples and the direction samples have one. `node tools/dev/audition-level.mjs
  id,id` (against a dev server of your own) measures what single sounds are at the page's
  output: peak, level of the sounding parts, whether the overload lamp lit. Measured so on
  2026-11-15, the five models of a voice line leave the page within about 2 dB of each other,
  and the radio lines about 5 dB above the cabin lines. With the room at 1 the cabin's impulse
  response colours a voice strongly; to judge a voice itself, the room goes to 0 and the radio
  filter off.
- The controller in a browser: `node scripts/pad-check.mjs` plays the game with a simulated pad
  (same ports and switches as `scripts/e2e.mjs`).
- The checkpoint loop ends after eight hours. Start it again when it has ended: on 2026-11-14 an
  agent's work lay uncommitted for hours because the loop had run out.
