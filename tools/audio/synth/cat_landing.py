"""Landing: gear, touchdowns, settling, scraping over the ground, regolith on the hull.

Blows and creaks come from cat_impacts; the two loops are many small events at uneven times
whose positions wrap around, so they close over the loop without a repeating pattern.
"""
import numpy as np

from . import (LEVELS, SR, bandpass, burst_env, fade_edges, machine_tone, normalize_rms, periodic_lfo, rise, thump,
               periodic_noise, rattles, register, rms, seeded, slow_wander, structure_lowpass,
               through_hull, MODES)
from .cat_impacts import blow, creak, no_dc, ring_events

LEVELS.update({
    "gear_deploy": ("peak", -8.0),
    "gear_retract": ("peak", -9.0),
    "ground_scrape_loop": ("lufs", -28.0),
    "dust_patter_loop": ("lufs", -34.0),
    "settle_creak": ("peak", -18.0),
})  # provisional; the touchdowns are in the core table


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
        y = at(knock, 0.0, 0.22) + whine(n, 0.08, 1.62, 150, 255, 0.22, rng) + at(clunk, 1.66, 1.0)
        # a second, smaller seat of the lock
        y += at(knock, 1.86, 0.18)
    else:
        # the lock opens (clack, the clearest part), whine falls with the load, doors close (soft)
        y = at(knock, 0.0, 0.9) + whine(n, 0.2, 1.55, 235, 150, 0.22, rng) + at(clunk, 1.6, 0.5)
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
    a = blow(n, "touchdown", f_start=72, f_end=42, thump_t60=0.14, ring=0.35, ring_sharp=0.5, modes=0.1)
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
             modes=0.8, rattle=1.0, glide_s=0.1)
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
    y = y + 0.3 * creak(n, 0.5, 0.75, 70, 105, 1.0, rng, rate=(20, 36))
    y = structure_lowpass(y, periodic=False)
    return no_dc(fade_edges(y, 0.0, 450.0))


# --------------------------------------------------------------------------- landing loops

def flatten(x, amount=0.7, win_s=0.12):
    """Partly level out slow swells of a loop (divide by the local RMS to a power), circularly so
    that it stays a loop. Noise that is band-limited to low frequencies has few independent
    components and swells now and then; a grinding that is steady on average should not."""
    n = x.size
    w = np.hanning(int(win_s * SR))
    k = np.zeros(n)
    k[: w.size] = w / w.sum()
    k = np.roll(k, -w.size // 2)
    env = np.sqrt(np.maximum(np.fft.irfft(np.fft.rfft(x * x) * np.fft.rfft(k), n), 1e-12))
    return x / env ** amount * rms(x) ** (amount - 1 + 1) / 1.0


def _wrapped_times(rng, count, n, wander, floor=0.15):
    """Event times that follow a periodic density (inverse-CDF sampling), so they are uneven and
    the pattern still closes over the loop."""
    dens = floor + np.clip(0.5 + 0.5 * wander, 0, 1)
    cdf = np.cumsum(dens)
    cdf /= cdf[-1]
    return np.searchsorted(cdf, rng.uniform(0, 1, count)) / n * (n / SR)


@register("ground_scrape_loop")
def ground_scrape_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("ground_scrape/" + name)
    # the grinding: low brown noise, gated by an irregular grit envelope (no fixed rate)
    grind = periodic_noise(n, "pink", s("grind"), lo=35, hi=520)
    gate = periodic_noise(n, "white", s("gate"), lo=1.5, hi=45)
    gate = np.maximum(gate, 0) ** 2
    gate = gate / max(gate.mean(), 1e-9)
    load = 1.0 + 0.2 * slow_wander(n, s("load"), 0.2, 1.3)
    flow = grind * (0.7 + 0.3 * np.minimum(gate, 2.0)) * load
    flow = normalize_rms(flatten(through_hull(flow, periodic=True, sharp=0.25, dry=0.7), 0.8))
    # gravel under the skid: finer grit above the hull modes
    grit = periodic_noise(n, "pink", s("grit"), lo=150, hi=900) * np.minimum(gate, 3.0) * load
    # stones catching: sparse hull thunks at uneven times, a few to a dozen per second
    rng = s("stones")
    count = 26
    times = _wrapped_times(rng, count, n, slow_wander(n, s("dens"), 0.15, 1.0), 0.25)
    amps = np.exp(rng.normal(-0.3, 0.4, count))
    freqs = rng.choice(MODES[1:8, 0], count) * rng.uniform(0.98, 1.02, count)
    t60s = rng.uniform(0.07, 0.20, count)
    stones = ring_events(n, times, amps, freqs, t60s, attack_ms=2.0, periodic=True, glide=-0.06)
    y = 1.0 * flow + 0.5 * normalize_rms(grit) + 0.2 * normalize_rms(stones)
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
    times = _wrapped_times(rng, count, n, slow_wander(n, dens, 0.3, 2.5), 1.8)
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
