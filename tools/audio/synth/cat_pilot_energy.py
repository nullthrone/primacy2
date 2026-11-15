"""Direction samples, round 3, energy family: thruster pulses and shield hits.

The owner heard the dull one-shots of round 2 as "someone knocking on a plastic container" and
asked that energetic sounds always carry a bass throb. Each sound here is one event made of layers
that start together: a bright attack that says what the thing is made of, a low body that has
weight, and a tail. The variants of one sound are deliberately different characters:

    pilot_thruster_a  gas jet            valve click, a broadband hiss, valve click, small thump
    pilot_thruster_b  cinema             bright crack, chesty punch that falls in pitch, airy tail
    pilot_thruster_c  valve and thump    solenoid clack and a tight thump, almost no hiss
    pilot_shield_a    with a bass throb  crackle and hiss of the medium hit on a beating bass and a growl
    pilot_shield_b    cinema             a falling whoomp, a soft sizzle that dissolves, a field hum

All layers are built as one-shots with causal filters; the only zero-phase filtering is done on
stationary noise before an envelope is applied. Everything is seeded (ctx.rng or synth.seeded).
"""
import numpy as np

from . import (LEVELS, SR, bandpass, burst_env, exp_decay, fade_edges, highpass, lowpass, mid_side, register,
               rise, rms, seeded, thump)
from .cat_impacts import (SHIELD, body_scale, crackle_lr, flutter_gain, growl, hiss_lr, knock_noise, lr_from,
                          no_dc, soft_limit)

# Starting targets (true peak, dBFS). The thruster family is level-matched by integrated loudness
# (the three variants within 2 dB), the shield family likewise; see the report for the values chosen.
LEVELS.update({
    "pilot_thruster_a": ("peak", -12.0),
    "pilot_thruster_b": ("peak", -12.0),
    "pilot_thruster_c": ("peak", -12.0),
    "pilot_shield_a": ("peak", -5.0),
    "pilot_shield_b": ("peak", -5.0),
})


# --------------------------------------------------------------------------- helpers

def shaped_noise(n, rng, points):
    """Stationary white noise with a spectrum given as (Hz, dB) points, interpolated on a log
    frequency axis and held flat outside them. Zero phase and circular: use it on a long
    stretch of noise and put the envelope on afterwards, never on an enveloped one-shot."""
    pts = np.asarray(points, dtype=np.float64)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    g_db = np.interp(np.log(np.maximum(f, 1.0)), np.log(pts[:, 0]), pts[:, 1])
    spec = np.fft.rfft(rng.standard_normal(n)) * 10.0 ** (g_db / 20.0)
    spec[0] = 0.0
    x = np.fft.irfft(spec, n)
    return x / max(rms(x), 1e-12)


def alive(n, rng, lo, hi, depth):
    """A gain around 1 that tears irregularly at lo to hi Hz (band-limited noise, never a tone)."""
    g = bandpass(rng.standard_normal(n + 4096), lo, hi, 2)[4096:]
    return np.clip(1.0 + depth * g / max(rms(g), 1e-12), 0.0, None)


def smooth_ramp(n, a, b):
    """0 before sample a, a half-cosine rise to 1 at sample b, 1 after."""
    out = np.ones(n)
    out[:a] = 0.0
    if b > a:
        out[a:b] = rise(b - a)
    return out


def put(dst, src, i0, gain=1.0):
    """Add src into dst starting at sample i0 (cut at the end)."""
    j = min(src.shape[0], dst.shape[0] - i0)
    if j > 0:
        dst[i0:i0 + j] += gain * src[:j]
    return dst


def unit_peak(x):
    return x / max(float(np.max(np.abs(x))), 1e-12)


def click(rng, ms, lo, hi, t60_ms, attack_ms=0.2):
    """One valve or relay click: a few milliseconds of band noise, unit peak."""
    m = int(ms * SR / 1000.0)
    return unit_peak(knock_noise(m, rng, lo, hi, attack_ms, t60_ms / 1000.0))


