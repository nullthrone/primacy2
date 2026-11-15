"""Round 3 direction samples, mechanical set: three answers for the medium hull hit and three for the
landing gear (category `pilot`, ids pilot_hull_a/b/c and pilot_gear_a/b/c).

The owner rejected every dull one-shot as "someone knocking on a dull plastic container": all
energy in the octave 125 to 250 Hz, nothing above 1 kHz in the attack, nothing below 60 Hz. Each
answer here is built from layers that come from one event (the attack leads, the low body follows
within a few milliseconds) and that put energy where the rejected sounds had none.

    hull a  metal      crack, clang of a large plate with shimmering inharmonic partials, sub, rattles
    hull b  cinema     sub drop, saturated crunch, a spray of debris grains (two channels)
    hull c  weight     deep boom, broad body, a soft knock, long low tail (tests depth alone)
    gear a  machinery  motor whine with harmonics, gear-train ratchet, lock in two stages
    gear b  cinema     pneumatic hiss, servo growl, sweeping whine, slam with sub and ring (two channels)
    gear c  dark/clear whine with harmonics heard through the structure, tick on a thunk, no ring

Rendering is deterministic: only seeded noise (ctx.rng).
"""
from __future__ import annotations

import numpy as np

from . import (LEVELS, SR, bandpass, burst_env, exp_decay, fade_edges, highpass, lowpass, mid_side,
               register, rise)

# true peak targets. The hull family and the gear family are meant to be about equally loud inside
# the family (integrated loudness within 2 dB); the values were set from measured LUFS.
LEVELS.update({
    "pilot_hull_a": ("peak", -5.0),
    "pilot_hull_b": ("peak", -5.0),
    "pilot_hull_c": ("peak", -5.0),
    "pilot_gear_a": ("peak", -8.0),
    "pilot_gear_b": ("peak", -8.0),
    "pilot_gear_c": ("peak", -8.0),
})


# --------------------------------------------------------------------------- helpers

def _add(out: np.ndarray, x: np.ndarray, t: float, gain: float = 1.0) -> None:
    """Add x into out starting at t seconds (cut at the end)."""
    i = int(round(t * SR))
    if i >= out.shape[0] or i < 0:
        return
    m = min(x.shape[0], out.shape[0] - i)
    out[i:i + m] += gain * x[:m]


def _smooth_env(n: int, attack: float, hold: float, t60: float) -> np.ndarray:
    """Rounded rise over `attack` s, flat for `hold` s, then an exponential decay with T60 `t60`."""
    a = max(1, int(attack * SR))
    h = int(hold * SR)
    env = np.ones(n)
    env[:a] = rise(min(a, n))[:a]
    if h + a < n:
        env[a + h:] = exp_decay(n - a - h, t60)
    return env


def _noise_burst(rng, dur: float, lo: float, hi: float, t60: float, attack_ms: float = 0.3,
                 order: int = 2) -> np.ndarray:
    """Band-limited noise burst: a very fast rounded rise, then an exponential decay."""
    n = int(dur * SR)
    x = rng.standard_normal(n + 256)
    x = bandpass(x, lo, hi, order)[256:]
    x = x / max(np.sqrt(np.mean(x ** 2)), 1e-9)
    return x * burst_env(n, attack_ms, t60)


def _falling_sine(n: int, f_hi: float, f_lo: float, glide: float, rng, wobble: float = 0.0) -> np.ndarray:
    """A sine that falls from f_hi to f_lo (time constant `glide` s). A little slow wobble keeps
    the line from being ruler-straight."""
    t = np.arange(n) / SR
    f = f_lo + (f_hi - f_lo) * np.exp(-t / glide)
    if wobble:
        f = f * (1.0 + wobble * np.sin(2 * np.pi * rng.uniform(1.5, 4.0) * t + rng.uniform(0, 6.28)))
    return np.sin(2 * np.pi * np.cumsum(f) / SR + rng.uniform(0, 0.5))


