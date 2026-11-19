# Brief for the next work session

Written on 2026-11-15 and brought up to date on 2026-11-18 in the evening, after he rated round 7
(built around the two candidates he called close) and every other sound that was still unrated on
the page, and after the round was recorded (section 1). The session that made rounds 3 to 7 ended
there on his word; this file is its hand-over. The session after it changed the way of working
(below), made the library step for round 7 and took the relay sounds off the page the same night
(section 1, steps 2 and 3), and started the runtime audio on his word in a session of its own
(section 3). It had grown to half a million tokens by then: a fresh session takes the sound work
over from this file. Delete or replace
this file when the step is done;
`docs/ROADMAP.md` stays the lasting record.

## Where and how

- Work on feature branches that are merged into `main` early, each session in a git worktree of
  its own. His word of 2026-11-18, after he had merged pull request 1
  (https://github.com/nullthrone/primacy2/pull/1, which brought `main` from the licence alone to the
  whole work): "Wir arbeiten ab jetzt mit Feature Branches und mergen früh in main und arbeiten
  hier lokal in Worktrees". The rules are in `docs/ROADMAP.md`, section 5. In short: a small branch
  cut from `main` per piece of work, a pull request as soon as it is green by itself, and the
  session merges it itself as one commit (asked that evening, his choice: "Claude mergt, Squash").
  The old rule (push only to `claude/primacy2-space-simulator-b9a0b8`, never to `main`, he merges)
  has ended.
- The sound work happens in one worktree only,
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`. It alone holds
  what git ignores of the sound work, and part of that cannot be made again (the files of every
  round as he heard them, `assets/audio/gen/_kept`; also the rendered tree, the downloads, the MOSS
  model and the three Python environments). A branch for the sound is switched to in that
  worktree, and the worktree is never removed. A byte copy of `assets/audio/gen/_kept` (rounds 3 to
  7) lies outside every worktree at `C:\Claude Code\LOCAL\primacy2-kept` since 2026-11-18, on his
  word: copy a new round there once it is recorded.
- Read `docs/ROADMAP.md` in full first, then `tools/audio/SOUND_DESIGN.md` (the direction for the
  sound, the rules, and in section 4 the owner's words from each listening round), then
  `tools/sound/README.md`, `RESULTS.md` (round 4), `RESULTS5.md` (round 5), `RESULTS6.md` (round 6)
  and `RESULTS7.md` (round 7; its section "After the first check" is what stood on the page, its
  last section gives his ratings; the reports `docs/reports/2026-11-18/sound7-*.json` are the two
  independent checks and the repairs), then `tools/voice/README.md`, `RESULTS.md` and
  `CANDIDATES.md`.
- How Thomas wants to work is in the project's memory files, which load by themselves. Answer him
  in German.
- Limits: a 5-hour usage window and a weekly allowance per model; limits are waited out. Measured
  on 2026-11-15: a workflow of eight to eleven agents on the cheaper model (1.3 to 1.5 million
  tokens) costs about 10 points of the 5-hour window. The orchestrating session on the strongest
  model is what eats the weekly allowance: keep its own reading small. Never send a message to an
  agent that is running inside a workflow (it starts a second copy).
- Before anything else: start `bash tools/dev/checkpoint.sh` in the background if no loop runs in
  your worktree (it ends by itself after eight hours, and it does nothing while `main` is checked
  out).
- Other sessions work in worktrees of their own; what they change reaches you through `main`.
  Since 2026-11-18 one works on the special effects (`packages/client/src/render`; its interview
  with him is in `docs/ROADMAP.md`) and one on the game's runtime audio (section 3; it reads
  `assets/audio/render` of the sound worktree and writes nothing there, so do not move or rename
  that tree without telling it). Keep to your own files, and change shared documents
  (`docs/ROADMAP.md`, `docs/CLIENT.md`) by exact replacement, never by writing the whole file: two
  branches that both rewrite a document cannot be merged.
- An agent that queues work behind the bench lock (`tools/voice/with_lock.py`) and then ends its
  turn leaves the work running with nobody to read the result. Tell agents to wait for their own
  locked commands, and check for left-over processes before you trust a "partial".
- Scripts that edit text files on Windows must write `\n` line ends (the repository wants LF).
- Rounds 4 to 7 are recorded and stay as they are: `assets/audio/render/source`,
  `render/events5`, `render/events6` and `render/events7`, `assets/audio/gen/moss`, `gen/sa3`,
  `gen/oga`, `gen/r5`, `gen/r6`, `gen/r7`, `gen/_kept`, `assets/audio/rounds`,
  `tools/sound/prompts.json`, `prompts5.json`, `prompts6.json`, `prompts7.json`, `skips.json`,
  `skips5.json`, `skips6.json`, `skips7.json`, `RESULTS.md`, `RESULTS5.md`, `RESULTS6.md` and
  `RESULTS7.md` are not changed or moved. A new round lies beside them, as round 7 did (own root
  under `assets/audio/gen`, own category, own prompts file). Nothing is frozen now: his ratings of
  round 7 are recorded. Look first whether he has rated anything since: `assets/audio/ratings.json`
  is byte-identical to `assets/audio/rounds/round7-ratings.json` (SHA-256
  `4509dbcdfc368b04b08ad54d6b8e5b88e9c7ee191a4b73e75367962ac7fa71f8`, saved
  2026-11-18T19:22:12.338Z) as long as he has not; if it differs, record that before any tool
  writes to the real tree. Never write `assets/audio/ratings.json`. A plain `screen.py` or
  `publish.py` without arguments still means round 4 and is not run on the real tree.
- His audition page is not up by itself. It is the preview server `audition` of
  `.claude/launch.json` (port 5190, `http://localhost:5190/dev/audition.html`) and it writes his
  real ratings file. That file was gone when the next session started (the folder `.claude` of the
  worktree was empty, and git ignores it); an entry `audition` was written again on 2026-11-18, by
  a guess at what it had been (`npm run dev -w @primacy2/client -- --port 5190 --strictPort`), and
  has never been started. Start it only on his word (on 2026-11-18 the app's permission check refused
  the start until he asked for it), read the page and press nothing. Checks of the page run on an
  own port with `AUDITION_RATINGS_FILE` pointing at an own empty file in an own folder; nothing of
  ours starts on ports 5190, 8420 or 8421.
