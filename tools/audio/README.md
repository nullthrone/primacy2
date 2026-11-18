# Sound tools

Listening tools for agents that cannot hear: they turn a sound file into numbers, a picture and
text. Run everything from the repository root with `.venv-audio/Scripts/python.exe`. Sounds are
checked against the rules of `SOUND_DESIGN.md` section 2; the model licences are in `MODELS.md`,
the package versions in `requirements.txt`.

All tools read any format libsndfile reads, keep the channels, and print compact text by default
(`--json` where offered is for machines). The three model tools take a lock file
(`assets/audio/cache/gpu.lock`) so that only one process holds a model at a time; a waiting call
polls for up to ten minutes and then exits with a message. A lock whose process died is taken over.
Models load from the local Hugging Face cache only (`HF_HUB_OFFLINE=1`); nothing is downloaded.

## measure.py (no model, no GPU)

```
.venv-audio/Scripts/python.exe tools/audio/listen/measure.py assets/audio/render/alarms/alarm_heat.wav a.wav --loop --png assets/audio/cache/png
```

Many files per call; `--json` for machines, `--loop` adds the seam check, `--png DIR` writes
`<stem>.png` (waveform strip above, spectrogram below: log frequency 20 Hz to 20 kHz, fixed colour
scale -90 to 0 dB re full scale, so pictures of different files are comparable).

| number | meaning |
|---|---|
| peak / true peak | highest sample / highest value of the 4x oversampled signal, dBFS. Rule: true peak at most -1 |
| clipped | samples at or above 0.9999 of full scale. Rule: 0 |
| DC | largest channel mean, linear. Rule: below 0.001 |
| RMS, crest | RMS in dBFS; peak minus RMS in dB |
| LUFS | integrated loudness, ITU-R BS.1770-4 (pyloudnorm; clips under 400 ms are repeated to fill one block, noted in the output) |
| centroid | spectral centre of gravity of the average power spectrum, Hz. The spectrum is a Welch average over every sample of the file (8192-sample Hann segments, 75 % overlap, zero-padded so that no sample is dropped or weighted down) |
| bands, lowShare, highShare | share of power per band (<60, 60-125, 125-250, 250-500, 500-1k, 1-2k, 2-4k, 4-8k, >8k); low is below 500 Hz, high above 4 kHz (fractions in JSON, percent in text). Mean removed first; same spectrum as centroid |
| peaks, fundamental | strongest spectral peaks (Hz, dB relative to the strongest; 6 Hz bin spacing refined by interpolation) and an f0 estimate from harmonic support; `n/a` for noise-like sounds |
| onset | first time a sample reaches 40 dB below the peak (but not below -70 dBFS). Rule: at most 5 ms |
| attack | time from 10 % to 90 % of the peak amplitude, 1 ms resolution (not meaningful for speech or noise beds) |
| fall60 | milliseconds from the loudest 10 ms frame until the level is 60 dB lower; `n/a` if it never gets there |
| last10ms | RMS of the last 10 ms in dBFS. Rule for one-shots: below -60 |
| env | the 10 ms RMS envelope as 80 characters (`ms/char` says how much time one character covers), ten steps from `.` (45 dB below the loudest frame) to `@` (loudest). Two alarms with different rhythms print different strings |
| loop seamRatio | step across the wrap (and the second difference, which finds a slope kink) divided by the 99th percentile of the same quantity inside the file. Up to about 1 is seamless; the check fails above 2 |
| loop edge level / band diff | level and worst band-level difference between the first and the last 50 ms; a level difference above 3 dB fails, the band difference is printed for you to judge |
| loop swing | max minus min of the 100 ms RMS over the loop, dB; a silent window counts as -120 dB, so a loop that falls silent reads 120 dB plus the level of its loudest window; a 16-bit file has dither in the gap at about -96 dB, so there it reads 96 dB plus the loudest window (the alarm loops read 78 to 84 dB, and the swing rule is off for them: `GAPPED`); judge yourself whether the repeat would be heard as rhythm |

`--loop` on a one-shot (an alarm with silence at the end) reports FAIL because the ends differ; it
is only meant for files that are loops.

## compare.py (CLAP, laion/larger_clap_general)