def _plate(n: int, rng, f0: float, ratios, t60_ref: float, ref_hz: float, expo: float, tilt: float,
           pair=(0.002, 0.007), drift: float = 0.0008, t60_floor: float = 0.05):
    """The clang of a large plate: inharmonic partials, each a close detuned pair. High partials
    die faster (T60 = t60_ref * (ref_hz / f) ** expo). Returns the two members of the pairs
    separately (a, b); a + b is the mono sound, and for two channels each ear can take its own.
    Each partial's pitch drifts a little (slow wander), so nothing is a ruler-straight line."""
    t = np.arange(n) / SR
    a = np.zeros(n)
    b = np.zeros(n)
    for r in ratios:
        f = f0 * r * rng.uniform(0.985, 1.015)
        if f > 12000:
            continue
        t60 = max(t60_floor, t60_ref * (ref_hz / f) ** expo * rng.uniform(0.85, 1.15))
        amp = (ref_hz / f) ** tilt * rng.uniform(0.55, 1.0)
        life = min(n, int(t60 * 1.3 * SR))  # past 80 dB down nothing is audible
        tt = t[:life]
        env = np.exp(-6.9078 * tt / t60)
        env[: int(0.0004 * SR)] *= rise(int(0.0004 * SR))
        for k, dst in enumerate((a, b)):
            fk = f * (1.0 + (rng.uniform(*pair) * rng.choice([-1.0, 1.0]) if k else 0.0))
            wander = drift * np.sin(2 * np.pi * rng.uniform(0.6, 3.0) * tt + rng.uniform(0, 6.28))
            ph = 2 * np.pi * np.cumsum(fk * (1.0 + wander)) / SR + rng.uniform(0, 6.28)
            dst[:life] += amp * (1.0 if k == 0 else rng.uniform(0.55, 0.9)) * np.sin(ph) * env
    return a, b


def _knock_run(rng, start: float, knocks: int, lo: float, hi: float, gap0: float, level: float,
               n: int) -> np.ndarray:
    """A run of small uneven knocks of band-limited noise, like a loose fitting settling: gaps that
    mostly shrink but never repeat, each knock with its own length, band and level."""
    out = np.zeros(n)
    t = start
    gap = gap0
    for k in range(knocks):
        dur = rng.uniform(0.0025, 0.009)
        fc = rng.uniform(lo * 1.2, hi * 0.8)
        kn = _noise_burst(rng, dur, fc / rng.uniform(1.2, 1.6), min(fc * rng.uniform(1.2, 1.6), hi * 1.1),
                          dur * 0.5, 1.0)
        _add(out, kn, t, level * rng.uniform(0.3, 1.0) * 0.92 ** k)
        t += gap * rng.uniform(0.6, 1.4)
        gap *= rng.uniform(0.8, 1.05)
    return out


def _grains(n: int, rng, t0: float, dur: float, count: int, tau: float, lo: float, hi: float):
    """Debris grains: `count` short bursts of noise between lo and hi Hz over `dur` seconds from
    t0, denser at the start (exponential density with time constant tau), each 1.5 to 6 ms long.
    Returns (waveform sum, pan-weighted sum) so that the caller can spread them between channels."""
    u = rng.uniform(0, 1, count)
    times = t0 - tau * np.log(1.0 - u * (1.0 - np.exp(-dur / tau)))
    mono = np.zeros(n)
    side = np.zeros(n)
    for tm in times:
        gdur = rng.uniform(0.0015, 0.006)
        fc = np.exp(rng.uniform(np.log(lo), np.log(hi)))
        g = _noise_burst(rng, gdur, fc / 1.35, min(fc * 1.35, 20000.0), gdur * 0.45, 0.2)
        amp = rng.uniform(0.25, 1.0) * np.exp(-(tm - t0) / (1.6 * tau))
        pan = rng.uniform(-1.0, 1.0)
        _add(mono, g, tm, amp)
        _add(side, g, tm, amp * pan)
    return mono, side


