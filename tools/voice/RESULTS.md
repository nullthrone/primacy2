# Voice comparison: results

Measured on 2026-11-15 with `tools/voice/score.py` (Whisper small reads each line back) and `tools/voice/identity.py` (speaker embedding of the Chatterbox package). Nobody has heard any of these files. Nothing here says how a voice sounds. Whether a voice is right is for the owner to decide on the listening copies in `assets/audio/voice/_listen/`.

## Table

Real-time factor (RTF) is synthesis time divided by audio length. Below 1 is faster than real time. WER is the word error rate on ordinary words; the invented names of a line are counted apart (column names: read back exactly as written, hits/total). Same voice: mean cosine similarity of one voice across its lines (higher is steadier). Voices apart: mean cosine between lines of different voices (lower is better apart). Threads: CPU threads set for the run (- on the card). Rows with 3 or 4 lines are thin; do not rank on them.

| model | device | threads | lines | parameters | model files on disk | RTF median | first audio s | load s | WER median | WER worst | names | same voice | voices apart | how the voices were made; problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3 | cuda | - | 15 | 0.6B Base speaks; 1.7B VoiceDesign made the cast clips | 7.04 GB (4.52 + 2.52) | 1.825 | - | 4.88 | 0.000 | 0.214 | 15/24 | 0.938 | 0.672 | VoiceDesign from a text description (seeds 20261115-17), clip kept, Base clone prompt per voice. slower than real time; peak GPU 2.96 GB; no streaming |
| qwen3 | cpu | 4 | 3 | 0.6B Base speaks; 1.7B VoiceDesign made the cast clips | 7.04 GB (4.52 + 2.52) | 3.064 | - | 3.89 | 0.000 | 0.083 | 4/6 | - | 0.651 | VoiceDesign from a text description (seeds 20261115-17), clip kept, Base clone prompt per voice. float32; only 3 lines were run (one per voice) |
| chatterbox-nano | cpu | 4 | 15 | 110M | 1.94 GB | 0.651 | - | 2.65 | 0.045 | 0.167 | 12/24 | 0.945 | 0.683 | Clones the 4 Qwen3 cast clips; built-in voice never used. CPU only; Perth watermark always on; peak RAM 4.5 GB; no streaming |
| chatterbox-nano-8t | cpu | 8 | 4 | 110M | 1.94 GB | 0.703 | - | 3.26 | 0.000 | 0.083 | 5/13 | 0.959 | 0.712 | as chatterbox-nano, 4 lines. 8 threads gave no speedup; 4 lines only |
| kokoro | cuda | - | 15 | 82M | 0.33 GB | 0.011 | 0.09 | 1.20 | 0.000 | 0.154 | 13/24 | 0.954 | 0.752 | Weighted blends of 2-3 preset packs (origin of packs not documented). peak GPU 0.81 GB; first audio = whole line |
| kokoro | cpu | 4 | 15 | 82M | 0.33 GB | 0.142 | 1.12 | 1.19 | 0.000 | 0.154 | 13/24 | 0.955 | 0.751 | Weighted blends of 2-3 preset packs (origin of packs not documented). pickle weights; GPL espeak-ng for invented names; best male pack graded C+ |
| phonon | cpu | 4 | 15 | 31M | 0.17 GB | 0.068 | 0.02 | 0.07 | 0.000 | 0.278 | 10/24 | 0.948 | 0.673 | 4 of the makers' fantasy character embeddings, as is. CPU only; loose fit to the cast; 12 of 15 lines have a pause over 0.8 s inside |
| phonon-q8 | cpu | 4 | 15 | 31M (q8) | 0.065 GB (q8 file) | 0.073 | 0.02 | 0.08 | 0.000 | 0.389 | 11/24 | 0.945 | 0.673 | as phonon. q8 file; one run; 13 of 15 lines have a pause over 0.8 s inside |
| phonon-blend | cpu | 4 | 4 | 31M | 0.17 GB | 0.057 | 0.02 | 0.08 | 0.057 | 0.083 | 4/13 | 0.944 | 0.764 | Weighted blends of character embeddings, 4 lines. 4 lines only; 1 clipped line (station_dock) |
| kitten | cpu | 4 | 15 | not read (int8 ONNX, 83 MB) | 0.095 GB | 0.153 | 1.02 | 7.89 | 0.000 | 0.154 | 13/24 | 0.961 | 0.620 | Fixed presets Martha, Vincent, Eleanor, Otis (origin not stated). needs torch + transformers for the name fallback; output differs between identical calls |
| kitten-blend | cpu | 4 | 4 | not read (int8 ONNX, 83 MB) | 0.095 GB | 0.149 | 1.14 | 7.82 | 0.067 | 0.143 | 5/13 | 0.974 | 0.659 | 50/50 mean of two nearest presets, 4 lines. 4 lines only; one voice (pilot_m) never spoken |

First audio: where the package cannot stream there is no figure (-). For Kokoro and Kitten it is the whole line, because each test line is one chunk. Phonon's figure comes from a second, separate streaming pass. Peak GPU memory: Qwen3 2.96 GB, Kokoro 0.81 GB. Peak RAM on CPU: Chatterbox-Nano 4.5 GB, Kitten 1.0 GB, Phonon 0.6 GB (f32) and 0.41 GB (q8). Only the 0.6B Base of Qwen3 speaks the lines; the 1.7B VoiceDesign was used once to make the four cast clips.