- The eleven direction samples of round 3 (category `pilot`) are gone since 2026-11-17, on his word:
  out of `tools/audio/sounds.json` with their renderers and tests, and off the page without a build
  on the real tree (`docs/ROADMAP.md`, section 2, "The direction samples taken off the page"). The
  manifest had 176 entries then (189 on 2026-11-18 after the library change and round 7 with its
  changes, 197 with the library step for round 7, 189 again since the relay sounds went; counted by
  a script). Their rendered files are kept in `assets/audio/gen/_kept/round3-pilot`.
  The check that nothing old moved reads: of the 165 hashes of `assets/audio/rounds/round5.json`,
  the 154 that are not `pilot_*` are unchanged and the eleven `pilot_*` are absent. That was the
  one change of the real tree during the freeze, made because he had not started rating and no
  file he is asked to rate was written. A page that was open before lists the samples until it is
  loaded again.
- The record of round 7 no longer equals the page either. Of the 189 hashes of
  `assets/audio/rounds/round7.json`, 181 are on the page unchanged and eight are absent: the relay
  and switch sounds, taken off on 2026-11-18. Eight sounds on the page are not in that record: the
  library sounds of round 7. The check that nothing old moved reads accordingly (counted by a
  script).
- Disk on 2026-11-18: 547 GB free of 1.9 TB (stop line of this work 200 GB; his condition: at
  least 10 % free). `.venv-sound` about 16 GB, the MOSS model 11 GB under
  `assets/audio/gen/moss/model`, the Stable Audio weights 4.5 GB under `.venv-sound/sa3/weights`,
  the recordings 16 MB of archives; all ignored by git. The sound tools are in `tools/sound`; every
  use of the graphics card goes through `tools/voice/with_lock.py`.

## The step: the accepted sounds of round 7 into the library, what is still open, then the game

### 1. Round 7 is rated and recorded (2026-11-18, evening)