def _rms_scale(x: np.ndarray, ref_rms: float, t_from: float = 0.0, t_to: float | None = None) -> np.ndarray:
    """Scale x so that its RMS over the window equals ref_rms."""
    a = int(t_from * SR)
    b = x.shape[0] if t_to is None else int(t_to * SR)
    r = np.sqrt(np.mean(x[a:b] ** 2))
    return x * (ref_rms / max(r, 1e-12))


# --------------------------------------------------------------------------- hull hits

@register("pilot_hull_a")
def pilot_hull_a(ctx):
    """Metal: a hard crack, the clang of a large plate, a sub thump, then fittings rattling."""
    n = ctx.n
    rng = ctx.rng()
    out = np.zeros(n)

    # 1. the crack: broadband 1 to 8 kHz, 15 to 30 ms, onset inside 2 ms
    crack = _noise_burst(rng, 0.060, 1000.0, 8000.0, 0.020, 0.25)
    # a second, slightly later and duller layer so that the crack has a tail and not only a click
    crack2 = _noise_burst(rng, 0.060, 1800.0, 5000.0, 0.035, 0.4)
    out += 0.9 * crack
    _add(out, crack2, 0.003, 0.45)

    # 2. the plate: at least twelve inharmonic partials 180 Hz to 5 kHz (here 22), pairs detuned
    ratios = [1.0, 1.43, 1.93, 2.31, 2.86, 3.37, 3.94, 4.58, 5.23, 6.05, 6.94, 7.73, 8.86, 10.1,
              11.4, 12.9, 14.6, 16.5, 18.7, 21.2, 23.9, 27.0]
    pa, pb = _plate(n, rng, 180.0, ratios, t60_ref=1.4, ref_hz=200.0, expo=0.85, tilt=0.45,
                    pair=(0.002, 0.008), drift=0.0007)
    plate = pa + pb
    # the plate is struck by the crack: it starts within a millisecond and swells over 1.5 ms
    plate[: int(0.0015 * SR)] *= rise(int(0.0015 * SR))
    out += 0.34 * plate

    # 3. the sub thump, 70 falling to 45 Hz; it follows the attack by about 3 ms
    sub = _falling_sine(n, 72.0, 44.0, 0.07, rng, wobble=0.01) * burst_env(n, 3.5, 0.42)
    _add(out, sub[: n - int(0.002 * SR)], 0.002, 1.55)
    # a low body of the plate itself, so that the clang has a floor to stand on
    body = lowpass(_noise_burst(rng, 0.5, 90.0, 400.0, 0.16, 1.5), 450.0, 2)
    out += 0.45 * body

    # 4. the fittings rattle after the clang, 60 to 250 ms, quiet, uneven
    for start, kn, lo, hi, g0, lv in ((0.062, 11, 1500.0, 4200.0, 0.0125, 0.075),
                                      (0.105, 14, 1700.0, 5000.0, 0.017, 0.07),
                                      (0.170, 9, 1500.0, 3600.0, 0.022, 0.055)):
        out += _knock_run(rng, start, kn, lo, hi, g0, lv, n)

    return fade_edges(out, 0.0, 20.0)


