"""The rules of SOUND_DESIGN.md section 2 as code. Takes the result of listen/measure.analyse.

Returns the names of the failed rules. CLAP and the describing model are not checked here
(the build does those); the Whisper check of radio lines belongs to the radio category.
"""
from __future__ import annotations

import numpy as np

from .core import SR

LOOP_SWING_MAX_DB = 6.0  # our reading of "does not swing so that the repeat is heard as a rhythm"
DRY_CATEGORIES = {"alarms", "sensors", "radio"}


def energy_share(x: np.ndarray, lo: float, hi: float) -> float:
    """Share of the energy between lo and hi Hz (mono mix of x)."""
    m = x if x.ndim == 1 else x.mean(axis=1)
    p = np.abs(np.fft.rfft(m)) ** 2
    f = np.fft.rfftfreq(m.size, 1.0 / SR)
    tot = p.sum()
    return float(p[(f >= lo) & (f < hi)].sum() / tot) if tot > 0 else 0.0


def check(spec: dict, data: np.ndarray, an: dict, swing_max: float | None = None) -> list[str]:
    """data is the file as read back, shape (n, channels); an is measure.analyse(data, sr, loop)."""
    bad = []
    kind, path, cat = spec["kind"], spec["path"], spec["category"]
    n, ch = data.shape
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