def falling_thump(n, f0, f1, glide_s, t60, attack_ms, drive=1.0, hp=35.0, lp=None):
    """A low body that falls in pitch, optionally pushed through a soft saturation for harmonics
    (the chest of a punch) and low-passed. n samples, unit peak, starts at zero phase."""
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / glide_s)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * burst_env(n, attack_ms, t60)
    if drive > 1.0:
        y = np.tanh(drive * y) / np.tanh(drive)
    y = highpass(y, hp, 2)
    if lp:
        y = lowpass(y, lp, 4)
    return unit_peak(y)


# --------------------------------------------------------------------------- thrusters

@register("pilot_thruster_a")
def pilot_thruster_a(ctx):
    """Gas jet. Valve opens (click), a jet hisses for about 200 ms, valve shuts (click), a small
    thump goes through the hull. One channel."""
    n = ctx.n
    r = ctx.rng
    t = np.arange(n) / SR
    t_on, t_off = 0.004, 0.204                       # the jet runs from here to here
    a_on, a_off = int(t_on * SR), int(t_off * SR)
    u = np.maximum(t - t_on, 0.0)

    # The jet is two noises with their own envelopes. The high one (from 2 kHz up to a lot of air,
    # rising like the approved thrusters from 1 kHz upward) pops at the start and falls first when
    # the pressure goes; the low-mid one (250 Hz to 2 kHz) is the body of the stream and carries
    # on a little longer. Both are torn by a fast flutter and a slower wander, never flat.
    hi_noise = shaped_noise(n, r("hi"), [(1500, -5), (3000, 0), (6000, -1), (10000, -4), (14000, -5), (20000, -14)])
    hi_noise = highpass(hi_noise, 1500.0, 2)
    mid_noise = shaped_noise(n, r("mid"), [(250, -6), (600, 0), (1500, 0), (3000, -8), (8000, -18)])
    mid_noise = highpass(mid_noise, 250.0, 3)

    def swell(rise_ms, fall_ms, t_end):
        e = smooth_ramp(n, a_on, a_on + int(rise_ms * SR / 1000.0))
        e = e * np.exp(-u / 0.55)                              # a slight sag while the jet runs
        fall = np.clip((t_end - t) / (fall_ms / 1000.0), 0.0, 1.0)
        return e * (0.5 - 0.5 * np.cos(np.pi * fall))          # a rounded fall, longer than the swell

    env_hi = swell(9.0, 42.0, t_off) * (1.0 + 0.9 * np.exp(-u / 0.018))
    env_hi[:a_on] = 0.0
    env_mid = swell(16.0, 55.0, t_off + 0.012)
    hi = hi_noise * env_hi * alive(n, r("fl-hi"), 25.0, 130.0, 0.38) * alive(n, r("w-hi"), 4.0, 18.0, 0.2)
    mid = mid_noise * env_mid * alive(n, r("fl-mid"), 20.0, 90.0, 0.3) * alive(n, r("w-mid"), 3.0, 14.0, 0.2)
    jet = hi * 1.0 + mid * 0.9

    # what is left in the nozzle after the valve shuts: a short thin hiss
    tail = np.zeros(n)
    m = n - a_off
    tail_n = highpass(shaped_noise(m, r("bleed2"), [(2000, -6), (6000, 0), (12000, 2)]), 2000.0, 2)
    tail[a_off:] = tail_n * exp_decay(m, 0.07) * smooth_ramp(m, 0, int(0.003 * SR)) * 0.30

    # the two valve clicks: bright, 4 ms, the closing one softer and a little duller
    opening = click(r("click-open"), 4.5, 2200.0, 6200.0, 2.2)
    closing = click(r("click-shut"), 4.0, 1800.0, 5200.0, 2.0)
    clicks = np.zeros(n)
    put(clicks, opening, 0, 1.0)
    put(clicks, closing, a_off, 0.55)

    # the small thump through the hull, with the shutting of the valve: 150 Hz falling to 72 Hz
    tm = int(0.26 * SR)
    thump_y = falling_thump(tm, 150.0, 72.0, 0.03, 0.13, 3.5, drive=1.6, hp=40.0, lp=650.0)
    th = np.zeros(n)
    put(th, thump_y, a_off + int(0.0025 * SR))

    rest = jet + tail + clicks * (rms(jet[a_on + 480:a_off - 480]) * 3.0)
    y = rest + th * body_scale(th, rest, 0.17)
    return no_dc(fade_edges(y, 0.0, 12.0))


