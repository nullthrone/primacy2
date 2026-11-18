"""Landing: gear, touchdowns, settling, scraping over the ground, regolith on the hull.

Blows and creaks come from cat_impacts; the two loops are many small events at uneven times
whose positions wrap around, so they close over the loop without a repeating pattern.
"""
import numpy as np

from . import (LEVELS, SR, bandpass, highpass, lowpass, burst_env, fade_edges, machine_tone, normalize_rms, periodic_lfo, rise, thump,
               periodic_noise, rattles, register, rms, seeded, slow_wander, structure_lowpass,
               through_hull, MODES, freq_filter, mid_side)
from .cat_impacts import blow, creak, no_dc, rattle_run, ring_events

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
    gush = bandpass(rng.standard_normal(m), 140, 520, 2)
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
    clunk = blow(n, "gear_" + sid, f_start=170 if deploy else 150, f_end=95 if deploy else 85,
                 thump_t60=0.16 if deploy else 0.22, ring=0.85 if deploy else 0.7,
                 ring_sharp=0.55, contact=0.2, rattle=0.3 if deploy else 0.0)
    clunk = clunk / max(np.max(np.abs(clunk)), 1e-9)
    knock = blow(n, "gear_knock_" + sid, f_start=190, f_end=120, thump_t60=0.05, ring=0.5,
                 ring_sharp=0.12, tick=0.6, tick_delay_ms=0.0)
    knock = knock / max(np.max(np.abs(knock)), 1e-9)

    def at(x, t, g):
        k = int(t * SR)
        out = np.zeros(n)
        out[k:] = g * x[: n - k]
        return out

    if deploy:
        # uplock lets go (soft), the whine rises with the motor speed, the leg locks (hard)
        y = at(knock, 0.0, 0.22) + whine(n, 0.08, 1.62, 190, 300, 0.22, rng) + at(clunk, 1.66, 1.0)
        # a second, smaller seat of the lock
        y += at(knock, 1.86, 0.18)
    else:
        # the lock opens (clack, the clearest part), whine falls with the load, doors close (soft)
        y = at(knock, 0.0, 0.9) + whine(n, 0.2, 1.55, 290, 190, 0.22, rng) + at(clunk, 1.6, 0.5)
    y = through_hull(y, sharp=0.35, gains=np.where(MODES[:, 0] < 100, 0.3, 1.0), dry=1.0)
    y = lowpass(highpass(y, 40.0, 2), 650.0, 6)
    return no_dc(fade_edges(y, 0.0, 450.0))


@register("gear_deploy")
def gear_deploy(ctx):
    return gear(ctx.n, "gear_deploy")


@register("gear_retract")
def gear_retract(ctx):
    return gear(ctx.n, "gear_retract")


def _at(n, x, t, g=1.0):
    k = int(t * SR)
    out = np.zeros(n)
    if k < n:
        out[k:] = g * x[: n - k]
    return out


def landing(n, rng, name, legs, give, rattles_at, creak_at, creak_band, creak_level):
    """A landing is not a shot: the legs meet the ground one after another (`legs` is a list of
    (time s, gain, pitch factor)), then the struts give (a lower, longer push, `give` = (time,
    gain)), loose things rattle (`rattles_at` = list of (time s, level)), then the strained creak."""
    y = np.zeros(n)
    for i, (t, g, pf) in enumerate(legs):
        b = blow(n, f"{name}_leg{i}", f_start=170 * pf, f_end=95 * pf, thump_t60=0.16 * (0.6 + g), ring=0.6 + 0.5 * g,
                 ring_sharp=0.5 + 0.5 * g, body=0.6, contact=0.2, fc=650.0)
        y += _at(n, b, t, g)
    pk = float(np.max(np.abs(y)))
    # the struts give: a slow, longer push of the whole ship down onto its legs
    push = thump(n, 150, 105, 35.0, 0.45, 0.2)
    push = lowpass(highpass(push, 40.0, 2), 400.0, 4)
    y += _at(n, push, give[0], give[1] * pk / max(np.max(np.abs(push)), 1e-9))
    for t0, lv in rattles_at:
        y += rattle_run(n, t0, int(rng.integers(5, 10)), float(rng.uniform(60, 130)), lv * pk, rng)
    y += creak_level * rms(y[: int(0.3 * SR)]) * creak(n, creak_at, 0.85, creak_band[0], creak_band[1], 1.0, rng,
                                                       rate=(22, 46))
    return y


