# Brief for the next work session

Written on 2026-11-15 by the session that evaluated listening round 2, prepared round 3 and
compared speech models. Delete or replace this file when the step is done; `docs/ROADMAP.md`
stays the lasting record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. Push only to this branch, never to `main`, and open no
  pull request.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round), then
  `tools/voice/README.md`, `RESULTS.md` and `CANDIDATES.md`.
- How Thomas wants to work is in the project's memory files, which load by themselves. Answer him
  in German.
- Limits: a 5-hour usage window and a weekly allowance per model; limits are waited out. Measured
  on 2026-11-15: a workflow of eight to eleven agents on the cheaper model (1.3 to 1.5 million
  tokens) costs about 10 points of the 5-hour window. The orchestrating session on the strongest
  model is what eats the weekly allowance: keep its own reading small. Never send a message to an
  agent that is running inside a workflow (it starts a second copy).
- Before anything else: start `bash tools/dev/checkpoint.sh` in the background if no loop runs
  (it ends by itself after eight hours).
- Other sessions work in the same checkout (on 2026-11-15 one changed the radar and compass part
  of the roadmap). Keep to your own files, and change shared documents by exact replacement, never
  by writing the whole file.
- An agent that queues work behind the bench lock (`tools/voice/with_lock.py`) and then ends its
  turn leaves the work running with nobody to read the result. Tell agents to wait for their own
  locked commands, and check for left-over processes before you trust a "partial".
- Scripts that edit text files on Windows must write `\n` line ends (the repository wants LF).

## The step: round 3, then the sound comes into the game

### 1. Round 3 with the owner

On the audition page (`npm run dev:client`, then `/dev/audition.html`; on 2026-11-15 a server ran
on port 5190) two groups stand at the top:

- "Richtungsproben (Runde 3)": eleven direction samples. Hull hit, thruster pulse and landing
  gear in three answers each (A metal or machinery, B as a film would do it, C dark but with
  weight), shield hit in two (A crackle on a bass throb, B a deep whoomp with soft sizzle).
- "Stimmproben (Runde 3)": four lines, each spoken by five speech models.

Read `assets/audio/ratings.json` when he has rated. Then:

- His choice among the direction samples becomes the rule: write it into section 1 and 2 of
  `SOUND_DESIGN.md`, give `tools/audio/synth/rules.py` new numbers for one-shots of the structure
  and energy paths (they still check the old, dull way), render the event sounds anew (thruster
  pulses, hull hits, landing gear, touchdowns, shield hits, debris, and what else shares their
  kind), remove the `pilot` category and its two modules, and let him hear the result. The
  synthesis is side work for the cheaper model in workflows, each agent with the category files
  it owns, a blind check after it; look at the spectrogram pictures yourself before you hand a
  round over. At the re-render every one-shot starts at zero (a rule for it is missing).
- Still unrated from round 1's rework: fold jump, fold exit, shields-down alarm, the longer cruise
  charge, and the stereo stage as a whole. Ask him for them in the same round.
- If he says the crackling is still there: the single discharges at the end of the shield hits and
  of the fold sounds are designed crackle, the NASA laser shots are snaps by nature, and the SLS
  recording is clipped in its source. Ask which sound he means before changing anything.
- Before more rounds lean on the numbers, have the measuring reviewed: `tools/audio/listen/
  measure.py` and `tools/audio/synth/rules.py` were never reviewed (`build.py` was, on
  2026-11-15, for its handling of downloads).
- If he has recorded household sounds (`tools/audio/RECORDINGS.md`), take them in as raw material.

### 2. The voice pipeline: design it with him, then build it

He has decided (2026-11-15): voices in the radio, as ship computer and as station staff; English;
the system must speak text the game generates; only artificial voices; no recorded real people.
The comparison (`tools/voice`) answers which models may be used and how fast they are; whether a
voice sounds right is his judgement on the samples.

What the comparison leaves open, to be settled with him in a question round before anything is
built (it is a greenfield design):

- Which model he accepts by ear, and whether a preset voice of undocumented origin (Kokoro,
  Kitten) counts as artificial for him. Qwen3-TTS designs a voice from a description but is
  slower than real time; Chatterbox-Nano speaks in such a designed voice on a processor at 0.5 to
  0.8 of real time; the small preset models are five to fifteen times faster than real time, and
  Phonon runs in a browser tab.
- Where speech is made: by the server when content is generated (and cached by its text and
  voice), by the server on demand, or in the player's browser. A federated game means that every
  operator's server would need the model; a browser model means a download for every player.
- Text normalisation: numbers, units, call signs, the phonetic alphabet. The test lines were
  written out by hand (`tools/voice/lines.json`, `spoken`); the game needs a function for it.
- Invented names: the recogniser read back 10 to 15 of 24 as written. Whether the models say them
  well is his to hear; a pronunciation hint per generated name may be needed.
- The cast: how many voices, and how they are described. Four exist (`tools/voice/cast.json`).
- Worth a look before deciding: a small model that takes a designed voice and runs in the browser
  (ZONOS3-Mini appeared on 2026-11-14; the provenance of its voice data is unclear and it was not
  run), and a faster way to run Qwen3-TTS (the package runs its token loop in Python).

### 3. The game's runtime audio on the library

Core work for the strongest model: `packages/client/src/audio` is rebuilt, not patched. Design it
first and show Thomas the plan in a few sentences. What it has to do:

- Play files, not oscillators. Decide how the sounds ship (the rendered WAV files are not in git;
  the game needs them under `packages/client/public`, in a compressed format the browsers decode,
  written by the build script, with the licence of every shipped file in the credits). Only
  sounds he approved go in; downloaded files only where the licence allows shipping.
- The stage that the audition page already has (`packages/client/src/dev/audition`): one-channel
  sounds at their place (`place` in `tools/audio/sounds.json`; hits from the side they came
  from), two-channel files as they are, everything through the cabin's impulse response. The
  levels are in the files: scenes mix by adding. Take the lessons of the page with it: a loop
  that starts mid-wave rises from zero from the moment its source starts, a one-shot whose file
  starts on a step gets a short fade, a chain is planned from the start time that was really
  used, and the limiter leaves everything below its threshold as it is.
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
  check that listens to the output (the capture of the audition check can be reused: level and
  clicks at the output while the test flies, fights and lands).

Done means: the game plays the approved sounds in flight, combat, cruise, fold and landing,
`npx tsc -p packages/shared && npx tsc -p packages/server && npx tsc -p packages/client`,
`npx vitest run`, `npm run build`, `node scripts/pad-check.mjs` and `node scripts/e2e.mjs` are
green, `docs/ROADMAP.md` is updated, and Thomas has played it and said what he hears.

### 4. Waiting for his word

- Music: the model is downloaded and has never been run. Not before he asks.
- A real controller: ask him to fly a few minutes with his own pad and say what he feels (stick
  response, dead zone, the default layout, the chords on Y).
- Things outside the ship as real sound: "not for now". Do not raise it again unasked.

## After this step

Docking, as specified in the roadmap. It starts with two graphics repairs that landing on a pad by
eye depends on (the soft ground near the ship, the streaks after a hard landing). One request to
Thomas before that work: nobody has seen the terrain in motion; ask him to fly one descent himself
and say what he sees.
