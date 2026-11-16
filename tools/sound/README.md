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
