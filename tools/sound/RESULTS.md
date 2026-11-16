# Sound sources, round 4 (second run): what was made and what was chosen

Written 2026-11-16, replacing the page of 2026-11-15. Nobody here can hear. This page says what was made, what was
measured and what was thrown out. Whether any of it sounds right is the owner's click on the audition page, category
"Klangquellen (Runde 4)". The sources are not ranked.

## What was made

| source | candidates | settings |
|---|---|---|
| MOSS-SoundEffect v2.0 | 72 (4 families x 3 prompts x seeds 11-16), 48 kHz mono, from the first run | the makers' defaults: 100 steps, cfg 4.0, sigma shift 5.0, bf16 |
| Stable Audio 3 Small-SFX Base | 72, 44.1 kHz stereo, made again on 2026-11-16 with the same seeds and settings, but without the makers' clamp to [-1, 1] (audio taken from `generate(return_latents=True)` and decoded; 50 of 72 files have a peak above 1, the highest 1.94; the old files are in `assets/audio/gen/sa3/raw_clamped/`) | the card's: 50 steps, cfg 7, euler, fp16, prefix "TrackType: SFX, " |
| OpenGameArt, CC0 | 21 excerpts of 10 items (hull 8, thruster 5, gear 7, shield 1), each in its own sample rate and channels, no gain, no fade; the page of each item says "License(s): CC0" (read 2026-11-16) | cuts in `tools/sound/oga_cuts.json`, adapter `tools/sound/adapters/oga.py`, downloads through `tools/audio/fetch.py` |

The Stable Audio checkpoint is the one before the makers' last training stage (the finished one is gated), so a weak
showing does not settle the model, and its files are test material under the Stability AI Community License: the page
says so on each of them. Which excerpts are really recordings is not established (see "What could not be judged").

## What was thrown out (of 165 files)

`screen.py` throws out only what is broken; the reason is in `assets/audio/gen/screen.json`, per file. The rules changed
since the first run (README, "How candidates are chosen"): a flat top (3 or more equal samples at the extreme of a
channel) counts as clipped, and the cut-off rule (last 50 ms within 20 dB of the maximum) now also applies where the
family's longest length stops an event that has not ended.

| family | MOSS (of 18) | Stable Audio 3 (of 18) | recordings |
|---|---|---|---|
| hull | 0 | 0 | 0 of 8 |
| thruster | 7: 6 cut off at the family length, 1 several events | 6: 5 several events, 1 cut off at the family length | 0 of 5 |
| gear | 14: 8 cut off by the end of the 4 s file, 6 cut off at the family length | 0 | 1 of 7: manhole-open, "music" (CLAP scores the music text 0.009 above the best family text, a narrow call) |
| shield | 10: 7 cut off at the family length, 3 by the end of the 3 s file | 0 | 0 of 1 |

Kept: MOSS 41 (hull 18, thruster 11, gear 4, shield 8), Stable Audio 66 (18, 12, 18, 18), recordings 20 (8, 5, 6, 1).
The first run kept MOSS 60 and Stable Audio 31. The Stable Audio files thrown out then as clipped are kept now (none has
a flat top); MOSS lost 19 files to the cap rule. No file was thrown out as speech. The level rule that finds the cut is
unchanged. Five MOSS files sit between 17 and 20 dB at the cap (reported by the screen-fix run); whether 20 dB at 50 ms
is the right threshold for steady sounds was not tested.

## Hand skips

The six skips of the first run were checked against the new rules. Four are no longer needed because the rules throw
those files out by themselves (all "cut-off" at the family length): MOSS thruster_3 s13, thruster_1 s13, thruster_3 s16
and shield_3 s11. Two stay, because the rules keep both files: MOSS thruster_1 s16 (the hiss sits 0.13 to 0.72 s inside
a 1.2 s cut, silence before and after) and Stable Audio thruster_1 s14 (the thump comes at 0.75 s of the 1.3 s cut).

Two new skips after the spectrograms of the sixteen first picks, both for the recorded share of the energy above 60 Hz
(the pick would play as silence on most loudspeakers), not for taste:

