"""The rules of SOUND_DESIGN.md section 2 as code. Takes the result of listen/measure.analyse.

Returns the names of the failed rules. CLAP and the describing model are not checked here
(the build does those); the Whisper check of radio lines belongs to the radio category.
"""
from __future__ import annotations

import numpy as np

from .core import SR

LOOP_SWING_MAX_DB = 6.0  # our reading of "does not swing so that the repeat is heard as a rhythm"
DRY_CATEGORIES = {"alarms", "sensors", "radio"}
# A rendered file whose loudest sample is under this (dBFS) is silent: the 16-bit dither alone reaches
# about -84 dBFS, and the quietest sound of the library (silent_running_loop) peaks at -44 dBFS.
SILENT_PEAK_DB = -80.0
# A sound the ceiling stopped (levels.set_level: info["limited"]) is a hint, not a failure, when the
# loudness or peak it reached misses the target of the level table by more than this.
LEVEL_MISS_HINT_DB = 0.5


class Verdict(list):
    """What check returns: the list of the names of the failed rules (it is that list, so `== []`,
    `in`, `not bad` and JSON work as they always did), and .hints: the hints, which are not failures,
    each a string that starts with the name of the hint."""

    def __init__(self, *args):
        super().__init__(*args)
        self.hints: list[str] = []


def level_hint(an: dict, level: dict | None) -> str | None:
    """A hint where the ceiling stopped the level setting and the file does not reach its table
    target. level is the info of levels.set_level. The reached level is the file's integrated
    loudness (of the mono sum where the target was set on that: info["monoSum"]) for a loudness
    target and the file's true peak for a peak target."""
    if not level or not level.get("limited"):
        return None
    mode, target = level.get("mode"), level.get("target")
    if target is None:
        return None
    if mode == "lufs":
        reached = an.get("lufsMono") if level.get("monoSum") else an.get("lufs")
        unit = "LUFS"
    elif mode == "peak":
        reached, unit = an.get("truePeakDb"), "dBFS true peak"
    else:
        return None
    if reached is None or abs(reached - target) <= LEVEL_MISS_HINT_DB:
        return None
    return "level-missed-by-ceiling: reached %.2f %s, table target %.2f %s (stopped by the ceiling)" % (
        reached, unit, target, unit)


def energy_share(x: np.ndarray, lo: float, hi: float) -> float:
    """Share of the energy between lo and hi Hz (mono mix of x)."""
    m = x if x.ndim == 1 else x.mean(axis=1)
    p = np.abs(np.fft.rfft(m)) ** 2
    f = np.fft.rfftfreq(m.size, 1.0 / SR)
    tot = p.sum()
    return float(p[(f >= lo) & (f < hi)].sum() / tot) if tot > 0 else 0.0


# Structure sounds must keep working on headphones and small loudspeakers: enough energy where
# those play (125 Hz to 1 kHz), not too much where they do not (below 60 Hz). The fold sounds are
# pressure by intent, so their limits are looser.
MID_SHARE_MIN, LOW60_SHARE_MAX = 0.35, 0.25
PRESSURE_SOUNDS = {"fold_jump", "fold_tunnel_loop"}
PRESSURE_MID_SHARE_MIN, PRESSURE_LOW60_SHARE_MAX = 0.20, 0.40


# The energy path (SOUND_DESIGN.md section 2): it hisses, it has weight, and no pitch stands out.
ENERGY_HIGH_MIN, ENERGY_AIR_MIN, ENERGY_WEIGHT_MIN, ENERGY_PEAK_MAX = 0.30, 0.08, 0.10, 0.15

# Two channels: left and right correlate in the middle, are equal in the bass, and equally loud.
STEREO_CORR_MIN, STEREO_CORR_MAX = 0.3, 0.9
STEREO_BASS_CORR_MIN, STEREO_LEVEL_DIFF_MAX_DB = 0.98, 1.5


def is_two_channel_rule(spec: dict) -> bool:
    """The rules for two channels apply to what is made as mid and side: structure and energy."""
    return int(spec.get("channels", 1)) == 2 and spec["path"] in ("structure", "energy") and spec["kind"] != "ir"


