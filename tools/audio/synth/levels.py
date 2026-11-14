"""Level setting and the one table of target levels.

The audition page mixes scenes by simply adding the files, so levels are part of the design.
Every sound is rendered to the target in LEVELS. Loops are set by integrated loudness (LUFS,
ITU-R BS.1770), one-shots by true peak (dBFS). The true peak never exceeds CEILING_DB.
"""
from __future__ import annotations

import numpy as np

from .core import SR, db

CEILING_DB = -1.0

# id -> (mode, value). mode "lufs" is integrated loudness, "peak" is true peak in dBFS.
LEVELS: dict[str, tuple[str, float]] = {
    # engines: one engine at six settings
    "engine_main_t000": ("lufs", -38.0),
    "engine_main_t025": ("lufs", -32.0),
    "engine_main_t050": ("lufs", -27.0),
    "engine_main_t075": ("lufs", -23.0),
    "engine_main_t100": ("lufs", -20.0),
    "engine_main_boost": ("lufs", -17.0),
    # drive
    "cruise_loop": ("lufs", -24.0),
    "fold_tunnel_loop": ("lufs", -34.0),
    "fold_jump": ("peak", -1.5),
    # cabin
    "cabin_ambience_loop": ("lufs", -45.0),
    "silent_running_loop": ("lufs", -55.0),
    "cabin_ir": ("peak", -3.0),  # the file only; the page normalises the convolver itself
    # thrusters, impacts, landing
    "thruster_pulse_a": ("peak", -12.0),
    "thruster_pulse_b": ("peak", -12.0),
    "thruster_pulse_c": ("peak", -12.0),
    "impact_hull_light": ("peak", -9.0),
    "impact_hull_medium": ("peak", -5.0),
    "impact_hull_heavy": ("peak", -1.5),
    "impact_shield_light": ("peak", -9.0),
    "impact_shield_medium": ("peak", -5.0),
    "impact_shield_heavy": ("peak", -1.5),
    "touchdown_soft": ("peak", -10.0),
    "touchdown_hard": ("peak", -2.0),
    # switches
    "relay_click_a": ("peak", -14.0),
    "relay_click_b": ("peak", -14.0),
    "switch_toggle": ("peak", -16.0),
    "switch_rotary": ("peak", -16.0),
    "breaker_thunk": ("peak", -14.0),
    "button_press": ("peak", -16.0),
    # alarms: loudspeaker, by loudness; the missile warning is the loudest sound in the ship
    "alarm_heat": ("lufs", -20.0),
    "alarm_missile": ("lufs", -18.0),
    "alarm_shields_down": ("lufs", -20.0),
    "alarm_fuel_low": ("lufs", -20.0),
    "alarm_hull_critical": ("lufs", -20.0),
    "alarm_master_caution": ("lufs", -20.0),
}

# Used for ids that are not in LEVELS, so that a new category renders at once. These are
# provisional: whoever writes the category should add exact entries above.
CATEGORY_DEFAULTS: dict[tuple[str, str], tuple[str, float]] = {
    ("engines", "loop"): ("lufs", -27.0),
    ("thrusters", "loop"): ("lufs", -30.0),
    ("thrusters", "oneshot"): ("peak", -12.0),
    ("impacts", "oneshot"): ("peak", -5.0),
    ("landing", "oneshot"): ("peak", -8.0),
    ("landing", "loop"): ("lufs", -32.0),
    ("switches", "oneshot"): ("peak", -14.0),
    ("alarms", "loop"): ("lufs", -20.0),
    ("alarms", "oneshot"): ("lufs", -20.0),
    ("drive", "loop"): ("lufs", -28.0),
    ("drive", "oneshot"): ("peak", -6.0),
    ("cabin", "loop"): ("lufs", -45.0),
    ("weapons", "loop"): ("lufs", -26.0),
    ("weapons", "oneshot"): ("peak", -8.0),
    ("sensors", "oneshot"): ("lufs", -27.0),
    ("radio", "loop"): ("lufs", -32.0),
    ("radio", "oneshot"): ("peak", -14.0),
}


def target_for(sound_id: str, category: str, kind: str) -> tuple[str, float]:
    if sound_id in LEVELS:
        return LEVELS[sound_id]
    try:
        return CATEGORY_DEFAULTS[(category, kind)]
    except KeyError:
        raise KeyError("no level target for %r (%s, %s): add it to LEVELS in synth/levels.py" % (sound_id, category, kind))


def true_peak_db(x: np.ndarray) -> float:
    """Peak of the 4x oversampled signal in dBFS (what a DAC would reconstruct)."""
    from scipy.signal import resample_poly

    x = np.asarray(x, dtype=np.float64)
    return db(np.max(np.abs(resample_poly(x, 4, 1, axis=0))))


def lufs(x: np.ndarray) -> float:
    """Integrated loudness (BS.1770-4). A clip shorter than 400 ms is repeated to one block."""
    import pyloudnorm as pyln

    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    need = int(0.4 * SR) + 1
    if x.shape[0] < need:
        x = np.tile(x, (int(np.ceil(need / x.shape[0])), 1))[:need]
    v = pyln.Meter(SR).integrated_loudness(x)
    if not np.isfinite(v):
        raise ValueError("silent or fully gated: loudness is undefined")
    return float(v)


def set_level(x: np.ndarray, mode: str, target: float, ceiling_db: float = CEILING_DB):
    """Scale x to the target. Returns (y, info). If the target would put the true peak above
    the ceiling, the gain is reduced to meet the ceiling and info["limited"] is True (the
    build then shows the loudness it actually reached)."""
    x = np.asarray(x, dtype=np.float64)
    if mode == "lufs":
        gain_db = target - lufs(x)
    elif mode == "peak":
        gain_db = target - true_peak_db(x)
    else:
        raise ValueError("mode must be lufs or peak")
    y = x * 10.0 ** (gain_db / 20.0)
    tp = true_peak_db(y)
    limited = tp > ceiling_db
    if limited:
        y = y * 10.0 ** ((ceiling_db - tp) / 20.0)
        tp = ceiling_db
    return y, {"mode": mode, "target": target, "gainDb": round(float(gain_db), 2),
               "truePeakDb": round(float(tp), 2), "limited": bool(limited)}
