"""Alarms: the cabin loudspeaker, rendered dry.

Model is an aircraft cockpit warning: a few harmonics with soft edges, band-limited like a small
speaker. The six differ in rhythm and contour, not only in pitch: a slow two-tone (heat), five
fast pulses (missile), three hard falling sweeps and a fading buzz once (shields), one chime and a long pause (fuel),
two heavy buzzer pulses (hull), a rising double chime once (master caution).

The helpers `phase_of`, `voice`, `gate` and `speaker` are reused by cat_sensors.py; they belong
in the library and can be moved there later.
"""
import numpy as np

from . import LEVELS, SR, freq_filter, rise, seeded


def phase_of(freq: np.ndarray) -> np.ndarray:
    """Phase in radians of a (possibly gliding) frequency track given per sample in Hz."""
    return 2 * np.pi * np.cumsum(freq) / SR


def voice(freq, amps=(1.0, 0.45, 0.2), ratios=None) -> np.ndarray:
    """A few harmonics (or other ratios) of one frequency track; sums to a loudspeaker tone."""
    freq = np.asarray(freq, dtype=np.float64)
    ph = phase_of(freq)
    ratios = ratios if ratios is not None else range(1, len(amps) + 1)
    return sum(a * np.sin(r * ph + 0.7 * k) for k, (a, r) in enumerate(zip(amps, ratios)))


def gate(n: int, start: float, dur: float, attack_ms: float = 8.0, release_ms: float = 20.0) -> np.ndarray:
    """A smooth on/off window (half-cosine edges) starting at `start` seconds, `dur` long."""
    g = np.zeros(n)
    a, r = int(SR * attack_ms / 1000), int(SR * release_ms / 1000)
    s, e = int(start * SR), int((start + dur) * SR)
    e = min(e, n)
    body = np.ones(max(e - s, 0))
    k = min(a, body.size)
    body[:k] *= rise(k)
    k = min(r, body.size)
    if k:
        body[-k:] *= rise(k)[::-1]
    g[s:s + body.size] = body
    return g


def speaker(x: np.ndarray, lo: float = 320.0, hi: float = 4600.0) -> np.ndarray:
    """A small loudspeaker: nothing below about 300 Hz, little above 5 kHz. Circular, so loops stay loops."""
    return freq_filter(x, lo, hi, order=3)


def bell_env(n: int, start: float, t60: float, attack_ms: float = 6.0) -> np.ndarray:
    """A struck-chime envelope: soft attack, exponential decay, zero before `start`."""
    e = np.zeros(n)
    s = int(start * SR)
    m = n - s
    env = np.exp(-6.9078 * np.arange(m) / (SR * t60))
    a = min(int(SR * attack_ms / 1000), m)
    env[:a] *= rise(a)
    e[s:] = env
    return e


# --------------------------------------------------------------------------- the six

def alarm_heat(n):
    """Slow two-tone: a lower and a higher note, each 0.6 s, then a pause. 2 s loop."""
    lo = voice(np.full(n, 520.0), (1.0, 0.5, 0.25)) * gate(n, 0.08, 0.62, 25, 40)
    hi = voice(np.full(n, 700.0), (1.0, 0.5, 0.25)) * gate(n, 0.78, 0.62, 25, 40)
    return speaker(lo + hi)


def alarm_missile(n):
    """Five fast urgent pulses a second on one high-ish note, the most pressing sound."""
    y = np.zeros(n)
    f = np.full(n, 1000.0)
    tone = voice(f, (1.0, 0.75, 0.55, 0.3))
    for k in range(5):
        y += tone * gate(n, 0.055 + k * 0.19, 0.10, 4, 12)
    return speaker(y)