def check(spec: dict, data: np.ndarray, an: dict, swing_max: float | None = None,
          sound_id: str | None = None, level: dict | None = None) -> Verdict:
    """data is the file as read back, shape (n, channels); an is measure.analyse(data, sr, loop).

    Returns the names of the hard rules that failed (a Verdict, which is that list and carries
    .hints). The CLAP margin is a hint and not checked here. level is the info of
    levels.set_level that made the sound; with it a sound that the ceiling stopped and whose
    reached level misses the table target by more than LEVEL_MISS_HINT_DB gets the hint
    "level-missed-by-ceiling" with both numbers (never a failure).

    For two channels the rules of the sound's path are applied to the mono sum (the analysis's
    spectral numbers and energy_share are of the mono sum), as SOUND_DESIGN.md section 2 asks."""
    bad = Verdict()
    hint = level_hint(an, level)
    if hint:
        bad.hints.append(hint)
    sound_id = sound_id or spec.get("id")
    kind, path, cat = spec["kind"], spec["path"], spec["category"]
    n, ch = data.shape
    if n == 0:
        bad.append("silent")  # nothing to measure: the rules below read the samples
        return bad
    if np.abs(data).max() < 10 ** (SILENT_PEAK_DB / 20):
        bad.append("silent")  # on every path, kind and category: a file of dither only is not a sound
    if an["sampleRate"] != SR:
        bad.append("sample-rate")
    if ch != int(spec.get("channels", 1)):
        bad.append("channels")
    if an["truePeakDb"] > -1.0:
        bad.append("true-peak")
    if an["clippedSamples"] > 0:
        bad.append("clipped")
    if an["dcOffset"] >= 0.001:
        bad.append("dc-offset")
    mono = np.abs(data).max(axis=1)
    if kind in ("oneshot", "ir"):
        loud = np.flatnonzero(mono >= mono.max() * 10 ** (-40 / 20))
        if loud.size == 0 or loud[0] > 0.005 * SR:
            bad.append("onset-late")
        if mono[-int(0.010 * SR):].max() > 10 ** (-60 / 20):
            bad.append("tail-not-silent")
    if kind == "loop":
        lp = an.get("loop", {})
        if not lp.get("pass", False):
            bad.append("loop-seam")
        limit = LOOP_SWING_MAX_DB if swing_max is None else swing_max
        if lp.get("levelSwingDb", 0.0) > limit:
            bad.append("loop-level-swing")
    if path == "structure":
        if an["lowShare"] < 0.85:
            bad.append("structure-low-share")
        if an["highShare"] > 0.02:
            bad.append("structure-high-share")
        pressure = sound_id in PRESSURE_SOUNDS
        mid_min = PRESSURE_MID_SHARE_MIN if pressure else MID_SHARE_MIN
        low60_max = PRESSURE_LOW60_SHARE_MAX if pressure else LOW60_SHARE_MAX
        if energy_share(data, 125, 1000) < mid_min:
            bad.append("structure-mid-share")
        if energy_share(data, 0, 60) > low60_max:
            bad.append("structure-sub-share")
    if path == "energy":
        # all shares are of the mono sum: energy_share mixes the channels down
        if energy_share(data, 1000, SR) < ENERGY_HIGH_MIN:
            bad.append("energy-high-share")
        if energy_share(data, 4000, SR) < ENERGY_AIR_MIN:
            bad.append("energy-air-share")
        if energy_share(data, 0, 250) < ENERGY_WEIGHT_MIN:
            bad.append("energy-weight")
        if an.get("peakShare", 0.0) > ENERGY_PEAK_MAX:
            bad.append("energy-peak")
    if is_two_channel_rule(spec) and ch == 2:
        st = an.get("stereo")
        if st is None:  # an measured without the stereo numbers: take them from the data
            from measure import stereo_stats

            st = stereo_stats(data, an["sampleRate"])
        if not STEREO_CORR_MIN <= st["corr"] <= STEREO_CORR_MAX:
            bad.append("stereo-correlation")
        if st["corrLow"] < STEREO_BASS_CORR_MIN:
            bad.append("stereo-bass-correlation")
        if st["levelDiffDb"] >= STEREO_LEVEL_DIFF_MAX_DB:
            bad.append("stereo-level-diff")
    if cat == "switches" and kind == "oneshot" and spec["duration"] <= 0.5:
        if n / SR > spec["duration"] + 1e-6:
            bad.append("switch-too-long")
        c = an.get("spectralCentroidHz") or 0
        if not 800 <= c <= 5000:
            bad.append("switch-centroid")
    if cat == "alarms":
        f0 = an.get("fundamentalHz")
        if f0 is None or not 400 <= f0 <= 1600:
            bad.append("alarm-fundamental")
        if energy_share(data, 5000, SR) > 0.001:
            bad.append("alarm-high-energy")
    if cat == "sensors":
        if energy_share(data, 6000, SR) > 0.001:
            bad.append("sensor-high-energy")
    if cat == "radio":
        if energy_share(data, 0, 250) > 0.01 or energy_share(data, 3800, SR) > 0.01:
            bad.append("radio-band")
    return bad
