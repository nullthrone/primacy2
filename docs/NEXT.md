# Brief for the next work session

Written on 2026-11-15 and brought up to date on 2026-11-17, after round 5 (the event sounds) was
rated and round 6 (another try for the families he rejected) was made. Delete or replace this file when the step is done;
`docs/ROADMAP.md` stays the lasting record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. Push only to this branch, never to `main`, and open no
  pull request.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round), then
  `tools/sound/README.md`, `RESULTS.md` (round 4), `RESULTS5.md` (round 5) and `RESULTS6.md` (round 6), then `tools/voice/README.md`, `RESULTS.md`
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
- Rounds 4 and 5 are recorded and stay as they are: `assets/audio/render/source` and
  `render/events5`, `assets/audio/gen/moss`, `gen/sa3`, `gen/oga`, `gen/r5`, `gen/_kept`,
  `tools/sound/prompts.json`, `prompts5.json`, `skips.json`, `skips5.json`, `RESULTS.md` and
  `RESULTS5.md` are not changed or moved. Round 6 lies beside them (`assets/audio/gen/r6`,
  `assets/audio/render/events6`). Frozen while the owner rates round 6:
  `assets/audio/render/events6`, and no `tools/sound/screen.py`, `publish.py` or
  `tools/audio/build.py` on the real tree, until his ratings are recorded (section 1 says how).
  Look first whether he has rated: `assets/audio/ratings.json` is byte-identical to
  `assets/audio/rounds/round5-ratings.json` as long as he has not. A plain `screen.py` or
  `publish.py` without arguments still means round 4 and is not run on the real tree.
- The eleven direction samples of round 3 (category `pilot`) are gone since 2026-11-17, on his word:
  out of `tools/audio/sounds.json` with their renderers and tests, and off the page without a build
  on the real tree (`docs/ROADMAP.md`, section 2, "The direction samples taken off the page"). The
  manifest has 176 entries. Their rendered files are kept in `assets/audio/gen/_kept/round3-pilot`.
  The check that nothing old moved reads: of the 165 hashes of `assets/audio/rounds/round5.json`,
  the 154 that are not `pilot_*` are unchanged and the eleven `pilot_*` are absent. That was the
  one change of the real tree during the freeze, made because he had not started rating and no
  file he is asked to rate was written. A page that was open before lists the samples until it is
  loaded again.
- Disk on 2026-11-17: 526 GB free of 1.9 TB (stop line of this work 200 GB; his condition: at
  least 10 % free). `.venv-sound` about 16 GB, the MOSS model 11 GB under
  `assets/audio/gen/moss/model`, the Stable Audio weights 4.5 GB under `.venv-sound/sa3/weights`,
  the recordings 16 MB of archives; all ignored by git. The sound tools are in `tools/sound`; every
  use of the graphics card goes through `tools/voice/with_lock.py`.

## The step: round 6 with the owner, then the sound comes into the game

### 1. Round 6: another try for the rejected families (made on 2026-11-17, waiting for his ratings)

The result of round 5. He rated all seventeen event sounds on 2026-11-16 (record:
`assets/audio/rounds/round5.json` and `round5-ratings.json`; the files as he heard them are kept in
`assets/audio/gen/_kept/round5`, ignored by git): five fit, two are close, ten are wrong. His notes
word for word are in `tools/audio/SOUND_DESIGN.md`, section 4, and in `tools/sound/RESULTS5.md`.

- Fit: the light hull hit of the wrench prompt, both heavy hull hits, both valve pulses.
- Close: the light hull hit of the debris prompt (several short tones in a row, like an echo) and
  the first fold exit (too much high-pitched noise).
