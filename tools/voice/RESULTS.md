# Voice comparison: results

Measured on 2026-11-15 with `tools/voice/score.py` (Whisper small reads each line back) and `tools/voice/identity.py` (speaker embedding of the Chatterbox package). Scored again after the fixes of the audit (alignment ties, words per second of raw lines); all figures below come from the new `scores.json`, `identity.json`, the `timing.json` of each run and `assets/audio/voice/retime.json`. Nobody had heard any of these files when they were measured (the owner heard the listening copies that evening, see "What was not measured"). Nothing here says how a voice sounds. Whether a voice is right is for the owner to decide on the listening copies in `assets/audio/voice/_listen/`.

## Table

Real-time factor (RTF) is synthesis time divided by audio length. Below 1 is faster than real time. All timings were taken on a busy machine: the graphics card is shared with the owner's desktop programs (about half busy when idle at the time of the audit, at times fully busy; 15-20 % busy before most of the later runs, 72 % before some), and other agents' checks (browser checks, `build.py`, a Qwen3 run) held the same lock, for up to 40 minutes at a time. So no timing is one number. The table gives the RANGE of the median RTF over the runs kept for that model and device (lowest to highest: the builder's scored run, the audit's re-times, and the three re-times of this fix). Three runs are left out of the ranges: Phonon's first builder run (0.082; it was overwritten by the scored run, 0.068), the one-line proof run of Qwen3 on the card after the adapter was pinned (2.197, one line), and the first Qwen3 run on the CPU, which had 3 lines (3.064; `retime.json` still lists it, so its lowest figure for that row is 3.064 over 6 runs) and, next to it, the builder's own median over its lines. The re-times are of the four listening lines only (computer_fold, procedural_convoy, radio_clearance, station_dock); the builder's median is over 15 lines (4 for the thin rows), so the two are not the same lines. The load from outside is in the second table.

WER is the word error rate on ordinary words; the invented names of a line are counted apart (column names: read back exactly as written, hits/total). Same voice: mean cosine similarity of one voice across its lines (higher is steadier). Voices apart: mean cosine between lines of different voices (lower is better apart). Threads: CPU threads set for the run (- on the card). The rows with 4 lines (chatterbox-nano-8t, phonon-blend, kitten-blend) are thin: their same-voice figure rests on one voice with two lines (the other voices have one line each, so no figure), and their voices-apart figure uses three voices, because the fourth (pilot_m) was never spoken. Do not rank on them.

