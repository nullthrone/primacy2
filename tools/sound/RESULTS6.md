# Sound sources, round 6: another try for the rejected families, MOSS only

Written 2026-11-17 by the select-and-publish step. Nobody listened: every statement below is a measurement or a
reading of a waveform, a level curve and a spectrum. Whether any pick is right is the owner's click on the audition
page, category "Ereignisklänge (Runde 6)", which is listed first. Round 5 follows as "Ereignisklänge (Runde 5)" with its
ratings untouched.

## What was asked, and why

The owner rated round 5 on 2026-11-16 (`assets/audio/rounds/round5-ratings.json`): 5 fit, 2 close, 10 wrong. What he
accepted (hull_light_1 s15, hull_heavy_1 s16 and hull_heavy_2 s14, the two valve pulses) is not asked again. Round 6
(`tools/sound/prompts6.json`, its "note") tries the rejected families with new prompts, MOSS only, as he decided:
"Lass uns mit MOSS weiter machen, ohne Stable Audio. Ich denke damit kommen wir auch ans Ziel."

- Thruster with more bang, all four wrong: "klingt wie eine kleine Gaspistole, nicht wie eine mächtige Gatling Gun",
  "klingt wie eine kleine Plastikkanone". Family `thruster_mighty`: prompts name large weapons and ask for weight in the
  low end; target level -28 LUFS (the library's own thruster pulses sit at -26 to -28; the round-5 candidates were 6 to 8
  dB under that).
- Shield, all three wrong: "Klingt zu voll und übersteuert, auch zu lang gezogen. Es muss kürzer sein", "klingt wie ein
  Knistern eines kaputten Kabels", "übersteuert, zu lang, zu viel rauschen". Family `shield_tight`: one short, tight, clean
  event, a low thump with a brief crackle, 2 s asked and cut at 1.5 s at most.
- Fold jump, both wrong: "zu übersteuert". Family `fold_jump`: clean, smooth, bright, an electrical source named.
- Fold exit, one close and one wrong: "zu viel hochtöniges Rauschen" and "klingt gehaucht, nach Luft, die es im Vakuum nicht
  gibt". Family `fold_exit`: no prompt names air, wind, steam or a whoosh; the first is the "close" prompt made darker.
- Hull hit, light: one of two fitted. Family `hull_light` here is the accepted wrench prompt with new seeds (21 to 26),
  as variants.

What "übersteuert" rests on was measured after round 5 (`docs/reports/2026-11-16/round5-overdrive-report.json`): the page
does not make it; the files do. The four he called overdriven are noise-like (share of energy above 2 kHz in the loud
frames 0.039 to 0.16, against 0.003 and 0.009 for the two shields he accepted) and their raw model output is pressed
against full scale (loudest 50 ms at -4.4 to -8.2 dBFS). Hence the new setting `notSaturatedNoise` (below). The rule
rests on four rejected and a handful of accepted files; it is a working rule, not a law.

## What was made

MOSS-SoundEffect, 78 raw files (`assets/audio/gen/r6/moss/raw`, record `gen.json`; generate report
`docs/reports/2026-11-16/sound6-generate-report.json`): hull_light 1 prompt x seeds 21-26 = 6, the other four families 3
prompts x seeds 11-16 = 18 each. No Stable Audio file was made, screened or published. Nothing was carried over from
earlier rounds.

## What was thrown out (of 78)

`screen.py` with Whisper small and CLAP on the processor, `--prompts-file tools/sound/prompts6.json --root
assets/audio/gen/r6` (skips of `skips6.json`, read by default for this prompts file). 56 kept, 22 thrown out, all 22 as
cut off (the sound is still loud at the end of the file or at the family length); none as silent, clipped, several
events, speech, music or too short.

| family | files | kept | thrown out (all cut off) |
|---|---|---|---|
| hull_light | 6 | 6 | 0 |
| thruster_mighty | 18 | 7 | 11 |
| shield_tight | 18 | 13 | 5 (shield_tight_2 s13, shield_tight_3 s13 to s16) |
| fold_jump | 18 | 14 | 4 (fold_jump_1 s11 and s15, fold_jump_2 s11, fold_jump_3 s11) |
| fold_exit | 18 | 16 | 2 (fold_exit_1 s11, fold_exit_3 s11) |

## The pick rule, and what it excluded

The slot rule is that of round 5: `picks` lists the sources (all MOSS); the first slot takes the most typical candidate,
each further slot the candidate farthest from the picks already made. Settings per family: `maxS`, `oneEvent`, `lufs`,
and for shield_tight `minAbove60Hz` 0.4.

