"""Basic building blocks: seeds, periodic noise, envelopes, filters, tones.

Everything that makes a loop is built to be periodic over the loop length n: noise is made in the
frequency domain with random phases, filters act on the spectrum (circular, zero phase), and tones
are snapped to a whole number of cycles per loop. A loop therefore has no seam to hide.
"""
from __future__ import annotations

import hashlib

import numpy as np

SR = 48000

_COLORS = {"white": 0.0, "pink": 0.5, "brown": 1.0}  # amplitude exponent: |X(f)| ~ f**-exponent


# --------------------------------------------------------------------------- seeds

def seeded(name: str) -> np.random.Generator:
    """A generator that depends only on the name: same name, same numbers, on every machine."""
    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return np.random.Generator(np.random.PCG64(int.from_bytes(digest[:8], "little")))


def _gen(rng) -> np.random.Generator:
    if rng is None:
        return seeded("default")
    if isinstance(rng, str):
        return seeded(rng)
    return rng


def rms(x) -> float:
    return float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))


def normalize_rms(x: np.ndarray, target: float = 1.0) -> np.ndarray:
    r = rms(x)
    return x * (target / r) if r > 0 else x


def db(x: float) -> float:
    return 20.0 * np.log10(max(float(x), 1e-12))


def undb(d: float) -> float:
    return 10.0 ** (d / 20.0)


# --------------------------------------------------------------------------- filters

def _band_gain(f: np.ndarray, lo, hi, order: int) -> np.ndarray:
    g = np.ones_like(f)
    with np.errstate(divide="ignore", invalid="ignore"):
        if lo:
            g = g / np.sqrt(1.0 + (lo / np.maximum(f, 1e-9)) ** (2 * order))
        if hi:
            g = g / np.sqrt(1.0 + (f / hi) ** (2 * order))
    return g


def freq_filter(x: np.ndarray, lo: float | None = None, hi: float | None = None, order: int = 4) -> np.ndarray:
    """Zero-phase band filter on the spectrum. Circular, so a periodic input stays periodic.

    `order` sets the steepness (6 dB per octave per unit of order, in amplitude)."""
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]
    f = np.fft.rfftfreq(n, 1.0 / SR)
    g = _band_gain(f, lo, hi, order)
    if x.ndim == 2:
        g = g[:, None]
    return np.fft.irfft(np.fft.rfft(x, axis=0) * g, n, axis=0)


def lowpass(x: np.ndarray, fc: float, order: int = 4) -> np.ndarray:
    """Causal Butterworth low-pass for one-shots (no pre-ringing before an onset)."""
    from scipy.signal import butter, sosfilt

    sos = butter(order, fc, "low", fs=SR, output="sos")
    return sosfilt(sos, np.asarray(x, dtype=np.float64), axis=0)


