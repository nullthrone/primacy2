"""Drive: the cruise drive and the fold drive (one family per drive).

Both drives are chains of files that play one after another, so each chain is built on one
shared timeline instead of four separate ideas:

  cruise:  cruise_charge (4 s) -> cruise_engage (1.5 s) -> cruise_loop (8 s) -> cruise_disengage
  fold:    fold_charge (8 s) -> fold_jump (2.5 s) -> fold_tunnel_loop (7 s) -> fold_exit

The steady part of a chain (the drone of the loop) is a periodic signal. The neighbours of the
loop take their drone from that same signal at the right moment of the timeline: the engage
reads the last 1.5 s of the loop's period and the charge the 4 s before that, the disengage and
the fold exit continue from its start. Pitch, phase and level then join without a seam by
construction, and only the part that makes each event is added on top.

A one-shot has to end in silence (rule), so each junction has a gap of about 10 ms; the player
should start the next file about 15 ms early (see the report).

Everything is mono, structure path: excitation -> hull -> steep low-pass. Loudspeaker-like or
bright content is kept far below the main level.
"""
import numpy as np

from . import (LEVELS, SR, bandpass, burst_env, exp_decay, fade_edges, freq_filter, highpass, lowpass,
               machine_tone, normalize_rms,
               periodic_lfo, periodic_noise, rattles, register, resonator, rise, rms, seeded,
               slow_wander, snap_freq, structure_lowpass, thump, through_hull, transformer_tone)

# ----------------------------------------------------------------------------- levels
# One table for the drive categories. Loops are integrated loudness, one-shots true peak.
# The one-shot values of the two chains are not free: they are the values at which the drone
# inside the one-shot has the loudness of the loop it leads into (see calibrate() at the end of
# the file, which prints them from the renderers).
DRIVE_LEVELS = {
    "cruise_loop": ("lufs", -24.0),        # brief
    "cruise_charge": ("peak", -11.1),      # calibrated: drone at the end equals the loop
    "cruise_engage": ("peak", -4.3),       # calibrated, see calibrate()
    "cruise_disengage": ("peak", -10.1),    # calibrated, see calibrate()
    "fold_charge": ("peak", -8.0),         # chosen: heavier than the cruise charge, below the jump
    "fold_jump": ("peak", -1.5),           # brief
    "fold_tunnel_loop": ("lufs", -34.0),   # brief
    "fold_exit": ("peak", -11.8),          # calibrated, see calibrate()
}
LEVELS.update(DRIVE_LEVELS)


# Hull modes the drive and the weapons excite: the two or three lowest ones (37 to 89 Hz) are left
# out or weak, because small loudspeakers play nothing there. The weight lies on 118 to 334 Hz.
W_UP = np.array([0.0, 0.0, 0.15, 0.4, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0])


def _shape(y: np.ndarray, periodic: bool = False, hp: float = 60.0, fc: float = 700.0) -> np.ndarray:
    """The end of the structure path for these sounds: nothing below about 30 Hz (it only costs
    headroom, `hp` is the corner of a steep high-pass) and the steep low-pass above `fc`."""
    if periodic:
        return structure_lowpass(freq_filter(y, lo=hp, order=6), periodic=True, fc=fc)
    return structure_lowpass(highpass(y, hp, 4), fc=fc)


def _close(y: np.ndarray, in_ms: float = 0.0) -> np.ndarray:
    """End a one-shot the way the rules ask: the last 10 ms are silent (below -60 dBFS), and the
    8 ms before them are a rounded fade. The silence is the price of a file that ends cleanly;
    the player starts the next file of a chain about 20 ms early to cover it."""
    y = np.array(y, dtype=np.float64)
    gap, fade = int(0.0105 * SR), int(0.008 * SR)
    y[-gap:] = 0.0
    y[-gap - fade:-gap] *= rise(fade)[::-1]
    a = int(in_ms * SR / 1000.0)
    if a:
        y[:a] *= rise(a)
    return y


