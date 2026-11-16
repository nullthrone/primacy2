# Sound design: you sit in the ship, and the game may be louder than physics

The direction for every sound in the library, the rules a sound is checked against, and the
contract between the scripts that make the sounds and the page on which the owner listens.
The list of sounds is `tools/audio/sounds.json`.

## 1. The idea

The pilot sits in a small metal cabin inside a machine, and that is where the ear is. The first
two sets took "space is silent, so everything arrives through the hull" to the letter, and the
owner heard a submarine: "many sounds are too muffled. It then feels like a submarine simulation
and not like a space sim. That may be half realistic, but we are still playing a game. We may be
more creative in making the sounds and need not keep 100 % to physics" (round 2). So physics is
where a sound starts, not where it has to stop. What he approved and what he rejected draws the
line:

- **Beds stay deep.** Everything that runs on and on (engines at every setting, the thruster burn,
  cruise, the fold tunnel, the cabin at rest, the hull groaning) was approved as deep, heavy sound
  felt through the structure. These keep their character.
- **Events need a shape.** Every dull one-shot was rejected with the same picture: "as if someone
  knocked on a dull plastic container" (hull hits, thruster pulses, the lock of the landing gear),
  "like under water" (debris). Measured, these have 50 to 83 % of their energy in the single octave
  from 125 to 250 Hz, nothing above 1 kHz in the attack and nothing below 60 Hz. An event has an
  attack that says what it is made of, a body that has weight, and a tail. What exactly the three
  should be is on trial in round 3 (the direction samples, category `pilot`): metal as it is,
  larger than life as a film does it, or dark with real weight.
