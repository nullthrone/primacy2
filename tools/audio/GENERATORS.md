# Ways to make sound that is not made by formula

After round 3 the owner said of the rendered sounds: "we are slowly going in the right direction,
but everything still sounds too artificial and boring. Are there no better local models for
generating audio?" Over three rounds the ratings show one pattern: long beds pass and short
events fail, from every source (rendered by formula or recorded; the one short event he ever
approved is a recorded low boom). So the aim is the first short event he accepts, and every source
is a candidate for it. This file records what was looked at on 2026-11-15, with the licence read at
the source (the dossiers are in `docs/reports/2026-11-15/sound-generator-dossiers.json`). The
same evening the owner approved three downloads for a listening test ("Ja, alle laden"):
MOSS-SoundEffect v2.0, Stable Audio 3 Small-SFX Base and CC0 recordings from OpenGameArt. Those
three were run on 2026-11-15 and 16 (section "What was run" below). The test is `tools/sound`.

The owner's rules, as for everything taken into the repository: nothing with non-commercial,
research-only or no-derivatives terms; a licence with a revenue cap or a duty to register is not
free use and is his decision; a gated repository needs his own login; it must run on his
computer (one RTX 5080, 16 GB, Windows).

## Models that make sound from a text description

No model passes every rule without an open point.

