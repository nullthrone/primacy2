# Brief for the next work session

Written on 2026-11-15 and brought up to date on 2026-11-16, after round 3 was heard and round 4
(the sound sources) was prepared. Delete or replace this file when the step is done;
`docs/ROADMAP.md` stays the lasting record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. Push only to this branch, never to `main`, and open no
  pull request.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round), then
  `tools/sound/README.md` and `RESULTS.md` (round 4), then `tools/voice/README.md`, `RESULTS.md`
  and `CANDIDATES.md`.
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
- Frozen while the owner rates round 4: `assets/audio/render/source`, and no `tools/sound/screen.py`,
  `publish.py` or `tools/audio/build.py` on the real tree (section 1 says when it ends).
- Disk on 2026-11-16: 508 GB free of 1.9 TB (stop line of this work 200 GB; his condition: at
  least 10 % free). `.venv-sound` about 16 GB, the MOSS model 11 GB under
  `assets/audio/gen/moss/model`, the Stable Audio weights 4.5 GB under `.venv-sound/sa3/weights`,
  the recordings 16 MB of archives; all ignored by git. The sound tools are in `tools/sound`; every
  use of the graphics card goes through `tools/voice/with_lock.py`.

## The step: round 4 with the owner, then the sound comes into the game

### 1. Round 4: the sound sources (waiting for his ratings)

What is on the audition page (`npm run dev:client`, then `/dev/audition.html`): its first category,
"Klangquellen (Runde 4)", holds sixteen candidates for four families (hull hit, thruster pulse,
landing gear, shield hit), four per family. The page lists twelve under "Von uns erzeugt" (five
from MOSS-SoundEffect v2.0, seven from Stable Audio 3 Small-SFX Base) and the four recordings in a
second block below them. On 2026-11-16 none of the sixteen was rated. The four countdown samples
made after round 3 (`voice_5_countdown_*`) are also unheard.

What he was asked: to accept or reject each candidate (Passt / Falsch), not to describe. After
round 3 he wrote: "Wir gehen langsam in die richtige Richtung. Aber es klingt alles
noch zu künstlich und langweilig. Gibt es keine besseren lokalen Modelle zur Audioton-Genese?"
Asked which direction sample came nearest, he said he liked none and can only describe it badly.

Where the candidates come from: three sources he approved on 2026-11-15 ("Ja, alle laden"): MOSS
(Apache-2.0), Stable Audio 3 Small-SFX Base (Stability AI Community License; its output is test
material until he decides) and CC0 recordings from OpenGameArt. Anything beyond them needs a new
yes. The pool of the second run is 165 files (MOSS 72 from the first run, Stable Audio 72 made
again without the makers' clamp, 21 excerpts of recordings); `tools/sound/screen.py` threw out only
what is broken, picked
for variety and set each copy to its family's loudness at the page; `publish.py` put the sixteen
on the page. Rules and numbers: `tools/sound/README.md` and `RESULTS.md`. The independent check
(`docs/reports/2026-11-16/sound-verify2-report.json`) measured the levels, cut rules and licence
lines; the orchestrator corrected the wrong sentences and the one failing test it found.

What nobody could verify: how any of it sounds (the orchestrator looked at the sixteen
spectrograms, which shows plain faults only), and whether three of the four "recordings" are
recordings (only the page of the spark says "recorded"); see RESULTS.md, "What could not be
judged". MOSS presses loud output against full scale inside its decoder (49 of 72 raw files peak
above 0.99); no pick was changed for it, and its effect on the shield candidates was not judged.

Frozen while he rates: `assets/audio/render/source` and the published ids. Run no `screen.py`,
`publish.py` or `tools/audio/build.py` on the real tree until round 4 is recorded (step 1), and
never write `assets/audio/ratings.json`: a new publish changes ids or hashes and orphans ratings.

When he has rated:

1. Record the round the way round 3 was recorded: copy the saved ratings to
   `assets/audio/rounds/round4-ratings.json` and write `assets/audio/rounds/round4.json` (round,
   date, note, and the file hash of every sound on the page as he heard it, same form as
   `round3.json`). Only then may screen, publish or build run again.
2. Read the ratings by source and by family: which of MOSS, Stable Audio and the recording he
   accepted for each of the four families.