Similarity of the lines to their Qwen3 clip (only for models that clone those clips): Chatterbox-Nano 0.898, Qwen3 on the card 0.944. The Qwen3 CPU run has 3 lines, one per voice, so it has no same-voice figure. The 8-thread Chatterbox run and the blend runs have 4 lines. All figures are in `assets/audio/voice/identity.json`. The Chatterbox voice encoder is the measuring tool for every model, so the numbers say how close two files are to each other, not how good a voice is.

## Checks on the files

For every run: lines missing, shorter than 1 s, longer than 30 s, or outside 1.5 to 4.5 words per second.

| run | missing | under 1 s | over 30 s | words per second outside 1.5-4.5 | pause over 0.8 s inside | clipped |
|---|---|---|---|---|---|---|
| qwen3/cuda | none | none | none | none | none | none |
| qwen3/cpu | 12 of 15 not run | none | none | none | none | none |
| chatterbox-nano/cpu | none | none | none | none | radio_patrol | none |
| chatterbox-nano-8t/cpu | 11 of 15 not run | none | none | none | none | none |
| kokoro/cuda | none | none | none | computer_cargo_raw 1.44 | computer_contact | none |
| kokoro/cpu | none | none | none | computer_cargo_raw 1.44 | computer_contact | none |
| phonon/cpu | none | none | none | radio_readback 1.46, radio_mayday 1.32, computer_cargo_raw 1.49 | 12 lines | none |
| phonon-q8/cpu | none | none | none | radio_readback 1.46, radio_mayday 1.37, computer_cargo_raw 1.40 | 13 lines | none |
| phonon-blend/cpu | 11 of 15 not run | none | none | computer_fold 1.32 | radio_clearance, computer_fold | station_dock |
| kitten/cpu | none | none | none | none | none | none |
| kitten-blend/cpu | 11 of 15 not run | none | none | none | none | none |

The lines marked not run are the planned 4-line comparisons and the 3-line Qwen3 CPU run. No file is shorter than 1 s or longer than 30 s. The words-per-second rule flags slow speech: Kokoro on the raw cargo line, and Phonon on several lines (radio_mayday takes about 18 s for 24 words). Phonon also leaves pauses longer than 0.8 s inside most of its lines. Whether that is a fault or a style was not judged.

## Lines Whisper read wrongly

Per run, the lines with at least one error on an ordinary word. Words are shown in the common form used for comparing: numbers cut into single digits, niner as nine, some spelling variants folded. Names are counted apart and listed in `scores.json` under each line. A recogniser error and a speech error look the same here: Whisper small mishears invented words and some ordinary ones, so the figures mix both. `computer_cargo_raw` is given to the model as raw text (24 t, cr) and scored against that text, so a model that says tons or credits is counted wrong there.

### qwen3 / cuda

- `radio_patrol` (1 error)
  - reference: unidentified lancet this is patrol kestrel 2 cut your engines and standby for customs scan do not power weapons
  - heard: unidentified lancet this is patrol kestrel 2 cut your engines and standby for custom scan do not power weapons
- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination was sold a prime jump in 5 4 3 2 1
- `procedural_convoy` (3 errors)
  - reference: convoy tsiolkov gap to xanthe drift escorts ngozi cael morrow and zhenyas rest report ready pilot brakkenridge you have the lead
  - heard: convoy tsiolkov gap to xanthodrift escort snowzie kail maro and genya is rest report ready pilot brackenridge you have the lead

### qwen3 / cpu

- `computer_fold` (1 error)
  - reference: fold drive charged destination ysolde prime jump in 5 4 3 2 1
  - heard: full drive charged destination wissoldi prime jump in 5 4 3 2 1

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

The first run showed spelling differences that are no speech error. `score.py` now folds them on both sides (see `_spelling_fold`): the filler spelling er (it appeared before Halvard in five models, so it reads as Whisper's spelling of a pause), stand by and standby, km and kilometers, the roman iii for 3, and the homophones ore and or. Effect: the median WER of Kitten, Kokoro and Qwen3 went to 0.000, and that of Chatterbox-Nano from 0.067 to 0.045. Real differences stay as errors: hull heard as hall or whole, customs as custom, mind as mine, clear for cleared. Your for you are may be a Whisper homophone slip; it was not folded. Kokoro's 2 point 0 percent for twenty percent was also left as an error. Tests: `.venv-audio/Scripts/python.exe tools/voice/tests/test_score.py` (all pass).

## What was not measured

- How any voice sounds, and whether a voice fits its role. Nobody listened.
- Whether a Phonon, Kokoro or Kitten blend is one coherent speaker. The similarity figures only say the embeddings stay close.
- Whisper small is one recogniser. A name it cannot spell is no proof that the model said it wrongly.
- Timings: other agents used the CPU between locked runs. Phonon f32 gave 0.082 and 0.068 in two runs, so single runs of q8 and the blends sit inside that spread.
- Qwen3 on CPU: three lines only. Chatterbox-Nano on the card: not tried.
- Time to first audio for Qwen3 and Chatterbox-Nano: the packages do not stream.