- **Energy has a bass throb.** "Energetic must always have a bass throb as well" (round 2, on the
  reworked shield hits, which he found more energetic than before but "like someone knocking on a
  taut foil"). A discharge is bright on top and throbs underneath, with nothing thin in between.
- **Small bright things were rejected as well** (the short metal hits from the downloaded packs):
  brightness alone is not the answer; size is.

Everything that is heard still reaches the ear by a path. Each sound belongs to exactly one
(`path` in the list):

- **structure**: vibration that travels through the hull into the seat and the cabin walls.
  Engines, thrusters, hits, landing gear, the drive. The beds are dull and heavy: most of the
  energy lies below 500 Hz and it falls off steeply above about 1.2 kHz. What rings are the hull's
  own modes: a fixed handful of inharmonic frequencies between 35 and 400 Hz that every structure
  sound of one ship excites, so that the ship has a voice of its own. For the one-shots of this
  path the old law ("a transient is a thunk, never a crack", high content only as sparse rattles)
  is withdrawn; their new shape comes out of round 3.
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
  out. Still hard science fiction: no "pew", no synthesiser sweep. Since round 2 the low body is
  not an extra but half of the sound: a bass throb that is there from the first moment and
  outlasts the crackle.
- **pilot**: not a path of the game but the mark of a direction sample (category `pilot`): two or
  three deliberately different answers to the same sound, for the owner to choose between. The
  chosen one becomes the rule for its kind and the samples are removed.

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
Dangerous), and it is a game: a sound may be clearer and larger than the physics would give.
When in doubt: more weight and a clearer shape, never duller. (Until round 2 this line read
"heavier, duller, quieter, fewer notes"; the owner's judgement overturned it.)

The radio carries no recorded voices of real people. The owner struck the NASA radio traffic in
round 2: "we have to invent our own pipeline for natural voice generation, also so that we can
have any text spoken". Voices are generated. What he decided when asked (2026-11-15): voices speak
in the radio, as the ship computer and as station staff ("all of it"); the spoken language is
English; the game generates much of its content, so the system must be able to speak generated
text, and lines made ahead are not enough; only artificial voices, with no real person as
template, his own voice included. The comparison of speech models and its results are in
`tools/voice`.

What happens outside the ship stays a signal of the ship's sensors. Asked whether explosions,
fly-bys and other ships' weapons may be heard as real sound, now that the game may leave physics,
he answered "not for now".

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

Downloaded files are processed and checked as well before the owner hears them (since round 2,
when he heard crackling and asked whether it was too loud). Until then they played unlevelled at
full scale, 10 to 20 dB above the rendered set, several cut hard at the end. Now:

- A one-shot does not start or end on a step. Where its first sample is not silence, a ramp of
  1.5 ms is put in front of the recording; the recording itself is not faded at the start. (A
  first version faded the first 8 ms: that took the attack off every short hit and the level step
  then turned up what was left, which is the dullness the owner rejects. A review caught it.) The
  end gets a fade of 30 ms where it is not silent, unless the loudest part of the sound lies
  there: then a short tail is appended instead.
- A loop wraps without a step: its tail is crossfaded into its head, and the processed file is
  shorter by that.
- The level comes from the same table as the rendered sounds (`DOWNLOAD_TARGETS` in `build.py`).
  An event never sits at the level of a bed.
- A file whose source is clipped carries that in its entry.

By path (the rules for structure describe the beds; the one-shots of the structure path and the
energy path get new numbers from the direction chosen in round 3, and until then the code in
`synth/rules.py` still checks them the old way):

- pilot: only the rules for all sounds above. Each sample has its own targets in its brief.
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

### Round 2, 2026-11-15 (32 rated on the current files, 49 of 114 rated in all)

What he heard is in `assets/audio/rounds/round2.json` (file hashes) and `round2-ratings.json`.
He did not go through everything: "I did not listen to many things one by one any more, because
above all we have to judge the big picture anew."

- The big picture, in his words: "We have the general problem that many sounds are too muffled.
  It then feels like a submarine simulation and not like a space sim. That may be half realistic,
  but we are still playing a game. We may be more creative in making the sounds and need not keep
  100 % to physics." Section 1 was rewritten for this.
- Fits: the engine at every setting (now two channels), the thruster burn, the hull groaning.
  With round 1 that makes every bed he has heard an approved one.
- Wrong, each with the same words, "sounds as if someone knocked on a dull plastic container":
  the three thruster pulses and the three hull hits. Landing gear out and in: "too muffled as a
  whole; above all the clunk at the end again sounds like knocking on a plastic container".
- Close: the three reworked shield hits. "Sounds more energetic than before, but rather reminds
  one of someone knocking on a taut foil. 'Energetic' must always have a bass throb as well."
  Debris on the hull: "sounds like under water and not like in space".
- Downloads. Fits: the Kenney engines `k_engine_large_0` and `k_engine_low_0`, the Kenney
  thrusters `k_thruster_0` and `k_thruster_3`, the NASA recordings of the rover driving, of
  Ingenuity and of the SLS test firing. Wrong: `k_engine_small_1` ("sounds like an aircraft
  propeller"), `k_engine_circular_0`, the metal and plate hits `k_hit_metal_heavy_0`,
  `k_hit_plate_heavy_1`, `k_hit_metal_medium_2`. (The round-2 verdicts on the engine levels and
  the downloads were clicked a few seconds apart; they say "nothing wrong here" more than "heard
  through".)
- "Crackling can be heard; can it be that it is too loud? Sounds overdriven." Found in the files,
  not in the mix: the downloaded excerpts were cut without a fade (fourteen end or start on a
  sample between 0.1 and 0.86 of full scale), `n_sls_test_fire` holds about two thousand clipped
  samples in the recording itself, and all downloads played at full scale. The page's limiter was
  a default compressor that lifts the beds by 2 to 3 dB (measured later on the page itself: a tone
  at -20 dBFS came out 3.55 dB louder). Both were repaired after this round: the downloads are
  processed (section 2), and the page has a limiter that leaves everything below its threshold as
  it is, a lamp that stays lit after an overload, and a check that records what the page really
  plays and looks for clicks in it. That check found clicks the page added itself, at the start
  of loops that begin mid-wave; they were repaired as well. Some crackle is designed and stays:
  the single discharges at the end of the shield hits, of the fold jump and of the fold exit. If
  that is what he hears as crackling, it is his to say.
- "Please strike the NASA radio traffic completely; we have to invent our own pipeline for
  natural voice generation, also so that we can have any text spoken if we want." The fifteen
  recordings with voices were removed from the library, and with them every other NASA file
  marked as speech in the list of downloads. The two Quindar files went too: a review ran the
  speech recogniser over what was left and found flight controllers talking in both excerpts,
  although the list had said "none". Eleven NASA recordings without voices stay; the recogniser
  finds no words in them, which is not proof that nobody speaks.
- Not judged: the reworked fold jump, fold exit and shields-down alarm, the longer cruise charge,
  and the two-channel versions of the idle engine, the cruise loop and the fold tunnel carry their
  round-1 verdicts, given on the old files. Nothing was said about the stereo stage (the line
  about "very mono" in the notes is the one from round 1).
- No verdict was given on the pulse weapon, which he opened.

Measured across both rounds (centre of the spectrum, share per band, the first 30 ms):

| | centre | where the energy is | attack above 1 kHz |
|---|---|---|---|
| approved beds (engines, burn, cruise, fold tunnel) | 130 to 220 Hz | 60 to 500 Hz, spread over two or three octaves | none, and none needed |
| rejected one-shots (hull hits, pulses, gear) | 150 to 175 Hz | 50 to 83 % in the one octave 125 to 250 Hz, nothing below 60 Hz | 0 % |
| approved Kenney low boom | 77 Hz | 27 % below 60 Hz, 67 % from 60 to 125 Hz | 0 % |
| approved Kenney thrusters | 330 to 1,230 Hz | low body plus air above 8 kHz | 2 to 7 % |
| rejected Kenney metal hits | 160 to 790 Hz | bright, but 0.1 to 0.4 s long: small | up to 91 % |
| shield hits, "close" | about 4 kHz | 13 to 17 % at 60 to 125 Hz, then a hole up to 2 kHz, 70 % above 2 kHz | 56 to 74 % |

So dull is not what he rejects (the low boom and every bed are dull), and bright is not what he
asks for (the small metal hits are bright). The rejected events are boxy: one resonance, no
attack, no depth. Round 3 puts that to the test with the direction samples.

### Round 3, 2026-11-15 (heard the same evening; 7 ratings, none on a direction sample)

What he heard is in `assets/audio/rounds/round3.json` (file hashes) and `round3-ratings.json`.

- On the sounds, in the chat: "We are slowly going in the right direction. But everything still
  sounds too artificial and boring. Are there no better local models for generating audio?" He
  rated none of the eleven direction samples and chose no direction among A, B and C. So no
  rule follows from this round: the event sounds are not rendered anew, and the rules for
  one-shots stay as they are, until there is a way of making sound that he does not hear as
  artificial. Asked which of A, B and C came nearest, he answered: "I don't know, I didn't
  really like any of it. But I can only describe it badly." So he is not asked to describe any
  more; he is given candidates to accept or reject.
- The pattern over three rounds, read from the ratings and not from his words: long beds pass,
  short events fail, whatever the source. Approved: the rendered engine levels, burn, cruise and
  fold beds, and of the recordings the large and the low Kenney engine, two Kenney thrusters, the
  NASA rover, Ingenuity and the SLS firing. Rejected: every rendered short event he rated, and of
  the recordings the Kenney metal and plate hits, the light metal landing, the computer noise,
  the NASA "dinks and donks", and two Kenney engines. One short event was ever approved: the
  Kenney low boom. So recorded sound is not the answer by itself (a first reading of this round
  said so and was wrong), and the aim of the next round is the first short event he accepts,
  from any source.
- On the voices: "The voices are really good, but the rhythm of the countdown is still broken.
  Perhaps the numbers should be recorded one by one and played back deterministically." (In German:
  "Die Stimmen sind wirklich gut, allerdings ist der Countdown-Rhythmus noch kaputt. Vielleicht
  sollte man die Zahlen einzeln aufnehmen und deterministisch abspielen lassen.") On the
  page he rated the five ship-computer lines "close", each with the same note: "the countdown is
  not really counted in seconds, the gaps are irregular and shorter". Four stars for the Qwen3
  computer line; the Qwen3 dock line "close" without a note. He named no model as the one to
  take, and did not say whether the preset voices of undocumented origin count as artificial.
- What follows for speech, as a design rule: speech that must keep time (a countdown) is not left
  to the model's own rhythm; it is made of single clips placed by a clock. Four countdown samples
  built that way went onto the page after this round (category `voice`):
  `voice_5_countdown_1_qwen3_single`, `_2_qwen3_list`, `_3_chatterbox_single` and
  `_4_chatterbox_list`. The numbers are spoken apart (single) or cut out of one spoken line (list)
  and placed on a grid of one second by computer. What was measured, and what the independent check
  confirmed and could not: `tools/voice/RESULTS.md`, section "Countdown on a one-second grid"
  (facts in `docs/reports/2026-11-15/voice-countdown-report.json` and
  `voice-countdown-verify-report.json`). Nobody has heard these four; he has not rated them.

What he was asked to judge, at the top of the audition page:

- Eleven direction samples (category `pilot`). Hull hit, thruster pulse and landing gear, each in
  three answers: A metal or machinery, B larger than life as a film would do it, C dark but with
  weight and a clear shape. Shield hit in two: A the current crackle on a bass throb, B a deep
  whoomp with a softer sizzle. Inside a family the variants are equally loud. Nobody has heard
  them: a blind check by measurement found no rule broken and flagged what may go wrong by ear
  (the thruster pulse C is little more than a low thump; the ratchet of landing gear A is a row of
  ticks; several read as "toy" or "foil" to the describing models).
- Twenty voice samples (category `voice`): four lines, each spoken by five open speech models,
  equally loud, the two radio lines through the page's radio filter. See `tools/voice/RESULTS.md`
  for what was measured and `tools/voice/CANDIDATES.md` for the models and their licences.
- Every download changed (level, edges, loops), so his round-2 verdicts on downloads show as
  given on an older file.

The plan had been that his choice among the direction samples becomes the rule for one-shots of
the structure and energy paths. He made no choice (see above); the samples stay on the page
until the question of how the sounds are made is settled.

### Round 4, 2026-11-16 (sixteen candidates on the page, not heard yet)

Why this round differs. After round 3 he wrote: "Wir gehen langsam in die richtige Richtung. Aber es
klingt alles noch zu künstlich und langweilig. Gibt es keine besseren lokalen Modelle zur
Audioton-Genese?" He had chosen no direction and could not describe what is wrong, so he is not
asked to describe or rank: he gets candidates from other sources and accepts or rejects each
(Passt / Falsch). The measures of round 2 are not used to rank them; the files are screened only
for plain faults (clipped, cut off while loud, several events, speech, music), and the sources are
not ranked. He approved three sources ("Ja, alle laden"): MOSS-SoundEffect v2.0 (Apache-2.0),
Stable Audio 3 Small-SFX Base (Stability AI Community License; output is test material until he
decides) and CC0 recordings from OpenGameArt. How they were run: `GENERATORS.md`.

On the page, first category "Klangquellen (Runde 4)": per family one MOSS, one Stable Audio, one
recording and one further generated pick. The twelve generated ones are under "Von uns erzeugt",
the four recordings in a second block below (prompts: `tools/sound/prompts.json`).

| id | source | prompt, seed / item | s |
|---|---|---|---|
| src_1_hull_1_moss_p1s16 | MOSS | hull_1, seed 16 | 2.51 |
| src_1_hull_2_sa3_p2s11 | Stable Audio 3 | hull_2, seed 11 | 2.51 |
| src_1_hull_3_oga_sfx2-metal-hit-01 | recording | 100 CC0 SFX #2, metal_hit_01, cut 0.01-0.75 s | 0.74 |
| src_1_hull_4_sa3_p1s13 | Stable Audio 3, second pick | hull_1, seed 13 | 1.73 |
| src_2_thruster_1_moss_p2s11 | MOSS | thruster_2, seed 11 | 0.50 |
| src_2_thruster_2_sa3_p2s12 | Stable Audio 3 | thruster_2, seed 12 | 0.98 |
| src_2_thruster_3_oga_steam-hiss-3 | recording | Steam release sounds, hiss 3, cut 0.00-0.92 s | 0.92 |
| src_2_thruster_4_moss_p1s11 | MOSS, second pick | thruster_1, seed 11 | 0.41 |
| src_3_gear_1_moss_p2s12 | MOSS | gear_2, seed 12 | 3.81 |
| src_3_gear_2_sa3_p3s15 | Stable Audio 3 | gear_3, seed 15 | 3.03 |
| src_3_gear_3_oga_sfx2-lock-open-01 | recording | 100 CC0 SFX #2, lock_open_01, cut 0.02-0.50 s | 0.49 |
| src_3_gear_4_sa3_p2s15 | Stable Audio 3, second pick | gear_2, seed 15 | 3.47 |
| src_4_shield_1_moss_p3s14 | MOSS | shield_3, seed 14 | 2.00 |
| src_4_shield_2_sa3_p3s11 | Stable Audio 3 | shield_3, seed 11 | 2.15 |
| src_4_shield_3_oga_tesla-spark | recording | Electricity Sound Effects, spark, cut 0.09-0.34 s | 0.26 |
| src_4_shield_4_sa3_p2s16 | Stable Audio 3, second pick | shield_2, seed 16 | 2.29 |

Level. Every copy is set so that the candidates of a family leave the page at the same BS.1770
loudness (the target of each family, within 0.1 dB by the independent check, 0.33 dB for the 0.41 s
MOSS thruster file). The page plays a one-channel file on both channels and a two-channel file as
it is, so the level is matched at the page, not in the file: `tools/sound/README.md`, "Level". By a
plain measure the sounding level still differs inside a family by 3.0 to 5.7 dB; no gain was changed.

Not established (`tools/sound/RESULTS.md`, "What could not be judged"): how any candidate sounds;
nobody has heard one, and the spectrograms find only plain faults. Whether a recording is a
recording: of the four, only the spark's page says "recorded"; the gear one is a short lock click,
not a motor ending in a latch, the shield one a 0.26 s spark. MOSS presses loud output against full
scale inside its decoder (49 of 72 raw files peak above 0.99; the published shield pick has a crest
of 7.7 dB); no pick was changed for it. Loudness of events under about 0.5 s moves by a few dB with
the block positions. The Stable Audio checkpoint is the one before its last training stage.

His ratings: none yet (0 of 16 rated). Until the ratings of round 4 are recorded the way round 3
was (`assets/audio/rounds/round4.json` with the file hashes, `round4-ratings.json` with the
ratings), `assets/audio/render/source` is frozen, and `screen.py`, `publish.py` and `build.py` are
not run on the real tree: a new publish changes ids or hashes and orphans his ratings.