3. Act on that (the orchestrator's plan, not his decision). If he accepts candidates of a source
   for a family, make the event sounds of that family anew from that source (more candidates from
   the accepted prompts or items), and only then give the rules in `tools/audio` new numbers,
   taken from what he accepted. If Stable Audio wins anywhere, he first decides on its licence
   (registration and a revenue cap for commercial use; the finished checkpoint is gated and needs
   a login, which is his decision too). If he accepts nothing: Freesound CC0 with his own account,
   recordings made at home, or other models; each needs a new yes.
4. Before the rules get numbers, have the measuring reviewed: `tools/audio/listen/measure.py` and
   `tools/audio/synth/rules.py` were never reviewed (`build.py` was, on 2026-11-15, for its
   handling of downloads). At a re-render every one-shot starts at zero (a rule is missing).
5. If he says the crackling is still there: the discharges at the end of the shield hits and fold
   sounds are designed crackle, the NASA laser shots are snaps, and the SLS recording is clipped
   in its source. Ask which sound he means before changing anything.

### 2. The voice pipeline: design it with him, then build it

He has decided (2026-11-15): voices in the radio, as ship computer and as station staff; English;
the system must speak text the game generates; only artificial voices; no recorded real people.
The comparison (`tools/voice`) answers which models may be used and how fast they are; whether a
voice sounds right is his judgement on the samples. Round 3 gave him twenty voice samples (ratings
in `assets/audio/rounds/round3-ratings.json`; five carry his note that the countdown did not count
in seconds); which model he accepts is still open.

The countdown: four samples are on the page (`voice_5_countdown_*`: Qwen3-TTS and Chatterbox-Nano,
each with the numbers spoken one by one or cut out of one sentence), unheard. By construction the
numbers start 1000 ms apart; the independent check of 2026-11-15 measured medians of three
detectors within 10 ms of that (single detectors off by up to 57.5 ms). His suggestion is the
design rule: speech that must keep time is made of single clips placed by a clock
(`tools/voice/countdown.py`), not of one utterance.

What the comparison leaves open, to be settled with him in a question round before anything is
built (it is a greenfield design):

- Which model he accepts by ear, and whether a preset voice of undocumented origin (Kokoro,
  Kitten) counts as artificial for him. Qwen3-TTS designs a voice but is slower than real time;
  Chatterbox-Nano speaks in a designed voice at 0.5 to 0.8 of real time on a processor; the small
  preset models run five to fifteen times faster than real time; Phonon runs in a browser tab.
- Where speech is made: by the server when content is generated (and cached by its text and
  voice), by the server on demand, or in the player's browser. A federated game means that every
  operator's server would need the model; a browser model means a download for every player.
- Text normalisation: numbers, units, call signs, the phonetic alphabet (the test lines were
  written out by hand, `tools/voice/lines.json`, `spoken`; the game needs a function), and which
  lines must keep time and so are composed of single clips on a clock.
- Invented names: the recogniser read back 10 to 15 of 24 as written. Whether the models say them
  well is his to hear; a pronunciation hint per generated name may be needed.
- The cast: how many voices, and how they are described. Four exist (`tools/voice/cast.json`).
- Worth a look: a small model that takes a designed voice and runs in the browser (ZONOS3-Mini
  appeared on 2026-11-14; the provenance of its voice data is unclear and it was not run), and a
  faster way to run Qwen3-TTS (the package runs its token loop in Python).

### 3. The game's runtime audio on the library

Not to be started without his word (section 4). Core work for the strongest model:
`packages/client/src/audio` is rebuilt, not patched. Design it first and show Thomas the plan in a
few sentences. Its event sounds wait for round 4 and what follows from it. What it has to do:

- Play files, not oscillators. Decide how the sounds ship (the rendered WAV files are not in git;
  the game needs them under `packages/client/public`, in a compressed format the browsers decode,
  written by the build script, with the licence of every shipped file in the credits). Only
  sounds he approved go in; downloaded files only where the licence allows shipping; Stable Audio
  output only after his licence decision.
- The stage that the audition page already has (`packages/client/src/dev/audition`): one-channel
  sounds at their place (`place` in `tools/audio/sounds.json`; hits from the side they came
  from), two-channel files as they are, everything through the cabin's impulse response. The
  levels are in the files: scenes mix by adding. The page plays a one-channel file on both
  channels and a two-channel file as it is, so the same file loudness leaves it 3 dB lower for two
  channels; the round 4 copies are levelled for that chain (`tools/sound/README.md`, "Level"), and
  another chain needs other gains. Take the other lessons of the page with it: a loop that starts
  mid-wave rises from zero from the moment its source starts, a one-shot whose file starts on a
  step gets a short fade, a chain is planned from the start time that was really used, and the
  limiter leaves everything below its threshold as it is.
- The mapping from the frame view and its events to sound: engines crossfaded by thrust, thruster
  pulses, the chains of cruise and fold, hits by strength and direction, alarms by state, landing
  (gear, touchdown, scraping, regolith), the cabin, weapons, outside signals, interface, radio.
- Loading without a stall, the volume setting, the browser's rule that sound starts only after a
  gesture, a phone with a controller. Tests for the mapping (pure functions from a frame view to
  what should sound) and a browser check that listens to the output (reuse the audition capture).

Done means: the game plays the approved sounds in flight, combat, cruise, fold and landing,
`npx tsc -p packages/shared && npx tsc -p packages/server && npx tsc -p packages/client`,
`npx vitest run`, `npm run build`, `node scripts/pad-check.mjs` and `node scripts/e2e.mjs` are
green, `docs/ROADMAP.md` is updated, and Thomas has played it and said what he hears.

### 4. Waiting for his word

What waits on him now: his ratings of round 4 (0 of 16 on 2026-11-16); the four countdown samples;
which voice model he accepts and whether the preset voices of Kokoro and Kitten count as
artificial; the licence decision on Stable Audio, if it wins; optional Freesound CC0 downloads
with his own account. Also open:

- From round 1, still unrated: fold jump, fold exit, shields-down alarm, the longer cruise charge,
  and the stereo stage as a whole. Ask him in the next round.
- A real controller: ask him to fly a few minutes with his own pad and say what he feels (stick
  response, dead zone, the default layout, the chords on Y).
- Recordings made at home (`tools/audio/RECORDINGS.md`), if he makes them: raw material.
- Things outside the ship as real sound: "not for now". Do not raise it again unasked.
- The eleven direction samples of round 3 (category `pilot`, "Richtungsproben (Runde 3)") are still
  on the page, none rated; he liked none of them. The earlier plan was to remove the category and
  its modules after his choice. He made none, so they stay until round 4 is recorded; then ask
  him in one line whether they can go, and remove them with the next build.

Not to be started without his word:

- The build of the voice pipeline.
- The rebuild of the game's runtime audio.
- A re-render of the event sounds.
- Any download beyond the three sources of 2026-11-15.
- Music: the model is downloaded and has never been run.

### 5. Lessons of round 4

- An allow-list is changed by the orchestrator, visibly, never by a sub-agent: `check_url` in
  `tools/audio/fetch.py` allowed only kenney.nl and nasa.gov, the recordings agent's attempt to add
  opengameart.org was refused, and the orchestrator added the exact host with tests and told him.
- Match loudness at the page, not in the file (every two-channel pick of the first run was 3 dB
  quieter than every one-channel pick), and measure again after setting a gain (one copy was
  0.8 LU off).
- A model's code may clamp its output after the decoder (Stable Audio: 41 of 72 files thrown out;
  decoding without the clamp undid it) or saturate inside it (MOSS; that cannot be undone).
- BS.1770 loudness of an event under about 0.5 s moves by a few dB with the block positions, so a
  LUFS target says little there.
- A test must not pin a list that a run legitimately changes: `test_screen.py` pinned the hand
  skips and failed after the second run; it now checks their form. Keep hand skips in a committed
  file, and never reorder a manifest to satisfy a page check.
- A scratch ratings file for a page check must be an own empty file in an own folder.

## After this step

Docking, as specified in the roadmap. It starts with two graphics repairs that landing on a pad by
eye depends on (the soft ground near the ship, the streaks after a hard landing). One request to
Thomas before that work: nobody has seen the terrain in motion; ask him to fly one descent himself
and say what he sees.