| model | device | threads | lines | parameters | model files on disk | RTF median, range over all runs (lowest-highest) | builder's own median (its lines) | first audio s | load s | WER median | WER worst | names | same voice | voices apart | how the voices were made; problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3 | cuda | - | 15 | 0.6B Base speaks (915 M); 1.7B VoiceDesign (1,917 M) made the cast clips | 7.04 GB (4.52 + 2.52) | 1.825-2.957 (6 runs) | 1.825 (15 lines) | - | 4.88 | 0.000 | 0.143 | 15/24 | 0.938 | 0.672 | One seed, 20261115, take 1 for all four voices; clip kept, Base clone prompt per voice. Slower than real time; peak GPU 2.96 GB; no streaming |
| qwen3 | cpu | 4 | 15 | 0.6B Base speaks (915 M); 1.7B VoiceDesign (1,917 M) made the cast clips | 7.04 GB (4.52 + 2.52) | 3.647-3.838 (5 runs) | 3.838 (15 lines) | - | 1.34 | 0.000 | 0.741 | 12/24 | 0.934 | 0.654 | As on the card (same cast). float32; all 15 lines. Slower than real time; no streaming |
| chatterbox-nano | cpu | 4 | 15 | 110M | 1.94 GB | 0.651-0.792 (5 runs) | 0.651 (15 lines) | - | 2.65 | 0.045 | 0.167 | 12/24 | 0.945 | 0.683 | Clones the 4 Qwen3 cast clips; built-in voice never used. CPU only; Perth watermark always on; peak RAM 4.5 GB; no streaming |
| chatterbox-nano-8t | cpu | 8 | 4 | 110M | 1.94 GB | 0.532-0.703 (5 runs) | 0.703 (4 lines) | - | 3.26 | 0.000 | 0.083 | 5/13 | 0.959 (1 voice, 2 lines; not to be ranked) | 0.712 (3 of 4 voices spoken; not to be ranked) | As chatterbox-nano, 4 lines (the listening lines). See the thread comparison below |
| kokoro | cuda | - | 15 | 82M | 0.34 GB downloaded (model file alone 0.33 GB) | 0.011-0.173 (7 runs) | 0.011 (15 lines) | 0.09 | 1.20 | 0.000 | 0.154 | 13/24 | 0.954 | 0.752 | Weighted blends of 2-3 preset packs (origin of packs not documented). Peak GPU 0.81 GB; first audio = whole line |
| kokoro | cpu | 4 | 15 | 82M | 0.34 GB downloaded (model file alone 0.33 GB) | 0.138-0.143 (5 runs) | 0.142 (15 lines) | 1.12 | 1.19 | 0.000 | 0.154 | 13/24 | 0.955 | 0.751 | Weighted blends of 2-3 preset packs (origin of packs not documented). Pickle weights; GPL espeak-ng for invented names; best male pack graded C+ |
| phonon | cpu | 4 | 15 | 31M | 0.17 GB | 0.067-0.074 (5 runs) | 0.068 (15 lines) | 0.02 | 0.07 | 0.000 | 0.278 | 10/24 | 0.948 | 0.673 | 4 of the makers' character embeddings, as is. CPU only; loose fit to the cast; 12 of 15 lines have a pause over 0.8 s inside |
| phonon-q8 | cpu | 4 | 15 | 31M (q8) | 0.065 GB (q8 file) | 0.062-0.073 (5 runs) | 0.073 (15 lines) | 0.02 | 0.08 | 0.000 | 0.389 | 11/24 | 0.945 | 0.673 | As phonon, q8 file. Peak RAM 0.41 GB; 13 of 15 lines have a pause over 0.8 s inside |
| phonon-blend | cpu | 4 | 4 | 31M | 0.17 GB | 0.057-0.073 (5 runs) | 0.057 (4 lines) | 0.02 | 0.08 | 0.057 | 0.083 | 4/13 | 0.944 (1 voice, 2 lines; not to be ranked) | 0.764 (3 of 4 voices spoken; not to be ranked) | Weighted blends of character embeddings, 4 lines; 1 clipped line (station_dock) |
| kitten | cpu | 4 | 15 | 82M (dossier) | 0.095 GB | 0.153-0.159 (5 runs) | 0.153 (15 lines) | 1.02 | 7.89 | 0.000 | 0.154 | 13/24 | 0.961 | 0.620 | Fixed presets Martha, Vincent, Eleanor, Otis (origin not stated). Needs torch + transformers for the name fallback; output differs between identical calls |
| kitten-blend | cpu | 4 | 4 | 82M (dossier) | 0.095 GB | 0.149-0.154 (5 runs) | 0.149 (4 lines) | 1.14 | 7.82 | 0.067 | 0.143 | 5/13 | 0.974 (1 voice, 2 lines; not to be ranked) | 0.659 (3 of 4 voices spoken; not to be ranked) | 50/50 mean of two nearest presets, 4 lines; one voice (pilot_m) never spoken |

First audio: where the package cannot stream there is no figure (-). For Kokoro and Kitten it is the whole line, because each test line is one chunk. Phonon's figure comes from a second, separate streaming pass. Peak GPU memory: Qwen3 2.96 GB, Kokoro 0.81 GB. Peak RAM on CPU: Chatterbox-Nano 4.5 GB, Kitten 1.0 GB, Phonon 0.6 GB (f32) and 0.41 GB (q8). Only the 0.6B Base of Qwen3 speaks the lines; the 1.7B VoiceDesign was used once to make the four cast clips. Parameters of Kitten: 82 million, taken from `docs/reports/2026-11-15/voice-dossiers.json` (candidate Kitten TTS 2 Mini, field `params_millions`); the dossier names no further source and the builder's report gives no figure, so it was not checked against the model card. Kokoro: the repository download is 341,870,408 bytes (0.34 GB); the model file `kokoro-v1_0.pth` alone is 327 MB (0.33 GB).