```
.venv-audio/Scripts/python.exe tools/audio/listen/compare.py clip.wav --pos "a low hum of machinery" --neg "a cheap electronic beep"
.venv-audio/Scripts/python.exe tools/audio/listen/compare.py --spec tools/audio/sounds.json --dir assets/audio/render --only alarm_heat,cabin_ambience_loop
```

Cosine similarity between the clip and each description (roughly 0.0 to 0.5; only the order
matters, never the absolute value). Batch mode finds `<dir>/<category>/<id>.wav`, uses the sound's
`pos` against the global and category `neg`, and writes `assets/audio/cache/compare.json` (`--out`
to change): per sound the scores, `best`, `bestPos`, `bestNeg` and `margin` = best pos minus best
neg (`pass` if above 0). Clips shorter than 10 s are repeat-padded by the model's own processor,
longer ones are cut into 10 s windows (a tail under 2 s is dropped) and the embeddings are averaged.
Mono, resampled to 48 kHz. It is a sanity check, not a target.

## transcribe.py (Whisper, openai/whisper-small)

```
.venv-audio/Scripts/python.exe tools/audio/listen/transcribe.py line.wav --lang en --ref-text "Docking clearance granted"
```

Prints the text; with `--ref-text` or `--ref-file` also the word error rate (lower case, punctuation
removed, Levenshtein over words; 0.15 means 15 %). Whisper-small can be fragile on synthetic or
non-native voices: the Windows default voice here is German, and an English sentence read by it
came out as nonsense, so the tests pick an English voice explicitly.

## describe.py (Qwen2-Audio-7B-Instruct)

```
.venv-audio/Scripts/python.exe tools/audio/listen/describe.py clip.wav --question "What is this sound?"
```

Answers a free question about the clip (first 30 s). It runs here: 4-bit NF4 loading with
bitsandbytes for the language model, the audio encoder and the output head stay fp16. If loading
fails the tool exits with code 3 and one sentence on stderr; nothing else depends on it.
`--mode quanto` and `--mode offload` exist as fallbacks but were NOT tried, because bnb4 worked
first; treat them as untested. Answers are descriptions by a 7B model: it called the placeholder
alarm "a Siamese cat meowing" and the placeholder cabin loop "a telephone dial tone", so read them
as a prompt to look again, not as truth.

## Measured here (RTX 5080 16 GB, 2026-11-14, warm disk cache)

| model | load | GPU peak | notes |
|---|---|---|---|
| CLAP larger_clap_general | 0.7 s to 4.5 s | 0.79 GiB | whole process about 38 s the first time (imports, cold disk), about 7 s afterwards, 3 clips in one call |
| Whisper small (fp16) | 0.7 s | 0.56 GiB | 5 s of speech in well under a second |
| Qwen2-Audio-7B, bnb 4-bit | 12.3 s to 15.5 s | 6.35 to 6.45 GiB | 2.3 s for the first answer, 0.4 s for the next; process RSS not measured |

Tests: `.venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/listen/tests -v`
(22 tests, about 10 s; the model tests skip with a message when a model or the English Windows
voice is missing; the speech file is made in a temporary folder and deleted).

## Downloads in the build (build.py, fetch.py)

`fetch.py` downloads the free material listed in `assets/audio/downloads.json` (`--check` verifies
without downloading, `--credits` rewrites `CREDITS.md`). Recorded speech is not used: the owner
struck all NASA voice recordings on 2026-11-15 ("voices are generated"); the entries are listed
under `notTaken`, and a test fails if an entry marked as speech is left in `downloads.json` or in
`selection.json`. The two Quindar recordings went the same day: their excerpts carried
flight-controller speech (Whisper read it back although the mark said none). Whisper
(`listen/transcribe.py`) was run on every remaining processed NASA file; a word in the result
strikes the file, and marks in `downloads.json` come from titles, not from listening.

