"""Render the registered sounds, measure them, check them against SOUND_DESIGN.md and write the manifest.

    .venv-audio/Scripts/python.exe tools/audio/build.py [--only id,id] [--category name]
        [--out DIR] [--no-clap] [--describe] [--manifest-only]

For every sound: <out>/<category>/<id>.wav, a spectrogram <id>.png and a small <id>.json with the
measurements and the result of every rule. Chosen downloads (selection.json) and generated sounds
(generated.json) are written as processed copies to <out>/downloads and <out>/generated. The manifest is assembled from all the small JSON
files in <out>, so several people can build their own categories into one folder.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "listen"))

import numpy as np  # noqa: E402

import synth  # noqa: E402
from synth import rules  # noqa: E402

DEFAULT_OUT = ROOT / "assets" / "audio" / "render"
SELECTION = ROOT / "assets" / "audio" / "selection.json"
DOWNLOADS = ROOT / "assets" / "audio" / "downloads"
GENERATED_LIST = ROOT / "assets" / "audio" / "generated.json"
GENERATED_DIR = ROOT / "assets" / "audio" / "generated"
LICENCE = "AGPL-3.0-or-later"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def file_hash(path: Path) -> str:
    """First twelve hex digits of the SHA-256 of the file: the audition page stores it with a
    rating and marks the sound as changed when it differs."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]


def build_sound(sound_id: str, out: Path, clap, describe_fn, measure, common) -> dict:
    spec = synth.load_spec()
    s = spec["sounds"][sound_id]
    entry = synth.REGISTRY[sound_id]
    x, level = synth.render(sound_id)
    wav = out / s["category"] / (sound_id + ".wav")
    synth.write_wav(wav, x, dither_seed=sound_id, shared_dither=synth.is_mid_side(s))
    data, sr = common.load_audio(wav)
    an = measure.analyse(data, sr, loop=s["kind"] == "loop")
    verdict = rules.check(s, data, an, entry.swing_max, sound_id=sound_id, level=level)
    failed = list(verdict)
    hints: list[str] = list(verdict.hints)  # not failures: e.g. the ceiling stopped the level and the target was missed
    png = wav.with_suffix(".png")
    measure.write_png(png, sound_id, data, sr, an)

    checks = {
        "pass": False, "failed": failed,
        "peakDb": an["truePeakDb"], "lufs": an["lufs"],
        "lowShare": an["lowShare"], "highShare": an["highShare"],
        "centroidHz": an["spectralCentroidHz"], "level": level,
    }
    if "loop" in an:
        checks["loop"] = {k: an["loop"].get(k) for k in ("seamRatio", "levelSwingDb", "edgeLevelDiffDb", "pass")}
    if clap is not None:
        from compare import judge

        pos = s.get("pos", [])
        neg = list(dict.fromkeys(spec["neg"] + spec["categories"][s["category"]].get("neg", [])))
        j = judge(clap, common.to_mono(data), sr, pos, neg)
        checks["clap"] = {"best": j.get("bestPos") or j["best"], "margin": j.get("margin"),
                          "bestNeg": j.get("bestNeg")}
        # an impulse response is a tool for the convolver, not a sound anyone hears by itself:
        # its CLAP margin is recorded but does not decide pass or fail
        # the CLAP margin is only a hint (SOUND_DESIGN.md section 3): it never fails a sound
        if j.get("margin") is not None and j["margin"] <= 0 and s["kind"] != "ir":
            hints.append("clap-margin")
    if describe_fn is not None:
        checks["described"] = describe_fn(wav)
    checks["pass"] = not failed
    if hints:
        checks["hints"] = hints
    checks["peakShare"] = an["peakShare"]
    if "stereo" in an:
        checks["stereo"] = an["stereo"]
        checks["lufsMono"] = an["lufsMono"]
    checks["midShare"] = round(rules.energy_share(data, 125, 1000), 3)
    checks["subShare"] = round(rules.energy_share(data, 0, 60), 3)

    dry = s["category"] in rules.DRY_CATEGORIES
    manifest_entry = {
        "id": sound_id,
        "file": "%s/%s.wav" % (s["category"], sound_id),
        "spectrogram": "%s/%s.png" % (s["category"], sound_id),
        "category": s["category"], "kind": s["kind"], "path": s["path"],
    }
    for k in ("family", "params", "place", "cue"):  # place and cue as they are in sounds.json (section 3)
        if k in s:
            manifest_entry[k] = s[k]
    manifest_entry.update({
        "en": s["en"], "de": s["de"], "intent": s["intent"],
        "source": "synth", "licence": LICENCE,
        "duration": round(data.shape[0] / sr, 4), "channels": int(s.get("channels", 1)), "gain": 1.0,
        "dry": dry, "hash": file_hash(wav), "checks": checks,
    })
    record = {"manifest": manifest_entry, "measure": an}
    _atomic_write(wav.with_suffix(".json"), json.dumps(record, indent=1, default=_json_default))
    return manifest_entry