def highpass(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    from scipy.signal import butter, sosfilt

    sos = butter(order, fc, "high", fs=SR, output="sos")
    return sosfilt(sos, np.asarray(x, dtype=np.float64), axis=0)


def bandpass(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    from scipy.signal import butter, sosfilt

    sos = butter(order, [lo, hi], "band", fs=SR, output="sos")
    return sosfilt(sos, np.asarray(x, dtype=np.float64), axis=0)


def resonator(x: np.ndarray, f: float, t60: float) -> np.ndarray:
    """A two-pole resonance at f Hz that rings for t60 seconds (60 dB). Roughly unit peak gain."""
    from scipy.signal import lfilter

    r = np.exp(-6.9078 / (t60 * SR))
    w = 2 * np.pi * f / SR
    b = [(1 - r) * np.sin(w)]
    a = [1.0, -2 * r * np.cos(w), r * r]
    return lfilter(b, a, np.asarray(x, dtype=np.float64))


# --------------------------------------------------------------------------- noise

def periodic_noise(n: int, color: str = "white", rng=None, lo: float | None = None,
                   hi: float | None = None, order: int = 4) -> np.ndarray:
    """Noise that repeats exactly every n samples, unit RMS, zero mean.

    color is white, pink or brown; lo and hi band-limit it (zero phase). The random phases are
    always drawn for every bin, so the same rng gives the same noise whatever lo and hi are:
    that is what lets a family of sounds share one noise and differ only in how it is shaped."""
    if n % 2:
        raise ValueError("loop length must be even")
    rng = _gen(rng)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    amp = np.zeros_like(f)
    amp[1:] = f[1:] ** -_COLORS[color]
    phase = rng.uniform(0.0, 2 * np.pi, f.size)
    phase[0] = 0.0
    phase[-1] = 0.0
    amp = amp * _band_gain(f, lo, hi, order)
    amp[0] = 0.0
    x = np.fft.irfft(amp * np.exp(1j * phase), n)
    return normalize_rms(x)


def white_noise(n: int, rng=None) -> np.ndarray:
    """Ordinary (not periodic) white noise, unit RMS, for one-shots."""
    return _gen(rng).standard_normal(n)


# --------------------------------------------------------------------------- envelopes

def rise(n: int) -> np.ndarray:
    """A half-cosine ramp from 0 to 1 over n samples: a rounded edge, never a click."""
    if n <= 0:
        return np.zeros(0)
    return 0.5 - 0.5 * np.cos(np.pi * (np.arange(n) + 0.5) / n)


def exp_decay(n: int, t60: float) -> np.ndarray:
    """Exponential decay that falls by 60 dB in t60 seconds."""
    return np.exp(-6.9078 * np.arange(n) / (SR * t60))


def burst_env(n: int, attack_ms: float = 3.0, t60: float = 0.2) -> np.ndarray:
    """Rounded rise (2 to 5 ms for a blow) followed by an exponential decay."""
    a = max(1, int(SR * attack_ms / 1000.0))
    env = exp_decay(n, t60)
    env[: min(a, n)] *= rise(min(a, n))
    return env


def fade_edges(x: np.ndarray, in_ms: float = 0.0, out_ms: float = 10.0) -> np.ndarray:
    """Round off the start and end of a one-shot so that it ends in true silence."""
    y = np.array(x, dtype=np.float64)
    shape = (-1,) + (1,) * (y.ndim - 1)
    a, b = int(SR * in_ms / 1000.0), int(SR * out_ms / 1000.0)
    if a:
        y[:a] *= rise(a).reshape(shape)
    if b:
        y[-b:] *= rise(b)[::-1].reshape(shape)
    return y


def periodic_lfo(n: int, hz: float, phase: float = 0.0) -> np.ndarray:
    """A sine with a whole number of cycles in n samples (hz is rounded to the loop grid)."""
    cycles = max(1, round(hz * n / SR))
    return np.sin(2 * np.pi * (cycles * np.arange(n) / n + phase))


def slow_wander(n: int, rng=None, lo: float = 0.2, hi: float = 3.0) -> np.ndarray:
    """Periodic random modulation between lo and hi Hz, about +-1 (peak-normalised)."""
    x = periodic_noise(n, "white", rng, lo=lo, hi=hi, order=3)
    return x / np.max(np.abs(x))


# --------------------------------------------------------------------------- tones

def snap_freq(f: float, n: int) -> float:
    """The nearest frequency with a whole number of cycles in n samples."""
    cycles = max(1, round(f * n / SR))
    return cycles * SR / n


def sine(n: int, f: float, phase: float = 0.0, snap: bool = True) -> np.ndarray:
    """A sine; with snap the frequency is moved to the loop grid so that the loop closes."""
    if snap:
        f = snap_freq(f, n)
    return np.sin(2 * np.pi * (f * np.arange(n) / SR + phase))


def machine_tone(n: int, f0: float, partials=(1.0, 2.0, 3.0), levels=(1.0, 0.5, 0.25),
                 beat_hz: float = 0.5, flutter_hz: float = 3.0, flutter: float = 0.002,
                 beat_depth: float = 0.5, rng=None) -> np.ndarray:
    """A pump or reactor: a few partials, each a close pair that beats slowly, with a little
    flutter (frequency modulation, `flutter` is the relative depth). The second component of a
    pair has `beat_depth` times the level of the first: 1 beats down to silence, 0.3 swings the
    level by about 5 dB. Frequencies are snapped and the flutter closes over the loop, so the
    result repeats exactly every n samples."""
    rng = _gen(rng)
    t = np.arange(n) / SR
    cyc = max(1, round(flutter_hz * n / SR))
    out = np.zeros(n)
    for p, lv in zip(partials, levels):
        base = f0 * p
        for sign, w in ((-0.5, 1.0), (0.5, beat_depth)):
            f = snap_freq(base + sign * beat_hz * p, n)
            ph = rng.uniform(0, 2 * np.pi)
            # phase deviation of a sinusoidal FM: (depth * f / flutter rate) * sin(...); the
            # sine has a whole number of cycles per loop, so the phase closes.
            dev = 2 * np.pi * flutter * rng.uniform(0.7, 1.3) * f / (cyc * SR / n)
            fl = np.sin(2 * np.pi * cyc * np.arange(n) / n + rng.uniform(0, 2 * np.pi))
            out += w * lv * np.sin(2 * np.pi * f * t + ph + dev * fl)
    return out / ((1 + beat_depth) * sum(levels))


def transformer_tone(n: int, f0: float = 100.0, load: float = 0.0, rng=None) -> np.ndarray:
    """Mains hum of a transformer: f0 with odd harmonics; under load the harmonics grow and a
    growl (band-limited noise amplitude-modulating the hum) appears. Periodic."""
    rng = _gen(rng)
    out = np.zeros(n)
    for k in (1, 3, 5, 7, 9):
        w = k ** -(1.6 - 1.0 * load)
        out += w * sine(n, f0 * k, rng.uniform(0, 1))
    growl = slow_wander(n, rng, lo=20.0, hi=120.0)
    out = out * (1.0 + 0.6 * load * growl)
    return out / np.max(np.abs(out))
