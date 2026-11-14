"""Thrusters, impacts and landing: structure sounds made of blows, rubbing and electrical surges.

Everything goes through the hull (its modes are the ship's one voice). Families are one event at
different strengths: the noise that starts a blow is shared by the family (seeded by family name),
only the strength parameters change.

Helpers that are local to this file and could move into the library later: `ring_events`,
`blow`, `creak`, `speaker_free_hum` (a pitch-gliding hum), `grains`.
"""
import numpy as np

from . import (LEVELS, MODES, SR, bandpass, burst_env, exp_decay, fade_edges, freq_filter, lowpass,
               machine_tone, normalize_rms, periodic_lfo, periodic_noise, rattles, register, rise, rms,
               seeded, slow_wander, structure_lowpass, thump, through_hull, white_noise)

# Targets for the ids the core agent's table does not hold (provisional until the owner listens).
# Everything in the brief (thruster pulses, hits, touchdowns) is already in LEVELS.
LEVELS.update({
    "thruster_burn_loop": ("lufs", -30.0),
    "hull_stress_groan": ("peak", -8.0),
    "debris_patter": ("peak", -9.0),
    "gear_deploy": ("peak", -8.0),
    "gear_retract": ("peak", -9.0),
    "ground_scrape_loop": ("lufs", -28.0),
    "dust_patter_loop": ("lufs", -34.0),
    "settle_creak": ("peak", -18.0),
})


# --------------------------------------------------------------------------- local helpers

def ring_events(n, times, amps, freqs, t60s, attack_ms=1.0, periodic=False, glide=0.0):
    """Sum of decaying sines (a small blow on a hull mode each). times in seconds.
    With periodic=True a tail past the end wraps to the start so that a loop stays a loop."""
    out = np.zeros(n)
    longest = float(np.max(t60s))
    length = int(min(n, longest * SR * 0.9 + 0.05 * SR))
    t = np.arange(length) / SR
    a = max(2, int(attack_ms * SR / 1000.0))
    for tm, am, f, t60 in zip(times, amps, freqs, t60s):
        env = np.exp(-6.9078 * t / t60)
        env[:a] *= rise(a)
        fr = f * (1.0 + glide * np.exp(-t / 0.03))
        seg = am * env * np.sin(2 * np.pi * np.cumsum(fr) / SR)
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
         ring_sharp=1.0, gains=None, tick=0.0, tick_delay_ms=0.0, rattle=0.0, rattle_rng=None,
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


def hum(n, f0, drop_env, load_env, rng, harmonics=(1, 3, 5, 7), growl_hz=(20.0, 110.0)):
    """Mains hum whose pitch follows f0 * (1 - drop_env): odd harmonics that grow with load, and a
    growl (band-limited noise modulating the amplitude). One-shot version of transformer_tone."""
    f = f0 * (1.0 - drop_env)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.zeros(n)
    for k in harmonics:
        y += k ** -(1.5 - 1.1 * load_env) * np.sin(k * ph + rng.uniform(0, 6.28))
    g = bandpass(rng.standard_normal(n), *growl_hz, order=2)
    g /= max(3 * rms(g), 1e-9)
    return y * (1.0 + 0.8 * load_env * g)


# --------------------------------------------------------------------------- thrusters

THRUSTERS = {
    #            f_start f_end t60   ring  sharp  tick  rattle seed gains-cut
    "thruster_pulse_a": dict(f_start=95, f_end=52, thump_t60=0.09, ring=0.5, ring_sharp=0.12, tick=0.9, tick_delay_ms=0, delay_ms=6),
    "thruster_pulse_b": dict(f_start=82, f_end=46, thump_t60=0.12, ring=0.55, ring_sharp=0.14, tick=0.8, tick_delay_ms=1, delay_ms=8),
    "thruster_pulse_c": dict(f_start=112, f_end=58, thump_t60=0.14, ring=0.8, ring_sharp=0.2, tick=1.0, tick_delay_ms=0, delay_ms=5, rattle=0.3),
}


def _make_pulse(sid):
    @register(sid)
    def _render(ctx):
        y = blow(ctx.n, "thruster_pulse", **THRUSTERS[sid])
        # the hull rings for seconds; a short file must end in silence
        return no_dc(fade_edges(y, 0.0, 0.5 * 1000.0 * ctx.n / SR))
    return _render


