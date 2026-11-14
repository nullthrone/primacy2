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
| centroid | spectral centre of gravity of the average power spectrum, Hz |
| bands, lowShare, highShare | share of power per band (<60, 60-125, 125-250, 250-500, 500-1k, 1-2k, 2-4k, 4-8k, >8k); low is below 500 Hz, high above 4 kHz (fractions in JSON, percent in text). Mean removed first |
| peaks, fundamental | strongest spectral peaks (Hz, dB relative to the strongest; 6 Hz bin spacing refined by interpolation) and an f0 estimate from harmonic support; `n/a` for noise-like sounds |
| onset | first time a sample reaches 40 dB below the peak (but not below -70 dBFS). Rule: at most 5 ms |
| attack | time from 10 % to 90 % of the peak amplitude, 1 ms resolution (not meaningful for speech or noise beds) |
| fall60 | milliseconds from the loudest 10 ms frame until the level is 60 dB lower; `n/a` if it never gets there |
| last10ms | RMS of the last 10 ms in dBFS. Rule for one-shots: below -60 |
| env | the 10 ms RMS envelope as 80 characters (`ms/char` says how much time one character covers), ten steps from `.` (45 dB below the loudest frame) to `@` (loudest). Two alarms with different rhythms print different strings |
| loop seamRatio | step across the wrap (and the second difference, which finds a slope kink) divided by the 99th percentile of the same quantity inside the file. Up to about 1 is seamless; the check fails above 2 |
| loop edge level / band diff | level and worst band-level difference between the first and the last 50 ms; a level difference above 3 dB fails, the band difference is printed for you to judge |
| loop swing | max minus min of the 100 ms RMS over the loop, dB; judge yourself whether the repeat would be heard as rhythm |

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