@register("touchdown_soft")
def touchdown_soft(ctx):
    n = ctx.n
    rng = ctx.rng()
    # gentle: two or three small thuds as the legs take the weight, a soft give, one faint rattle, a short creak
    y = landing(n, rng, "touchdown_soft", [(0.0, 0.8, 0.9), (0.075, 0.6, 0.85), (0.16, 0.5, 0.95)],
                (0.1, 0.45), [(0.3, 0.035)], 0.45, (130.0, 175.0), 0.12)
    return no_dc(fade_edges(y, 0.0, 450.0))


@register("touchdown_hard")
def touchdown_hard(ctx):
    n = ctx.n
    rng = ctx.rng()
    # too fast: three legs within 150 ms, the struts give, loose things rattle, the strained creak
    y = landing(n, rng, "touchdown_hard", [(0.0, 1.0, 1.0), (0.055, 0.85, 0.9), (0.125, 0.7, 1.1)],
                (0.14, 0.5), [(0.2, 0.09), (0.45, 0.07), (0.8, 0.05)], 1.35, (115.0, 165.0), 0.25)
    return no_dc(fade_edges(y, 0.0, 600.0))


@register("settle_creak")
def settle_creak(ctx):
    n = ctx.n
    rng = ctx.rng()
    # metal ticks as the struts relax: small blows on the upper hull modes at uneven times
    times = np.array([0.0006, 0.19, 0.31, 0.74, 0.83, 1.22, 1.55])
    times = times + np.array([0, 0.01, -0.02, 0.015, 0.0, -0.01, 0.02])
    amps = np.array([1.0, 0.55, 0.8, 0.45, 0.65, 0.35, 0.3])
    freqs = MODES[[5, 7, 4, 8, 6, 7, 9], 0] * 1.0 * rng.uniform(0.98, 1.02, 7)
    t60s = rng.uniform(0.05, 0.14, 7)
    y = ring_events(n, times, amps, freqs, t60s, attack_ms=0.7)
    y = y / max(np.max(np.abs(y)), 1e-9)
    # one creak while the strut slides to rest
    y = y + 0.3 * creak(n, 0.5, 0.75, 120, 175, 1.0, rng, rate=(20, 36))
    y = lowpass(highpass(y, 40.0, 2), 650.0, 6)
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


def _pans(family, count, spread):
    """One position per event, from hard left (-spread) to hard right (+spread): where on the
    hull that stone or grain hits. Its own seed, so that it never disturbs the approved events."""
    return seeded(family + "/pan").uniform(-spread, spread, count)


def _scrape_events(n, fam, pan=None):
    """The stones catching under the skid. With pan, every stone is scaled by its position."""
    s = lambda name: seeded(fam + "/" + name)
    rng = s("stones")
    count = 26
    times = _wrapped_times(rng, count, n, slow_wander(n, s("dens"), 0.15, 1.0), 0.25)
    amps = np.exp(rng.normal(-0.3, 0.4, count))
    freqs = rng.choice(MODES[4:9, 0], count) * rng.uniform(0.98, 1.02, count)
    t60s = rng.uniform(0.07, 0.20, count)
    if pan is not None:
        amps = amps * pan
    return ring_events(n, times, amps, freqs, t60s, attack_ms=2.0, periodic=True, glide=-0.06)


def _scrape_body(n, fam):
    """The grinding and the gravel of the scrape (everything but the stones) from one seed family,
    before the low-pass: returns (grinding, gravel)."""
    s = lambda name: seeded(fam + "/" + name)
    # the grinding: low brown noise, gated by an irregular grit envelope (no fixed rate)
    grind = periodic_noise(n, "pink", s("grind"), lo=100, hi=520)
    gate = periodic_noise(n, "white", s("gate"), lo=1.5, hi=45)
    gate = np.maximum(gate, 0) ** 2
    gate = gate / max(gate.mean(), 1e-9)
    load = 1.0 + 0.2 * slow_wander(n, s("load"), 0.2, 1.3)
    flow = grind * (0.7 + 0.3 * np.minimum(gate, 2.0)) * load
    flow = normalize_rms(flatten(through_hull(flow, periodic=True, sharp=0.25, gains=np.where(MODES[:, 0] < 100, 0.25, 1.0), dry=0.7), 0.8))
    # gravel under the skid: finer grit above the hull modes
    grit = periodic_noise(n, "pink", s("grit"), lo=150, hi=900) * np.minimum(gate, 3.0) * load
    return flow, grit