def alarm_shields_down(n):
    """Critical, not a chime: three quick harsh sweeps falling in pitch (1,400 Hz down to 700 Hz,
    0.28 s each, odd harmonics, overdriven and torn by a 90 Hz flutter), short gaps, then a low rough
    buzz of half a second near 420 Hz that fades. The owner heard the first version as a railway
    station announcement; this one has no note to hum. Each sweep has a hard edge and loses a
    third of its level on the way down, so the envelope (three hard blows, then a long fade)
    differs from every other alarm."""
    t = np.arange(n) / SR
    odd = ((1.0, 1.0), (3.0, 0.5), (5.0, 0.22))
    y = np.zeros(n)
    for k, level in enumerate((1.0, 0.95, 0.9)):
        s0 = 0.34 * k                                            # starts at once: within 5 ms
        u = np.clip((t - s0) / 0.28, 0.0, 1.0)
        f = 1400.0 * 0.5 ** u                                    # an octave down within each sweep
        ph = phase_of(f)
        tone = sum(a * np.sin(r * ph + 0.7 * j) for j, (r, a) in enumerate(odd))
        tone = np.tanh(1.8 * tone) * (0.65 + 0.35 * np.sin(2 * np.pi * 90.0 * t + k))
        y += level * tone * gate(n, s0, 0.28, 3, 14) * (1.0 - 0.35 * u)
    # the buzz: 420 Hz with odd harmonics up to 4.6 kHz, rough, fading over about half a second
    f = 420.0 * (1.0 + 0.012 * np.sin(2 * np.pi * 7.0 * t))
    ph = phase_of(f)
    buzz = sum(a * np.sin(r * ph + 0.9 * j) for j, (r, a) in enumerate(((1, 1.0), (3, 0.8), (5, 0.55), (7, 0.35),
                                                                     (9, 0.2), (11, 0.1))))
    # roughness from band-limited noise (30 to 90 Hz), not from a steady flutter, whose sidebands
    # would sit below 400 Hz and read as the fundamental
    rough = freq_filter(seeded("alarm_shields_down/rough").standard_normal(n), lo=30.0, hi=90.0, order=2)
    rough = rough / (3.0 * np.std(rough))
    buzz = np.tanh(1.6 * buzz) * np.clip(0.75 + 0.35 * rough, 0.2, 1.4)
    e = np.exp(-6.9078 * np.maximum(t - 1.04, 0.0) / 0.5)
    y += 0.8 * buzz * gate(n, 1.04, 0.5, 8, 40) * e / np.maximum(e[int(1.04 * SR)], 1e-9)
    # the odd harmonics of the top of the sweeps reach 7 kHz: a steep low-pass after the roughening
    y = freq_filter(speaker(y), hi=3800.0, order=6)
    y[-int(0.05 * SR):] *= rise(int(0.05 * SR))[::-1]            # a one-shot ends in silence
    return y


def alarm_fuel_low(n):
    """One soft chime and a long pause. Bell-like: slightly inharmonic partials, long decay."""
    f = 660.0
    tone = voice(np.full(n, f), (1.0, 0.45, 0.2, 0.08), ratios=(1.0, 2.0, 2.76, 4.07))
    return speaker(tone * bell_env(n, 0.08, 1.4, 12))


def alarm_hull_critical(n):
    """A harsh low buzzer: two heavy pulses (long, short), the buzz roughened by a 55 Hz flutter."""
    f = np.full(n, 440.0)
    buzz = voice(f, (1.0, 0.8, 0.65, 0.5, 0.35, 0.22, 0.1))
    t = np.arange(n) / SR
    buzz = np.tanh(1.5 * buzz) * (0.6 + 0.4 * np.sin(2 * np.pi * 70.0 * t))
    env = gate(n, 0.08, 0.46, 12, 25) + 0.9 * gate(n, 0.70, 0.30, 12, 25)
    return speaker(buzz * env, hi=3600.0)


def alarm_master_caution(n):
    """A clear double chime, rising (784 then 988 Hz), once."""
    y = np.zeros(n)
    for s, f in ((0.0, 784.0), (0.27, 988.0)):
        tone = voice(np.full(n, f), (1.0, 0.35, 0.12), ratios=(1.0, 2.0, 3.0))
        y += tone * bell_env(n, s, 0.28, 8)
    y = speaker(y)
    y[-int(0.06 * SR):] *= rise(int(0.06 * SR))[::-1]  # a one-shot ends in silence
    return y


from . import register  # noqa: E402  (kept next to its use)

for _id, _fn, _kw in (("alarm_heat", alarm_heat, {"swing_max": 80.0}),
                      ("alarm_missile", alarm_missile, {"swing_max": 80.0}),
                      ("alarm_shields_down", alarm_shields_down, {}),
                      ("alarm_fuel_low", alarm_fuel_low, {"swing_max": 80.0}),
                      ("alarm_hull_critical", alarm_hull_critical, {"swing_max": 80.0}),
                      ("alarm_master_caution", alarm_master_caution, {})):
    register(_id, **_kw)(lambda ctx, _fn=_fn: _fn(ctx.n))
