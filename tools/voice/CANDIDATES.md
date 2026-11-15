# Voice comparison: candidates

What was looked at on 2026-11-15, what was taken, and why the rest was not. Source: `docs/reports/2026-11-15/voice-dossiers.json` (licence and runtime facts read at the source that day) and the five builders' reports `docs/reports/2026-11-15/voice-<key>-report.json`. Where those say "not read", this file says so too. Measured results are in `RESULTS.md`. Nobody has heard any voice.

The dossier gave each candidate a verdict: pass, unclear or fail, against the rules in `README.md`. Unclear means a rule could not be settled from what the makers publish. Five models were taken; four of them were unclear on the voice rule or on a small licence point, and were taken to measure them, not because the question is closed.

## Taken

### Qwen3-TTS (key `qwen3`)

- Repositories and revisions:
  - `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`, revision `5ecdb67327fd37bb2e042aab12ff7391903235d3`, 4,520,162,313 bytes (safetensors, 12 files incl. speech tokenizer).
  - `Qwen/Qwen3-TTS-12Hz-0.6B-Base`, revision `5d83992436eae1d760afd27aff78a71d676296fc`, 2,516,104,532 bytes (safetensors).
  - Total 7.04 GB. Package `qwen-tts` 0.1.1 from PyPI, torch 2.11.0+cu128. Environment 4.8 GB.
- Licence of code: Apache-2.0. Read at https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/main/LICENSE (the first line is blank, then "Apache License / Version 2.0, January 2004").
- Licence of weights: Apache-2.0, from the model-card metadata of both repositories (https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/raw/main/README.md and https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/raw/main/README.md: "license: apache-2.0"). Not gated. The model repositories have no LICENSE file.
- How voices are made: VoiceDesign writes a short reference clip from a text description (no real person). The Base 0.6B model builds a reusable clone prompt from that clip and speaks every line with it. Seeds 20261115 to 20261117; take 1 passed all checks for every voice. The four clips are the shared cast for the Chatterbox run.
- Open points:
  - No LICENSE file in the model repositories; the licence rests on the card metadata and the paper.
  - The training data (more than 5M hours per the paper) is not itemised.
  - Speed on the card is slower than real time with this package (RTF 1.66 to 1.96); no streaming, so no first-audio figure.
  - The CustomVoice sibling was not taken (see below).

### Chatterbox-Nano (key `chatterbox-nano`)

- Repository: `ResembleAI/chatterbox-nano`, revision `71ccd1d0081b430592cea481f4307e764e07bc64`, 1,941,930,294 bytes (8 files: `t3_nano_v1.safetensors`, `s3gen_meanflow.safetensors`, `ve.safetensors`, tokenizer files). `conds.pt` (the built-in voice) was not downloaded and the adapter checks that it is absent. Model files 1.94 GB, environment 1.7 GB.
- Package: PyPI `chatterbox-tts` 0.1.7 does not contain nano. Installed from the makers' source, commit `ab55923c27757c90cfcc407baa57dc25a7d25217`, with `--no-deps`. torch 2.6.0+cpu, transformers 5.2.0. `resemble-perth` 1.0.1 from PyPI.
- Licence of code: MIT. Read at https://raw.githubusercontent.com/resemble-ai/chatterbox/master/LICENSE (first line "MIT License"). Perth watermarker code and weights: MIT, https://raw.githubusercontent.com/resemble-ai/Perth/master/LICENSE.
- Licence of weights: MIT, card metadata at https://huggingface.co/ResembleAI/chatterbox-nano/raw/main/README.md ("license: mit"). Not gated. No LICENSE file in the repository.
- How voices are made: the model has no voice design. It speaks in the voice of a reference clip, here the four Qwen3 clips (so the voices stay artificial). The built-in voice, whose origin is not stated, is never used.
- Open points:
  - It needs a clip made by another model.
  - The Perth watermark is always on in the package and was left untouched.
  - Perth's weights are a pickle inside the PyPI package, loaded under torch 2.6's weights_only default.
  - The package pins torch 2.6.0 and transformers 5.2.0 (and gradio, not installed). The dossier calls the project retired.
  - The makers' speed claim (3x real time on 8 cores) was not reproduced: RTF 0.65 at 4 threads, 0.70 at 8.
  - Peak RAM 4.5 GB.

### Kokoro-82M v1.0 (key `kokoro`)