PUNCH_VS_CRACK, AIR_VS_CRACK = 1.3, 0.6


@register("pilot_thruster_b")
def pilot_thruster_b(ctx):
    """Cinema punch. A bright crack, a chesty punch that falls from about 320 Hz to 95 Hz, a short
    airy tail. One channel."""
    n = ctx.n
    r = ctx.rng
    # the crack: a snap and a bright burst of band noise, two small knocks (a bounce 7 ms later)
    snap = highpass(click(r("snap"), 1.2, 3000.0, 11000.0, 0.7, 0.05), 2500.0, 2)
    burst = click(r("burst"), 9.0, 1200.0, 8000.0, 5.5, 0.2)
    bounce = click(r("bounce"), 6.0, 1500.0, 6500.0, 3.5, 0.2)
    crack = np.zeros(n)
    put(crack, burst, 0, 1.0)
    put(crack, snap, 0, 0.8)
    put(crack, bounce, int(0.0075 * SR), 0.45)

    # the punch: a thump that starts high and drops across more than an octave, pushed through a
    # soft saturation so that the chest has harmonics, and a short dull knock of noise at its start
    tm = int(0.34 * SR)
    punch_a = falling_thump(tm, 330.0, 92.0, 0.05, 0.19, 4.0, drive=2.2, hp=45.0, lp=1100.0)
    punch_b = falling_thump(tm, 150.0, 58.0, 0.06, 0.22, 5.0, drive=1.3, hp=40.0, lp=420.0)
    chest = np.zeros(n)
    put(chest, punch_a + 0.9 * punch_b, int(0.0015 * SR))
    knock = lowpass(r("knock").standard_normal(n), 900.0, 2) * burst_env(n, 0.5, 0.025)
    chest += 0.22 * unit_peak(knock) * np.max(np.abs(chest))

    # the airy tail: a puff that blooms within 20 ms and fades over a quarter of a second
    air = shaped_noise(n, r("air"), [(1500, -10), (3500, 0), (7000, 3), (12000, 4), (20000, -2)])
    air = highpass(air, 1500.0, 2)
    air_env = smooth_ramp(n, int(0.012 * SR), int(0.04 * SR)) * exp_decay(n, 0.27)
    air = air * air_env * alive(n, r("fl-air"), 25.0, 110.0, 0.35)

    # energies set against the crack: the punch 1.3 of it, the air 0.6 of it, so that the first
    # 30 ms are about half crack (the attack is bright) and half of the file lies below 500 Hz
    e_crack = float(np.sum(crack ** 2))
    punch = chest * np.sqrt(PUNCH_VS_CRACK * e_crack / max(float(np.sum(chest ** 2)), 1e-12))
    air = air * np.sqrt(AIR_VS_CRACK * e_crack / max(float(np.sum(air ** 2)), 1e-12))
    y = crack + punch + air
    return no_dc(fade_edges(y, 0.0, 12.0))


THUMP_VS_CLACK, THUMP_T60, THUMP_RISE_MS, THUMP_DELAY_MS = 1.65, 0.13, 15.0, 12.0