# Where a processed download sits, so that it plays at the level of a rendered sound of its
# category. Keys are (category, "short" | "long"): short is a one-shot of up to SHORT_ONESHOT_S,
# set by true peak; long one-shots and loops are set by loudness (LUFS). The values come from
# CATEGORY_DEFAULTS and LEVELS in synth/levels.py. Where levels.py has no value for the pair the
# nearest sensible one is taken and says so here:
#   engines  short: no one-shot value; between thruster_pulse (-12) and impact_hull_medium (-5)
#            for a burst of an engine, so -8 (the weapons one-shot default).
#   engines  long / loop: the engine loop default, -27 LUFS (engine_main_t050).
#   thrusters short -12 peak (thruster_pulse_*), long -30 LUFS (thruster loop default).
#   impacts  short -5 peak (impact_*_medium). Long: no value; an impact of medium strength that
#            lasts a couple of seconds measures about -26 LUFS, taken as -26.
#   landing  short -8 peak (landing one-shot default), long -32 LUFS (landing loop default).
#   switches short -14 peak (relay_click_*, breaker_thunk); long: no value, -30 LUFS (as thrusters).
#   cabin    short: no value, -16 peak (button_press); long one-shot -32 LUFS (see below); loop -45
#            LUFS (cabin_ambience_loop).
#   sensors  default is -27 LUFS for any one-shot; for the short ones that is about -17 dB peak
#            of a blip, taken as -16 peak. Loops: no value, -27 LUFS as the one-shots.
#   radio    short -14 peak, long / loop -32 LUFS (radio defaults).
#   alarms   loudspeaker, -20 LUFS (the alarm defaults); short -10 peak, nearest to a short beep.
#   drive, weapons: the category defaults; long one-shots of weapons: -26 LUFS (weapons loop).
# A loop is looked up under (category, "loop") first and falls back to (category, "long").
#
# A bed level must not be given to an event. The loop defaults above are the levels of beds (the
# cabin ambience at -45 LUFS sits 29 dB below a button press at -16 dBFS peak); a one-shot that
# lasts a few seconds is an event, and at a bed level it vanishes next to the rendered sounds of
# its category (review of 2026-11-15: k_computer_noise_1 peak -37 dBFS, n_dinks_donks -23).
# The test applied to every row: a long one-shot should sit near the loudness of a short one at
# its peak target, taken as the short peak minus 16 dB (the cabin value -32 is the owner's
# decision and follows from it; the crest factor of the long one-shots of the library is 8 to
# 20 dB). A long row more than 8 dB under that value is a bed level and is corrected:
#   cabin    long -45 -> -32 LUFS (short -16 - 16 = -32; 13 dB under). Loop stays -45.
#   landing  long -32 -> -24 LUFS (short -8 - 16 = -24; 8 dB under, a touchdown is an event). Loop
#            stays -32. No download uses this row at present.
# The other rows are within 8 dB of that value (engines -27 against -24, thrusters -30 against
# -28, impacts -26 against -21, switches -30 against -30, radio -32 against -30, weapons -26
# against -24, drive -28 against -22) and stay as they were.
DOWNLOAD_TARGETS: dict[tuple[str, str], tuple[str, float]] = {
    ("engines", "short"): ("peak", -8.0), ("engines", "long"): ("lufs", -27.0),
    ("thrusters", "short"): ("peak", -12.0), ("thrusters", "long"): ("lufs", -30.0),
    ("impacts", "short"): ("peak", -5.0), ("impacts", "long"): ("lufs", -26.0),
    ("landing", "short"): ("peak", -8.0), ("landing", "long"): ("lufs", -24.0),
    ("landing", "loop"): ("lufs", -32.0),
    ("switches", "short"): ("peak", -14.0), ("switches", "long"): ("lufs", -30.0),
    ("cabin", "short"): ("peak", -16.0), ("cabin", "long"): ("lufs", -32.0),
    ("cabin", "loop"): ("lufs", -45.0),
    ("sensors", "short"): ("peak", -16.0), ("sensors", "long"): ("lufs", -27.0),
    ("radio", "short"): ("peak", -14.0), ("radio", "long"): ("lufs", -32.0),
    ("alarms", "short"): ("peak", -10.0), ("alarms", "long"): ("lufs", -20.0),
    ("drive", "short"): ("peak", -6.0), ("drive", "long"): ("lufs", -28.0),
    ("weapons", "short"): ("peak", -8.0), ("weapons", "long"): ("lufs", -26.0),
}
DOWNLOAD_FALLBACK = {"short": ("peak", -12.0), "long": ("lufs", -30.0)}  # a category without a row
SHORT_ONESHOT_S = 1.5
DOWNLOAD_SR = 48000
# ceiling for the level setting: -1 dBFS true peak, with a little room for the rounding to 16 bit
DOWNLOAD_CEILING_DB = -1.05
SILENT_EDGE_DB = -60.0      # an edge sample (start) or millisecond (end) below this needs no repair
LEAD_IN_MS = 1.5            # ramp 0 -> first sample put in front of a start that is a step
FADE_OUT_MS = 30.0
TAIL_MS = 3.0               # raised-cosine tail appended where the loudest part of a one-shot is at its end
ENV_WINDOW_MS = 1.0         # the envelope is the moving average of the channel maximum of |x| over this
LOOP_XFADE_S = 0.3          # loop seam: crossfade of the tail into the head, at most this long ...
LOOP_XFADE_SHARE = 0.1      # ... and at most this share of the file
LOOP_EDGE_WINDOW_S = 0.05   # the loop check compares the level of the first and the last 50 ms ...
LOOP_EDGE_TRY_DB = 2.0      # ... and the wrap point is moved where that differs by more than this
LOOP_ROLL_HOP_S = 0.01      # candidate wrap points lie this far apart
LOOP_ALIGN_S = 0.03         # the cut of the tail may move this far earlier to line it up with the head
LOOP_CORR_LINEAR = 0.5      # normalised correlation above which the crossfade adds the signals (equal gain)
LOOP_ZONE_WINDOW_S = 0.05   # level of the crossfade zone is measured in windows of this length ...
LOOP_ZONE_MAX_DB = 1.5      # ... and may differ from the level just outside the zone by this much
CLIP_SHARE = 0.001          # "within 0.1 % of the maximum"
CLIP_MIN_PEAK = 0.98        # the maximum must be at least this much of full scale
CLIP_MIN_RUN = 3


def download_target(category: str, kind: str, duration_s: float) -> tuple[str, float]:
    """Level target (mode, value) for a download: a loop or a one-shot longer than SHORT_ONESHOT_S
    is set by loudness, a shorter one-shot by true peak."""
    length = "short" if kind == "oneshot" and duration_s <= SHORT_ONESHOT_S else "long"
    if kind == "loop" and (category, "loop") in DOWNLOAD_TARGETS:
        return DOWNLOAD_TARGETS[(category, "loop")]
    return DOWNLOAD_TARGETS.get((category, length), DOWNLOAD_FALLBACK[length])


