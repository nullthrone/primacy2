# Brief for the next work session

Written on 2026-11-14 by the session that built the sound library and controller support. Delete
or replace this file when the step is done; `docs/ROADMAP.md` stays the lasting record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. Push only to this branch, never to `main`, and open no
  pull request.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round).
- How Thomas wants to work is in the project's memory files, which load by themselves. Answer him
  in German.
- Limits: a 5-hour usage window and a weekly allowance per model. As far as is known no reset is
  left: limits are waited out. Measured on 2026-11-14: a workflow agent on the cheaper model
  (about 200,000 tokens) costs 3 to 4 points of the 5-hour window, and two sessions on the
  strongest model running beside an orchestrating one cost about as much as eight such agents.
  Read the usage figures before any fan-out, and never send a message to an agent that is running
  inside a workflow (it starts a second copy).
- Before anything else: start `bash tools/dev/checkpoint.sh` in the background if no loop runs
  (it ends by itself after eight hours).
- Other sessions may be at work in the same checkout (on 2026-11-14: light and sky, where the
  textures are still open; the HUD work was finished). Ask Thomas which are alive, and keep to
  your own files.

## The step: the sound comes into the game

Sound is the owner's largest complaint about the game. The library exists; the game still plays
the old procedural sound.

### 1. Finish the listening rounds

- Read `assets/audio/ratings.json`. A rating carries the hash of the file it was given on; the
  20 sounds reworked after round 1 are marked on the audition page until he rates them again.
  `assets/audio/rounds/` has what he heard in round 1.
- Rework what he rejects (the synthesis is side work for the cheaper model, in workflows, each
  agent with the category files it owns; look at the spectrogram pictures yourself before you
  hand a round over), record his words in section 4 of `SOUND_DESIGN.md`, and change the rules
  when his judgement contradicts them. He judges; nobody else can hear.
- Start the page for him: the dev server of the client (`npm run dev:client`), then
  `/dev/audition.html`. Tell him what changed and what to listen for.
- If he has recorded household sounds (`tools/audio/RECORDINGS.md`), take them in as raw material:
  his own recordings fit the repository's licence.

### 2. The game's runtime audio on the library

This is core work for the strongest model: `packages/client/src/audio` is rebuilt, not patched.
Design it first and show Thomas the plan in a few sentences. What it has to do:

- Play files, not oscillators. Decide how the sounds ship (the rendered WAV files are not in git;
  the game needs them under `packages/client/public`, in a compressed format the browsers decode,
  written by the build script, with the licence of every shipped file in the credits). Only
  sounds he approved go in; downloaded files only where the licence allows shipping, and none of
  the NASA files with identifiable voices without his decision.
- The stage that the audition page already has (`packages/client/src/dev/audition`): one-channel
  sounds at their place (`place` in `tools/audio/sounds.json`; hits from the side they came
  from), two-channel files as they are, everything through the cabin's impulse response. The
  levels are in the files: scenes mix by adding.
- The mapping from the frame view and its events to sound: the engine family crossfaded by
  thrust, thruster pulses, the chains of cruise and fold with their cues, hits on shield and
  hull by strength and direction, the alarms by state (heat, missile, shields down, low fuel,
  hull critical), landing (gear, touchdown by speed, scraping, regolith near the ground), the
  cabin at rest and silent running, the ship's own weapons, the sensor signals for what happens
  outside (contacts, a lock, fire and explosions nearby, the approach to a pad), switches and
  console keys for the interface, radio.
- Loading without a stall at the start, the volume setting, the browser's rule that sound starts
  only after a gesture, a phone played with a controller.
- Tests for the mapping (pure functions from a frame view to what should sound), and a browser
  check that listens to the output (level at an analyser while the test flies, fights and lands).

Done means: the game plays the approved sounds in flight, combat, cruise, fold and landing,
`npx tsc -p packages/shared && npx tsc -p packages/server && npx tsc -p packages/client`,
`npx vitest run`, `npm run build`, `node scripts/pad-check.mjs` and `node scripts/e2e.mjs` are
green, `docs/ROADMAP.md` is updated, and Thomas has played it and said what he hears.

### 3. Waiting for his word

- Voices and music: the models are downloaded and have never been run. Not before he asks.
- The radio: real NASA traffic, his own voice, or synthetic voices.
- A real controller: ask him to fly a few minutes with his own pad and say what he feels (stick
  response, dead zone, the default layout, the chords on Y).

## After this step

Docking, as specified in the roadmap. It starts with two graphics repairs that landing on a pad by
eye depends on (the soft ground near the ship, the streaks after a hard landing). One request to
Thomas before that work: nobody has seen the terrain in motion; ask him to fly one descent himself
and say what he sees.
