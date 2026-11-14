"""Switches and relays: small mechanical events in the cabin, rendered with the cabin baked in.

Every event is built from the same three parts, in different amounts: a rounded tick (band-passed
noise, rise of about 0.5 ms so it is crisp but not a digital click), a ringing of the part
that was struck (one or two damped resonances in the kHz range), and a low thunk (a short falling
sine, the body of the panel). The cabin reverb comes last.
"""
import numpy as np

from . import LEVELS, SR, apply_cabin, exp_decay, fade_edges, freq_filter, register, rise, seeded

LEVELS.update({
    "systems_power_up": ("peak", -14.0),
    "systems_power_down": ("peak", -14.0),
})


def tick(n, t0, lo, hi, t60, amp, rng, rise_ms=0.5):
    """Band-passed noise burst starting at t0 seconds."""
    i = int(t0 * SR)
    m = int(min(n - i, 6 * t60 * SR))
    if m <= 8:
        return np.zeros(n)
    g = freq_filter(rng.standard_normal(m), lo, hi, order=2)
    g = g / max(np.std(g), 1e-9) * exp_decay(m, t60)
    r = max(int(rise_ms / 1000 * SR), 2)
    g[:r] *= rise(r)
    out = np.zeros(n)
    out[i:i + m] = amp * g
    return out


def ring(n, t0, f, t60, amp, partials=((1.0, 1.0),)):
    """A struck part ringing: damped sines, higher partials dying faster."""
    i = int(t0 * SR)
    m = int(min(n - i, 5 * t60 * SR))
    if m <= 8:
        return np.zeros(n)
    t = np.arange(m) / SR
    y = np.zeros(m)
    for k, (ratio, level) in enumerate(partials):
        y += level * np.sin(2 * np.pi * f * ratio * t + 0.9 * k) * np.exp(-6.9 * t / (t60 / (1 + 0.8 * k)))
    r = max(int(0.0005 * SR), 2)
    y[:r] *= rise(r)
    out = np.zeros(n)
    out[i:i + m] = amp * y
    return out


def thunk(n, t0, f0, f1, t60, amp):
    """Low body of the panel: a sine falling from f0 to f1 with a rounded start."""
    i = int(t0 * SR)
    m = int(min(n - i, 5 * t60 * SR))
    if m <= 8:
        return np.zeros(n)
    t = np.arange(m) / SR
    f = f1 + (f0 - f1) * np.exp(-t / (t60 / 3.5))
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_decay(m, t60)
    r = int(0.003 * SR)
    y[:r] *= rise(r)
    out = np.zeros(n)
    out[i:i + m] = amp * y
    return out


def _finish(y, tail_ms, guard_ms=12.0):
    """Taper the last tail_ms to zero, reaching exactly zero guard_ms before the end (the rule looks at the last 10 ms)."""
    n = y.size
    g = int(guard_ms / 1000 * SR)
    k = int(tail_ms / 1000 * SR)
    w = np.ones(n)
    w[n - g - k:n - g] = rise(k)[::-1]
    w[n - g:] = 0.0
    return y * w


def in_cabin(dry, tail_ms):
    """The cabin reverb, mono out, and a rounded end so that the file finishes in silence."""
    return _finish(apply_cabin(dry)[:, 0], tail_ms)


def relay(n, rng, f_ring, thunk_f, body, bounce_ms):
    """One relay closing: contact tick, a second small tick when the contact bounces, ring, thunk."""
    y = tick(n, 0.0, 1800, 5500, 0.003, 0.35, rng)
    y += tick(n, bounce_ms / 1000, 2200, 6000, 0.002, 0.45, rng)
    y += ring(n, 0.0, f_ring, 0.026, 1.2, ((1.0, 1.0), (1.93, 0.4)))
    y += thunk(n, 0.001, thunk_f, thunk_f * 0.5, 0.035, body)
    return y


@register("relay_click_a")
def relay_click_a(ctx):
    return in_cabin(relay(ctx.n, ctx.rng("a"), 2600.0, 150.0, 0.25, 5.5), 70)


@register("relay_click_b")
def relay_click_b(ctx):
    """The larger relay: a lower ring, a heavier thunk, a slower bounce."""
    return in_cabin(relay(ctx.n, ctx.rng("b"), 1500.0, 95.0, 0.28, 9.0), 70)


@register("switch_toggle")
def switch_toggle(ctx):
    """The lever snaps over the centre (two ticks, 14 ms apart, the second softer) and the spring rings."""
    n, rng = ctx.n, ctx.rng("t")
    y = tick(n, 0.0, 2000, 5800, 0.004, 1.0, rng)
    y += tick(n, 0.014, 1500, 5000, 0.005, 0.65, rng)
    y += ring(n, 0.014, 3100.0, 0.055, 0.35, ((1.0, 1.0), (1.51, 0.5), (2.2, 0.25)))
    y += ring(n, 0.0, 1750.0, 0.03, 0.3)
    y += thunk(n, 0.014, 180.0, 100.0, 0.03, 0.3)
    return in_cabin(y, 60)


