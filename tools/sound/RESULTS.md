# Sound sources, round 4: what was made and what was chosen

Written 2026-11-15. Nobody here can hear. This page says what was made, what was measured and
what was thrown out. Whether any of it sounds right is the owner's click on the audition page,
category "Klangquellen (Runde 4)". The sources are not ranked.

## What was made

| source | candidates | one candidate took | settings |
|---|---|---|---|
| MOSS-SoundEffect v2.0 | 72 (4 families x 3 prompts x seeds 11-16), 48 kHz mono | 17-18 s on the free card; 384-547 s in four runs while another program held the card | the makers' defaults: 100 steps, cfg 4.0, sigma shift 5.0, bf16 |
| Stable Audio 3 Small-SFX Base | 72 (same grid), 44.1 kHz stereo | about 2 s after an 18 s warm-up | the card's: 50 steps, cfg 7, euler, fp16, prefix "TrackType: SFX, " |
| OpenGameArt, CC0 | 0 | not made | blocked before any download: `tools/audio/fetch.py` allows only kenney.nl and nasa.gov, and the change was refused. Nothing was substituted. |

Both generators give the same file for the same seed (checked by the builders). The Stable Audio
checkpoint is the one before the makers' last training stage (the finished one is gated), so a
weak showing does not settle the model, and its files are test material under the Stability AI
Community License.

## What was thrown out (per family and source, of 18 each)

`screen.py` throws out only what is broken. Reasons are in `assets/audio/gen/screen.json`, per file.

| family | MOSS | Stable Audio 3 |
|---|---|---|
| hull | 0 | 10, clipped |
| thruster | 1, several events | 12: 11 clipped (5 of them also several events), 1 several events |
| gear | 8, cut off by the end of the 4 s file (the sound still 3.6 to 15.6 dB under its maximum in the last 50 ms) | 9, clipped |
| shield | 3, cut off by the end of the 3 s file | 10, clipped |

Left: MOSS 60 (hull 18, thruster 17, gear 10, shield 15), Stable Audio 31 (hull 8, thruster 6,
gear 9, shield 8). No file was thrown out as speech or music.

"Clipped" means 3 or more samples in a row at full scale. For Stable Audio this is the makers'
own clamp to [-1, 1] on output: the thrown-out files hold runs of 3 to 117 samples at full scale.
The MOSS files that peak at 0.999 or more have runs of at most 2 samples and were kept.
The three thrown-out files looked at per reason were real faults, not faults of the script
(clipped: shield_3 s14 of Stable Audio, a run of 80; cut off: MOSS gear_3 s11, 9.9 dB under at the
end of the file; several events: Stable Audio thruster_3 s11, a second onset at 1.495 s).

## Two changes to the script, after looking at the files

- The end of an event in the three one-event families is now 45 dB under the maximum (was 50).
  MOSS thruster_3 is two bursts with 0.6 s between them at 48 to 49 dB under; with 50 dB the first
  event never ended, the cut ran on to the family length and took the start of the second burst
  (thruster_3 s15 and s16 were such cuts). Now s15 is thrown out as two events. Gear is unchanged.
- The listening copy has its mean taken out when it is 0.0005 or more, with a window that is 1 in
  the middle and tapers over the first 1.5 ms and the last 5 ms, so there is no step. The page
  fails a file whose mean is 0.001 or more, and four of the sixteen had one (MOSS shield_3 s16:
  0.0099, thruster_2 s16: 0.003, shield_1 s14: 0.0025, Stable Audio shield_2 s16: 0.0017), which is
  sub-bass in a short event. This is the only change to the sound beyond cut, level and the end
  fades; it is recorded per file as `dcBefore` and `dcAfter` in screen.json.

## Replaced after looking at the spectrograms

The spectrogram of every pick was looked at for plain faults (nothing there, a second event, a
cut-off end, a tone over everything). Six candidates were skipped as picks (they stay in the pool,
so the others are chosen as before; written to screen.json as `skippedAsPick`):

- MOSS thruster_3 s13, thruster_1 s13: steady noise with a line near 12.5 kHz for the whole 1.2 s
  cut, no event, still within 0.6 dB of its maximum at the cut.
- MOSS thruster_1 s16: the hiss sits 0.13 to 0.72 s inside a 1.2 s cut, silence before and after.
- MOSS thruster_3 s16: its cut ended with the first samples of a second event.
- Stable Audio thruster_1 s14: the thump comes at 0.75 s, after a quiet hiss the 40 dB onset rule keeps.
- MOSS shield_3 s11: a 50 Hz sine over the whole 2.5 s cut, still 12.7 dB under the maximum at
  the cut, no decay.

One kept pick has a tone that could be called a fault but follows the prompt: MOSS gear_2 s16
(src_3_gear_1) holds a steady line near 520 Hz for its whole length (the prompt asked for a servo
whine). It also runs to the family length of 3.8 s, 6.6 dB under its maximum at the cut.
Stable Audio thruster_1 s12 runs to the family length of 1.2 s, 27 dB under at the cut.

## The sixteen

All 48 kHz, one place ahead for mono files, 16-bit on the page. "Level" is the target loudness of
the family (LUFS) as reached by the file, and the true peak. "On page" is the level of the sounding
parts at the output of the page with its defaults (room 1, radio filter on), peak, and whether the
overload lamp lit (it lit for none of them).

