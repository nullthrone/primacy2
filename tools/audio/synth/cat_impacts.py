"""Impacts: hull hits, shield hits, hull groan, debris. Also the shared helpers of the three
categories thrusters, impacts and landing (cat_thrusters and cat_landing import them from here).

Everything goes through the hull (its modes are the ship's one voice). Families are one event at
different strengths: the noise that starts a blow is shared by the family (seeded by family name),
only the strength parameters change.

Helpers local to this file that could move into the library later: `ring_events` (decaying sines
at given times), `no_dc`, `blow` (a complete blow on the structure), `creak` (stick-slip groan),
`hum` (a transformer hum with a gliding pitch).
"""
import numpy as np

from . import (LEVELS, MODES, SR, bandpass, burst_env, exp_decay, fade_edges, freq_filter, lowpass,
               machine_tone, normalize_rms, periodic_lfo, periodic_noise, rattles, register, rise, rms,
               seeded, slow_wander, structure_lowpass, thump, through_hull, white_noise)

# Targets for the ids the core agent's table does not hold (provisional until the owner listens).
# Everything in the brief (thruster pulses, hits, touchdowns) is already in LEVELS.
LEVELS.update({
    "hull_stress_groan": ("peak", -8.0),
    "debris_patter": ("peak", -9.0),
})


# --------------------------------------------------------------------------- local helpers

def ring_events(n, times, amps, freqs, t60s, attack_ms=1.0, periodic=False, glide=0.0, phases=None):
    """Sum of decaying sines (a small blow on a hull mode each). times in seconds.
    With periodic=True a tail past the end wraps to the start so that a loop stays a loop."""
    out = np.zeros(n)
    longest = float(np.max(t60s))
    length = int(min(n, longest * SR * 0.9 + 0.05 * SR))
    t = np.arange(length) / SR
    a = max(2, int(attack_ms * SR / 1000.0))
    ph0 = np.zeros(len(times)) if phases is None else phases
    for tm, am, f, t60, p0 in zip(times, amps, freqs, t60s, ph0):
        env = np.exp(-6.9078 * t / t60)
        env[:a] *= rise(a)
        fr = f * (1.0 + glide * np.exp(-t / 0.03))
        seg = am * env * np.sin(2 * np.pi * np.cumsum(fr) / SR + p0)
        idx = int(tm * SR) + np.arange(length)
        if periodic:
            np.add.at(out, idx % n, seg)
        else:
            keep = idx < n
            np.add.at(out, idx[keep], seg[keep])
    return out


def no_dc(y):
    """First-order high-pass at 6 Hz: a blow is a unipolar push and would leave an offset; this
    gives it the opposite slow tail instead (far below hearing, so inaudible)."""
    from scipy.signal import lfilter

    r = np.exp(-2 * np.pi * 6.0 / SR)
    return lfilter([(1 + r) / 2, -(1 + r) / 2], [1.0, -r], y)


def blow(n, family, *, f_start, f_end, glide_s=0.06, thump_t60=0.15, attack_ms=3.0, ring=0.7,
         ring_sharp=1.0, gains=None, modes=0.0, tick=0.0, tick_delay_ms=0.0, rattle=0.0, rattle_rng=None,
         delay_ms=0.0):
    """One blow on the structure, before the level is set. The exciting noise is the family's."""
    s = lambda name: seeded(family + "/" + name)
    m = min(n, int(0.012 * SR))
    pulse = np.zeros(n)
    pulse[:m] = burst_env(m, 2.5, 0.008) * s("pulse").standard_normal(m)
    pulse = lowpass(pulse, 500, 2)
    ringing = through_hull(pulse, sharp=ring_sharp, gains=gains)
    body = thump(n, f_start, f_end, attack_ms, thump_t60, glide_s)
    scale = rms(body[: int(0.2 * SR)]) / max(rms(ringing[: int(0.2 * SR)]), 1e-9)
    y = body + ring * 0.7 * scale * ringing
    if modes > 0:
        # the whole hull is struck at once: every mode starts at the table level, so the low ones
        # (37 to 89 Hz) carry on for a second or more behind the thump
        y = y + modes * ring_events(n, np.zeros(len(MODES)), MODES[:, 1], MODES[:, 0],
                                    MODES[:, 2] * ring_sharp, attack_ms=3.0,
                                    phases=seeded(family + "/mode_phase").uniform(0, 6.283, len(MODES)))
    d = int(delay_ms * SR / 1000.0)
    if d:
        y = np.concatenate([np.zeros(d), y[:-d]])
    if tick > 0:
        # a valve or latch: a dull knock of a few ms, not a click (nothing above 700 Hz)
        k = np.zeros(n)
        mk = int(0.02 * SR)
        kn = lowpass(s("tick").standard_normal(mk) * burst_env(mk, 1.2, 0.006), 700, 2)
        k[:mk] = kn
        k = np.roll(k, int(tick_delay_ms * SR / 1000.0))
        y = y + tick * rms(y[: int(0.2 * SR)]) * k / max(rms(kn), 1e-9) * 0.5
    y = structure_lowpass(y, periodic=False)
    if rattle > 0:
        r = rattles(n, 1.0, rattle_rng if rattle_rng is not None else s("rattle"), per_second=7.0,
                    periodic=False)
        env = burst_env(n, 4.0, 0.15 + 0.5 * rattle)
        y = y + 0.05 * rattle * rms(y[: int(0.3 * SR)]) * r * env * 8
    return y