New in round 6, `"notSaturatedNoise": {"loud50Db": -9.5, "above2kHz": 0.03}` on shield_tight, fold_jump and fold_exit. A
kept candidate stays in the pool (it counts for the normalisation and the centre, like a hand skip) but is not picked
when the loudest 50 ms of its raw cut are above -9.5 dBFS and the share of its energy above 2 kHz in its loud frames
(2048-sample spectrum, hop 512, frames within 10 dB of the loudest) is 0.03 or more. If a family had fewer candidates
that can be picked than slots, the rest would be filled from the excluded ones, the lowest loudest-50-ms level first;
that was not needed in any family, and no note was written.

Check of the setting on round-5 data (measured on the raw cuts of round 5, with the family settings of
`prompts5.json`): the four the owner called overdriven are above both thresholds, the three that were not are not.

| raw file of round 5 | loudest 50 ms dBFS | share above 2 kHz, loud frames | excluded by the rule |
|---|---|---|---|
| shield_bright_1 s15 (overdriven) | -4.40 | 0.0373 | yes |
| shield_bright_2 s14 (overdriven) | -8.25 | 0.1006 | yes |
| fold_jump_1 s13 (overdriven) | -6.95 | 0.1601 | yes |
| fold_jump_2 s14 (overdriven) | -5.44 | 0.1506 | yes |
| fold_exit_1 s15 | -10.71 | 0.4177 | no (under the level threshold) |
| fold_exit_2 s15 | -11.17 | 0.7965 | no (under the level threshold) |
| shield_bright_2 s11 | -22.07 | 0.8649 | no (under the level threshold) |

shield_bright_1 s15 is the narrowest: 0.0373 against the threshold 0.03. The share of the round-5 report for it was 0.039;
this step uses a Hann window and averages the channels, which gives the small difference. The setting was also run on a
copy of `assets/audio/gen/r5` with `prompts5.json` and `skips5.json`: the same 17 picks, ids, cuts, gains, notes and
file statuses as `assets/audio/gen/r5/screen.json`, and no new key.

Kept but not picked as pressed noise (`notPickedSaturatedNoise`), 14 of the 43 kept files of the three families:

- fold_exit: 9 of 16. All six of fold_exit_2 (s11 to s16, loudest 50 ms -5.1 to -8.2, share above 2 kHz 0.045 to 0.107)
  and three of fold_exit_3 (s12, s13, s15). The prompt "a bright electric surge collapses quickly" is entirely pressed
  noise; the round-5 "close" prompt made darker (fold_exit_1) is not touched by the rule, and neither are the two
  other fold_exit_3 files at -7.9 and -9.7 dBFS.
- fold_jump: 2 of 14 (fold_jump_1 s12 at -4.4 / 0.136, fold_jump_2 s14 at -9.3 / 0.214).
- shield_tight: 3 of 13 (shield_tight_1 s15 at -7.3 / 0.425, shield_tight_2 s15 at -6.3 / 0.031, s16 at -5.1 / 0.068).

Under `minAbove60Hz` 0.4 (not picked, `notPickedLowShare`), shield_tight: shield_tight_1 s14 (18.1 %), shield_tight_2 s14
(29.3 %), shield_tight_3 s11 (19.2 %) and s12 (34.9 %). They stay in the pool.

## Hand skips

Look at every pick for a plain fault the rules do not see (waveform, level in 50 ms windows, spectrum; never how it may
sound), as the README says. Eight skips in `tools/sound/skips6.json` after four screening runs, each with its numbers:

- hull_light_1 s23: a second event in a one-event cut. The level falls to -19 dB under the maximum at 0.15 s, comes back
  to -11 dB at 0.2 to 0.35 s and to -18 dB at 0.6 to 0.8 s (11 peaks within 20 dB). This is the "several short tones in a
  row, like an echo" that the owner said of a round-5 hull hit.
- shield_tight_2 s12: a tone and not a thump. The whole pick is 0.12 s at full scale (raw peak 1.00, loudest 50 ms at -3.9
  dBFS), 84 % of the energy at 250 to 1000 Hz, 31 % of it near 810 Hz, nothing under 250 Hz.
- fold_jump_3 s12 (2.7 % above 60 Hz), fold_exit_1 s12 (4.4 %) and fold_jump_3 s14 (8.7 %): under the 10 % rule; they play as
  silence on most loudspeakers.