@register("pilot_hull_b")
def pilot_hull_b(ctx):
    """Cinema: a sub drop, a dense saturated crunch, and a spray of debris that thins out (two
    channels; the bass is equal in both, the crunch and the debris differ)."""
    n = ctx.n
    rng = ctx.rng()

    # sub drop 80 to 35 Hz, lasting well past half a second
    t = np.arange(n) / SR
    f = 35.0 + 45.0 * np.exp(-t / 0.28)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * _smooth_env(n, 0.004, 0.18, 1.05)
    # a second layer one octave above that falls with it: the chest of the blow
    f2 = 70.0 + 70.0 * np.exp(-t / 0.18)
    chest = np.sin(2 * np.pi * np.cumsum(f2) / SR + 0.7) * _smooth_env(n, 0.003, 0.02, 0.45)

    def crunch(seed: str) -> np.ndarray:
        r = ctx.rng(seed)
        n_c = int(0.28 * SR)
        # a dense burst of 80 to 150 ms: a body held at full level, then let go
        hold = np.ones(n_c)
        hold[int(0.050 * SR):] = exp_decay(n_c - int(0.050 * SR), 0.11)
        hold[: int(0.0015 * SR)] *= rise(int(0.0015 * SR))
        raw = bandpass(r.standard_normal(n_c + 256), 300.0, 3000.0, 2)[256:]
        raw = raw / np.sqrt(np.mean(raw ** 2)) * hold
        driven = np.tanh(3.5 * raw)                      # driven into saturation: grit
        return bandpass(driven, 260.0, 3600.0, 2)        # and the harmonics kept in the band

    cr_a, cr_b = crunch("crunch/a"), crunch("crunch/b")

    # debris grains 2 to 9 kHz over about 1.1 s, sparser and sparser, spread between the channels
    g_mono, g_side = _grains(n, rng, 0.012, 1.15, 360, 0.38, 2000.0, 9000.0)

    mid = np.zeros(n)
    side = np.zeros(n)
    mid += 1.0 * sub + 0.55 * chest
    _add(mid, cr_a, 0.0, 0.62)
    _add(side, cr_b, 0.0, 0.45)
    mid += 0.20 * g_mono
    side += 0.20 * g_side * 1.6
    # a bright click at the very start: the hit has an edge
    click = _noise_burst(rng, 0.012, 2500.0, 9000.0, 0.004, 0.2)
    _add(mid, click, 0.0, 0.8)
    _add(side, _noise_burst(rng, 0.012, 2500.0, 9000.0, 0.004, 0.2), 0.0, 0.6)

    y = mid_side(mid, side, periodic=False)
    return fade_edges(y, 0.0, 25.0)


@register("pilot_hull_c")
def pilot_hull_c(ctx):
    """Weight: depth and a broad body alone. A deep boom, a body of 125 to 600 Hz with no ringing
    resonance, only a soft knock in the attack, a long low tail."""
    n = ctx.n
    rng = ctx.rng()
    t = np.arange(n) / SR

    # the boom: two falling sines, one below 60 Hz and one in the 60 to 125 Hz range
    boom_a = _falling_sine(n, 78.0, 50.0, 0.20, rng, wobble=0.012) * _smooth_env(n, 0.006, 0.05, 1.9)
    boom_b = _falling_sine(n, 52.0, 34.0, 0.35, rng, wobble=0.015) * _smooth_env(n, 0.008, 0.10, 2.3)
    # the long low tail: a rumble of low noise, not a tone
    rumble = lowpass(rng.standard_normal(n), 95.0, 2) * _smooth_env(n, 0.012, 0.0, 1.7)
    rumble = highpass(rumble, 25.0, 2)

    # the body: broad noise from 125 to 600 Hz, decaying faster than the boom, no resonance
    body = bandpass(rng.standard_normal(n + 256), 110.0, 650.0, 2)[256:] * _smooth_env(n, 0.003, 0.0, 0.55)
    body = _rms_scale(body, 1.0, 0.0, 0.3)

    # the soft knock: 0.8 to 2 kHz, only in the attack
    knock = _noise_burst(rng, 0.030, 800.0, 2000.0, 0.012, 0.8)

    out = 1.0 * boom_a + 0.8 * boom_b + 0.55 * _rms_scale(rumble, 0.35, 0.0, 0.5) * 1.0
    out += 0.30 * body
    _add(out, knock, 0.0, 0.10)
    return fade_edges(out, 0.0, 40.0)


# --------------------------------------------------------------------------- landing gear