`build.py` writes every download of `selection.json` as a processed copy
`<out>/downloads/<id>.wav` (with a spectrogram) and the manifest points to that copy
(`process_download`, tested in `tests/test_downloads_build.py`): excerpt, at most two channels,
48 kHz, 16 bit. The recording is never multiplied at its start, so no attack is lost: where a
one-shot's first SAMPLE is above -60 dBFS (a real step) a lead-in of 1.5 ms is put in front (raised
cosine from zero to that sample, per channel, `checks.leadInMs`); where its last millisecond is above
-60 dBFS the last 30 ms are faded out (raised cosine; `checks.fadeOutMs` is the fade that was applied,
half the file for a file under 60 ms) - unless the maximum of the envelope (1 ms moving average of the
largest |sample| of the channels) lies inside that fade: a fade-out must not reach into the loudest
part. Then the recording is left as it is and a raised-cosine tail of 3 ms falling from the last
sample to zero is appended (per channel; `checks.appendedTailMs`, the file is 3 ms longer, the
last sample is 0; `checks.fadeOutMs` is then 0). A loop gets neither: its tail is crossfaded
into its head (300 ms or a tenth of the file, whichever is less; `checks.loopCrossfadeMs`). Before
that the cut of the tail moves up to 30 ms earlier, to the offset where the normalised
cross-correlation of tail and head over the crossfade is highest (`checks.loopShiftMs`, the file is
that much shorter; a steady tone is in phase with itself only at some offsets), and that
correlation (`checks.loopCorrelation`) picks the law (`checks.loopLaw`): above 0.5 the weights add to 1
(`linear`, equal gain: two copies of one signal keep their level), otherwise their squares do
(`equal-power`, cos / sin, with a divisor that takes out the part of the correlation that is left).
The last sample then runs into the first. `checks.loopZone` states the level of the zone in 50 ms
windows: `vsSourcesDb` against what the mixed tail and head would give with that law (the part the
crossfade is responsible for; above 1.5 dB it fails the loop as `loop-crossfade-level`),
`vsOutsideDb` against the 300 ms before and after the zone (includes whatever the recording
itself does there) and `outsideSpreadDb`, the range of the same windows over the rest of the loop
against the same reference. Where the first and last 50 ms still differ by more than 2 dB in level
the start is moved to the wrap point, on a 10 ms grid, where they differ least
(`checks.loopStartMs`). The seam is measured
(`loop-seam` in `checks.failed`); clipping of the source is counted (`checks.sourceClipped`, flag
`source-clipped`; runs of three or more samples within 0.1 % of the maximum, magnitudes above
full scale counted as full scale; a loud low sine can trip it); the level comes from
`DOWNLOAD_TARGETS` (short one-shots by true peak, longer ones and loops by LUFS, ceiling
-1 dBFS true peak; a long one-shot is an event and does not get the level of a bed, see the table).
`checks.level.gainDb` is the gain that was applied and `requestedGainDb` the one the target asked
for; they differ where the ceiling limited it (`limited`). `set_level` raises on a silent file in peak mode, and the rules (`synth/rules.py`) fail a file whose peak is under -80 dBFS as `silent`. A silent channel gives correlation 0 and a level difference of about 100 dB, so a hard-panned file fails the stereo rules. `measure.py` raises a ValueError on an empty file. The manifest entry carries the real duration and channels and the same
measured numbers as a rendered sound.

## Generated sounds in the build (build.py)

`build.py` returns 1 when a generated entry is refused, missing or failed (the message is printed and the other entries are still built), as well as for failed checks and manifest problems.

Sounds made by a model that the owner heard and accepted become library sounds, with source
`generated`. At present these are eighteen sounds of MOSS-SoundEffect v2.0 (code and weights
Apache-2.0): two from round 4, four from round 5, four from round 6, eight from round 7. Six of the
eight of round 7 are processed copies ("derived") of two raw files of round 6 (see `derived`
below). Two more were withdrawn on 2026-11-18 (see below).

- `assets/audio/generated.json` is the list: `{"note", "sounds": [...], "withdrawn": [...]}`. Each entry has `id`
  (`g_...`), `standsFor` (the event of `sounds.json` it stands for), `file`, `sha256` of the raw
  file, `cut` (`startS`, `endS`), `lufs`, `en`, `de`, `origin` (model, model revision, code, code
  commit, prompt, seed, round, candidate, verdict, ratedAt, and `note` where the owner wrote one)
  and `licence`. Several sounds may stand for one event (`impact_hull_heavy`, `impact_hull_light`,
  `fold_exit`, `thruster_pulse_c`, `impact_shield_light`).