- fold_jump_3 s13, s15 and s16: a steady tone instead of an event. The level stays within 6 dB of the maximum for 2.8,
  2.7 and 2.45 s of 3.8 s and one 50 Hz band holds 86, 57 and 82 % of the energy (dominant 48, 67 and 36 Hz). With these,
  every kept file of the prompt fold_jump_3 ("a deep power hum swells for one second") is skipped, so the family has no
  pick from it. This is a judgement on a level curve and a spectrum; the prompt asked for a hum, so the owner might have
  wanted one of them. The skips are in the file and can be removed.

Not skipped although they are borderline: shield_tight_1 s12 (pick 3 of the shield, 0.11 s, a tick with 77 % of its energy
above 4 kHz and nothing under 250 Hz; it has no thump and is very short, but it is one event and not a tone), and
fold_exit_1 s13 and s16 (a 41 % and a 65 % band at 47 and 36 Hz, but a clear rise, plateau and fall).

## The picks

14 of the 14 planned slots are filled (hull_light 2, the others 3 each). All are MOSS, one channel, 48 kHz. "Loud 50 ms"
and "share above 2 kHz" are measured on the raw cut before any gain (families without the rule: not recorded). "Reached"
is the own-channel loudness of the listening copy; no copy was stopped by the true-peak ceiling.

| id | prompt, seed | cut s | length s | loud 50 ms dBFS | share above 2 kHz | target LUFS | reached | above 60 Hz |
|---|---|---|---|---|---|---|---|---|
| ev6_1_hull_light_1_moss_p1s22 | hull_light_1, 22 | 0.00-0.47 | 0.48 | - | - | -34.0 | -33.99 | 100.0 % |
| ev6_1_hull_light_2_moss_p1s21 | hull_light_1, 21 | 0.00-0.65 | 0.66 | - | - | -34.0 | -33.97 | 94.9 % |
| ev6_2_thruster_mighty_1_moss_p1s12 | thruster_mighty_1, 12 | 0.00-1.50 | 1.51 | - | - | -28.0 | -27.98 | 48.6 % |
| ev6_2_thruster_mighty_2_moss_p3s11 | thruster_mighty_3, 11 | 0.05-1.56 | 1.51 | - | - | -28.0 | -28.00 | 74.2 % |
| ev6_2_thruster_mighty_3_moss_p3s12 | thruster_mighty_3, 12 | 0.00-1.50 | 1.51 | - | - | -28.0 | -27.99 | 95.7 % |
| ev6_3_shield_tight_1_moss_p1s11 | shield_tight_1, 11 | 0.07-0.33 | 0.27 | -10.94 | 0.0420 | -24.0 | -24.02 | 88.8 % |
| ev6_3_shield_tight_2_moss_p2s11 | shield_tight_2, 11 | 0.00-0.91 | 0.92 | -4.44 | 0.0145 | -24.0 | -23.99 | 50.2 % |
| ev6_3_shield_tight_3_moss_p1s12 | shield_tight_1, 12 | 0.00-0.11 | 0.12 | -22.56 | 0.7297 | -24.0 | -24.01 | 98.9 % |
| ev6_4_fold_jump_1_moss_p1s14 | fold_jump_1, 14 | 0.00-3.80 | 3.81 | -9.86 | 0.4832 | -24.0 | -24.00 | 85.1 % |
| ev6_4_fold_jump_2_moss_p2s15 | fold_jump_2, 15 | 0.00-3.80 | 3.81 | -10.50 | 0.6319 | -24.0 | -24.00 | 99.9 % |
| ev6_4_fold_jump_3_moss_p2s12 | fold_jump_2, 12 | 0.00-3.80 | 3.81 | -14.71 | 0.8037 | -24.0 | -24.00 | 99.9 % |
| ev6_5_fold_exit_1_moss_p3s16 | fold_exit_3, 16 | 0.00-3.80 | 3.81 | -9.72 | 0.1308 | -24.0 | -24.00 | 99.9 % |
| ev6_5_fold_exit_2_moss_p1s13 | fold_exit_1, 13 | 0.00-3.12 | 3.13 | -2.92 | 0.0020 | -24.0 | -24.00 | 43.0 % |
| ev6_5_fold_exit_3_moss_p1s16 | fold_exit_1, 16 | 0.14-3.88 | 3.75 | -4.04 | 0.0015 | -24.0 | -24.00 | 36.8 % |

