# Brief for the next work session

Written on 2026-11-15 and brought up to date on 2026-11-16, after round 4 (the sound sources) was
rated and round 5 (the event sounds) was made. Delete or replace this file when the step is done;
`docs/ROADMAP.md` stays the lasting record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. Push only to this branch, never to `main`, and open no
  pull request.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round), then
  `tools/sound/README.md`, `RESULTS.md` (round 4) and `RESULTS5.md` (round 5), then `tools/voice/README.md`, `RESULTS.md`
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
- Round 4 is recorded and stays as it is: `assets/audio/render/source`, `assets/audio/gen/moss`,
  `gen/sa3`, `gen/oga`, `gen/_kept`, `tools/sound/prompts.json`, `skips.json` and `RESULTS.md` are
  not changed or moved. Round 5 lies beside it (`assets/audio/gen/r5`, `assets/audio/render/events5`).
  Frozen while the owner rates round 5: `assets/audio/render/events5`, and no `tools/sound/screen.py`,
  `publish.py` or `tools/audio/build.py` on the real tree (section 1 says when it ends). A plain
  `screen.py` or `publish.py` without arguments still means round 4 and is not run on the real tree.
- Disk on 2026-11-16: 506 GB free of 1.9 TB (stop line of this work 200 GB; his condition: at
  least 10 % free). `.venv-sound` about 16 GB, the MOSS model 11 GB under
  `assets/audio/gen/moss/model`, the Stable Audio weights 4.5 GB under `.venv-sound/sa3/weights`,
  the recordings 16 MB of archives; all ignored by git. The sound tools are in `tools/sound`; every
  use of the graphics card goes through `tools/voice/with_lock.py`.

## The step: round 5 with the owner, then the sound comes into the game

### 1. Round 5: the event sounds (made on 2026-11-16, waiting for his ratings)

The result of round 4. He rated all sixteen candidates on 2026-11-16 (record:
`assets/audio/rounds/round4.json` and `round4-ratings.json`; the files as he heard them are kept in
`assets/audio/gen/_kept/round4`, ignored by git): ten fit ("Passt"), three are close ("Nah dran"),
three are wrong ("Falsch"). These are the first short events he has accepted in four rounds. By
source, with 7, 5 and 4 candidates, so counts and no ranking: Stable Audio 6 of 7 fit and 1 is
close; MOSS 3 of 5 fit and 2 are close; the recordings 1 of 4 fit and 3 are wrong. Read by family
and prompt:

- Hull and gear fit from both models (MOSS hull_1 s16, Stable Audio hull_2 s11 and hull_1 s13; MOSS
  gear_2 s12, Stable Audio gear_3 s15 and gear_2 s15). The recorded metal hit and the recorded lock
  click are wrong.
- Thruster: the verdict followed the prompt. MOSS thruster_1 s11 (valve prompt) fits, and so does
  the recorded steam hiss; MOSS thruster_2 s11 and Stable Audio thruster_2 s12 (air-cannon prompt)
  are close. His notes: "Grundidee passt, es muss aber doller, knalliger klingen" and, on the
  second, "Grundidee passt, es muss aber doller, knalliger klingen. Aktuell klingt es eher
  \"hauchig\"".
- Shield: the verdict followed the model. Stable Audio shield_3 s11 and shield_2 s16 fit; MOSS
  shield_3 s14 is close, with the note "Klingt hochwertiger als die letzten Samples, allerdings
  klingt es etwas zu bass-lastig. ich würde ein minimales knistern/wummern mit einbauen". The
  recorded spark is wrong.
- Of the recordings only the steam hiss fits.

