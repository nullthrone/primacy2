# Ways to make sound that is not made by formula

After round 3 the owner said of the rendered sounds: "we are slowly going in the right direction,
but everything still sounds too artificial and boring. Are there no better local models for
generating audio?" Over three rounds the ratings show one pattern: long beds pass and short
events fail, from every source (rendered by formula or recorded; the one short event he ever
approved is a recorded low boom). So the aim is the first short event he accepts, and every source
is a candidate for it. This file records what was looked at on 2026-11-15, with the licence read at
the source; the full dossiers are in `docs/reports/2026-11-15/sound-generator-dossiers.json`. The
same evening the owner approved three downloads for a listening test ("Ja, alle laden"):
MOSS-SoundEffect v2.0, Stable Audio 3 Small-SFX Base and CC0 recordings from OpenGameArt. The test
itself is `tools/sound`.

The owner's rules, as for everything taken into the repository: nothing with non-commercial,
research-only or no-derivatives terms; a licence with a revenue cap or a duty to register is not
free use and is his decision; a gated repository needs his own login; it must run on his
computer (one RTX 5080, 16 GB, Windows).

## Models that make sound from a text description

No model passes every rule without an open point.

| model | licence of the weights | trained on | makes | size | open points |
|---|---|---|---|---|---|
| Stable Audio 3 Small-SFX (Stability AI, 2026-05) | Stability AI Community License: free for research and non-commercial use; commercial use needs registration and ends above USD 1,000,000 of yearly revenue; a notice and "Powered by Stability AI" when the model or a product using it is distributed; "You own any outputs" | 472,618 Freesound recordings (CC0, CC-BY, Sampling+) and 806,284 licensed from AudioSparx | sound effects only, 44.1 kHz, two channels, any length up to 120 s; also editing of a given sound | 3.5 GB; about 2 GB of graphics memory | gated (form, licence and Google's Gemma terms to accept); an ungated sibling, Small-SFX Base (4.8 GB, same licence), is the version before its last training stage. Whether the notice duty reaches a game that ships only generated files is not stated. The owner decides. |
| MOSS-SoundEffect v2.0 (OpenMOSS, 2026) | Apache-2.0, not gated | not stated by the makers | sound effects and short percussive clips, 48 kHz, up to 30 s | 11.2 GB | training data undisclosed; no statement on outputs; one file is a pickled model object, to be loaded only with an allow-list; Windows not confirmed (an open issue reports an error of the compiler it uses) |
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
| OpenGameArt, sound effects marked CC0 | CC0 per item, no account needed | metal hits and clangs, machine loops, switches, doors, drills, engine loops, power-down; small clips of mixed quality | each item's licence line is read and recorded; little heavy hydraulics |
| Wikimedia Commons | per file: CC0, public domain or CC-BY | alarms, hums, vents, machine power-up | CC-BY files need a credit each; few heavy impacts |
| Freesound, CC0 filter | CC0 per file | the largest free source of heavy impacts, hydraulics, servos, relays, arcs | a download needs an account: the owner's own |
| OpenAIR impulse responses (University of York) | CC-BY 4.0 for the pages read | rooms and spaces for convolution | credit per response; read from an archived copy |
| The owner's own phone recordings | his | see `RECORDINGS.md` | none |

Fail: the Sonniss GameAudioGDC bundles (no redistribution as sound files, so not in an open
repository), the BBC archive (personal and educational use), paid packs on itch.io.

## How a generated or recorded sound would enter the library

Whatever the source, a sound goes through the same door as a download today
(`build.py`, processed copies): level from the table, no step at either end, loops crossfaded,
a record of where it came from and under which terms. Generated sound is raw material like a
recording: it can be layered with a rendered low end or attack, cut, pitched and placed. The
rules of `SOUND_DESIGN.md` then apply to the result, and the owner's ear decides.