def detect_source_clipping(x: np.ndarray) -> int:
    """Samples that sit in a run of at least CLIP_MIN_RUN consecutive samples within 0.1 % of the
    file's maximum (per channel), when that maximum is at least 0.98 of full scale. x is (n, ch)."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    if x.size == 0:
        return 0
    # magnitudes above full scale (a lossy decoder overshoots a clipped waveform, up to 1.14 in
    # the SLS recording) count as full scale: otherwise the flat plateaus of such a file are
    # not within 0.1 % of its highest overshoot and clipping goes unseen
    a = np.minimum(np.abs(x), 1.0)
    top = float(a.max())
    if top < CLIP_MIN_PEAK:
        return 0
    hit = a >= top * (1.0 - CLIP_SHARE)
    total = 0
    for c in range(hit.shape[1]):
        h = np.concatenate(([False], hit[:, c], [False]))
        edges = np.flatnonzero(h[1:] != h[:-1])
        runs = edges[1::2] - edges[0::2]
        total += int(runs[runs >= CLIP_MIN_RUN].sum())
    return total


def _fade_curve(n: int) -> np.ndarray:
    """Raised cosine rising from exactly 0 to exactly 1 over n samples."""
    if n < 2:
        return np.ones(max(n, 0))
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / (n - 1))


def _lead_in(first: np.ndarray, n: int) -> np.ndarray:
    """n samples of a raised cosine rising from exactly 0 towards the first sample (per channel),
    the last of them one step short of it, so that the file that follows continues the ramp."""
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    return ramp[:, None] * first[None, :]


def envelope_peak_index(x: np.ndarray) -> int:
    """Index (in samples) of the maximum of the envelope of x (n, ch): the moving average over
    ENV_WINDOW_MS of the largest |sample| of the channels, centred, first maximum on a tie."""
    w = max(1, int(round(ENV_WINDOW_MS * DOWNLOAD_SR / 1000.0)))
    m = np.abs(x).max(axis=1)
    if m.shape[0] < w:
        return int(np.argmax(m))
    cs = np.concatenate([[0.0], np.cumsum(m)])
    env = (cs[w:] - cs[:-w]) / w          # env[i] covers samples i .. i+w-1
    return int(np.argmax(env)) + w // 2


def _tail_out(last: np.ndarray, n: int) -> np.ndarray:
    """n samples of a raised cosine falling from the last sample (per channel) to exactly zero: the
    first of them one step below it, the last one zero."""
    ramp = 0.5 + 0.5 * np.cos(np.pi * np.arange(1, n + 1) / n)
    return ramp[:, None] * last[None, :]


def _align_tail(x: np.ndarray, k: int, smax: int) -> np.ndarray:
    """Normalised cross-correlation (summed over the channels, no mean removed) between the head
    x[:k] and the tail x[n-s-k : n-s] for every cut s = 0 .. smax samples before the end."""
    from scipy.signal import fftconvolve

    n = x.shape[0]
    head = x[:k]
    region = x[n - k - smax: n]
    num = np.zeros(smax + 1)
    en = np.zeros(smax + 1)
    for c in range(x.shape[1]):
        num += fftconvolve(region[:, c], head[::-1, c], mode="valid")
        cs = np.concatenate([[0.0], np.cumsum(region[:, c] ** 2)])
        en += cs[k: k + smax + 1] - cs[: smax + 1]
    hn = float((head ** 2).sum())
    corr = num / np.sqrt(np.maximum(en * hn, 1e-30))
    return corr[::-1]            # index s: the tail that ends s samples before the end of x


def _zone_levels(y: np.ndarray, tail: np.ndarray, head: np.ndarray, k: int, fin: np.ndarray, fout: np.ndarray) -> dict:
    """Levels of a loop's crossfade zone, which is y[:k] and circular (y wraps). In windows of
    LOOP_ZONE_WINDOW_S every 10 ms that lie inside the zone, the power (mean over samples and
    channels) is compared in dB with
      - the power of the k samples before and the k samples after the zone together
        (vsOutsideDb: the literal "level just outside the zone"; it includes whatever the recording
        itself does in those 600 ms), and
      - the power the same window has in the tail and the head that were mixed, averaged with the
        squares of the weights of the law at the middle of the window and divided by their sum
        (vsSourcesDb: what the crossfade itself adds or takes away; 0 where the law matches the
        material, about -3 dB where two copies of one signal are mixed with the power law out of
        phase, or two unrelated signals with the linear law).
    Each is the signed deviation of largest magnitude. outsideSpreadDb is the range of the same
    windows over the rest of the loop, against the same reference, for comparison."""
    m, w, hop = y.shape[0], int(round(LOOP_ZONE_WINDOW_S * DOWNLOAD_SR)), int(round(0.01 * DOWNLOAD_SR))
    if k < w:
        return {}

    def pw(a: np.ndarray) -> np.ndarray:
        p = (a ** 2).mean(axis=1)
        return np.concatenate([[0.0], np.cumsum(p)])

    def mean(cs: np.ndarray, a: int, b: int) -> float:
        return float((cs[b] - cs[a]) / (b - a))

    db = lambda v: 10.0 * np.log10(max(v, 1e-12))   # noqa: E731
    cy, ct, ch = pw(np.concatenate([y, y, y])), pw(tail), pw(head)
    z = m                                            # the zone starts here in the tripled signal
    ref = db(0.5 * mean(cy, z - k, z) + 0.5 * mean(cy, z + k, z + 2 * k))
    ins = range(0, k - w + 1, hop)
    vs_out = [db(mean(cy, z + o, z + o + w)) - ref for o in ins]
    def expected(o: int) -> float:
        a, b = float(fout[o + w // 2, 0]) ** 2, float(fin[o + w // 2, 0]) ** 2
        return (a * mean(ct, o, o + w) + b * mean(ch, o, o + w)) / (a + b)

    vs_src = [db(mean(cy, z + o, z + o + w)) - db(expected(o)) for o in ins]
    outs = [db(mean(cy, a, a + w)) - ref for a in range(z + k, z + m - w + 1, hop)]
    big = lambda v: max(v, key=abs)                 # noqa: E731
    return {"vsOutsideDb": round(float(big(vs_out)), 2), "vsSourcesDb": round(float(big(vs_src)), 2),
            "outsideSpreadDb": [round(float(min(outs)), 2), round(float(max(outs)), 2)]}


def _loop_crossfade(x: np.ndarray, info: dict | None = None) -> tuple[np.ndarray, int]:
    """Make x wrap without a step: the last k samples are mixed into the first k and cut off, so the
    result is k samples (plus the shift below) shorter. Its first sample is the sample that followed
    its last one in the recording. Returns (y, k); k is 0 where the file is too short.

    Two things depend on how well the tail and the head agree. The cut may move up to LOOP_ALIGN_S
    earlier, to the offset s at which the normalised cross-correlation of the two over the
    crossfade length is highest (a steady tone is in phase with itself only at some offsets; for
    noise the best offset is a small gain over s = 0, which does no harm). And the law: where the correlation is above LOOP_CORR_LINEAR the weights add to 1
    (linear, equal gain: two copies of one signal keep their level), otherwise their squares do
    (cos / sin, equal power: two unrelated signals keep their power, corrected for the part of
    the correlation that is left, see below). info, if given, receives
    loopShiftMs, loopCorrelation, loopLaw and loopZone (see _zone_levels)."""
    n = x.shape[0]
    k = min(int(round(LOOP_XFADE_S * DOWNLOAD_SR)), int(n * LOOP_XFADE_SHARE))
    if k < 2:
        return x, 0
    smax = max(0, min(int(round(LOOP_ALIGN_S * DOWNLOAD_SR)), n - 2 * k))
    corr = _align_tail(x, k, smax)
    s = int(np.argmax(corr))          # the first of equal maxima: the smallest shift
    c = float(corr[s])
    linear = c > LOOP_CORR_LINEAR
    t = np.arange(k) / k
    if linear:
        fin, fout = t[:, None], (1.0 - t)[:, None]
    else:
        # cos / sin keep the power of two unrelated signals; where the two still agree a little
        # (0 < c <= 0.5) their sum is louder by c * sin(2 theta), which the divisor takes out again
        th = 0.5 * np.pi * t
        g = 1.0 / np.sqrt(1.0 + min(max(c, 0.0), LOOP_CORR_LINEAR) * np.sin(2.0 * th))
        fin, fout = (g * np.sin(th))[:, None], (g * np.cos(th))[:, None]
    e = n - s
    y = x[: e - k].copy()
    y[:k] = x[:k] * fin + x[e - k: e] * fout
    if info is not None:
        info["loopShiftMs"] = round(1000.0 * s / DOWNLOAD_SR, 3)
        info["loopCorrelation"] = round(c, 4)
        info["loopLaw"] = "linear" if linear else "equal-power"
        info["loopZone"] = _zone_levels(y, x[e - k: e], x[:k], k, fin, fout)
    return y, k


def _edge_level_diff_db(s: np.ndarray, r: int, w: int, ch: int) -> float:
    """Level difference in dB between the w samples after and the w samples before position r of a
    circular signal, s being its power per sample (summed over the channels), like the loop check."""
    m = s.shape[0]
    cs = np.concatenate([[0.0], np.cumsum(np.concatenate([s, s]))])
    after = (cs[r + w] - cs[r]) / (w * ch)
    before = (cs[r + m] - cs[r + m - w]) / (w * ch)
    floor = 1e-12
    return abs(10.0 * np.log10(max(after, floor)) - 10.0 * np.log10(max(before, floor)))


def _loop_roll(y: np.ndarray) -> tuple[np.ndarray, int]:
    """A crossfaded loop is continuous all the way round, so it may start anywhere. Where the level
    of its first and its last 50 ms differ by more than LOOP_EDGE_TRY_DB (the loop check fails at
    3 dB: a recording that is louder here than there), start it at the wrap point, a multiple of
    LOOP_ROLL_HOP_S, where the two differ least (the earliest on a tie). Returns (y, start)
    with start in samples (0 where nothing was moved)."""
    m, ch = y.shape
    w = int(DOWNLOAD_SR * LOOP_EDGE_WINDOW_S)
    if m < 2 * w:
        return y, 0
    s = (y ** 2).sum(axis=1)
    if _edge_level_diff_db(s, 0, w, ch) <= LOOP_EDGE_TRY_DB:
        return y, 0
    hop = int(round(DOWNLOAD_SR * LOOP_ROLL_HOP_S))
    cands = np.arange(0, m, hop)
    diffs = np.array([_edge_level_diff_db(s, int(r), w, ch) for r in cands])
    r = int(cands[int(np.argmin(diffs))])
    return np.roll(y, -r, axis=0), r


def prepare_download(data: np.ndarray, sr: int, excerpt: tuple[float, float] | None = None) -> tuple[np.ndarray, dict]:
    """The first steps of process_download: cut the excerpt (seconds), keep 1 or 2 channels (more
    are mixed down to 2), count the clipped samples of that cut as it is, resample to 48 kHz.
    Returns (float array (n, ch) at 48 kHz, info)."""
    from math import gcd

    from scipy.signal import resample_poly

    x = np.array(data, dtype=np.float64)  # a copy: nothing here changes the input
    if x.ndim == 1:
        x = x[:, None]
    if excerpt is not None:
        x = x[int(excerpt[0] * sr): int(excerpt[1] * sr)]
    if x.shape[0] == 0:
        raise ValueError("empty excerpt")
    if x.shape[1] > 2:  # even channels to the left, odd ones to the right
        x = np.stack([x[:, 0::2].mean(axis=1), x[:, 1::2].mean(axis=1)], axis=1)
    info: dict = {"sourceClipped": detect_source_clipping(x), "sourceSr": int(sr)}
    if sr != DOWNLOAD_SR:
        g = gcd(int(sr), DOWNLOAD_SR)
        x = resample_poly(x, DOWNLOAD_SR // g, int(sr) // g, axis=0)
    return x, info


def repair_oneshot_ends(x: np.ndarray, info: dict) -> np.ndarray:
    """The end repair of a one-shot at 48 kHz (n, ch), shared by downloads and generated sounds.
    The recording itself is never multiplied at its start, so no attack is lost. Where the first
    SAMPLE is above SILENT_EDGE_DB a lead-in of LEAD_IN_MS is put in front. Where the last
    millisecond is not silent the last FADE_OUT_MS are faded out, or, where the loudest part of
    the sound is in those, a short tail is appended. info receives leadInMs, fadeOutMs and
    appendedTailMs. x is changed in place where it is faded; the result may be a new array."""
    n = x.shape[0]
    ms = DOWNLOAD_SR // 1000
    silent = 10.0 ** (SILENT_EDGE_DB / 20.0)
    if np.abs(x[-ms:]).max() > silent:
        k = min(int(round(FADE_OUT_MS * ms)), n // 2)
        if envelope_peak_index(x) >= n - k:
            # the loudest part is where the fade would go: the recording stays as it is and a
            # short tail runs from its last sample down to zero after it
            kt = int(round(TAIL_MS * ms))
            x = np.concatenate([x, _tail_out(x[-1], kt)], axis=0)
            info["appendedTailMs"] = round(1000.0 * kt / DOWNLOAD_SR, 3)
        else:
            x[n - k:] *= _fade_curve(k)[::-1][:, None]
            info["fadeOutMs"] = round(1000.0 * k / DOWNLOAD_SR, 3)   # what was applied: n // 2 of a short file
    if np.abs(x[0]).max() > silent:
        k = int(round(LEAD_IN_MS * ms))
        x = np.concatenate([_lead_in(x[0], k), x], axis=0)
        info["leadInMs"] = LEAD_IN_MS
    return x


def process_download(data: np.ndarray, sr: int, kind: str, category: str,
                     excerpt: tuple[float, float] | None = None) -> tuple[np.ndarray, dict]:
    """Turn a decoded download into the file that is shipped: arrays in, array out.

    data is (n, channels) or (n,). Steps: prepare_download (cut, channels, clipping count, 48 kHz),
    then the ends, then the level.
      one-shot: the recording itself is never multiplied at its start, so no attack is lost. Where
        the first SAMPLE is above -60 dBFS (a real step) a lead-in of LEAD_IN_MS is put in front: a
        raised cosine from zero to that sample (per channel), then the file as it is. Where the last
        millisecond is not silent the last FADE_OUT_MS are faded out (raised cosine).
      loop: the tail is crossfaded into the head (see _loop_crossfade), and where the level of its
        first and last 50 ms still differ the start is moved to a better wrap point (_loop_roll);
        no lead-in, no fade-out.
    Then the level is set (set_level) and info["level"] states the gain that was applied
    (gainDb) and the gain that was asked for (requestedGainDb), which differs where the ceiling
    limited it. Nothing here is random, so the same input gives the same output."""
    from synth import set_level

    x, info = prepare_download(data, sr, excerpt)
    info["fadeInMs"] = info["fadeOutMs"] = info["leadInMs"] = info["loopCrossfadeMs"] = info["appendedTailMs"] = 0.0
    if kind == "oneshot":
        x = repair_oneshot_ends(x, info)
    elif kind == "loop":
        x, k = _loop_crossfade(x, info)
        info["loopCrossfadeMs"] = round(1000.0 * k / DOWNLOAD_SR, 3)
        if k:
            x, r = _loop_roll(x)
            info["loopStartMs"] = round(1000.0 * r / DOWNLOAD_SR, 3)
    mode, value = download_target(category, kind, x.shape[0] / DOWNLOAD_SR)
    before = float(np.abs(x).max())
    y, level = set_level(x, mode, value, ceiling_db=DOWNLOAD_CEILING_DB)
    # set_level states the gain that was applied (gainDb) and the one that was asked for
    # (requestedGainDb); where the ceiling cut it back the applied one is smaller. Here the applied
    # gain is also read back from the samples, which is what the manifest must state
    after = float(np.abs(y).max())
    if level["limited"] and before > 0 and after > 0:
        level["gainDb"] = round(float(20.0 * np.log10(after / before)), 2)
    info["level"] = level
    return y, info


def _excerpt_downloads(out: Path, measure_mod, common) -> list[dict]:
    """Downloaded files chosen in assets/audio/selection.json (a list, or {"selected": [...]}, of
    {id, category, file, licence, en, de, intent, kind, excerpt}; file is relative to
    assets/audio/downloads; excerpt is [start, end] seconds or {start, end}). Every one is written
    as a processed copy <out>/downloads/<id>.wav (see process_download) with a spectrogram, and
    the manifest entry points to that copy. A download missing on disk is reported and skipped."""
    from synth import write_wav

    if not SELECTION.is_file():
        return []
    raw = json.loads(SELECTION.read_text(encoding="utf-8"))
    items = raw if isinstance(raw, list) else raw.get("selected", raw.get("sounds", []))
    folder = out / "downloads"
    entries = []
    for it in items:
        try:
            src = DOWNLOADS / it["file"]
            if not src.is_file():
                print("  download missing on disk: %s" % it["file"])
                continue
            ex = it.get("excerpt")
            sid = it.get("id") or Path(it["file"]).stem
            kind = it.get("kind", "oneshot")
            category = it.get("category", "downloads")
            if ex:
                ex = (ex["start"], ex["end"]) if isinstance(ex, dict) else (ex[0], ex[1])
            data, sr = common.load_audio(src)
            y, info = process_download(data, sr, kind, category, ex or None)
            wav = folder / (sid + ".wav")
            write_wav(wav, y, dither_seed="download/" + sid)
            back, back_sr = common.load_audio(wav)
            an = measure_mod.analyse(back, back_sr, loop=kind == "loop")
            failed = []
            if info["sourceClipped"]:
                failed.append("source-clipped")
            if kind == "loop" and not an.get("loop", {}).get("pass", True):
                failed.append("loop-seam")
            if kind == "loop" and abs(info.get("loopZone", {}).get("vsSourcesDb", 0.0)) > LOOP_ZONE_MAX_DB:
                failed.append("loop-crossfade-level")
            png = wav.with_suffix(".png")
            measure_mod.write_png(png, sid, back, back_sr, an)
            checks = {
                "pass": not failed, "failed": failed, "sourceClipped": info["sourceClipped"],
                "peakDb": an["truePeakDb"], "lufs": an["lufs"],
                "lowShare": an["lowShare"], "highShare": an["highShare"],
                "centroidHz": an["spectralCentroidHz"], "level": info["level"],
                "fadeInMs": info["fadeInMs"], "fadeOutMs": info["fadeOutMs"],
                "leadInMs": info["leadInMs"], "loopCrossfadeMs": info["loopCrossfadeMs"],
                "loopStartMs": info.get("loopStartMs", 0.0), "appendedTailMs": info["appendedTailMs"],
            }
            for key in ("loopShiftMs", "loopCorrelation", "loopLaw", "loopZone"):
                if key in info:
                    checks[key] = info[key]
            if "loop" in an:
                checks["loop"] = {k: an["loop"].get(k) for k in ("seamRatio", "levelSwingDb", "edgeLevelDiffDb", "pass")}
            entries.append({
                "id": sid, "file": "downloads/%s.wav" % sid, "spectrogram": "downloads/%s.png" % sid,
                "category": category, "kind": kind,
                "path": it.get("path", "structure"), "en": it.get("en", sid), "de": it.get("de", sid),
                "intent": it.get("intent", ""), "source": "download", "licence": it.get("licence", "unknown"),
                "duration": round(back.shape[0] / back_sr, 4), "channels": int(back.shape[1]), "gain": 1.0,
                "dry": True, "hash": file_hash(wav), "checks": checks,
            })
        except Exception as e:
            print("  selection entry skipped (%s): %s" % (type(e).__name__, e))
    # processed copies of downloads that are no longer selected must not stay behind
    keep = {e["id"] for e in entries}
    for old in sorted(folder.glob("*")) if folder.is_dir() else []:
        if old.suffix in (".wav", ".png", ".json") and old.stem not in keep:
            old.unlink()
    return entries


GENERATED_LIST_KEYS = ("id", "standsFor", "file", "sha256", "cut", "lufs", "en", "de", "origin", "licence")
GENERATED_ORIGIN_KEYS = ("model", "prompt", "seed", "round", "candidate", "verdict", "ratedAt")
GENERATED_DERIVED_KEYS = ("parentFile", "parentSha256", "parentRound", "parentCandidate", "parentVerdict", "process", "operations")
LEVEL_TOLERANCE_LU = 0.1    # a generated sound must land this close to its target loudness (unless the ceiling stops it)
LEVEL_SEARCH_LU = 0.01      # the search for the gain goes on until the measured loudness is this close


def set_loudness(x: np.ndarray, target: float, ceiling_db: float = DOWNLOAD_CEILING_DB,
                 max_iter: int = 8) -> tuple[np.ndarray, dict]:
    """Scale x (n, ch) so that its integrated loudness, measured after the gain, is the target in
    LUFS. One gain from the measurement of x is not enough for a quiet sound: when the sound is
    made quieter, 400 ms blocks fall under the absolute gate of BS.1770 and the loudness moves. So
    the loudness of the scaled signal is measured again and the gain corrected until it is within
    LEVEL_SEARCH_LU. Where the true peak would pass ceiling_db the gain is cut back to the ceiling
    and info["limited"] is True. info: target, reached (measured on y), gainDb (applied),
    requestedGainDb (the one that would have met the target), truePeakDb, limited, iterations."""
    from synth.levels import lufs, true_peak_db

    x = np.asarray(x, dtype=np.float64)
    gain = target - lufs(x)
    y, limited, tp, n = x, False, 0.0, 0
    for n in range(1, max_iter + 1):
        y = x * 10.0 ** (gain / 20.0)
        tp = true_peak_db(y)
        if tp > ceiling_db:
            limited = True
            break
        err = target - lufs(y)
        if abs(err) <= LEVEL_SEARCH_LU:
            break
        gain += err
    requested = gain
    if limited:
        gain -= tp - ceiling_db
        y = x * 10.0 ** (gain / 20.0)
        tp = true_peak_db(y)
    return y, {"mode": "lufs", "target": float(target), "reached": round(float(lufs(y)), 2),
               "gainDb": round(float(gain), 2), "requestedGainDb": round(float(requested), 2),
               "truePeakDb": round(float(tp), 2), "limited": bool(limited), "iterations": n}


# From this round of the owner's listening tests on, a generated sound is built the way the page copy he rated was made
# (tools/sound/screen.py _finish): the library file is that copy times one gain. Earlier rounds keep the repair of the ends
# that is shared with downloads, so that the files built before do not change.
PAGE_FINISH_FROM_ROUND = 7
PAGE_STEP_DB = -72.0         # the page's rule: a sample above this at an end is a step (the page's static rule is -60 dBFS)
PAGE_FADE_S = 0.030          # fade out (raised cosine) where the last PAGE_TAIL_S are not silent
PAGE_TAIL_S = 0.010          # the last 10 ms the page checks; after a fade this much digital silence follows it
PAGE_RAMP_S = 0.0015         # ramp in from zero to the first sample where that sample is a step
PAGE_DC_LIMIT = 0.001        # the page fails a file whose mean is this or more: from half of it the mean is taken out


def rated_from_page_copy(origin: dict) -> bool:
    """True where the owner rated the candidate from a page copy that was finished like page_finish (round PAGE_FINISH_FROM_ROUND on)."""
    r = origin.get("round")
    return isinstance(r, int) and not isinstance(r, bool) and r >= PAGE_FINISH_FROM_ROUND


def page_finish(y: np.ndarray) -> tuple[np.ndarray, dict]:
    """The steps of tools/sound/screen.py _finish after its gain, in its order, on y (n, ch) at 48 kHz that is already at its level
    (the decisions below are made on the level that ships): where the last PAGE_TAIL_S are above PAGE_STEP_DB the last PAGE_FADE_S
    are faded out and PAGE_TAIL_S of silence follow; where the first sample is above PAGE_STEP_DB a ramp of PAGE_RAMP_S from zero is put
    in front; where the mean is PAGE_DC_LIMIT / 2 or more it is taken out with a window that is 1 in the middle and tapers over the
    first PAGE_RAMP_S and the last 5 ms (the silence at the end is left as it is). Every step is linear in y. y is not changed.
    Returns (copy, {"fade", "ramp", "dcBefore", "dcAfter", "tailPeak", "firstPeak"}: what decided the first three)."""
    y = np.array(y, dtype=np.float64)
    thr = 10.0 ** (PAGE_STEP_DB / 20.0)
    tail = int(round(PAGE_TAIL_S * DOWNLOAD_SR))
    tail_peak = float(np.abs(y[-tail:]).max())
    fade = bool(tail_peak > thr)
    if fade:
        m = min(int(round(PAGE_FADE_S * DOWNLOAD_SR)), y.shape[0])
        y[-m:] *= (0.5 + 0.5 * np.cos(np.pi * (np.arange(m) + 1) / m))[:, None]
        y = np.concatenate([y, np.zeros((tail, y.shape[1]))], axis=0)
    first_peak = float(np.abs(y[0]).max())
    ramp = bool(first_peak > thr)
    if ramp:
        n = int(round(PAGE_RAMP_S * DOWNLOAD_SR))
        r = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
        y = np.concatenate([y[0][None, :] * r[:, None], y], axis=0)
    dc_before = float(np.abs(y.mean(axis=0)).max())
    if dc_before >= PAGE_DC_LIMIT / 2:
        n = y.shape[0] - tail
        a_, b_ = min(int(round(PAGE_RAMP_S * DOWNLOAD_SR)), n // 4), min(int(round(0.005 * DOWNLOAD_SR)), n // 4)
        w = np.ones(n)
        w[:a_] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a_) / max(a_, 1))
        w[n - b_:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(b_) / max(b_, 1))
        corr = np.zeros_like(y)
        corr[:n] = (y.mean(axis=0, keepdims=True) * (y.shape[0] / float(w.sum()))) * w[:, None]
        y = y - corr
    return y, {"fade": fade, "ramp": ramp, "dcBefore": dc_before, "dcAfter": float(np.abs(y.mean(axis=0)).max()),
               "tailPeak": tail_peak, "firstPeak": first_peak}


def process_generated(data: np.ndarray, sr: int, cut: tuple[float, float], lufs_target: float,
                      page_copy: bool = False) -> tuple[np.ndarray, dict]:
    """Turn the raw file of a generated sound into the file that is shipped: arrays in, array out.
    Cut as recorded (seconds, to the nearest sample), 48 kHz (prepare_download), the ends of a one-shot made without a step
    (repair_oneshot_ends, the same as for a download), then the integrated loudness set to
    lufs_target (set_loudness) within the true-peak ceiling of the download step. Nothing here is
    random, so the same input gives the same output.
    page_copy (the sound was rated from a page copy, see rated_from_page_copy): instead of repair_oneshot_ends the
    steps of page_finish, which the page copy went through, then the loudness. The level is set once on the cut, the
    steps of page_finish are decided on that level, and the loudness is set again on what they made, so that
    the result is the page copy times one gain (fade, ramp and mean removal are linear)."""
    # the recorded seconds are sample positions: the nearest sample, not the one below
    # (int(0.006 * 48000) is 287 because of the binary fraction; the position is 288). A position written with four decimals
    # is a sample only to within 2.4 samples at 48 kHz: the cut of a page_copy sound is written with enough decimals for its sample.
    first, last = int(round(cut[0] * sr)), int(round(cut[1] * sr))
    x, info = prepare_download(np.asarray(data)[first:last], sr)
    info["fadeInMs"] = info["fadeOutMs"] = info["leadInMs"] = info["appendedTailMs"] = 0.0
    if page_copy:
        leveled, _ = set_loudness(x, lufs_target)
        x, fin = page_finish(leveled)
        info["fadeOutMs"] = round(1000.0 * PAGE_FADE_S, 3) if fin["fade"] else 0.0
        info["leadInMs"] = round(1000.0 * PAGE_RAMP_S, 3) if fin["ramp"] else 0.0
        info["pageFinish"] = fin
    else:
        x = repair_oneshot_ends(x, info)
    y, info["level"] = set_loudness(x, lufs_target)
    return y, info


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _derived_problem(d) -> str | None:
    """The optional object "derived" of a generated entry (a sound made by tools/sound/derive.py from the committed raw file
    of a parent): parentFile (a plain .wav file name next to the raw files), parentSha256, parentRound (an integer),
    parentCandidate and parentVerdict (text), process (the list of operations, each with its "op") and operations (what each
    one reported, one per operation, in the same order). Returns a message or None."""
    if not isinstance(d, dict):
        return "derived is not an object"
    for k in GENERATED_DERIVED_KEYS:
        if k not in d:
            return "no derived.%s" % k
    f = d["parentFile"]
    if not isinstance(f, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\.wav", f):
        return "derived.parentFile is not a plain file name"
    if not isinstance(d["parentSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", d["parentSha256"]):
        return "derived.parentSha256 is not a sha256"
    if not isinstance(d["parentRound"], int) or isinstance(d["parentRound"], bool):
        return "derived.parentRound is not an integer"
    for k in ("parentCandidate", "parentVerdict"):
        if not isinstance(d[k], str) or not d[k]:
            return "derived.%s is not text" % k
    for k in ("process", "operations"):
        v = d[k]
        if not isinstance(v, list) or not v or not all(isinstance(o, dict) and isinstance(o.get("op"), str) for o in v):
            return "derived.%s is not a list of operations" % k
    if [o["op"] for o in d["process"]] != [o["op"] for o in d["operations"]]:
        return "derived.operations does not follow derived.process"
    return None


def _generated_entry_problem(it: dict) -> str | None:
    for k in GENERATED_LIST_KEYS:
        if k not in it:
            return "no %s" % k
    for k in GENERATED_ORIGIN_KEYS:
        if k not in it["origin"]:
            return "no origin.%s" % k
    for k in ("startS", "endS"):
        if k not in it["cut"]:
            return "no cut.%s" % k
    if not it["cut"]["endS"] > it["cut"]["startS"] >= 0:
        return "the cut is empty"
    if "derived" in it:
        why = _derived_problem(it["derived"])
        if why:
            return why
    return None


def _generated_sounds(out: Path, measure_mod, common, listing: Path | None = None,
                      raw_dir: Path | None = None, problems: list | None = None) -> list[dict]:
    """Generated sounds listed in assets/audio/generated.json ({"note", "sounds": [...]}; see the
    README of tools/audio). The raw file of every entry (assets/audio/generated/<file>) is
    committed, because a run of the model is not reproducible bit for bit. Every entry is written
    as a processed copy <out>/generated/<id>.wav with a spectrogram (see process_generated), and
    the manifest entry points to that copy. An entry whose raw file does not match its sha256 is
    refused with a message: the sound is never built from another file. A raw file missing on disk
    is reported and skipped, like a missing download. Processed copies that are no longer in the
    list are removed; so is the copy of an entry of the list "withdrawn", which is otherwise ignored. Category, kind, path and place are those of the event the sound stands for
    (sounds.json). listing and raw_dir default to GENERATED_LIST and GENERATED_DIR.

    problems, when a list is given, receives one line for every entry that was not built: refused
    (every reason), missing raw file, or failed with an exception. The messages are printed as ever;
    main counts the lines and returns a non-zero exit code, the other entries are still built."""
    from synth import write_wav

    def problem(text: str) -> None:
        print(text)
        if problems is not None:
            problems.append(text.strip())

    listing = Path(listing) if listing is not None else GENERATED_LIST
    raw_dir = Path(raw_dir) if raw_dir is not None else GENERATED_DIR
    if not listing.is_file():
        return []
    raw = json.loads(listing.read_text(encoding="utf-8"))
    items = raw if isinstance(raw, list) else raw.get("sounds", [])
    # "withdrawn": sounds that were built once and the owner then rejected. They are not built, not in
    # the manifest, and their processed copy goes like any copy no longer in the list; the raw file stays
    # in the raw folder and nothing reports it. An id in both lists is a mistake of the list: the entry
    # of "sounds" is refused, so that a withdrawn sound is never built by accident.
    withdrawn_ids = set()
    if isinstance(raw, dict):
        for w in raw.get("withdrawn", []):
            if isinstance(w, dict) and isinstance(w.get("id"), str):
                withdrawn_ids.add(w["id"])
    spec = synth.load_spec()
    folder = out / "generated"
    entries = []
    seen = set()
    for it in items:
        sid = it.get("id", "?") if isinstance(it, dict) else "?"
        try:
            if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
                # the id is the name of a file under <out>/generated: no path may get into it
                problem("  generated entry %r refused: the id is not a plain name (letters, digits, _ and -)" % (sid,))
                continue
            if sid in seen:
                problem("  generated entry %s refused: the id is listed twice; the first one stays" % sid)
                continue
            seen.add(sid)
            if sid in withdrawn_ids:
                problem("  generated entry %s refused: it is also listed as withdrawn" % sid)
                continue
            why = _generated_entry_problem(it)
            if why:
                problem("  generated entry %s refused: %s" % (sid, why))
                continue
            event = spec["sounds"].get(it["standsFor"])
            if event is None:
                problem("  generated entry %s refused: it stands for %r, which sounds.json does not know" % (sid, it["standsFor"]))
                continue
            src = raw_dir / it["file"]
            if not src.is_file():
                problem("  generated raw file missing on disk: %s" % it["file"])
                continue
            have = _sha256(src)
            if have != it["sha256"]:
                problem("  generated entry %s refused: the sha256 of %s is %s, the list says %s; "
                        "a sound is never built from another file" % (sid, it["file"], have, it["sha256"]))
                continue
            if "derived" in it:
                # the parent file is committed next to the raw files; the sound is built from its own raw file, never from the parent,
                # but the record of how it was made must name a parent that is there and unchanged
                d = it["derived"]
                parent = raw_dir / d["parentFile"]
                if not parent.is_file():
                    problem("  generated entry %s refused: the parent file %s is missing on disk" % (sid, d["parentFile"]))
                    continue
                have_parent = _sha256(parent)
                if have_parent != d["parentSha256"]:
                    problem("  generated entry %s refused: the sha256 of the parent file %s is %s, the list says %s; "
                            "a sound is never recorded as made from another file" % (sid, d["parentFile"], have_parent, d["parentSha256"]))
                    continue
            cut = (float(it["cut"]["startS"]), float(it["cut"]["endS"]))
            data, sr = common.load_audio(src)
            y, info = process_generated(data, sr, cut, float(it["lufs"]), page_copy=rated_from_page_copy(it["origin"]))
            wav = folder / (sid + ".wav")
            write_wav(wav, y, dither_seed="generated/" + sid)
            back, back_sr = common.load_audio(wav)
            an = measure_mod.analyse(back, back_sr, loop=False)
            lv = dict(info["level"])
            lv["reached"] = an["lufs"]          # what the shipped file measures, 16 bit and all
            lv["error"] = None if an["lufs"] is None else round(an["lufs"] - lv["target"], 2)
            failed, hints = [], []
            if lv["error"] is None or (not lv["limited"] and abs(lv["error"]) > LEVEL_TOLERANCE_LU):
                failed.append("level-missed")
            if lv["limited"]:
                hints.append("level-limited-by-ceiling")
            if info["sourceClipped"]:
                hints.append("source-clipped")  # the owner heard and accepted it: a hint, not a failure
            png = wav.with_suffix(".png")
            measure_mod.write_png(png, sid, back, back_sr, an)
            checks = {
                "pass": not failed, "failed": failed, "hints": hints, "sourceClipped": info["sourceClipped"],
                "peakDb": an["truePeakDb"], "lufs": an["lufs"],
                "lowShare": an["lowShare"], "highShare": an["highShare"],
                "centroidHz": an["spectralCentroidHz"], "level": lv,
                "fadeInMs": info["fadeInMs"], "fadeOutMs": info["fadeOutMs"],
                "leadInMs": info["leadInMs"], "appendedTailMs": info["appendedTailMs"],
            }
            o = it["origin"]
            entries.append({
                "id": sid, "file": "generated/%s.wav" % sid, "spectrogram": "generated/%s.png" % sid,
                "category": event["category"], "kind": event["kind"], "path": event["path"],
                **({"place": event["place"]} if "place" in event else {}),
                "en": it["en"], "de": it["de"], "intent": it.get("intent") or generated_intent(it, event, int(back.shape[1])),
                "source": "generated", "licence": it["licence"],
                "duration": round(back.shape[0] / back_sr, 4), "channels": int(back.shape[1]), "gain": 1.0,
                "dry": False, "hash": file_hash(wav), "checks": checks,
                "generated": {
                    "standsFor": it["standsFor"], "model": o["model"], "prompt": o["prompt"], "seed": o["seed"],
                    "round": o["round"], "candidate": o["candidate"], "sha256": it["sha256"],
                    "modelRevision": o.get("modelRevision"), "codeCommit": o.get("codeCommit"),
                    "verdict": o["verdict"], "ratedAt": o["ratedAt"], "cut": it["cut"], "rawFile": it["file"],
                    **({"derived": it["derived"]} if "derived" in it else {}),
                },
            })
        except Exception as e:
            problem("  generated entry %s skipped (%s): %s" % (sid, type(e).__name__, e))
    keep = {e["id"] for e in entries}
    for old in sorted(folder.glob("*")) if folder.is_dir() else []:
        if old.suffix in (".wav", ".png", ".json") and old.stem not in keep:
            old.unlink()
    return entries


def _say_operation(p: dict, o: dict) -> str:
    """One operation of a derived sound in words, built from the data of the entry: its name, the settings of the list
    (derived.process) and what it reported (derived.operations), nothing from a table of the code."""
    parts = ["%s %s" % (k, str(v)) for k, v in p.items() if k != "op"]
    for k, v in o.items():
        if k == "op" or k in p:
            continue
        if isinstance(v, dict):
            v = "(" + ", ".join("%s %s" % (kk, str(vv)) for kk, vv in v.items()) + ")"
        parts.append("%s %s" % (k, str(v)))
    return "%s (%s)" % (p["op"], ", ".join(parts))


def generated_intent(it: dict, event: dict, channels: int = 1) -> str:
    """The intent text of a generated sound: prompt, seed, round, who accepted it and when, which
    event it stands for and the level rule. A derived sound (the entry has "derived") says that it was
    made from the parent candidate and by which operations with the numbers they reported; its prompt and
    seed are those of the parent. channels is that of the built file: the level sentence says the lufs is the loudness
    of the rendered event (one channel) only for one channel; a file with two channels is set higher than that, because
    the audition page takes about 3 dB off a two-channel file (see README, round 7)."""
    o = it["origin"]
    d = it.get("derived")
    if d is None:
        head = "Generated with %s. Prompt: \"%s\" (seed %s, round %s, candidate %s). " % (
            o["model"], o["prompt"], o["seed"], o["round"], o["candidate"])
    else:
        ops = "; ".join(_say_operation(p, q) for p, q in zip(d["process"], d["operations"]))
        head = ("Made from a file generated with %s: the parent file %s (sha256 %s), the candidate %s of round %s, which the owner called %s. "
                "Prompt of the parent: \"%s\" (seed %s). Operations on the parent, in this order, with the numbers they reported: %s. "
                "This sound is the candidate %s of round %s; the build does not run the operations again, it starts from the committed raw file of this sound. " % (
                    o["model"], d["parentFile"], d["parentSha256"], d["parentCandidate"], d["parentRound"], d["parentVerdict"],
                    o["prompt"], o["seed"], ops, o["candidate"], o["round"]))
    # rounds 4 to 6 were heard at -34 or -35 LUFS, under the library level; from round 7 on the candidates were heard at about the library level
    lower = isinstance(o["round"], int) and not isinstance(o["round"], bool) and o["round"] < PAGE_FINISH_FROM_ROUND
    if channels == 2:
        level = ("Level: the integrated loudness is set to %.2f LUFS. The rendered event has one channel, and the audition page plays a "
                 "file with two channels about 3 dB lower than a one-channel file of the same loudness; this file keeps that relation, so "
                 "its loudness is about 3 dB above that of the rendered event today; provisional until the mix of the game is designed. " % float(it["lufs"]))
    else:
        level = ("Level: the integrated loudness is set to %.2f LUFS, the loudness of that rendered event today; "
                 "provisional until the mix of the game is designed. " % float(it["lufs"]))
    return (head + "The owner heard it and accepted it (verdict %s) on %s. It stands for the event %s (%s). %s%s" % (
                o["verdict"], o["ratedAt"], it["standsFor"], event.get("en", it["standsFor"]), level,
                "The owner heard the candidate at a lower level." if lower else
                "The level is close to the one the owner heard the candidate at (tools/audio/README.md gives both)."))


def assemble_manifest(out: Path, measure_mod, common, problems: list | None = None) -> dict:
    """Assemble manifest.json from the small JSON files of out. problems, when a list is given,
    receives a line for every generated entry that was refused, missing or failed (see _generated_sounds)."""
    spec = synth.load_spec()
    order = {sid: i for i, sid in enumerate(spec["order"])}
    sounds = []
    for p in sorted(out.glob("*/*.json")):
        if p.parent.name in ("downloads", "generated"):  # added from selection.json and generated.json below
            continue
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(rec, dict) and "manifest" in rec and (p.with_suffix(".wav")).is_file():
            m = rec["manifest"]
            # a JSON written by an older build lacks what the contract added later: fill it from
            # the file and from sounds.json, so that a partial rebuild still gives a valid manifest
            if "hash" not in m:
                m["hash"] = file_hash(p.with_suffix(".wav"))
            for k in ("place", "cue"):
                if k not in m and k in spec["sounds"].get(m["id"], {}):
                    m[k] = spec["sounds"][m["id"]][k]
            sounds.append(m)
    sounds.sort(key=lambda e: order.get(e["id"], 10_000))
    sounds += _generated_sounds(out, measure_mod, common, problems=problems)
    sounds += _excerpt_downloads(out, measure_mod, common)
    used = {s["category"] for s in sounds}
    cats = [{"id": c["id"], "en": c["en"], "de": c["de"]} for c in spec["categories"].values() if c["id"] in used]
    for cid in sorted(used - set(spec["categories"])):
        cats.append({"id": cid, "en": cid.capitalize(), "de": cid.capitalize()})
    manifest = {"version": 1, "categories": cats, "sounds": sounds}
    _atomic_write(out / "manifest.json", json.dumps(manifest, indent=1, ensure_ascii=False))
    return manifest


REQUIRED = ("id", "file", "spectrogram", "category", "kind", "path", "en", "de", "intent", "source",
            "licence", "duration", "channels", "gain", "dry", "hash", "checks")


def validate_manifest(manifest: dict, out: Path) -> list[str]:
    """Check the manifest against the contract of SOUND_DESIGN.md section 3. Returns problems."""
    bad = []
    if manifest.get("version") != 1:
        bad.append("version is not 1")
    cats = {c["id"] for c in manifest.get("categories", [])}
    seen = set()
    for s in manifest.get("sounds", []):
        name = s.get("id", "?")
        for k in REQUIRED:
            if k not in s:
                bad.append("%s: missing %s" % (name, k))
        if name in seen:
            bad.append("%s: listed twice" % name)
        seen.add(name)
        if s.get("category") not in cats:
            bad.append("%s: category %r not listed" % (name, s.get("category")))
        if s.get("kind") not in ("loop", "oneshot", "ir"):
            bad.append("%s: kind %r" % (name, s.get("kind")))
        if s.get("source") not in ("synth", "download", "generated"):
            bad.append("%s: source %r" % (name, s.get("source")))
        if s.get("file") and not (out / s["file"]).is_file():
            bad.append("%s: file %s not found" % (name, s["file"]))
        if s.get("spectrogram") and not (out / s["spectrogram"]).is_file():
            bad.append("%s: spectrogram not found" % name)
        if s.get("source") in ("download", "generated") and not s.get("spectrogram"):
            bad.append("%s: %s without a spectrogram" % (name, s["source"]))
        if s.get("hash") and not (isinstance(s["hash"], str) and len(s["hash"]) == 12):
            bad.append("%s: hash is not twelve hex digits" % name)
        c = s.get("checks", {})
        required = ("pass", "failed", "peakDb", "lufs", "lowShare", "highShare")
        if s.get("source") in ("download", "generated"):  # a processed copy is measured like a rendered sound
            required += ("centroidHz", "sourceClipped")
        for k in required:
            if k not in c:
                bad.append("%s: checks.%s missing" % (name, k))
        if s.get("source") == "generated":
            if not s.get("licence"):
                bad.append("%s: generated without a licence" % name)
            g = s.get("generated")
            if not isinstance(g, dict):
                bad.append("%s: generated sound without the generated record" % name)
            else:
                for k in ("standsFor", "model", "prompt", "seed", "round", "candidate", "sha256"):
                    if g.get(k) in (None, ""):
                        bad.append("%s: generated.%s missing" % (name, k))
                if "derived" in g:
                    why = _derived_problem(g["derived"])
                    if why:
                        bad.append("%s: generated.%s" % (name, why))
        if s.get("source") in ("download", "generated"):
            if not s.get("duration"):
                bad.append("%s: duration is 0" % name)
            if c.get("peakDb") is not None and c["peakDb"] > -1.0:
                bad.append("%s: true peak %.2f dB is above -1" % (name, c["peakDb"]))
    return bad


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma separated sound ids")
    ap.add_argument("--category", help="build only this category")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output folder (default assets/audio/render)")
    ap.add_argument("--no-clap", action="store_true", help="skip the CLAP comparison")
    ap.add_argument("--describe", action="store_true", help="also run the describing model if the tool exists")
    ap.add_argument("--manifest-only", action="store_true", help="only reassemble manifest.json")
    args = ap.parse_args(argv)
    out = Path(args.out).resolve()

    import common  # listen/common.py
    import measure  # listen/measure.py

    errors = synth.load_categories()
    for e in errors:
        print("category import failed: " + e)
    spec = synth.load_spec()
    wanted = [i for i in spec["order"]
              if (not args.only or i in args.only.split(","))
              and (not args.category or spec["sounds"][i]["category"] == args.category)]
    if args.only:
        for i in args.only.split(","):
            if i not in spec["sounds"]:
                print("unknown sound id: %s" % i)
                return 2

    failures = 0
    if not args.manifest_only:
        todo = [i for i in wanted if i in synth.REGISTRY]
        missing = [i for i in wanted if i not in synth.REGISTRY]
        clap = None
        if todo and not args.no_clap:
            try:
                from compare import Clap

                clap = Clap()
            except Exception as e:
                print("CLAP not available (%s: %s); continuing without it" % (type(e).__name__, e))
        describe_fn = None
        if args.describe and todo:
            try:
                from describe import Describer

                describer = Describer()  # loaded once per run

                def describe_fn(wav):
                    d, sr = common.load_audio(wav)
                    return describer.ask(common.to_mono(d), sr, "What is this sound?")
            except BaseException as e:  # the model may not fit or may be missing: not a build failure
                print("describing model not available (%s: %s); continuing without it" % (type(e).__name__, e))
                describe_fn = None
        t0 = time.time()
        for sid in todo:
            try:
                e = build_sound(sid, out, clap, describe_fn, measure, common)
            except Exception:
                failures += 1
                print("%-24s ERROR" % sid)
                traceback.print_exc()
                continue
            c = e["checks"]
            clap_txt = "clap %+.3f" % c["clap"]["margin"] if c.get("clap") and c["clap"].get("margin") is not None else "clap -"
            verdict = "pass" if c["pass"] else "FAIL " + ",".join(c["failed"])
            if c.get("hints"):
                verdict += " (hint: %s)" % ",".join(c["hints"])
            verdict += " mid %.2f sub %.2f" % (c["midShare"], c["subShare"])
            lf = "  limited" if c["level"]["limited"] else ""
            print("%-24s %-34s %s  %6.1f LUFS  tp %5.1f dB%s" % (
                sid, verdict, clap_txt, c["lufs"] if c["lufs"] is not None else float("nan"), c["peakDb"], lf))
            failures += 0 if c["pass"] else 1
        if missing:
            print("missing (no renderer yet): %d sounds" % len(missing))
            _atomic_write(out / "missing.json", json.dumps(missing, indent=1))
        print("rendered %d in %.1f s" % (len(todo), time.time() - t0))
    generated_problems: list[str] = []
    manifest = assemble_manifest(out, measure, common, problems=generated_problems)
    if generated_problems:
        print("generated sounds not built: %d (they are listed above)" % len(generated_problems))
    failures += len(generated_problems)
    print("manifest: %d sounds in %s" % (len(manifest["sounds"]), out / "manifest.json"))
    problems = validate_manifest(manifest, out)
    for p in problems:
        print("manifest problem: " + p)
    print("manifest validates against the contract" if not problems else "manifest has %d problems" % len(problems))
    failures += len(problems)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