for _sid in THRUSTERS:
    _make_pulse(_sid)


@register("thruster_burn_loop")
def thruster_burn_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("thruster_burn/" + name)
    # gas through the nozzle: muffled hiss, only what the hull lets through
    hiss = periodic_noise(n, "pink", s("hiss"), lo=140, hi=1000)
    hiss = hiss * (1.0 + 0.18 * slow_wander(n, s("hiss_wander"), 1.0, 7.0))
    # valve chatter and feed pump: a low buzz of two beating partial series
    buzz = machine_tone(n, 58.0, (1, 2, 3, 4), (1.0, 0.7, 0.4, 0.2), beat_hz=0.8, flutter_hz=4.0,
                        flutter=0.006, beat_depth=0.3, rng=s("buzz"))
    buzz = normalize_rms(buzz * (1.0 + 0.35 * periodic_lfo(n, 29.0, 0.2)))
    base = periodic_noise(n, "brown", s("brown"), lo=25, hi=300)
    base = through_hull(base, periodic=True, sharp=0.2, dry=0.7)
    y = 1.0 * normalize_rms(base) + 0.9 * buzz + 0.35 * normalize_rms(hiss)
    y = structure_lowpass(y, periodic=True)
    return y - y.mean()


# --------------------------------------------------------------------------- hull hits

