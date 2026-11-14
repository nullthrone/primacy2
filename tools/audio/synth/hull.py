"""The hull: the ship's one voice. Every structure sound is an excitation sent through it.

The hull is a fixed table of inharmonic modes. Higher modes die faster. After the hull the
structure path has a steep low-pass, and only when the shaking is strong a few rattles of cabin
fittings (1 to 4 kHz) are added on top, far below the main level.
"""
from __future__ import annotations

import numpy as np

from .core import (SR, _gen, burst_env, exp_decay, fade_edges, normalize_rms, periodic_noise, rms,
                   bandpass, lowpass, freq_filter, rise)

# frequency Hz, level, T60 seconds (how long the mode rings after a blow)
MODES = np.array([
    [37.0, 1.00, 2.00],
    [53.0, 0.85, 1.50],
    [71.0, 0.95, 1.20],
    [89.0, 0.70, 0.95],
    [118.0, 0.80, 0.75],
    [147.0, 0.55, 0.55],
    [163.0, 0.60, 0.50],
    [211.0, 0.45, 0.36],
    [268.0, 0.35, 0.26],
    [334.0, 0.28, 0.20],
])
N_MODES = len(MODES)


def hull_ir(n: int, sharp: float = 1.0, gains=None) -> np.ndarray:
    """Impulse response of the hull, n samples. `sharp` scales how long the modes ring (1 is the
    table; engines use less because a steady source damps the structure); `gains` is one factor
    per mode (a mode that is not excited rings at gain 0).

    The level is fixed by the full table at the same sharpness, so changing gains changes the
    balance of the modes without secretly re-normalising the sum."""
    t = np.arange(n) / SR
    g = np.ones(N_MODES) if gains is None else np.asarray(gains, dtype=np.float64)

    def build(gv):
        ir = np.zeros(n)
        for (f, a, t60), gk in zip(MODES, gv):
            if gk <= 0:
                continue
            ir += gk * a * np.exp(-6.9078 * t / (t60 * sharp)) * np.sin(2 * np.pi * f * t)
        return ir

    ref = build(np.ones(N_MODES))
    norm = np.sqrt(np.sum(ref[: min(n, 4 * SR)] ** 2))
    return build(g) / max(norm, 1e-12)


def through_hull(x: np.ndarray, periodic: bool = False, sharp: float = 1.0, gains=None,
                 dry: float = 0.0) -> np.ndarray:
    """Send an excitation through the hull. With periodic=True the convolution is circular, so
    a loop stays a loop. `dry` mixes in some of the excitation itself (the hull also carries
    broad low energy that is not a mode)."""
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]
    ir = hull_ir(n, sharp, gains)
    if periodic:
        y = np.fft.irfft(np.fft.rfft(x) * np.fft.rfft(ir), n)
    else:
        from scipy.signal import fftconvolve

        y = fftconvolve(x, ir)[:n]
    return y + dry * x if dry else y


def structure_lowpass(x: np.ndarray, periodic: bool = False, fc: float = 650.0, order: int = 8) -> np.ndarray:
    """The steep low-pass of the structure path: almost nothing is left above 1.2 kHz."""
    return freq_filter(x, hi=fc, order=order) if periodic else lowpass(x, fc, order)


