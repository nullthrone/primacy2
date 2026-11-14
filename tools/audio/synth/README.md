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
- `register(id, swing_max=None)`, `REGISTRY`, `render(id)` (to level), `render_dry(id)`, `load_spec()`, `load_categories()`, `Ctx` (`id`, `spec`, `n`, `channels`, `kind`, `params`, `rng()`), `is_mid_side(spec)`.

Two channels: `mid_side(mid, side, periodic, ratio)`, `SIDE_LOW_HZ`.

## Two channels

Sounds with `"channels": 2` on the structure or energy path are made as mid and side
(SOUND_DESIGN.md, section Space). The renderer returns shape `(n, 2)`.

```python
from . import mid_side
mid = render_the_approved_mono_sound(ctx.n)               # unchanged
side = render_the_same_kind_with_other_seeds(ctx.n)       # e.g. the same function, another seed family
return mid_side(mid, side, periodic=True, ratio=0.5)      # loops: periodic=True; one-shots: False
```

- `mid_side(mid, side, periodic=True, ratio=None)` takes the bass out of the side (nothing below
  150 Hz: a steep high-pass with its corner at 170 Hz, circular for loops, causal for one-shots) and
  returns `[mid + side, mid - side]`. `(left + right) / 2` is exactly `mid`. `ratio` sets the RMS of
  the side as a fraction of the RMS of the mid; the power ratio is its square, and for independent
  signals the correlation of the two channels is `(1 - ratio**2) / (1 + ratio**2)`. The rule wants
  0.3 to 0.9, so a ratio between about 0.3 and 0.73.
- Single events (stones, grains) can sit at different places: keep the same events in the mid and
  put them into the side weighted by a position from -1 (left) to +1 (right); see `cat_landing.py`.
- Level: for these sounds the build sets the loudness on the mono sum, `(L + R) / 2`
  (`set_level(..., mono_sum=True)`, chosen by `is_mid_side(spec)`), so the side adds width and
  leaves the approved level alone. The true peak and the ceiling look at both channels. The LUFS
  of the file itself is higher (about 3.5 dB for a ratio of 0.3 and more for wider sounds);
  `checks.lufsMono` is the number the table below refers to.
- Dither: such files are written with the same dither in both channels, so that the mono sum
  differs from the old mono file only by sample rounding (below -60 dB for everything made so far).
- Measuring: `listen/measure.py` gives, for two channels, `stereo.corr` (left against right over
  the file), `stereo.corrLow` (the same below 150 Hz), `stereo.levelDiffDb` and `stereo.monoRmsDb`,
  and it measures the spectral numbers (shares, centroid, peaks, `peakShare`, the share of the
  strongest spectral peak) on the mono sum. `peakShare` and `stereo` are copied into `checks`.
- Rules (`rules.py`): for the structure and energy path with two channels, correlation between 0.3 and
  0.9 (`stereo-correlation`), equal bass (`stereo-bass-correlation`, above 0.98), left and right within
  1.5 dB (`stereo-level-diff`), and the path rules are applied to the mono sum. The energy path itself:
  `energy-high-share` (30 % above 1 kHz), `energy-air-share` (8 % above 4 kHz), `energy-weight` (10 %
  below 250 Hz), `energy-peak` (no spectral peak with more than 15 %).
- The cabin's own two-channel sounds (ambience, `cabin_ir`) are not mid and side and are not held to these rules.

## Manifest fields added by the build

`hash` (first twelve hex digits of the SHA-256 of the file), `place` and `cue` (copied from
sounds.json where the entry has them), and `channels` (from sounds.json). A JSON written by an
older build is completed with these when the manifest is assembled.

## Level table

Loops are set by integrated loudness (LUFS), one-shots by true peak (dBFS); the table is `LEVELS` in `levels.py`. Ids missing there fall back to `CATEGORY_DEFAULTS`, which are provisional.

| sound | target |
|---|---|
| cabin at rest / silent running | -45 / -55 LUFS |
| engine idle, 1/4, 1/2, 3/4, full, boost (mono sum) | -38, -32, -27, -23, -20, -17 LUFS |
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

Two channels: the mid is exactly this engine; the side is the same engine from other seeds
(`seeded("engine_main_side/...")`), without bass, with `side_ratio(t)` growing from 0.30 at idle to
0.68 at boost.

One engine at six settings: the same hull modes and the same noise seeds (`seeded("engine_main/...")`),
only the excitation changes with thrust. Steady noise goes through the hull (circular, so it
loops), is roughened by modulation that closes over the loop, and passes the steep low-pass; two
beating machine tones move up about 15 % from idle to full; rattles are a fixed pool of events
that switch on with thrust. The final level is set by the build.