@register("switch_rotary")
def switch_rotary(ctx):
    """Three detents 125 ms apart; each is a tick and a soft thunk, the pitch of the ring rising a little."""
    n, rng = ctx.n, ctx.rng("r")
    y = np.zeros(n)
    for k in range(3):
        t0 = 0.125 * k
        y += tick(n, t0, 1600 + 150 * k, 5000, 0.004, 0.35, rng)
        y += ring(n, t0, 1900.0 + 120 * k, 0.03, 0.7)
        y += thunk(n, t0, 140.0, 80.0, 0.03, 0.4)
    return in_cabin(y, 90)


@register("breaker_thunk")
def breaker_thunk(ctx):
    """A heavy breaker thrown: a firm clack with a low, short thunk and a faint latch settling after it."""
    n, rng = ctx.n, ctx.rng("b")
    y = tick(n, 0.0, 900, 4200, 0.012, 1.4, rng, rise_ms=0.9)
    y += ring(n, 0.0, 1100.0, 0.05, 0.45, ((1.0, 1.0), (2.4, 0.4)))
    y += thunk(n, 0.001, 105.0, 55.0, 0.07, 0.4)
    y += tick(n, 0.032, 1200, 4200, 0.006, 0.3, rng)
    y += ring(n, 0.032, 2300.0, 0.03, 0.12)
    return in_cabin(y, 110)


@register("button_press")
def button_press(ctx):
    """A soft, quiet tick of a key with short travel: almost no thunk, a little warmth at 700 Hz."""
    n, rng = ctx.n, ctx.rng("k")
    y = tick(n, 0.0, 1300, 4200, 0.0035, 0.35, rng, rise_ms=0.8)
    y += ring(n, 0.0, 2000.0, 0.016, 0.9)
    y += thunk(n, 0.0, 700.0, 450.0, 0.015, 0.25)
    return in_cabin(y, 40)


# --------------------------------------------------------------------------- power up and down

def _fan_and_hum(n, speed_fn, f_fan):
    """Fan air, blade-pass tone and mains hum; speed_fn gives the fan speed 0..1 per sample."""
    rng = seeded("switches/power/fan")
    t = np.arange(n) / SR
    speed = speed_fn(t)
    air = freq_filter(rng.standard_normal(n), 120, 1500, order=2)
    air = air / np.std(air)
    ph = np.cumsum(2 * np.pi * f_fan * (0.25 + 0.75 * speed) / SR)
    blade = np.sin(ph) + 0.4 * np.sin(2 * ph + 0.8)
    hum = np.sin(2 * np.pi * 100.0 * t) + 0.35 * np.sin(2 * np.pi * 300.0 * t + 1.0)
    return 0.7 * air * speed ** 2 + 0.5 * blade * speed ** 1.5 + 0.2 * hum * np.clip(speed * 1.5, 0, 1) ** 2


def _cascade(n, times, rng):
    """Relays dropping at the given times, each a little different."""
    y = np.zeros(n)
    m = int(0.12 * SR)
    for t0 in times:
        v = 0.8 + 0.4 * rng.random()
        r = relay(m, rng, rng.uniform(1500, 2700), rng.uniform(95, 160), rng.uniform(0.4, 0.8), rng.uniform(5, 9))
        i = int(t0 * SR)
        k = min(m, n - i)
        y[i:i + k] += v * r[:k]
    return y


@register("systems_power_up")
def systems_power_up(ctx):
    """Eight relays, quickening; the fan spins up from 0.3 s to 2.1 s, the hum rises and holds; fades to silence."""
    n = ctx.n
    rng = ctx.rng("relays")
    relays = _cascade(n, [0.0, 0.26, 0.50, 0.68, 0.83, 0.95, 1.05, 1.13], rng)
    fan = _fan_and_hum(n, lambda t: np.clip((t - 0.3) / 1.8, 0, 1) ** 1.6, 146.0)
    fan = fan / max(np.max(np.abs(fan)), 1e-9)
    dry = relays / max(np.max(np.abs(relays)), 1e-9) + 0.22 * fan
    y = apply_cabin(dry)[:, 0]
    tail = np.ones(n)
    k = int(0.9 * SR)
    tail[-k:] = rise(k)[::-1]
    return fade_edges(y * tail, 0.0, 20.0)


@register("systems_power_down")
def systems_power_down(ctx):
    """The fan runs down over 2 s, six relays drop out one by one, then silence."""
    n = ctx.n
    rng = ctx.rng("relays")
    relays = _cascade(n, [0.12, 0.50, 0.85, 1.20, 1.50, 1.78], rng)
    fan = _fan_and_hum(n, lambda t: np.clip(1 - t / 2.1, 0, 1) ** 1.3, 146.0)
    fan = fan / max(np.max(np.abs(fan)), 1e-9)
    fan *= np.clip((2.35 - np.arange(n) / SR) / 0.25, 0, 1)  # gone before the end
    dry = relays / max(np.max(np.abs(relays)), 1e-9) + 0.22 * fan
    return fade_edges(apply_cabin(dry)[:, 0], 0.0, 30.0)