def _scrape_finish(n, y, fam):
    y = structure_lowpass(y, periodic=True)
    y = y + 0.04 * rms(y) * rattles(n, 0.7, seeded(fam + "/rattle"), per_second=3.0, periodic=True) * 3
    return y - y.mean()


# RMS of the continuous side against the mid: about 0.5, correlation of the channels near 0.6
SCRAPE_SIDE_RATIO = 0.5
SCRAPE_PAN = 0.8


@register("ground_scrape_loop")
def ground_scrape_loop(ctx):
    n = ctx.n
    flow, grit = _scrape_body(n, "ground_scrape")
    stones = _scrape_events(n, "ground_scrape")
    # stones catching: sparse hull thunks at uneven times, a few to a dozen per second
    y = 1.0 * flow + 0.5 * normalize_rms(grit) + 0.2 * normalize_rms(stones)
    mid = _scrape_finish(n, y, "ground_scrape")
    if ctx.channels != 2:
        return mid
    # two channels: the grinding and gravel again from other seeds, and the very same stones at
    # the same times, each one weighted by where it hits (left or right of the middle), so that
    # (left + right) / 2 stays the approved scrape
    flow_s, grit_s = _scrape_body(n, "ground_scrape_side")
    cont = _scrape_finish(n, 1.0 * flow_s + 0.5 * normalize_rms(grit_s), "ground_scrape_side")
    cont = freq_filter(cont, lo=170.0, order=12)
    cont = cont * (SCRAPE_SIDE_RATIO * rms(mid) / max(rms(cont), 1e-12))
    pan = _pans("ground_scrape", 26, SCRAPE_PAN)
    placed = structure_lowpass(0.2 * _scrape_events(n, "ground_scrape", pan) / max(rms(stones), 1e-12), periodic=True)
    return mid_side(mid, cont + placed, periodic=True)


def _dust_events(n, pan=None):
    s = lambda name: seeded("dust_patter/" + name)
    rng = s("grains")
    count = 2400
    dens = s("density")
    times = _wrapped_times(rng, count, n, slow_wander(n, dens, 0.3, 2.5), 3.5)
    amps = np.minimum(np.exp(rng.normal(-1.0, 0.6, count)), 1.2)
    freqs = rng.uniform(150, 440, count)
    t60s = rng.uniform(0.008, 0.028, count)
    kb = rng.choice(count, 18, replace=False)
    ps, pp = (np.ones(count), np.ones(18)) if pan is None else (pan[:count], pan[count:])
    y = ring_events(n, times, amps * ps, freqs, t60s, attack_ms=0.5, periodic=True)
    # a few larger pebbles make a duller knock
    y += ring_events(n, times[kb] + 0.0004, amps[kb] * 0.7 * pp, rng.uniform(130, 210, 18),
                     rng.uniform(0.04, 0.09, 18), attack_ms=1.5, periodic=True)
    return y


def _dust_rattles(n, y, fam):
    y = structure_lowpass(y, periodic=True)
    y = y + 0.03 * rms(y) * rattles(n, 0.6, seeded(fam + "/rattle"), per_second=5.0, periodic=True) * 4
    return y - y.mean()


DUST_PAN = 0.9


@register("dust_patter_loop")
def dust_patter_loop(ctx):
    n = ctx.n
    mid = _dust_events(n)
    mid = _dust_rattles(n, mid, "dust_patter")
    if ctx.channels != 2:
        return mid
    # two channels: the same grains and pebbles at the same times, each weighted by where it falls
    # (left or right of the middle); the sum of both ears is the approved patter
    pan = _pans("dust_patter", 2400 + 18, DUST_PAN)
    side = _dust_events(n, pan)
    side = structure_lowpass(side, periodic=True)  # the side loses its bass in mid_side
    return mid_side(mid, side, periodic=True)