def _whine(n: int, rng, t0: float, t1: float, f_start: float, f_end: float, rise_t: float,
           harmonics, wobble_hz=(4.5, 7.3), wobble_depth: float = 0.012, stop_wind: float = 0.0,
           detune: float = 0.0, ratchet_hz: float = 0.0, ratchet_depth: float = 0.0):
    """A motor whine: a fundamental that rises smoothly from f_start to f_end over rise_t seconds and
    then holds (with a little wobble and a slow drift), harmonics `harmonics` = [(k, level), ...].
    From t0 to t1; the last `stop_wind` seconds wind down in pitch and level. The gear-train ratchet
    is an uneven amplitude modulation at ratchet_hz."""
    m = int((t1 - t0) * SR)
    tt = np.arange(m) / SR
    u = np.clip(tt / rise_t, 0, 1)
    f = f_start + (f_end - f_start) * (3 * u ** 2 - 2 * u ** 3)
    f = f * (1.0 + wobble_depth * (0.6 * np.sin(2 * np.pi * wobble_hz[0] * tt + rng.uniform(0, 6.28))
                                   + 0.4 * np.sin(2 * np.pi * wobble_hz[1] * tt + rng.uniform(0, 6.28))))
    f = f * (1.0 + detune)
    drift = 1.0 + 0.004 * np.cumsum(rng.standard_normal(m)) / np.sqrt(SR) * 4
    f = f * np.clip(drift, 0.98, 1.02)
    amp = np.ones(m)
    amp[: int(0.12 * SR)] *= rise(int(0.12 * SR))
    if stop_wind > 0:
        w = int(stop_wind * SR)
        f[-w:] *= 1.0 - 0.25 * (np.arange(w) / w) ** 2
        amp[-w:] *= (1.0 - np.arange(w) / w) ** 1.5
    phase = 2 * np.pi * np.cumsum(f) / SR
    y = np.zeros(m)
    for k, lv in harmonics:
        # each harmonic has its own slow level wobble, so the spectrogram lines are alive
        lw = 1.0 + 0.18 * np.sin(2 * np.pi * rng.uniform(0.7, 2.2) * tt + rng.uniform(0, 6.28))
        y += lv * lw * np.sin(k * phase + rng.uniform(0, 6.28))
    y *= amp
    if ratchet_hz:
        # teeth of a gear train: pulses at about ratchet_hz with uneven spacing and depth
        period = SR / ratchet_hz
        jitter = np.cumsum(rng.uniform(0.75, 1.25, int(m / period * 1.3) + 4)) * period
        env = np.ones(m)
        w = int(0.45 * period)
        shape = 1.0 - ratchet_depth * (0.5 + 0.5 * np.cos(np.linspace(0, 2 * np.pi, 2 * w)))
        for c in jitter:
            i = int(c) - w
            if i < 0 or i + 2 * w > m:
                continue
            env[i:i + 2 * w] = np.minimum(env[i:i + 2 * w], shape * rng.uniform(0.92, 1.0) + (1 - shape) * 0.0)
        y *= env
    out = np.zeros(n)
    _add(out, y, t0)
    return out, f


def _teeth(n: int, rng, t0: float, t1: float, rate: float, lo: float, hi: float, level: float) -> np.ndarray:
    """Tooth clicks of a gear train: a small noise tick at roughly `rate` per second, uneven in time
    and level, band-limited lo to hi. These carry the texture above 1 kHz."""
    out = np.zeros(n)
    t = t0 + rng.uniform(0, 1.0 / rate)
    while t < t1:
        tick = _noise_burst(rng, rng.uniform(0.0015, 0.004), lo, hi, 0.0012, 0.2)
        # a ramp on the level near both ends so that the texture swells in and winds out
        edge = min(1.0, (t - t0) / 0.25, (t1 - t) / 0.12)
        _add(out, tick, t, level * rng.uniform(0.3, 1.0) * max(edge, 0.0))
        t += rng.uniform(0.6, 1.4) / rate
    return out


