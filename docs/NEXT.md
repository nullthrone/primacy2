# Brief for the next work session

Written on 2026-11-15 and brought up to date on 2026-11-18, after round 6 (another try for the
families he rejected) was rated and round 7 (built around the two candidates he called close) was
made. Delete or replace this file when the step is done; `docs/ROADMAP.md` stays the lasting
record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. Push only to this branch, never to `main`, and open no
  pull request.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round), then
  `tools/sound/README.md`, `RESULTS.md` (round 4), `RESULTS5.md` (round 5), `RESULTS6.md` (round 6)
  and `RESULTS7.md` (round 7; read it together with `docs/reports/2026-11-18/sound7-verify-report.json`,
  which lists wrong sentences in it), then `tools/voice/README.md`, `RESULTS.md` and `CANDIDATES.md`.
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
- Rounds 4 to 6 are recorded and stay as they are: `assets/audio/render/source`,
  `render/events5` and `render/events6`, `assets/audio/gen/moss`, `gen/sa3`, `gen/oga`, `gen/r5`,
  `gen/r6`, `gen/_kept`, `assets/audio/rounds`, `tools/sound/prompts.json`, `prompts5.json`,
  `prompts6.json`, `skips.json`, `skips5.json`, `skips6.json`, `RESULTS.md`, `RESULTS5.md` and
  `RESULTS6.md` are not changed or moved. Round 7 lies beside them (`assets/audio/gen/r7`,
  `assets/audio/render/events7`, `tools/sound/prompts7.json`, `skips7.json`, `RESULTS7.md`).
  Frozen while the owner rates round 7: `assets/audio/render/events7`, and no
  `tools/sound/screen.py`, `publish.py` or `tools/audio/build.py` on the real tree (except
  `build.py --manifest-only`, by the role told to run it), until his ratings are recorded (section
  1 says how). Look first whether he has rated: `assets/audio/ratings.json` is byte-identical to
  `assets/audio/rounds/round6-ratings.json` (SHA-256 `28ba8285...61d4`, saved
  2026-11-18T14:40:34.900Z) as long as he has not. A plain `screen.py` or `publish.py` without
  arguments still means round 4 and is not run on the real tree.
- The eleven direction samples of round 3 (category `pilot`) are gone since 2026-11-17, on his word:
  out of `tools/audio/sounds.json` with their renderers and tests, and off the page without a build
  on the real tree (`docs/ROADMAP.md`, section 2, "The direction samples taken off the page"). The
  manifest had 176 entries then (188 on 2026-11-18, counted by a script, after the library change
  and round 7). Their rendered files are kept in `assets/audio/gen/_kept/round3-pilot`.
  The check that nothing old moved reads: of the 165 hashes of `assets/audio/rounds/round5.json`,
  the 154 that are not `pilot_*` are unchanged and the eleven `pilot_*` are absent. That was the
  one change of the real tree during the freeze, made because he had not started rating and no
  file he is asked to rate was written. A page that was open before lists the samples until it is
  loaded again.
- Disk on 2026-11-18: 547 GB free of 1.9 TB (stop line of this work 200 GB; his condition: at
  least 10 % free). `.venv-sound` about 16 GB, the MOSS model 11 GB under
  `assets/audio/gen/moss/model`, the Stable Audio weights 4.5 GB under `.venv-sound/sa3/weights`,
  the recordings 16 MB of archives; all ignored by git. The sound tools are in `tools/sound`; every
  use of the graphics card goes through `tools/voice/with_lock.py`.

## The step: round 7 with the owner, then the sound comes into the game

### 1. Round 7 waits for his ratings (round 6 was rated on 2026-11-18 and is recorded)

ROUND 6 IS RATED AND RECORDED. Do not record it again: `assets/audio/rounds/round6.json` (176
hashes, each checked against its file), `round6-ratings.json` (the saved ratings, SHA-256
`28ba8285...61d4`, saved 2026-11-18T14:40:34.900Z) and `assets/audio/gen/_kept/round6` (with
`kept.json`) exist. He has rated something new only when `assets/audio/ratings.json` differs from
`assets/audio/rounds/round6-ratings.json`; on the day this was written the two were byte-identical.
The older test ("differs from `round5-ratings.json`") is out of date.

**The result of round 6** (rated 2026-11-18 between 14:28 and 14:40 UTC, 55 ratings on the file the
manifest lists; counts from the recording script and `docs/reports/2026-11-18/round6-ratings-analysis.json`).
Of the 14 candidates 4 fit, 2 are close, 8 are wrong. By family: hull_light 1 fits, 1 wrong;
thruster_mighty 1 close, 2 wrong; shield_tight 1 close, 2 wrong; fold_jump 1 fits, 2 wrong;
fold_exit 2 fit, 1 wrong. His notes, word for word:

