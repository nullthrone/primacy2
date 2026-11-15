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

    .venv-sound/<key>/Scripts/python.exe tools/sound/adapters/<key>.py [--family hull] [--seeds 11,12]

It makes every prompt of `prompts.json` with every seed and writes, under
`assets/audio/gen/<key>/` (ignored by git):

- `raw/<prompt>__s<seed>.wav`: exactly what the model returned (its sample rate, its channels);
- `gen.json`: per file the text given, the seed, the settings, the time it took.

The recordings have no adapter: cut excerpts go to `assets/audio/gen/oga/raw/<family>__<name>.wav`
with the same kind of record (the source file, the cut in seconds, the item's page and licence).

## How candidates are chosen

`screen.py` (run with the environment of the sound library, which it only reads) cuts the event
out of each raw file, and throws out only what is broken: silence, clipping, speech or music
(the speech recogniser and CLAP say so), several events where one was asked for, an event cut
off by the end of the file. It does NOT rank by the measures of round 2 (share of energy per
band, attack): the direction samples of round 3 met those and he still disliked them. Among what
is left it picks for variety, so that the candidates of a family differ from each other.

On the page every candidate gets the same treatment: the level of its family, no step at either
end, the cabin not baked in but only lightly added (`dry` false), a fixed place ahead where it
has one channel. `publish.py` writes them as the category "Klangquellen (Runde 4)".

Nobody can hear here. Whether a candidate is right is the owner's click.
