# Sound sources: a listening test of ways to make short events

This directory holds a comparison, not a new sound library. It answers one question: is there a
source of short events (a hit on the hull, a thruster pulse, the landing gear, a hit on the
shield) that the owner accepts? Over three rounds he approved long beds and rejected every short
event but one, from every source, and after round 3 he said the rendered sounds are "still too
artificial and boring" and asked for better local models. Asked which direction came nearest, he
answered that he liked none of it and can only describe it badly. So he is no longer asked to
describe: he gets candidates and accepts or rejects them.

`tools/audio/GENERATORS.md` lists everything that was looked at, with licences.

## What the owner approved (2026-11-15, "Ja, alle laden")

Exactly three sources, and nothing else without a new yes:

| key | source | licence | size |
|---|---|---|---|
| `moss` | MOSS-SoundEffect v2.0, `OpenMOSS-Team/MOSS-SoundEffect-v2.0` on Hugging Face, code `OpenMOSS/MOSS-TTS` | Apache-2.0 | 11.2 GB |
| `sa3` | Stable Audio 3 Small-SFX Base, `stabilityai/stable-audio-3-small-sfx-base` | Stability AI Community License | 4.8 GB |
| `oga` | recordings marked CC0 on OpenGameArt | CC0 per item | under 100 MB |

Stable Audio's licence allows testing freely; using it for a product needs registration and ends
above USD 1,000,000 of yearly revenue. Its output is therefore test material: it is labelled so
on the page and goes into nothing that ships until the owner has decided. The checkpoint taken is
the one before the makers' last training stage (the finished one is gated behind a login), so a
weak showing does not settle the model.

## Rules for every source

1. Scope: the three sources above. If one does not run after three different attempts, that is
   reported; nothing is substituted.
2. Code from the makers' own repository at a pinned commit, or from PyPI at a pinned version. No
   `trust_remote_code`. No install script piped into a shell.
3. Weights as safetensors where they exist. A pickle file is loaded only with
   `weights_only=True`; a pickled model object (the VAE of MOSS) only with `weights_only=True`
   and an explicit allow-list of the classes it needs. If that cannot be done, stop and report.
4. Every model has its own environment under `.venv-sound/<key>/` (made with `uv`). Nothing is
   installed into `.venv-audio` or into the environments under `.venv-voice`.
5. Disk: `df -h .` before every download and after every install. Stop at 200 GB free.
6. Every use of the graphics card goes through the lock:
   `<python> tools/voice/with_lock.py --wait 3600 -- <command>`.
7. A package that reports usage to its makers has that switched off; models run with the
   Hugging Face hub offline once their files are on disk.
8. A recording is taken only when its own page says CC0; the page, the author and the licence
   line are recorded per file, through `tools/audio/fetch.py` and `assets/audio/downloads.json`
   like every other download. Each archive goes into its own directory; nothing in it is run.

## How a source is run

    .venv-sound/moss/venv/Scripts/python.exe tools/sound/adapters/moss.py [--family hull] [--seeds 11,12]
    .venv-sound/sa3/Scripts/python.exe tools/sound/adapters/sa3.py [--family hull] [--seeds 11,12]

(The two environments differ in where their interpreter lies. Every run that uses the graphics
card goes through `tools/voice/with_lock.py`.)

It makes every prompt of `prompts.json` with every seed and writes, under
`assets/audio/gen/<key>/` (ignored by git):

- `raw/<prompt>__s<seed>.wav`: exactly what the model returned (its sample rate, its channels);
- `gen.json`: per file the text given, the seed, the settings, the time it took.

