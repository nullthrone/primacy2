"""Impacts: hull hits, shield hits, hull groan, debris. Also the shared helpers of the three
categories thrusters, impacts and landing (cat_thrusters and cat_landing import them from here).

Everything goes through the hull (its modes are the ship's one voice). Families are one event at
different strengths: the noise that starts a blow is shared by the family (seeded by family name),
only the strength parameters change.

Helpers local to this file that could move into the library later: `ring_events` (decaying sines
at given times), `no_dc`, `blow` (a complete blow on the structure), `creak` (stick-slip groan),
`hull_ring`, `rattle_run` (a run of uneven noise knocks).
"""
import numpy as np

from . import (LEVELS, MODES, SR, bandpass, burst_env, exp_decay, fade_edges, freq_filter, highpass, lowpass,
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


# The hull modes below 100 Hz only cost headroom on small loudspeakers; a heavy blow is heard
# through the modes between 100 and 400 Hz. So the low modes ring short and quiet, the upper ones
# ring longer than the sub-bass (the rule of SOUND_DESIGN.md section 2).
LOW_MODE = MODES[:, 0] < 100.0


def hull_ring(n, family, level, sharp=1.0, t0=0.0):
    """The whole hull struck at once: every mode starts together, the upper ones carry on."""
    gains = np.where(LOW_MODE, 0.3, 1.0)
    t60 = np.where(LOW_MODE, 0.3, MODES[:, 2] * 1.3) * sharp
    ph = seeded(family + "/mode_phase").uniform(0, 6.283, len(MODES))
    return level * ring_events(n, np.full(len(MODES), t0), MODES[:, 1] * gains, MODES[:, 0], t60,
                               attack_ms=2.0, phases=ph)


def knock_noise(m, rng, lo, hi, attack_ms, t60):
    """A burst of band noise of m samples: one small knock of metal or a valve."""
    x = bandpass(rng.standard_normal(m + 256), lo, hi, 2)[256:]
    return x * burst_env(m, attack_ms, t60)


def rattle_run(n, t0, count, span_ms, peak, rng, lo=1200.0, hi=3200.0):
    """A rattle of fittings: several small uneven knocks of noise in a short run (never a pitched
    ping). Each knock has its own band, length and level, so no two runs are alike."""
    out = np.zeros(n)
    gaps = rng.uniform(0.4, 1.6, count)
    times = t0 + np.cumsum(gaps) / gaps.sum() * span_ms / 1000.0
    for tm, g in zip(times, np.exp(rng.normal(-0.4, 0.5, count))):
        i0 = int(tm * SR)
        m = int(rng.uniform(0.004, 0.011) * SR)
        if i0 + m >= n:
            continue
        c = rng.uniform(lo, hi * 0.8)
        k = knock_noise(m, rng, c * 0.7, min(c * 1.5, 3900.0), 0.4, rng.uniform(0.003, 0.008))
        out[i0:i0 + m] += g * k / max(np.max(np.abs(k)), 1e-9)
    return peak * out / max(np.max(np.abs(out)), 1e-9)


def blow(n, family, *, f_start, f_end, glide_s=0.06, thump_t60=0.15, attack_ms=3.0, ring=0.7,
         ring_sharp=1.0, body=0.6, contact=0.0, tick=0.0, tick_delay_ms=0.0, rattle=0.0,
         rattle_rng=None, delay_ms=0.0, fc=650.0):
    """One blow on the structure, before the level is set.

    The weight sits in the hull modes above 100 Hz (`ring`) and in a thump that falls from f_start
    to f_end (`body`). `contact` is the level of the first moment of metal on metal (20 to 40 ms of
    band noise between 400 Hz and 1.5 kHz) against the peak of the rest; `tick` is the small valve
    knock of a thruster at tick_delay_ms. `rattle` (0 to 1) is how many runs of loose fittings
    follow. Sub-30 Hz content is removed: it only costs headroom."""
    s = lambda name: seeded(family + "/" + name)
    tb = thump(n, f_start, f_end, attack_ms, thump_t60, glide_s)
    modes = hull_ring(n, family, 1.0, ring_sharp)
    k = rms(tb[: int(0.2 * SR)]) / max(rms(modes[: int(0.2 * SR)]), 1e-9)
    y = body * tb + ring * 0.7 * k * modes
    d = int(delay_ms * SR / 1000.0)
    if d:
        y = np.concatenate([np.zeros(d), y[:-d]])
    y = lowpass(highpass(y, 32.0, 2), fc, 6)
    pk = float(np.max(np.abs(y)))
    if contact > 0:
        m = int(0.03 * SR)
        c = knock_noise(m, s("contact"), 400.0, 1500.0, 0.8, 0.014)
        y[:m] += contact * pk * c / max(np.max(np.abs(c)), 1e-9)
    if tick > 0:
        m = int(0.004 * SR)
        c = knock_noise(m, s("tick"), 500.0, 1600.0, 0.3, 0.0025)
        i0 = int(tick_delay_ms * SR / 1000.0)
        y[i0:i0 + m] += tick * pk * c / max(np.max(np.abs(c)), 1e-9)
    runs = int(round(rattle * 3.5))
    if runs:
        rng = rattle_rng if rattle_rng is not None else s("rattle")
        for i in range(runs):
            t0 = 0.03 + 0.07 * i + float(rng.uniform(0.0, 0.06)) + 0.05 * i * i
            y += rattle_run(n, t0, int(rng.integers(5, 10)), float(rng.uniform(45, 110)),
                            pk * 0.07 * rattle * 0.8 ** i, rng)
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


# --------------------------------------------------------------------------- hull hits

# One event at three strengths: a low boom (thump), the hull modes between 100 and 400 Hz ringing
# on, a contact transient of metal, and from the medium hit on, rattles of fittings.
HULL = {
    "impact_hull_light": dict(f_start=165, f_end=92, thump_t60=0.12, ring=1.1, ring_sharp=0.6, body=0.55,
                              contact=0.25, rattle=0.0),
    "impact_hull_medium": dict(f_start=175, f_end=88, thump_t60=0.2, ring=1.4, ring_sharp=0.8, body=0.6,
                               contact=0.25, rattle=0.5),
    "impact_hull_heavy": dict(f_start=190, f_end=82, thump_t60=0.34, ring=1.6, ring_sharp=1.0, body=0.7,
                              contact=0.25, rattle=1.0, glide_s=0.08),
}


def _make_hull(sid):
    @register(sid)
    def _render(ctx):
        n = ctx.n
        y = blow(n, "impact_hull", **HULL[sid])
        if sid == "impact_hull_heavy":
            # the strained metal complains after the slam
            rng = ctx.rng("groan")
            y = y + 0.35 * rms(y[: int(0.3 * SR)]) * creak(n, 1.5, 0.9, 105.0, 150.0, 1.0, rng, rate=(24, 48))
        return no_dc(fade_edges(y, 0.0, min(400.0, 0.3 * 1000.0 * n / SR)))
    return _render


for _sid in HULL:
    _make_hull(_sid)


# --------------------------------------------------------------------------- shield hits

SHIELD = {
    # surge level, pitch sag (fraction), time to the bottom of the sag (s), recovery time constant (s),
    # thump level, crackle level
    "impact_shield_light": dict(load=0.45, sag=0.06, t_sag=0.04, rec=0.25, thump=0.3, crackle=0.5),
    "impact_shield_medium": dict(load=0.75, sag=0.16, t_sag=0.08, rec=0.35, thump=0.45, crackle=0.8),
    "impact_shield_heavy": dict(load=1.0, sag=0.30, t_sag=0.15, rec=0.45, thump=0.6, crackle=1.0),
}
# odd harmonics of a 100 Hz generator: the third and fifth carry the sound (a machine heard through
# the housing); the fundamental alone would read as a beep and lies under 125 Hz
HARM = ((1, 0.6), (3, 1.0), (5, 0.5), (7, 0.18), (9, 0.06))


def _make_shield(sid):
    @register(sid)
    def _render(ctx):
        n = ctx.n
        p = SHIELD[sid]
        t = np.arange(n) / SR
        # pitch: falls to the bottom within t_sag, then climbs back with the recovery constant
        s_ = np.where(t < p["t_sag"], np.sin(0.5 * np.pi * t / p["t_sag"]),
                      np.exp(-(t - p["t_sag"]) / p["rec"]))
        f = 100.0 * (1.0 - p["sag"] * s_)
        ph = 2 * np.pi * np.cumsum(f) / SR
        pr = seeded("impact_shield/phase")
        tone = sum(w * np.sin(k * ph + pr.uniform(0, 6.28)) for k, w in HARM)
        tone = np.tanh(1.4 * tone / max(rms(tone), 1e-9))  # overdriven: rougher, more odd harmonics
        # uneven amplitude at 20 to 40 Hz: the generator labouring
        g = bandpass(seeded("impact_shield/am").standard_normal(n), 20, 40, 2)
        g /= max(3 * rms(g), 1e-9)
        load = p["load"] * (0.4 + 0.6 * s_)
        am = np.clip(1.0 + 0.9 * load * g + 0.25 * load * np.sin(2 * np.pi * 30.0 * t), 0.0, None)
        env = rise(int(0.005 * SR))
        env = np.concatenate([env, np.ones(n - env.size)]) * (0.55 + 0.45 * np.exp(-t / (0.5 * p["rec"] + 0.15)))
        env = env * exp_decay(n, 2.2 * n / SR)
        y = tone * am * env
        # noise in the sidebands: grit that follows the load
        sb = bandpass(seeded("impact_shield/grit").standard_normal(n), 150, 900, 2)
        y = y / max(rms(y[: int(0.2 * SR)]), 1e-9) + 0.45 * load * sb / max(rms(sb), 1e-9) * am * env
        # crackle: band noise between 300 Hz and 1.2 kHz in the first 100 ms, in uneven sparks
        cr = np.zeros(n)
        cm = int(0.1 * SR)
        rr = seeded("impact_shield/crackle")
        cr[rr.integers(0, cm, 40)] = rr.standard_normal(40)
        cr = bandpass(cr, 300, 1200, 2)
        cr[:cm] *= np.linspace(1.0, 0.0, cm) ** 1.2
        cr[cm:] = 0.0
        y = y + p["crackle"] * 1.6 * cr / max(rms(cr[:cm]), 1e-9) * rms(y[: int(0.2 * SR)]) * 0.55
        body = thump(n, 130, 85, 4.0, 0.07 + 0.08 * p["load"], 0.04)
        y = y + p["thump"] * 1.2 * body / max(rms(body[: int(0.2 * SR)]), 1e-9) * rms(y[: int(0.2 * SR)])
        y = lowpass(highpass(y, 35.0, 2), 1300.0, 6)
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
    y += creak(n, 0.05, 2.2, 125.0, 165.0, 1.0, rng, rate=(14, 30), partials=(1.0, 1.9))
    y += 0.8 * creak(n, 0.9, 1.6, 185.0, 255.0, 1.0, rng, rate=(18, 40), partials=(1.0, 2.1))
    for t0, d, lo, hi, lv in ((0.35, 0.35, 190, 240, 0.40), (1.7, 0.28, 150, 215, 0.44),
                              (2.45, 0.5, 120, 170, 0.55), (3.0, 0.3, 230, 300, 0.3)):
        y += lv * creak(n, t0, d, lo, hi, 1.0, rng, rate=(30, 70))
    # the file begins with a small knock of metal taking up the load, so it starts within 5 ms
    y += 0.5 * ring_events(n, [0.0004], [1.0], [182.0], [0.25], attack_ms=1.0)
    y = through_hull(y, sharp=0.5, gains=np.where(LOW_MODE, 0.3, 1.0), dry=1.0)
    y = lowpass(highpass(y, 40.0, 2), 650.0, 6)
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
    freqs = rng.uniform(170, 430, count)
    t60s = rng.uniform(0.007, 0.03, count) * (1 + 3 * (amps > 0.7))
    y = ring_events(n, times, amps, freqs, t60s, attack_ms=0.8)
    # now and then a bigger piece: a dull thump, not a ring
    big = np.flatnonzero(amps > np.quantile(amps, 0.93))
    for i in big:
        s0 = int(times[i] * SR)
        seg = thump(min(n - s0, int(0.25 * SR)), 170, 110, 3.0, 0.07, 0.04) * 1.2 * amps[i]
        y[s0:s0 + seg.size] += seg
    y = lowpass(highpass(y, 60.0, 2), 700.0, 6)
    # fittings rattle where it is dense: runs of small uneven knocks, never a ping
    rr = ctx.rng("rattle")
    for t0 in (0.12, 0.31, 0.62, 1.05):
        y += rattle_run(n, t0, int(rr.integers(5, 9)), float(rr.uniform(60, 140)),
                        0.08 * np.max(np.abs(y)) * np.exp(-t0 / 1.4), rr)
    return no_dc(fade_edges(y, 0.0, 500.0))