@register("pilot_gear_a")
def pilot_gear_a(ctx):
    """Machinery: a real machine. Motor whine rising 180 to 420 Hz with eight harmonics, the
    texture of a gear train, then the lock in two stages: a bright clack and a heavy clunk."""
    n = ctx.n
    rng = ctx.rng()
    t_lock = 1.80

    harm = [(1, 1.0), (2, 0.75), (3, 0.62), (4, 0.42), (5, 0.34), (6, 0.22), (7, 0.16), (8, 0.10)]
    whine, _ = _whine(n, rng, 0.04, t_lock - 0.01, 180.0, 420.0, 0.85, harm, stop_wind=0.12,
                      ratchet_hz=29.0, ratchet_depth=0.55)
    # a second, weaker voice a fifth above the fundamental, to make it a motor and not a tone
    # (kept off the harmonic grid so the two beat a little)
    whine2, _ = _whine(n, rng, 0.04, t_lock - 0.01, 180.0 * 1.012, 420.0 * 1.012, 0.85,
                       [(1, 0.22), (3, 0.16), (5, 0.1)], wobble_hz=(5.1, 8.2), stop_wind=0.12,
                       ratchet_hz=0.0)
    teeth = _teeth(n, rng, 0.05, t_lock, 31.0, 1400.0, 4200.0, 0.30)
    air = highpass(rng.standard_normal(n), 900.0, 2)
    air = lowpass(air, 3500.0, 2) * np.concatenate([_smooth_env(int(1.7 * SR), 0.2, 1.3, 0.05),
                                                    np.zeros(n - int(1.7 * SR))])

    out = 0.55 * whine + 0.2 * whine2 + teeth + 0.035 * air

    # lock, stage one: a bright metallic clack (centre above 2.5 kHz), with a tiny ring of two parts
    clack = _noise_burst(rng, 0.040, 2200.0, 9000.0, 0.011, 0.2)
    ring = np.zeros(n)
    for f, a in ((2630.0, 0.5), (3470.0, 0.35), (4310.0, 0.25)):
        tt = np.arange(int(0.10 * SR)) / SR
        _add(ring, a * np.sin(2 * np.pi * f * tt * (1 + 0.002 * np.sin(2 * np.pi * 3 * tt)) + rng.uniform(0, 6.28))
             * np.exp(-6.9078 * tt / 0.045), t_lock)
    _add(out, clack, t_lock, 1.3)
    out += 0.45 * ring

    # stage two, 60 ms later: a heavy clunk: body 100 to 400 Hz, sub at 50 to 80 Hz, ring 0.3 s
    t2 = t_lock + 0.060
    m = n - int(t2 * SR)
    body = bandpass(rng.standard_normal(m + 256), 100.0, 400.0, 2)[256:] * burst_env(m, 2.0, 0.12)
    body = _rms_scale(body, 1.0, 0.0, 0.06)
    sub = _falling_sine(m, 82.0, 52.0, 0.05, rng) * burst_env(m, 3.0, 0.24)
    tt = np.arange(m) / SR
    rings = sum(a * np.sin(2 * np.pi * f * tt + rng.uniform(0, 6.28)) * np.exp(-6.9078 * tt / t60)
                for f, a, t60 in ((133.0, 0.55, 0.30), (187.0, 0.45, 0.26), (254.0, 0.35, 0.22),
                                  (371.0, 0.22, 0.16)))
    rings[: int(0.002 * SR)] *= rise(int(0.002 * SR))
    clunk = 1.15 * body + 1.6 * sub + 0.55 * rings
    _add(out, clunk, t2, 1.0)
    return fade_edges(out, 0.0, 30.0)


