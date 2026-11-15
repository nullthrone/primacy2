"""Render the registered sounds, measure them, check them against SOUND_DESIGN.md and write the manifest.

    .venv-audio/Scripts/python.exe tools/audio/build.py [--only id,id] [--category name]
        [--out DIR] [--no-clap] [--describe] [--manifest-only]

For every sound: <out>/<category>/<id>.wav, a spectrogram <id>.png and a small <id>.json with the
measurements and the result of every rule. The manifest is assembled from all the small JSON
files in <out>, so several people can build their own categories into one folder.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
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
    failed = rules.check(s, data, an, entry.swing_max, sound_id=sound_id)
    hints: list[str] = []
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
LOOP_XFADE_S = 0.3          # loop seam: crossfade of the tail into the head, at most this long ...
LOOP_XFADE_SHARE = 0.1      # ... and at most this share of the file
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


def _loop_crossfade(x: np.ndarray) -> tuple[np.ndarray, int]:
    """Make x wrap without a step: the last k samples are mixed into the first k with equal power
    (cos / sin) and cut off, so the result is k samples shorter. Its first sample is the sample
    that followed its last one in the recording. Returns (y, k); k is 0 where the file is too
    short for a crossfade."""
    n = x.shape[0]
    k = min(int(round(LOOP_XFADE_S * DOWNLOAD_SR)), int(n * LOOP_XFADE_SHARE))
    if k < 2:
        return x, 0
    t = np.arange(k) / k
    fin = np.sin(0.5 * np.pi * t)[:, None]
    fout = np.cos(0.5 * np.pi * t)[:, None]
    y = x[: n - k].copy()
    y[:k] = x[:k] * fin + x[n - k:] * fout
    return y, k


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


def process_download(data: np.ndarray, sr: int, kind: str, category: str,
                     excerpt: tuple[float, float] | None = None) -> tuple[np.ndarray, dict]:
    """Turn a decoded download into the file that is shipped: arrays in, array out.

    data is (n, channels) or (n,). Steps: prepare_download (cut, channels, clipping count, 48 kHz),
    then the ends, then the level.
      one-shot: the recording itself is never multiplied at its start, so no attack is lost. Where
        the first SAMPLE is above -60 dBFS (a real step) a lead-in of LEAD_IN_MS is put in front: a
        raised cosine from zero to that sample (per channel), then the file as it is. Where the last
        millisecond is not silent the last FADE_OUT_MS are faded out (raised cosine).
      loop: the tail is crossfaded into the head (see _loop_crossfade); no lead-in, no fade-out.
    Then the level is set (set_level) and info["level"] states the gain that was applied
    (gainDb) and the gain that was asked for (requestedGainDb), which differs where the ceiling
    limited it. Nothing here is random, so the same input gives the same output."""
    from synth import set_level

    x, info = prepare_download(data, sr, excerpt)
    info["fadeInMs"] = info["fadeOutMs"] = info["leadInMs"] = info["loopCrossfadeMs"] = 0.0
    if kind == "oneshot":
        n = x.shape[0]
        ms = DOWNLOAD_SR // 1000
        silent = 10.0 ** (SILENT_EDGE_DB / 20.0)
        if np.abs(x[-ms:]).max() > silent:
            k = min(int(round(FADE_OUT_MS * ms)), n // 2)
            x[n - k:] *= _fade_curve(k)[::-1][:, None]
            info["fadeOutMs"] = FADE_OUT_MS
        if np.abs(x[0]).max() > silent:
            k = int(round(LEAD_IN_MS * ms))
            x = np.concatenate([_lead_in(x[0], k), x], axis=0)
            info["leadInMs"] = LEAD_IN_MS
    elif kind == "loop":
        x, k = _loop_crossfade(x)
        info["loopCrossfadeMs"] = round(1000.0 * k / DOWNLOAD_SR, 3)
    mode, value = download_target(category, kind, x.shape[0] / DOWNLOAD_SR)
    before = float(np.abs(x).max())
    y, level = set_level(x, mode, value, ceiling_db=DOWNLOAD_CEILING_DB)
    # set_level reports the gain that was asked for; where the ceiling cut it back the gain that
    # was applied is smaller, and that is what the manifest must state
    level["requestedGainDb"] = level["gainDb"]
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
            png = wav.with_suffix(".png")
            measure_mod.write_png(png, sid, back, back_sr, an)
            checks = {
                "pass": not failed, "failed": failed, "sourceClipped": info["sourceClipped"],
                "peakDb": an["truePeakDb"], "lufs": an["lufs"],
                "lowShare": an["lowShare"], "highShare": an["highShare"],
                "centroidHz": an["spectralCentroidHz"], "level": info["level"],
                "fadeInMs": info["fadeInMs"], "fadeOutMs": info["fadeOutMs"],
                "leadInMs": info["leadInMs"], "loopCrossfadeMs": info["loopCrossfadeMs"],
            }
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


def assemble_manifest(out: Path, measure_mod, common) -> dict:
    spec = synth.load_spec()
    order = {sid: i for i, sid in enumerate(spec["order"])}
    sounds = []
    for p in sorted(out.glob("*/*.json")):
        if p.parent.name == "downloads":  # processed downloads are added from selection.json below
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
        if s.get("source") not in ("synth", "download"):
            bad.append("%s: source %r" % (name, s.get("source")))
        if s.get("file") and not (out / s["file"]).is_file():
            bad.append("%s: file %s not found" % (name, s["file"]))
        if s.get("spectrogram") and not (out / s["spectrogram"]).is_file():
            bad.append("%s: spectrogram not found" % name)
        if s.get("source") == "download" and not s.get("spectrogram"):
            bad.append("%s: download without a spectrogram" % name)
        if s.get("hash") and not (isinstance(s["hash"], str) and len(s["hash"]) == 12):
            bad.append("%s: hash is not twelve hex digits" % name)
        c = s.get("checks", {})
        required = ("pass", "failed", "peakDb", "lufs", "lowShare", "highShare")
        if s.get("source") == "download":  # a processed download is measured like a rendered sound
            required += ("centroidHz", "sourceClipped")
        for k in required:
            if k not in c:
                bad.append("%s: checks.%s missing" % (name, k))
        if s.get("source") == "download":
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
    manifest = assemble_manifest(out, measure, common)
    print("manifest: %d sounds in %s" % (len(manifest["sounds"]), out / "manifest.json"))
    problems = validate_manifest(manifest, out)
    for p in problems:
        print("manifest problem: " + p)
    print("manifest validates against the contract" if not problems else "manifest has %d problems" % len(problems))
    failures += len(problems)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