| model | licence of the weights | trained on | makes | size | open points |
|---|---|---|---|---|---|
| Stable Audio 3 Small-SFX (Stability AI, 2026-05) | Stability AI Community License: free for research and non-commercial use; commercial use needs registration and ends above USD 1,000,000 of yearly revenue; a notice and "Powered by Stability AI" when the model or a product using it is distributed; "You own any outputs" | 472,618 Freesound recordings (CC0, CC-BY, Sampling+) and 806,284 licensed from AudioSparx | sound effects only, 44.1 kHz, two channels, any length up to 120 s; also editing of a given sound | 3.5 GB; about 2 GB of graphics memory | the finished checkpoint is gated (form, licence and Google's Gemma terms to accept, a login); the ungated sibling Small-SFX Base (4.5 GB of weights on disk, same licence) is the version before its last training stage, and it is the one that was run. Whether the notice duty reaches a game that ships only generated files is not stated. The owner decides. |
| MOSS-SoundEffect v2.0 (OpenMOSS, 2026) | Apache-2.0, not gated | not stated by the makers | sound effects and short percussive clips, 48 kHz, up to 30 s | 11.2 GB | training data undisclosed; no statement on outputs; the VAE file is a pickle (loaded with `weights_only=True`, see below); it runs on native Windows with one change (see below) |
| EzAudio XL (2024, updated 2026-09) | MIT, not gated | AudioSet and VGGSound (clips from YouTube), no licence stated for the audio | sound effects, 24 kHz only | about 15 GB with its text encoder | 24 kHz has nothing above 12 kHz; pickle checkpoints; training audio of unstated licence |
| SoundCTM-DiT (Sony, 2025) | CC-BY 4.0 (credit Sony), not gated | AudioCaps and AudioSet (YouTube) | sound effects, 44.1 kHz, fixed 10 s | about 7 GB | pinned to a PyTorch that predates this graphics card; pickle checkpoints |
| Make-An-Audio 2 (2023) | MIT | includes WavCaps (academic use only) | 16 kHz class | 7.3 GB | old; training data with academic-only terms |
| Dasheng-AudioGen (Xiaomi) | permissive tag | not stated | mixed scenes with speech | 8.7 GB | needs `trust_remote_code`: not taken |

Fail on the licence (non-commercial, research only, or a regional clause): Stable Audio's
research cousins TangoFlux and Tango 2, AudioLDM 2, AudioGen and MAGNeT (Meta), MMAudio,
ThinkSound, PrismAudio, HunyuanVideo-Foley, FoleyCrafter, AudioX, Auffusion, Woosh (Sony AI),
MOSS-SoundEffect v1 (too large for 16 GB), RAVE (code and models non-commercial).

## Recorded sound

| source | licence | holds | open points |
|---|---|---|---|
| OpenGameArt, sound effects marked CC0 | CC0 per item, no account needed | metal hits and clangs, machine loops, switches, doors, drills, engine loops, power-down; small clips of mixed quality | ten items taken (see below), the licence line of each read again on 2026-11-16; little heavy hydraulics |
| Wikimedia Commons | per file: CC0, public domain or CC-BY | alarms, hums, vents, machine power-up | CC-BY files need a credit each; few heavy impacts |
| Freesound, CC0 filter | CC0 per file | the largest free source of heavy impacts, hydraulics, servos, relays, arcs | a download needs an account: the owner's own |
| OpenAIR impulse responses (University of York) | CC-BY 4.0 for the pages read | rooms and spaces for convolution | credit per response; read from an archived copy |
| The owner's own phone recordings | his | see `RECORDINGS.md` | none |

Fail: the Sonniss GameAudioGDC bundles (no redistribution as sound files, so not in an open
repository), the BBC archive (personal and educational use), paid packs on itch.io.

## How a generated or recorded sound enters the library

Whatever the source, a sound goes through the same door as a download today
(`build.py`, processed copies): level from the table, no step at either end, loops crossfaded,
a record of where it came from and under which terms. Generated sound is raw material like a
recording: it can be layered with a rendered low end or attack, cut, pitched and placed. The
rules of `SOUND_DESIGN.md` then apply to the result, and the owner's ear decides.

None of that has happened yet. The sixteen candidates of round 4 are listening copies on the
audition page (`tools/sound/screen.py`, `publish.py`), not library entries; no event sound is made
from these sources, and `build.py` and the rules in `tools/audio` are unchanged. That waits for
his ratings.

## What was run (2026-11-15 and 16)

Both models ran on the owner's RTX 5080 (16 GB, Windows), each in its own environment under
`.venv-sound/`, offline, no token. Each made 72 candidates (4 families, 3 prompts in
`tools/sound/prompts.json`, seeds 11 to 16); the same seed gave a bit-identical file. Nobody has
heard a file.

MOSS-SoundEffect v2.0 (`tools/sound/adapters/moss.py`, run 2026-11-15):

- Code OpenMOSS/MOSS-TTS at commit `934d6826b084c46a0d033402174d5f8ac4ed2519`; weights at revision
  `e35df4d82fbe87fcd5d14e5d100e349c0c3c076d`. Makers' defaults: 100 steps, cfg 4.0, sigma shift 5.0,
  bfloat16, 48 kHz, one channel.
- Needed: `TORCHDYNAMO_DISABLE=1` before torch is imported (the denoiser is wrapped in
  `torch.compile` with Triton CUDA graphs, an open issue on native Windows; same maths, not
  compiled). The VAE file is a pickle and the makers' loader calls `torch.load` without
  `weights_only`; the adapter loads it with `weights_only=True` (it holds only `OrderedDict`,
  `FloatStorage` and `_rebuild_tensor_v2`; the allow-list is empty). On the shared 16 GB card the
  text encoder (4 GB) stays on the processor between prompts and the denoiser (5.7 GB) moves
  there while the 30 s latent is decoded; the numbers do not change.
- A candidate took 17 to 18 s with the card free; while a game of the owner's held 4 to 4.6 GB of
  it, four took 384 to 547 s each. Its decoder ends in a tanh: 49 of 72 raw files peak above 0.99
  (orchestrator, 2026-11-16, `tools/sound/RESULTS.md`).
- Licence Apache-2.0 (model card; no LICENSE file in the repository). Training data and terms for
  outputs are not stated; the licences of the DAC VAE and `descript-audiotools` were not read.

Stable Audio 3 Small-SFX Base (`tools/sound/adapters/sa3.py`, run 2026-11-15, again 2026-11-16):

- Code Stability-AI/stable-audio-3 (MIT) at commit `790793b89ddceea612be9ce42ff6830d18f6fa57`;
  weights stabilityai/stable-audio-3-small-sfx-base at revision
  `b332479a012f83c24c4381f331ce594284ec8a81`. 50 steps, cfg 7, euler, float16, prefix
  "TrackType: SFX, " (makers' guide; not confirmed for the base), 44.1 kHz, two channels. A
  candidate took 1.6 to 2.8 s after a first call of 18 s; the reports do not say whether the
  card was shared.
- Needed: the `model_config.json` of the base names its text encoder in the gated sibling
  repository. The adapter changes that configuration in memory (drops `repo_id` and `subfolder`,
  points `model_path` at `t5gemma-b-b-ul2/` of the base). The sibling was never contacted; that
  the two encoders are equal was not checked.
- The makers' `generate()` ends with `.clamp(-1, 1)`; the first run kept that audio and 41 of 72
  files were thrown out as clipped. The second run calls `generate(return_latents=True)` (the
  makers' own switch, no clamp) and decodes with `pretransform.decode`, as `sample_diffusion()`
  does, then cuts to the length: no gain, no clamp. Builder's test: wherever the old file is below
  full scale the new one is identical (72 of 72); 50 files go above it, up to 1.9365. The
  independent check re-made two files bit for bit. Old files: `raw_clamped/`. The makers' own tools
  clamp too, so these files are levelled down before they are played.
- Licence: Stability AI Community License. Testing is free; use in a product needs registration
  and ends above USD 1,000,000 of yearly revenue; the text encoder is under Google's Gemma Terms
  of Use. Every file is test material until the owner decides; the page says so on each.

OpenGameArt (CC0, `tools/sound/adapters/oga.py`):

- First run: nothing fetched. `check_url` in `tools/audio/fetch.py` allowed only kenney.nl and
  nasa.gov; the agent's attempt to add the host was refused as a change to a safety control. The
  orchestrator added the exact host `opengameart.org` (no subdomain) with tests, because the
  owner's approval named it, and told him. An allow-list is changed in the open, not by a sub-agent.
- Second run: twelve items planned, ten fetched through `fetch.py` (16.3 MB; `--check` 35 entries,
  0 problems); each page reads "License(s): CC0" and nothing else (2026-11-16). Dropped: the chain
  winch (its author writes that he synthesised the sound) and the circuit breaker (its page gives
  no reason why the uploader may release another author's work; it can be added back on the
  owner's word). 21 excerpts came from 9 of the ten items, cut by level and file name; the
  elevator door has none (cut off by the end of its file). Three pages say "recorded"; for the
  rest it is not established.

Screening, levelling and the sixteen: `tools/sound/README.md` and `RESULTS.md`. Builders' numbers:
`sound-*.json` in `docs/reports/2026-11-15/` and `2026-11-16/`.