The recordings have no adapter: cut excerpts go to `assets/audio/gen/oga/raw/<family>__<name>.wav`
with the same kind of record (the source file, the cut in seconds, the item's page and licence).

## How candidates are chosen

`screen.py` (run with the environment of the sound library, which it only reads) cuts the event
out of each raw file, throws out what is broken, and among what is left picks for variety, so that
the candidates of a family differ from each other. It does NOT rank by the measures of round 2
(share of energy per band, attack): the direction samples of round 3 met those and he still
disliked them. A plain run, `screen.py` and then `publish.py`, gives the published picks: the hand
skips below are read from a committed file.

**What is thrown out** (reason in `screen.json`, per file): silent; clipped; speech or music (the
speech recogniser and CLAP say so); several events where one was asked for; cut off; shorter than
80 ms.

- *Clipped* means a flat top: three or more equal samples in a row at the extreme (the highest or
  the lowest value) of a channel. A file whose float samples go beyond full scale without a flat
  top (Stable Audio before its makers' clamp) is not clipped; a file clamped at 1.0 is. The rule
  does not see soft saturation: the decoder of MOSS ends in a tanh, so its loud output is pressed
  against 1.0 without ever holding it (49 of its 72 raw files peak above 0.99, none has a flat
  top). That is inside the model and stays in its candidates; RESULTS.md gives the numbers.
- *Cut off* means the event is still within 20 dB of its maximum in the last 50 ms, and it holds
  for two places: the end of the raw file, and the end of the cut where the family's longest length
  (hull 2.5 s, thruster 1.2 s, gear 3.8 s, shield 2.5 s) stops an event that has not ended by
  itself. Both use the same 20 dB and the same 50 ms against the same maximum (the loudest 4 ms of
  the file). `screen.json` says which (`cutOffAt`: `end-of-file` or `family-length`) and, for the
  cap, how far under the maximum the event was (`lastDbBelowMaxAtCap`). An event that has died away
  20 dB or more by the cap is kept and only marked as capped. Why two measures of the same event
  can differ: gear_2 seed 16 of MOSS is a steady sound at about -15 dB for 3.6 s with a latch peak
  at 3.67 s. At the cap of 3.8 s its last 50 ms are 11.0 dB under the loudest 4 ms (the rule), 7.2 dB
  under the loudest 50 ms, and 0.1 to 0.5 dB under the loudest 100 ms when a 100 ms window ends at
  3.77 s, before the fade. The rule's measure is the first.

**Hand skips.** A pick can be skipped by hand for a plain fault that the rules do not see. Found in
its spectrogram: steady noise instead of an event, a tone over everything, a second event or
silence inside the cut (in a family that asks for one event; gear may hold several). Found in its
record: almost no energy above 60 Hz (`energyAbove60Hz` under 10 %, see below), because such a
pick plays as silence on most loudspeakers. Never for how it sounds. The skipped candidate stays in the pool (it counts
for the normalisation and the centre), is never picked, and the next nearest takes its place. The
list is `tools/sound/skips.json` (candidate as `source/name`, reason), committed, and read by
default; `--skip SOURCE/NAME=REASON` adds to it and `--skips FILE` reads another file. The skips in
use are written to `screen.json`.

**Level.** Every copy is set so that all candidates of a family leave the audition page equally
loud in its Stereo stage, whatever their number of channels. What the page does was measured: it
plays a one-channel file on both of its channels and a two-channel file as it is, and its chain
takes 3 dB off everything. Summed over both output channels, a one-channel file therefore leaves
the page with the energy of the file and a two-channel file with 3.1 dB less than the file, so a
two-channel file of the same BS.1770 loudness as a one-channel file leaves the page 3.0 dB lower
(`tools/dev/audition-level.mjs`, column `file>page dB`: one channel -0.09 to +0.33 dB, median
-0.07, for the six one-channel files of the published sixteen; two channels -3.10 dB for all
ten). The family target in `prompts.json` stays the loudness of a one-channel file, as in rounds 3
and 4. A copy is set to the family target plus 10*log10(2) = 3.01 dB measured as BS.1770
integrated over two channels, a one-channel file counted on both (its own loudness plus 3.01 dB,
so one-channel files stay exactly where the family target put them, two-channel files come up by
3.01 dB). That figure, called the page level (`lufsPageTarget`, "page LUFS" in RESULTS.md), is a
way of counting, not what a meter at the output reads: after the chain's 3 dB the output of the
page, summed over both channels, sits at the family target itself for every candidate (measured
dry: -34.1 hull and thruster, -35.1 gear, -24.1 shield; one 0.41 s thruster file -33.7). No
downmix. The
measure is taken after all processing (resampling, end fade and the silence after it, ramp in,
mean removal), the gain is corrected and the measure taken again until it is within 0.05 LU of the
target, or the true-peak ceiling (-1.1 dBFS) stops it. `screen.json` records per copy the family
target (`lufsTarget`), the page target (`lufsPageTarget`), the level reached by the own-channels
measure (`lufsReached`) and by the page measure (`lufsReachedPage`), the gain (`gainDb`), the
error and whether the ceiling stopped it (`limitedByPeak`).

**A measure the script does not act on.** `energyAbove60Hz` is the share of the event's energy
above 60 Hz (over all channels). A candidate with almost nothing above 60 Hz plays as silence on
most loudspeakers; the page shows the share in the intent line and in the checks, and a hint below
10 %. `screen.py` throws nothing out for it, but a pick under 10 % is skipped by hand (see "Hand
skips"; two of the four skips of 2026-11-16 are of this kind).

**Ids.** A published id names the candidate: `src_<family number>_<family>_<slot>_<source>_<tag>`,
the tag being prompt number and seed for a generated file (`p2s16`) and a short slug of the
excerpt's name for a recording, so that an id never comes to mean another sound when a pick is
replaced. `publish.py` removes every file of the category from `render/source` that is not part of
the new set, because the manifest is assembled from whatever lies there; it leaves the order of
`manifest.json` as `tools/audio/build.py` makes it. The page lists the categories in the order of
`manifest.categories`, and `tools/dev/audition-check.mjs` finds its first rows that way.

On the page every candidate gets the same treatment: the level above, no step at either end, the
cabin not baked in but only lightly added (`dry` false), a fixed place ahead where it has one
channel. `publish.py` writes them as the category "Klangquellen (Runde 4)".

Nobody can hear here. Whether a candidate is right is the owner's click.

## Round 5

Round 5 makes the event sounds the game needs from what the owner accepted in round 4, from
`tools/sound/prompts5.json` (its "note" says what each family is for). It runs beside round 4 and
changes nothing of it: the raw candidates lie under `assets/audio/gen/r5/<source>/raw` with
`assets/audio/gen/r5/<source>/gen.json`, the screening output (`screen.json`, `_listen/`) under
`assets/audio/gen/r5/`, the published files under `assets/audio/render/events5/` (category `events5`,
"Ereignisklänge (Runde 5)", listed first), ids `ev5_<family number>_<family>_<slot>_<source>_<tag>`.
A plain `screen.py` or `publish.py` without arguments still means round 4; run them for round 5 only
with the options below.

What the prompts file adds, per family (a key that is missing falls back to round 4): `maxS` (the longest
cut), `oneEvent` (a second event is a fault; `false` also cuts from the first sound to the last, as for the
gear), `lufs`, `picks` (the sources of the slots on the page, in order: the first pick of a source is its most
typical candidate, each further pick of that source the candidate farthest from the picks already made in the
family), `minAbove60Hz` (a kept candidate under this share of energy above 60 Hz stays in the pool for the
statistics but is not picked; `screen.json` says so per file as `notPickedLowShare`), `seeds` (the family's own),
`fromRound4` (see below). `skips5.json` is read for `prompts5.json` instead of `skips.json`.

The whole run, in order (each line can be copied; the generating step goes through the lock):

1. Bring the unheard, kept candidates of round 4 into the pool (writes only `gen/r5/<source>/gen.json`; copies and moves nothing; safe to run twice; before or after the generation, as the adapters keep these items):

       .venv-audio/Scripts/python.exe tools/sound/from_round4.py

2. Look at the jobs without making anything (`--list-jobs` loads no model):

       .venv-sound/moss/venv/Scripts/python.exe tools/sound/adapters/moss.py --prompts-file tools/sound/prompts5.json --out-root assets/audio/gen/r5 --list-jobs

3. Make the candidates, MOSS (90 files: 15 prompts x 6 seeds; the valve prompt takes seeds 21 to 26):

       .venv-audio/Scripts/python.exe tools/voice/with_lock.py --wait 3600 -- .venv-sound/moss/venv/Scripts/python.exe tools/sound/adapters/moss.py --prompts-file tools/sound/prompts5.json --out-root assets/audio/gen/r5

4. There is no Stable Audio step in round 5: the owner decided on MOSS only (`prompts5.json`, field `decision`). `screen.py` takes every `gen.json` under its root and does not read the `sources` key of the prompts file, so the root of a MOSS-only round must hold MOSS files only (`assets/audio/gen/r5` does).

5. Screen and choose (Whisper and CLAP on the processor):

       .venv-audio/Scripts/python.exe tools/sound/screen.py --prompts-file tools/sound/prompts5.json --root assets/audio/gen/r5 --device cpu

6. Look at the spectrograms of the picks; skip a pick for a plain fault with `--skip SOURCE/NAME=REASON` or by an entry in `skips5.json`, and run step 5 again.

7. Publish to the audition page (only `render/events5` is written and pruned; then the manifest is assembled and validated):

       .venv-audio/Scripts/python.exe tools/sound/publish.py --prompts-file tools/sound/prompts5.json --root assets/audio/gen/r5

8. The manifest alone, if it has to be assembled again (`events5` comes first, the existing entries keep their hashes):

       .venv-audio/Scripts/python.exe tools/audio/build.py --manifest-only

To take the round off the page: `publish.py --prompts-file tools/sound/prompts5.json --root assets/audio/gen/r5 --remove`.

`fromRound4` of a family names the round-4 prompt or prompts (`"prompt"`), optionally `"sources"` and
`"exclude"` (as `source/name`). A candidate is taken when it is kept in `assets/audio/gen/screen.json`, was not
published in round 4 (so the owner has not heard it) and is not excluded. Its item in the round-5 `gen.json`
points at the raw file where it lies, carries `fromRound4: true` and has the round-5 family. A hand skip it had
in round 4 comes along as `round4Skip` and is honoured (it is the same file with the same cut). Its id tag starts
with `r4` (`ev5_3_thruster_valve_1_moss_r4p1s12`), so that it is never taken for a file of the same prompt number
made in round 5, and its intent line on the page says that the file was made in round 4 and not heard then.
A family's intent line also says whether it is `proven` (rests on a prompt the owner accepted) or a first try. The round named there is the family's `provenRound` (4 where the key is missing, which is what the proven families of `prompts5.json` rest on; `prompts6.json` sets 5 for `hull_light`).
A further pick of a source is named "zweite Auswahl" / "second pick", then "dritte Auswahl" / "third pick".

Stable Audio output stays test material under the Stability AI Community License: the page keeps its "test
only" label and licence note. Nobody can hear here; whether a candidate is right is the owner's click.

## Round 6

Round 6 tries the families the owner rejected in round 5 again, MOSS only, from `tools/sound/prompts6.json` (its "note"
says what each family answers). Files: raw candidates `assets/audio/gen/r6/moss/raw` with `gen.json`; screening output
`assets/audio/gen/r6/screen.json` and `_listen/`; published files `assets/audio/render/events6/` (category `events6`,
"Ereignisklänge (Runde 6)", listed first, `events5` second); ids `ev6_<family number>_<family>_<slot>_moss_<tag>`; hand
skips `tools/sound/skips6.json` (read for `prompts6.json` as `skips5.json` is for `prompts5.json`). The run is the run of
round 5 with these names; there is no `from_round4.py` step and no Stable Audio step.

One new optional setting of a family, `"notSaturatedNoise": {"loud50Db": X, "above2kHz": Y}`. A kept candidate stays in the
pool (it counts for the normalisation and the centre, like a hand skip) but is not picked when both hold: the loudest 50 ms
of its raw cut (root mean square, dB re full scale, before any gain) are above X, and the share of its energy above 2 kHz
in its loud frames is at or above Y (short-time spectrum of 2048 samples, hop 512, Hann window; loud frames are those
within 10 dB of the loudest frame; the share is the energy above 2 kHz summed over the loud frames divided by their whole
energy). `screen.json` records `loud50Db` and `above2kHzLoud` for every kept file of such a family, and marks an excluded one
with `notPickedSaturatedNoise: true`. If a family has fewer candidates that can be picked than slots, the remaining slots
are filled from the excluded ones, the lowest `loud50Db` first; the notes of the family say so and the pick carries
`pressedNoiseFallback: true`. A family without the setting behaves as before (checked on a copy of round 5: same picks).
It is a working rule that rests on four rejected and a few accepted files, not a law.

Commands (from the repository root):

1. Screen and choose (Whisper and CLAP on the processor):

       .venv-audio/Scripts/python.exe tools/sound/screen.py --prompts-file tools/sound/prompts6.json --root assets/audio/gen/r6 --device cpu

2. Look at the picks for plain faults (README "Hand skips"), put each skip into `skips6.json`, run step 1 again.

3. Publish (only `render/events6` is written and pruned; then the manifest is assembled and validated):

       .venv-audio/Scripts/python.exe tools/sound/publish.py --prompts-file tools/sound/prompts6.json --root assets/audio/gen/r6

4. Take the round off the page: the same command with `--remove`.

The tests: `.venv-audio/Scripts/python.exe tools/sound/tests/test_screen.py`. The results of the round are in `tools/sound/RESULTS6.md`.

## Round 7

Round 7 answers what the owner rated on 2026-11-18 (round 6: 4 fit, 2 close, 8 wrong), MOSS only, from `tools/sound/prompts7.json` (its "note"
says what each family is for). Two families are still open, the thruster pulse and the shield hit. The round is built around the two
candidates he called close: their raw files are processed as he asked by `tools/sound/derive.py` (fixed candidates), and a few new files
are generated beside them. Files: raw candidates `assets/audio/gen/r7/moss/raw`, derived candidates `assets/audio/gen/r7/derived/raw` (each
with its `gen.json`), screening output `assets/audio/gen/r7/screen.json` and `_listen/`, published files `assets/audio/render/events7/`
(category `events7`, added to `tools/audio/sounds.json` by the select step), ids `ev7_<family number>_<family>_<slot>_<source>_<tag>`
(`ev7_1_thruster_room_1_derived_r6p3s11a`, `ev7_2_thruster_three_1_moss_p1s24`), hand skips `tools/sound/skips7.json` (one skip: `moss/shield_snap_1__s22`,
a click in the tail found by the page check). The page holds 11 candidates (thruster_room 4, thruster_three 1, thruster_hall 1, shield_brighter 3,
shield_swallow 1, shield_absorb none, shield_snap 1); the plan was changed after the first check of the round, see "After the first check" in
`tools/sound/RESULTS7.md`. `assets/audio/gen` is ignored by git.

The whole run, in order (each line can be copied; only the generating step uses the graphics card and goes through the lock):

1. The derived candidates (writes only `assets/audio/gen/r7/derived`; checks the sha256 of every raw file first; safe to run twice, the samples are the same):

       .venv-audio/Scripts/python.exe tools/sound/derive.py --prompts-file tools/sound/prompts7.json --out-root assets/audio/gen/r7

2. The jobs of the adapter without making anything (40: 5 prompts x seeds 21 to 28, nothing for the two fixed families):

       .venv-sound/moss/venv/Scripts/python.exe tools/sound/adapters/moss.py --prompts-file tools/sound/prompts7.json --out-root assets/audio/gen/r7 --list-jobs

3. The generated candidates, MOSS:

       .venv-audio/Scripts/python.exe tools/voice/with_lock.py --wait 3600 -- .venv-sound/moss/venv/Scripts/python.exe tools/sound/adapters/moss.py --prompts-file tools/sound/prompts7.json --out-root assets/audio/gen/r7

4. Screen and choose (Whisper and CLAP on the processor; stops with a non-zero exit code if a fixed item is missing, stale or silent):

       .venv-audio/Scripts/python.exe tools/sound/screen.py --prompts-file tools/sound/prompts7.json --root assets/audio/gen/r7 --device cpu

5. Publish (only `render/events7` is written and pruned; the category has to be in `tools/audio/sounds.json`; the manifest is assembled and validated):

       .venv-audio/Scripts/python.exe tools/sound/publish.py --prompts-file tools/sound/prompts7.json --root assets/audio/gen/r7

6. Take the round off the page: the same command with `--remove`. The tests: `.venv-audio/Scripts/python.exe tools/sound/tests/test_screen.py`.

New plan keys. `"sources"` lists `"derived"`: only then does `screen.py` read `<root>/derived/gen.json` and record the round-7 measures
(`loud50Db` and `above2kHzLoud` of every kept file and chosen candidate, `shots` for every file of a family whose id starts with
`thruster`); for the prompts files of rounds 4 to 6 nothing changes (checked: the screen.json of round 6, made again on a copy, differs in 106 values, all of them paths: 92 "file" keys (the listening copies and the raw
files of the file list) and 14 "raw" keys of the chosen entries). `"derived"` of a family is a list of items `{id, tag, de, en, from {round, candidate, verdict, raw, sha256},
process [...]}`; the operations are `room {rt60S, wetDb, channels, seed}`, `pitch {semitones}`, `shelf {hz, gainDb}` and `append {fromS, toS}` (see the head of
`derive.py`; a room and a shelf scale the output to a peak of 0.999 when it would be above, and say by how much). `append` adds a copy of the samples
from `fromS` to `toS` of the signal, as it is at that point of the process list, to its end (no fade, no gain); the text of the candidate says that the appended part is a copy.
It refuses the item (message `REFUSED ...`, the other items go on, exit code 1, as for a wrong sha256) unless the last 10 ms before the splice, the first 10 ms of the copy and the last
10 ms of the copy are each at least 50 dB under the peak of the signal, and it records the three levels, the lengths, the splice time and the largest sample step within 1 ms of the splice
in `numbers.operations` of the item's record; thruster_room_4 of the plan is `append {0.0, 1.0}` followed by a room, so that its file holds three shots, the third a copy of the first.
`"pressedNoiseFallback": false` of a family with `notSaturatedNoise` (default true, which is what rounds 5 and 6 do): a slot that has only pressed-noise candidates left stays empty
instead of being filled from them, and the notes of the family in `screen.json` say how many kept candidates there were and that they are over both numbers; shield_absorb of round 7 has it.
`publish.py` never gives a pick that carries `pressedNoiseFallback` the sentence "Chosen as the most typical candidate of its source in this family.": it says it is a fallback, with the pick's two numbers
and the family's two limits. For a screen.json that lists "derived" among its sources, a first pick whose source had exactly one candidate left that could be picked is not called "the most typical candidate" either: the text says it was the only eligible one and counts what ruled the others out (shot count, share above 60 Hz, pressed noise, hand skip); nothing was weighed. `"minAbove60Hz"` is a family key of rounds 5 and 6; round 7 sets it for the two generated thruster families too. `"fixed": true` makes every
item of `"derived"` a candidate, in the order of the list (slot = position, tag = the item's tag); no pick rule, skip or exclusion applies, the fault
rules are only recorded as `faults` (on the file and on the chosen entry) and the fixed files do not enter the statistics of another family.
`"shots": N` of a generated family picks only kept candidates with exactly N separate shots (a shot is a rise of the 10 ms level above -12 dB
under the loudest window of the cut after at least 80 ms under -20 dB, or since the start; see `count_shots`); the others stay in the pool with
`notPickedShots`, and a slot that cannot be filled stays empty with a note in `screen.json`. `"history"` is one sentence of the plan that
replaces, on the page, the sentence that a family is a first try; the intent line of a derived candidate says from which candidate of which round
(and what the owner called it) it was made and what was done, with the numbers, and that of every thruster candidate ends with the measured number of shots.
