"""Engines: one pressure-fed plasma engine at six settings.

All six share the hull modes and the same noise (seeded by family, not by sound id); only the
excitation changes with thrust: the level and roughness grow a lot, the pitch of the pumps only
a little (about 15 % from idle to full), more hull modes ring, and at the top a few rattles.
That is what lets the files crossfade without a jump.

Two channels (SOUND_DESIGN.md, section Space): the mid is the engine exactly as the owner approved
it, the side is the same engine made from other noise seeds (the same hull and pumps, only other
phases), with nothing below 150 Hz, and it grows with thrust. The six files share the side seeds
just as they share the mid seeds, so the crossfade between levels stays even.
"""
import numpy as np

from . import (N_MODES, SR, freq_filter, machine_tone, normalize_rms, periodic_lfo, periodic_noise, rattles, register,
               rms, mid_side, seeded, slow_wander, structure_lowpass, through_hull)

PUMP_HZ = 47.0       # reactor coolant pump; only its upper harmonics are used, 47 Hz itself is sub-bass
REACTOR_HZ = 71.0    # plasma feed

# How strongly each hull mode is driven by the engine. The two lowest modes (37 and 53 Hz) are
# nearly left out: a small loudspeaker plays nothing there and they only cost headroom. The
# weight sits on the modes between 100 and 400 Hz, which is where the engine is heard.
MODE_WEIGHT = np.array([0.06, 0.10, 0.25, 0.45, 1.2, 1.3, 1.4, 1.5, 1.3, 1.1])


def mode_gains(t: float) -> np.ndarray:
    """Which hull modes the engine drives: the low ones always, higher ones as thrust grows."""
    k = np.arange(N_MODES)
    return np.clip((t - 0.075 * k) / 0.7 + 0.5, 0.0, 1.0) * MODE_WEIGHT


def render_engine(n: int, t: float, seed_family: str = "engine_main") -> np.ndarray:
    """One engine setting; t is thrust from 0 (idle) to 1.4 (boost). Mono, any scale. The seed
    family chooses the noise: the default is the approved engine, another one gives the same
    engine with other phases (used for the side channel)."""
    s = lambda name: seeded(seed_family + "/" + name)
    pitch = 1.0 + 0.15 * min(t, 1.0) + 0.03 * max(t - 1.0, 0.0) / 0.4

    # steady plasma flow: the same noise at every setting, shaped by the hull. Most of the sound
    # is this noise-driven hull, not tones, so that it does not sound like a played instrument.
    pink = periodic_noise(n, "pink", s("pink"), lo=100, hi=1500)
    brown = periodic_noise(n, "brown", s("brown"), lo=80, hi=500)
    flow = 0.15 * brown + 0.9 * pink
    flow = through_hull(flow, periodic=True, sharp=0.2, gains=mode_gains(t), dry=0.35)
    flow = normalize_rms(flow)

    # roughness: irregular, noise-driven modulation (no steady sine), deeper with thrust. Two
    # bands of wander at different speeds give an uneven chugging rather than a regular beat.
    rough = (0.55 * slow_wander(n, s("wander"), 5.0, 38.0) + 0.45 * slow_wander(n, s("wander2"), 18.0, 70.0))
    depth = 0.10 + 0.55 * min(t, 1.4)
    flow = flow * (1.0 + depth * rough)
    drive = 0.2 + 1.6 * min(t, 1.4)
    flow = np.tanh(drive * flow) / drive

    # pump and reactor: upper partials only, in beating pairs, with more flutter than before and
    # a slow irregular wobble in level, so that no partial is a clean steady line
    pump = machine_tone(n, PUMP_HZ * pitch, (2, 3, 4, 5, 6), (0.8, 1.0, 0.7, 0.45, 0.3), beat_hz=0.5,
                        flutter_hz=3.0, flutter=0.012, beat_depth=0.6, rng=s("pump"))
    plasma = machine_tone(n, REACTOR_HZ * pitch, (2, 3, 4, 5), (0.9, 1.0, 0.6, 0.35), beat_hz=0.75,
                          flutter_hz=5.0, flutter=0.012, beat_depth=0.6, rng=s("plasma"))
    tones = normalize_rms(pump + 0.7 * plasma)
    tones = tones * (1.0 + 0.35 * slow_wander(n, s("tone_wander"), 0.7, 6.0))
    tones = normalize_rms(through_hull(tones, periodic=True, sharp=0.2, gains=mode_gains(t), dry=1.0))

    flow_gain = 0.45 + 2.0 * min(t, 1.4) ** 1.2
    tone_gain = 0.45 - 0.2 * min(t, 1.0)
    y = tone_gain * tones + flow_gain * flow
    y = freq_filter(y, lo=70.0, order=6)  # nothing below 30 Hz: it only costs headroom
    y = structure_lowpass(y, periodic=True, fc=680.0)

    act = float(np.clip((t - 0.7) / 0.7, 0.0, 1.0))
    if act > 0:
        # a few loose fittings knock now and then, far below the main level
        y = y + 0.025 * act * rms(y) * rattles(n, act, s("rattle"), per_second=1.2, lo=1500.0, hi=3000.0)
    return y - y.mean()  # modulation of slow noise leaves a trace of offset


def side_ratio(t: float) -> float:
    """RMS of the side against the RMS of the mid. At idle the two channels still differ a little
    (correlation about 0.83), at full thrust and boost clearly more (about 0.5 and 0.4). It is
    bounded by the rule that the correlation of the two channels stays between 0.3 and 0.9."""
    return 0.30 + 0.27 * min(t, 1.4)


def render_engine_stereo(n: int, t: float) -> np.ndarray:
    mid = render_engine(n, t)
    side = render_engine(n, t, "engine_main_side")
    return mid_side(mid, side, periodic=True, ratio=side_ratio(t))


def _make(sound_id):
    @register(sound_id)
    def _render(ctx):
        t = float(ctx.params["thrust"])
        return render_engine_stereo(ctx.n, t) if ctx.channels == 2 else render_engine(ctx.n, t)
    return _render


for _id in ("engine_main_t000", "engine_main_t025", "engine_main_t050",
            "engine_main_t075", "engine_main_t100", "engine_main_boost"):
    _make(_id)