- Repository: `hexgrad/Kokoro-82M`, revision `f3ff3571791e39611d31c381e3a41a3af07b4987`, 341,870,408 bytes: `config.json`, `kokoro-v1_0.pth` and 28 English voice packs (`af_`, `am_`, `bf_`, `bm_`). Model files 0.33 GB, environment 4.6 GB.
- Packages: `kokoro` 0.9.4 and `misaki[en]` 0.9.4 from PyPI, torch 2.11.0+cu128, spaCy `en_core_web_sm` 3.8.0 (wheel from the explosion GitHub release, MIT, installed beforehand so misaki does not download it at run time).
- Licence of code: Apache-2.0 for kokoro (https://raw.githubusercontent.com/hexgrad/kokoro/main/LICENSE) and misaki (https://raw.githubusercontent.com/hexgrad/misaki/main/LICENSE).
- Licence of weights: Apache-2.0 from the card metadata (https://huggingface.co/hexgrad/Kokoro-82M/raw/main/README.md). Not gated. The repository has no LICENSE file.
- How voices are made: there is no voice design. A voice is a weighted mean of 2 to 3 preset packs (the package averages packs). Female blends use packs graded B- or better; both male blends rest on packs graded C+ or C.
- Open points:
  - Weights and packs are pickle files only (the makers ship nothing else); loaded with `weights_only=True`.
  - The origin of the English preset packs is not documented, and the card says part of the training audio is synthetic output of closed TTS providers, whose terms are not stated.
  - Invented names need the bundled espeak-ng (GPL-3.0, https://raw.githubusercontent.com/espeak-ng/espeak-ng/master/COPYING) and phonemizer-fork 3.3.2 (GPLv3+). Shipping or linking them needs a licence decision.
  - The browser build (kokoro-js with the ONNX repository) has the same open points; blending there is not documented. It was not run.

### Phonon 31M English (key `phonon`)

- Repositories:
  - `gradium/phonon-31m-en`, revision `92741c5b07d085ff840e26fea8ce43110b87852f`, 167,619,093 bytes (`model.safetensors`, `model.q8.gguf`, config, tokenizer).
  - `gradium/phonon-voices`, revision `0ee17205f254b5abc43b266c8a0f215565c352f7`, about 3.1 MB (12 character embeddings and `voices.jsonl`).
  - Model files 0.168 GB, environment 0.09 GB.
- Package: `ptts` 0.7.1 from PyPI (Rust extension, no PyTorch). The Windows wheel offers the CPU only.
- Licence of code: MIT or Apache-2.0. Read at https://raw.githubusercontent.com/gradium-ai/xn-ptts/main/LICENSE-MIT ("Permission is hereby granted, free of charge, to any") and `LICENSE-APACHE` in the same repository.
- Licence of weights: Apache-2.0, card metadata at https://huggingface.co/gradium/phonon-31m-en/raw/main/README.md. The 40m models of the same maker are CC BY-NC 4.0 and were not touched. Voices repository: Apache-2.0, "English character voices made with Gradium Voice Design" (https://huggingface.co/gradium/phonon-voices/raw/main/README.md); the origin of its 90 catalogue voices is not stated and none was downloaded. Not gated. No LICENSE file in the model repository.
- How voices are made: a voice is a fixed embedding file. The four cast voices are four of the twelve character embeddings, used as they are (a loose fit: fantasy characters, no man in his thirties). A blend of embeddings was written as safetensors files and run for four lines.
- Open points:
  - The Mimi codec that Phonon builds on is CC-BY-4.0 (attribution), read only, nothing downloaded from it.
  - No graphics-card run exists.
  - The in-memory `add_voice_from_embedding` call gave different audio from the same embedding loaded from a file; the blend was therefore written as files.
  - Timing varies between runs (RTF 0.082 and 0.068) because other agents used the CPU.

### Kitten TTS 2 Mini (key `kitten`)

- Repository: `KittenML/kitten-tts-2-mini`, revision `c01797caec3967b400da457656e011eb81f530a4`, 94,907,926 bytes (int8 ONNX model, `voices_en.npz`, G2P files). Model files 0.095 GB, environment 0.92 GB.
- Packages: `kittenml` 0.9.8 (`--no-deps`), onnxruntime 1.32.0, misaki 0.9.4, torch 2.15.0+cpu and transformers 5.23.0 (needed by the G2P fallback for invented names), spaCy `en_core_web_sm` 3.8.0 from the explosion GitHub release (not PyPI and not the makers' repository: a deviation from rule 3, wheel sha256 in the report).
- Licence of code: Apache-2.0. Read at https://raw.githubusercontent.com/KittenML/KittenTTS/main/LICENSE ("Apache License / Version 2.0, January 2004").
- Licence of weights: Apache-2.0, card at https://huggingface.co/KittenML/kitten-tts-2-mini/raw/main/README.md ("license: apache-2.0"; "Apache-2.0 (the models, voice packs and the bundled G2P files)"). Not gated. No LICENSE file in the repository. The en_core_web_sm licence (MIT) rests on its meta file only; the LICENSE URL tried returned 404.
- How voices are made: fixed presets chosen by name (Martha, Vincent, Eleanor, Otis). There is no voice design and no seed. A 50/50 blend of two presets was run for four lines.
- Open points:
  - The makers do not say where the preset voices come from, so the rule "no real person as template" is not shown for them.
  - Output is not reproducible: two identical calls gave different samples.
  - The English path needs torch and transformers, so the pure ONNX route does not work for English.
  - The 1.7B sibling has a custom licence and was not taken.

## Looked at and not taken

### Qwen3 siblings

- Qwen3-TTS 1.7B Base: verdict pass; not taken, the 0.6B Base was enough for cloning and smaller.
- Qwen3-TTS CustomVoice 1.7B and 0.6B: unclear; source of the nine preset voices not stated.

### Voice cloning with no design method, or voices of real people

- VoxCPM2: unclear; Apache-2.0 but the card adds prose terms (no impersonation, label AI content) that need a legal reading, 4.96 GB, no CPU speed figure (about 1.76 RTF on Apple Metal), designed timbre random per call.
- VoxCPM1.5 and VoxCPM-0.5B: fail; production use limited to research and development in the card, no voice design, 0.5B has pickle-only weights.
- Maya1: unclear; Apache-2.0 tag but a possible Llama licence lineage is not explained, 6.6 GB. maya2-native (2026-11-03): seen only, licence file and voice provenance not read.
- Orpheus TTS: fail; both English repositories gated, Llama 3.2 base.
- Chatterbox original (500M) and Turbo (350M): unclear; MIT, same indirect clip route as Nano, built-in voice of unknown origin, heavier than Nano.
- Chatterbox-Flash: fail; no CPU speed figure, a clip is always required.
- Dramabox (Resemble AI): fail; LTX-2 Community License with a revenue limit, too heavy for CPU.
- Pocket TTS (Kyutai, full repository): fail; gated.
- Pocket TTS without voice cloning (ungated twin): unclear; no method to invent a voice, some presets non-commercial-derived.
- Kyutai TTS 1.6B: fail; voices are real people, NC voice folders.
- Parler-TTS Mini v1, Large v1 and Mini Multilingual v1.1: unclear; Apache-2.0, but consistent voices only through named real dataset speakers, and one description does not promise the same voice across texts.
- Parler-TTS Mini Expresso: fail; trained on a non-commercial dataset, real speakers.
- CosyVoice 2 and Fun-CosyVoice 3: unclear; Apache-2.0, a clip always needed, CPU and Windows speed not stated.
- NeuTTS Air: fail; gated, revenue-capped code licence.
- Zonos v0.1: verdict pass; not taken, the README says CPU is too slow for interactive use and Windows is only through a third-party fork. Superseded by ZONOS3-Mini.
- ZONOS3-Mini (2026-11-14): unclear; the only model with a built-in artificial-voice method and CPU and browser runtimes, but the provenance of its 27 bundled clips and of the steering-vector training data is open. A candidate for a later round.
- ZONOS2: seen only; Linux and NVIDIA only per its card, 15.3 GB.
- Supertonic 1, 2 and 3: unclear; MIT code, OpenRAIL-M weights with use restrictions that must be passed on and a remote-restriction clause, no documented way to invent a voice.
- Ming-3.0-tts-0.5B: unclear; MIT, voice design exists, but GPU-only, pinned old transformers, reproducibility unproven.
- Audio8-TTS-Realistic-Air: unclear; clean licence, no way to invent and keep a voice, needs `trust_remote_code` (not allowed).
- Soprano-1.1-80M: unclear; one voice of unstated source, GitHub LICENSE not read.
- MOSS-TTS-Nano-100M: unclear; code Apache-2.0, weight licence wording hedged, cloning only.
- Inflect-Micro-v2: verdict pass; one voice only, which cannot cover radio, computer and staff; the v3 siblings (2026-11-12) were not read.
- AuK (Tencent): fail; needs a Qwen2.5-Omni model under a research licence.
- OmniVoice (k2-fsa): fail; weights CC-BY-NC.

### Licence fails

- Kitten TTS 2 (1.7B): fail; custom licence with a USD 1M revenue cap, attribution, use policy and no-distillation clauses.
- Kitten TTS 2 Nano and Pico: unclear; same open voice-origin point as Mini; Mini was the one taken.
- MeloTTS-English: unclear; pickle-only weights, recordings behind the five voices undocumented, no way to invent a voice.
- Piper engine and the voices en_US-ljspeech-high, en_US-libritts-high, en_GB-cori-high, en_US-joe-medium, en_US-hifi_tts_92-medium: fail; engine GPL-3.0, but every shipped voice is a real person's.
- Seen in a sweep and failing on licence (reasons as the dossier lists them): fishaudio drama-3 and s2-pro (research licence), Voxtral-4B-TTS-2603 (CC-BY-NC), higgs-tts-3-4b (non-commercial licence), Underdog-Woof (non-commercial), Phonon 40m models (CC BY-NC 4.0), IndexTTS-2.5 (bilibili licence, not read further).
- Seen in a sweep, not read further: HumeAI tada-1b (Llama 3.2 licence), VibeVoice-Realtime-0.5B (MIT tag, voices not read), MOSS-TTS-v1.5 (17 GB, cloning-focused), Ming-3.0-tts-tiny (18 GB), GLM-TTS (8.9 GB), LuxTTS (English cloning only), kugelaudio-0-open (18.7 GB, too large).