Qwen3 on the CPU has all 15 lines (455.7 s of synthesis in a run of 482.6 s, load 1.34 s, 4 threads, float32, hub offline, revision pinned). Its median RTF is 3.838 on 15 lines; the three re-times on the four listening lines gave 3.647 to 3.744 and the audit's 3.729. An earlier run of only 3 lines (RTF 3.064) is replaced and not in the range. One line has a large error: `station_contract` was read back by Whisper as only 7 of its 24 words ("Got a contract if you want it."), 20 errors, WER 0.741, which is the worst WER of that row. The file has 8.96 s of audio (the same line on the card has 9.20 s and was read back whole), which is 2.68 words per second for 24 words, and a pause of 0.82 s inside. So the length speaks for a complete line with Whisper stopping at the pause, but that was not checked by ear or by a second recogniser. The median WER is not affected.

Qwen3 cast: one seed, 20261115, take 1, for all four voices. Takes 2 and 3 (seeds 20261116 and 20261117) were made for each voice but not used.

### Outside load, per run

Graphics card and processor busy (percent) just before each of the three new runs, as measured by `retime.py` (the range over the three runs). For the audit's runs the load was noted by the audit's driver when the run was queued, not at its start; for the second and third Kokoro runs and the second Qwen3 run on the card it is the audit's statement that the card was about 50 % busy.

| run | outside load noted, new runs (card and processor busy just before each run) | outside load of the audit's runs |
|---|---|---|
| qwen3/cuda | card 16-17 %, cpu 6-10 % | at queue: cpu 39 %, card 95 %; cuda_r2: card about 50 % |
| qwen3/cpu | cpu 8-14 %, card 16-18 % | at queue: cpu 77 %, card 99 % |
| chatterbox-nano/cpu | cpu 9-26 %, card 19-21 % | at queue: cpu 48 %, card 97 % |
| chatterbox-nano-8t/cpu | cpu 7-14 %, card 15-66 % | at queue: cpu 46 %, card 0 % |
| kokoro/cuda | card 16-72 %, cpu 8-22 % | at queue: cpu 67 %, card 99 %; cuda_r2: card about 50 %; cuda_r3: card about 50 % |
| kokoro/cpu | cpu 8-17 %, card 16-72 % | at queue: cpu 16 %, card 22 % |
| phonon/cpu | cpu 5-13 %, card 0-19 % | at queue: cpu 8 %, card 14 % |
| phonon-q8/cpu | cpu 2-15 %, card 0-16 % | at queue: cpu 30 %, card 13 % |
| phonon-blend/cpu | cpu 2-15 %, card 0-16 % | at queue: cpu 22 %, card 12 % |
| kitten/cpu | cpu 12-23 %, card 16-16 % | at queue: cpu 7 %, card 0 % |
| kitten-blend/cpu | cpu 10-15 %, card 17-66 % | at queue: cpu 10 %, card 10 % |

### No real person as template (owner's rule)

Three different statuses, not one: **met by method** (the voice is made by a method that needs no real voice), **stated by the makers** (their statement, not checked here), **not shown** (the makers do not say where the voice comes from). Details and sources are in `CANDIDATES.md`.

| model | no real person as template |
|---|---|
| qwen3 | met by method (VoiceDesign from a text description) |
| chatterbox-nano | met by method (speaks only in the designed Qwen3 clips) |
| kokoro | not shown (blends of presets of undocumented origin) |
| phonon | stated by the makers (the character voices were made with their voice design; their statement, not checked) |
| kitten | not shown (presets, origin not stated) |

Phonon: the voices card says the twelve character voices were made with Gradium Voice Design; that is the makers' statement. Kokoro: every voice is a blend of preset packs of undocumented origin (the male packs are graded C+ and C). Kitten: four presets as they are, and a blend of two of them; the makers do not state their origin.

### Chatterbox-Nano at 4 and 8 threads

Compared on the same four lines (computer_fold, procedural_convoy, radio_clearance, station_dock), median RTF of each run:

| source | 4 threads | 8 threads |
|---|---|---|
| builder (4 listening lines of the 15-line run; 8 threads run on its own) | 0.677 | 0.703 |
| audit re-time | 0.710 | 0.532 |
| this fix, run 1 | 0.740 | 0.559 |
| this fix, run 2 | 0.736 | 0.548 |
| this fix, run 3 | 0.792 | 0.586 |