- Fits, the first light hull hit (`ev6_1_hull_light_1_moss_p1s22`): "ist ok, schauen wir mal wie es
  weiterhin wird". Fits without a note: the first fold jump (`ev6_4_fold_jump_1_moss_p1s14`), the
  second and third fold exit (`ev6_5_fold_exit_2_moss_p1s13`, `ev6_5_fold_exit_3_moss_p1s16`).
- Close, the thruster (`ev6_2_thruster_mighty_2_moss_p3s11`): "Es waren nur zwei statt Drei Schüsse
  wie im Prompt gewünscht. Grundsätzlich gut. Wenn wir noch ein bisschen Raumklang reinbringen, sind
  wir langsam am Ziel".
- Close, the shield (`ev6_3_shield_tight_2_moss_p2s11`): "Es wird besser, ich würde den Ton
  vielleicht leicht heller machen als bisher, aber die Idee, dass der Schild ein Projektil oder
  einen Energiestrahl "verschluckt", und so klingt es hier ein wenig, ist die richtige Richtung".
- Wrong, all without a note: `ev6_1_hull_light_2`, `ev6_2_thruster_mighty_1` and `_3`,
  `ev6_3_shield_tight_1` and `_3`, `ev6_4_fold_jump_2` and `_3`, `ev6_5_fold_exit_1`. No note of this
  round says "übersteuert".

The 41 other ratings of that day: 35 fit, 4 close, 2 wrong. Nineteen are voice samples (section 2).
Of the 22 other sounds, 20 fit: the four library hull hits and `g_thruster_pulse_c`, and 15 sounds
that are not in the library (four radio, three sensor, three weapon, four alarm, one cruise). The
two wrong ones are `g_thruster_pulse_a` and `g_thruster_pulse_b`, library copies of valve pulses he
had accepted as candidates in rounds 4 and 5, both without a note. The same signals play 8.25 dB
(a) and 6.77 dB (b) louder in the library than the copies he heard; c, which fits, plays 5.73 dB
louder (the analysis report measured it). Whether the level is why he rejected them is not known:
three pulses cannot separate level, length and character.

**What round 6 settles.** Hull hits (light, medium, heavy), the gear, the fold jump and the fold
exit are accepted and are in the library: `assets/audio/generated.json` lists ten sounds (round 4:
2, round 5: 4, round 6: 4) and a new list `withdrawn` with the two rejected pulses (the library
report, the independent check: all four new files equal `kept.json` by sha256, the manifest has 188
entries; the 178 entries before round 7 are equal in every field by the gate of the select step and
in hash and file by the check). Five of the ten are rated in their
built form (four hull hits and pulse c, all fit); `g_gear_deploy` and the four new ones are not.
The countdown made of single clips on a clock is accepted by ear: all four samples fit, both
variants, so the ratings do not choose between them. **What it leaves open.** The thruster pulse and
the shield hit (no gun or cannon thruster has fit in rounds 4 to 6, 3 close and 6 wrong; no MOSS
shield has fit, 7 rated: 2 close, 5 wrong). Which voice model (section 2). Whether `notSaturatedNoise`
finds what he means by "übersteuert": of the 14, 3 are over both numbers (a fit, a close one, a wrong
one) and none of the three rule families, because the rule had removed them; over rounds 4 to 6
the rule families have 4 over both (all wrong) and 16 not (5 fit, 3 close, 8 wrong); numbers
fitted on rounds 4 and 5 reject 2 of 4 round-6 fits; no new rule was proposed, and no note of round 6
names overdrive.

**Round 7** (`tools/sound/prompts7.json`, whose "note" explains every family; `tools/sound/RESULTS7.md`;
category "Ereignisklänge (Runde 7)", `events7`, the first category of the page; MOSS only; root
`assets/audio/gen/r7`). It is built around the two candidates he called close, because new prompts had
landed less than one time in three. On the page, 10 sounds (counted by script; 11 were planned, the
second slot of `thruster_three` has no candidate with exactly three measured shots):

- Five fixed candidates, processed from the raw files of round 6 as he asked (always on the page, no
  rule applies): the thruster with a room of 0.9 s decay at -9 dB and one of 1.4 s at -4 dB (one
  channel each) and a wide room of 1.2 s at -6 dB (two channels), since "Raumklang" can mean
  reverberation or width; the shield tuned 3 semitones higher, and with a high shelf of +8 dB at 300 Hz.