@register("pilot_gear_b")
def pilot_gear_b(ctx):
    """Cinema: heavy science fiction machinery. A pneumatic hiss, a servo growl under a sweeping
    whine, a big locking slam with a sub drop and a metallic ring, a last puff of air. Two channels:
    the hiss, the whine and the ring are wide, the growl and the slam's low part sit in the middle."""
    n = ctx.n
    rng = ctx.rng()
    t_slam = 1.85
    mid = np.zeros(n)
    side = np.zeros(n)

    # pneumatic hiss, 0 to 0.25 s, 3 to 9 kHz: independent noise in mid and side makes it wide
    def hiss(seed, dur, lo, hi, attack, hold, t60):
        r = ctx.rng(seed)
        m = int(dur * SR)
        x = bandpass(r.standard_normal(m + 256), lo, hi, 2)[256:]
        x = x / np.sqrt(np.mean(x ** 2))
        e = _smooth_env(m, attack, hold, t60)
        return x * e
    _add(mid, hiss("hiss/m", 0.34, 3000.0, 9000.0, 0.004, 0.10, 0.07), 0.0, 0.75)
    _add(side, hiss("hiss/s", 0.34, 3000.0, 9000.0, 0.004, 0.10, 0.07), 0.0, 0.75)

    # servo growl, 70 to 160 Hz: a rough buzzy pulse, amplitude-modulated by uneven noise
    m = int(1.70 * SR)
    tt = np.arange(m) / SR
    u = np.clip(tt / 1.2, 0, 1)
    f = 70.0 + 85.0 * (3 * u ** 2 - 2 * u ** 3)
    f = f * (1.0 + 0.012 * np.sin(2 * np.pi * 5.2 * tt + 1.0))
    ph = 2 * np.pi * np.cumsum(f) / SR
    growl = sum(lv * np.sin(k * ph + rng.uniform(0, 6.28)) for k, lv in ((1, 1.0), (2, 0.8), (3, 0.55), (4, 0.4), (5, 0.25), (6, 0.15)))
    rough = lowpass(rng.standard_normal(m), 55.0, 2)
    rough = rough / np.max(np.abs(rough))
    growl = growl * (1.0 + 0.55 * rough) * (1.0 + 0.25 * np.sin(2 * np.pi * 31.0 * tt))
    genv = np.ones(m)
    genv[: int(0.25 * SR)] = rise(int(0.25 * SR))
    genv[-int(0.12 * SR):] *= (1 - np.arange(int(0.12 * SR)) / int(0.12 * SR))
    growl = lowpass(growl * genv, 650.0, 2)
    _add(mid, growl, 0.14, 0.34)

    # whine that sweeps 300 to 900 Hz and back down a little before the slam; each ear its own
    # slightly detuned copy (wide)
    def sweep(detune, seed):
        r = ctx.rng(seed)
        mm = int(1.62 * SR)
        t2 = np.arange(mm) / SR
        g = np.clip(t2 / 1.3, 0, 1)
        fq = 300.0 + 600.0 * (3 * g ** 2 - 2 * g ** 3)
        fq = fq * (1.0 - 0.18 * np.clip((t2 - 1.35) / 0.27, 0, 1) ** 2) * (1.0 + detune)
        fq = fq * (1.0 + 0.008 * np.sin(2 * np.pi * 6.1 * t2 + r.uniform(0, 6.28)))
        p = 2 * np.pi * np.cumsum(fq) / SR
        y = np.sin(p) + 0.45 * np.sin(2 * p + r.uniform(0, 6)) + 0.2 * np.sin(3 * p + r.uniform(0, 6))
        e = np.ones(mm)
        e[: int(0.30 * SR)] = rise(int(0.30 * SR))
        e[-int(0.10 * SR):] *= (1 - np.arange(int(0.10 * SR)) / int(0.10 * SR))
        return y * e
    wl, wr = sweep(-0.004, "sweep/l"), sweep(0.004, "sweep/r")
    _add(mid, 0.5 * (wl + wr), 0.22, 0.17)
    _add(side, 0.5 * (wl - wr), 0.22, 0.17)

    # the slam: crunch on top, a sub drop 70 to 35 Hz, a metallic ring of at least 0.4 s
    mm = n - int(t_slam * SR)
    tt = np.arange(mm) / SR
    f = 35.0 + 35.0 * np.exp(-tt / 0.16)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * _smooth_env(mm, 0.004, 0.08, 0.5)
    thud = bandpass(rng.standard_normal(mm + 256), 90.0, 450.0, 2)[256:] * burst_env(mm, 1.5, 0.16)
    thud = _rms_scale(thud, 1.0, 0.0, 0.08)
    crack = np.tanh(2.5 * _noise_burst(rng, 0.05, 250.0, 6000.0, 0.018, 0.3))
    _add(mid, 1.5 * sub + 1.1 * thud, t_slam, 0.9)
    _add(mid, crack, t_slam, 0.65)
    _add(side, _noise_burst(rng, 0.05, 900.0, 6000.0, 0.02, 0.3), t_slam, 0.35)
    ratios = [1.0, 1.52, 2.07, 2.61, 3.28, 4.04, 5.0, 6.1, 7.5, 9.1, 11.0, 13.6]
    pa, pb = _plate(mm, rng, 230.0, ratios, t60_ref=0.55, ref_hz=230.0, expo=0.8, tilt=0.5,
                    pair=(0.003, 0.009), drift=0.0009)
    pa[: int(0.001 * SR)] *= rise(int(0.001 * SR))
    pb[: int(0.001 * SR)] *= rise(int(0.001 * SR))
    _add(mid, 0.5 * (pa + pb), t_slam, 0.30)
    _add(side, 0.5 * (pa - pb), t_slam, 0.30)

    # a last puff of air as the pressure lets go
    puff = bandpass(ctx.rng("puff/m").standard_normal(int(0.22 * SR) + 256), 2500.0, 7500.0, 2)[256:]
    puff = puff / np.sqrt(np.mean(puff ** 2)) * _smooth_env(int(0.22 * SR), 0.035, 0.02, 0.08)
    puff2 = bandpass(ctx.rng("puff/s").standard_normal(int(0.22 * SR) + 256), 2500.0, 7500.0, 2)[256:]
    puff2 = puff2 / np.sqrt(np.mean(puff2 ** 2)) * _smooth_env(int(0.22 * SR), 0.035, 0.02, 0.08)
    _add(mid, puff, 2.20, 0.30)
    _add(side, puff2, 2.20, 0.30)

    y = mid_side(mid, side, periodic=False)
    return fade_edges(y, 0.0, 30.0)