def creak(n, t0, dur, f_lo, f_hi, level, rng, rate=(28.0, 62.0), partials=(1.0, 2.07)):
    """Strained metal: a few inharmonic partials gliding slowly, rubbed by stick-slip (an amplitude
    sawtooth whose rate wanders), swelling and fading inside a Hann window. Below 500 Hz."""
    out = np.zeros(n)
    i0 = int(t0 * SR)
    m = min(int(dur * SR), n - i0)
    if m <= 0:
        return out
    t = np.arange(m) / SR
    walk = np.cumsum(rng.standard_normal(m))
    walk = lowpass(walk - np.linspace(walk[0], walk[-1], m), 4.0, 1)
    walk /= max(np.max(np.abs(walk)), 1e-9)
    f = f_lo + (f_hi - f_lo) * (0.5 + 0.5 * walk)
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = sum(w * np.sin(p * ph + rng.uniform(0, 6.28)) for w, p in zip((1.0, 0.45), partials))
    r = rate[0] + (rate[1] - rate[0]) * (0.5 + 0.5 * lowpass(rng.standard_normal(m), 3.0, 1) /
                                         max(1e-9, 3 * rms(lowpass(rng.standard_normal(m), 3.0, 1))))
    saw = (np.cumsum(np.clip(r, rate[0] * 0.5, rate[1] * 1.5)) / SR) % 1.0
    slip = lowpass(np.exp(-5.0 * saw), 150.0, 2)
    win = np.hanning(m) ** 1.5
    out[i0:i0 + m] = level * tone * (0.3 + 0.7 * slip) * win
    return out


def hum(n, f0, drop_env, load_env, rng, harmonics=(1, 3, 5, 7, 9), growl_hz=(15.0, 160.0)):
    """Mains hum whose pitch follows f0 * (1 - drop_env): odd harmonics that grow with load, and a
    growl (band-limited noise modulating the amplitude). One-shot version of transformer_tone."""
    f = f0 * (1.0 - drop_env)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.zeros(n)
    for k in harmonics:
        y += k ** -(1.5 - 1.1 * load_env) * np.sin(k * ph + rng.uniform(0, 6.28))
    g = bandpass(rng.standard_normal(n), *growl_hz, order=2)
    g /= max(3 * rms(g), 1e-9)
    return y * (1.0 + 1.3 * load_env * g)


# --------------------------------------------------------------------------- hull hits

# strength 0..1: thump pitch and length, ringing level, rattles. One event at three strengths.
HULL = {
    "impact_hull_light": dict(f_start=88, f_end=48, thump_t60=0.12, ring=0.8, ring_sharp=0.7, modes=0.15, rattle=0.0),
    "impact_hull_medium": dict(f_start=100, f_end=50, thump_t60=0.22, ring=1.5, ring_sharp=0.9, modes=0.35, rattle=0.5),
    "impact_hull_heavy": dict(f_start=112, f_end=44, thump_t60=0.40, ring=2.0, ring_sharp=1.0, modes=0.8, rattle=1.0,
                              glide_s=0.09),
}


def _make_hull(sid):
    @register(sid)
    def _render(ctx):
        n = ctx.n
        y = blow(n, "impact_hull", **HULL[sid])
        if sid == "impact_hull_heavy":
            # the strained metal complains after the slam
            rng = ctx.rng("groan")
            y = y + 0.35 * rms(y[: int(0.3 * SR)]) * creak(n, 1.5, 0.9, 52.0, 79.0, 1.0, rng, rate=(24, 48))
        y = structure_lowpass(y, periodic=False)
        return no_dc(fade_edges(y, 0.0, min(400.0, 0.3 * 1000.0 * n / SR)))
    return _render


for _sid in HULL:
    _make_hull(_sid)


# --------------------------------------------------------------------------- shield hits

SHIELD = {
    # level of the surge, pitch sag (fraction), time of the sag, recovery time constant (s), thump
    "impact_shield_light": dict(load=0.45, sag=0.04, t_sag=0.02, rec=0.12, thump=0.35, f0=100.0),
    "impact_shield_medium": dict(load=0.75, sag=0.12, t_sag=0.04, rec=0.30, thump=0.5, f0=100.0),
    "impact_shield_heavy": dict(load=1.0, sag=0.34, t_sag=0.10, rec=0.65, thump=0.7, f0=100.0),
}