- Five generated (40 files made, 5 prompts x seeds 21 to 28; 34 kept, 11 of 45 thrown out): the
  thruster prompt he called good in principle, asked for 4 s so that three shots fit, and the same in a
  steel hangar (the page text of each thruster says how many shots were measured, 2, 2, 2, 3, 3);
  three shield prompts (swallows a projectile, absorbs a beam, a bright snap).
- He is asked only for Passt / Falsch.

**What the independent check found** (`docs/reports/2026-11-18/sound7-verify-report.json`; its own
measurements, nothing changed but the report). Verdict: round 7 holds on all nine points, with
caveats; points 6 (cuts and faults) and 9 (texts against measurements) only partly. Held: nothing he
rated moved, the library, the page entries, the processing recomputed with its own code, the level
at the page (within 0.39 dB of -28 and -24 LUFS, the two-channel room at -3.10 dB file to page),
`audition-check` 48 of 48 with no fault from the page, 40 generated files equal to the plan, no
Stable Audio, nothing downloaded; `unittest discover -s tools/audio/tests` 111 tests, `test_screen.py`
58, vitest 807 passed (2 expected failures), `tsc` exit 0. **NOT REPAIRED AS OF THIS WRITING:** its
`mustFix`, the manifest text of `ev7_6_shield_absorb_1_moss_p1s27`, says "Chosen as the most typical
candidate of its source in this family"; the file is a fallback of pressed noise (6 of 8 files of the
family were cut off, both kept ones are over the pressed-noise numbers, this one over both) that
fills its slot only because nothing else was left. The entry and `publish.py` still carry the
sentence, so the page he reads says it. Putting it right means `publish.py` on the real tree while it
is frozen, or a skip and a new publish: that is the orchestrator's decision. Until then tell him with
the hand-over that this one is a fallback. Eight more wrong sentences in `RESULTS7.md`, the README of
`tools/sound` and the intent texts are listed in the report (shot claims rest on `count_shots` alone
and the check's own counter differs on 4 of 16 generated thruster files; "no faults" stands beside a
click in `shield_snap` s22; a length column that is the cut length; some 16 kHz values; an example id
that is not on the page; "-25 / -21 LUFS" in every intent text counts one channel on both and is not
what the page plays). They are not repaired either.

**What nobody could verify**, and he should be told: how any of the ten sounds; whether the rooms
are his "Raumklang"; whether the tuned or the shelved shield is "heller" in his sense; whether the
three generated bright shields are the kind he turned down (two have the spectral shape of the
recorded spark and of `shield_bright_2`, at a loudest 50 ms about 10 dB higher; both were kept and
flagged, not skipped); whether the click in `shield_snap` s22 and the 16 kHz line that every MOSS
file has (also those he accepted) are heard; whether the three room versions are over both numbers
of `notSaturatedNoise` as their parent is (they are; so are `shield_brighter_2` and the absorb pick);
that the two generated thrusters have the highest loudest 50 ms of any rated thruster file
(-1.58 and -2.21 dBFS) and match `thruster_mighty_1`, which he rated wrong, on the four measures of
the select test.

The earlier work of rounds 4 and 5 (the "übersteuert" measurement: the page does not make it, it is
in the files; the measuring tools reviewed and repaired on 2026-11-16 and 17, no rendered byte
changed; the library step for generated files) is in `docs/ROADMAP.md`, section 2, "Sound sources",
and `tools/audio/SOUND_DESIGN.md`, section 4, with his notes word for word.

When he has rated round 7:

1. Look whether he has: `assets/audio/ratings.json` then differs from
   `assets/audio/rounds/round6-ratings.json`. Record the round the way rounds 4 to 6 were recorded:
   copy the saved ratings to `assets/audio/rounds/round7-ratings.json` and write
   `assets/audio/rounds/round7.json` (round, date, note, and the file hash of every sound on the
   page as he heard it, same form as `round6.json`; the count comes from the script, 188 entries on
   2026-11-18). Keep the files as he heard them in `assets/audio/gen/_kept/round7` (`kept.json` of
   round 6 shows the form). Only then may screen, publish or build run again on the real tree, and
   never write `assets/audio/ratings.json` by hand. Take every count from the output of a script.
2. Read the ratings by family: the thruster (which of the three rooms, if any; whether three
   generated shots in one file are mighty or too pressed) and the shield (tuned, shelved, or one of
   the three generated). Every candidate he calls overdriven and every one he accepts is a data
   point for `notSaturatedNoise`: five candidates of round 7 are over both numbers. The analysis of
   round 6 was made by `tools/sound/compare.py` with its option `--analysis` (47 rated candidates of
   rounds 4 to 6); read what it covers before using it for round 7.
