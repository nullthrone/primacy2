# Voices: a comparison of open speech models

This directory holds a comparison, not the voice pipeline. It answers three questions before
anything is built: which open model sounds right, which may be used, and which can speak text
that the game makes up while it runs.

## What the owner decided (2026-11-15)

- The game carries no recorded voices of real people. The NASA radio recordings with speech were
  struck from the library.
- Voices come from our own pipeline, and they speak in the radio, as the ship computer and as
  station staff.
- Spoken language is English.
- The game generates much of its content, so the system must be able to speak generated text:
  rendering a fixed list of lines ahead is not enough.
- Only artificial voices: no voice has a real person as template, his own voice included.
- Further open speech models may be downloaded for a comparison, the licence read first.

## Rules for every model

1. Licence, read at the source (the LICENSE file and the model card, not a blog): nothing with
   non-commercial, research-only or no-derivatives terms, for code, weights, bundled voices and
   generated audio alike. No gated repository.
2. A voice is created with no real person as template: from a text description, by blending
   voice vectors, or by sampling. A clip that another model invented may serve as reference.
3. Weights as safetensors, ONNX or GGUF; a pickle file (`.pt`, `.pth`, `.bin`) only where the
   makers ship nothing else and it is loaded with `weights_only=True`. No `trust_remote_code`.
   Packages from PyPI or the makers' own repository, at a pinned version. A package that reports
   usage to its makers has that switched off.
4. Every model has its own environment under `.venv-voice/<key>/`. Nothing is installed into
   `.venv-audio`: the sound library is measured with it.
5. At least 10 % of the disk stays free (`df` before every download).
6. Every timed run and every use of the graphics card goes through the lock:
   `<python> tools/voice/with_lock.py -- <command>`. A timing taken while another model runs is
   worth nothing.

`CANDIDATES.md` lists what was looked at, what was taken, from where, how large and under which
licence.

## How a model is run

Every model has an adapter, `adapters/<key>.py`, run with the Python of its own environment:

    .venv-voice/<key>/Scripts/python.exe tools/voice/adapters/<key>.py --device cuda
    .venv-voice/<key>/Scripts/python.exe tools/voice/adapters/<key>.py --device cpu --threads 4

It speaks the lines of `lines.json` in the voices of `cast.json` and writes, under
`assets/audio/voice/<key>/` (ignored by git):

- `cast/<voice>.wav` and `cast/<voice>.json`: the clip or vector that fixes an invented voice, and
  how it was made;
- `<device>/<line>.wav`: one channel, the model's own sample rate, exactly what the model
  returned (no trimming, no gain);
- `<device>/timing.json`: load time, and per line the length of the audio, the time it took and
  their ratio (below 1 is faster than real time), the time to the first audio where a model
  streams, the peak of graphics memory.

`common.py` holds what the adapters share. A model that speaks from a reference clip can take the
clips of another model with `--cast-from <key>`, so that fast models are compared on the same
voices.

## How the result is measured

`score.py` runs afterwards on the files, with the environment of the sound library (it only reads
it):

- Whisper reads every line back. The word error rate counts ordinary words only; the invented
  names of a line (`names` in `lines.json`) are counted apart, because a recogniser rewrites
  words it has never seen.
- Level, clipping, silence at both ends, words per second.
- A speaker embedding says whether a voice stays the same voice from line to line, and whether
  two voices of the cast differ.

Numbers sort the field. Whether a voice is right is the owner's judgement: the lines marked
`listen` go onto the audition page, radio lines through the radio loudspeaker filter
(`tools/audio/synth/radio.py`).
