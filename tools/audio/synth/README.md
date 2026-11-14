# Synthesis library

Everything here is synthesised by code (AGPL-3.0-or-later); no sound is copied from elsewhere.
Direction and rules: `tools/audio/SOUND_DESIGN.md`. The list of sounds: `tools/audio/sounds.json`.
Python is `.venv-audio/Scripts/python.exe`, run from the repository root.

## Add a sound

Create (or extend) `tools/audio/synth/cat_<category>.py`. The build imports every `cat_*.py`, so
nothing else needs to change. A renderer gets a context and returns a float array of exactly
`ctx.n` samples (shape `(n,)`, or `(n, 2)` where sounds.json says `"channels": 2`), at any scale.
It never normalises: the build sets the level from the table in `levels.py`.

```python
from . import register, hull_blow, apply_cabin, seeded

@register("impact_hull_light")            # must be an id of sounds.json, once
def impact_hull_light(ctx):
    rng = ctx.rng()                       # fixed by the sound id: the same on every run
    return hull_blow(ctx.n, strength=0.25, rng=rng)

@register("relay_click_a")
def relay_click_a(ctx):
    n = ctx.n
    click = ...                           # build the dry sound with the helpers below
    return apply_cabin(click)[:, 0]       # cabin sounds are heard in the cabin: bake it in
```

Build and read the result:

```
.venv-audio/Scripts/python.exe tools/audio/build.py --only impact_hull_light --no-clap
.venv-audio/Scripts/python.exe tools/audio/build.py --category impacts [--describe]
.venv-audio/Scripts/python.exe tools/audio/build.py                  # everything registered
```

`--out DIR` changes the folder (default `assets/audio/render`; use `assets/audio/cache/render-wip`
while experimenting). Per sound you get `<out>/<category>/<id>.wav`, `.png` (waveform and
spectrogram: open it and look) and `.json` (measurements and the result of each rule). One line
is printed per sound: `pass`, or `FAIL` and the names of the failed rules (see `rules.py`), the
CLAP margin (positive is good), loudness and true peak. Sounds of sounds.json with no renderer are
counted as missing, not as failures. `manifest.json` is assembled from all the `.json` files in
`<out>`, so several people can build into one folder; it is checked against the contract at the
end of every run. Exit code 1 means a failed sound or manifest problem.

Rules that need your judgement and are decided in `rules.py`: a loop's 100 ms level may swing at
most 6 dB (`@register(id, swing_max=...)` raises it for loops whose content is an event now and
then); the CLAP margin of an impulse response (`kind: ir`) is recorded but not a failure.

Tests: `.venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/synth/tests`

## Helpers (`from synth import ...`)

Noise and seeds
- `seeded(name)` generator fixed by a string; `ctx.rng(salt)` the same, per sound id. Use
  `seeded("family/part")` for noise that several sounds of one family must share.
- `periodic_noise(n, color, rng, lo, hi, order)` white/pink/brown noise that repeats exactly every n samples, unit RMS; same rng gives the same phases whatever the band.
- `white_noise(n, rng)` ordinary noise for one-shots.

Filters
- `freq_filter(x, lo, hi, order)` zero-phase, circular (keeps a loop a loop); `lowpass`, `highpass`, `bandpass` causal (one-shots); `resonator(x, f, t60)` a ringing two-pole.

Envelopes and tones
- `rise(n)` half-cosine ramp; `exp_decay(n, t60)`; `burst_env(n, attack_ms, t60)` rounded blow envelope; `fade_edges(x, in_ms, out_ms)` ends a one-shot in silence.
- `periodic_lfo(n, hz)` and `slow_wander(n, rng, lo, hi)` modulators that close over the loop.
- `snap_freq(f, n)`, `sine(n, f)` whole cycles per loop; `machine_tone(...)` pump or reactor (partials in beating pairs, flutter); `transformer_tone(n, f0, load)` mains hum with odd harmonics and growl.

Hull (structure path)
- `MODES` the ten hull modes (Hz, level, T60); `hull_ir(n, sharp, gains)`; `through_hull(x, periodic, sharp, gains, dry)` sends any excitation through them.
- `structure_lowpass(x, periodic)` the steep low-pass (nothing above about 1.2 kHz).
- `rattles(n, activity, rng, per_second, periodic)` sparse 1 to 4 kHz rattles; weaker activity is a subset of stronger.
- `thump(n, f_start, f_end, ...)` falling-pitch body of a blow; `hull_blow(n, strength, rng)` a complete structure blow (thump, ringing, low-pass, rattles above strength 0.5).

Cabin
- `cabin_ir()` stereo impulse response (0.5 s) of a 2.2 x 1.6 x 1.4 m metal cockpit; `apply_cabin(x, ir=None, wet=1.0, periodic=False)` puts a dry sound in it, mono in gives stereo out; with `periodic=True` a loop stays a loop.

Level and output
- `LEVELS`, `target_for(id, category, kind)`, `set_level(x, mode, target)`, `lufs(x)`, `true_peak_db(x)`, `CEILING_DB` (-1 dBFS true peak).
- `to_int16(x, seed)`, `write_wav(path, x, dither_seed)` 16-bit, 48 kHz, TPDF dither.

Registry
- `register(id, swing_max=None)`, `REGISTRY`, `render(id)` (to level), `render_dry(id)`, `load_spec()`, `load_categories()`, `Ctx` (`id`, `spec`, `n`, `channels`, `kind`, `params`, `rng()`).

## Level table

Loops are set by integrated loudness (LUFS), one-shots by true peak (dBFS); the table is `LEVELS` in `levels.py`. Ids missing there fall back to `CATEGORY_DEFAULTS`, which are provisional.

| sound | target |
|---|---|
| cabin at rest / silent running | -45 / -55 LUFS |
| engine idle, 1/4, 1/2, 3/4, full, boost | -38, -32, -27, -23, -20, -17 LUFS |
| cruise loop / fold tunnel | -24 / -34 LUFS |
| clicks, console keys, toggles | -16 dBFS peak |
| relays, breaker | -14 dBFS peak |
| thruster pulses | -12 dBFS peak |
| hull and shield hits light / medium / heavy | -9 / -5 / -1.5 dBFS peak |
| touchdown gentle / hard | -10 / -2 dBFS peak |
| fold jump | -1.5 dBFS peak |
| alarms (missile) | -20 (-18) LUFS |
| sensor signals | -27 LUFS |
| cabin_ir (file only) | -3 dBFS peak |

## How the engines are made (a pattern for loops)

One engine at six settings: the same hull modes and the same noise seeds (`seeded("engine_main/...")`),
only the excitation changes with thrust. Steady noise goes through the hull (circular, so it
loops), is roughened by modulation that closes over the loop, and passes the steep low-pass; two
beating machine tones move up about 15 % from idle to full; rattles are a fixed pool of events
that switch on with thrust. The final level is set by the build.