ROUND 7 IS RATED AND RECORDED. Do not record it again: `assets/audio/rounds/round7.json` (189
hashes, each checked against its file), `round7-ratings.json` (the saved ratings, a byte copy,
SHA-256 `4509dbcd...71f8`, saved 2026-11-18T19:22:12.338Z) and `assets/audio/gen/_kept/round7`
exist. The kept folder is ignored by git and exists only on this machine: `page/` (33 files, the
eleven candidates as he heard them), `raw/` (13 files: the four MOSS raw files, the seven processed
files of `tools/sound/derive.py`, and the two round-6 raw files those were made from, `parent__*`),
`listen/` (11), `screen.json`, `gen_moss.json`, `gen_derived.json` and `kept.json` (per candidate:
verdict, hash, raw file with its sha256, cut, gain, level target, channels; for a processed one its
parent, its operations and their numbers; for a generated one the prompt and the seed).

**The result of round 7** (rated between 19:14 and 19:22 UTC; every count here is from the
recording script). Of the 11 candidates 8 fit, 1 is close, 2 are wrong. He wrote no note on any of
them.

| candidate | what it is | verdict |
|---|---|---|
| `ev7_1_thruster_room_1_derived_r6p3s11a` | the thruster he called close in round 6, with a room: decay 0.9 s, wet -9 dB, one channel; 2 shots | fits |
| `ev7_1_thruster_room_2_derived_r6p3s11b` | the same, decay 1.4 s, wet -4 dB, one channel; 2 shots | fits |
| `ev7_1_thruster_room_3_derived_r6p3s11c` | the same, decay 1.2 s, wet -6 dB, two channels; 2 shots | fits |
| `ev7_1_thruster_room_4_derived_r6p3s11d` | its first shot appended as a third (a copy), then the room of `room_2`; 3 shots | fits |
| `ev7_2_thruster_three_1_moss_p1s24` | MOSS, the prompt of the close candidate asked for 4 s; 3 shots by `count_shots` | fits |
| `ev7_3_thruster_hall_1_moss_p1s21` | MOSS, the same shots in a large steel hangar; 3 shots | fits |
| `ev7_4_shield_brighter_1_derived_r6p2s11a` | the shield he called close in round 6, tuned 3 semitones higher | close |
| `ev7_4_shield_brighter_2_derived_r6p2s11b` | the same with a high shelf, corner 300 Hz, +8 dB | fits |
| `ev7_4_shield_brighter_3_derived_r6p2s11c` | tuned and shelved | fits |
| `ev7_5_shield_swallow_1_moss_p1s22` | MOSS, a shield that swallows a projectile | wrong |
| `ev7_7_shield_snap_1_moss_p1s24` | MOSS, a force field deflects a projectile, a bright snap | wrong |

How the round was made, checked twice and changed before he heard it is in `docs/ROADMAP.md`,
section 2, and in `tools/sound/RESULTS7.md`.

**What round 7 settles, and what it does not.**

- Each of the six event families of rounds 4 to 7 now has a sound he accepted. Hull hits, the gear,
  the fold jump and the fold exit are in the library (`assets/audio/generated.json`, ten sounds and
  two withdrawn); all ten are rated in their built form on the file the manifest lists, and all ten
  fit (five of them since this evening). The thruster pulse and the shield hit were accepted as
  candidates of round 7; since the library step of the same night they are in the library too
  (eight more sounds, step 2 below), unrated in their built form.
- The ratings do not choose among the thrusters: all six fit, without a note, and `room_1` and
  `room_2` were rated 0.6 s apart. He heard them at the family target of -28 LUFS. All six went
  into the library as variants, at the level of `thruster_pulse_c` (step 2 below): the
  orchestrator's choice, his to overrule.
- The shield: the two that fit are processed copies of the one MOSS file he had called close. Of the
  nine shields that MOSS made from a prompt and he rated, none fits (2 close, 7 wrong: the seven of
  rounds 4 to 6 by the analysis of round 6, and the two of round 7). The shield is settled without
  reopening Stable Audio.