@register("pilot_thruster_c")
def pilot_thruster_c(ctx):
    """Valve and thump. A crisp solenoid clack, a tight low thump, almost no hiss. One channel."""
    n = ctx.n
    r = ctx.rng
    # the clack: the armature hits (2.5 to 5 kHz), bounces back and hits again, with a little
    # body of the housing around 700 Hz to 1.5 kHz so that it is material and not a tick
    hit1 = click(r("hit1"), 6.5, 2300.0, 5200.0, 2.6)
    hit2 = click(r("hit2"), 4.0, 2000.0, 4600.0, 1.8)
    housing = click(r("housing"), 9.0, 700.0, 1500.0, 4.0, 0.3)
    clack = np.zeros(n)
    put(clack, hit1, 0, 1.0)
    put(clack, hit2, int(0.0072 * SR), 0.5)
    put(clack, housing, 0, 0.2)

    # the thump: starts just after the clack, mostly between 60 and 125 Hz, gone in 0.15 s
    tm = int(0.30 * SR)
    th = falling_thump(tm, 150.0, 58.0, 0.045, THUMP_T60, THUMP_RISE_MS, drive=1.35, hp=38.0, lp=420.0)
    body = np.zeros(n)
    put(body, th, int(THUMP_DELAY_MS * SR / 1000.0))
    y = clack + body * np.sqrt(THUMP_VS_CLACK * float(np.sum(clack ** 2)) / max(float(np.sum(body ** 2)), 1e-12))
    return no_dc(fade_edges(y, 0.0, 12.0))


# --------------------------------------------------------------------------- shield hits

GROWL_VS_SPARKS, THROB_SHARE = 1.25, 0.34
BASS_PAIRS = ((56.0, 8.0, 1.0), (68.0, 9.5, 0.9), (82.0, 7.0, 0.75), (96.0, 6.0, 0.4))   # base Hz, beat Hz, level


def bass_throb(n, seed, scale=1.0):
    """The throb of shield A: three close pairs of sines between 45 and 90 Hz. Each pair beats
    (6 to 12 Hz) with its second partner weaker than the first, so the swing stays near 6 to 8 dB
    and never drops to silence. The pitch sags by 12 % at the hit and climbs back, and every partner
    drifts a little, so the spectrum is a few soft humps and not a ruler-straight line. The envelope
    swells in 30 ms, stays near its top for half a second and falls over about 1.1 s. Mono."""
    rng = seeded(seed)
    t = np.arange(n) / SR
    sag = 1.0 - 0.2 * np.exp(-t / 0.22)
    out = np.zeros(n)
    for base, beat, lv in BASS_PAIRS:
        for k, (sign, w) in enumerate(((-0.5, 1.0), (0.5, 0.42))):
            drift = 1.0 + 0.07 * lowpass(np.cumsum(rng.standard_normal(n)) / np.sqrt(n), 2.5, 1) * 6.0
            f = (base + sign * beat * (1 + 0.25 * np.sin(2 * np.pi * rng.uniform(0.5, 1.5) * t))) * sag * drift
            out += lv * w * np.sin(2 * np.pi * np.cumsum(f) / SR + rng.uniform(0, 6.28))
    env_db = -6.0 * (t / 0.62) ** 2
    env = 10.0 ** (env_db / 20.0) * smooth_ramp(n, 0, int(0.030 * SR))
    y = out * env
    # a touch of saturation so that the throb has harmonics at 100 to 200 Hz (small loudspeakers)
    y = np.tanh(2.2 * y / max(np.max(np.abs(y)), 1e-9))
    return highpass(y, 30.0, 2) * scale


def shield_a_layers(n):
    """Crackle and hiss as in the medium shield hit (same seeds and parameters), shaped for 1.4 s."""
    p = SHIELD["impact_shield_medium"]
    t = np.arange(n) / SR
    a = int(0.004 * SR)
    env = (0.60 * np.exp(-6.9078 * t / p["t60"]) + 0.25 * np.exp(-6.9078 * t / (0.4 * p["t60"]))
           + 0.15 * np.exp(-6.9078 * t / (1.7 * p["t60"])))
    env[:a] *= rise(a)
    fc = 800.0 + 6700.0 * np.exp(-t / p["tau_s"])
    sigma = 0.95 + 1.4 * np.exp(-t / 0.02)
    hs = hiss_lr(n, "impact_shield", env, fc, sigma, rho=0.35, depth=0.8)
    rate = p["c_floor"] + p["c_peak"] * np.exp(-t / p["c_tau"])
    cr = crackle_lr(n, seeded("impact_shield/crackle"), rate, amp_decay_s=1.5 * p["c_tau"] + 0.1)
    w = slice(0, int(0.15 * SR))
    cr *= 0.85 * rms(hs[w]) / max(rms(cr[w]), 1e-12)
    return hs, cr


