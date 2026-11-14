# Sound design: "you hear your ship, not space"

The direction for every sound in the library, the rules a sound is checked against, and the
contract between the scripts that make the sounds and the page on which the owner listens.
The list of sounds is `tools/audio/sounds.json`.

## 1. The idea

Space is silent. The pilot sits in a small metal cabin inside a machine, and everything that is
heard reaches the ear by one of four paths. Each sound belongs to exactly one (`path` in the list):

- **structure**: vibration that travels through the hull into the seat and the cabin walls.
  Engines, thrusters, hits, landing gear, the drive. Dull and heavy. Most of the energy lies below
  500 Hz and it falls off steeply above about 1.2 kHz. What rings are the hull's own modes: a fixed
  handful of inharmonic frequencies between 35 and 400 Hz that every structure sound of one ship
  excites, so that the ship has a voice of its own. A transient is a thunk, never a crack. The only
  high content is what the vibration shakes loose inside the cabin: short rattles of fittings,
  1 to 4 kHz, sparse, quiet, and only when the vibration is strong.
- **cabin**: sound made in the cabin air. Relays, switches, fans, the pilot's console. Dry, close,
  small: a short dense reverb (0.25 to 0.4 s), first reflections within 3 to 12 ms, a slightly
  boxy tone around 200 to 300 Hz.
- **sensor**: what happens outside makes no sound, so the ship's computer turns it into sound
  (sonification): a contact, a lock, a ship firing nearby, the closing distance to a pad. These are
  designed signals from a loudspeaker. Sober and functional, like avionics, never like an arcade.
- **radio**: voices and signal tones from the radio loudspeaker: band-limited (300 to 3,400 Hz),
  slightly overdriven, with squelch noise at the ends of a transmission.

- **energy**: the ship's high-energy systems discharging: the shield taking a hit, the fold drive
  tearing space open. Added on 2026-11-14 after the owner heard the first set: these must sound
  energetic, hissing and rushing, not like a dull blow ("as if someone knocked on a salad bowl").
  They are bright, broad and alive: a surge of noise that swells within milliseconds, hisses and
  tears; electrical crackle and arcing in uneven bursts; a rushing swell and release; and a low
  body underneath that gives weight. Nothing rings like struck metal, and no steady pitch stands
  out. Still hard science fiction: no "pew", no synthesiser sweep.

### Space

The owner found the first set "all very mono". Sound in the cabin has width and places:

- Enveloping sounds are files with two channels: every loop of the structure path (engines,
  thruster burn, scraping, regolith, cruise, fold tunnel, beam, mining laser) and every energy
  sound. They are made as mid and side: the mid is the sound as it was approved in mono, the side
  is more material of the same kind (the same excitation with other seeds through the same hull)
  with nothing below 150 Hz, and left is mid plus side, right is mid minus side. So the bass stays
  in the middle, the mono sum is exactly the approved sound, and the two ears get what two places
  in a shaking cabin would get.
- Point events stay files with one channel, because they have a place: a hit comes from a side, a
  thruster sits somewhere on the hull, the alarm loudspeaker hangs ahead on the left. `place` in
  the sound list gives the direction in degrees (0 ahead, 90 right, -90 left, 180 behind), or
  `event` when the game knows it (the side a hit came from). The player, which is the audition
  page now and the game later, puts the sound there and sends everything through the cabin's
  two-channel impulse response, which makes the room.

Alarms come from the cabin loudspeaker (`path` cabin). Model: aircraft cockpit warnings. Each one
is recognised within 300 ms, differs from every other in rhythm and contour (not only in pitch),
and can be borne for a minute. No sirens from films, no toy beeps.

Silence is a means. With the engines off the cabin holds a fan, a faint electrical hum and now and
then a tick of metal changing temperature. Silent running takes even the fan away.

The art direction of the game is hard science fiction, sober and believable (The Expanse, Elite
Dangerous). When in doubt: heavier, duller, quieter, fewer notes.

## 2. Rules a sound is checked against