- `notSaturatedNoise` (loudest 50 ms above -9.5 dBFS and a share above 2 kHz in the loud frames of at
  least 0.03): 7 of the 11 candidates are over both numbers, and all seven fit (the four rooms, the
  hangar pick, the two shelved shields). The two wrong shields are under the level number (-12.81
  and -15.16 dBFS). The plan had applied the rule to the generated shield families only. In this
  round the rule's numbers separate nothing that he rejects.
- It settles nothing outside these six families (the list below), and the word on the runtime audio
  is still his.

**His other ratings of that evening** (39 sounds: 23 fit, 3 close, 13 wrong; one of them replaces an
entry that had no verdict, no stars and no note). With them every one of the 189 sounds on the page
is rated by the page's rule. His notes, word for word:

- Eight rendered sounds of the category switches, all wrong, the same note on each: "die ganzen
  Relais Töne bitte weglassen" (`relay_click_a`, `relay_click_b`, `switch_toggle`, `switch_rotary`,
  `breaker_thunk`, `button_press`, `systems_power_up`, `systems_power_down`). In the same category,
  wrong without a note: the downloads `k_door_close_1`, `k_door_open_1` and `k_toggle_1`; fits:
  `k_switch_ui_5`, `k_switch_ui_18` and `n_insight_arm`.
- `weapon_cannon_fire`, wrong: "klingt nach einfach nur ein dumpes klopfen, erinnert überhaupt nicht
  an eine Kanone. Brauchen wir hier noch etwas? Wir haben in anderen Runden ja schon etwas
  gesammelt". He was answered in the chat the same evening: yes, the cannon still needs a sound of
  its own that he accepts; no round made a candidate for it (a script over `tools/sound/prompts*.json`
  and `assets/audio/generated.json`: every gun prompt of rounds 5 to 7 belongs to a thruster family),
  and whether that gun material is also tried as the cannon is his call.
- `weapon_pulse_fire`, wrong: "Klingt überhaupt nicht nach Laser, sondern als ob jemand auf einem
  Plastikeimer tippt...".
- Landing: `touchdown_hard`, close: "Klingt übersteuert". `dust_patter_loop`, close: "Klingt
  übersteuert". `ground_scrape_loop`, close: "der tiefe Basston passt, aber das "Kratzen" in den
  höhen stört". `touchdown_soft` and `settle_creak` fit.
- Fit without a note: the five library sounds that had been unrated (`g_impact_hull_light_b`,
  `g_gear_deploy`, `g_fold_jump`, `g_fold_exit_a`, `g_fold_exit_b`), `cabin_ir`, `k_tick_2`, and the
  eleven sounds of the category sensors that had been unrated (two rendered, three downloaded tones
  and six NASA recordings, among them `n_laser_shots`).

**Where the game's sounds stand** (a script over the manifest and the saved ratings; the categories
of the rounds and the voices left out):

- Nothing accepted: the cannon (`weapon_cannon_fire`), the pulse laser (`weapon_pulse_fire`), the
  gear retracting (`gear_retract` wrong; `g_gear_deploy` fits), the shields-down alarm
  (`alarm_shields_down`, wrong in round 1, the file has changed since), the debris patter
  (`debris_patter`, close: "Klingt wie unterwasser und nicht wie im Raum"), the switches of the
  cockpit beyond the two downloaded toggles, and the hatch (both door downloads wrong).
- Close only: `touchdown_hard`, `dust_patter_loop`, `ground_scrape_loop`.
- Replaced by generated sounds he accepted: the rendered hull hits, thruster pulses, shield hits,
  gear, fold jump and fold exit.
- Fits, on the file the manifest lists: the engine at 25 to 100 % and boost, the thruster burn
  loop, the hull stress groan, `touchdown_soft`, `settle_creak`, four alarms (heat, fuel low, hull
  critical, master caution), `cruise_disengage`, `cabin_ir`, the beam weapon, the mining laser, the
  missile launch, all fourteen sensor sounds, the four radio sounds.
- 28 ratings are not on the file the manifest lists now: 17 of round 1 (2026-11-14) carry no file
  hash (among them the engine idle, the cruise chain, the fold charge and tunnel, the cabin beds
  and two alarms), 11 carry the hash of an older file (downloads of the categories engines,
  thrusters and impacts). The count of 23 that stood here before was made by another rule, not
  re-derived. `cruise_loop` and `fold_charge` carry five stars and no verdict.