What follows from it. The frozen rule of round 4 has ended, because the round is recorded. Round
4's files, `prompts.json` and `skips.json` stay as they are, and round 5 is built beside them. The
licence question on Stable Audio became real: on the evidence of round 4 only the shield depended on
it, since MOSS (Apache-2.0) fits for hull, thruster and gear. He answered it on the same day: round
5 is made with MOSS only, and so Stable Audio output does not go into the game (his words are in the
field `decision` of `tools/sound/prompts5.json`, which wins over the briefs of the workflow
`round5-event-sounds`, written before). His hint for the thruster, to take a Gatling gun as the
reference and not an air cannon, is in the families `thruster_bang` and `thruster_gatling`.
Recordings are no longer pursued as the main source: one of four fit.

Round 5 (`tools/sound/prompts5.json`, `tools/sound/RESULTS5.md`, category "Ereignisklänge (Runde 5)",
the first category of the audition page, then "Klangquellen (Runde 4)"). It makes the event sounds
the game needs from what he accepted. Why each family is in it:

- hull_light and hull_heavy (2 slots each): hull hits fit in round 4, and the library needs a light
  and a heavy strength. First tries.
- thruster_valve (2 of 3 slots): the only family on a prompt he accepted; variants, so that repeated
  pulses do not sound the same.
- thruster_bang and thruster_gatling (2 each): his two notes on the air cannon (harder, more of a
  bang, less breathy) and his Gatling hint, as a single shot and as a short burst. First tries.
- shield_bright (3): his note on the MOSS shield hit (too bass-heavy, a little crackle or throb).
  With MOSS alone this family decides whether the shield can be made.
- fold_jump and fold_exit (2 each): two events he has rejected since round 1. First tries.

What is on the page: 17 of the 18 planned slots, all MOSS, one channel (the valve family has two
because none of its six new files survived the screening and the third carried file is a round-4
hand skip). The pool was 99 MOSS files (90 made in round 5, 9 unheard kept files of round 4); 73
were kept and 26 thrown out (23 cut off, 3 several events). Two picks were skipped by hand for plain
faults (`tools/sound/skips5.json`: thruster_bang_1 s12, shield_bright_2 s12) and replaced. The
manifest has 165 entries (the 148 of before, unchanged, and 17 new). The page check ran on a port of
its own: `audition-check.mjs` 48 passed, 0 failed, 0 page faults (28 faults lie in sound files, 22 of
them in shield_bright_2 s11). He rated none of the 17 on 2026-11-16, and the four countdown samples
(`voice_5_countdown_*`) are still unheard. Nobody listened to any of it. The generate step also made
90 Stable Audio files against his decision; they were kept out of the pool by renaming
`assets/audio/gen/r5/sa3/gen.json` to `gen.json.not-screened` (undo: move it back, but then the
MOSS picks would change).

What he is asked: Passt / Falsch for each candidate, nothing else, no description.

The independent check (`docs/reports/2026-11-16/sound5-verify-report.json`). Its verdict: round 4 is
untouched, the round-5 page entries agree with `screen.json` and `prompts5.json`, and almost every
number in `RESULTS5.md` reproduced. Not clean, its three points to fix, none of them repaired when
this was written:

- `tools/sound/tests/test_screen.py` (line 1012) asserts that the `skips` of `skips5.json` are
  empty, and the file now holds the two hand skips: 43 tests, 1 failed. The assertion should check
  that the file exists and holds a list.
- ev5_6_shield_bright_2_moss_p2s11 leaves the page 4.0 dB under its two family mates (-28.05 against
  -24.05 and -24.07): the true-peak ceiling stopped its gain (raw crest 35.0 dB). An unequal level
  biases a listening comparison. Replace it before he listens, or state the miss on the page.
- ev5_3_thruster_valve_1_moss_r4p1s12 ends within 20 dB of its maximum in its last 50 ms (16.7 dB;
  14.2 dB on the raw cut), because the raw file drops at 1.004 s, where the cut-off rule does not
  look. Accept it as a hard-ending burst, or re-cut or skip it.