@register("pilot_shield_a")
def pilot_shield_a(ctx):
    """Shield hit with a bass throb. The crackle and hiss of the medium hit, a beating bass throb
    in the middle, and a growl between 250 Hz and 2 kHz so that nothing is a thin foil. Two channels."""
    n = ctx.n
    t = np.arange(n) / SR
    hs, cr = shield_a_layers(n)
    w = slice(0, int(0.15 * SR))
    spark = hs + cr
    spark_mono = 0.5 * (spark[:, 0] + spark[:, 1])

    # the growl: the generator growl of the old hit, a second one for the side, and rough noise
    # from 600 Hz to 2 kHz that is torn by the same kind of flutter, so the hole is filled
    g_mid = growl(n, 100.0, 0.2, 0.08, 0.45, 1.0, "pilot_shield_a")
    g_side = growl(n, 100.0, 0.2, 0.08, 0.45, 1.0, "pilot_shield_a_side")
    genv = np.minimum(1.0, t / 0.004) * np.exp(-6.9078 * t / 0.95)
    rough_l, rough_r = (bandpass(seeded("pilot_shield_a/rough-" + c).standard_normal(n), 600.0, 2200.0, 2)
                        for c in "lr")
    renv = np.minimum(1.0, t / 0.004) * np.exp(-6.9078 * t / 0.55) * alive(n, seeded("pilot_shield_a/rfl"), 30.0, 90.0, 0.6)
    g_mid = highpass(g_mid, 130.0, 2) * genv
    g_side = highpass(g_side, 130.0, 2) * genv
    growl_lr = mid_side(g_mid, g_side, periodic=False, ratio=0.6)
    growl_lr = growl_lr + np.stack([rough_l, rough_r], axis=1) * renv[:, None] * 0.55 * rms(g_mid[w]) / max(rms(rough_l[w] * renv[w]), 1e-9)

    throb = bass_throb(n, "pilot_shield_a/throb")

    # balance (shares of the mono sum): sparks about 0.30, growl about 0.30, throb the rest
    growl_mono = 0.5 * (growl_lr[:, 0] + growl_lr[:, 1])
    half = slice(0, int(0.5 * SR))
    sg = growl_lr * (rms(spark_mono[half]) / max(rms(growl_mono[half]), 1e-9)) * GROWL_VS_SPARKS
    base = spark + sg
    base_mono = 0.5 * (base[:, 0] + base[:, 1])
    throb = throb * body_scale(throb, base_mono, THROB_SHARE)
    y = base + lr_from(throb)
    y = soft_limit(y, 3.2 * rms(y[w]))
    return no_dc(fade_edges(y, 0.0, 250.0))


HUM_PARTIALS = ((183.0, 0.55), (268.0, 0.80), (337.0, 0.90), (452.0, 0.80), (617.0, 0.60))


