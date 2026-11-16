# Sound sources, round 5: the event sounds of the game, made with MOSS only

Written 2026-11-16 by the select-and-publish step. Nobody listened: every statement below is a measurement or a
reading of a waveform and a spectrogram. Whether any pick is right is the owner's click on the audition page, category
"Ereignisklänge (Runde 5)", which is listed first. Round 4 is untouched and follows on the page as "Klangquellen
(Runde 4)" with its sixteen candidates and their ratings.

## What was asked, and why

The owner rated the sixteen candidates of round 4 on 2026-11-16 (`assets/audio/rounds/round4.json`,
`round4-ratings.json`). Verdicts: "Passt" (fits), "Nah dran" (close), "Falsch" (wrong).

- Hull: MOSS hull_1 s16 fits; Stable Audio hull_2 s11 and hull_1 s13 fit; the recorded metal hit is wrong.
- Thruster: MOSS thruster_1 s11 (valve prompt) fits; the recorded steam hiss fits; MOSS thruster_2 s11 and Stable Audio
  thruster_2 s12 (air-cannon prompt) are close, with the notes "Grundidee passt, es muss aber doller, knalliger klingen"
  and, for the second, "Aktuell klingt es eher hauchig".
- Gear: MOSS gear_2 s12 fits; Stable Audio gear_3 s15 and gear_2 s15 fit; the recorded lock click is wrong.
- Shield: Stable Audio shield_3 s11 and shield_2 s16 fit; MOSS shield_3 s14 is close, with the note "Klingt hochwertiger
  als die letzten Samples, allerdings klingt es etwas zu bass-lastig. ich würde ein minimales knistern/wummern mit
  einbauen"; the recorded spark is wrong.
- By count: Stable Audio 6 of 7 fit and 1 close; MOSS 3 of 5 fit and 2 close; recordings 1 of 4 fit and 3 wrong. These
  are the first short events he accepted in four rounds. The four countdown samples are still unrated.

After that the owner decided (2026-11-16, quoted in `tools/sound/prompts5.json`): "Lass uns mit MOSS weiter machen, ohne
Stable Audio." Round 5 is therefore MOSS only. This step followed that later decision: no Stable Audio file was
screened or published (see "Stable Audio" below). His hint for the thruster pulse, to describe it as a Gatling gun and
not as an air cannon, is carried by the families thruster_bang and thruster_gatling.

`tools/sound/prompts5.json` plans eight families and 18 slots: hull_light 2, hull_heavy 2, thruster_valve 3,
thruster_bang 2, thruster_gatling 2, shield_bright 3, fold_jump 2, fold_exit 2. Only the valve family rests on a prompt
he accepted ("proven"); the other seven are first tries. fold_jump and fold_exit are two events he has rejected since
round 1.

## What was made

MOSS-SoundEffect v2.0, 15 prompts x seeds 11-16 = 90 files (the valve prompt with its own seeds 21-26), 48 kHz mono,
the makers' defaults (generate step, `docs/reports/2026-11-16/sound5-generate-report.json`). Besides these, 9 kept and
unheard round-4 files joined the pool without being made again (`tools/sound/from_round4.py`): 3 for the valve family
(thruster_1 s12, s15, s16) and 6 for shield_bright (shield_1 s11, s14, s15, s16; shield_3 s15, s16). The pool is 99 MOSS
files.

## What was thrown out (of 99)

`screen.py` with Whisper small and CLAP on the processor, `--prompts-file tools/sound/prompts5.json --root
assets/audio/gen/r5 --skips tools/sound/skips5.json`. 73 kept, 26 thrown out: 23 cut off, 3 several events; none as
silent, clipped, speech, music or too short.

