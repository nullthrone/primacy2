# Sound sources, round 7: the thruster pulse and the shield hit, built around the two candidates he called close

Written 2026-11-18 by the select-and-publish step. NOBODY LISTENED: every statement below is a measurement or a reading of a
waveform, a level curve and a spectrum, and nothing says how any sound sounds. Whether a candidate is right is the owner's click
on the audition page, category "Ereignisklänge (Runde 7)", which is listed first. Round 6 follows unchanged.

Two states are described. Everything up to "After the first check" is the first selection (ten candidates, published before a check
of the page and the files); where a sentence there was wrong or has been overtaken, it is corrected or marked. The section "After the
first check" is the state that is on the page now: 11 candidates, the five changes of the plan, the new numbers, and what nobody
could verify. The owner has rated nothing of this round.

## What was asked, and why

The owner rated round 6 on 2026-11-18 between 14:28 and 14:40 UTC (`assets/audio/rounds/round6.json`, `round6-ratings.json`; verdicts
"fits" = Passt, "close" = Nah dran, "wrong" = Falsch). Of the 14 candidates 4 fit, 2 are close and 8 are wrong. No note of this round
says "übersteuert".

- Fit: ev6_1_hull_light_1_moss_p1s22 (his note: "ist ok, schauen wir mal wie es weiterhin wird"), ev6_4_fold_jump_1_moss_p1s14,
  ev6_5_fold_exit_2_moss_p1s13, ev6_5_fold_exit_3_moss_p1s16.
- Close, the thruster, ev6_2_thruster_mighty_2_moss_p3s11: "Es waren nur zwei statt Drei Schüsse wie im Prompt gewünscht. Grundsätzlich
  gut. Wenn wir noch ein bisschen Raumklang reinbringen, sind wir langsam am Ziel"
- Close, the shield, ev6_3_shield_tight_2_moss_p2s11: "Es wird besser, ich würde den Ton vielleicht leicht heller machen als bisher,
  aber die Idee, dass der Schild ein Projektil oder einen Energiestrahl \"verschluckt\", und so klingt es hier ein wenig, ist die richtige
  Richtung"
- Wrong, all without a note: ev6_1_hull_light_2, ev6_2_thruster_mighty_1 and _3, ev6_3_shield_tight_1 and _3, ev6_4_fold_jump_2 and _3,
  ev6_5_fold_exit_1.

