"""Engines: one pressure-fed plasma engine at six settings.

All six share the hull modes and the same noise (seeded by family, not by sound id); only the
excitation changes with thrust: the level and roughness grow a lot, the pitch of the pumps only
a little (about 15 % from idle to full), more hull modes ring, and at the top a few rattles.
That is what lets the files crossfade without a jump.
"""
import numpy as np

from . import (N_MODES, SR, machine_tone, normalize_rms, periodic_lfo, periodic_noise, rattles, register,
               rms, seeded, slow_wander, structure_lowpass, through_hull)

PUMP_HZ = 47.0       # reactor coolant pump, partial series 1 2 3
REACTOR_HZ = 71.0    # plasma feed, two partials


def mode_gains(t: float) -> np.ndarray:
    """Which hull modes the engine drives: the low ones always, higher ones as thrust grows."""
    k = np.arange(N_MODES)
    return np.clip((t - 0.075 * k) / 0.4 + 0.45, 0.0, 1.0)


def render_engine(n: int, t: float) -> np.ndarray:
    """One engine setting; t is thrust from 0 (idle) to 1.4 (boost). Mono, any scale."""
    s = lambda name: seeded("engine_main/" + name)
    pitch = 1.0 + 0.15 * min(t, 1.0) + 0.03 * max(t - 1.0, 0.0) / 0.4

    # steady plasma flow: the same noise at every setting, shaped by the hull
    pink = periodic_noise(n, "pink", s("pink"), lo=25, hi=1500)
    brown = periodic_noise(n, "brown", s("brown"), lo=20, hi=400)
    flow = 0.7 * brown + 0.5 * pink
    flow = through_hull(flow, periodic=True, sharp=0.3, gains=mode_gains(t), dry=0.5)
    flow = normalize_rms(flow)

    # roughness: slow wander and fast flutter that close over the loop, deeper with thrust
    rough = (0.5 * slow_wander(n, s("wander"), 3.0, 40.0)
             + 0.3 * periodic_lfo(n, 11.0, 0.13) + 0.2 * periodic_lfo(n, 29.0, 0.61))
    depth = 0.05 + 0.50 * min(t, 1.4)
    flow = flow * (1.0 + depth * rough)
    drive = 0.2 + 1.6 * min(t, 1.4)
    flow = np.tanh(drive * flow) / drive

    # pumps and reactor: beating partials whose pitch moves only a little
    pump = machine_tone(n, PUMP_HZ * pitch, (1, 2, 3), (1.0, 0.5, 0.25), beat_hz=0.5,
                        flutter_hz=3.0, flutter=0.004, beat_depth=0.3, rng=s("pump"))
    plasma = machine_tone(n, REACTOR_HZ * pitch, (1, 2), (1.0, 0.4), beat_hz=0.75,
                          flutter_hz=5.0, flutter=0.004, beat_depth=0.3, rng=s("plasma"))
    tones = normalize_rms(pump + 0.7 * plasma)

    flow_gain = 0.06 + 2.2 * min(t, 1.4) ** 1.2
    y = tones + flow_gain * flow
    y = structure_lowpass(y, periodic=True)

    act = float(np.clip((t - 0.7) / 0.7, 0.0, 1.0))
    if act > 0:
        # a fitting rattles now and then, far below the main level
        y = y + 0.05 * act * rms(y) * rattles(n, act, s("rattle"), per_second=2.5)
    return y - y.mean()  # modulation of slow noise leaves a trace of offset


def _make(sound_id):
    @register(sound_id)
    def _render(ctx):
        return render_engine(ctx.n, float(ctx.params["thrust"]))
    return _render


for _id in ("engine_main_t000", "engine_main_t025", "engine_main_t050",
            "engine_main_t075", "engine_main_t100", "engine_main_boost"):
    _make(_id)