| family | files | kept | thrown out |
|---|---|---|---|
| hull_light | 12 | 12 | 0 |
| hull_heavy | 12 | 12 | 0 |
| thruster_valve | 9 (3 carried) | 3 (the 3 carried) | all 6 new ones: 1 cut off at the end of the file, 3 cut off at the family length (4.0, 2.0, 4.0 dB under the maximum in the last 50 ms of the cut), 2 several events (s24, s26) |
| thruster_bang | 12 | 8 | 4: 3 cut off at the family length (2.9, 18.9, 15.6 dB), 1 several events |
| thruster_gatling | 12 | 7 | 5 cut off at the family length (8.4, 18.1, 5.6, 13.1, 9.0 dB) |
| shield_bright | 18 (6 carried) | 17 | 1 cut off at the family length (12.9 dB) |
| fold_jump | 12 | 6 | 6 cut off: 4 at the end of the 4 s file, 2 at the family length (15.7, 11.6 dB) |
| fold_exit | 12 | 8 | 4 cut off: 2 at the end of the file, 2 at the family length (9.4, 12.0 dB) |

Kept but never picked: shield_bright has 5 kept files under the family minimum of 40 % above 60 Hz
(`notPickedLowShare`: shield_1 s11 35.8 %, s14 39.97 %, s16 18.6 %, shield_3 s16 9.5 %, shield_bright_1 s14 34.9 %),
and four hand-skipped files (below). All stay in the pool for the statistics.

## Hand skips

The README allows a hand skip only for a plain fault: steady noise, a tone over everything, a second event or silence
inside the cut in a one-event family, almost no energy above 60 Hz. The 17 picks of the first screening were looked at
as waveform and spectrogram (made from the listening copies) and as a 50 ms level; the two new picks after the skips were
looked at the same way. Two picks were skipped (`tools/sound/skips5.json`):

- moss/thruster_bang_1__s12: in its 1.2 s cut the level sits 15 to 22 dB under the maximum for 0.95 s, with low thumps
  at about 0.40, 0.50 and 0.90 s; the loudest sound (peak 0.199) is at 1.011 s. Its place went to thruster_bang_1 s11.
- moss/shield_bright_2__s12: about 40 separate clicks within 16.5 dB of its peak (0.850 at 0.010 s) spread over 0 to
  1.55 s, among them 1.321 s at -5.6 dB and 1.507 s at -1.9 dB, then 0.9 s at 28 to 31 dB under the maximum. Its place
  went to shield_bright_2 s14.

Two hand skips come from round 4 with their files (`round4Skip`): thruster_1 s16 (silence around a hiss inside the
cut) and shield_3 s16 (9.5 % above 60 Hz). thruster_1 s16 is why the valve family has two picks, not three.

Looked at and kept, because the README names no fault for them: thruster_valve s12 and s15 are flat noise bursts of
about 0.9 and 0.65 s with a hard start and a hard end; the accepted round-4 file thruster_1 s11 has the same shape at
about 0.35 s (raw level 0 to -3 dB, then -24 dB and lower), so a flat top is not a fault of this family. fold_jump_2 s14
stays at 0 to -3 dB for about 2 s and fades over the last 0.8 s (68 % of its 100 ms windows within 6 dB of the maximum);
gear_2 s12 of round 4 was steadier and was accepted. thruster_bang_1 s11 is one bang of 0.2 s followed by a plateau at
-24 dB for the rest of the cut. shield_bright_2 s11 has its crackle in the first 0.45 s and small isolated clicks later
(22 to 35 dB under the maximum). This list is not a judgement of how any of them sounds.

## The picks

17 of the 18 planned slots are filled. The valve family has two: its third slot had no candidate left (none of the six
new valve files survived the screening, and the third carried file is a round-4 hand skip). The slot was left empty and
not filled from another source or family. Every pick is MOSS, one channel, 48 kHz, 16-bit on the page, with a fixed
place ahead.

"Level" is the own LUFS of the file plus the dry gain from file to page (`audition-level.mjs --dry`, in brackets), that
is, what leaves the page; target -34.0 for hull and thruster, -24.0 for shield and fold. "Above 60 Hz" is the share of
the cut's energy. "Raw crest" (shield_bright only) is peak over RMS of the whole raw file.

