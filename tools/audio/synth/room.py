"""The cabin: the impulse response of a small metal cockpit and a function that puts sound in it."""
from __future__ import annotations

from functools import lru_cache
from itertools import product

import numpy as np

from .core import SR, exp_decay, freq_filter, seeded

C = 343.0
BOX = (2.2, 1.6, 1.4)  # metres: length, width, height
IR_SECONDS = 0.5


def _image_arrivals(src, dst, order: int = 3, absorb: float = 0.82):
    """Image-source arrivals (delay s, gain) of a rectangular metal box up to `order` bounces."""
    out = []
    L = np.array(BOX)
    for idx in product(range(-order, order + 1), repeat=3):
        bounces = sum(abs(i) for i in idx)
        if bounces > order or bounces == 0:
            continue
        img = np.array([(i * L[k] + (src[k] if i % 2 == 0 else L[k] - src[k]))
                        for k, i in enumerate(idx)])
        d = float(np.linalg.norm(img - dst))
        out.append((d / C, absorb**bounces / max(d, 0.3)))
    return out


@lru_cache(maxsize=1)
def cabin_ir() -> np.ndarray:
    """Stereo impulse response of a 2.2 x 1.6 x 1.4 m metal cockpit, shape (0.5 s * 48 kHz, 2).

    A direct impulse at sample 0, then first reflections from the walls (image sources, 3 to
    12 ms), then a dense decorrelated tail of 0.3 s that is a little boxy around 250 Hz. The
    two channels are the two ears: slightly different positions and independent tails.
    Deterministic; the same array is what the build writes as cabin_ir.wav."""
    n = int(IR_SECONDS * SR)
    ir = np.zeros((n, 2))
    src = (1.7, 0.8, 0.9)
    ears = ((0.9, 0.71, 0.95), (0.9, 0.89, 0.95))
    t = np.arange(n) / SR
    for ch, ear in enumerate(ears):
        ir[0, ch] = 1.0
        for delay, gain in _image_arrivals(src, ear):
            if delay < 0.003:  # keep the direct sound alone for the first 3 ms
                continue
            i = delay * SR
            i0 = int(i)
            frac = i - i0
            if i0 + 1 < n:
                g = 0.55 * gain * (1 if (i0 + ch) % 2 == 0 else -1)
                ir[i0, ch] += g * (1 - frac)
                ir[i0 + 1, ch] += g * frac
        rng = seeded("cabin_ir/tail/%d" % ch)
        noise = rng.standard_normal(n)
        bright = freq_filter(noise, lo=300, hi=5500, order=2) * exp_decay(n, 0.22)
        dark = freq_filter(noise[::-1].copy(), lo=120, hi=1200, order=2) * exp_decay(n, 0.30)
        # the boxy tone: a ringing resonance around 250 Hz, a little different per ear
        box = freq_filter(rng.standard_normal(n), lo=225 + 12 * ch, hi=285 + 12 * ch, order=3) * exp_decay(n, 0.30)
        tail = bright * 0.55 + dark * 0.45 + box * 2.0
        tail = tail / np.sqrt(np.mean(tail[int(0.012 * SR): int(0.1 * SR)] ** 2)) * 0.050
        onset = np.clip((t - 0.008) / 0.006, 0, 1)
        ir[:, ch] += tail * onset
    ir *= np.clip((0.5 - t) / 0.03, 0, 1)[:, None]  # round off the end
    return ir


def apply_cabin(x: np.ndarray, ir: np.ndarray | None = None, wet: float = 1.0, periodic: bool = False) -> np.ndarray:
    """Put a dry sound into the cabin. Mono input gives a stereo output (n, 2); a stereo input is
    convolved channel by channel. With periodic=True the convolution is circular, so a loop
    stays a loop; otherwise the result is cut to the input length (leave silence at the end).
    `wet` scales everything except the direct sound."""
    ir = cabin_ir() if ir is None else ir
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    direct = np.zeros_like(ir)
    direct[0] = ir[0]
    h = direct + wet * (ir - direct)
    out = np.zeros((n, 2))
    for ch in range(2):
        if periodic:
            hh = np.zeros(n)
            m = min(n, h.shape[0])
            hh[:m] = h[:m, ch]
            out[:, ch] = np.fft.irfft(np.fft.rfft(x[:, ch]) * np.fft.rfft(hh), n)
        else:
            from scipy.signal import fftconvolve

            out[:, ch] = fftconvolve(x[:, ch], h[:, ch])[:n]
    return out


SIDE_LOW_HZ = 150.0     # below this the two ears hear the same thing: bass has no direction in a small cabin
SIDE_CORNER_HZ = 170.0  # the side's high-pass corner: a little above 150 Hz, so that what is left below 150 Hz is tiny


def mid_side(mid: np.ndarray, side: np.ndarray, periodic: bool = True, ratio: float | None = None) -> np.ndarray:
    """Two channels from a mid and a side signal (SOUND_DESIGN.md, section Space).

    left = mid + side and right = mid - side, so (left + right) / 2 is exactly `mid`, the sound as
    it was approved in mono. The side loses everything below 150 Hz first (a steep high-pass with its corner at 170 Hz), which
    keeps the bass in the middle. periodic=True filters circularly (a loop stays a loop), False
    uses a causal filter (a one-shot). `ratio`, if given, sets the RMS of the filtered side to
    that fraction of the RMS of the mid; the power ratio is its square. Returns shape (n, 2)."""
    from .core import freq_filter, highpass, rms

    mid = np.asarray(mid, dtype=np.float64)
    side = np.asarray(side, dtype=np.float64)
    if mid.shape != side.shape or mid.ndim != 1:
        raise ValueError("mid and side must be mono arrays of the same length")
    side = freq_filter(side, lo=SIDE_CORNER_HZ, order=12) if periodic else highpass(side, SIDE_CORNER_HZ, 8)
    if ratio is not None:
        side = side * (ratio * rms(mid) / max(rms(side), 1e-12))
    return np.stack([mid + side, mid - side], axis=1)