def _make_shield(sid):
    @register(sid)
    def _render(ctx):
        n = ctx.n
        p = SHIELD[sid]
        rng = seeded("impact_shield/hum")
        t = np.arange(n) / SR
        # surge: a fast rise (5 ms), a sag of level and pitch, then a slow recovery
        up = rise(int(0.005 * SR))
        env = np.concatenate([up, np.ones(n - up.size)])
        sag = np.where(t < p["t_sag"], t / p["t_sag"], np.exp(-(t - p["t_sag"]) / p["rec"]))
        pitch_drop = p["sag"] * sag
        load = p["load"] * (0.35 + 0.65 * sag)
        h = hum(n, p["f0"], pitch_drop, load, seeded("impact_shield/growl"))
        level_env = env * (0.55 + 0.45 * np.exp(-t / (0.5 * p["rec"] + 0.15))) * exp_decay(n, 2.2 * n / SR)
        y = h * level_env
        # a hum is driven in the metal of the housing, not rung by it: very short hull, mostly direct
        # a coarse electrical buzz under the hum: noise that follows the load (a hum alone reads as a beep)
        buzz = bandpass(seeded("impact_shield/buzz").standard_normal(n), 40, 320, 2)
        y = y / max(rms(y[: int(0.2 * SR)]), 1e-9) + 0.9 * load * buzz / max(rms(buzz), 1e-9) * level_env
        y = through_hull(y, sharp=0.1, dry=1.0)
        body = thump(n, 74, 46, 4.0, 0.08 + 0.1 * p["load"], 0.05)
        y = y / max(rms(y[: int(0.2 * SR)]), 1e-9) + p["thump"] * 1.5 * body / max(rms(body[: int(0.2 * SR)]), 1e-9)
        y = structure_lowpass(y, periodic=False)
        return no_dc(fade_edges(y, 0.0, 0.35 * 1000.0 * n / SR))
    return _render


for _sid in SHIELD:
    _make_shield(_sid)


# --------------------------------------------------------------------------- groan and debris

@register("hull_stress_groan")
def hull_stress_groan(ctx):
    n = ctx.n
    rng = ctx.rng()
    y = np.zeros(n)
    # a long low groan and shorter creaks, like a pressure hull going deep
    y += creak(n, 0.05, 2.2, 47.0, 64.0, 1.0, rng, rate=(14, 30), partials=(1.0, 1.9))
    y += 0.7 * creak(n, 0.9, 1.6, 83.0, 118.0, 1.0, rng, rate=(18, 40), partials=(1.0, 2.1))
    for t0, d, lo, hi, lv in ((0.35, 0.35, 190, 240, 0.30), (1.7, 0.28, 150, 215, 0.34),
                              (2.45, 0.5, 120, 170, 0.45), (3.0, 0.3, 230, 300, 0.2)):
        y += lv * creak(n, t0, d, lo, hi, 1.0, rng, rate=(30, 70))
    # the file begins with a small knock of metal taking up the load, so it starts within 5 ms
    y += 0.5 * ring_events(n, [0.0004], [1.0], [118.0], [0.18], attack_ms=1.0)
    y = through_hull(y, sharp=0.5, dry=1.0)
    y = structure_lowpass(y, periodic=False)
    return no_dc(fade_edges(y, 0.0, 600.0))


@register("debris_patter")
def debris_patter(ctx):
    n = ctx.n
    rng = ctx.rng()
    dur = n / SR
    # the burst thins out: a decaying rate with uneven gaps, the first fragments arrive at once
    count = 150
    u = np.sort(rng.uniform(0, 1, count)) ** 1.0
    times = -0.85 * np.log(1 - u * (1 - np.exp(-(dur - 0.15) / 0.85)))
    times[0] = 0.0003
    amps = np.exp(rng.normal(-0.9, 0.7, count)) * np.exp(-times / 1.6)
    freqs = rng.uniform(160, 560, count)
    t60s = rng.uniform(0.007, 0.03, count) * (1 + 3 * (amps > 0.7))
    y = ring_events(n, times, amps, freqs, t60s, attack_ms=0.8)
    # now and then a bigger piece: a dull thump, not a ring
    big = np.flatnonzero(amps > np.quantile(amps, 0.93))
    for i in big:
        s0 = int(times[i] * SR)
        seg = thump(min(n - s0, int(0.25 * SR)), 85, 52, 3.0, 0.07, 0.04) * 1.6 * amps[i]
        y[s0:s0 + seg.size] += seg
    y = structure_lowpass(y, periodic=False)
    # fittings rattle where it is dense
    r = rattles(n, 0.6, ctx.rng("rattle"), per_second=5.0, periodic=False)
    y = y + 0.05 * rms(y[: int(0.5 * SR)]) * 8 * r * burst_env(n, 20.0, 1.0)
    return no_dc(fade_edges(y, 0.0, 500.0))


