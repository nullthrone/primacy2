"""Sensors: designed signals from a loudspeaker (sonification), rendered dry.

Sober avionics: soft attacks, a few harmonics, nothing above 6 kHz, level well below the alarms.
Tone helpers come from cat_alarms.py.
"""
import numpy as np

from . import LEVELS, SR, exp_decay, fade_edges, freq_filter, register, rise, seeded
from .cat_alarms import bell_env, gate, phase_of, speaker, voice

LEVELS.update({
    "sensor_contact_ping": ("lufs", -27.0),
    "sensor_lock_tone": ("lufs", -27.0),
    "sensor_proximity_tick": ("lufs", -27.0),
    "sensor_fire_outside": ("lufs", -27.0),
    "sensor_explosion_outside": ("lufs", -27.0),
})


def _end(y, ms=25.0):
    return fade_edges(y, 0.0, ms)


@register("sensor_contact_ping")
def contact_ping(ctx):
    """One soft ping: 1.1 kHz with a faint octave, 10 ms rise, a tail of about 0.35 s."""
    n = ctx.n
    tone = voice(np.full(n, 1100.0), (1.0, 0.28, 0.08))
    return _end(speaker(tone * bell_env(n, 0.0, 0.32, 10)), 60.0)


@register("sensor_lock_tone")
def lock_tone(ctx):
    """Two quick rising tones, a fourth apart (880 then 1175 Hz), the second a little longer."""
    n = ctx.n
    a = voice(np.full(n, 880.0), (1.0, 0.3, 0.1)) * gate(n, 0.0, 0.14, 12, 30)
    b = voice(np.full(n, 1175.0), (1.0, 0.3, 0.1)) * gate(n, 0.18, 0.26, 12, 120)
    return _end(speaker(a + 1.1 * b), 40.0)


@register("sensor_proximity_tick")
def proximity_tick(ctx):
    """A tick of 25 ms: 1.8 kHz with a rounded onset, since the page repeats it up to many times a second."""
    n = ctx.n
    t = np.arange(n) / SR
    tick = np.sin(2 * np.pi * 1800.0 * t) + 0.25 * np.sin(2 * np.pi * 3600.0 * t + 0.5)
    env = exp_decay(n, 0.03)
    a = int(0.0025 * SR)
    env[:a] *= rise(a)
    return _end(speaker(tick * env), 15.0)


@register("sensor_fire_outside")
def fire_outside(ctx):
    """A muted burst of six ticks, quickening and fading: band-limited noise grains with a tone core."""
    n = ctx.n
    rng = ctx.rng("grains")
    y = np.zeros(n)
    times = np.cumsum([0.0, 0.034, 0.032, 0.03, 0.028, 0.026])
    for k, s in enumerate(times):
        m = int(0.014 * SR)
        g = rng.standard_normal(m)
        g = freq_filter(g, 1400, 3400, order=3) if m > 8 else g
        env = exp_decay(m, 0.012)
        env[:int(0.002 * SR)] *= rise(int(0.002 * SR))
        tt = np.arange(m) / SR
        grain = g / max(np.std(g), 1e-9) * 0.5 + np.sin(2 * np.pi * (1500 + 90 * k) * tt)
        i = int(s * SR)
        y[i:i + m] += grain * env * (1.0 - 0.11 * k)
    return _end(speaker(y), 40.0)


@register("sensor_explosion_outside")
def explosion_outside(ctx):
    """A soft falling sweep (1.4 kHz to 280 Hz) through noise; the noise band falls with it."""
    n = ctx.n
    t = np.arange(n) / SR
    rng = ctx.rng("noise")
    f = 1400.0 * (280.0 / 1400.0) ** np.clip(t / 1.0, 0, 1)
    sweep = voice(f, (1.0, 0.35, 0.12))
    noise = rng.standard_normal(n)
    # a moving band: three fixed bands cross-faded along the sweep, cheaper than a time-varying filter
    bands = [freq_filter(noise, lo, hi, order=3) for lo, hi in ((250, 600), (600, 1400), (1400, 2800))]
    pos = np.clip(t / 1.0, 0, 1)
    # high band early, mid band in the middle, low band late
    w = [np.clip(2 * pos - 1, 0, 1), np.clip(1 - np.abs(2 * pos - 1), 0, 1), np.clip(1 - 2 * pos, 0, 1)]
    mov = bands[0] * w[0] + bands[1] * w[1] + bands[2] * w[2]
    mov = mov / max(np.std(mov), 1e-9)
    env = np.exp(-6.9 * t / 0.95)
    env[:int(0.012 * SR)] *= rise(int(0.012 * SR))
    y = (0.8 * sweep + 0.9 * mov) * env
    return _end(speaker(y, hi=3800.0), 80.0)
