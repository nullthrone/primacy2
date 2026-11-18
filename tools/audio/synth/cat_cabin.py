"""Cabin: the room tone of the cockpit (engines off, and silent running) and its impulse response."""
import numpy as np

from . import (SR, apply_cabin, cabin_ir, exp_decay, machine_tone, normalize_rms, periodic_noise, register,
               rise, rms, seeded, slow_wander, transformer_tone)


def thermal_ticks(n: int, count: int, rng, min_gap_s: float = 1.2) -> np.ndarray:
    """Metal that changes temperature: sparse short ticks, each a rounded dull knock plus a
    small ringing around 1.5 to 3 kHz. Returns (n, 2); events wrap around the loop end."""
    pos = []
    while len(pos) < count:
        p = int(rng.integers(0, n))
        if all(min(abs(p - q), n - abs(p - q)) > min_gap_s * SR for q in pos):
            pos.append(p)
    length = int(0.25 * SR)
    t = np.arange(length) / SR
    out = np.zeros((n, 2))
    for p in pos:
        f = rng.uniform(1500, 3000)
        f_low = rng.uniform(220, 300)
        ev = (0.35 * np.sin(2 * np.pi * f_low * t) * np.exp(-6.9 * t / 0.06)
              + 0.5 * np.sin(2 * np.pi * f * t) * np.exp(-6.9 * t / 0.020)
              + 0.25 * np.sin(2 * np.pi * f * 1.52 * t + 1.0) * np.exp(-6.9 * t / 0.012))
        ev[: int(0.0006 * SR)] *= rise(int(0.0006 * SR))
        pan = rng.uniform(0.55, 1.0)
        idx = (p + np.arange(length)) % n
        gain = rng.uniform(0.6, 1.0)
        out[idx, 0] += gain * pan * ev
        out[idx, 1] += gain * (1.55 - pan) * ev
    return out


def _stereo(fn):
    return np.stack([fn(0), fn(1)], axis=1)


@register("cabin_ambience_loop")
def cabin_ambience(ctx):
    n = ctx.n
    s = lambda name, ch: seeded("cabin/%s/%d" % (name, ch))
    # life-support fan: broad air noise, blade-pass partials that beat, a faint motor whine
    air = _stereo(lambda c: periodic_noise(n, "pink", s("air", c), lo=80, hi=1300, order=3))
    blades = _stereo(lambda c: machine_tone(n, 146.0, (1, 2, 3), (1.0, 0.45, 0.2), beat_hz=0.35,
                                            flutter_hz=0.6, flutter=0.004, rng=s("blades", c)))
    whine = _stereo(lambda c: machine_tone(n, 1180.0, (1,), (1.0,), beat_hz=0.2, flutter_hz=0.4,
                                           flutter=0.002, rng=s("whine", c)))
    hum = _stereo(lambda c: transformer_tone(n, 100.0, 0.0, s("hum", c)))
    drift = 1.0 + 0.08 * slow_wander(n, s("drift", 0), 0.1, 0.8)  # the fan breathes a little
    bed = (1.0 * air + 0.55 * blades + 0.015 * whine + 0.22 * hum) * drift[:, None]
    bed = normalize_rms(bed)
    ticks = thermal_ticks(n, 5, seeded("cabin/ticks/ambience"))
    dry = bed + 5.0 * ticks
    return apply_cabin(dry, periodic=True)


@register("silent_running_loop", swing_max=12.0)  # the ticks are the content: they may stand out
def silent_running(ctx):
    n = ctx.n
    s = lambda name, ch: seeded("silent/%s/%d" % (name, ch))
    hum = _stereo(lambda c: transformer_tone(n, 100.0, 0.0, s("hum", c)))
    noise = _stereo(lambda c: periodic_noise(n, "pink", s("floor", c), lo=60, hi=1200, order=2))
    bed = normalize_rms(hum) * 1.0 + 0.45 * normalize_rms(noise)
    bed = normalize_rms(bed)
    ticks = thermal_ticks(n, 4, seeded("cabin/ticks/silent"), min_gap_s=2.0)
    dry = bed + 6.0 * ticks
    return apply_cabin(dry, periodic=True)


@register("cabin_ir")
def cabin_impulse_response(ctx):
    ir = cabin_ir()
    if ir.shape[0] != ctx.n:
        raise ValueError("cabin_ir length %d does not match sounds.json (%d)" % (ir.shape[0], ctx.n))
    return ir