- A sound that `tools/sound/derive.py` made from a raw file of an earlier round (a room, a pitch, a
  shelf, a copied part) has one more optional object, `derived`: `parentFile` (a plain file name of
  a `.wav` in `assets/audio/generated`, committed like the raw files), `parentSha256`, `parentRound`,
  `parentCandidate`, `parentVerdict`, `process` (the list of operations exactly as `derive.py` was
  given it, as `kept.json` of the round holds it) and `operations` (the numbers each operation
  reported, one per operation, in the order of `process`). For such an entry `origin.prompt` and
  `origin.seed` are those of the PARENT (the entry has no prompt of its own, and `validate_manifest`
  demands one); `origin.round` and `origin.candidate` are those of the candidate the owner heard.
  The parent files are `parent_thruster_mighty_3__s11.wav` (round 6 candidate
  `ev6_2_thruster_mighty_2_moss_p3s11`, four sounds) and `parent_shield_tight_2__s11.wav`
  (`ev6_3_shield_tight_2_moss_p2s11`, two sounds).
- `withdrawn` holds sounds that were built once and that the owner then rejected (here the library
  copies `g_thruster_pulse_a` and `g_thruster_pulse_b`, rated wrong on 2026-11-18 after he had
  accepted the same raw files as candidates at a level 6 to 8 dB lower). An entry has every field
  of a sound plus `withdrawn: {date, verdict, ratedAt, reason}`. It is not built and is not in the
  manifest; its processed copy under `<out>/generated` is removed like any copy no longer in the
  list; its raw file stays in `assets/audio/generated` and nothing reports it as stray. An id that
  is in both lists is refused (the entry of `sounds` is not built, the message says so).
- The raw files lie in `assets/audio/generated/<id>.wav` and are committed, byte for byte: a run of
  the model is not reproducible bit for bit, and `assets/audio/gen` is ignored by git.
- The command is the one of every build, `.venv-audio/Scripts/python.exe tools/audio/build.py
  --manifest-only` (or a full run). `_generated_sounds` writes every entry as a processed copy
  `<out>/generated/<id>.wav` with a spectrogram, and the manifest points to that copy. The entries
  stand after the rendered sounds and before the downloads. Copies no longer in the list are
  removed. Tests: `tests/test_generated_build.py`.
- What is checked. The sha256 of the raw file: where it differs the entry is refused with a message
  and nothing is built from another file; a raw file missing on disk is reported and skipped.
  Then the cut as recorded (seconds, to the nearest sample), 48 kHz, and the ends of a one-shot made
  without a step (the same repair as for a download, `repair_oneshot_ends`). Then the level: the
  integrated loudness is set to the entry's `lufs` by measurement, and measured again after the
  gain until it is within 0.01 LU (`set_loudness`), then once more on the 16 bit file that is
  shipped. `checks.level` says `target`, `reached`, `error`, and `limited`: the true-peak ceiling of
  the download step (-1.05 dB) may stop the gain; the build then fails nothing and adds the hint
  `level-limited-by-ceiling`. Otherwise `reached` must be within 0.1 LU of `target` or the sound
  fails as `level-missed`. Clipping of the raw cut is counted (`checks.sourceClipped`) and shown as
  a hint, not a failure, because the owner heard and accepted the sound. Two runs give the same bytes.
- What is checked of `derived`, where an entry has it. `_generated_entry_problem` refuses an entry
  whose object is malformed: not an object, a key missing, a parent file name that is not a plain
  `.wav` name (no folder, no path), a sha256 that is not 64 lower case hex digits, a round that is not
  an integer, a candidate or verdict that is not text, no operations, or `operations` that do not
  follow `process` in number and in the name `op` of each. `_generated_sounds` then reads the parent
  file: a parent missing on disk, or with a sha256 that differs, refuses the entry with a message and
  the build returns 1, as a wrong raw file does. The sound itself is always built from the committed
  raw file of the entry, never from the parent: the build does not run the operations again. The
  manifest object `generated` carries `derived` as it is, and `generated_intent` says which parent
  candidate the sound was made from and by which operations with the numbers they reported (built
  from the data of the entry). A parent file that an entry names is not a stray file (the build
  reports no stray files at all). `tests/test_generated_derived.py` reads the tracked files and holds
  two things the build does not do: every file in `assets/audio/generated` is the raw file or the
  parent file of an entry, and every derived entry is reproduced sample for sample
  (`derive.apply_process` on the committed parent, first channel, read as float64 and converted to
  float32, equals the float32 samples of the committed raw file; samples, not file hashes, because
  the writer puts a time stamp into the header, so two writes of the same samples differ in their
  sha256).