The same day he rated 41 other sounds and voice samples (35 fit, 4 close, 2 wrong). The two wrong ones are g_thruster_pulse_a and
g_thruster_pulse_b, library copies of valve pulses he had accepted as candidates in rounds 4 and 5; g_thruster_pulse_c fits. So two
families are still open, the thruster pulse and the shield hit (the hull hits, the gear and the two folds are accepted). Round 7
(`tools/sound/prompts7.json`, its "note") is built around the two close candidates: their raw files are processed as he asked
("derived", fixed candidates that are always on the page, no pick rule, hand skip or exclusion applies), and a few files are generated
beside them. MOSS only, as he decided on 2026-11-16 ("Lass uns mit MOSS weiter machen, ohne Stable Audio. Ich denke damit kommen wir auch
ans Ziel."). The page text of every thruster candidate says how many separate shots were measured in the file, because his remark was that
text and file did not match.

## What was made

### Derived (first selection: five fixed candidates; two more were added after the check, see below; `tools/sound/derive.py`, from the raw files of round 6, sha256 checked first)

Thruster, from `assets/audio/gen/r6/moss/raw/thruster_mighty_3__s11.wav` (2.0 s, two shots 1.0 s apart; peak 0.99955; 65.1 % of the
energy under 250 Hz; share above 2 kHz 0.0572; centroid 492.9 Hz). "Raumklang" can mean reverberation or width, so both are offered. A room
is a synthetic impulse response (seed 7) folded into the sound; it is scaled down when the result would pass the peak limit 0.999, and the
raw peak was already 0.99955, so all three were scaled.

| id | room | impulse response | length of result | output gain | channels | under 250 Hz | above 2 kHz | centroid |
|---|---|---|---|---|---|---|---|---|
| ev7_1_thruster_room_1_derived_r6p3s11a | decay 0.9 s, wet -9 dB against dry (reached -9.0) | 1.35 s | 3.35 s | -2.11 dB | 1 | 67.4 % | 0.0513 | 460.3 Hz |
| ev7_1_thruster_room_2_derived_r6p3s11b | decay 1.4 s, wet -4 dB (reached -4.0) | 2.10 s | 4.10 s | -3.55 dB | 1 | 69.0 % | 0.0429 | 415.2 Hz |
| ev7_1_thruster_room_3_derived_r6p3s11c | decay 1.2 s, wet -6 dB (reached -6.0), wide | 1.80 s | 3.80 s | -2.83 dB | 2 | 67.4 % | 0.0482 | 442.8 Hz |

The page already sends every sound through its cabin impulse response (0.5 s long); the baked rooms are 1.35 to 2.1 s long. Shield, from
`assets/audio/gen/r6/moss/raw/shield_tight_2__s11.wav` (2.0 s; peak 0.998; 94.6 % of the energy under 250 Hz; share above 2 kHz 0.0147;
centroid 160.8 Hz):

| id | operation | length of result | under 250 Hz | above 2 kHz | centroid |
|---|---|---|---|---|---|
| ev7_4_shield_brighter_1_derived_r6p2s11a | tuned 3 semitones higher by resampling (ratio 1169/983); this also made it shorter | 1.68 s | 94.3 % | 0.0168 | 191.3 Hz |
| ev7_4_shield_brighter_2_derived_r6p2s11b | high shelf at 300 Hz, +8 dB; scaled by -3.60 dB to stay under peak 0.999 | 2.00 s | 74.8 % | 0.0722 | 531.1 Hz |

The raw file of the close thruster holds two shots (measured: 2 shots, also in the three room versions). The raw file of round 6 was 2.0 s
long, so the third shot did not fit into the file; the cut was not the cause.

### Generated (MOSS-SoundEffect, 40 files, `docs/reports/2026-11-18/sound7-generate-report.json`)

Five prompts x seeds 21 to 28, through the lock, about 17 s per file (the first 27 s with the model load): thruster_three and
thruster_hall 4.0 s asked and 8 files each, shield_swallow, shield_absorb and shield_snap 2.0 s asked and 8 files each. thruster_three is
the prompt of the close candidate, unchanged ("Large-caliber machine cannon fires three slow heavy shots, each a chest-thumping boom with a
metallic clank, dry, close microphone") asked for 4 s; thruster_hall puts the same three shots into "a large steel hangar". The generation
report found shield_snap_1 seed 28 not bit-identical when made again (root mean square of the difference 2.3e-5 against a signal of
0.0176), thruster_three_1 seed 21 identical.

## What was thrown out (first selection, of 45 files: 5 derived, 40 generated; after the check 47 files, 36 kept, the same 11 thrown out)

`screen.py --prompts-file tools/sound/prompts7.json --root assets/audio/gen/r7 --device cpu` (Whisper and CLAP on the processor; the
hand-skip file `skips7.json` was empty then; it holds one skip now, see below). 34 kept, 11 thrown out (counts from `screen.json`, by script): 7 cut off, 3 speech, 1
several events; none silent, clipped or too short. The counts of the table below are those of the first selection; the rows of
the fixed families and the picked column changed after the check (the table in "After the first check" is the current one).

| family | files | kept | thrown out | not picked | picked |
|---|---|---|---|---|---|
| thruster_room (fixed) | 3 | 3 | 0 | - | 3 |
| thruster_three | 8 | 7 | 1 speech (s26) | 6 for shots (not exactly 3) | 1 of 2 slots |
| thruster_hall | 8 | 6 | 2 speech (s25, s26) | 4 for shots | 1 of 1 |
| shield_brighter (fixed) | 2 | 2 | 0 | - | 2 |
| shield_swallow | 8 | 7 | 1 cut off (s21) | 1 as pressed noise (s25) | 1 of 1 |
| shield_absorb | 8 | 2 | 6 cut off (s21 to s26) | 2 as pressed noise (s27, s28) | 1 of 1, as a fallback |
| shield_snap | 8 | 7 | 1 several events (s21) | 0 | 1 of 1 |

- The three "speech" files are thruster files: Whisper wrote "BANG! BANG! BANG! BANG!" (thruster_hall s25 and s26) and "BOOM! BOOM! BOOM!
  BOOM!" (thruster_three s26) and the speech check marked them `speech`. All three measure four shots, so none would have been picked for the three-shot
  rule anyway. The speech rule found a transcript of shots; nothing was changed.
- The six cut-off shield_absorb files and shield_swallow s21 are still within 20 dB of the maximum in their last 50 ms: absorb s22 to s25 at
  the 1.5 s cap (14.6, 15.7, 2.5 and 8.9 dB under), absorb s21 and s26 at the end of the file (8.6 and 16.0 dB under), swallow s21 at the
  cap (13.2 dB under). Only two of eight absorb files remain, both pressed noise by the rule of the
  plan (`notSaturatedNoise` -9.5 dBFS and 0.03). The family therefore has no pick that is not pressed noise; `screen.py` filled the slot
  from the excluded ones, lowest level first (s27, -9.36 dBFS, share 0.5933), as the README says, and marked it `pressedNoiseFallback`.
- shield_snap s21 holds several events where one was asked for.

### Shots of every thruster file (`count_shots` of screen.py, from `screen.json`; the counter is a heuristic, see the sentence after the table)

| family | s21 | s22 | s23 | s24 | s25 | s26 | s27 | s28 |
|---|---|---|---|---|---|---|---|---|
| thruster_three | 2 | 1 | 2 | **3** | 4 | 4 (thrown out) | 2 | 4 |
| thruster_hall | **3** | 4 | 2 | **3** | 4 (thrown out) | 4 (thrown out) | 2 | 4 |

Of the 16 generated thruster files 3 have exactly three shots by `count_shots` (thruster_three s24, thruster_hall s21 and s24); the
counts rest on that one counter, a rise of the 10 ms level, and on nothing else. The check of the round used a counter of its own
(20 ms windows, a rise of 10 dB) and agreed on some files and not on others: it also gave three for thruster_three s21 and s22 (count_shots: 2 and 1),
five for thruster_three s28 (count_shots: 4) and four for thruster_hall s27 (count_shots: 2); those four values are the check's, not
measured here. So "exactly three" is what `count_shots` says and the file may be counted differently by another method.
First selection: picked thruster_three s24
and thruster_hall s24 (the most typical of the two that qualify; s21 stayed in the pool, there is one slot; after the check s24 of the
hangar is under the 40 % floor and s21 is picked, see below). The second slot of
thruster_three stays empty, as the plan says: "1 of 7 kept candidates have exactly 3 separate shots" by `count_shots` (a slot is not filled with a
candidate that has the wrong number of shots). The waveforms of both picks (own pictures from the listening copies) show three blocks at
0.0, 1.05 and 2.15 s (thruster_three) and 0.0, 1.15 and 2.25 s (thruster_hall), the level falling 25 to 30 dB between them. The three
fixed room candidates show two shots at 0.0 and 1.0 s.

## Hand skips (the first look found none; one was added after the page check)

Every pick of the first selection was looked at as waveform, 50 ms level and spectrogram (pictures made from the listening copies; scratch folder
`r7-select/pics`) for the faults of the README: steady noise instead of an event, a tone over everything, a second event or silence inside the
cut (in a family that asks for one event), almost no energy above 60 Hz. Numbers by script (listening copies):

| id | time within 6 dB of loudest (of length) | strongest 50 Hz band | above 60 Hz | silence inside | note |
|---|---|---|---|---|---|
| thruster_room_1 / _2 / _3 | 0.60 s of 2.01 / 2.45 / 2.25 | 20.1 % (0 Hz) / 20.8 % (150 Hz) / 20.7 % | 76.8 / 80.9 / 78.8 % | none | two shots; fixed |
| thruster_three_1 s24 | 1.50 s of 3.80 | 48.0 % (0 to 50 Hz) | 49.6 % | none | three shots |
| thruster_hall_1 s24 | 1.05 s of 3.81 | 70.2 % (0 to 50 Hz) | 29.2 % | none | three shots; the 10 % rule is met |
| shield_brighter_1 / _2 | 0.20 s of 0.77 / 0.91 | 42.3 % (50 Hz) / 29.3 % | 62.0 / 61.2 % | none | fixed |
| shield_swallow_1 s22 | 0.55 s of 1.41 (39 %) | 10.4 % (16000 Hz) | 98.5 % | none | |
| shield_absorb_1 s27 | 0.55 s of 1.17 (47 %) | 14.3 % (0 Hz) | 84.2 % | none | level rises about 30 dB over 0.5 s, then falls away at 0.9 s |
| shield_snap_1 s22 | 0.20 s of 0.78 | 9.2 % (16000 Hz) | 100.0 % | none | |

None is steady (the steady-hum skips of round 6 were within 6 dB of the maximum for 2.45 to 2.8 s of 3.8 s, 65 to 74 %; the largest
share here is shield_absorb at 47 %). The fixed candidates are never skipped; `screen.py` recorded `faults: []` for all five.

Two things found that are not skips. A line at 16 kHz: the strongest bin of shield_swallow_1 s22, shield_absorb_1 s27 and shield_snap_1 s22
lies at 16000 Hz (3.1 to 5.3 % of the energy in the single bin, 12.7 to 16.7 % in 15.5 to 16.5 kHz). Measured as the power in 15995 to
16005 Hz against the mean per-bin power in 15.5 to 15.9 and 16.1 to 16.5 kHz, by a scratch script of the select step (values in dB,
approximate: the check of the round measured the same line with its own script and the two differ by up to 4 dB): thruster_room 23.2 /
23.4 / 23.4 dB, thruster_three 20.7, thruster_hall 18.8, shield_brighter 4.5 and 10.5, swallow 22.4, absorb 30.8, snap 30.1. The same line is in every MOSS file measured of
round 6, in the accepted ones as well (select step: fold_jump_1 fits 27.6 dB, fold_exit_2 fits 18.3, hull_light_1 fits 12.9, fold_exit_3 fits 8.0;
the check: 27.5, 22.3, 12.5 and 11.1) and in
the two close ones (select step: thruster 22.6, shield 10.4; the check: 22.9 and 10.0; the check also gave swallow 23.0, absorb 30.8, snap 30.0). It is not a skip: he has accepted the same line. Absorb and snap are above the largest value
of an accepted file (27.6 by the select step's script, 27.5 by the check's) by about 3 dB in both measures. And a click: the page check (below) found a click of size 0.010 to 0.019 at about 0.59 s in
shield_snap_1 s22, in Stereo, Mono and Headphones (in the check's own run 0.010 at 0.586 s in Headphones, 0.597 s in the select step's run: the time differs from run to run). The first look called it listed, not skipped; after the check it was skipped (see "After the first check").
The sentence "faults: []" above is about the five fixed candidates and the rules of the plan; it does not say that the files have no click.

### Held against what he has rated (no skip)

`tools/sound/compare.py --screen assets/audio/gen/r7/screen.json` and `--place-against docs/reports/2026-11-18/round6-ratings-analysis.json`.
The tick of round 6 was skipped because it matched two shields he had rated wrong on all four numbers: under 250 Hz (3.8 % there), above
4 kHz (57 %), the share above 2 kHz in loud frames (0.73) and the loudest 50 ms (-22.6 dBFS, against -22.7 and -22.1). The test used here
for each generated pick, against every candidate rated wrong in the same event: under 250 Hz, above 4 kHz and the share above 2 kHz each
within 0.10 and the loudest 50 ms within 3 dB. Result by script: no generated pick matches two; matches at all: thruster_three s24 and
thruster_hall s24 one each (thruster_mighty_1, rated wrong: differences 0.087 / 0.065 under 250 Hz, 1.07 / 0.44 dB loudest 50 ms); the
shield picks none. Two shield picks come close, and the number that separates them is the level, not the shape:

| generated pick | under 250 Hz | above 4 kHz | above 2 kHz (loud) | loud 50 ms | rated wrong, same shape |
|---|---|---|---|---|---|
| shield_snap_1 s22 | 0.2 % | 79.2 % | 0.951 | -12.60 | OGA spark (0.1 %, 86 %, 0.961, -22.69) and shield_bright_2 s11 (3.8 %, 72.7 %, 0.865, -22.07): shape within 0.07 and 0.09, loudest 50 ms about 10 dB higher |
| shield_swallow_1 s22 | 10.9 % | 64.5 % | 0.774 | -12.81 | shield_bright_2 s11: shape within 0.08, level 9.3 dB higher; shield_tight_3 s16 (29.1 %, 44.0 %, 0.759, -12.77): level within 0.04 dB, shape off by 0.18 to 0.21 |

So both are bright, noise-like shields of the kind he turned down in rounds 4 to 6, and the owner may well do so again. The reason they were
kept: the level differs from the quiet ones by 10 dB (the loudest 50 ms is measured on the raw cut, before any gain, so it describes how
pressed the model's output is, not how loud it plays), and the prompt asked for a brighter sound after he said "heller". A skip can be put
into `skips7.json` and `screen.py` and `publish.py` run again; most replacements in the pool (s23 to s26 of snap, s23, s24 and s26 of
swallow) are of the same kind, snap s27 and s28 are 0.10 and 0.13 s long (a test run with both skipped picked swallow s23 and snap s24, under 250 Hz 4.2 % and 0.0 %; that run was overwritten by a clean one). All five
fixed candidates and every pick are in ranges of the analysis that hold fits only for the dark-tone shields: both shield fits and both close
shields have 94.6 to 98.7 % of their energy under 250 Hz and under 1 % above 4 kHz; no MOSS shield has ever fit.

## The picks (first selection; the current ones are in "After the first check")

10 of the 11 planned slots are filled (the second slot of thruster_three is empty, see above). All one channel except thruster_room_3.
The column "length s" is the length of the cut (`screen.json` cut, end minus start); the published files are 0.007 to 0.015 s longer
(2.0084, 2.4493, 2.2544, 3.8034, 3.8145, 0.7725, 0.9136, 1.4075, 1.1692 and 0.7775 s in the manifest); the check of the round
named the difference, this document does not explain it.
"Own" is the loudness of the listening copy over its own channels, "page count" the same counted as the page counts (a one-channel file on
both channels). No copy was stopped by the true-peak ceiling. Measures of the raw cut before any gain, as in round 6.

| id | cut length s | ch | shots | reached own LUFS | reached page count | loud 50 ms dBFS | above 2 kHz (loud frames) | under 250 Hz | above 60 Hz |
|---|---|---|---|---|---|---|---|---|---|
| ev7_1_thruster_room_1_derived_r6p3s11a | 2.00 | 1 | 2 | -27.99 | -24.98 | -6.23 | 0.0520 | 67.4 % | 76.8 % |
| ev7_1_thruster_room_2_derived_r6p3s11b | 2.44 | 1 | 2 | -27.99 | -24.98 | -6.97 | 0.0446 | 69.0 % | 80.9 % |
| ev7_1_thruster_room_3_derived_r6p3s11c | 2.24 | 2 | 2 | -24.98 | -24.98 | -7.03 | 0.0547 | 67.4 % | 78.8 % |
| ev7_2_thruster_three_1_moss_p1s24 | 3.79 | 1 | 3 | -28.00 | -24.99 | -1.58 | 0.0189 | 82.3 % | 49.6 % |
| ev7_3_thruster_hall_1_moss_p1s24 | 3.80 | 1 | 3 | -28.00 | -24.99 | -2.21 | 0.0201 | 84.5 % | 29.2 % |
| ev7_4_shield_brighter_1_derived_r6p2s11a | 0.76 | 1 | - | -23.98 | -20.97 | -4.36 | 0.0165 | 94.3 % | 62.0 % |
| ev7_4_shield_brighter_2_derived_r6p2s11b | 0.90 | 1 | - | -24.00 | -20.99 | -7.65 | 0.0714 | 74.8 % | 61.2 % |
| ev7_5_shield_swallow_1_moss_p1s22 | 1.40 | 1 | - | -23.99 | -20.98 | -12.81 | 0.7738 | 10.9 % | 98.5 % |
| ev7_6_shield_absorb_1_moss_p1s27 | 1.16 | 1 | - | -24.00 | -20.99 | -9.36 | 0.5933 | 25.1 % | 84.2 % |
| ev7_7_shield_snap_1_moss_p1s22 | 0.77 | 1 | - | -23.97 | -20.96 | -12.60 | 0.9508 | 0.2 % | 100.0 % |

Targets: thruster -28 LUFS for a one-channel file; shield -24. The two-channel file is levelled to the same loudness over its two
channels as a one-channel file counted on both (+3.01 dB), which is why its own value is -24.98 and its page count the same as the others.
Cuts: thruster_room 0.064 to 2.06 / 0.065 to 2.50 / 0.064 to 2.31 s; thruster_three s24 0.208 to 4.00 s; thruster_hall s24 0.176 to 3.98 s
(capped at the family length 3.8 s; kept, so its end is 20 dB or more under the maximum); shield_brighter 0.001 to 0.762 and 0.001 to 0.905 s;
swallow 0.00 to 1.40; absorb 0.073 to 1.231; snap 0.00 to 0.77.

## Each pick against the references (first selection)

The setting `notSaturatedNoise` (loudest 50 ms above -9.5 dBFS and a share above 2 kHz of 0.03 or more in the loud frames) is a working rule
from four rejected round-5 files; it is applied by the plan to the three generated shield families only, and the thruster families have
no such rule (the plan sets none; in round 6 every thruster file was over the level number). The four files he called overdriven in round 5
(table of RESULTS6.md): shield_bright_1 s15 (-4.40 dBFS, 0.0373), shield_bright_2 s14 (-8.25, 0.1006), fold_jump_1 s13 (-6.95, 0.1601),
fold_jump_2 s14 (-5.44, 0.1506). The thrusters of round 6 for scale: thruster_mighty_2 (close) -4.54 and 0.057,
thruster_mighty_3 (wrong) -5.77 and 0.061, thruster_mighty_1 (wrong) -2.65 and 0.010. Over level = above -9.5; over share = 0.03 or
more; distances are to the thresholds.

| id | loud 50 ms (distance to -9.5) | share above 2 kHz (distance to 0.03) | over both? |
|---|---|---|---|
| ev7_1_thruster_room_1_derived_r6p3s11a | -6.23 (+3.27 dB) | 0.0520 (+0.0220) | YES |
| ev7_1_thruster_room_2_derived_r6p3s11b | -6.97 (+2.53) | 0.0446 (+0.0146) | YES |
| ev7_1_thruster_room_3_derived_r6p3s11c | -7.03 (+2.47) | 0.0547 (+0.0247) | YES |
| ev7_2_thruster_three_1_moss_p1s24 | -1.58 (+7.92) | 0.0189 (-0.0111) | no: level over, share under |
| ev7_3_thruster_hall_1_moss_p1s24 | -2.21 (+7.29) | 0.0201 (-0.0099) | no: level over, share under |
| ev7_4_shield_brighter_1_derived_r6p2s11a | -4.36 (+5.14) | 0.0165 (-0.0135) | no: level over, share under |
| ev7_4_shield_brighter_2_derived_r6p2s11b | -7.65 (+1.85) | 0.0714 (+0.0414) | YES |
| ev7_5_shield_swallow_1_moss_p1s22 | -12.81 (-3.31) | 0.7738 (+0.7438) | no: share over, level under |
| ev7_6_shield_absorb_1_moss_p1s27 | -9.36 (+0.14) | 0.5933 (+0.5633) | YES (a fallback, see above) |
| ev7_7_shield_snap_1_moss_p1s22 | -12.60 (-3.10) | 0.9508 (+0.9208) | no: share over, level under |

Plainly: five lie over both numbers: the three room versions (as the close thruster they were made from is, -4.54 and 0.057), shield_brighter_2 (-7.65, 0.0714, between
the -8.25 and -4.40 of the overdriven shields and in the range of 0.037 to 0.16 of their shares) and shield_absorb_1 s27 (0.14 dB over the
level number, 0.5933 against the 0.037 to 0.16 of the four, the only pick that the rule itself would have kept out). The two generated
thrusters are over the level number by 7.3 and 7.9 dB and under the share number by 0.010 and 0.011, so the closest to the edge of the
rule's second half; their loudest 50 ms (-1.58, -2.21) are higher than any rated file of the thruster event (the highest before:
thruster_mighty_1 -2.65). shield_brighter_1 is over the level number by 5.1 dB and under the share by 0.0135. The swallow and snap picks are
noise-like (0.77 and 0.95) and 3.3 and 3.1 dB under the level number.

By the ranges of `round6-ratings-analysis.json` (script `--place-against`): thruster: the three rooms lie inside the "wrong" range on
loudest 50 ms, share above 2 kHz, under 250 Hz and above 4 kHz and inside "close and wrong" on above 60 Hz; the generated thrusters are
"over every range" on loudest 50 ms, length and active length, and inside "wrong" on the shares; thruster_hall has 29.2 % above 60 Hz,
"under every range" of the thruster event. Shield: the swallow and snap picks lie inside the "wrong" range on every measure but the
tail; brighter_1 lies inside "close" on the loudest 50 ms and the tail, between ranges on the shares, and inside "wrong" on length.

## Level at the page (first selection, ten ids; the current numbers are in "After the first check")

Own vite server on port 5555 (the ratings file an empty file in `r7-select/ratings`, never the owner's), process 154128, stopped
afterwards: the port has no listener (only waiting leftovers of closed connections). `audition-level.mjs` for the ten ids, with `--dry`
(room 0, radio filter off) and with the page defaults. "At page" is the file's own-channel loudness plus "file>page".

| id | target | file own LUFS | file>page dry | at page dry | file>page default | at page default | peak dBFS dry / default |
|---|---|---|---|---|---|---|---|
| ev7_1_thruster_room_1 | -28 | -27.99 | -0.14 | -28.13 | +0.06 | -27.93 | -18.0 / -17.9 |
| ev7_1_thruster_room_2 | -28 | -27.99 | -0.09 | -28.08 | +0.12 | -27.87 | -16.1 / -15.6 |
| ev7_1_thruster_room_3 (two channels) | -28 | -24.98 | -3.10 | -28.08 | -2.89 | -27.87 | -16.9 / -16.6 |
| ev7_2_thruster_three_1 | -28 | -28.00 | -0.09 | -28.09 | +0.02 | -27.98 | -20.7 / -19.9 |
| ev7_3_thruster_hall_1 | -28 | -28.00 | -0.09 | -28.09 | +0.03 | -27.97 | -18.1 / -17.3 |
| ev7_4_shield_brighter_1 | -24 | -23.98 | -0.09 | -24.07 | +0.02 | -23.96 | -12.6 / -12.3 |
| ev7_4_shield_brighter_2 | -24 | -24.00 | -0.09 | -24.09 | +0.01 | -23.99 | -11.9 / -11.8 |
| ev7_5_shield_swallow_1 | -24 | -23.99 | +0.25 | -23.74 | +0.38 | -23.61 | -12.4 / -12.2 |
| ev7_6_shield_absorb_1 | -24 | -24.00 | +0.13 | -23.87 | +0.25 | -23.75 | -14.8 / -14.7 |
| ev7_7_shield_snap_1 | -24 | -23.97 | +0.22 | -23.75 | +0.34 | -23.63 | -10.8 / -10.7 |

The rule (thrusters -28 and shields -24 within 0.4 dB, whatever the channels) holds: the largest deviation is 0.39 dB (shield_swallow_1
with the defaults, -23.61). The one-channel files lie at file>page -0.14 to +0.38 dB, the two-channel file at -3.10 (dry) and -2.89
(default). "Sounding dBFS" of the page recording is not a level rule: -23.1 to -29.1 over the ten (dry). The highest output peak is -10.7
(shield_snap_1, default) and -10.8 (dry); the overload lamp was unchanged for all ten.

## Page checks (first selection, ten ids; the current ones are in "After the first check")

- `tools/dev/audition-check.mjs` with `AUDITION_CAPTURE_SCENES=none` and `AUDITION_CAPTURE_ONLY` the ten ids plus test_edges and test_step
  (same server and ratings file): 48 passed, 0 failed, no console errors. The page lists "Ereignisklänge (Runde 7)" first with its German
  name. Faults in the recordings: 0 caused by the page, 10 in a sound file itself (listed, not page faults): 6 in
  ev7_7_shield_snap_1_moss_p1s22 (a click of size 0.018 at 0.590 s in Stereo, 0.019 in Mono, 0.010 at 0.597 s in Headphones; the
  listing shows each twice) and 4 in test_step, which holds a step on purpose.
- The manifest after `publish.py` (script, `r7-select/gate.py`, against the snapshot taken before anything was changed): 188 entries,
  the 178 before and the 10 new, all category `events7`. The 178 are equal to before in every field and in the same relative order; the
  categories read events7, events6, events5, source, voice, and the 15 before follow unchanged. Every wav on disk has the sha256 of its
  entry (0 mismatches), and the sha256 of all 178 old files is unchanged. `assets/audio/ratings.json` was not written (SHA-256 prefix
  28ba828550516814 before and after; it was saved by the owner at 2026-11-18T14:40:34Z). Before the first change `build.py --manifest-only`
  on a copy of `assets/audio/render` (output there) gave a manifest equal to the real one in all 178 entries and in order, so the build
  was quiet.
- `tools/sound/tests` were not run again by this step; the tools step reports 58 passed.

## What could not be judged (first selection; see the end of "After the first check" for the current list)

How any of it sounds. Whether a room of 1.35 to 2.1 s in one or two channels is what "Raumklang" means for him, and whether the wide
version is wanted. Whether the thruster picks with three measured shots are a mighty gun or too pressed (-1.6 and -2.2 dBFS loudest 50 ms,
the highest of any rated thruster file); the rooms are over both numbers like the close candidate they were made from. Whether the two
shield versions of the close candidate are "a little brighter": the tuned one has 94.3 % under 250 Hz (against 94.6 %) and a centroid of 191
Hz (against 161 Hz); the shelved one has 74.8 % and 531 Hz and is over both numbers. Whether the three generated bright shields are the
kind he turned down before (two have the spectral shape of the OGA spark and of shield_bright_2, at a level 10 dB higher), or the swallowing
he described; whether the 16 kHz line, which is in the sounds he accepted too, matters; whether the click in the snap pick is heard. Whether
`shield_absorb` s27, a one-second rise followed by a drop, is an energy beam that is swallowed, and it is there only because every other
file of the family was cut off. Whether the speech rule was right to throw out three thruster files; it did not change the picks. That
the owner has not heard any of these files: the shots count (`count_shots`) is a rise of the 10 ms level and agrees with the pictures
for the three-shot picks and the two-shot fixed ones, but was not checked against anyone's ear.

## After the first check

The first check of the round (`docs/reports/2026-11-18/sound7-verify-report.json`, 2026-11-18, before the owner had rated anything of
it) found one wrong sentence on the page and a few in this document; the plan was then changed in five places (all in
`tools/sound/prompts7.json`, in its "note" and in each family's "what") and the tools were changed to carry them out. Every number
below is from a script run after the change (screen.py, derive.py, publish.py and the two page scripts), unless it is marked as the
check's. NOBODY LISTENED to any of it.

### The five changes, why, and what was measured

1. **thruster_room_4** (new fixed candidate, tag r6p3s11d). His note was that the file held two shots, not three; the generated files that
   hold three are other sounds. Process: `append {fromS 0.0, toS 1.0}`, then `room {rt60S 1.4, wetDb -4, channels 1, seed 7}`. A copy of the first second of
   the raw file (its first shot) is appended to its end, so the file holds three shots, and the clear room is added after that. The third
   shot is a copy of the first, which the name and the intent text on the page say. New operation `append` of `derive.py`: the item is
   refused unless the last 10 ms before the splice, the first 10 ms of the copy and the last 10 ms of the copy are each at least 50 dB under the
   peak; no fade, no gain. Measured: splice at 2.0 s of a 2.0 s raw file (peak 0.99955), copy 1.0 s long, appended result 3.0 s, the three
   levels 69.36, 56.78 and 62.67 dB under the peak, the largest sample step within 1 ms of the splice 0.000186. With the room the result is 5.10 s
   (output gain -3.59 dB to stay under peak 0.999). The family's maxS went from 3.6 to 4.0; the cut is 0.0652 to 3.558 s (3.49 s),
   not capped at the family length. `count_shots` on the whole derived file: 3 shots, rises of the 10 ms level at 0.07, 1.08 and 2.07 s
   (10 ms resolution, so 1.01 and 0.99 s apart); on the cut 3.
2. **shield_brighter_3** (new fixed candidate, tag r6p2s11c): tuned 3 semitones higher and a high shelf at 300 Hz, +8 dB (the two
   operations of the first two together), so that he can say where on that line the right brightness lies. Result 1.68 s, peak 0.999 after a
   scaling of -3.69 dB, under 250 Hz 74.3 %, above 2 kHz 0.0813, centroid 627.3 Hz (the other two: 94.3 % / 0.0168 / 191.3 Hz and 74.8 % / 0.0722 / 531.1 Hz).
3. **`minAbove60Hz: 0.4` for thruster_three and thruster_hall.** The first hangar pick (seed 24) had 29.2 % of its energy above 60 Hz. Now
   seed 24 of the hangar (3 shots, 0.2916 above 60 Hz) is not picked ("energy above 60 Hz 0.2916 is under the family's minimum 0.40") and seed 21 (3 shots,
   0.8128) takes the slot. thruster_three seed 24 has 0.4962 and stays.
4. **`pressedNoiseFallback: false` for shield_absorb.** The fallback had put seed 27 on the page under the text "Chosen as the most typical
   candidate of its source in this family.", which the check called wrong (it was put in only to fill the slot: -9.36 dBFS and a share above 2 kHz of 0.5932). Now the slot stays empty;
   the note in `screen.json`: 2 kept candidates, both over both numbers (loudest 50 ms above -9.5 dBFS and a share above 2 kHz of 0.03
   or more in the loud frames; seed 27 -9.36 / 0.5932, seed 28 -5.98 / 0.1026). Further, `publish.py` can no longer write that sentence for a pick that
   carries `pressedNoiseFallback`: it writes that it is a fallback, with its two numbers and the family's two limits. No such pick is on
   the page.
5. **Hand skip `moss/shield_snap_1__s22`** (`tools/sound/skips7.json`): a click in the tail, found by the page check and measured in the file
   (at 0.533 s of the raw file, three samples step by up to 0.0265 at the published level where the median step is 0.0012 and the level is -55 dBFS).
   The replacement the tool chose is seed 24; it was tested before publishing (below).

Also corrected: the sentences of this document that the check listed (the "length s" column is the cut length; "exactly three shots" rests on
`count_shots` alone; the click beside "faults: []"; the 16 kHz values are approximate), the example id in the README (p1s24 where p1s23 was named) and, on the page, the sentence about the fallback.
The sentence "as the page plays it ... -24.99 / -20.99 LUFS" is inherited from
rounds 5 and 6 and unchanged: it counts the file's own loudness over two channels with a one-channel file counted on both (+3.01 dB); it is not the level
the page outputs (the page passes a file's energy on: about -28 LUFS for a thruster and -24 for a shield, table below).

### The tool change, checked

`tools/sound/tests/test_screen.py`: 62 tests, 0 failed (4 new: append copies and records the splice; append refuses a step; a family without
fallback leaves the slot empty; publish never calls a fallback "the most typical candidate"). `.venv-audio/Scripts/python.exe -m unittest discover -s
tools/audio/listen/tests`: 80 tests, OK. Round 6 reproduced: `screen.py --prompts-file tools/sound/prompts6.json` on a scratch copy of
`assets/audio/gen/r6` (cpu) gives the same 14 chosen ids, the same 14 cuts and the same listening-copy values as the real
`assets/audio/gen/r6/screen.json`; the only values that differ are the file paths of the raw files and of the listening copies.
The five derived files of the first selection are sample for sample what they were after the run of `derive.py` (their `gen.json`
records are equal too); the seven unchanged chosen ids have the same cut and the same `listen` values except the file path.

### The picks now (11 candidates; from `screen.json` and the listening copies, by script)

"cut length" is the cut of `screen.json`; "shots" is `count_shots` (where counted); above 60 Hz, loud 50 ms and above 2 kHz (loud frames) are
measures of the raw cut before any gain as in the tables above; centroid is of the listening copy, power weighted. "over both" says whether the
two numbers of `notSaturatedNoise` (loudest 50 ms above -9.5 dBFS and a share above 2 kHz of 0.03 or more) are both exceeded; the plan applies that rule to
shield_swallow, shield_absorb and shield_snap only.

| id | cut length s | ch | shots | above 60 Hz | loud 50 ms dBFS | above 2 kHz (loud frames) | centroid Hz | over both | what was done |
|---|---|---|---|---|---|---|---|---|---|
| ev7_1_thruster_room_1_derived_r6p3s11a | 2.00 | 1 | 2 | 76.8 % | -6.23 | 0.0520 | 460.6 | yes | room, decay 0.9 s, wet -9 dB, one channel |
| ev7_1_thruster_room_2_derived_r6p3s11b | 2.44 | 1 | 2 | 80.9 % | -6.97 | 0.0446 | 415.4 | yes | room, decay 1.4 s, wet -4 dB, one channel |
| ev7_1_thruster_room_3_derived_r6p3s11c | 2.24 | 2 | 2 | 78.8 % | -7.03 | 0.0547 | 443.1 | yes | room, decay 1.2 s, wet -6 dB, two channels |
| ev7_1_thruster_room_4_derived_r6p3s11d | 3.49 | 1 | 3 | 80.6 % | -7.00 | 0.0446 | 415.1 | yes | first second of the raw file appended (the third shot is a copy), then room 1.4 s, -4 dB, one channel |
| ev7_2_thruster_three_1_moss_p1s24 | 3.79 | 1 | 3 | 49.6 % | -1.58 | 0.0189 | 251.3 | no (level over, share under) | generated, seed 24 |
| ev7_3_thruster_hall_1_moss_p1s21 | 3.79 | 1 | 3 | 81.3 % | -2.73 | 0.0304 | 367.3 | yes (share 0.0004 over) | generated, seed 21 (replaces seed 24) |
| ev7_4_shield_brighter_1_derived_r6p2s11a | 0.76 | 1 | - | 62.0 % | -4.36 | 0.0165 | 191.4 | no (level over, share under) | tuned +3 semitones |
| ev7_4_shield_brighter_2_derived_r6p2s11b | 0.90 | 1 | - | 61.2 % | -7.65 | 0.0714 | 531.2 | yes | high shelf 300 Hz, +8 dB |
| ev7_4_shield_brighter_3_derived_r6p2s11c | 0.76 | 1 | - | 70.8 % | -7.68 | 0.0811 | 627.4 | yes | tuned +3 semitones and shelf 300 Hz, +8 dB |
| ev7_5_shield_swallow_1_moss_p1s22 | 1.40 | 1 | - | 98.5 % | -12.81 | 0.7738 | 7958.4 | no (share over, level under) | generated, seed 22 |
| ev7_7_shield_snap_1_moss_p1s24 | 0.32 | 1 | - | 100.0 % | -15.16 | 0.9963 | 9722.6 | no (share over, level under) | generated, seed 24 (replaces seed 22) |

Nothing for shield_absorb (slot empty) and the second slot of thruster_three (no second candidate with exactly three shots by `count_shots`). The seven
fixed candidates carry no fault (`faults: []`). The listening copies are levelled to the same targets as before (own LUFS -28.00 or -27.99 for
the one-channel thrusters, -24.98 for the two-channel one, -24.00 to -23.97 for the shields; none stopped by the true-peak ceiling).

**Which ids left the page, and why:** ev7_3_thruster_hall_1_moss_p1s24 (the hangar seed 24: 0.2916 above 60 Hz, under the floor of 0.40), ev7_6_shield_absorb_1_moss_p1s27 (the beam seed 27: a pressed-noise
fallback, -9.36 dBFS and 0.5932, over both numbers) and ev7_7_shield_snap_1_moss_p1s22 (the snap seed 22: a click in the tail). Four ids came in: thruster_room_4,
thruster_hall seed 21, shield_brighter_3 and shield_snap seed 24. The manifest has 189 sounds, 11 in events7.

### The snap replacement, tested before publishing

The tool chose seed 24 in place of seed 22. Step test over the whole cut in 50 ms windows (largest sample step against the median step of the window, and the
level of the window; a click is more than 15 times the median in a window more than 30 dB under the loudest window), by script on the raw cuts:

| candidate | cut s | windows | windows more than 30 dB under the loudest | largest step / median in those | clicks found |
|---|---|---|---|---|---|
| shield_snap_1 seed 24 | 0.465 to 0.786 (0.32 s) | 6 | 1 (the last, 36.6 dB under) | 8.5 | none |
| shield_snap_1 seed 22 (for comparison) | 0.0 to 0.766 (0.77 s) | 15 | 7 (from 0.40 s to 0.70 s) | 18.1 in the window from 0.50 s (the click at 0.533 s) | 1 |

Seed 24: window levels -31.8, -17.5, -15.2, -20.0, -36.0 and -51.8 dB; the largest ratio of any window is 24.5, in the first (16.6 dB under the loudest, so not
a click by the rule). The 50 ms trace of the whole raw file (2.0 s): about -88 dB until 0.40 s, then -80.6, -40.8, -19.7, -15.2, -17.7, -30.7, -48.0, -58.0, -65.1, -73.3, -82.1 dB, then
about -88 dB again until 1.9 s, and a last window (1.95 to 2.0 s) of -52.8 dB, outside the cut and not in the published file. Waveform: one burst, no step inside it;
time within 6 dB of the loudest 0.15 s of 0.32 (47 %); strongest 50 Hz band 6.2 % at 16000 Hz (the 16 kHz line of the files above); above 60 Hz 100.0 %; no silence inside the cut.
The spectrogram picture was looked at: broadband energy from the lowest bins up to about 18 kHz for the length of the burst, darker above 18 kHz, no separate tone line
visible. For seed 22 the window levels fall from -12.9 to -55.7 dB over 0.77 s. One candidate was tested; no further skip was needed. The page check found no click in seed 24 (below).

### Gates of the publication

- `assets/audio/ratings.json` sha256 28ba828550516814 (full value 28ba828550516814fff3fc617dfa32fbfdbaae7cdfb418be5db157819c0961d4) before the publish, after it and after the page checks (equal to
  `assets/audio/rounds/round6-ratings.json`); it was never written.
- The manifest has 189 entries: the 178 outside events7 are equal to the saved manifest of before the change in every field and in the same order,
  the 11 events7 entries are the chosen ids in order, every manifest hash equals the first 12 hex digits of the sha256 of its file (0 mismatches of 189), the seven
  unchanged candidates have the wav hashes 237a9d62a54f, 4fc5476226dd, d5bef1d1dc87, 44d7897d7e8a, 3aa3551f4eb4, b66bd0e4706f and ecd0f1239bdc, and their
  wav, png and json files (21 of 21) are byte for byte those of before. `assets/audio/render/events7` holds 33 files, exactly three per chosen id and nothing else; the
  manifest validates (no problem).

### Page checks and levels now

Own vite server on port 5611 (ratings file an empty file in a new folder under the scratchpad, never the owner's; `/audio-lib/ratings-path` named it), stopped by its process id afterwards: no
listener left on the port (only waiting leftovers of closed connections). `tools/dev/audition-check.mjs` with `AUDITION_CAPTURE_SCENES=none` and
`AUDITION_CAPTURE_ONLY` = thruster_room_4, thruster_hall seed 21, shield_brighter_3, shield_snap seed 24, test_edges and test_step:

- first run: 47 passed, 1 failed. The capture check found 2 listings (one click, listed twice) that it blamed on the page, in ev7_1_thruster_room_4 in the Headphones play: size 0.099 at 0.147 s,
  ratio 3.1 against a threshold of 3, not found in the samples of the file. Second run, the same set: 48 passed, 0 failed, 0 page faults. A further run with room_1, room_2, room_4 and test_edges
  gave no page fault for any of the three (its one failed check was the control that needs test_step, which that set did not contain, so that run is not a complete pass).
  room_4 was played in Headphones in all three runs; one of the three plays had a page fault of ratio 3.1. Nothing here says whether it is a property of the file or of the page's
  Headphones stage; the plays are real-time recordings and vary.
- faults in a sound file itself (listed, not page faults), by id: thruster_hall seed 21 18 listings in each of the two complete runs (clicks of size 0.001 to 0.003 at 1.09, 1.20 and 3.80 s in Stereo and Mono,
  at 1.21, 3.74 and 3.81 s in Headphones; every click is listed twice); thruster_room_4, shield_brighter_3 and shield_snap seed 24: none; test_step, which holds a step on purpose: 10.
- no console errors; the category "Ereignisklänge (Runde 7)" is listed first.
- The screenshots of this script are written to `screenshots/audition/` of the repository (ignored by git); the script overwrote the 20 files that were there (same names, from earlier runs); nothing was deleted.

Level run, `tools/dev/audition-level.mjs` for all 11 ids with `--dry` (room 0, radio filter off); "at page" is the listening copy's own loudness plus "file>page":

| id | target | file own LUFS | file>page dB | at page | deviation |
|---|---|---|---|---|---|
| ev7_1_thruster_room_1 | -28 | -27.99 | -0.14 | -28.13 | -0.13 |
| ev7_1_thruster_room_2 | -28 | -27.99 | -0.09 | -28.08 | -0.08 |
| ev7_1_thruster_room_3 (two channels) | -28 | -24.98 | -3.10 | -28.08 | -0.08 |
| ev7_1_thruster_room_4 | -28 | -28.00 | -0.09 | -28.09 | -0.09 |
| ev7_2_thruster_three_1 | -28 | -28.00 | -0.09 | -28.09 | -0.09 |
| ev7_3_thruster_hall_1 | -28 | -27.99 | -0.09 | -28.08 | -0.08 |
| ev7_4_shield_brighter_1 | -24 | -23.98 | -0.09 | -24.07 | -0.07 |
| ev7_4_shield_brighter_2 | -24 | -24.00 | -0.09 | -24.09 | -0.09 |
| ev7_4_shield_brighter_3 | -24 | -23.97 | -0.08 | -24.05 | -0.05 |
| ev7_5_shield_swallow_1 | -24 | -23.99 | +0.25 | -23.74 | +0.26 |
| ev7_7_shield_snap_1 | -24 | -24.00 | +0.19 | -23.81 | +0.19 |

The largest deviation from -28 (thrusters) is 0.13 dB (room_1), from -24 (shields) 0.26 dB (swallow); the overload lamp was unchanged for all eleven.

### What the shields say about "a little brighter"

The shield he called close (ev6_3_shield_tight_2_moss_p2s11, its raw file) has its energy mostly under 250 Hz: 94.6 % under 250 Hz, a share above 2 kHz of 0.0147 and a spectral
centroid of 160.8 Hz. The generated shields of this round are of another kind by the numbers: shield_swallow seed 22 (on the page) has a centroid of 7958 Hz (10.9 % under 250 Hz, share above 2 kHz 0.7847)
and shield_snap seed 24 (on the page) 9723 Hz (0.0 % under 250 Hz, share above 2 kHz 0.9963); the two that left the page had 8741 Hz (snap seed 22) and 5868 Hz (absorb seed 27). So a generated
shield here has a centroid of several kHz where the candidate he called close has 161 Hz; none of them lies near it. The answer to his "a little brighter" is therefore in the three fixed shields: centroids
191.4 Hz (tuned), 531.2 Hz (shelf) and 627.4 Hz (both), against the 160.8 Hz of the raw file.

### What nobody could verify

Nobody listened to any of the 11 files. Open are: how they sound, whether the room is the "Raumklang" he means, whether three shots of which the third is a copy of the first is what he asks for,
whether any of the three fixed shields is the "little brighter", whether the hangar pick (81.3 % above 60 Hz, three shots by `count_shots`) is a mighty gun, and whether the swallow and snap picks are the swallowing he
described. The shot counts rest on `count_shots` alone; the check's counter differed on four of the generated files. The one page fault of the first page-check run (room_4, Headphones, ratio 3.1) did not come back in two
further runs and was not explained. The 16 kHz line is in files he accepted and was measured only approximately. The last 50 ms of the raw file of snap seed 24 start something (-52.8 dB) that lies outside the cut and is not
published. The two replacements (snap seed 24, hangar seed 21) were chosen by the tool, not by an ear.