| id | source | prompt, seed | proven or first try | length s | ch | level LUFS (dry gain dB) | above 60 Hz | raw crest |
|---|---|---|---|---|---|---|---|---|
| ev5_1_hull_light_1_moss_p2s15 | MOSS | hull_light_2, seed 15 | first try | 0.66 | 1 | -34.06 (-0.08) | 99.8 % | - |
| ev5_1_hull_light_2_moss_p1s11 | MOSS | hull_light_1, seed 11 | first try | 0.44 | 1 | -34.05 (-0.05) | 100.0 % | - |
| ev5_2_hull_heavy_1_moss_p2s16 | MOSS | hull_heavy_2, seed 16 | first try | 3.77 | 1 | -34.09 (-0.09) | 63.4 % | - |
| ev5_2_hull_heavy_2_moss_p1s14 | MOSS | hull_heavy_1, seed 14 | first try | 3.81 | 1 | -34.08 (-0.09) | 28.8 % | - |
| ev5_3_thruster_valve_1_moss_r4p1s12 | MOSS | thruster_1, seed 12 | proven; file made in round 4, not heard then | 1.01 | 1 | -33.50 (+0.50) | 97.8 % | - |
| ev5_3_thruster_valve_2_moss_r4p1s15 | MOSS | thruster_1, seed 15 | proven; file made in round 4, not heard then | 0.80 | 1 | -33.70 (+0.29) | 100.0 % | - |
| ev5_4_thruster_bang_1_moss_p2s11 | MOSS | thruster_bang_2, seed 11 | first try | 0.50 | 1 | -34.07 (-0.07) | 98.2 % | - |
| ev5_4_thruster_bang_2_moss_p1s11 | MOSS | thruster_bang_1, seed 11 | first try | 1.21 | 1 | -34.02 (-0.03) | 72.8 % | - |
| ev5_5_thruster_gatling_1_moss_p2s12 | MOSS | thruster_gatling_2, seed 12 | first try | 1.11 | 1 | -34.07 (-0.07) | 82.8 % | - |
| ev5_5_thruster_gatling_2_moss_p1s11 | MOSS | thruster_gatling_1, seed 11 | first try | 0.81 | 1 | -34.05 (-0.05) | 95.5 % | - |
| ev5_6_shield_bright_1_moss_p1s15 | MOSS | shield_bright_1, seed 15 | first try | 2.51 | 1 | -24.07 (-0.08) | 88.9 % | 11.7 dB |
| ev5_6_shield_bright_2_moss_p2s11 | MOSS | shield_bright_2, seed 11 | first try | 2.51 | 1 | -28.05 (+0.17) | 99.0 % | 35.0 dB |
| ev5_6_shield_bright_3_moss_p2s14 | MOSS | shield_bright_2, seed 14 | first try | 1.72 | 1 | -24.05 (-0.06) | 44.6 % | 17.7 dB |
| ev5_7_fold_jump_1_moss_p1s13 | MOSS | fold_jump_1, seed 13 | first try | 3.81 | 1 | -24.05 (-0.05) | 90.6 % | - |
| ev5_7_fold_jump_2_moss_p2s14 | MOSS | fold_jump_2, seed 14 | first try | 3.81 | 1 | -24.07 (-0.07) | 83.0 % | - |
| ev5_8_fold_exit_1_moss_p1s15 | MOSS | fold_exit_1, seed 15 | first try | 3.67 | 1 | -24.01 (-0.01) | 96.2 % | - |
| ev5_8_fold_exit_2_moss_p2s15 | MOSS | fold_exit_2, seed 15 | first try | 3.81 | 1 | -23.90 (+0.10) | 100.0 % | - |

shield_bright (the family that decides whether MOSS can make the shield), per pick, share above 60 Hz and crest of the
raw file: shield_bright_1 s15 88.9 % and 11.7 dB (raw peak 0.9994, 0.24 % of its samples within 1 dB of the peak);
shield_bright_2 s11 99.0 % and 35.0 dB (raw peak 0.9602); shield_bright_2 s14 44.6 % and 17.7 dB (raw peak 0.9989). The
round-4 MOSS shield pick (shield_3 s14, the one he called too bass-heavy) had 25 % above 60 Hz and a crest of 7.7 dB
(RESULTS.md). All three round-5 picks have more energy above 60 Hz and a higher crest than it. Crest is peak over RMS
only; it does not see the tanh of the decoder, and it says nothing of how bass-heavy a pick sounds.

## Level at the page