- Wrong: all four thrusters with more bang ("klingt wie eine kleine Gaspistole, nicht wie eine
  mächtige Gatling Gun", "klingt wie eine kleine Plastikkanone"), all three shields ("Klingt zu voll
  und übersteuert, auch zu lang gezogen. Es muss kürzer sein", "klingt wie ein Knistern eines
  kaputten Kabels", "übersteuert, zu lang, zu viel rauschen"), both fold jumps ("zu übersteuert")
  and the second fold exit ("klingt gehaucht, nach Luft, die es im Vakuum nicht gibt..").

What was done with it on 2026-11-16 and 17 (`docs/ROADMAP.md`, section 2, "Sound sources", has the
figures and the reports):

- The round is recorded, and the freeze of `render/events5` has ended.
- "Übersteuert" was measured: the page does not make it. The four files are noise-like and their raw
  model output is pressed against full scale. It is a working rule that rests on four files.
- The MOSS candidates he accepted in rounds 4 and 5 are in the library: `tools/audio/build.py` has
  a step for generated files, `assets/audio/generated.json` lists eight sounds (ids `g_*`) with
  origin and licence, and their raw files are committed. Their levels are provisional.
- The measuring was reviewed and repaired (`tools/audio/listen/measure.py`, `synth/rules.py`,
  `synth/levels.py`, `build.py`): 21 of 22 findings confirmed, seven repairs, no rendered byte
  changed. The alarm loops are exempt from the swing rule by name (`GAPPED`). What was left open on
  purpose is listed in section 4 of the roadmap.
- Round 6 was made, screened, published and checked independently.

Round 6 (`tools/sound/prompts6.json`, `tools/sound/RESULTS6.md`, category "Ereignisklänge (Runde 6)",
the first category of the audition page; round 5 and round 4 follow). MOSS only, 78 raw files, 56
kept, 14 on the page:

- hull_light (2): the wrench prompt he accepted, new seeds, as variants.
- thruster_mighty (3): large weapons named, a heavy low end asked for, 6 dB louder than in round 5.
- shield_tight (3): one short tight event, a low thump with a brief crackle, at most 1.5 s. With
  MOSS alone this family decides whether the shield can be made; it is the third try.
- fold_jump (3): an electrical source, clean and bright.
- fold_exit (3): no air, wind or steam in any prompt.

What he is asked: Passt / Falsch for each candidate, nothing else, no description. What he was told
with the hand-over on 2026-11-17, because it was measured and not heard: two of the three thruster
candidates are pressed and noise-like by the numbers that describe what he called overdriven; the
first thruster candidate is a burst though its prompt asks for a single shot; the first shield
candidate has clicks at its end; the second is bass-heavy; four of the thirteen prompts have no
candidate on the page. He was also told that MOSS has failed the shield twice, shown the plan for
the runtime audio (section 3) in a few sentences, and asked in one line whether the eleven direction
samples of round 3 can go. He said yes the same day, and they were taken off the page. The page
check that followed (48 of 48, no fault from the page) found one click inside the file of the third
shield candidate, at 0.26 s, beside the clicks of the first; he was told that as well.

What nobody could verify: how any of it sounds, and whether the pick rule finds what he means by
"übersteuert". See `RESULTS6.md`, "What could not be judged".

When he has rated round 6:

1. Look whether he has: `assets/audio/ratings.json` then differs from
   `assets/audio/rounds/round5-ratings.json`. Record the round the way rounds 4 and 5 were recorded:
   copy the saved ratings to `assets/audio/rounds/round6-ratings.json` and write
   `assets/audio/rounds/round6.json` (round, date, note, and the file hash of every sound on the
   page as he heard it, 176 entries, same form as `round5.json`). Keep the files as he heard them in
   `assets/audio/gen/_kept/round6` (`kept.json` of round 5 shows the form). Only then may screen,
   publish or build run again on the real tree, and never write `assets/audio/ratings.json` by hand.
   Take every count from the output of a script.
2. Read the ratings by family and prompt. The questions: is the thruster now mighty, and did he call
   the pressed candidates overdriven; can MOSS make the shield; are the fold sounds clean; is the
   exit free of hiss and air. Every candidate he calls overdriven and every one he accepts is a
   data point for `notSaturatedNoise`: measure them and say whether the rule holds.
3. Accepted candidates go into `assets/audio/generated.json` (form and rules in
   `tools/audio/README.md`, "Generated sounds in the build": raw file committed, sha256,
   `standsFor`), then one build.
4. Give the rules in `tools/audio` new numbers, taken from everything he has accepted in rounds 4
   to 6. The measuring is reviewed. The first full build after the repairs also refreshes the checks
   of the rendered sounds, which still carry the numbers of before: run it with CLAP and with
   `--describe` (eleven entries carry a description, and a build with `--no-clap` strips those
   fields), on a copy first, and compare the hashes of all entries with the record of round 6. At a
   re-render every one-shot starts at zero (a rule is missing); a re-render needs his word.
5. A family he rejects again. Thruster, fold jump, fold exit: another round with new prompts is
   possible. The shield: a third failure of MOSS is the point to put the fact before him (the only
   shields he accepted came from Stable Audio, which he ruled out on 2026-11-16) and to ask whether
   he wants to reopen that or allow another source. Do not push; another source needs a new yes.
6. The plan for the game's runtime audio (section 3) was shown to him on 2026-11-17. It is still
   not started without his word.
7. If he says the crackling is still there: the discharges at the end of the shield hits and fold
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
few sentences (done on 2026-11-17). Its event sounds wait for round 6 and what follows from it;
eight accepted ones are in the library (`assets/audio/generated.json`). What it has to do:

- Play files, not oscillators. Decide how the sounds ship (the rendered WAV files are not in git;
  the game needs them under `packages/client/public`, in a compressed format the browsers decode,
  written by the build script, with the licence of every shipped file in the credits). Only
  sounds he approved go in; downloaded files only where the licence allows shipping; Stable Audio
  output does not go in (his decision of 2026-11-16).
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

What waits on him now: his ratings of round 6 (0 of 14 on 2026-11-17); the four countdown samples;
which voice model he accepts and whether the preset voices of Kokoro and Kitten count as
artificial; his word on the runtime audio, whose plan he was shown on 2026-11-17; optional
Freesound CC0 downloads with his own account. The licence of Stable Audio he answered on 2026-11-16
by choosing MOSS only. MOSS failed the shield in round 5 (three of three wrong); he was told that
fact on 2026-11-17, and round 6 is the third try. Reopening Stable Audio is his decision (the
finished checkpoint is gated and needs a login).
Also open:

- From round 1, still unrated: fold jump, fold exit, shields-down alarm, the longer cruise charge,
  and the stereo stage as a whole. Ask him in the next round.
- A real controller: ask him to fly a few minutes with his own pad and say what he feels (stick
  response, dead zone, the default layout, the chords on Y).
- Recordings made at home (`tools/audio/RECORDINGS.md`), if he makes them: raw material.
- Things outside the ship as real sound: "not for now". Do not raise it again unasked.

Not to be started without his word:

- The build of the voice pipeline.
- The rebuild of the game's runtime audio.
- A re-render of the event sounds.
- Any download beyond the three sources of 2026-11-15.
- Music: the model is downloaded and has never been run.

### 5. Lessons of rounds 4 to 6

Round 6 and the repairs (2026-11-17):

- Take every count from the output of a script. The orchestrator told him 6, 2 and 9 where the
  ratings say 5, 2 and 10, and had to correct it in the next message.
- A step that adds entries to the build (the generated sounds) reaches every test that builds into
  a fake tree with the real lists. Point such a test at an empty list, as was done for the
  downloads, in the same change.
- A text that names a round, a count or a source comes from the data of the run (`provenRound`),
  not from a literal in the code: the hull entries of round 6 said "accepted in round 4".
- When a measure is repaired, a limit that was set to sit above what the old measure could read
  means something else (the alarm swing of 80 dB). Look at every per-sound limit when a measure
  changes, and say by name what is exempt.
- A variety rule ("the candidate farthest from the picks") likes outliers, and an outlier can be
  the kind he has already rejected. Before a round goes out, compare each pick with the measures of
  what he rejected and accepted in the same family.
- Never run a build with `--no-clap` against the real render folder: it strips the CLAP fields and
  the described text from the entries.
- On this German Windows `netstat` prints ABHÖREN, not LISTENING: look for the port, not for the
  word, when checking that a server of your own is gone.
- Something can be taken off the page while the real render folder is frozen, without a build
  there: remove its folder on a copy, let `build.py --manifest-only --out <copy>` write the
  manifest, check that it is the real one minus exactly those entries, then move the folder away
  on the real tree and put that manifest in place. A `--manifest-only` build on the real tree
  would write every processed copy of a download and of a generated sound again while he may be
  listening.

Round 5 (2026-11-16):

- A decision that comes after the briefs of a workflow must be written where the tools read it. The
  generate step made 90 Stable Audio files against his MOSS-only decision: the key `sources` of
  `prompts5.json` is read by no script, and `screen.py` takes every `gen.json` under its root.
- A test that pins a committed list (`skips5.json` empty) fails when the list is filled by the
  next step of the same run. Check its form, not its content.
- A level target can be unreachable for a file with a very high crest (a few loud clicks over a
  quiet bed): the true-peak ceiling stops the gain and the file leaves the page 4 dB under its
  family. Screening does not see it; the page measure does.

Round 4:

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