- MOSS shield_3 s16: 9.5 % above 60 Hz; the waveform is a steady low oscillation for 1.5 s.
- MOSS thruster_2 s12: 6.1 % above 60 Hz; the waveform is one slow swing of about 0.2 s, no noise burst.

Their places were taken by MOSS shield_3 s14 (25 % above 60 Hz) and MOSS thruster_2 s11 (98 %), whose spectrograms
show no plain fault either. The other fourteen spectrograms showed none of the plain faults (nothing there, a second
event of weight, a cut-off end, a tone over everything). Seen and kept: a few narrow lines at 1.5 to 1.8 s in the MOSS
hull_1 s16 pick and at about 0.95 s in the Stable Audio hull_1 s13 pick, far under the first event; the gear picks hold
several separate clunks over 3 to 3.8 s, and the recorded gear excerpt (0.49 s) holds three short clicks. The skips are
in `tools/sound/skips.json`; the run is `screen.py` and `publish.py` without arguments.

## The sixteen

Slots per family: one MOSS, one Stable Audio, one recording, one further generated pick (the one farthest from the
other three in the description used for variety; its page name ends in "second pick"). All four families had a
recording that passed, so every third slot holds a recording (page name "Aufnahme (CC0)" / "Recording (CC0)"). Whether
a recording is credible for its family is not something the rules decide: the gear recording is a short lock click, not
a motor ending in a latch, and the shield recording is a 0.26 s spark (no other electrical item exists). Stable Audio
entries keep the label "test only" and the licence note.

All 48 kHz, 16-bit on the page; mono files have a fixed place ahead. "Own / page LUFS / true peak": BS.1770 of the
file over its own channels, over two channels with a one-channel file counted on both (the measure the gain was set
by), and the true peak in dBFS. "Page, defaults": room 1, radio filter on; level of the sounding parts of channel 0 and
peak, dBFS. "Dry, both": level of the sounding parts with the energies of both channels added, room 0 and radio filter
off; "file>page": output energy of the page over both channels against the energy of the file over its own channels
(dry).