**What to do, in this order.** (The orchestrator's plan, not his decision, except where his words
are quoted.)

1. Look whether he has rated anything since (the test above). If so, record it first.
2. The library step for round 7: DONE on 2026-11-18, late evening (`docs/ROADMAP.md`, section 2,
   "The library step for round 7"; `tools/audio/README.md`, "Generated sounds in the build"). All
   six thrusters and the two shields that fit are in `assets/audio/generated.json` (18 sounds, 2
   withdrawn) and in the real tree (197 manifest entries then, 189 since step 3). What is left of it:
   - He has not heard the eight in their built form: they are the only unrated sounds on the page
     (ids `g_thruster_heavy_*`, `g_impact_shield_a` and `g_impact_shield_b`). When he is asked,
     tell him two things. The five one-channel thrusters play about 1.7 dB under the candidates he
     rated, because a library sound takes the place of its event (20 degrees) and the candidates
     stood in the middle. The shields have no place, so every play comes from a new random
     direction and is duller from behind: a single press says little.
   - The choices are the orchestrator's and his to overrule: all six thrusters as variants, and
     what each sound stands for chosen by level (`thruster_pulse_c`, `impact_shield_light`), so the
     pulses a and b and the medium and heavy shield hit still have nothing he accepted.
   - A library file of round 7 or later is built as its page copy times one gain
     (`build.page_finish`). For the next library step: `screen.py` and `publish.py` record the cut
     start with four decimals, which does not name a sample. Find the sample again (the built file
     must have the length of the page copy and match it at offset 0) and write `startS` as
     sample / 48000.
   - The gate of this step was a script in the session's scratch folder, which is gone with the
     session: write it again from the ROADMAP (the old entries equal in every field and in order,
     exactly the new ids added, only `manifest.json` changed, two runs the same bytes, the real
     tree after its build equal to the copy file for file).