Every pick of the three rule families is either not pressed (under -9.5 dBFS) or not noise-like (under 0.03), as the rule
demands. Two sit close to the edge: ev6_4_fold_jump_2 (-10.50, 0.63) and ev6_5_fold_exit_1 (-9.72, 0.13) are noise-like
and 1.0 and 0.2 dB under the level threshold. ev6_3_shield_tight_2 is pressed (-4.44) but tonal (0.0145). The fold_jump picks 1 to 3 and the first
fold_exit pick are the bright, rushing kind; the other two fold_exit picks are
low and tonal (37 to 43 % above 60 Hz, a dominant tone at 36 to 47 Hz), which is unlike the round-5 exits.

## Level at the page

All 14 are one-channel files, so file>page is about 0 dB. `audition-level.mjs --dry` (room 0, radio filter off) for the 14
ids: file>page -0.10 to +0.15 dB (hull -0.10 and -0.07, thruster -0.09 to -0.08, shield -0.08, -0.09 and +0.15, fold jump
+0.05, +0.02 and +0.15, fold exit -0.08, -0.09 and -0.09). So what leaves the page equals the level of the file: -34 LUFS
for hull_light, -28 for thruster_mighty, -24 for shield_tight and the folds. The highest output peak is -4.6 dBFS
(ev6_3_shield_tight_3, a 0.12 s tick), under the limiter threshold at -2 dBFS; the overload lamp did not light for any
sound. "Sounding dBFS" (50 ms windows over -45 dBFS) is not a level rule and varies from -34.9 (hull) to -23.1 (shield): a
short event and a long one of the same LUFS differ there.

## Page checks

Own vite server on port 5420 (`AUDITION_RATINGS_FILE` an empty file in a new folder of the scratch directory, never the
owner's file), stopped afterwards; the port has no listener. `AUDITION_CAPTURE_SCENES=none`, `AUDITION_CAPTURE_ONLY` the 14
ids plus test_edges and test_step.

- `audition-check.mjs`: 48 passed, 0 failed, no console errors. 0 faults caused by the page; 14 faults in a sound file
  itself: 10 in ev6_3_shield_tight_1_moss_p1s11 (clicks of size 0.014 to 0.061 at 0.19 to 0.25 s, in Stereo, Mono and
  Headphones) and 4 in test_step, which holds a step on purpose. They are listed, not page faults.
- The manifest has 187 entries: the 173 before and the 14 new. Every one of the 173 ids is still there with the same
  hash and in the same relative order; the new entries are exactly the 14 picks, all category `events6`, and the
  categories read events6, events5, source, pilot. The 165 hashes of `assets/audio/rounds/round5.json` are unchanged.
  `assets/audio/ratings.json` is byte-identical to `assets/audio/rounds/round5-ratings.json` (SHA-256
  b41654a8579903a0732245f8ee44bf91bc1364eefb98d1cad5b760d2f5ef4a58).
- The tests of `tools/sound`: 47 tests (43 before, 4 new for the setting), 46 pass. One fails, and not because of this
  round: `test_publish_removes_what_is_not_in_the_new_set_and_leaves_the_build_order` expects 17 entries in the manifest
  of its fake tree and finds 25, because `tools/audio/build.py` adds the 8 library sounds of the committed
  `assets/audio/generated.json` (ids `g_*`, committed 2026-11-16 23:35, after round 5 passed 43 of 43). It was not changed
  here.

## What could not be judged

How any of it sounds. Whether the thruster picks are a mighty gun and not a small pistol, whether the shield picks are
short, tight and clean with a thump and a brief crackle, whether the fold sounds are clean and not overdriven, whether the
exits are free of hiss and air. Whether `notSaturatedNoise` finds what the owner means by "übersteuert": it rests on four
rejected files and a handful of accepted ones, and files it keeps (ev6_4_fold_jump_2 and ev6_5_fold_exit_1 are bright and
noise-like, 1.0 and 0.2 dB under the level threshold) may still be called overdriven. The very short shield pick
(0.12 s, a tick with almost nothing under 250 Hz) and the 0.27 s one with a low tone near 104 Hz may be too short or too thin
for a shield; the owner asked for short, but not for a tick. The steady-hum skips of fold_jump_3 and the under-10-percent
skips were made on level curves and spectra only. Whether 20 dB for the cut-off rule suits the steady fold sounds was not
tested again (22 files were cut off, 11 of them thruster_mighty, which has the 1.5 s cap). The decoder's pressing
against full scale was measured only by the loudest 50 ms of the raw cut and the crest in the page recording.