| id | source | prompt, seed | length s | ch | level LUFS / true peak dB | on page: sounding / peak dBFS |
|---|---|---|---|---|---|---|
| src_1_hull_1_moss | MOSS | hull_1, 14 | 2.19 | 1 | -33.2 / -17.9 | -32.4 / -20.3 |
| src_1_hull_2_sa3 | Stable Audio 3 | hull_3, 16 | 2.48 | 2 | -34.0 / -19.5 | -36.6 / -23.0 |
| src_1_hull_3_moss | MOSS | hull_2, 12 | 1.09 | 1 | -34.0 / -17.2 | -31.4 / -19.8 |
| src_1_hull_4_moss | MOSS | hull_2, 16 | 1.96 | 1 | -34.0 / -15.0 | -32.5 / -17.5 |
| src_2_thruster_1_moss | MOSS | thruster_1, 15 | 0.79 | 1 | -34.0 / -23.6 | -39.6 / -26.7 |
| src_2_thruster_2_sa3 | Stable Audio 3 | thruster_1, 12 | 1.21 | 2 | -34.0 / -16.8 | -40.1 / -20.0 |
| src_2_thruster_3_moss | MOSS | thruster_2, 16 | 0.49 | 1 | -34.0 / -12.4 | -24.5 / -15.4 |
| src_2_thruster_4_moss | MOSS | thruster_2, 13 | 0.51 | 1 | -34.0 / -13.6 | -31.8 / -16.5 |
| src_3_gear_1_moss | MOSS | gear_2, 16 | 3.81 | 1 | -35.0 / -20.2 | -38.1 / -23.3 |
| src_3_gear_2_sa3 | Stable Audio 3 | gear_2, 16 | 3.54 | 2 | -35.0 / -15.1 | -35.1 / -18.2 |
| src_3_gear_3_moss | MOSS | gear_1, 12 | 3.81 | 1 | -35.0 / -23.2 | -39.2 / -26.1 |
| src_3_gear_4_sa3 | Stable Audio 3 | gear_2, 11 | 2.48 | 2 | -35.0 / -23.7 | -42.2 / -26.5 |
| src_4_shield_1_moss | MOSS | shield_3, 16 | 2.51 | 1 | -24.0 / -12.0 | -20.9 / -15.0 |
| src_4_shield_2_sa3 | Stable Audio 3 | shield_2, 11 | 2.27 | 2 | -24.0 / -11.0 | -27.3 / -14.3 |
| src_4_shield_3_moss | MOSS | shield_1, 14 | 2.00 | 1 | -24.0 / -12.3 | -23.3 / -14.9 |
| src_4_shield_4_sa3 | Stable Audio 3 | shield_2, 16 | 2.29 | 2 | -24.0 / -9.9 | -27.1 / -13.1 |

The prompt texts are in `tools/sound/prompts.json`. The slot of the recording (third in each
family) is filled with a second MOSS pick because no recording exists: slots 3 and 4 of a family
are therefore both generated.

Each family has the same loudness target for all four files, but they do not leave the page
within 3 dB of each other:

- hull: sounding level -36.6 to -31.4 (spread 5.2 dB). The Stable Audio file is the low one.
- thruster: -40.1 to -24.5 (15.6 dB). The two MOSS thruster_2 files are the loud end, and
  thruster_3 (src_2_thruster_3_moss) is mostly a push below 40 Hz with a high peak. The most
  likely reason is that LUFS (K-weighting) hardly counts low frequencies, while the page's level
  does; this was not tested by changing the weighting.
- gear: -42.2 to -35.1 (7.1 dB). Long files, so the sounding level includes many quiet windows.
- shield: -27.3 to -20.9 (6.4 dB), with the sub-bass heavy MOSS files louder than the Stable Audio ones.

No gain was changed to hide this. If the owner wants the families equal on the page, the
loudness target would have to be set per file from the page's own measure
(`tools/dev/audition-level.mjs`), which is a decision for the next round.

## Page checks

`audition-check.mjs` with the sixteen ids plus test_edges and test_step, no scene: 48 passed,
0 failed. The capture found no click or clipped sample caused by the page (the 4 faults it lists
are in test_step, a file made to contain a step). It played 18 sounds in Stereo and 10 of them
also in Mono and Headphones; the other eight were not played in those two stage settings.
`assets/audio/ratings.json` has the same SHA-256 before and after
(f916ed364561b57618647545bfe8a11adeb8871219743cb244b23c87c01ecac4); the check wrote only to a
scratch file. A first run of the check with a copy of the owner's ratings as scratch file failed
two steps that count ratings (the counter and the "only unrated" filter), which was the copy and
not the page; the third failure there is described next.

`publish.py` now moves the sounds of this category to the front of `manifest.json`: the page lists
categories in the order of `sounds.json`, where this one is first, and the check takes
`manifest.sounds[0]` and `[1]` for the first rows of the page. `build.py` alone puts unknown ids
after the known ones, so a rebuild without `publish.py` would bring that failure back.
The hashes of all 132 sounds in the manifest before are unchanged, and the 128 ids of
`assets/audio/rounds/round3.json` match their hashes.

## What could not be judged

How any of it sounds: whether a hull hit is a hit, a thruster pulse a pulse, whether the gear
ends in a latch, whether the shield is a shield, whether any of it is "artificial and boring". The
spectrogram review only finds plain faults. The cuts were made by the level rule, not by ear, so
some start or end where an ear would cut differently (for example the quiet hiss before a thump).
Speech and music were screened by Whisper small and CLAP on the processor; nothing was flagged,
which says nothing about weaker faults. The recordings (CC0) were not tested at all.