def rattles(n: int, activity: float, rng=None, per_second: float = 3.0, periodic: bool = True,
            lo: float = 1200.0, hi: float = 3500.0) -> np.ndarray:
    """Short rattles of cabin fittings, 1 to 4 kHz, sparse. About unit RMS at activity 1.

    A fixed pool of events (positions, pitches, thresholds) comes from the rng; `activity`
    from 0 to 1 decides which of them sound and how strongly, so a weaker setting is a subset
    of a stronger one (needed when levels of one engine crossfade). With periodic=True a tail
    that reaches past the end wraps around to the start."""
    rng = _gen(rng)
    count = max(1, int(per_second * n / SR))
    pos = rng.integers(0, n, count)
    thr = rng.uniform(0.0, 1.0, count)
    amp = rng.uniform(0.4, 1.0, count)
    f1 = rng.uniform(lo, 0.7 * hi, count)
    f2 = np.minimum(f1 * rng.uniform(1.2, 1.5, count), 4000.0)  # nothing above 4 kHz
    t60 = rng.uniform(0.02, 0.07, count)
    length = int(0.2 * SR)
    t = np.arange(length) / SR
    out = np.zeros(n)
    for i in range(count):
        gain = float(np.clip((activity - thr[i]) / 0.25, 0.0, 1.0))
        if gain <= 0:
            continue
        ph = rng.uniform(0, 2 * np.pi, 2)
        env = np.exp(-6.9078 * t / t60[i]) * rise(length)[::-1] ** 0.5
        env[: int(0.0008 * SR)] *= rise(int(0.0008 * SR))
        ev = env * (np.sin(2 * np.pi * f1[i] * t + ph[0]) + 0.6 * np.sin(2 * np.pi * f2[i] * t + ph[1]))
        seg = gain * amp[i] * ev
        idx = pos[i] + np.arange(length)
        if periodic:
            np.add.at(out, idx % n, seg)
        else:
            keep = idx < n
            np.add.at(out, idx[keep], seg[keep])
    r = rms(out)
    # normalise by the full pool so that levels stay comparable between activities
    return out / max(_pool_rms(count, n, amp, t60), 1e-9) if r > 0 else out


def _pool_rms(count: int, n: int, amp, t60) -> float:
    # energy of one event is about amp^2 * t60 * SR / 13.8 * (1 + 0.36) / 2; spread over n
    e = np.sum(amp**2 * t60 * SR / 13.8 * 1.36 / 2.0)
    return float(np.sqrt(e / n))


def thump(n: int, f_start: float = 90.0, f_end: float = 45.0, attack_ms: float = 3.0,
          t60: float = 0.15, glide_s: float = 0.06) -> np.ndarray:
    """The body of a blow: a low sine that falls in pitch, risen over a few ms with a rounded edge."""
    t = np.arange(n) / SR
    f = f_end + (f_start - f_end) * np.exp(-t / glide_s)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase) * burst_env(n, attack_ms, t60)


def hull_blow(n: int, strength: float = 0.5, rng=None, sharp: float = 1.0, ring: float = 1.0) -> np.ndarray:
    """A blow on the structure, structure path complete (not level-set): a thump, the hull
    ringing after it, a steep low-pass, and rattles when strength is high (above about 0.6).
    `strength` is 0 to 1; `ring` scales the level of the hull ringing against the thump."""
    rng = _gen(rng)
    pulse = np.zeros(n)
    m = min(n, int(0.012 * SR))
    pulse[:m] = burst_env(m, 2.5, 0.008) * rng.standard_normal(m)
    pulse = lowpass(pulse, 500, 2)
    ringing = through_hull(pulse, sharp=sharp)
    body = thump(n, 80 + 30 * strength, 40 + 10 * strength, 3.0, 0.10 + 0.25 * strength)
    scale = rms(body[: int(0.2 * SR)]) / max(rms(ringing[: int(0.2 * SR)]), 1e-9)
    y = body + ring * 0.7 * scale * ringing
    y = structure_lowpass(y, periodic=False)
    act = float(np.clip((strength - 0.5) / 0.5, 0, 1))
    if act > 0:
        r = rattles(n, act, rng, per_second=6.0, periodic=False)
        env = burst_env(n, 4.0, 0.15 + 0.6 * strength)
        y = y + 0.06 * act * rms(y[: int(0.3 * SR)]) * r * env * 8
    # the hull rings longer than a short file: let the end fade over the last quarter
    return fade_edges(y, 0.0, min(250.0, 0.25 * 1000.0 * n / SR))