- Two channels. A raw file with two channels builds as a two-channel copy: the cut, the conversion
  to 48 kHz, the repair of the ends and the loudness measurement (`set_loudness`) work on both
  channels, and the copy, its spectrogram and `channels: 2` in the manifest follow. `g_thruster_heavy_room_wide`
  is the one such sound at present. Nothing in `build.py` needed repair for it;
  `tests/test_generated_derived.py` (class `TwoChannels`) holds it, with two different channels.
- `validate_manifest` demands for a generated entry a spectrogram, a licence, a duration above 0, a
  true peak not above -1 dB and the object `generated` (`standsFor`, `model`, `prompt`, `seed`,
  `round`, `candidate`, `sha256`) and, where `generated.derived` is there, a well-formed one.
- The `lufs` of an entry is the loudness of the rendered event it stands for: `checks.lufs` of the
  entry with the id `standsFor` in `assets/audio/render/manifest.json` (as the manifest had it on
  2026-11-16 for the first eight; the four of round 6 and the eight of round 7 take it from the manifest of 2026-11-18). These levels are provisional until the mix of the game is designed. The owner heard
  the candidates of rounds 4 to 6 at another level (-34 or -35 LUFS, for the comparison). The rendered events stay.
- Round 7: levels heard and built. A library sound plays at the loudness of the rendered event it
  stands for: `checks.lufs` of `thruster_pulse_c` is -28.26 and of `impact_shield_light` -24.47 in
  `assets/audio/render/manifest.json`. Those two events were chosen because their level is the
  nearest to what the owner heard: the page copies he rated
  (`assets/audio/gen/_kept/round7/page/<candidate>.wav`) measure -27.99 to -28.00 LUFS for the
  one-channel thrusters and -24.00 and -23.97 for the two shields, so the library copies play 0.26 to
  0.27 dB and 0.47 to 0.50 dB under what he heard. The two-channel thruster was heard from a file at
  -24.98 LUFS, because the audition page plays a two-channel file about 3 dB lower than a one-channel
  file of the same loudness; it keeps that relation and gets -25.24. `standsFor` was chosen by level,
  not by meaning: `thruster_pulse_a`, `thruster_pulse_b`, `impact_shield_medium` and
  `impact_shield_heavy` still have no sound he accepted. Heard is the integrated loudness of the page
  copy as `tools/audio/listen/measure.py` measures it; built is `checks.lufs` of the shipped file in
  the manifest of a `--manifest-only` build (every one reached its target, none was limited by the
  ceiling, none has a hint):

  | id | stands for | channels | heard (LUFS) | built (LUFS) | built minus heard (dB) |
  |---|---|---|---|---|---|
  | g_thruster_heavy_room_a | thruster_pulse_c | 1 | -27.99 | -28.26 | -0.27 |
  | g_thruster_heavy_room_b | thruster_pulse_c | 1 | -27.99 | -28.26 | -0.27 |
  | g_thruster_heavy_room_wide | thruster_pulse_c | 2 | -24.98 | -25.24 | -0.26 |
  | g_thruster_heavy_room_three | thruster_pulse_c | 1 | -28.00 | -28.26 | -0.26 |
  | g_thruster_heavy_three | thruster_pulse_c | 1 | -28.00 | -28.26 | -0.26 |
  | g_thruster_heavy_hall | thruster_pulse_c | 1 | -27.99 | -28.26 | -0.27 |
  | g_impact_shield_a | impact_shield_light | 1 | -24.00 | -24.47 | -0.47 |
  | g_impact_shield_b | impact_shield_light | 1 | -23.97 | -24.47 | -0.50 |