def _tone_stack(n: int, tones, name: str, trials: int = 40):
    """Sum of tones on the loop grid. Slow tones in a short window make the level depend on
    their phases, so the phases are chosen (deterministically, from seeded draws) for the
    calmest level over the loop and the most even edges: no rhythm, no bump at the seam."""
    t = np.arange(n) / SR
    w = int(0.1 * SR)
    best = None
    for k in range(trials):
        rng = seeded("%s/phase%d" % (name, k))
        phases = rng.uniform(0, 2 * np.pi, len(tones))
        y = sum(a * np.sin(2 * np.pi * snap_freq(f, n) * t + ph) for (f, a), ph in zip(tones, phases))
        r = np.sqrt(np.mean(y[: n // w * w].reshape(-1, w) ** 2, axis=1))
        e = np.sqrt(np.mean(np.concatenate([y[-int(0.05 * SR):], y[: int(0.05 * SR)]]).reshape(2, -1) ** 2, axis=1))
        cost = 20 * np.log10(r.max() / r.min()) + 20 * np.log10(max(e) / min(e))
        if best is None or cost < best[0]:
            best = (cost, y, phases)
    return best[1], best[2]


def _seg(loop: np.ndarray, start_s: float, n: int) -> np.ndarray:
    """n samples of a periodic signal at timeline position start_s (negative = before its start)."""
    return loop[(int(round(start_s * SR)) + np.arange(n)) % loop.size]


def _place(out: np.ndarray, seg: np.ndarray, pos: int, wrap: bool) -> None:
    idx = pos + np.arange(seg.size)
    if wrap:
        np.add.at(out, idx % out.size, seg)
    else:
        keep = idx < out.size
        np.add.at(out, idx[keep], seg[keep])


# ============================================================================= cruise
CRUISE_N = 8 * SR
# (Hz, level) on the 1/8 Hz grid of the 8 s loop. Close pairs beat slowly: that is the "phasing".
# The drone is heard through its upper partials (106 to 285 Hz), with a trace of 71 Hz under them.
CRUISE_TONES = ((106.25, 1.0), (106.625, 0.2), (142.5, 0.8), (142.125, 0.15), (213.0, 0.6), (212.5, 0.12),
                (285.0, 0.35), (284.5, 0.08), (71.125, 0.18))
WHINE_HZ = 520.0     # the charge's whine climbs to this pitch and arrives there at the engage
WHINE_AMP = 0.05     # against a drone body of unit RMS
LOOP_WHINE_DB = -13.0  # in the loop the whine is this much below where the charge leaves it
_cache: dict = {}


def _cruise_parts():
    if "cruise" in _cache:
        return _cache["cruise"]
    s = lambda name: seeded("cruise/" + name)
    n = CRUISE_N
    t = np.arange(n) / SR
    rng = s("phase")
    low, _ = _tone_stack(n, CRUISE_TONES, "cruise")
    flow = through_hull(periodic_noise(n, "pink", s("pink"), lo=90, hi=700), periodic=True, sharp=0.3,
                        gains=W_UP, dry=0.5)
    body = normalize_rms(low) + 0.4 * normalize_rms(flow)
    body = body * (1.0 + 0.05 * periodic_lfo(n, 0.25, 0.1))   # a slow tension in the level
    body = normalize_rms(_shape(body, periodic=True))
    body -= body.mean()
    wph = rng.uniform(0, 2 * np.pi)
    # the whine of the loop: a faint narrow band that wanders slowly in pitch and level, never a
    # ruler-straight line. A slow frequency swing (about +-8 Hz) on a tone plus a narrow band of
    # noise next to it; all of it closes over the loop.
    wob = slow_wander(n, s("whine-pitch"), 0.15, 0.9)
    fm = 2 * np.pi * WHINE_HZ * t + wph + 10.0 * wob           # a typical swing of about +-8 Hz, at most +-30 Hz
    lvl = 1.0 + 0.45 * slow_wander(n, s("whine-level"), 0.1, 0.8)
    band = periodic_noise(n, "white", s("whine-band"), lo=WHINE_HZ - 9.0, hi=WHINE_HZ + 9.0, order=6)
    whine = WHINE_AMP * 10 ** (LOOP_WHINE_DB / 20.0) * lvl * (0.8 * np.sin(fm) + 0.8 * band)
    _cache["cruise"] = (body, whine, wph, _tone_stack(n, CRUISE_TONES, "cruise")[1])
    return _cache["cruise"]


@register("cruise_loop")
def cruise_loop(ctx):
    body, whine, _w, _ph = _cruise_parts()
    return body + whine


def _charge_am(t_g: np.ndarray) -> np.ndarray:
    """Slow level swing of the charge's whine (3 cycles per 8 s). The engage carries it on."""
    return 1.0 + 0.3 * np.sin(2 * np.pi * (3 / 8.0) * t_g + 0.7)


@register("cruise_charge")
def cruise_charge(ctx):
    n = ctx.n
    body, _, wph, _ph = _cruise_parts()
    u = np.arange(n) / n
    t_g = -5.5 + np.arange(n) / SR           # timeline: the loop starts at 0, the engage at -1.5
    amp = 0.2 + 0.8 * u ** 1.5
    rate = 2.0 + 11.0 * u ** 1.3             # the throb gets quicker ...
    depth = np.clip(1.6 * u * (1 - u) ** 0.6, 0, 0.75)   # ... and melts into the drone at the end
    throb = 1.0 + depth * np.sin(2 * np.pi * np.cumsum(rate) / SR)
    y = _seg(body, -5.5, n) * amp * throb

    # the capacitor whine climbs to the whine of the loop and carries its phase and beating
    f = 110.0 * (WHINE_HZ / 110.0) ** (u ** 1.2)
    ph = 2 * np.pi * np.cumsum(f) / SR
    ph += (2 * np.pi * WHINE_HZ * t_g[-1] + wph) - ph[-1]
    am = _charge_am(t_g)
    gain = WHINE_AMP * (1.0 + 60.0 * u ** 2 * (1 - u) ** 0.7) * np.minimum(1.0, u * 10.0)
    whine = gain * am * np.sin(ph)
    # a lower partner at half the pitch crosses the hull modes on the way and makes them ring
    sub_ph = ph * 0.5
    sub = 0.6 * WHINE_AMP * 40.0 * u ** 2 * (1 - u) ** 2 * np.sin(sub_ph) * np.minimum(1.0, u * 10.0)
    sub = lowpass(through_hull(sub, sharp=0.25, gains=W_UP, dry=0.6), 650, 8)
    y = _shape(y + sub + whine, fc=760.0)
    return _close(y - y.mean(), 2.0)


@register("cruise_engage")
def cruise_engage(ctx):
    n = ctx.n
    body, whine, _w, _ph = _cruise_parts()
    t = np.arange(n) / SR
    tension = 1.0 + 0.9 * np.exp(-t / 0.4)    # the drone takes hold, then eases back to its level
    # the whine arrives from the charge at 520 Hz with the charge's phase, then sinks by about 12 dB
    # within the engage while the loop's faint wandering band takes over from it
    t_g = -1.5 + t
    c = rise(int(1.3 * SR))
    c = np.concatenate([c, np.ones(n - c.size)])[:n]
    wph = _cruise_parts()[2]
    pure = WHINE_AMP * _charge_am(t_g) * np.sin(2 * np.pi * WHINE_HZ * t_g + wph) * (1.0 - c)
    y = _seg(body, -1.5, n) * tension + pure + _seg(whine, -1.5, n) * c
    # the whump: a thump and the hull answering it; only the top of the blow rattles
    whump = thump(n, 150.0, 70.0, 4.0, 0.3, 0.1)
    pulse = np.zeros(n)
    m = int(0.012 * SR)
    pulse[:m] = burst_env(m, 2.5, 0.008) * seeded("cruise/engage-pulse").standard_normal(m)
    ring = through_hull(lowpass(pulse, 700, 2), sharp=0.6, gains=W_UP)
    whump = whump + 1.1 * rms(whump[: int(0.2 * SR)]) / max(rms(ring[: int(0.2 * SR)]), 1e-9) * ring
    whump = _shape(whump, fc=760.0)
    rat = 0.03 * rattles(n, 0.5, seeded("cruise/engage-rattle"), per_second=2.0, periodic=False, lo=1500.0, hi=3000.0) * burst_env(n, 4.0, 0.3)
    y = y + 6.0 * rms(body) * whump / max(np.max(np.abs(whump)), 1e-9) + rms(body) * rat
    return _close(_shape(y - y.mean(), fc=760.0), 3.0)


@register("cruise_disengage")
def cruise_disengage(ctx):
    n = ctx.n
    body, whine, _w, _ph = _cruise_parts()
    t = np.arange(n) / SR
    g = np.exp(-t / 0.45) * np.clip((1.5 - t) / 0.5, 0.0, 1.0) ** 0.5   # level falls away
    # the pitch falls: the tones are re-synthesised with a falling rate from the loop's phases
    sp = 1.0 - 0.15 * (0.5 - 0.5 * np.cos(np.pi * np.clip(t / 1.0, 0, 1)))
    prog = np.cumsum(sp) / SR
    low = np.zeros(n)
    for (f, a), ph in zip(CRUISE_TONES, _cruise_parts()[3]):     # the phases of the loop's tones
        low += a * np.sin(2 * np.pi * snap_freq(f, CRUISE_N) * prog + ph)
    flow = _seg(body, 0.0, n)
    flow = lowpass(flow, 330.0, 2) * 0.5 + flow * 0.5 * np.exp(-t / 0.5)   # the noise darkens as it falls
    y = (normalize_rms(low) * 0.45 + 2.0 * flow) * g
    y = y + _seg(whine, 0.0, n) * np.exp(-t / 0.2)
    # the thud when the load drops off the hull, about when the drone has gone quiet
    k = int(0.95 * SR)
    thud = np.zeros(n)
    m = n - k
    th = thump(m, 260.0, 150.0, 5.0, 0.22, 0.08)
    pulse = np.zeros(m)
    mm = int(0.012 * SR)
    pulse[:mm] = burst_env(mm, 3.0, 0.008) * seeded("cruise/disengage-pulse").standard_normal(mm)
    ring = through_hull(lowpass(pulse, 700, 2), sharp=0.5, gains=W_UP)
    th = th + 1.5 * rms(th[: int(0.2 * SR)]) / max(rms(ring[: int(0.2 * SR)]), 1e-9) * ring
    thud[k:] = _shape(th, fc=760.0)
    y = y + 2.6 * rms(body) * thud / max(np.max(np.abs(thud)), 1e-9)
    y = y * np.clip((n / SR - 0.05 - t) / 0.3, 0.0, 1.0) ** 0.5   # the hull settles to silence
    return _close(_shape(y - y.mean(), fc=760.0), 3.0)


# ============================================================================= fold
TUNNEL_N = 7 * SR
# Pressure: a trace of the lowest hull modes under a stack of the upper ones (118 to 211 Hz).
TUNNEL_TONES = ((37.0, 0.3), (37.43, 0.1), (53.0, 0.25), (118.0, 0.8), (118.43, 0.28), (147.0, 0.6),
                (147.29, 0.2), (163.0, 0.55), (211.0, 0.35))


def _creak(rng, f: float, dur: float) -> np.ndarray:
    """A stick-slip creak: a jittering train of small slips rings a hull-like resonance, and the
    pitch of the resonance drifts a little while the load shifts."""
    m = int(dur * SR)
    slips = np.zeros(m)
    pos = 0
    while pos < m:
        slips[pos] = rng.uniform(0.4, 1.0)
        pos += max(1, int(SR / rng.uniform(22.0, 70.0)))
    a = resonator(slips, f, 0.06)
    b = resonator(slips, f * rng.uniform(1.05, 1.12), 0.05)
    env = np.sin(np.pi * np.arange(m) / m) ** 2
    y = (a + 0.6 * b) * env
    return y / max(np.max(np.abs(y)), 1e-9)


def _tunnel_parts():
    if "tunnel" in _cache:
        return _cache["tunnel"]
    s = lambda name: seeded("fold_tunnel/" + name)
    n = TUNNEL_N
    t = np.arange(n) / SR
    low, _ = _tone_stack(n, TUNNEL_TONES, "fold_tunnel")
    pressure = through_hull(periodic_noise(n, "pink", s("pink"), lo=60, hi=450), periodic=True, sharp=0.4,
                            gains=np.array([0.3, 0.3, 0.5, 0.7, 1, 1, 1, 1, 1, 1]), dry=0.6)
    body = normalize_rms(low) + 0.5 * normalize_rms(pressure)
    body = body * (1.0 + 0.08 * periodic_lfo(n, 1 / 7.0 * 2, 0.3))  # two slow swells per pass
    body = normalize_rms(_shape(body, periodic=True, hp=45.0, fc=520.0))
    body -= body.mean()
    creaks = np.zeros(n)
    crng = s("creaks")
    for at, f, dur in ((0.7, 176.0, 0.9), (2.35, 212.0, 1.2), (5.9, 150.0, 0.8)):   # uneven distances
        _place(creaks, _creak(crng, f, dur), int(at * SR), wrap=True)   # distant: far below the drone
    creaks = structure_lowpass(through_hull(creaks, periodic=True, sharp=0.3, gains=W_UP, dry=0.5), periodic=True,
                               fc=520.0, order=4)
    _cache["tunnel"] = (body, normalize_rms(creaks))
    return _cache["tunnel"]


CREAK_LEVEL = 0.30   # of the drone's RMS; the creaks are heard at the margin


@register("fold_tunnel_loop", swing_max=9.0)
def fold_tunnel_loop(ctx):
    body, creaks = _tunnel_parts()
    y = body + CREAK_LEVEL * creaks
    return y - y.mean()


def _blow_ring(n: int, seed: str, sharp: float, f_hi: float = 500.0, gains=None) -> np.ndarray:
    pulse = np.zeros(n)
    m = int(0.012 * SR)
    pulse[:m] = burst_env(m, 3.0, 0.008) * seeded(seed).standard_normal(m)
    return through_hull(lowpass(pulse, f_hi, 2), sharp=sharp, gains=gains)


@register("fold_charge")
def fold_charge(ctx):
    n = ctx.n
    s = lambda name: seeded("fold_charge/" + name)
    u = np.arange(n) / n
    t = np.arange(n) / SR
    rng = s("phase")
    # pressure: the stack of the lowest hull modes, a little higher in pitch as it builds
    grow = 0.14 + 0.86 * u ** 2.2
    low = np.zeros(n)
    for f, a in ((118.0, 1.0), (118.4, 0.6), (147.0, 0.8), (147.4, 0.5), (163.0, 0.55), (211.0, 0.3), (71.0, 0.1)):
        ph = 2 * np.pi * np.cumsum(f * (1.0 + 0.12 * u ** 2)) / SR + rng.uniform(0, 2 * np.pi)
        low += a * np.sin(ph)
    rate = 0.8 + 5.5 * u ** 1.5
    depth = 0.15 + 0.45 * u
    low = normalize_rms(low) * grow * (1.0 + depth * np.sin(2 * np.pi * np.cumsum(rate) / SR))
    # the rumble: brown noise whose upper edge opens as the pressure builds
    nz = seeded("fold_charge/noise").standard_normal(n)
    lo_n, mid_n, hi_n = (normalize_rms(lowpass(nz, fc, 4)) for fc in (110.0, 220.0, 420.0))
    w = np.clip(u * 2.0, 0, 2)
    rumble = np.where(w < 1, (1 - w) * lo_n + w * mid_n, (2 - w) * mid_n + (w - 1) * hi_n)
    rumble = through_hull(rumble, sharp=0.35, gains=W_UP, dry=0.6)
    y = low + 0.55 * normalize_rms(rumble) * u ** 1.6
    # a deep whine, lower than the cruise whine, crossing the hull modes
    f = 110.0 * (380.0 / 110.0) ** (u ** 1.1)
    wh = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.35 * u ** 3
    y = y + lowpass(through_hull(wh, sharp=0.3, gains=W_UP, dry=0.7), 650, 8)
    # the hull creaks toward the end
    cr = np.zeros(n)
    crng = s("creaks")
    plan = ((0.58, 148.0, 0.9, 0.35), (0.66, 211.0, 0.8, 0.45), (0.73, 163.0, 1.0, 0.55), (0.80, 268.0, 0.7, 0.6),
            (0.86, 118.0, 1.1, 0.8), (0.91, 211.0, 0.7, 0.8), (0.95, 334.0, 0.5, 0.7))
    for at, fc, dur, lv in plan:
        _place(cr, lv * _creak(crng, fc, dur), int(at * 8.0 * SR), wrap=False)
    cr = structure_lowpass(through_hull(cr, sharp=0.3, gains=W_UP, dry=0.5))
    y = y + 0.45 * rms(y[int(0.7 * n):]) * normalize_rms(cr) * np.clip((u - 0.55) * 3.0, 0, 1)
    return _close(_shape(y - y.mean(), hp=60.0, fc=760.0), 4.0)


@register("fold_jump")
def fold_jump(ctx):
    n = ctx.n
    t = np.arange(n) / SR
    body = thump(n, 105.0, 50.0, 5.0, 0.8, 0.2)
    ring = _blow_ring(n, "fold_jump/pulse", 1.2, 700.0, np.array([0.25, 0.25, 0.4, 0.6, 1, 1, 1, 1, 1, 1]))
    scale = rms(body[: int(0.2 * SR)]) / max(rms(ring[: int(0.2 * SR)]), 1e-9)
    y = _shape(body + 1.0 * scale * ring, hp=45.0, fc=760.0)
    # the whole cabin shakes for an instant; nothing else is left after it
    rat = rattles(n, 1.0, seeded("fold_jump/rattle"), per_second=3.0, periodic=False, lo=1500.0, hi=3000.0) \
        * burst_env(n, 3.0, 0.35)
    y = y + 0.03 * rms(y[: int(0.3 * SR)]) * 6 * rat
    y = y * np.clip((n / SR - 0.12 - t) / 0.5, 0.0, 1.0) ** 0.7   # near silence at the end
    return _close(y - y.mean(), 0.0)


@register("fold_exit")
def fold_exit(ctx):
    n = ctx.n
    body, creaks = _tunnel_parts()
    t = np.arange(n) / SR
    # the tunnel drone is still there for an instant and lets go
    drone = (_seg(body, 0.0, n) + CREAK_LEVEL * _seg(creaks, 0.0, n)) * np.exp(-t / 0.18)
    thud = thump(n, 110.0, 55.0, 4.0, 0.3, 0.1)
    ring = _blow_ring(n, "fold_exit/pulse", 0.8, 700.0, W_UP)
    scale = rms(thud[: int(0.2 * SR)]) / max(rms(ring[: int(0.2 * SR)]), 1e-9)
    thud = _shape(thud + 1.0 * scale * ring, fc=760.0)
    # the hull ticks as the pressure goes: short rings of the upper hull modes, fewer and softer
    ticks = np.zeros(n)
    trng = seeded("fold_exit/ticks")
    upper = np.array([0, 0, 0, 0, 1, 1, 1, 1, 1, 1], dtype=float)
    for at, lv in ((0.37, 0.4), (0.58, 0.22), (1.12, 0.26), (1.31, 0.15), (1.97, 0.1)):
        _place(ticks, lv * _blow_ring(int(0.35 * SR), "fold_exit/tick%d" % int(at * 100), 0.12, 600.0, upper) *
               trng.uniform(0.8, 1.2), int(at * SR), wrap=False)
    ticks = structure_lowpass(ticks)
    d_rms = rms(_seg(body, 0.0, SR))
    y = drone + 9.0 * d_rms * thud / max(np.max(np.abs(thud)), 1e-9) + 5.0 * d_rms * ticks / max(np.max(np.abs(ticks)), 1e-9)
    return _close(_shape(y - y.mean(), fc=760.0), 3.0)


# ----------------------------------------------------------------------------- calibration
def calibrate(print_it: bool = True) -> dict:
    """Print the peak targets at which the drone inside each one-shot has the loudness of the loop
    it leads into (cruise loop -24 LUFS, tunnel -34 LUFS). Paste the result into DRIVE_LEVELS."""
    from . import Ctx, load_spec, lufs, true_peak_db
    spec = load_spec()["sounds"]
    out = {}

    def raw(i):
        return np.asarray(REGISTRY[i].fn(Ctx(i, spec[i])))

    from . import REGISTRY
    for loop_id, ids in (("cruise_loop", ("cruise_charge", "cruise_engage", "cruise_disengage")),
                         ("fold_tunnel_loop", ("fold_exit",))):
        lp = raw(loop_id)
        gain_db = LEVELS[loop_id][1] - lufs(lp)
        for i in ids:
            out[i] = round(float(true_peak_db(raw(i)) + gain_db), 1)
    if print_it:
        print(out)
    return out


# ============================================================================= weapons
@register("weapon_pulse_fire")
def weapon_pulse_fire(ctx):
    """A capacitor discharges with a muffled snap and a brief transformer buzz: a snap of 20 ms
    (band noise, 300 Hz to 1.5 kHz) and then a rough buzz of about 80 ms on 120 Hz with harmonics
    up to 1 kHz. This is the sound heard most in a fight, so it is short, dry in character and
    carried by the hull modes above 100 Hz, not by a boom."""
    n = ctx.n
    t = np.arange(n) / SR
    rng = seeded("pulse/snap")
    m = int(0.020 * SR)
    snap = np.zeros(n)
    snap[:m] = bandpass(rng.standard_normal(m + 512), 300.0, 1500.0, 2)[512:] * burst_env(m, 0.8, 0.012)
    snap = through_hull(snap, sharp=0.2, gains=W_UP, dry=1.0)    # muffled: the hull colours it

    # the buzz: harmonics of 120 Hz, roughened by noise-driven modulation so it is not a clean tone
    t0 = int(0.012 * SR)
    L = int(0.082 * SR)
    tt = np.arange(L) / SR
    brng = seeded("pulse/buzz")
    HARM = (0.5, 1.0, 0.9, 0.8, 0.6, 0.5, 0.4, 0.3)   # the fundamental is weak: it lies under 125 Hz
    buzz = np.zeros(L)
    for k in range(1, 9):
        buzz += HARM[k - 1] * np.sin(2 * np.pi * (120.0 * k * tt + 0.8 * tt ** 2 * k) + brng.uniform(0, 2 * np.pi))
    rough = lowpass(brng.standard_normal(L), 260.0, 2)
    buzz *= 1.0 + 0.9 * rough / max(np.std(rough), 1e-9) * 0.5
    benv = np.minimum(1.0, tt / 0.005) * np.exp(-tt / 0.045) * np.clip((0.082 - tt) / 0.020, 0, 1)
    buzz = through_hull(buzz * benv, sharp=0.15, gains=W_UP, dry=1.0)
    seg = np.zeros(n)
    seg[t0:t0 + L] = buzz
    y = snap / max(rms(snap[:m]), 1e-9) + 0.42 * seg / max(rms(buzz), 1e-9)
    y = _shape(y, hp=70.0, fc=900.0)
    return _close(y - y.mean(), 0.0)


@register("weapon_cannon_fire")
def weapon_cannon_fire(ctx):
    n = ctx.n
    # recoil: a hard low thump with the mount knocking in the upper hull modes
    body = thump(n, 175.0, 80.0, 2.5, 0.2, 0.05)
    ring = _blow_ring(n, "cannon/pulse", 0.7, 700.0, W_UP)
    scale = rms(body[: int(0.1 * SR)]) / max(rms(ring[: int(0.1 * SR)]), 1e-9)
    knock = _blow_ring(n, "cannon/knock", 0.3, 900.0, np.array([0, 0, 0, 0, 1, 1, 1, 1, 1, 1], dtype=float))
    ks = rms(body[: int(0.1 * SR)]) / max(rms(knock[: int(0.1 * SR)]), 1e-9)
    y = _shape(body + 1.2 * scale * ring + 0.8 * ks * knock, hp=60.0, fc=800.0)
    rat = rattles(n, 0.9, seeded("cannon/rattle"), per_second=3.0, periodic=False, lo=1500.0, hi=3000.0) \
        * burst_env(n, 2.0, 0.12)
    y = y + 0.03 * rms(y[: int(0.15 * SR)]) * 6 * rat
    return _close(y - y.mean(), 0.0)


@register("weapon_beam_loop")
def weapon_beam_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("beam/" + name)
    hum = transformer_tone(n, 150.0, 0.7, s("hum"))
    hum = hum * (1.0 + 0.3 * slow_wander(n, s("hum-level"), 0.3, 2.5))   # never a steady line
    pump = machine_tone(n, 59.0, (3, 4, 5), (1.0, 0.6, 0.35), beat_hz=0.67, flutter_hz=3.0, flutter=0.008,
                        beat_depth=0.5, rng=s("pump"))
    whir = machine_tone(n, 187.0, (1, 2), (1.0, 0.4), beat_hz=1.0, flutter_hz=7.0, flutter=0.01,
                        beat_depth=0.4, rng=s("whir"))
    flow = periodic_noise(n, "pink", s("flow"), lo=110, hi=700)   # the coolant flow: not only pure lines
    y = 1.4 * normalize_rms(hum) + 0.4 * normalize_rms(pump) + 0.5 * normalize_rms(whir) + 0.5 * flow
    y = through_hull(y, periodic=True, sharp=0.3, gains=W_UP, dry=0.7)
    y = _shape(y, periodic=True, hp=70.0, fc=750.0)
    y = y + 0.02 * rms(y) * rattles(n, 0.5, s("rattle"), per_second=0.8, lo=1500.0, hi=3000.0)
    return y - y.mean()


@register("mining_laser_loop")
def mining_laser_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("mining/" + name)
    hum = transformer_tone(n, 180.0, 0.35, s("hum"))
    pump = machine_tone(n, 83.0, (2, 3, 4), (1.0, 0.6, 0.4), beat_hz=0.67, flutter_hz=3.0, flutter=0.008,
                        beat_depth=0.15, rng=s("pump"))
    flow = periodic_noise(n, "pink", s("flow"), lo=120, hi=700)    # the cutting head's air and grit
    y = normalize_rms(hum) + 0.4 * normalize_rms(pump) + 0.35 * flow
    y = through_hull(y, periodic=True, sharp=0.25, gains=W_UP, dry=0.8)
    y = y * (1.0 + 0.15 * periodic_lfo(n, 1.0, 0.25))     # the slow pulse, one per second
    y = _shape(y, periodic=True, hp=70.0, fc=750.0)
    return y - y.mean()


@register("missile_launch")
def missile_launch(ctx):
    n = ctx.n
    t = np.arange(n) / SR
    # the clamp: a knock in the upper hull modes with a couple of fittings rattling
    upper = np.array([0, 0, 0, 0, 1, 1, 1, 1, 1, 1], dtype=float)
    clack = _blow_ring(n, "missile/clack", 0.3, 900.0, upper)
    clack_r = rms(clack[: int(0.1 * SR)])
    # the rumble of the motor leaving: noise whose upper edge falls as the missile goes
    nz = seeded("missile/noise").standard_normal(n)
    a, b, c = (normalize_rms(lowpass(nz, fc, 4)) for fc in (700.0, 420.0, 260.0))
    w = np.clip((t - 0.05) / 0.9, 0, 1)
    rumble = np.where(w < 0.5, (1 - 2 * w) * a + 2 * w * b, (2 - 2 * w) * b + (2 * w - 1) * c)
    renv = np.minimum(1.0, np.maximum(t - 0.07, 0) / 0.12) * np.exp(-np.maximum(t - 0.3, 0) / 0.32)
    rumble = through_hull(rumble * renv, sharp=0.3, gains=W_UP, dry=0.8)
    knock = thump(n, 150.0, 80.0, 3.0, 0.12, 0.04)
    y = _shape(knock * 1.0 + 0.9 * rms(knock[: int(0.1 * SR)]) / max(clack_r, 1e-9) * 0.95 * clack
                          + 0.8 * rumble * rms(knock[: int(0.1 * SR)]) / max(rms(rumble[int(0.15 * SR): int(0.45 * SR)]), 1e-9) * 0.45, hp=60.0, fc=800.0)
    rat = rattles(n, 0.5, seeded("missile/rattle"), per_second=3.0, periodic=False, lo=1500.0, hi=3000.0) \
        * burst_env(n, 2.0, 0.1)
    y = y + 0.02 * rms(y[: int(0.2 * SR)]) * 6 * rat
    y = y * np.clip((n / SR - 0.02 - t) / 0.35, 0, 1) ** 0.7
    return _close(y - y.mean(), 0.0)


LEVELS.update({
    # weapons: provisional, not in the brief (one-shots by true peak, loops by loudness)
    "weapon_pulse_fire": ("peak", -10.0),
    "weapon_cannon_fire": ("peak", -4.0),
    "missile_launch": ("peak", -8.0),
    "weapon_beam_loop": ("lufs", -26.0),
    "mining_laser_loop": ("lufs", -31.0),
})