# strength 0..1: thump pitch and length, ringing level, rattles. One event at three strengths.
HULL = {
    "impact_hull_light": dict(f_start=88, f_end=48, thump_t60=0.12, ring=0.45, ring_sharp=0.6, rattle=0.0),
    "impact_hull_medium": dict(f_start=100, f_end=50, thump_t60=0.22, ring=0.8, ring_sharp=0.85, rattle=0.5),
    "impact_hull_heavy": dict(f_start=112, f_end=44, thump_t60=0.40, ring=1.1, ring_sharp=1.0, rattle=1.0,
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
            y = y + 0.20 * rms(y[: int(0.3 * SR)]) * creak(n, 1.5, 0.9, 52.0, 79.0, 1.0, rng, rate=(24, 48))
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
        level_env = env * (0.45 + 0.55 * np.exp(-t / (0.5 * p["rec"] + 0.15))) * exp_decay(n, 0.7 * n / SR)
        y = h * level_env
        # a hum is driven in the metal of the housing, not rung by it: very short hull, mostly direct
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
    modes = MODES[3:9, 0]
    freqs = rng.choice(modes, count) * rng.uniform(0.97, 1.03, count)
    t60s = rng.uniform(0.012, 0.05, count) * (1 + 3 * (amps > 0.7))
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


# --------------------------------------------------------------------------- landing

def whine(n, t0, t1, f0, f1, level, rng):
    """Hydraulic pump heard through the hull: a motor note and two harmonics whose pitch follows
    the motor speed, with a flutter, and a gush of pressurised fluid (low-passed noise)."""
    out = np.zeros(n)
    i0, i1 = int(t0 * SR), min(n, int(t1 * SR))
    m = i1 - i0
    t = np.arange(m) / SR
    speed = f0 + (f1 - f0) * (t / (t1 - t0)) ** 1.4
    speed = speed * (1 + 0.012 * np.sin(2 * np.pi * 7.3 * t + 1.0))
    ph = 2 * np.pi * np.cumsum(speed) / SR
    tone = np.sin(ph) + 0.5 * np.sin(2 * ph + 0.7) + 0.25 * np.sin(3 * ph + 1.9)
    gush = bandpass(rng.standard_normal(m), 90, 420, 2)
    gush /= max(rms(gush), 1e-9)
    tone = tone / max(rms(tone), 1e-9) + 0.5 * gush
    env = np.ones(m)
    a, b = int(0.12 * SR), int(0.1 * SR)
    env[:a] = rise(a)
    env[-b:] = rise(b)[::-1]
    out[i0:i1] = level * tone * env
    return out


def gear(n, sid):
    """The gear sequence: latch knock, hydraulic whine, lock (deploy) or doors (retract)."""
    rng = seeded("gear/" + sid)
    deploy = sid == "gear_deploy"
    clunk = blow(n, "gear_" + sid, f_start=95 if deploy else 70, f_end=48 if deploy else 42,
                 thump_t60=0.16 if deploy else 0.22, ring=0.85 if deploy else 0.7,
                 ring_sharp=0.55, tick=0.6, rattle=0.25 if deploy else 0.12)
    clunk = clunk / max(np.max(np.abs(clunk)), 1e-9)
    knock = blow(n, "gear_knock_" + sid, f_start=130, f_end=75, thump_t60=0.05, ring=0.4,
                 ring_sharp=0.12, tick=1.0, tick_delay_ms=0.0)
    knock = knock / max(np.max(np.abs(knock)), 1e-9)

    def at(x, t, g):
        k = int(t * SR)
        out = np.zeros(n)
        out[k:] = g * x[: n - k]
        return out

    if deploy:
        # uplock lets go (soft), the whine rises with the motor speed, the leg locks (hard)
        y = at(knock, 0.0, 0.22) + whine(n, 0.08, 1.62, 150, 255, 0.07, rng) + at(clunk, 1.66, 1.0)
        # a second, smaller seat of the lock
        y += at(knock, 1.86, 0.18)
    else:
        # the lock opens (clack, the clearest part), whine falls with the load, doors close (soft)
        y = at(knock, 0.0, 0.9) + whine(n, 0.2, 1.55, 235, 150, 0.075, rng) + at(clunk, 1.6, 0.5)
    y = through_hull(y, sharp=0.35, dry=1.0)
    y = structure_lowpass(y, periodic=False)
    return no_dc(fade_edges(y, 0.0, 450.0))


@register("gear_deploy")
def gear_deploy(ctx):
    return gear(ctx.n, "gear_deploy")


@register("gear_retract")
def gear_retract(ctx):
    return gear(ctx.n, "gear_retract")


@register("touchdown_soft")
def touchdown_soft(ctx):
    n = ctx.n
    rng = ctx.rng()
    # soft double thud: two struts take the weight, 180 ms apart, then a short creak
    a = blow(n, "touchdown", f_start=72, f_end=42, thump_t60=0.14, ring=0.35, ring_sharp=0.5)
    b = blow(n, "touchdown_b", f_start=64, f_end=40, thump_t60=0.12, ring=0.3, ring_sharp=0.5)
    k = int(0.18 * SR)
    y = a + 0.7 * np.concatenate([np.zeros(k), b[: n - k]])
    y = y + 0.12 * rms(y[: int(0.3 * SR)]) * creak(n, 0.4, 0.6, 95, 130, 1.0, rng, rate=(26, 44))
    y = structure_lowpass(y, periodic=False)
    return no_dc(fade_edges(y, 0.0, 450.0))


@register("touchdown_hard")
def touchdown_hard(ctx):
    n = ctx.n
    rng = ctx.rng()
    y = blow(n, "touchdown_hard", f_start=118, f_end=42, thump_t60=0.45, ring=1.15, ring_sharp=1.0,
             rattle=1.0, glide_s=0.1)
    # a struck leg a moment later, then the strained metal
    k = int(0.07 * SR)
    b = blow(n, "touchdown_hard_b", f_start=90, f_end=45, thump_t60=0.2, ring=0.6, ring_sharp=0.8)
    y = y + 0.5 * np.concatenate([np.zeros(k), b[: n - k]])
    y = y + 0.22 * rms(y[: int(0.3 * SR)]) * creak(n, 1.35, 0.85, 55, 82, 1.0, rng, rate=(22, 46))
    y = structure_lowpass(y, periodic=False)
    return no_dc(fade_edges(y, 0.0, 600.0))


@register("settle_creak")
def settle_creak(ctx):
    n = ctx.n
    rng = ctx.rng()
    # metal ticks as the struts relax: small blows on the upper hull modes at uneven times
    times = np.array([0.0006, 0.19, 0.31, 0.74, 0.83, 1.22, 1.55])
    times = times + np.array([0, 0.01, -0.02, 0.015, 0.0, -0.01, 0.02])
    amps = np.array([1.0, 0.55, 0.8, 0.45, 0.65, 0.35, 0.3])
    freqs = MODES[[5, 7, 4, 8, 6, 7, 9], 0] * rng.uniform(0.98, 1.02, 7)
    t60s = rng.uniform(0.05, 0.14, 7)
    y = ring_events(n, times, amps, freqs, t60s, attack_ms=0.7)
    y = y / max(np.max(np.abs(y)), 1e-9)
    # one creak while the strut slides to rest
    y = y + 0.45 * creak(n, 0.5, 0.75, 70, 105, 1.0, rng, rate=(20, 36))
    y = structure_lowpass(y, periodic=False)
    return no_dc(fade_edges(y, 0.0, 450.0))


# --------------------------------------------------------------------------- landing loops

def _wrapped_times(rng, count, n, wander, floor=0.15):
    """Event times that follow a periodic density (inverse-CDF sampling), so they are uneven and
    the pattern still closes over the loop."""
    dens = floor + np.clip(0.5 + 0.5 * wander, 0, 1)
    cdf = np.cumsum(dens)
    cdf /= cdf[-1]
    return np.searchsorted(cdf, rng.uniform(0, 1, count)) / n * (n / SR)


@register("ground_scrape_loop", swing_max=9.0)
def ground_scrape_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("ground_scrape/" + name)
    # the grinding: low brown noise, gated by an irregular grit envelope (no fixed rate)
    grind = periodic_noise(n, "brown", s("grind"), lo=30, hi=420)
    gate = periodic_noise(n, "white", s("gate"), lo=1.5, hi=45)
    gate = np.maximum(gate, 0) ** 2
    gate = gate / max(gate.mean(), 1e-9)
    load = 1.0 + 0.30 * slow_wander(n, s("load"), 0.2, 1.3)
    flow = grind * (0.55 + 0.45 * np.minimum(gate, 2.5)) * load
    flow = through_hull(flow, periodic=True, sharp=0.25, dry=0.7)
    flow = normalize_rms(flow)
    # gravel under the skid: finer grit above the hull modes
    grit = periodic_noise(n, "pink", s("grit"), lo=150, hi=900) * np.minimum(gate, 3.0) * load
    # stones catching: sparse hull thunks at uneven times, a few to a dozen per second
    rng = s("stones")
    count = 26
    times = _wrapped_times(rng, count, n, slow_wander(n, s("dens"), 0.15, 1.0), 0.25)
    amps = np.exp(rng.normal(-0.3, 0.55, count))
    freqs = rng.choice(MODES[1:8, 0], count) * rng.uniform(0.98, 1.02, count)
    t60s = rng.uniform(0.07, 0.30, count)
    stones = ring_events(n, times, amps, freqs, t60s, attack_ms=2.0, periodic=True, glide=-0.06)
    y = 1.0 * flow + 0.30 * normalize_rms(grit) + 0.9 * normalize_rms(stones) * 0.5
    y = structure_lowpass(y, periodic=True)
    y = y + 0.04 * rms(y) * rattles(n, 0.7, s("rattle"), per_second=3.0, periodic=True) * 3
    return y - y.mean()


@register("dust_patter_loop")
def dust_patter_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("dust_patter/" + name)
    rng = s("grains")
    count = 1500
    dens = s("density")
    times = _wrapped_times(rng, count, n, slow_wander(n, dens, 0.3, 2.5), 1.0)
    amps = np.minimum(np.exp(rng.normal(-1.0, 0.6, count)), 1.2)
    freqs = rng.uniform(150, 440, count)
    t60s = rng.uniform(0.008, 0.028, count)
    y = ring_events(n, times, amps, freqs, t60s, attack_ms=0.5, periodic=True)
    # a few larger pebbles make a duller knock
    kb = rng.choice(count, 18, replace=False)
    y += ring_events(n, times[kb] + 0.0004, amps[kb] * 1.2, rng.uniform(70, 120, 18),
                     rng.uniform(0.04, 0.09, 18), attack_ms=1.5, periodic=True)
    y = structure_lowpass(y, periodic=True)
    y = y + 0.03 * rms(y) * rattles(n, 0.6, s("rattle"), per_second=5.0, periodic=True) * 4
    return y - y.mean()
