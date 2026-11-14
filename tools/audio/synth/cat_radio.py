"""Radio: signal tones and squelch from the radio loudspeaker, rendered dry.

Everything goes through radio.radio_filter (band 300 to 3,400 Hz, mild overdrive); noise is made
before the filter so that the band edges hold.
"""
import numpy as np

from . import LEVELS, SR, exp_decay, fade_edges, freq_filter, periodic_lfo, periodic_noise, register, rise, rms, seeded
from .radio import radio_filter

LEVELS.update({
    "radio_squelch_open": ("peak", -14.0),
    "radio_squelch_close": ("peak", -14.0),
    "radio_static_loop": ("lufs", -32.0),
    "radio_tone": ("peak", -14.0),
})


def _noise(n, rng):
    return rng.standard_normal(n)


@register("radio_squelch_open")
def squelch_open(ctx):
    """Key click (a short rounded tick) and a breath of noise that falls away."""
    n = ctx.n
    t = np.arange(n) / SR
    rng = ctx.rng("noise")
    click = np.sin(2 * np.pi * 1600 * t) * np.exp(-6.9 * t / 0.006)
    click[: int(0.0008 * SR)] *= rise(int(0.0008 * SR))
    breath = _noise(n, rng) * exp_decay(n, 0.09)
    breath[: int(0.004 * SR)] *= rise(int(0.004 * SR))
    x = 0.9 * click / max(rms(click), 1e-9) * 0.3 + 0.5 * breath / max(rms(breath), 1e-9) * 0.4
    y = radio_filter(x, SR, drive=2.0, noise_db=None)
    return fade_edges(y, 0.0, 25.0)


@register("radio_squelch_close")
def squelch_close(ctx):
    """The squelch tail: a hiss that holds a moment and is cut off, then a faint click."""
    n = ctx.n
    rng = ctx.rng("noise")
    hold = int(0.11 * SR)
    hiss = _noise(n, rng)
    env = np.zeros(n)
    env[:hold] = 1.0
    env[:hold] *= np.exp(-6.9 * np.arange(hold) / (SR * 0.35))
    env[:int(0.006 * SR)] *= rise(int(0.006 * SR))
    env[hold - int(0.004 * SR):hold] *= rise(int(0.004 * SR))[::-1]   # cut off, not faded
    t = np.arange(n) / SR
    off = np.zeros(n)
    s = hold + int(0.012 * SR)
    m = int(0.02 * SR)
    off[s:s + m] = np.sin(2 * np.pi * 1300 * t[:m]) * np.exp(-6.9 * t[:m] / 0.008)
    off[s:s + int(0.001 * SR)] *= rise(int(0.001 * SR))
    x = hiss * env / 1.0 + 0.7 * off
    y = radio_filter(x, SR, drive=2.0, noise_db=None)
    return fade_edges(y, 0.0, 30.0)


@register("radio_static_loop")
def static_loop(ctx):
    """An open channel: band-limited noise that fades slowly (one cycle per loop) with faint crackle."""
    n = ctx.n
    s = lambda name: seeded("radio/static/" + name)
    bed = periodic_noise(n, "white", s("bed"), lo=300, hi=3400, order=4)
    fade = 1.0 + 0.25 * periodic_lfo(n, 0.25, 0.1) + 0.12 * periodic_lfo(n, 0.75, 0.55)
    bed = bed * fade
    # crackle: sparse impulses, a few a second, band-limited circularly so the loop closes
    rng = s("crackle")
    imp = np.zeros(n)
    for p in rng.integers(0, n, size=int(ctx.spec["duration"] * 7)):
        imp[p] += rng.choice([-1.0, 1.0]) * rng.uniform(0.3, 1.0)
    crackle = freq_filter(imp, 700, 3300, order=3)
    crackle = crackle / max(np.max(np.abs(crackle)), 1e-9)
    y = bed / rms(bed) + 1.5 * crackle * 0.4
    y = freq_filter(y, 300, 3400, order=4)
    # the mild overdrive is pointwise, so it keeps the loop closed; then the band edges again
    y = np.tanh(1.3 * y) / np.tanh(1.3)
    y = freq_filter(y, 300, 3400, order=4)
    return y - y.mean()


@register("radio_tone")
def radio_tone(ctx):
    """The pure tone of a ground transmission: 1 kHz, soft edges, a faint overdrive."""
    n = ctx.n
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 1000.0 * t)
    g = np.zeros(n)
    m = int(0.2 * SR)
    g[:m] = 1.0
    a = int(0.008 * SR)
    g[:a] *= rise(a)
    g[m - a:m] *= rise(a)[::-1]
    y = radio_filter(tone * g, SR, drive=1.6, noise_db=None)
    return fade_edges(y, 0.0, 10.0)