@register("pilot_shield_b")
def pilot_shield_b(ctx):
    """Shield hit, cinema. A whoomp that falls from about 120 Hz toward 40 Hz and is gone before it
    settles, a soft sizzle that dissolves, and the hum of an energy field: five inharmonic partials
    between 180 and 700 Hz, each a close pair that beats. Two channels."""
    n = ctx.n
    t = np.arange(n) / SR
    w = slice(0, int(0.2 * SR))

    # the whoomp: reaches its top in about 15 ms; the pitch keeps falling while it fades
    f = 38.0 + 82.0 * np.exp(-t / 0.15)
    jit = bandpass(seeded("pilot_shield_b/jit").standard_normal(n + 2048), 4.0, 25.0, 2)[2048:]
    f = f * (1.0 + 0.3 * jit / max(rms(jit), 1e-9))          # the pitch is never a clean line
    ph = 2 * np.pi * np.cumsum(f) / SR
    f2 = (70.0 + 190.0 * np.exp(-t / 0.09)) * (1.0 + 0.1 * jit / max(rms(jit), 1e-9))
    env = smooth_ramp(n, 0, int(0.009 * SR)) * np.exp(-6.9078 * t / 0.6)
    whoomp = (np.sin(ph) + 0.55 * np.sin(2 * np.pi * np.cumsum(f2) / SR + 1.0) * np.exp(-t / 0.22)) * env
    # (no saturation here: a clipped sine at 30 to 40 Hz puts a hard line at three times its pitch)
    # the air moved: broad low rumble, 40 to 200 Hz, that blooms under it and fades with it
    rumble = bandpass(seeded("pilot_shield_b/rumble").standard_normal(n + 1024), 40.0, 200.0, 2)[1024:]
    rumble = rumble * smooth_ramp(n, 0, int(0.012 * SR)) * np.exp(-6.9078 * t / 0.55)
    low = highpass(whoomp / max(rms(whoomp[w]), 1e-9) + 1.6 * rumble / max(rms(rumble[w]), 1e-9), 28.0, 2)

    # the sizzle: soft, broad, a lot of it from 1.5 to 6 kHz and little above 8 kHz; the band slides
    # down while it dissolves. A few weak sparks in it, longer and duller than in A.
    envs = (0.55 * np.exp(-6.9078 * t / 0.95) + 0.45 * np.exp(-6.9078 * t / 0.35)) * smooth_ramp(n, 0, int(0.01 * SR))
    fc = 1400.0 + 1900.0 * np.exp(-t / 0.35)
    sizz = hiss_lr(n, "pilot_shield_b", envs, fc, np.full(n, 0.85), rho=0.5, depth=0.9)
    sizz = lowpass(sizz, 5200.0, 2)
    sparks = crackle_lr(n, seeded("pilot_shield_b/sparks"), 10.0 + 80.0 * np.exp(-t / 0.25), 0.4, amp_sigma=0.6,
                        lo=1200.0, hi=4200.0, dur_ms=(2.0, 7.0), first_at=None)
    sparks = lowpass(sparks, 5500.0, 2)
    sizz = sizz + sparks * (0.35 * rms(sizz[w]) / max(rms(sparks[w]), 1e-9))

    # the field hum: five partials, each a pair (left and right are detuned a little against each
    # other, which is where the width comes from) that beats against its neighbour at 2 to 7 Hz.
    rng = seeded("pilot_shield_b/hum")
    hum = np.zeros((n, 2))
    for (f0, lv) in HUM_PARTIALS:
        for sign, wgt in ((-0.5, 1.0), (0.5, 0.7)):
            beat = rng.uniform(2.0, 7.0)
            ph0 = rng.uniform(0, 6.28)
            drift = lowpass(np.cumsum(rng.standard_normal(n)) / np.sqrt(n) * 2.5, 2.0, 1)
            for ch in range(2):
                fr = (f0 + sign * beat + 0.9 * (ch - 0.5) + 0.01 * f0 * drift) * (1.0 + 0.012 * np.exp(-t / 0.15))
                hum[:, ch] += lv * wgt * np.sin(2 * np.pi * np.cumsum(fr) / SR + ph0)
    hum_env = smooth_ramp(n, int(0.01 * SR), int(0.14 * SR)) * np.exp(-6.9078 * t / 1.5)
    hum = hum * (hum_env * alive(n, seeded("pilot_shield_b/hum-fl"), 3.0, 9.0, 0.25))[:, None]

    # balance (shares of the mono sum): whoomp and rumble about 0.50, hum about 0.20, sizzle the rest
    sizz_m = 0.5 * (sizz[:, 0] + sizz[:, 1])
    hum_m = 0.5 * (hum[:, 0] + hum[:, 1])
    hum = hum * (rms(sizz_m[w]) * 0.85 / max(rms(hum_m[w]), 1e-9))
    rest_m = 0.5 * (sizz[:, 0] + sizz[:, 1] + hum[:, 0] + hum[:, 1])
    low = low * body_scale(low, rest_m, 0.50)
    y = sizz + hum + lr_from(low)
    y = soft_limit(y, 6.0 * rms(y[w]))
    return no_dc(fade_edges(y, 0.0, 250.0))