@register("pilot_gear_c")
def pilot_gear_c(ctx):
    """Dark but clear: a whine of 150 to 350 Hz with harmonics up to 1.5 kHz heard through the
    structure, the lock as a tick of 1 to 3 kHz on a thunk of 80 to 250 Hz with weight below, no ring."""
    n = ctx.n
    rng = ctx.rng()
    t_lock = 1.55
    harm = [(1, 1.0), (2, 0.85), (3, 0.70), (4, 0.50)]
    whine, _ = _whine(n, rng, 0.05, t_lock - 0.02, 150.0, 350.0, 0.8, harm, stop_wind=0.10,
                      ratchet_hz=24.0, ratchet_depth=0.40)
    # a little duller: nothing above 3 kHz, the structure takes the top
    out = 0.55 * lowpass(whine, 1900.0, 4)
    teeth = _teeth(n, rng, 0.06, t_lock, 26.0, 900.0, 2400.0, 0.12)
    out += lowpass(teeth, 2600.0, 2)

    # the lock: a tick (1 to 3 kHz) leading a thunk (80 to 250 Hz) by about 2 ms, sub below 80 Hz
    tick = lowpass(_noise_burst(rng, 0.030, 1000.0, 3000.0, 0.007, 0.4), 3000.0, 4)
    m = n - int((t_lock + 0.002) * SR)
    body = bandpass(rng.standard_normal(m + 256), 80.0, 250.0, 2)[256:] * burst_env(m, 2.5, 0.10)
    body = _rms_scale(body, 1.0, 0.0, 0.06)
    sub = _falling_sine(m, 80.0, 52.0, 0.04, rng) * burst_env(m, 3.0, 0.16)
    thunk = 1.0 * body + 1.2 * sub
    _add(out, thunk, t_lock + 0.002, 1.0)
    _add(out, tick, t_lock, 1.0)
    return fade_edges(out, 0.0, 30.0)