All 17 are one-channel files, so file>page is about 0 dB. `audition-level.mjs` with the page defaults (room 1, radio
filter on): +0.03 to +0.62 dB; dry: -0.09 to +0.50 dB. What leaves the page (own LUFS plus dry gain): hull -34.05 to
-34.09 (four files), thruster -34.02 to -34.07 for the four bang and gatling files and -33.5 and -33.7 for the two valve
files, shield -24.05 and -24.07 for two files and -28.05 for shield_bright_2 s11, fold -23.90 to -24.07.

Two misses of the level rule (inside a family everything leaves the page equally loud, short events within about
0.4 dB), reported and not repaired:

- shield_bright_2 s11 reaches only -28.22 LUFS own (target -24.0): the true-peak ceiling (-1.1 dBFS) stopped the gain at
  -0.75 dB (`limitedByPeak`; page measure -25.21 against -20.98). Its raw file has a crest of 35.0 dB (a few very loud
  clicks over a quiet bed). It leaves the page about 4.0 dB under its two family mates.
- The valve files leave the page 0.50 dB (s12, 1.01 s) and 0.29 dB (s15, 0.80 s) above the target, dry, against "about
  0.4 dB" for short events; s12 is 0.1 dB outside it.

## Page checks

Own vite server on port 5311 (pid recorded and stopped; the port was free afterwards), ratings in an empty scratch file,
`AUDITION_CAPTURE_SCENES=none`, `AUDITION_CAPTURE_ONLY` the 17 ids plus test_edges and test_step.

- `audition-check.mjs`: 48 passed, 0 failed, no console errors. It played 19 sounds in Stereo and 10 of them also in Mono
  and Headphones. Faults in the recordings: 0 caused by the page, 28 in a sound file itself (every sound playing at the
  time is counted): 22 in shield_bright_2 s11 (clicks of size 0.017 to 0.461), 2 in shield_bright_1 s15 and 4 in
  test_step, which holds a step on purpose. They are listed, not page faults.
- `audition-level.mjs` for the 17 ids, with and without `--dry`: the numbers above.
- The manifest has 165 entries: the 148 as before and 17 new; its categories read events5 ("Ereignisklänge (Runde 5)"),
  source ("Klangquellen (Runde 4)"), pilot, and so on. The 148 hashes equal `assets/audio/rounds/round4.json`, and the 48
  files of `render/source` have the same SHA-256 as before this step. `assets/audio/ratings.json` had the SHA-256
  3c50dc48d26b1b368cd1e111d8f446fa04e81bea94ad094f68d17a6d35f67453 at the start and at the end.
- The "test only" label and licence note of Stable Audio apply to no round-5 entry, since there is none; the round-4
  category keeps them. The -3.10 dB two-channel rule had nothing to apply to.

## Stable Audio

The generate step also made 90 Stable Audio files (`assets/audio/gen/r5/sa3`), against the later decision. They were not
screened: `screen.py` has no option to leave a source out and takes every `gen.json` under its root, and the pool
statistics decide which MOSS files are picked. So `assets/audio/gen/r5/sa3/gen.json` was renamed in place to
`gen.json.not-screened` (git-ignored; the raw files are untouched). To undo it:
`mv assets/audio/gen/r5/sa3/gen.json.not-screened assets/audio/gen/r5/sa3/gen.json`; a later screening would then take
them into the pool and change which MOSS files are picked. The `screen.json` in the tree was made with the name as it is
now.

## What could not be judged

How any of it sounds: whether the hull hits are hits, whether the thruster pulses have more bang, whether the Gatling
bursts are a burst, whether the shield has the crackle or throb he asked for or is still bass-heavy, whether the fold
jump and exit are energetic and rushing and not a dull thud. Nobody listened. The cuts were made by the level rule, and
the review of the spectrograms finds plain faults only. The decoder's pressing against full scale was measured by crest
only. Whether the 20 dB cut-off threshold suits steady sounds was not tested (it threw out 23 files, 10 of them in the
two fold families). The six valve files made in round 5 were all thrown out, so the proven family rests on two files
from round 4 that the owner has not heard; why none survived was not examined. The clicks in shield_bright_2 s11 are in
the file; whether they are the crackle that was asked for or a fault was not judged.