3. The relay sounds: DONE on 2026-11-18, night (`docs/ROADMAP.md`, section 2, "The relay and switch
   sounds taken off the page"). The eight are out of `tools/audio/sounds.json` (56 sounds), their
   renderers and tests, and the docking scene of the page; their files are kept in
   `assets/audio/gen/_kept/relays-2026-11-18`; the real manifest has 189 entries. He had been asked
   not to rate the eight library sounds of step 2 before this step was done, because a new rating
   stops every tool that writes the real tree until it is recorded. Open after it: what the cockpit
   switches sound like (the two downloaded toggles fit), the title of the category ("Relays and
   switches") and the two lines of `tools/audio/RECORDINGS.md` that still ask him for relay clicks
   and a rotary selector.
4. What has nothing accepted. Ask him in one question whether he wants a round 8 for it, and give
   him candidates, not a request to describe sounds: the cannon, the pulse laser, the gear
   retracting, the shields-down alarm, the debris patter; and new candidates beside the old files
   for the three landing sounds he called close (not a re-render in place, which needs his word).
   What round 7 shows about method: processing a file he accepted or called close gave 6 fits and
   1 close out of 7; generating from a prompt gave 2 fits out of 4 (both thrusters; both shields
   wrong). Ideas of the orchestrator, none of them his decision: a single shot cut from an accepted
   gun file as a cannon candidate (only if he says yes to using the thruster material, and then the
   two events must still be told apart); the gear retracting made from `g_gear_deploy`; for the
   pulse laser, `n_laser_shots` (NASA SuperCam, public domain), which he rated fits as a sensor
   sound the same evening, as raw material.
5. Measure before ruling. `touchdown_hard` and `dust_patter_loop` are the first rendered sounds he
   called "übersteuert"; nobody has measured them with the measures of the candidates
   (`tools/sound/compare.py --wav`). Then give the rules in `tools/audio` new numbers, taken from
   everything he has accepted in rounds 4 to 7 (still to do; `compare.py --analysis` covers rounds
   4 to 6, read what it covers before using it for round 7). The first full build after the repairs
   also refreshes the checks of the rendered sounds, which still carry the numbers of before: run
   it with CLAP and with `--describe` (eleven entries carry a description, and a build with
   `--no-clap` strips those fields), on a copy first, and compare the hashes of all entries with
   the record of round 7. At a re-render every one-shot starts at zero (a rule is missing); a
   re-render needs his word.
6. The game's runtime audio (section 3) is started: on 2026-11-18 he answered "Ja, bauen" to the
   question whether it should now be built as a first playable version, and a session of its own
   builds it. The voices still wait for his word.
7. If he says the crackling is still there: the discharges at the end of the shield hits and fold
   sounds are designed crackle, the NASA laser shots are snaps, and the SLS recording is clipped
   in its source. Ask which sound he means before changing anything.

The earlier work of rounds 4 to 6 (the "übersteuert" measurement: the page does not make it, it is
in the files; the measuring tools reviewed and repaired on 2026-11-16 and 17, no rendered byte
changed; the library steps for generated files; his notes word for word) is in `docs/ROADMAP.md`,
section 2, "Sound sources", and `tools/audio/SOUND_DESIGN.md`, section 4.

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

<<<<<<< HEAD
STARTED on 2026-11-18 on his word ("Ja, bauen"), in a worktree and session of its own
(`.claude/worktrees/runtime-audio-43eb54`); what is built, what was decided and what is silent is
in `docs/ROADMAP.md`, section 2, "The game's runtime audio on the library", and `docs/CLIENT.md`,
"Sound". The text below is the brief it was built from. Core work for the strongest model:
=======
Started on 2026-11-18 on his word. He asked whether any worktree already plays the new sounds,
because he wants to play with them (none did), and answered "Ja, bauen" to the question whether
the runtime audio should now be built as a first playable version. The session "Laufzeit-Klang:
erste spielbare Fassung" builds it in a worktree of its own, cut from `main`; it reads
`assets/audio/render` of the sound worktree by its path and writes nothing there. This section is
its specification, and it may change this section by exact replacement. Events that have no sound
he accepted stay silent in the first version. Core work for the strongest model:
>>>>>>> main
`packages/client/src/audio` is rebuilt, not patched. Design it first and show Thomas the plan in a
few sentences (done on 2026-11-17). Since round 7 each of the six event families of rounds 4 to 7
has a sound he accepted: eighteen are in the library (`assets/audio/generated.json`; the first ten
fit in their built form, the eight of round 7 are unrated as built; two more were withdrawn after
he rejected them as library copies). The cannon, the pulse
laser, the gear retracting and the shields-down alarm have nothing he accepted yet.
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

What waits on him now: to hear the eight library sounds of round 7 as built (section 1, step 2),
and his word if the game should not use all six thrusters as variants; whether the gun material of rounds 5 to 7 may also be tried for the cannon, and whether
he wants a round 8 for the sounds that have nothing he accepted (section 1); which voice model he
accepts and whether the preset voices of Kokoro and Kitten count as artificial (the countdown
samples are rated and fit); optional Freesound CC0 downloads with his own account. The licence of Stable Audio he answered on
2026-11-16 by choosing MOSS only, and the shield is settled without it (section 1).

Unrated sounds on the page: the eight library sounds of round 7 (8 of 189, by a script after the
relay sounds went on 2026-11-18; of the 189 on the page 107 fit, 24 are close, 48 are wrong, two have
five stars and no verdict, and eight are unrated). The 189 of before that step were counted by a script from `assets/audio/render/manifest.json` and
`assets/audio/ratings.json` (saved 2026-11-18T19:22:12.338Z, SHA-256 prefix `4509dbcd`), with the
page's rule that a sound is rated when it has stars, a verdict or a note: 0 of 189 are unrated. By
verdict: 107 fit, 24 close, 56 wrong, and two have five stars and no verdict (`cruise_loop`,
`fold_charge`). 28 of the ratings are not on the file the manifest lists now (section 1). Ten ratings in the file belong to sounds that are not on the page any more (the eight relay and
switch sounds and the two withdrawn pulses, all wrong).
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
- A re-render of the event sounds.
- Any download beyond the three sources of 2026-11-15.
- Music: the model is downloaded and has never been run.
- His audition page (the preview server `audition` on port 5190).

### 5. Lessons of rounds 4 to 7

The library step for round 7 (2026-11-18, late evening):

- "It is the file he heard" is a gate to measure, not a sentence to write. The first build differed
  from the page copies by -20 to -40 dB: the page copy has its mean taken out, ends by other
  thresholds, and its cut start was recorded with too few decimals. Before a library file reaches
  the real tree, compare it with the copy he rated: the same length, offset 0, one gain, and a
  residual at the floor of the format.
- Give a checker a threshold that can be met. "Below -70 dB" cannot be met by two 16 bit files at
  -28 LUFS; the second checker showed that -65 dB there is the noise of the two quantisations and
  nothing else. Name the floor of the format, not a round number.
- Ask a server of your own which ratings file it writes (`/audio-lib/ratings-path`), read the
  answer, and only then let anything open its page. The orchestrator put the question and the
  measuring tool into one command; the variable had not reached the server, which named his real
  file. The tool only presses Play and the file is byte-identical, but that was the nature of the
  tool, not care.
- Before the first merge under a new way of working, read the app's own settings: it archived a
  session when its pull request merged, and archiving cleans up the session's worktree.
- The manifest is assembled from the files in the render tree, not from `sounds.json`. A sound
  leaves the page only when its files leave the tree, and the files go first: with them still
  there the build kept 197 entries and moved the eight relay sounds to the end of the rendered
  block.

The evening of round 7 (2026-11-18):

- Start from what he accepted or called close. Seven candidates were made by processing two files
  he had called close (a room, a pitch, a shelf, a copied shot): 6 fit, 1 close. Four were generated
  from a prompt: the two thrusters fit, the two shields are wrong. Three rounds of new shield
  prompts had given nothing that fits.
- A rule that was never tested on what it would refuse stays a guess: all seven candidates over
  both numbers of `notSaturatedNoise` fit. They were on the page only because fixed candidates and
  thruster families were outside the rule.
- When he has accepted every variant, the ratings choose none. Say so, and do not read an order
  into ratings given 0.6 s apart.
- He answers questions the page never asked: the note on the cannon holds a question to us, and
  the note on the relays holds a decision. Read every note of an evening, not only those of the
  round.
- His page does not run by itself, and the app may refuse to start it without his word. Hand a
  round over only when the page answers, or tell him how to start it.
- A recorded round is three things: the byte copy of the ratings and the hash list (in git), and
  the kept files (ignored by git, on this machine only).

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
- A slot rule that asks for exactly three shots left a slot empty (the second one of
  `thruster_three`). That is right:
  do not fill a slot with a candidate that has the wrong number of shots. But a shot count is a
  heuristic: the check's own counter differed on 4 of 16 generated thruster files, and the page says
  "N shots" from the tool's count. Look at the picture, and say which counter a number is from.
- A text the tool writes about a pick must come from the data of the run: the page said "most
  typical candidate" of the fallback pick of `shield_absorb`, though `screen.json` flagged it
  `pressedNoiseFallback`, and the same sentence stood on two picks that were each the only eligible
  candidate (found by the second check). Both were corrected on 2026-11-18. That sentence, "no faults" in a
  report beside a click the page check lists, and a column "length s" that is the cut length are
  one kind of fault: a sentence written before the number was looked at.
- A speech check can throw out sound effects: Whisper wrote "BANG!" and "BOOM!" for three
  thruster files, which were thrown out as speech (none would have been picked for the shot count).
- `tools/dev/audition-check.mjs` writes screenshots into `screenshots/audition` of the repository
  on every run.
- The independent check is part of the round: the first one (`sound7-verify-report.json`) led to the
  five changes of the plan, the second one (`sound7-verify2-report.json`) to a text repair, which
  the orchestrator then checked by script and with one page check. A round can be changed after its check only while
  `assets/audio/ratings.json` is byte-identical to the record of the round before (then
  `round6-ratings.json`), and every republish of
  `events7` was gated: the 178 entries outside it equal in every field, and the ratings file hashed
  before and after.

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