In the four later pairs, 8 threads took 24 to 26 percent less time than 4 threads (RTF 0.532 to 0.586 against 0.710 to 0.792; every pair was measured a few minutes apart under the lock, with 7 to 26 percent of the processor busy from outside in the new runs and 46 to 48 percent in the audit's). Only the builder's pair, one 8-thread run next to the 4-thread lines of a 15-line run, shows no gain (0.703 against 0.677); why it differs was not found. So 8 threads were somewhat faster on this machine, by about a quarter, not three times. The makers' claim (3 times real time on 8 cores) was not reproduced either way: the best figure, RTF 0.53 with 8 threads, is 1.9 times real time. Whether the threads really ran on 8 cores was not measured.

Similarity of the lines to their Qwen3 clip (only for models that clone those clips): Chatterbox-Nano 0.898, Qwen3 on the card 0.944 and on the CPU 0.946. The 8-thread Chatterbox run and the blend runs have 4 lines. All figures are in `assets/audio/voice/identity.json`. The Chatterbox voice encoder is the measuring tool for every model and also conditions Chatterbox, so the numbers say how close two files are to each other, not how good a voice is, and the figure for Chatterbox itself is favoured.

Word error rate and names, median and worst of the lines: see the table. Qwen3 on the card: worst 0.143 (`procedural_convoy`, 2 errors of 14 words; the first scoring printed 3 because of an alignment tie, now fixed).

## Checks on the files

For every run: lines missing, shorter than 1 s, longer than 30 s, or outside 1.5 to 4.5 words per second. Words per second now counts the spoken words of a raw line (`computer_cargo_raw` is given as written text, 24 t, cr, and spoken as more words), so the raw cargo line no longer shows up as slow.

| run | missing | under 1 s | over 30 s | words per second outside 1.5-4.5 | pause over 0.8 s inside | clipped |
|---|---|---|---|---|---|---|
| qwen3/cuda | none | none | none | none | none | none |
| qwen3/cpu | none | none | none | none | station_contract | none |
| chatterbox-nano/cpu | none | none | none | none | radio_patrol | none |
| chatterbox-nano-8t/cpu | 11 of 15 not run | none | none | none | none | none |
| kokoro/cuda | none | none | none | none | computer_contact | none |
| kokoro/cpu | none | none | none | none | computer_contact | none |
| phonon/cpu | none | none | none | radio_readback 1.46, radio_mayday 1.32 | 12 lines | none |
| phonon-q8/cpu | none | none | none | radio_readback 1.46, radio_mayday 1.37 | 13 lines | none |
| phonon-blend/cpu | 11 of 15 not run | none | none | computer_fold 1.32 | radio_clearance, computer_fold | station_dock |
| kitten/cpu | none | none | none | none | none | none |
| kitten-blend/cpu | 11 of 15 not run | none | none | none | none | none |

The lines marked not run are the planned 4-line comparisons. No file is shorter than 1 s or longer than 30 s. The words-per-second rule flags slow speech on Phonon (radio_mayday takes about 18 s for 24 words). Phonon also leaves pauses longer than 0.8 s inside most of its lines. Whether that is a fault or a style was not judged.

## Lines Whisper read wrongly

Per run, the lines with at least one error on an ordinary word. Words are shown in the common form used for comparing: numbers cut into single digits, niner as nine, some spelling variants folded. Names are counted apart and listed in `scores.json` under each line. A recogniser error and a speech error look the same here: Whisper small mishears invented words and some ordinary ones, so the figures mix both. `computer_cargo_raw` is given to the model as raw text (24 t, cr) and scored against that text, so a model that says tons or credits is counted wrong there.

### qwen3 / cuda

- `radio_patrol` (1 error)
  - reference: unidentified lancet this is patrol kestrel 2 cut your engines and standby for customs scan do not power weapons
  - heard: unidentified lancet this is patrol kestrel 2 cut your engines and standby for custom scan do not power weapons
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination was sold a prime jump in 5 4 3 2 1
- `procedural_convoy` (2 errors)
  - reference: convoy tsiolkov gap to xanthe drift escorts ngozi cael morrow and zhenyas rest report ready pilot brakkenridge you have the lead
  - heard: convoy tsiolkov gap to xanthodrift escort snowzie kail maro and genya is rest report ready pilot brackenridge you have the lead

### qwen3 / cpu

- `radio_patrol` (1 error)
  - reference: unidentified lancet this is patrol kestrel 2 cut your engines and standby for customs scan do not power weapons
  - heard: unidentified lancet this is patrol kestrel 2 cut your engines and standby for custom scan do not power weapons
- `radio_mayday` (1 error)
  - reference: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 0 percent position qorvane 4 bearing 1 7 5 requesting immediate assistance
  - heard: mayday mayday mayday waifair 3 1 6 reactor breach hall at 2 0 percent position corvane 4 bearing 1 7 5 requesting immediate assistance
- `radio_pirate` (2 errors)
  - reference: nice cargo you are hauling drover drop 2 0 tons of it and you fly home in one piece
  - heard: nice cargo your hauling drover drop 2 0 tons of it and you fly home in one piece
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination wissoldi prime jump in 5 4 3 2 1
- `computer_fuel` (3 errors)
  - reference: fuel at 1 8 percent nearest station meridian anchorage 4 point 2 light seconds
  - heard: fool at 1 8 percent near a station meridian anchorage 4 point 2 light seconds
- `station_contract` (20 errors)
  - reference: got a contract if you want it 4 0 tons of medicine to draumheim relay and the customs boys there are not friendly pays 6 0 0 0
  - heard: got a contract if you want it
- `procedural_convoy` (2 errors)
  - reference: convoy tsiolkov gap to xanthe drift escorts ngozi cael morrow and zhenyas rest report ready pilot brakkenridge you have the lead
  - heard: convoy t silkov gap to xanth adrift escort is nozi kale morrow and genya is rest report ready pilot brockenridge you have the lead

### chatterbox-nano / cpu

- `radio_patrol` (2 errors)
  - reference: unidentified lancet this is patrol kestrel 2 cut your engines and standby for customs scan do not power weapons
  - heard: unidentified lancet this is betrull kestrel 2 cut your engines and standby for custom scan do not power weapons
- `radio_mayday` (1 error)
  - reference: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 0 percent position qorvane 4 bearing 1 7 5 requesting immediate assistance
  - heard: mayday mayday mayday wayfarer 3 1 6 reactor breach hall at 2 0 percent position corvane 4 bearing 1 7 5 requesting immediate assistance
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination yolde prime jump in 5 4 3 2 1
- `computer_warning` (1 error)
  - reference: warning shields down hull integrity 6 2 percent heat at 9 0 percent of limit
  - heard: warning shields down hall integrity 6 2 percent heat at 9 0 percent of limit
- `computer_fuel` (1 error)
  - reference: fuel at 1 8 percent nearest station meridian anchorage 4 point 2 light seconds
  - heard: fuel at 1 8 percent near station meridian anchorage 4 point 2 light seconds
- `computer_cargo_raw` (3 errors)
  - reference: cargo 2 4 t helium 3 8 t platinum or market value 9 5 0 0 0 cr
  - heard: cargo 2 4 t helium 3 at platinum or market value 9 5 0 0 0 cray
- `station_contract` (2 errors)
  - reference: got a contract if you want it 4 0 tons of medicine to draumheim relay and the customs boys there are not friendly pays 6 0 0 0
  - heard: got a contract if you wanted 4 0 tons of medicine to dromheim relay and the customs boys there are not friendly pays 6 0 0 0
- `procedural_codes` (1 error)
  - reference: squawk a k 4 4 7 docking frequency 1 1 8 point 3
  - heard: squawk a k 4 7 docking frequency 1 1 8 point 3

### chatterbox-nano-8t / cpu

- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination yolde prime jump in 5 4 3 2 1

### kokoro / cuda

- `radio_clearance` (1 error)
  - reference: drover 7 4 9 halvard control cleared to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
  - heard: drover 7 4 9 havard control clear to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
- `radio_mayday` (2 errors)
  - reference: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 0 percent position qorvane 4 bearing 1 7 5 requesting immediate assistance
  - heard: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 point 0 percent position corvin 4 bering 1 7 5 requesting immediate assistance
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination usseld prime jump in 5 4 3 2 1
- `computer_fuel` (2 errors)
  - reference: fuel at 1 8 percent nearest station meridian anchorage 4 point 2 light seconds
  - heard: fuel at 1 8 percent near a station meridian anchorage 4 point 2 light seconds
- `station_refuel` (1 error)
  - reference: refueling is done mind the lift it sticks fly safe out there
  - heard: refueling is done mine the lift it sticks fly safe out there

### kokoro / cpu

- `radio_clearance` (1 error)
  - reference: drover 7 4 9 halvard control cleared to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
  - heard: drover 7 4 9 havard control clear to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
- `radio_mayday` (2 errors)
  - reference: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 0 percent position qorvane 4 bearing 1 7 5 requesting immediate assistance
  - heard: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 point 0 percent position corvin 4 bering 1 7 5 requesting immediate assistance
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination usseld prime jump in 5 4 3 2 1
- `computer_fuel` (2 errors)
  - reference: fuel at 1 8 percent nearest station meridian anchorage 4 point 2 light seconds
  - heard: fuel at 1 8 percent near a station meridian anchorage 4 point 2 light seconds
- `station_refuel` (1 error)
  - reference: refueling is done mind the lift it sticks fly safe out there
  - heard: refueling is done mine the lift it sticks fly safe out there

### phonon / cpu

- `radio_clearance` (1 error)
  - reference: drover 7 4 9 halvard control cleared to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
  - heard: jovo 7 4 9 halvard control clear to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
- `radio_mayday` (1 error)
  - reference: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 0 percent position qorvane 4 bearing 1 7 5 requesting immediate assistance
  - heard: mayday mayday mayfair wayfair 3 1 6 reactor breach hull at 2 0 percent position corvane 4 bearing 1 7 5 requesting immediate assistance
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination sold to prime jump in 5 4 3 2 1
- `computer_warning` (1 error)
  - reference: warning shields down hull integrity 6 2 percent heat at 9 0 percent of limit
  - heard: warning shields down whole integrity 6 2 percent heat at 9 0 percent of limit
- `computer_cargo_raw` (5 errors)
  - reference: cargo 2 4 t helium 3 8 t platinum or market value 9 5 0 0 0 cr
  - heard: cargo 2 0 1 4 helium 3 8 tons platinum or market value 9 5 0 0 0 cron
- `procedural_convoy` (1 error)
  - reference: convoy tsiolkov gap to xanthe drift escorts ngozi cael morrow and zhenyas rest report ready pilot brakkenridge you have the lead
  - heard: convoy t s ilkov gap to santadrift escorts ngozi kl moro and zenya is rest report ready pilot brockenridge you have the lead

### phonon-q8 / cpu

- `radio_clearance` (1 error)
  - reference: drover 7 4 9 halvard control cleared to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
  - heard: jovr 7 4 9 halvard control clear to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
- `radio_mayday` (1 error)
  - reference: mayday mayday mayday wayfarer 3 1 6 reactor breach hull at 2 0 percent position qorvane 4 bearing 1 7 5 requesting immediate assistance
  - heard: mayday mayday rave error 3 1 6 reactor breach hull at 2 0 percent position corvane 4 bearing 1 7 5 requesting immediate assistance
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination sold to prime jump in 5 4 3 2 1
- `computer_warning` (1 error)
  - reference: warning shields down hull integrity 6 2 percent heat at 9 0 percent of limit
  - heard: warning shields down whole integrity 6 2 percent heat at 9 0 percent of limit
- `computer_fuel` (1 error)
  - reference: fuel at 1 8 percent nearest station meridian anchorage 4 point 2 light seconds
  - heard: fuel at 1 8 percent mirrors station meridian anchorage 4 point 2 light seconds
- `computer_cargo_raw` (7 errors)
  - reference: cargo 2 4 t helium 3 8 t platinum or market value 9 5 0 0 0 cr
  - heard: cargo 2 0 1 4 helium 3 8 1 0 s platinum or market value 9 5 0 0 0 cron

### phonon-blend / cpu

- `radio_clearance` (1 error)
  - reference: drover 7 4 9 halvard control cleared to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
  - heard: jav 7 4 9 halvard control clear to pad 0 4 approach from the north marker hold speed below 5 0 meters per 2 nd
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination yuldu prime jump in 5 4 3 2 1
- `procedural_convoy` (1 error)
  - reference: convoy tsiolkov gap to xanthe drift escorts ngozi cael morrow and zhenyas rest report ready pilot brakkenridge you have the lead
  - heard: convoy t silkov gap to zanti drift escorts ngozi k l moro and zina is rest report ready pella brockenridge you have the lead

### kitten / cpu

- `radio_patrol` (1 error)
  - reference: unidentified lancet this is patrol kestrel 2 cut your engines and standby for customs scan do not power weapons
  - heard: unidentified lancet this is patrol kestrel 2 cut your engines and standby for custom scan do not power weapons
- `radio_pirate` (2 errors)
  - reference: nice cargo you are hauling drover drop 2 0 tons of it and you fly home in one piece
  - heard: nice cargo your hauling drover drop 2 0 tons of it and you fly home in one piece
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination wild prime jump in 5 4 3 2 1
- `computer_fuel` (2 errors)
  - reference: fuel at 1 8 percent nearest station meridian anchorage 4 point 2 light seconds
  - heard: fuel at 1 8 percent near a station meridian anchorage 4 point 2 light seconds
- `computer_cargo_raw` (1 error)
  - reference: cargo 2 4 t helium 3 8 t platinum or market value 9 5 0 0 0 cr
  - heard: cargo 2 4 t helium 3 8 t platinum or market value 9 5 0 0 0 kister
- `station_dock` (1 error)
  - reference: welcome to vashti okonkwo yard your delvers in bay 9 repairs will take about 1 0 minutes and it will not be cheap
  - heard: welcome to vashti okonkoyard your delvers in bay 9 repairs will take about 1 0 minutes and it will not be cheap

### kitten-blend / cpu

- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination wild prime jump in 5 4 3 2 1
- `station_dock` (1 error)
  - reference: welcome to vashti okonkwo yard your delvers in bay 9 repairs will take about 1 0 minutes and it will not be cheap
  - heard: welcome to vashti okonkoyard your delvers in bay 9 repairs will take about 1 0 minutes and it will not be cheap
- `procedural_convoy` (2 errors)
  - reference: convoy tsiolkov gap to xanthe drift escorts ngozi cael morrow and zhenyas rest report ready pilot brakkenridge you have the lead
  - heard: convoy tsiolkov gap to zanddrift iskorts and gosi kiel moro and jeaniez rest report ready pilot brackenridge you have the lead

## How the scoring was checked

The first run showed spelling differences that are no speech error. `score.py` folds them on both sides (see `_spelling_fold`): the filler spelling er (it appeared before Halvard in five models, so it reads as Whisper's spelling of a pause), stand by and standby, km and kilometers, the roman iii for 3, and the homophones ore and or. Real differences stay as errors: hull heard as hall or whole, customs as custom, mind as mine, clear for cleared. Your for you are may be a Whisper homophone slip; it was not folded. Kokoro's 2 point 0 percent for twenty percent was also left as an error.

The audit found that a tie in the alignment inside a name run gave a neighbouring ordinary word to the name, so that Qwen3 on the card, `procedural_convoy`, showed 3 errors where a hand count gives 2 (drift lost inside xanthodrift; escorts heard as escort). `score.py` now chooses, among alignments of equal cost, the one with the fewest errors on ordinary words, and counts the words per second of raw lines by their spoken words. After the new scoring the only line whose error count changed is that one (compared line by line with the earlier `scores.json`: error counts and name hits of all other lines are the same); the median WERs did not change. Tests: `.venv-audio/Scripts/python.exe tools/voice/tests/test_score.py` (all pass).

## Countdown on a one-second grid (2026-11-15)

After the round-3 samples the owner wrote in the chat: "Die Stimmen sind wirklich gut, allerdings ist der Countdown-Rhythmus noch kaputt. Vielleicht sollte man die Zahlen einzeln aufnehmen und deterministisch abspielen lassen" On the page he rated the five ship-computer lines "close", each with the same note (`assets/audio/rounds/round3-ratings.json`): "Countdown wird nicht wirklich in Sekunden gezählt, die Abstände sind unregelmäßig und kürzer". `tools/voice/countdown.py` is the answer to that; it makes listening samples, not the game's runtime.

What was measured in the two lines he heard (`computer_fold`, the vowel onsets of "five" to "one", intervals in ms, target 1000): Qwen3 630.4, 462.6, 466.0, 181.2; Chatterbox-Nano 745.7, 642.9, 657.2, 598.4 (the builder). The independent check measured the same files with three detectors (`voicing`, `band15` and `env50` in its report) and found the same pattern: Qwen3 between 180 and 633 ms, Chatterbox-Nano between 568 and 752 ms.

How the four samples are built, per model (Qwen3 on the card, Chatterbox-Nano on the processor, voice `computer`): 4 takes of the whole line and 6 takes of each of "Five." to "One.". In the variant `single` the five numbers are the takes spoken alone; in `list` they are cut out of one take of the whole line at the word boundaries (Whisper time stamps, refined to the level minimum between two words). The intro ("Fold drive charged. Destination: Ysolde Prime. Jump in") comes from one list take in both variants. Takes are chosen by measurement only. A single take passes when Whisper reads it as the number (the spelled number or its digit; "for", "to" and "won" are not accepted), its sounding part is 0.2 to 0.8 s long, its level is within 3 dB of the median of the takes that read right, and a vowel onset is found; of the passing takes the one whose voice embedding is nearest to the intro wins. A list take is chosen by the number of words that pass, then by the same similarity. The words are set to the sounding level of the intro by gain only.

The anchor of a word is the onset of its vowel: the first moment from which the level in the band 300 to 3000 Hz stays within 15 dB of the word's maximum and the signal is periodic for 20 ms. Each word is placed so that its anchor lies exactly 48,000 samples (1 s at 48 kHz) after the one before; each word gets a fade of 5 ms at both ends and is never shortened. "Five" sits 0.45 s after the end of the intro (4.978 s into the Qwen3 files, 5.357 s into the Chatterbox files). The file ends one second after the onset of "one", the moment of the jump: 478,944 samples (9.978 s) for Qwen3 and 497,136 samples (10.357 s) for Chatterbox-Nano, one channel, loudness set by gain to -23 LUFS with a true-peak limit of -3 dB. The files are in `assets/audio/voice/_countdown/<model>__<variant>.wav` with a `.json` each and `measure.json`; they are on the audition page as `voice_5_countdown_1_qwen3_single`, `_2_qwen3_list`, `_3_chatterbox_single` and `_4_chatterbox_list` (`tools/voice/publish.py`, block `composed` of `listening.json`).

What the builder measured on the finished files, blind (the words found by the silence between them, not from the placement table): 1000.0 ms for all four intervals of all four files, also on the published 16-bit copies. That is by construction; it shows that the placement is exact, not that the onset is where a listener hears the beat. With a level criterion of 10 dB or 20 dB instead of 15 dB the same files give intervals between 928 and 1077 ms.

What the independent check confirmed: the three detectors put the median interval of every file between 991.8 and 1009.9 ms; the largest deviation of a single detector from 1000 ms is 57.5 ms (Chatterbox-Nano `list`, voicing detector), and the detectors disagree on the onset of one word by 10.4 to 76.8 ms. Whisper reads the numbers in order in all four files. The sounding level of the five words differs by 0.67 to 1.02 dB (whole-word RMS 1.29 to 1.95 dB). The files begin and end without a step. The manifest has 132 sounds and validates; `audition-check` passed 48 of 48 with no fault caused by the page. The two Chatterbox files list four clicks each (three of them in the shared intro; the `list` file has one at 8.281 s inside "two" with a step ratio of 3 or more); the Qwen3 files list none. `tools/voice/tests/test_countdown.py` passes.

What could not be confirmed: that the onset of the vowel is the beat a listener hears in each number (its report states this as not verified), and how much of the 1000 ms grid survives a different onset definition (see above). Nobody has heard these four files, and the owner has not rated them.

## What was not measured

- How any voice sounds, and whether a voice fits its role. Nobody who made or measured the files listened. The owner heard the twenty samples in round 3 on the evening of 2026-11-15 and rated six of them "close" (the five ship-computer lines and the Qwen3 docking line); he named no model.
- Whether a Phonon, Kokoro or Kitten blend is one coherent speaker. The similarity figures only say the embeddings stay close.
- Whisper small is one recogniser. A name it cannot spell is no proof that the model said it wrongly.
- Timings: every timing was taken on a busy machine. The graphics card is shared with the owner's desktop programs (about half busy when idle at the time of the audit, 95 to 100 percent in some audit runs, 15 to 72 percent before the later runs), and other agents' checks held the same lock for up to 40 minutes. The processor was loaded by other agents at times (up to 88 percent in the audit's Qwen3 run). The ranges in the table show how far a figure moved; the lowest figure is the best case, not the typical one. The Kokoro and Qwen3 figures on the card moved most (Kokoro 0.011 to 0.173, Qwen3 1.825 to 2.957). A run with the desktop programs closed was not made. Phonon f32 gave 0.082 and 0.068 in the builder's two runs; the cause of that spread was not measured.
- Whether the thread limits hold on the CPU runs.
- Qwen3 `station_contract` on the CPU: whether the file says the whole line.
- Chatterbox-Nano on the card: not tried.
- Time to first audio for Qwen3 and Chatterbox-Nano: the packages do not stream.
- Countdown: whether the vowel onset is the perceived beat of each number, and how the four composed countdowns sound. Nobody listened.