Also not repaired: the README section "Round 5" (`tools/sound/README.md`) says 78 files where there
are 90 per model, names a wrong id for the first valve pick, and tells the reader to generate Stable
Audio, which would change the MOSS picks when screened; `RESULTS5.md` has four sentences that the
check lists as wrong or over-reaching (four hand-skipped shield files, the shape of thruster_1 s11,
the click count of shield_bright_2 s12 and the peak of thruster_bang_1 s12, 68 % against 71 %). The
regeneration test gave bit-identical files for three of four; one MOSS file (hull_heavy_2 s11)
differs at about -79 dB, so a run is not reproducible bit for bit.

What nobody could verify: how any of it sounds (the check and the orchestrator looked at
waveforms, spectrograms and levels, which show plain faults only), whether the clicks in
shield_bright_2 s11 are the crackle he asked for or a fault, the decoder's pressing against full
scale (measured by crest only), and the 20 dB cut-off threshold on steady sounds. See `RESULTS5.md`,
"What could not be judged".

When he has rated round 5:

1. Record the round the way round 4 was recorded: copy the saved ratings to
   `assets/audio/rounds/round5-ratings.json` and write `assets/audio/rounds/round5.json` (round,
   date, note, and the file hash of every sound on the page as he heard it, same form as
   `round4.json`). Keep the files as he heard them in `assets/audio/gen/_kept/round5`. Only then may
   screen, publish or build run again on the real tree, and never write `assets/audio/ratings.json`
   by hand.
2. Read the ratings by family and prompt, not by source: which prompts of the first tries he
   accepted, whether the shield can be made with MOSS, whether the thruster now bangs, whether the
   two fold events work.
3. Accepted candidates become the library's event sounds through `tools/audio/build.py` as processed
   copies, each with its origin (model, prompt, seed) and licence (MOSS, Apache-2.0). `build.py`
   has no step for generated files yet (it knows only synthesised sounds and downloads), so it needs
   one, with tests. Only then give the rules in `tools/audio` new numbers, taken from what he
   accepted. A family he rejects gets another round (new prompts); another source needs a new yes.
4. Before the rules get numbers, have the measuring reviewed: `tools/audio/listen/measure.py` and
   `tools/audio/synth/rules.py` were never reviewed (`build.py` was, on 2026-11-15, for its
   handling of downloads). At a re-render every one-shot starts at zero (a rule is missing).
5. Then show him the plan for the game's runtime audio (section 3) in a few sentences. It is still
   not started without his word.
6. If he says the crackling is still there: the discharges at the end of the shield hits and fold
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
few sentences. Its event sounds wait for round 5 and what follows from it. What it has to do:

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

What waits on him now: his ratings of round 5 (0 of 17 on 2026-11-16); the four countdown samples;
which voice model he accepts and whether the preset voices of Kokoro and Kitten count as
artificial; the licence of Stable Audio, which he answered on 2026-11-16 by choosing MOSS only
(ask again only if MOSS fails the shield in round 5 and he wants to reopen it, since the finished
checkpoint is gated and needs a login); optional Freesound CC0 downloads with his own account.
Also open:

- From round 1, still unrated: fold jump, fold exit, shields-down alarm, the longer cruise charge,
  and the stereo stage as a whole. Ask him in the next round.
- A real controller: ask him to fly a few minutes with his own pad and say what he feels (stick
  response, dead zone, the default layout, the chords on Y).
- Recordings made at home (`tools/audio/RECORDINGS.md`), if he makes them: raw material.
- Things outside the ship as real sound: "not for now". Do not raise it again unasked.
- The eleven direction samples of round 3 (category `pilot`, "Richtungsproben (Runde 3)") are still
  on the page, none rated; he liked none of them. The earlier plan was to remove the category and
  its modules after his choice. He made none, so they stayed until round 4 was recorded; that has
  happened, so ask him in one line whether they can go, and remove them with the next build (after
  round 5 is recorded).

Not to be started without his word:

- The build of the voice pipeline.
- The rebuild of the game's runtime audio.
- A re-render of the event sounds.
- Any download beyond the three sources of 2026-11-15.
- Music: the model is downloaded and has never been run.

### 5. Lessons of rounds 4 and 5

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
