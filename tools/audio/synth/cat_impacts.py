"""Impacts: hull hits, shield hits, hull groan, debris. Also the shared helpers of the three
categories thrusters, impacts and landing (cat_thrusters and cat_landing import them from here).

Everything goes through the hull (its modes are the ship's one voice). Families are one event at
different strengths: the noise that starts a blow is shared by the family (seeded by family name),
only the strength parameters change.

Helpers local to this file that could move into the library later: `ring_events` (decaying sines
at given times), `no_dc`, `blow` (a complete blow on the structure), `creak` (stick-slip groan),
`hull_ring`, `rattle_run` (a run of uneven noise knocks), and for the energy path (shield hits,
fold jump and exit) `crackle_lr`, `hiss_lr`, `growl`, `body_scale`, `soft_limit`.
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
    return lfilter([(1 + r) / 2, -(1 + r) / 2], [1.0, -r], y, axis=0)


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


# --------------------------------------------------------------------------- energy toolkit
# The energy path (SOUND_DESIGN.md section 1): the ship's high-energy systems discharging. Nothing
# here goes through the hull modes. Four layers, all in two channels (left, right):
#   crackle  very short bursts of band noise at random times and places (electrical arcing)
#   hiss     band noise that is there within milliseconds, whose band slides, torn by a flutter
#   body     the generator growl and a soft low push, in the middle (below 150 Hz both ears are equal)
#   (fold sounds add a broad crack; see cat_drive)
# These helpers are shared with cat_drive (fold jump and fold exit).

HISS_BANDS = 800.0 * 2.0 ** (np.arange(15) / 4.0)    # 800 Hz to 9 kHz in quarter octaves
HISS_TILT = (HISS_BANDS / 1000.0) ** 0.25            # a little more at the top: it hisses, not rumbles


def _sos_band(lo, hi, order=2):
    from scipy.signal import butter

    return butter(order, [lo, min(hi, 0.45 * SR)], "band", fs=SR, output="sos")


def _band_bank(white):
    """White noise through the hiss bands, each band at unit RMS: shape (bands, n)."""
    from scipy.signal import sosfilt

    out = np.empty((HISS_BANDS.size, white.size))
    for k, f in enumerate(HISS_BANDS):
        b = sosfilt(_sos_band(f * 2 ** -0.125, f * 2 ** 0.125), white)
        out[k] = b / max(rms(b), 1e-12)
    return out


def flutter_gain(n, rng, lo=30.0, hi=90.0, depth=0.8):
    """An irregular tearing of the level, 30 to 90 Hz: noise limited to that band, never a tone."""
    x = bandpass(rng.standard_normal(n + 2048), lo, hi, 2)[2048:]
    return x / max(rms(x), 1e-12) * depth


def hiss_lr(n, tag, env, fc, sigma, rho, depth=0.8, shared_flutter=0.35):
    """Band noise in two channels. `env` (level), `fc` (centre of the band in Hz) and `sigma` (width
    of the band in octaves) are arrays over time; `rho` (0 to 1, array or number) is the share of the
    noise that both ears hear alike: the rest is different on the left and on the right.
    Unit power at env 1, so the caller sets levels by env alone."""
    rng = lambda name: seeded(tag + "/hiss-" + name)
    wc, wl, wr = (rng(k).standard_normal(n) for k in ("c", "l", "r"))
    lg = np.log2(HISS_BANDS)[:, None]
    w = np.exp(-0.5 * ((lg - np.log2(np.maximum(fc, 300.0))[None, :]) / np.maximum(sigma, 0.2)[None, :]) ** 2)
    w = w * HISS_TILT[:, None]
    w = w / np.sqrt(np.maximum((w ** 2).sum(axis=0), 1e-12))[None, :]
    mix = [(w * _band_bank(x)).sum(axis=0) for x in (wc, wl, wr)]
    rho = np.broadcast_to(np.asarray(rho, dtype=np.float64), (n,))
    fc_ = flutter_gain(n, rng("fl-c"), depth=1.0)
    out = np.empty((n, 2))
    for ch, (own, fl) in enumerate(((mix[1], "fl-l"), (mix[2], "fl-r"))):
        x = np.sqrt(rho) * mix[0] + np.sqrt(1.0 - rho) * own
        f = np.sqrt(shared_flutter) * fc_ + np.sqrt(1.0 - shared_flutter) * flutter_gain(n, rng(fl), depth=1.0)
        m = np.clip(1.0 + depth * f, 0.0, 4.0)
        out[:, ch] = x * m / max(rms(m), 1e-12) * env
    return out


def pan_gains(p):
    """Constant-power gains for a place p from -1 (left) to 1 (right)."""
    th = (np.clip(p, -1.0, 1.0) + 1.0) * np.pi / 4.0
    return np.cos(th), np.sin(th)


def crackle_lr(n, rng, rate, amp_decay_s, amp_sigma=1.0, lo=1000.0, hi=8000.0, dur_ms=(0.5, 4.0), first_at=0.0,
               amp_env=None):
    """Electrical arcing: very short bursts of band noise (0.5 to 4 ms), each with its own band
    between lo and hi and its own strength (a few strong, many weak; log-normal), thrown at random
    times by a process whose rate `rate` (an array of events per second over time) falls from
    hundreds a second to single ones. Every burst sits at its own place between left and right;
    the places are chosen so that neither ear gets more of the strong ones than the other.
    Returns (n, 2). A first burst at `first_at` makes the sound start at once (None: no forced first
    burst). `amp_env`, an array over time, replaces the plain falling strength of the bursts."""
    from scipy.signal import sosfilt

    r = np.asarray(rate, dtype=np.float64)
    rmax = float(r.max())
    t = first_at if first_at is not None else 0.0
    times = [first_at] if first_at is not None else []
    while True:
        t += rng.exponential(1.0 / rmax)
        if t >= n / SR - 0.012:
            break
        if rng.uniform() < r[int(t * SR)] / rmax:
            times.append(t)
    times = np.array(times)
    k = times.size
    amps = np.exp(rng.normal(0.0, amp_sigma, k))
    if amp_env is None:
        amps = np.minimum(amps, 5.0) * (0.25 + 0.75 * np.exp(-times / amp_decay_s))
    else:
        amps = np.minimum(amps, 5.0) * np.asarray(amp_env)[(times * SR).astype(int)]
    if first_at is not None:
        amps[0] = max(amps[0], 2.0)
    durs = np.exp(rng.uniform(np.log(dur_ms[0]), np.log(dur_ms[1]), k)) / 1000.0
    centres = np.exp(rng.uniform(np.log(lo * 1.3), np.log(hi * 0.8), k))
    widths = rng.uniform(0.35, 0.7, k)               # half-width in octaves
    places = rng.uniform(0.15, 1.0, k)
    out = np.zeros((n, 2))
    el = er = 1e-9
    for i in range(k):
        m = max(8, int(durs[i] * SR))
        c = centres[i]
        sos = _sos_band(max(lo, c * 2.0 ** -widths[i]), min(hi, c * 2.0 ** widths[i]))
        x = sosfilt(sos, rng.standard_normal(m + 64))[64:]
        x = x * burst_env(m, 0.08, 0.85 * m / SR)
        x = x / max(np.max(np.abs(x)), 1e-9) * amps[i]
        # the side that has had less of the energy so far gets this one
        side = 1.0 if el > er else -1.0
        gl, gr = pan_gains(side * places[i])
        el += (gl * amps[i]) ** 2
        er += (gr * amps[i]) ** 2
        i0 = int(times[i] * SR)
        j = min(m, n - i0)
        out[i0:i0 + j, 0] += gl * x[:j]
        out[i0:i0 + j, 1] += gr * x[:j]
    return out


def growl(n, f0, sag, t_sag, rec, load, seed):
    """The generator growl: 100 Hz with odd harmonics, overdriven and rough, its pitch sagging
    under load and climbing back. Returns a mono array of unit RMS at the start."""
    t = np.arange(n) / SR
    s_ = np.where(t < t_sag, np.sin(0.5 * np.pi * t / t_sag), np.exp(-(t - t_sag) / rec))
    f = f0 * (1.0 - sag * s_)
    ph = 2 * np.pi * np.cumsum(f) / SR
    pr = seeded(seed + "/phase")
    harm = ((1, 1.0), (3, 0.8), (5, 0.4), (7, 0.15), (9, 0.05))
    tone = sum(w * np.sin(k * ph + pr.uniform(0, 6.28)) for k, w in harm)
    tone = np.tanh(1.4 * tone / max(rms(tone), 1e-9))      # overdriven: rougher, more odd harmonics
    g = bandpass(seeded(seed + "/am").standard_normal(n), 20, 40, 2)
    g /= max(3 * rms(g), 1e-9)
    am = np.clip(1.0 + 0.9 * load * g + 0.25 * load * np.sin(2 * np.pi * 30.0 * t), 0.0, None)
    y = tone * am
    return y / max(rms(y[: int(0.2 * SR)]), 1e-9)


def share(x, lo, hi):
    """Share of the energy between lo and hi Hz of a mono array."""
    p = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(x.size, 1.0 / SR)
    return float(p[(f >= lo) & (f < hi)].sum() / max(p.sum(), 1e-30))


def body_scale(body, rest, wanted):
    """Gain for `body` so that it holds `wanted` (0 to 1) of the energy of body plus rest (mono mixes)."""
    eb, er = float(np.sum(body ** 2)), float(np.sum(rest ** 2))
    return float(np.sqrt(wanted / (1.0 - wanted) * er / max(eb, 1e-30)))


def lr_from(mono):
    return np.stack([mono, mono], axis=1)


def soft_limit(y, knee):
    """Tames the few strongest sparks so that the level the build sets is not decided by one burst."""
    return knee * np.tanh(y / knee)


# --------------------------------------------------------------------------- shield hits

SHIELD = {
    # hiss: decay t60 (s), time constant of the band sliding down (s); crackle: rate at the hit and
    # at the end (per second), time constant of the thinning (s); body: sag (fraction), time to the
    # bottom of the sag, recovery (s), push level, share of the energy
    "impact_shield_light": dict(t60=0.40, tau_s=0.09, c_peak=520.0, c_floor=8.0, c_tau=0.07, load=0.45,
                                sag=0.06, t_sag=0.04, rec=0.25, push=0.7, body=0.16, body_t60=0.30),
    "impact_shield_medium": dict(t60=0.80, tau_s=0.16, c_peak=700.0, c_floor=6.0, c_tau=0.13, load=0.75,
                                 sag=0.16, t_sag=0.08, rec=0.35, push=0.9, body=0.19, body_t60=0.60),
    "impact_shield_heavy": dict(t60=1.45, tau_s=0.34, c_peak=950.0, c_floor=5.0, c_tau=0.30, load=1.0,
                                sag=0.30, t_sag=0.15, rec=0.45, push=1.1, body=0.22, body_t60=1.10),
}


def shield_hit(n, p):
    """One shield hit, two channels, before the level is set. The three strengths share their seeds
    ("impact_shield/..."): one event at three strengths, not three events."""
    t = np.arange(n) / SR
    a = int(0.004 * SR)
    # hiss: there within 4 ms, then a double-slope decay (a hard first flare, a longer sizzle)
    env = (0.60 * np.exp(-6.9078 * t / p["t60"]) + 0.25 * np.exp(-6.9078 * t / (0.4 * p["t60"]))
           + 0.15 * np.exp(-6.9078 * t / (1.7 * p["t60"])))
    env[:a] *= rise(a)
    fc = 800.0 + 6700.0 * np.exp(-t / p["tau_s"])
    sigma = 0.95 + 1.4 * np.exp(-t / 0.02)
    hs = hiss_lr(n, "impact_shield", env, fc, sigma, rho=0.35, depth=0.8)
    # crackle: dense at the hit, single sparks at the end
    rate = p["c_floor"] + p["c_peak"] * np.exp(-t / p["c_tau"])
    cr = crackle_lr(n, seeded("impact_shield/crackle"), rate, amp_decay_s=1.5 * p["c_tau"] + 0.1)
    w = slice(0, int(0.15 * SR))
    cr *= 0.85 * rms(hs[w]) / max(rms(cr[w]), 1e-12)
    # body: the growl with its sag and a soft low push, in the middle
    g = growl(n, 100.0, p["sag"], p["t_sag"], p["rec"], p["load"], "impact_shield")
    genv = np.minimum(1.0, t / 0.005) * np.exp(-6.9078 * t / p["body_t60"])
    push = thump(n, 120.0, 70.0, 6.0, 0.08 + 0.1 * p["load"], 0.05)
    push = push / max(rms(push[w]), 1e-9)
    body = g * genv + p["push"] * push
    body = lowpass(highpass(body, 40.0, 2), 1100.0, 4)
    rest = 0.5 * (hs[:, 0] + hs[:, 1]) + 0.5 * (cr[:, 0] + cr[:, 1])
    body = body * body_scale(body, rest, p["body"])
    y = hs + cr + lr_from(body)
    y = soft_limit(y, 3.2 * rms(y[w]))
    return no_dc(fade_edges(y, 0.0, 0.2 * 1000.0 * n / SR))


def _make_shield(sid):
    @register(sid)
    def _render(ctx):
        return shield_hit(ctx.n, SHIELD[sid])
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