Every sound is rendered, measured with the listening tools in `tools/audio/listen`, and improved
until it passes. The numbers go into the manifest so that a reader can see them.

All sounds:

- 48 kHz, 16-bit PCM WAV. Mono, except where the list says two channels.
- True peak at or below -1 dBFS, no clipped samples, no DC offset (|mean| below 0.001).
- A one-shot starts within 5 ms of the file start and ends in silence (last 10 ms below -60 dBFS).
- A loop repeats without a click or a bump: the seam check of the measuring tool passes, and the
  level over the loop does not swing so that the repeat is heard as a rhythm (unless the list asks
  for a pulse).
- The CLAP score of the sound's own descriptions (`pos`) is higher than that of every description
  it must not be mistaken for (the category's `neg` and the global ones). CLAP is a sanity check,
  not a target: do not tune a sound toward the score at the cost of the rules in section 1.
- If the describing model runs: its answer to "What is this sound?" is recorded. An answer that
  names something else entirely is a reason to look again, not a failure by itself.

By path:

- structure: at least 85 % of the energy below 500 Hz, at most 2 % above 4 kHz.
- structure, so that the sound survives headphones and small loudspeakers that play no deep bass
  (a phone with a controller is a way to play): at least 35 % of the energy between 125 Hz and
  1 kHz and at most 25 % below 60 Hz. The fold jump and the fold tunnel are meant as pressure and
  need only 20 % and may have 40 %. Deep rumble is carried by its harmonics and by the hull modes
  above 100 Hz, not by content that only a subwoofer plays. (Added on 2026-11-14 after the first
  set came out with nearly all energy below 150 Hz.)
- No steady pure tone stands alone for the whole length of a loop: a whine or a hum drifts a
  little in pitch and level and is never a ruler-straight line in the spectrogram.
- A rattle is a fast run of several small uneven knocks of noise, never a pitched ping, and no
  two rattles in a file are alike.
- cabin (switches, relays): shorter than the list's duration, spectral centre between 800 Hz and
  5 kHz, and audibly in a small room (the cabin reverb is applied in the render).
- alarms: fundamental between 400 Hz and 1.6 kHz, no energy peak above 5 kHz, each alarm's
  envelope pattern different from the others (the measuring tool prints the envelope). Rendered
  dry, as the loudspeaker gives them out.
- sensor: rendered dry; soft attack (no click), nothing above 6 kHz, level well below the alarms.
- energy: at least 30 % of the energy above 1 kHz and at least 8 % above 4 kHz (it hisses), at
  least 10 % below 250 Hz (it has weight), and no single spectral peak that holds more than 15 %
  of the energy (no pitch stands out). Two channels.
- two channels (structure loops and energy sounds): the correlation between left and right over
  the file lies between 0.3 and 0.9; below 150 Hz the channels are equal (correlation above
  0.98); the levels of left and right differ by less than 1.5 dB; and the mono sum passes every
  rule of the sound's path by itself.
- radio: nothing below 250 Hz or above 3.8 kHz after the filter; a spoken line must still be
  transcribed correctly by Whisper after the filter (word error rate at most 15 % against the
  unfiltered transcript).

Families belong together: the engine levels are one engine at six settings and must crossfade
without a jump in pitch or tone (same hull modes, same noise seeds, only the excitation changes).
Light, medium and heavy hits are one event at three strengths, not three different things.

## 3. Files and contract

```
tools/audio/sounds.json        the list: what exists, what it is meant to be (this is the spec)
tools/audio/listen/            listening tools (measure, compare, transcribe, describe)
tools/audio/synth/             synthesis library and one render script per category
tools/audio/build.py           renders everything, measures it, writes the manifest
assets/audio/render/           rendered WAV files, spectrogram PNGs, manifest.json   (not in git)
assets/audio/downloads/        downloaded packs, each archive in its own directory   (not in git)
assets/audio/downloads.json    which files were downloaded: URL, SHA-256, licence, size (in git)
assets/audio/CREDITS.md        the licence list (in git)
assets/audio/ratings.json      the owner's ratings, written by the audition page     (in git)
```

Rendering is deterministic: fixed seeds, no clock, no network, so that anyone can rebuild the
same files with `.venv-audio/Scripts/python.exe tools/audio/build.py`.

`assets/audio/render/manifest.json` is what the audition page reads:

```json
{
  "version": 1,
  "categories": [{ "id": "engines", "en": "Engines", "de": "Triebwerke" }],
  "sounds": [{
    "id": "engine_main_t050",
    "file": "engines/engine_main_t050.wav",
    "spectrogram": "engines/engine_main_t050.png",
    "category": "engines",
    "kind": "loop",
    "path": "structure",
    "family": "engine_main",
    "params": { "thrust": 0.5 },
    "en": "Main engines, half thrust",
    "de": "Haupttriebwerke, halber Schub",
    "intent": "what it is meant to be, one sentence, from sounds.json",
    "source": "synth",
    "licence": "AGPL-3.0-or-later",
    "duration": 8.0,
    "channels": 1,
    "gain": 1.0,
    "checks": {
      "pass": true,
      "failed": [],
      "peakDb": -3.2,
      "lufs": -24.1,
      "lowShare": 0.93,
      "highShare": 0.004,
      "clap": { "best": "deep engine rumble felt through the hull of a spacecraft", "margin": 0.11 },
      "described": "A low mechanical rumbling ..."
    }
  }]
}
```

In `checks`, `failed` lists only the hard rules (levels, clipping, start and end, seam, energy
shares, band rules) and `pass` is true when it is empty. The CLAP comparison is a hint, not a
rule: a sound whose margin is negative carries `"hints": ["clap-margin"]` and still passes.

Every sound entry also carries `"dry": true` or `false`. Structure sounds and the cabin's own
sounds (switches, relays, ambience) are rendered as they are heard in the seat, with the cabin
baked in: `dry` is false. Loudspeaker sounds (alarms, sensor signals, radio) and downloaded files
are dry: the audition page, and later the game, puts them into the cabin with `cabin_ir`. The
optional top-level field `"placeholder": true` marks a manifest of stand-in sounds.

Three more fields serve the listening rounds. `hash` is the first twelve hex digits of the
SHA-256 of the sound file: the audition page stores it with each rating and marks a sound as
"changed since your rating" when it differs. `place` is copied from the sound list (see Space).
`cue`, where the sound list has it, is the time in seconds at which the next sound of a chain
starts (the cruise charge carries a tail after its cue).

`kind` is `loop`, `oneshot` or `ir` (an impulse response for the cabin reverb). `source` is
`synth` or `download`; downloaded files chosen for listening appear in the same list with their
licence (`CC0 1.0`, `Public domain (NASA)`) and a `file` path that starts with `../downloads/`.
Paths are relative to `assets/audio/render/`.

## 4. Listening rounds

The owner judges; what he says overrides the rules above, and the rules are changed to match.

### Round 1, 2026-11-14 (20 of 114 rated, ratings in `assets/audio/ratings.json`)

- Approved as they are (five stars or "fits"): engine idle, cruise charge, cruise engage, cruise
  loop, fold charge, fold tunnel, cabin at rest, silent running, the missile warning. Their
  character must not change; the move to two channels keeps the approved sound as the mono sum.
- Cruise charge: "should be a little longer toward the end". It now carries a tail after its cue.
- Shield hits, all three: wrong. "It should sound energetic. This sounds as if someone knocked on
  a salad bowl." They moved to the new energy path.
- Fold jump and fold exit: wrong. "Should sound energetic, hissing, rushing, not like a dull
  blow." Energy path as well.
- Shields-down alarm: wrong. "Sounds like a railway station announcement instead of a critical
  state." Redesigned as a harsh falling warning.
- General: "The sounds all sound very mono. Can the sound engine be tuned more toward stereo and
  spatial sound?" See the section Space.
- Downloads: the Kenney low boom (`k_hit_lowboom_0`) fits; `k_land_plate_medium_0`,
  `k_land_metal_light_3`, `k_computer_noise_1` and the NASA file `n_dinks_donks` are wrong.