3. Accepted candidates go into `assets/audio/generated.json` (form and rules in
   `tools/audio/README.md`, "Generated sounds in the build"), then one build. A generated candidate
   goes in as in round 6. A fixed candidate is made by processing a raw file of round 6 (room, pitch
   or shelf, with its numbers and seed), and the build cannot record that yet: an entry knows a raw
   file and a cut, not an operation. That needs a change of `tools/audio/build.py` and its tests, the
   raw file committed under `assets/audio/generated` (the thruster's has the sha256 `02a8c33c...3aab`),
   the operation and its numbers written into the entry, and the same gate as the library step: a copy
   first, then `build.py --manifest-only`, with the old entries equal in every field. Decide the level
   of a new library sound on purpose: the two pulses he rejected in the library had played 8.25 and
   6.77 dB above the candidates he had accepted.
4. Give the rules in `tools/audio` new numbers, taken from everything he has accepted in rounds 4
   to 7 (still to do). The measuring is reviewed. The first full build after the repairs also
   refreshes the checks of the rendered sounds, which still carry the numbers of before: run it with
   CLAP and with `--describe` (eleven entries carry a description, and a build with `--no-clap`
   strips those fields), on a copy first, and compare the hashes of all entries with the record of
   round 7. At a re-render every one-shot starts at zero (a rule is missing); a re-render needs his
   word.
5. A family he rejects again. Thruster: another round with new prompts is possible. The shield: no
   MOSS shield has fit in seven tries, and the only shields he accepted came from Stable Audio, which
   he ruled out on 2026-11-16. If round 7 fails too, put the fact before him and ask whether he wants
   to reopen that or allow another source (Freesound CC0 with his own account, recordings made at
   home, other models). Do not push; another source needs a new yes.
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

His ratings of 2026-11-18 (24 voice samples are rated in all, 19 of them that day; counts from
`docs/reports/2026-11-18/round6-ratings-analysis.json`). Per line, on 2026-11-18:

- clearance: Qwen3, Chatterbox, Kokoro and Kitten fit (Kitten, his note: "Klingt sehr gut und sie
  sagt "Niner," statt "Nine", was sehr gut ist für Funksprache"); Phonon is close, "zu langsam
  gesprochen".
- dock: Qwen3 fits, "Klingt natürlich" (on 2026-11-15 it was close, without a note), and Phonon fits,
  "Klingt natürlich"; Chatterbox, Kokoro and Kitten are close, each "Klingt wie vorgelesen".
- convoy: all five fit, without a note.
- countdown: all four fit, without a note.
- computer (rated on 2026-11-15, five close): "Countdown wird nicht wirklich in Sekunden gezählt,
  die Abstände sind unregelmäßig und kürzer".

By model over all 24 ratings (fits / close / wrong): Qwen3 5 / 1 / 0, Chatterbox 4 / 2 / 0, Kokoro 2 /
2 / 0, Kitten 2 / 2 / 0, Phonon 2 / 2 / 0. The counts do not compare across models, because only
Qwen3 and Chatterbox have countdown samples (6 ratings each against 4), and the verdict of a line
differs between models for reasons his notes give only in part. They recommend no model, and none
is recommended here. No voice sample was rated wrong.

What they answer. The countdown: four samples are on the page (`voice_5_countdown_*`: Qwen3-TTS and
Chatterbox-Nano, each with the numbers spoken one by one or cut out of one sentence); all four fit,
by ear. By construction the numbers start 1000 ms apart; the independent check of 2026-11-15
measured medians of three detectors within 10 ms of that (single detectors off by up to 57.5 ms).
His suggestion is the design rule, and it stands: speech that must keep time is made of single
clips placed by a clock (`tools/voice/countdown.py`), not of one utterance. The ratings do not
choose between the two variants. What they do not answer: which model; whether the preset voices of
Kokoro and Kitten count as artificial; "vorgelesen" on three models for one line.

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
few sentences (done on 2026-11-17). Its event sounds wait for round 7 and what follows from it;
ten sounds he accepted as candidates are in the library (`assets/audio/generated.json`; five of them
are rated in their built form; two more were withdrawn after he rejected them as library copies).
What it has to do:

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

What waits on him now: his ratings of round 7 (0 of 10 rated on the day this was written, by the
page's own definition and the saved ratings of 2026-11-18T14:40:34.900Z); which voice model he
accepts and whether the preset voices of Kokoro and Kitten count as artificial (the countdown
samples are rated and fit); his word on the runtime audio, whose plan he was shown on 2026-11-17;
optional Freesound CC0 downloads with his own account. The licence of Stable Audio he answered on
2026-11-16 by choosing MOSS only. MOSS has made seven shields he rated, none of which fits (2 close,
5 wrong; the last close one is the parent of two candidates of round 7); he was told on 2026-11-17
that it had failed twice. Reopening Stable Audio is his decision (the finished checkpoint is gated
and needs a login).

Unrated sounds on the page, counted by a script from `assets/audio/render/manifest.json` and
`assets/audio/ratings.json` (saved 2026-11-18T14:40:34.900Z, SHA-256 prefix `28ba8285`), with the
page's rule that a sound is rated when it has stars, a verdict or a note: 49 of 188 are unrated.
By category (unrated of total): events7 10 of 10 (round 7), switches 14 of 14, sensors 11 of 14,
landing 6 of 10, drive 3 of 11, cabin 2 of 6, weapons 2 of 5, impacts 1 of 17; none in engines,
thrusters, alarms, radio, events5, events6, source and voice. Of the 49, 5 are library sounds
(`g_gear_deploy`, `g_impact_hull_light_b`, `g_fold_jump`, `g_fold_exit_a`, `g_fold_exit_b`; the
library has no category of its own, they sit in landing, impacts and drive) and 34 are older
sounds of the first rounds that he has not rated. 23 more sounds carry a rating on an older file
than the one on the page (the page marks them as changed): engines 6, drive 5, impacts 4, thrusters
3, landing 2, cabin 2, alarms 1. Two ratings in the file belong to sounds that are not on the page
any more (the two withdrawn pulses, both wrong). Three entries on the page have no verdict: two have
five stars (rated by the page's rule), one has no stars and no note (counted as unrated).
Also open:

- From round 1: the old list "fold jump, fold exit, shields-down alarm, the longer cruise charge"
  is no longer true as written. Those sounds carry his round 1 ratings (fold jump, fold exit and
  the shields-down alarm wrong, the cruise charge fits), but the files have changed since, so the
  page marks them as changed and a new rating would be a new one. The stereo stage as a whole is
  still unrated. Ask him in the next round.
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

### 5. Lessons of rounds 4 to 7

Round 7 and the library change (2026-11-18; from the `problems` of the reports of that day):

- A library copy plays at the level of the rendered event it stands for, and that is not the level
  at which he heard the candidate. Two library pulses played 8.25 and 6.77 dB above their candidates
  and he rated them wrong; the one that fits played 5.73 dB above. A level is possibly the cause,
  not proven. Before a library sound is built, say at what level he heard it, and look at the gap.
- A measuring tool must not depend on files that another session may change. The analysis of round 6
  found the rendered library pulses withdrawn and deleted while it ran; `tools/sound/compare.py` now
  rebuilds them in memory with `process_generated` from the committed raw files after checking
  their sha256. Read from the raw files and their hashes, not from `render`.
- A trial run of `screen.py` with test skips on the real root overwrote the real `screen.json`; a
  clean rerun repaired it and a script checked it. Try skips on a copy of the root.
- A rule that removes candidates from the pool cannot be tested on the files it removed: the three
  rule families of round 6 had no candidate over both numbers, so round 6 said nothing about the
  rule. If a rule is to be judged, leave some of what it would exclude on the page, or say that it
  cannot be judged.
- A slot rule that asks for exactly three shots left a slot empty (10 of 11 planned). That is right:
  do not fill a slot with a candidate that has the wrong number of shots. But a shot count is a
  heuristic: the check's own counter differed on 4 of 16 generated thruster files, and the page says
  "N shots" from the tool's count. Look at the picture, and say which counter a number is from.
- A text the tool writes about a pick must come from the data of the run: the page says "most
  typical candidate" of the fallback pick of `shield_absorb`, though `screen.json` flags it
  `pressedNoiseFallback`. That sentence, "no faults" in a
  report beside a click the page check lists, and a column "length s" that is the cut length are
  one kind of fault: a sentence written before the number was looked at.
- A speech check can throw out sound effects: Whisper wrote "BANG!" and "BOOM!" for three
  thruster files, which were thrown out as speech (none would have been picked for the shot count).
- `tools/dev/audition-check.mjs` writes screenshots into `screenshots/audition` of the repository
  on every run.
- The independent check (`docs/reports/2026-11-18/sound7-verify-report.json`) is part of the round
  and its `mustFix` is the orchestrator's to settle before the hand-over, or to tell him.

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