| id | source | prompt, seed / item | length s | ch | own / page LUFS / true peak | above 60 Hz | page, defaults: sounding / peak | dry, both dBFS | file>page dB |
|---|---|---|---|---|---|---|---|---|---|
| src_1_hull_1_moss_p1s16 | MOSS | hull_1, seed 16 | 2.51 | 1 | -33.99 / -30.98 / -14.6 | 32 % | -31.0 / -17.2 | -29.0 | -0.09 |
| src_1_hull_2_sa3_p2s11 | Stable Audio 3 | hull_2, seed 11 | 2.51 | 2 | -30.97 / -30.97 / -16.2 | 91 % | -33.3 / -19.6 | -30.9 | -3.10 |
| src_1_hull_3_oga_sfx2-metal-hit-01 | recording CC0 | sfx100v2_metal_hit_01.ogg (100 CC0 SFX #2, rubberduck), cut 0.01-0.75 s | 0.74 | 2 | -30.99 / -30.99 / -11.0 | 100 % | -33.2 / -14.0 | -31.2 | -3.10 |
| src_1_hull_4_sa3_p1s13 | Stable Audio 3 (second pick) | hull_1, seed 13 | 1.73 | 2 | -30.97 / -30.97 / -17.8 | 96 % | -33.5 / -20.9 | -32.0 | -3.10 |
| src_2_thruster_1_moss_p2s11 | MOSS | thruster_2, seed 11 | 0.50 | 1 | -34.00 / -30.99 / -10.8 | 98 % | -32.8 / -13.9 | -30.0 | -0.06 |
| src_2_thruster_2_sa3_p2s12 | Stable Audio 3 | thruster_2, seed 12 | 0.98 | 2 | -30.96 / -30.96 / -16.4 | 99 % | -34.4 / -21.4 | -32.8 | -3.10 |
| src_2_thruster_3_oga_steam-hiss-3 | recording CC0 | steam hisses - Marker #3.wav (Steam release sounds, bart), cut 0.00-0.92 s | 0.92 | 2 | -30.99 / -30.99 / -18.7 | 100 % | -38.6 / -23.5 | -35.0 | -3.10 |
| src_2_thruster_4_moss_p1s11 | MOSS (second pick) | thruster_1, seed 11 | 0.41 | 1 | -34.00 / -30.99 / -24.2 | 99 % | -38.6 / -27.7 | -35.7 | 0.33 |
| src_3_gear_1_moss_p2s12 | MOSS | gear_2, seed 12 | 3.81 | 1 | -35.00 / -31.99 / -19.9 | 100 % | -35.9 / -22.9 | -33.8 | -0.08 |
| src_3_gear_2_sa3_p3s15 | Stable Audio 3 | gear_3, seed 15 | 3.03 | 2 | -31.99 / -31.99 / -15.1 | 79 % | -37.9 / -18.2 | -34.9 | -3.10 |
| src_3_gear_3_oga_sfx2-lock-open-01 | recording CC0 | sfx100v2_lock_open_01.ogg (100 CC0 SFX #2, rubberduck), cut 0.02-0.50 s | 0.49 | 2 | -31.99 / -31.99 / -10.4 | 100 % | -39.5 / -13.3 | -36.6 | -3.10 |
| src_3_gear_4_sa3_p2s15 | Stable Audio 3 (second pick) | gear_2, seed 15 | 3.47 | 2 | -31.99 / -31.99 / -12.9 | 100 % | -35.7 / -16.0 | -33.4 | -3.10 |
| src_4_shield_1_moss_p3s14 | MOSS | shield_3, seed 14 | 2.00 | 1 | -23.99 / -20.98 / -14.0 | 25 % | -23.1 / -16.3 | -20.4 | -0.09 |
| src_4_shield_2_sa3_p3s11 | Stable Audio 3 | shield_3, seed 11 | 2.15 | 2 | -20.97 / -20.97 / -5.9 | 52 % | -24.4 / -8.9 | -21.6 | -3.10 |
| src_4_shield_3_oga_tesla-spark | recording CC0 | spark.wav (Electricity Sound Effects, BMacZero), cut 0.09-0.34 s | 0.26 | 1 | -24.00 / -20.99 / -1.5 | 100 % | -27.1 / -4.5 | -24.2 | 0.02 |
| src_4_shield_4_sa3_p2s16 | Stable Audio 3 (second pick) | shield_2, seed 16 | 2.29 | 2 | -20.99 / -20.99 / -6.9 | 34 % | -24.3 / -10.1 | -21.5 | -3.10 |

The overload lamp lit for none of the sixteen (the column reads "unchanged" in both runs). The prompt texts are in
`tools/sound/prompts.json`; the records of the recordings are in `assets/audio/gen/oga/gen.json`.

## Level at the page

The target of the family stays the loudness of a one-channel file; a copy is set to that plus 3.01 dB measured over
two channels (one channel counted on both), after all processing, and corrected until it is within 0.05 LU (largest
error of the sixteen 0.032 LU; no copy was stopped by the true-peak ceiling). Gain from file to page, dry, over both
channels: one channel -0.09 to +0.33 dB (the six files: -0.09, -0.06, 0.33, -0.08, -0.09, 0.02), two channels -3.10 dB
in all ten. That -3.10 is the page halving the energy of a two-channel file while a one-channel file's energy is put on
both channels, and it is what the +3.01 dB in the rule makes up for: the page LUFS column is -30.96 to -30.99 for hull
and thruster, -31.99 for gear and -20.97 to -20.99 for shield, whatever the number of channels. With the defaults
(room 1, radio filter on) the gains are -2.90 to -3.00 for two channels and +0.03 to +0.44 for one.

By the plain (unweighted) measure, the sounding level of both channels at the page, the files of a family still differ:

| family | dry, both dBFS | spread | by channels |
|---|---|---|---|
| hull | -32.0 to -29.0 | 3.0 dB | the one-channel file is the loudest (-29.0); the three two-channel files -30.9, -31.2, -32.0 |
| thruster | -35.7 to -30.0 | 5.7 dB | one channel -30.0 and -35.7 (both ends of the range); two channels -32.8 and -35.0 |
| gear | -36.6 to -33.4 | 3.2 dB | one channel -33.8; two channels -34.9, -36.6, -33.4 |
| shield | -24.2 to -20.4 | 3.8 dB | one channel -20.4 and -24.2; two channels -21.6, -21.5 |

The one-channel mean minus the two-channel mean is +2.4 (hull), +1.0 (thruster), +1.2 (gear) and -0.8 (shield) dB, and
in thruster and shield the one-channel files sit at both ends: the difference no longer follows the number of channels.
The first run's spread by the "sounding" measure of channel 0 was 5.2, 15.6, 7.1 and 6.4 dB; this table uses both
channels, so the two are not directly comparable.

Measured reason for part of what is left (`why.py`, a script kept outside the repository, run over the 16 files of
render/source with a K-weighting filter and no gate): per family, the spread of the K-weighted mean power of the whole
file is 2.6 (hull), 1.0 (thruster), 1.4 (gear) and 0.7 dB (shield), while the spread of the unweighted mean power is
4.2, 2.3, 3.0 and 8.1 dB. The unweighted level minus the K-weighted one, per file, follows the spectrum: +3.0 dB for the
low-heavy MOSS hull file against -1.5 for the metal-hit recording; -3.9 and -4.0 dB for the steam hiss and the MOSS
thruster_1 noise burst against -0.9 and -1.5 for the other two thruster files; +4.4, +2.6 and +2.8 dB for the three
generated shield files against -3.9 dB for the spark. That is the effect of the K-weighting (it cuts the low end and
lifts the high end by about 4 dB), which every LUFS target contains and the plain measure does not. It does not explain
the thruster spread of 5.7 dB at the page, which is larger than the 2.3 dB of the whole-file unweighted power: that
measure counts only 50 ms windows above -45 dBFS, and the thruster events are 0.4 to 1 s long with different tails;
this was not tested further. Loudness values of events under about 0.5 s (MOSS thruster_1 and thruster_2, the 0.49 s
gear recording, the spark) rest on one or two 400 ms blocks of BS.1770, and the gate and block positions move such a
value by a few dB (a 1.5 ms ramp moved one by 2.5 dB in the screen-fix run). No gain was changed to hide any of this.

## Page checks (own vite server on port 5271, ratings in an empty scratch file, stopped by its pid)

- `audition-check.mjs` with the sixteen ids plus test_edges and test_step, no scene: 48 passed, 0 failed. The capture
  found 0 faults caused by the page; the 4 it lists are in test_step, a file made to contain a step. It played 18 sounds
  in Stereo and 10 of them also in Mono and Headphones; the 24-start test of test_edges found no step. The other 130
  sounds and the four scenes were not played in this run.
- `audition-level.mjs` for the sixteen, with and without `--dry`: the figures above.
- `assets/audio/ratings.json` had the SHA-256 f916ed364561b57618647545bfe8a11adeb8871219743cb244b23c87c01ecac4 before
  the screening, before and after the publishing and after the page checks.
- The manifest has 148 sounds and validates. The hashes of the other 132 sounds are unchanged, the 128 ids of
  `assets/audio/rounds/round3.json` and the four voice_5_countdown files match, and render/source holds only the new
  sixteen (48 files: wav, png, json).

## What could not be judged

How any of it sounds: whether a hull hit is a hit, a thruster pulse a pulse, whether the gear ends in a latch, whether
the shield is a shield, whether any of it is "artificial and boring". The spectrogram review finds only plain faults;
nobody listened. The cuts were made by the level rule, not by ear. Whether the recordings are recordings: only three
of the item pages say "recorded"; the pages of rubberduck, bart, Cough-E and PagDev do not say how the sounds were
made. Two items were dropped for that kind of reason: the chain winch (its author says he synthesised it) and the
circuit breaker (its page gives no reason why the uploader may release another author's work). That the pack authors
may release their packs as CC0 was not checked. Three decoded .ogg excerpts peak at 1.004 to 1.008 before the ceiling
is applied to the copy. Speech and music were screened by Whisper small and CLAP on the processor; the only flag was one
recording, by a narrow margin, which says nothing about weaker faults. The unclamped Stable Audio files were not compared
with the clamped ones by ear. The page level was measured once per file with the defaults and once dry; repeated plays
of the same file were not compared.
