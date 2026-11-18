#!/usr/bin/env python
"""Compare sound candidates by the measures the owner's ratings can be held against.

For every cut (a raw file and the cut the screening step made of it) it prints and returns:

  loud50Db        the loudest 50 ms, dB re full scale (screen.saturation_measures, raw cut, before any gain)
  above2kHzLoud   the share of energy above 2 kHz in the loud frames (screen.saturation_measures)
  above60Hz       the share of the cut's energy above 60 Hz (screen.energy_share_above)
  under250Hz      the share of the cut's energy under 250 Hz (1 - screen.energy_share_above(250 Hz))
  above4kHz       the share of the cut's energy above 4 kHz (screen.energy_share_above)
  centroidHz      the spectral centroid of the whole cut (power spectrum, rectangular window, all channels)
  crestDb         the peak over the root mean square of the cut, in dB (all channels)
  peakDb          the highest absolute sample of the cut, dB re full scale
  lengthS         the length of the cut in seconds
  activeS         from the start of the cut to the last 4 ms frame within 40 dB of the loudest frame (screen.level_env)
  tailDb          the level of the last 50 ms of the cut, dB under the loudest 50 ms (how the cut ends)
  lufs            the level the candidate was played at (the family target of its round, from the screen.json of that
                  round; a library file: the loudness recorded in assets/audio/generated.json)

The definitions of screen.py are imported, not written a second time; the measures above that screen.py does not have
(centroid, crest, peak, activeS, tailDb) are defined here and nowhere else.

Inputs:
  --kept FILE      a kept.json of assets/audio/gen/_kept/roundN (rounds 4, 5, 6): id, verdict, note, raw file and cut.
                   The raw file is taken from the path in the record when its SHA-256 is the one recorded, otherwise
                   from the kept copy beside kept.json (a record says which: rawFile, rawShaOk). The level comes from
                   the screen.json beside kept.json.
  --screen FILE    a screen.json of a round: every chosen candidate, measured on its raw cut (no verdict).
  --wav FILE[:START:END]   any wav, optionally a cut in seconds (a library file, a derived file).

  --event NAME     only this event (hull, thruster, gear, shield, fold jump, fold exit)
  --json FILE      write the rows as data (the table is printed anyway)

Reads only. Run with the environment of the sound library (.venv-audio).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import screen  # noqa: E402  (the definitions of the measures live there; never edited from here)

# the event a family belongs to: the grouping of the reference table
EVENT_OF_FAMILY = {
    "hull": "hull", "hull_light": "hull", "hull_heavy": "hull",
    "thruster": "thruster", "thruster_valve": "thruster", "thruster_bang": "thruster",
    "thruster_gatling": "thruster", "thruster_mighty": "thruster",
    "gear": "gear",
    "shield": "shield", "shield_bright": "shield", "shield_tight": "shield",
    "fold_jump": "fold jump", "fold_exit": "fold exit",
}
EVENT_ORDER = ["hull", "thruster", "gear", "shield", "fold jump", "fold exit"]
MEASURES = ["loud50Db", "above2kHzLoud", "above60Hz", "under250Hz", "above4kHz", "centroidHz", "crestDb", "peakDb",
            "lengthS", "activeS", "tailDb", "lufs"]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _db(v: float) -> float:
    return 10.0 * math.log10(max(v, 1e-20))


def measure_cut(event: np.ndarray, sr: int) -> dict:
    """The measures of one cut. event: (n, channels) float samples at rate sr (the raw cut, before any gain)."""
    x = np.asarray(event, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    n = x.shape[0]
    out = {}
    out.update(screen.saturation_measures(x, sr))                       # loud50Db, above2kHzLoud
    out["above60Hz"] = round(screen.energy_share_above(x, sr, 60.0), 4)
    out["under250Hz"] = round(1.0 - screen.energy_share_above(x, sr, 250.0), 4)
    out["above4kHz"] = round(screen.energy_share_above(x, sr, 4000.0), 4)
    spec = (np.abs(np.fft.rfft(x, axis=0)) ** 2).sum(axis=1)
    freq = np.fft.rfftfreq(n, 1.0 / sr)
    out["centroidHz"] = round(float((spec * freq).sum() / spec.sum()), 1) if spec.sum() > 0 else 0.0
    peak = float(np.abs(x).max())
    rms = math.sqrt(float((x ** 2).mean()))
    out["crestDb"] = round(20.0 * math.log10(peak / rms), 2) if rms > 0 and peak > 0 else None
    out["peakDb"] = round(20.0 * math.log10(max(peak, 1e-10)), 2)
    out["lengthS"] = round(n / sr, 3)
    env, hop, win = screen.level_env(x, sr)
    within = np.flatnonzero(env >= env.max() - 40.0)
    out["activeS"] = round((int(within[-1]) * hop + win) / sr, 3)
    w = max(1, int(round(0.05 * sr)))
    p = (x ** 2).mean(axis=1)
    last = _db(float(p[-w:].mean())) if p.size >= w else _db(float(p.mean()))
    out["tailDb"] = round(last - out["loud50Db"], 2)                    # dB under the loudest 50 ms (negative)
    return out


def level_profile(event: np.ndarray, sr: int, step_s: float = 0.05) -> list[float]:
    """The level of consecutive 50 ms windows (power mean over the channels), dB under the loudest 50 ms of the cut
    (the loud50Db window); the last window is the end of the cut (a shorter one is padded with nothing, not zeros)."""
    x = np.asarray(event, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    p = (x ** 2).mean(axis=1)
    w = max(1, int(round(step_s * sr)))
    ref = screen.saturation_measures(x, sr)["loud50Db"]
    out = []
    for i in range(0, p.size, w):
        seg = p[i:i + w]
        out.append(round(_db(float(seg.mean())) - ref, 1))
    return out


def read_cut(path: Path, start_s: float | None, end_s: float | None):
    import soundfile as sf
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    a = 0 if start_s is None else int(round(start_s * sr))
    b = x.shape[0] if end_s is None else int(round(end_s * sr))
    return x[a:b], int(sr), int(x.shape[1])


def _rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(p)


def _targets(kept_dir: Path) -> dict:
    """id -> the level the candidate was played at (lufsTarget of its listening copy), from the screen.json beside kept.json."""
    f = kept_dir / "screen.json"
    if not f.exists():
        return {}
    d = json.loads(f.read_text(encoding="utf-8"))
    return {c["id"]: c.get("listen", {}).get("lufsTarget") for c in d.get("chosen", [])}


def rows_from_kept(kept_file: Path) -> list[dict]:
    d = json.loads(kept_file.read_text(encoding="utf-8"))
    kdir = kept_file.parent
    tg = _targets(kdir)
    rows = []
    for c in d["candidates"]:
        raw = ROOT / c["raw"]
        rawfile, ok = raw, False
        if raw.exists() and sha256(raw) == c["rawSha256"]:
            ok = True
        else:  # the kept copy beside kept.json
            name = c.get("keptRaw") or ("raw/%s__%s" % (c["source"], Path(c["raw"]).name))
            alt = kdir / name
            if alt.exists() and sha256(alt) == c["rawSha256"]:
                rawfile, ok = alt, True
        cut = c["cut"]
        ev, sr, ch = read_cut(rawfile, cut["startS"], cut["endS"])
        m = measure_cut(ev, sr)
        m["lufs"] = tg.get(c["id"])
        fam = c.get("family")
        rows.append({
            "id": c["id"], "round": d["round"], "source": c.get("source"), "family": fam,
            "promptId": Path(c["raw"]).stem.split("__s")[0] if c.get("source") in ("moss", "sa3") else None,  # a recording has none
            "event": EVENT_OF_FAMILY.get(fam, fam), "verdict": c.get("verdict"), "note": c.get("note", ""),
            "raw": c["raw"], "rawFile": _rel(rawfile), "rawShaOk": ok, "cut": cut, "sr": sr, "channels": ch,
            "measures": m,
        })
    return rows


def rows_from_screen(screen_file: Path) -> list[dict]:
    d = json.loads(screen_file.read_text(encoding="utf-8"))
    rows = []
    for c in d["chosen"]:
        raw = ROOT / c["raw"]
        cut = c["cut"]
        ev, sr, ch = read_cut(raw, cut["startS"], cut["endS"])
        m = measure_cut(ev, sr)
        m["lufs"] = c.get("listen", {}).get("lufsTarget")
        fam = c.get("family")
        rows.append({
            "id": c["id"], "round": None, "source": c.get("source"), "family": fam,
            "event": EVENT_OF_FAMILY.get(fam, fam), "verdict": None, "note": "",
            "raw": c["raw"], "rawFile": _rel(raw), "rawShaOk": None, "cut": cut, "sr": sr, "channels": ch,
            "measures": m, "screen": _rel(screen_file),
        })
    return rows


def row_from_wav(spec: str, lufs: float | None = None, label: str | None = None) -> dict:
    parts = spec.rsplit(":", 2)
    if len(parts) == 3 and parts[0] and _isnum(parts[1]) and _isnum(parts[2]) and not parts[0].endswith(("\\", "/")):
        path, a, b = Path(parts[0]), float(parts[1]), float(parts[2])
    else:
        path, a, b = Path(spec), None, None
    if not path.is_absolute():
        path = ROOT / path
    ev, sr, ch = read_cut(path, a, b)
    m = measure_cut(ev, sr)
    m["lufs"] = lufs
    return {"id": label or path.stem, "round": None, "source": None, "family": None, "event": None, "verdict": None,
            "note": "", "raw": _rel(path), "rawFile": _rel(path), "rawShaOk": None,
            "cut": {"startS": a, "endS": b}, "sr": sr, "channels": ch, "measures": m}


def _isnum(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def table(rows: list[dict]) -> str:
    cols = [("id", 40), ("rd", 2), ("verdict", 7), ("loud50", 7), ("a2k", 6), ("a60", 6), ("u250", 6), ("a4k", 6),
            ("centroid", 8), ("crest", 6), ("peak", 6), ("len", 6), ("active", 6), ("tail", 6), ("lufs", 6)]
    head = " ".join(n.ljust(w) for n, w in cols)
    lines = [head, "-" * len(head)]

    def f(v, nd=2):
        return "-" if v is None else ("%.*f" % (nd, v))
    last_event = object()
    for r in rows:
        if r["event"] != last_event:
            last_event = r["event"]
            lines.append("[%s]" % last_event)
        m = r["measures"]
        vals = [r["id"][:40], "" if r["round"] is None else str(r["round"]), r["verdict"] or "-", f(m["loud50Db"]),
                f(m["above2kHzLoud"], 3), f(m["above60Hz"], 3), f(m["under250Hz"], 3), f(m["above4kHz"], 3),
                f(m["centroidHz"], 0), f(m["crestDb"]), f(m["peakDb"]), f(m["lengthS"], 3), f(m["activeS"], 3),
                f(m["tailDb"]), f(m["lufs"], 1)]
        lines.append(" ".join(str(v).ljust(w) for v, (n, w) in zip(vals, cols)))
    return "\n".join(lines)


def sort_rows(rows: list[dict]) -> list[dict]:
    order = {e: i for i, e in enumerate(EVENT_ORDER)}
    return sorted(rows, key=lambda r: (order.get(r["event"], 99), r["round"] or 0, r["id"]))


# ----------------------------------------------------------------------------------------------
# the analysis of the ratings of round 6 (2026-11-18): --analysis writes the json and the md of docs/reports/2026-11-18

KEPT_FILES = [ROOT / ("assets/audio/gen/_kept/round%d/kept.json" % r) for r in (4, 5, 6)]
RATINGS_FILE = ROOT / "assets/audio/ratings.json"
GENERATED_FILE = ROOT / "assets/audio/generated.json"
LIBRARY_DIR = ROOT / "assets/audio/render/generated"
GENERATED_RAW_DIR = ROOT / "assets/audio/generated"
PROMPTS6 = HERE / "prompts6.json"
VERDICTS = ("fits", "close", "wrong")
RULE = {"loud50Db": -9.5, "above2kHz": 0.03}   # the working rule notSaturatedNoise of prompts6.json / RESULTS6.md
NEAR_DB = 1.5
RANGE_MEASURES = ["loud50Db", "above2kHzLoud", "above60Hz", "under250Hz", "above4kHz", "centroidHz", "crestDb",
                  "peakDb", "lengthS", "activeS", "tailDb", "lufs"]


def _over_level(m):
    return m["loud50Db"] > RULE["loud50Db"]


def _over_share(m):
    return m["above2kHzLoud"] >= RULE["above2kHz"]


def rule_table(rows: list, rule_families: set) -> list:
    """Every row over both numbers of the rule or within NEAR_DB of its level threshold, with its verdict."""
    out = []
    for r in rows:
        m = r["measures"]
        both = _over_level(m) and _over_share(m)
        near = abs(m["loud50Db"] - RULE["loud50Db"]) <= NEAR_DB
        if both or near:
            out.append({"id": r["id"], "event": r["event"], "family": r["family"], "verdict": r["verdict"],
                        "note": r["note"], "loud50Db": m["loud50Db"], "above2kHzLoud": m["above2kHzLoud"],
                        "lufs": m["lufs"], "overLevel": _over_level(m), "overShare": _over_share(m),
                        "overBoth": both, "withinNearOfLevelThreshold": near,
                        "distanceToLevelThresholdDb": round(m["loud50Db"] - RULE["loud50Db"], 2),
                        "familyHasTheRule": r["family"] in rule_families})
    return out


def tally(rows: list) -> dict:
    t = {v: 0 for v in VERDICTS}
    for r in rows:
        t[r["verdict"]] += 1
    t["n"] = len(rows)
    return t


def best_two_measure_rule(rows: list, accepted: tuple) -> dict:
    """The fewest mistakes of any rule 'reject when loud50Db > t1 and above2kHzLoud >= t2' on the rows (a row is
    good-class when its verdict is in `accepted`). Thresholds run over the midpoints of the values present, so the
    answer is the best this family of rules can do on these rows, which is optimistic (it is fitted to them)."""
    rr = [(r["measures"]["loud50Db"], r["measures"]["above2kHzLoud"], r["verdict"] in accepted) for r in rows]
    a = sorted({x[0] for x in rr})
    b = sorted({x[1] for x in rr})
    ta = [a[0] - 1.0] + [(a[i] + a[i + 1]) / 2 for i in range(len(a) - 1)] + [a[-1] + 1.0]
    tb = [0.0] + [(b[i] + b[i + 1]) / 2 for i in range(len(b) - 1)] + [b[-1] + 1.0]

    def errors(t1, t2):
        rejected_good = sum(1 for l, s, good in rr if good and l > t1 and s >= t2)
        kept_bad = sum(1 for l, s, good in rr if (not good) and not (l > t1 and s >= t2))
        return rejected_good, kept_bad
    best = None
    for t1 in ta:
        for t2 in tb:
            g, bd = errors(t1, t2)
            if best is None or g + bd < best[0]:
                best = (g + bd, t1, t2, g, bd)
    g0, b0 = errors(RULE["loud50Db"], RULE["above2kHz"])
    return {"n": len(rr), "accepted": list(accepted), "rowsAccepted": sum(1 for x in rr if x[2]),
            "rowsRejected": sum(1 for x in rr if not x[2]),
            "currentRule": {"acceptedRejectedByRule": g0, "rejectedNotCaughtByRule": b0},
            "bestRuleOfThisKind": {"loud50Db": round(best[1], 2), "above2kHz": round(best[2], 4),
                                   "acceptedRejectedByRule": best[3], "rejectedNotCaughtByRule": best[4]}}


def rule_errors(rows: list, accepted: tuple, t1: float, t2: float) -> dict:
    """The mistakes of 'reject when loud50Db > t1 and above2kHzLoud >= t2' on the rows."""
    good = [r for r in rows if r["verdict"] in accepted]
    bad = [r for r in rows if r["verdict"] not in accepted]

    def hit(r):
        return r["measures"]["loud50Db"] > t1 and r["measures"]["above2kHzLoud"] >= t2
    return {"n": len(rows), "acceptedRejectedByRule": sum(1 for r in good if hit(r)), "nAccepted": len(good),
            "rejectedNotCaughtByRule": sum(1 for r in bad if not hit(r)), "nRejected": len(bad)}


def single_measure_separation(rows: list) -> dict:
    """Per measure: do the 'fits' and the 'wrong' rows of these rows separate by one threshold?"""
    f = [r for r in rows if r["verdict"] == "fits"]
    w = [r for r in rows if r["verdict"] == "wrong"]
    out = {"nFits": len(f), "nWrong": len(w), "measures": {}}
    if not f or not w:
        return out
    for k in RANGE_MEASURES:
        fv = [r["measures"][k] for r in f if r["measures"].get(k) is not None]
        wv = [r["measures"][k] for r in w if r["measures"].get(k) is not None]
        if not fv or not wv:
            continue
        sep = "none"
        if max(fv) < min(wv):
            sep = "fits all under wrong"
        elif min(fv) > max(wv):
            sep = "fits all over wrong"
        out["measures"][k] = {"fits": [min(fv), max(fv)], "wrong": [min(wv), max(wv)], "separates": sep}
    return out


def ranges_of(rows: list) -> dict:
    """Per measure and verdict: n, min, max, the ids at both ends and all values (sorted), for the select step."""
    out = {}
    for k in RANGE_MEASURES:
        out[k] = {}
        for v in VERDICTS:
            vals = sorted(((r["measures"][k], r["id"]) for r in rows if r["verdict"] == v and r["measures"].get(k) is not None))
            if vals:
                out[k][v] = {"n": len(vals), "min": vals[0][0], "minId": vals[0][1], "max": vals[-1][0],
                             "maxId": vals[-1][1], "values": [[i, x] for x, i in vals]}
    return out


def place(measures: dict, ranges: dict) -> dict:
    """Where a pick's measures fall against ranges_of(...): per measure the verdicts whose [min, max] holds the value."""
    out = {}
    for k, per in ranges.items():
        v = measures.get(k)
        if v is None or not per:
            continue
        out[k] = {"value": v, "insideRangeOf": [vd for vd, r in per.items() if r["min"] <= v <= r["max"]],
                  "underAllRanges": all(v < r["min"] for r in per.values()),
                  "overAllRanges": all(v > r["max"] for r in per.values())}
    return out


def alignment_gain(lib: np.ndarray, cand: np.ndarray) -> tuple:
    """The gain (dB) that takes the listening copy `cand` to the library file `lib` when the two are the same signal:
    cross-correlation finds the lag, a least-squares fit the gain; the third number is the residual relative to lib."""
    from scipy.signal import correlate
    l, c = lib[:, 0], cand[:, 0]
    cc = correlate(c, l, mode="full", method="fft")
    lag = int(cc.argmax() - (len(l) - 1))
    if lag >= 0:
        cs = c[lag:lag + len(l)]
        ls = l[:len(cs)]
    else:
        ls = l[-lag:]
        cs = c[:len(ls)]
    g = float((ls @ cs) / (cs @ cs))
    resid = float(np.sqrt(((ls - g * cs) ** 2).sum() / (ls ** 2).sum()))
    return round(20.0 * math.log10(g), 2), lag, round(resid, 4)


def library_pulses(ref_rows: list, ratings: dict) -> list:
    import soundfile as sf
    sys.path.insert(0, str(ROOT / "tools" / "audio"))
    from synth.levels import lufs, true_peak_db
    gdoc = json.loads(GENERATED_FILE.read_text(encoding="utf-8"))
    glist = list(gdoc["sounds"]) + list(gdoc.get("withdrawn", []))  # a and b were withdrawn after the rating
    gen = {g["id"]: g for g in glist}
    withdrawn_ids = {g["id"] for g in gdoc.get("withdrawn", [])}
    byid = {r["id"]: r for r in ref_rows}
    out = []
    for letter in "abc":
        gid = "g_thruster_pulse_" + letter
        g = gen[gid]
        cand_id = g["origin"]["candidate"]
        # The library file as the build makes it, in memory (tools/audio/build.py process_generated: cut as recorded,
        # 48 kHz, end repair, loudness set), from the raw file of assets/audio/generated whose SHA-256 is checked. The
        # rendered copy under render/generated is not read: a and b were withdrawn and are no longer rendered. The
        # check below compares the rebuilt c with the rendered c on disk where there is one.
        raw_lib = GENERATED_RAW_DIR / g["file"]
        if sha256(raw_lib) != g["sha256"]:
            raise SystemExit("%s: the SHA-256 of the raw library file is not the one in generated.json" % gid)
        sys.path.insert(0, str(ROOT / "tools" / "audio"))
        import build as _build
        import importlib.util
        spec = importlib.util.spec_from_file_location("audio_listen_common", ROOT / "tools" / "audio" / "listen" / "common.py")
        listen_common = importlib.util.module_from_spec(spec)  # the loader build.py is given (not tools/sound/common.py)
        spec.loader.exec_module(listen_common)
        data, rsr0 = listen_common.load_audio(raw_lib)
        y, _info = _build.process_generated(data, rsr0, (float(g["cut"]["startS"]), float(g["cut"]["endS"])), float(g["lufs"]))
        lib, sr = np.asarray(y, dtype=np.float64), 48000
        if lib.ndim == 1:
            lib = lib[:, None]
        wav = LIBRARY_DIR / g["file"]
        rendered = None
        if wav.exists():
            on_disk, dsr = sf.read(str(wav), dtype="float64", always_2d=True)
            n = min(len(on_disk), len(lib))
            rendered = {"file": _rel(wav), "sameLength": len(on_disk) == len(lib),
                        "residualRelative": round(float(np.sqrt(((on_disk[:n] - lib[:n]) ** 2).sum() / (on_disk[:n] ** 2).sum())), 5)}
        lrow = {"measures": measure_cut(lib, sr)}
        lrow["measures"]["lufs"] = g["lufs"]
        lprof = level_profile(lib, sr)
        crow = byid[cand_id]
        raw = ROOT / crow["rawFile"]
        ev, rsr, _ = read_cut(raw, crow["cut"]["startS"], crow["cut"]["endS"])
        cprof = level_profile(ev, rsr)
        listen = ROOT / ("assets/audio/gen/_kept/round%d/listen/%s.wav" % (crow["round"], cand_id))
        cl, csr = sf.read(str(listen), dtype="float64", always_2d=True)
        gain, lag, resid = alignment_gain(lib, cl)
        within3 = sum(1 for x in lprof if x >= -3.0)
        rt = ratings.get(gid, {})
        out.append({
            "libraryId": gid, "libraryRawFile": _rel(raw_lib), "renderedFileOnDisk": rendered, "libraryWithdrawn": gid in withdrawn_ids, "libraryVerdict": rt.get("verdict"), "libraryNote": rt.get("note"),
            "libraryRatedAt": rt.get("at"),
            "library": {"measures": lrow["measures"], "lufsMeasured": round(float(lufs(lib)), 2),
                        "truePeakDb": round(float(true_peak_db(lib)), 2), "durationS": round(len(lib) / sr, 4),
                        "lastSampleAbs": float(abs(lib[-1, 0])), "windows50msWithin3DbOfLoudest": within3,
                        "plateauWithin3DbS": round(within3 * 0.05, 2), "profile50msDbUnderLoudest": lprof},
            "candidate": {"id": cand_id, "round": crow["round"], "verdict": crow["verdict"], "note": crow["note"],
                          "cut": crow["cut"], "playedAtLufs": crow["measures"]["lufs"], "measuresRawCut": crow["measures"],
                          "listeningCopy": {"file": _rel(listen), "lufsMeasured": round(float(lufs(cl)), 2),
                                            "truePeakDb": round(float(true_peak_db(cl)), 2), "durationS": round(len(cl) / csr, 4)},
                          "profile50msDbUnderLoudest": cprof},
            "sameSignal": {"gainLibraryOverListeningCopyDb": gain, "lagSamples": lag, "residualRelative": resid},
            "origin": {"seed": g["origin"]["seed"], "round": g["origin"]["round"], "prompt": g["origin"]["prompt"]},
        })
    return out


def voice_rows(ratings: dict) -> list:
    import re
    pat = re.compile(r"^voice_(\d+)_([a-z]+)_(\d+)_([a-z0-9]+)(?:_(.+))?$")
    rows = []
    for k, v in ratings.items():
        if not k.startswith("voice_"):
            continue
        m = pat.match(k)
        rows.append({"id": k, "lineNumber": int(m.group(1)), "line": m.group(2), "slot": int(m.group(3)),
                     "model": m.group(4), "variant": m.group(5), "verdict": v["verdict"], "note": v.get("note", ""),
                     "ratedAt": v["at"], "hasHistory": "history" in v})
    return sorted(rows, key=lambda r: (r["lineNumber"], r["slot"]))


def voice_counts(rows: list) -> dict:
    out = {}
    for r in rows:
        d = out.setdefault(r["model"], {v: 0 for v in VERDICTS})
        d[r["verdict"]] += 1
    for d in out.values():
        d["n"] = sum(d[v] for v in VERDICTS)
    return out


def _f(v, nd=2):
    return "-" if v is None else ("%.*f" % (nd, v))


def build_analysis() -> tuple:
    ratings_doc = json.loads(RATINGS_FILE.read_text(encoding="utf-8"))
    ratings = ratings_doc["ratings"]
    rows = []
    for k in KEPT_FILES:
        rows += rows_from_kept(k)
    rows = sort_rows(rows)
    p6 = json.loads(PROMPTS6.read_text(encoding="utf-8"))
    rule_fams = {f["id"] for f in p6["families"] if "notSaturatedNoise" in f}
    r6 = [r for r in rows if r["round"] == 6]

    # 2. the reference table
    reference = {e: [r for r in rows if r["event"] == e] for e in EVENT_ORDER}

    # 3. the working rule against round 6
    t6 = rule_table(r6, rule_fams)
    t_all = rule_table(rows, rule_fams)
    both_all = [r for r in t_all if r["overBoth"]]
    rule = {
        "rule": RULE, "nearDb": NEAR_DB, "ruleFamiliesRound6": sorted(rule_fams),
        "round6": {"candidates": len(r6), "listed": t6,
                   "overBoth": tally([r for r in r6 if _over_level(r["measures"]) and _over_share(r["measures"])]),
                   "withinNearOfLevelThreshold": tally([r for r in r6 if abs(r["measures"]["loud50Db"] - RULE["loud50Db"]) <= NEAR_DB]),
                   "ruleFamiliesOnly": tally([r for r in r6 if r["family"] in rule_fams]),
                   "ruleFamiliesOverBoth": tally([r for r in r6 if r["family"] in rule_fams and _over_level(r["measures"]) and _over_share(r["measures"])])},
        "allRoundsOverBoth": {"rows": both_all, "tally": tally([r for r in rows if _over_level(r["measures"]) and _over_share(r["measures"])])},
        "separation": {
            "round6All_fitsVsWrong": best_two_measure_rule([r for r in r6 if r["verdict"] in ("fits", "wrong")], ("fits",)),
            "round6All_notWrongVsWrong": best_two_measure_rule(r6, ("fits", "close")),
            "round6RuleFamilies_fitsVsWrong": best_two_measure_rule([r for r in r6 if r["family"] in rule_fams and r["verdict"] in ("fits", "wrong")], ("fits",)),
            "rounds456All_fitsVsWrong": best_two_measure_rule([r for r in rows if r["verdict"] in ("fits", "wrong")], ("fits",)),
            "rounds456All_notWrongVsWrong": best_two_measure_rule(rows, ("fits", "close")),
            "singleMeasure_byEvent": {e: single_measure_separation(reference[e]) for e in EVENT_ORDER},
        },
        "holdout": None,
        "ruleEventsAllRounds": {
            "events": ["shield", "fold jump", "fold exit"],
            "overBoth": tally([r for r in rows if r["event"] in ("shield", "fold jump", "fold exit") and _over_level(r["measures"]) and _over_share(r["measures"])]),
            "notOverBoth": tally([r for r in rows if r["event"] in ("shield", "fold jump", "fold exit") and not (_over_level(r["measures"]) and _over_share(r["measures"]))]),
        },
        "notesNamingOverdrive": {str(rd): [r["id"] for r in rows if r["round"] == rd and re.search(r"(?i)übersteuer|ubersteuer|overdr|verzerr|clip|sättig", r["note"])] for rd in (4, 5, 6)},
    }

    # the holdout: thresholds fitted on rounds 4 and 5 (fits against wrong), tried on round 6
    r45 = [r for r in rows if r["round"] in (4, 5) and r["verdict"] in ("fits", "wrong")]
    fit45 = best_two_measure_rule(r45, ("fits",))
    b45 = fit45["bestRuleOfThisKind"]
    rule["holdout"] = {"fittedOn": "rounds 4 and 5, fits against wrong", "fit": fit45,
                       "triedOnRound6FitsVsWrong": rule_errors([r for r in r6 if r["verdict"] in ("fits", "wrong")], ("fits",), b45["loud50Db"], b45["above2kHz"]),
                       "currentRuleOnRound6FitsVsWrong": rule_errors([r for r in r6 if r["verdict"] in ("fits", "wrong")], ("fits",), RULE["loud50Db"], RULE["above2kHz"])}

    # 4. the library pulses
    pulses = library_pulses(rows, ratings)

    # 5. ranges for thruster and shield
    ranges = {}
    for e in ("thruster", "shield"):
        er = [r for r in rows if r["event"] == e]
        groups = {
            "allRoundsAllSources": er,
            "mossOnly": [r for r in er if r["source"] == "moss"],
            "round6Only": [r for r in er if r["round"] == 6],
        }
        if e == "thruster":
            # the two prompts that make a thruster apart: a valve burst (round 4 thruster_1 prompt, all of its fits) and
            # everything that asks for a gun or cannon (round 4 thruster_2, bang, gatling, mighty)
            groups["valvePromptMoss"] = [r for r in er if r["promptId"] == "thruster_1"]
            groups["cannonLikeMossAndSa3"] = [r for r in er if r["promptId"] and r["promptId"] != "thruster_1"]
        ranges[e] = {g: {"rows": len(rs), "tally": tally(rs), "ranges": ranges_of(rs)} for g, rs in groups.items()}

    # 6. the voices
    vrows = voice_rows(ratings)
    voices = {"rows": vrows, "countsByModelAll": voice_counts(vrows),
              "countsByModelRatedOn2026-11-18": voice_counts([r for r in vrows if r["ratedAt"].startswith("2026-11-18")]),
              "ratedBefore2026-11-18": [r["id"] for r in vrows if not r["ratedAt"].startswith("2026-11-18")]}
    try:
        man = json.loads((ROOT / "assets/audio/render/manifest.json").read_text(encoding="utf-8"))
        sounds = man["sounds"]
        mids = [s["id"] if isinstance(s, dict) else s for s in (sounds.values() if isinstance(sounds, dict) else sounds)]
        voices["voiceIdsInManifest"] = len([i for i in mids if i.startswith("voice_")])
        voices["voiceIdsInManifestWithoutRating"] = [i for i in mids if i.startswith("voice_") and i not in ratings]
    except Exception as e:  # the manifest is read only for this count
        voices["manifestNote"] = "manifest not read: %s" % e

    doc = {
        "script": "tools/sound/compare.py --analysis", "date": "2026-11-18",
        "inputs": {"kept": [_rel(k) for k in KEPT_FILES], "ratings": _rel(RATINGS_FILE),
                   "ratingsSavedAt": ratings_doc.get("savedAt"), "ratingsSha256": sha256(RATINGS_FILE),
                   "prompts6": _rel(PROMPTS6), "generated": _rel(GENERATED_FILE)},
        "counts": {"rows": len(rows), "byRound": {str(r): len([x for x in rows if x["round"] == r]) for r in (4, 5, 6)},
                   "round6": tally(r6), "rawShaOkForAll": all(r["rawShaOk"] for r in rows)},
        "reference": reference, "saturationRule": rule, "libraryPulses": pulses, "ranges": ranges, "voices": voices,
    }
    return doc, markdown(doc)


def markdown(doc: dict) -> str:
    L = []
    w = L.append
    w("# Analysis of the ratings of round 6 (rated 2026-11-18)")
    w("")
    w("Made by `tools/sound/compare.py --analysis`; the data is in `round6-ratings-analysis.json` (same folder). Every number "
      "below is a measurement on the raw cut of a candidate (before any gain) or a count from a script. Nobody listened; "
      "nothing here says how anything sounds. Ratings read: `assets/audio/ratings.json` as saved at %s (SHA-256 %s)."
      % (doc["inputs"]["ratingsSavedAt"], doc["inputs"]["ratingsSha256"][:16]))
    w("")
    c = doc["counts"]
    w("%d rated candidates: round 4 %d, round 5 %d, round 6 %d; round 6 is %d fits, %d close, %d wrong. All raw files "
      "were found with the SHA-256 of their record: %s." % (c["rows"], c["byRound"]["4"], c["byRound"]["5"], c["byRound"]["6"],
                                                         c["round6"]["fits"], c["round6"]["close"], c["round6"]["wrong"], c["rawShaOkForAll"]))
    w("")
    w("Columns: loud50 = loudest 50 ms, dBFS; a2k = share of energy above 2 kHz in the loud frames; a60 = share above "
      "60 Hz; u250 = share under 250 Hz; a4k = share above 4 kHz; centroid in Hz; crest = peak over RMS, dB; peak dBFS; "
      "len = length of the cut, s; active = s until the last 4 ms frame within 40 dB of the loudest; tail = level of the "
      "last 50 ms in dB under the loudest 50 ms; LUFS = the level it was played at (family target).")
    w("")
    w("## 2. The reference table")
    w("")
    for e in EVENT_ORDER:
        w("### %s" % e)
        w("")
        w("| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |")
        w("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for r in doc["reference"][e]:
            m = r["measures"]
            note = r["note"].replace("|", "/")
            w("| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                r["id"], r["round"], r["verdict"], note, _f(m["loud50Db"]), _f(m["above2kHzLoud"], 3), _f(m["above60Hz"], 3),
                _f(m["under250Hz"], 3), _f(m["above4kHz"], 3), _f(m["centroidHz"], 0), _f(m["crestDb"]), _f(m["peakDb"]),
                _f(m["lengthS"], 3), _f(m["activeS"], 3), _f(m["tailDb"]), _f(m["lufs"], 0)))
        w("")
    s = doc["saturationRule"]
    w("## 3. The working rule notSaturatedNoise against round 6")
    w("")
    w("Rule: loudest 50 ms above %.1f dBFS and share above 2 kHz at least %.2f. Listed: every round-6 candidate over both "
      "numbers or within %.1f dB of the level threshold. 'rule family' says whether the family had the setting in "
      "`prompts6.json` (%s)." % (s["rule"]["loud50Db"], s["rule"]["above2kHz"], s["nearDb"], ", ".join(s["ruleFamiliesRound6"])))
    w("")
    w("| id | verdict | loud50 | dB from threshold | a2k | over level | over share | over both | LUFS | rule family |")
    w("|---|---|---|---|---|---|---|---|---|---|")
    for r in s["round6"]["listed"]:
        w("| %s | %s | %s | %+.2f | %s | %s | %s | %s | %s | %s |" % (
            r["id"], r["verdict"], _f(r["loud50Db"]), r["distanceToLevelThresholdDb"], _f(r["above2kHzLoud"], 3),
            r["overLevel"], r["overShare"], r["overBoth"], _f(r["lufs"], 0), r["familyHasTheRule"]))
    w("")
    r6 = s["round6"]
    w("Counts (script): of %d round-6 candidates, %d are over both numbers (fits %d, close %d, wrong %d) and %d are within "
      "%.1f dB of the level threshold (fits %d, close %d, wrong %d). In the three rule families (%d candidates: fits %d, "
      "close %d, wrong %d), %d are over both numbers." % (
          r6["candidates"], r6["overBoth"]["n"], r6["overBoth"]["fits"], r6["overBoth"]["close"], r6["overBoth"]["wrong"],
          r6["withinNearOfLevelThreshold"]["n"], s["nearDb"], r6["withinNearOfLevelThreshold"]["fits"],
          r6["withinNearOfLevelThreshold"]["close"], r6["withinNearOfLevelThreshold"]["wrong"], r6["ruleFamiliesOnly"]["n"],
          r6["ruleFamiliesOnly"]["fits"], r6["ruleFamiliesOnly"]["close"], r6["ruleFamiliesOnly"]["wrong"], r6["ruleFamiliesOverBoth"]["n"]))
    w("")
    a = s["allRoundsOverBoth"]
    w("Rounds 4 to 6 together, over both numbers: %d candidates (fits %d, close %d, wrong %d): %s." % (
        a["tally"]["n"], a["tally"]["fits"], a["tally"]["close"], a["tally"]["wrong"],
        "; ".join("%s %s (%s, %s)" % (x["id"], x["verdict"], _f(x["loud50Db"]), _f(x["above2kHzLoud"], 3)) for x in a["rows"])))
    w("")
    w("Best the family of rules 'reject when loud50 above t1 and a2k at least t2' can do on these rows, with t1 and t2 fitted "
      "to the rows themselves (so optimistic); 'accepted rejected' counts accepted candidates the rule would reject, "
      "'wrong kept' counts wrong candidates it would let through:")
    w("")
    w("| rows | accepted = | n (accepted/rejected) | current rule: accepted rejected / wrong kept | best t1, t2: accepted rejected / wrong kept |")
    w("|---|---|---|---|---|")
    for k, v in s["separation"].items():
        if k == "singleMeasure_byEvent":
            continue
        b = v["bestRuleOfThisKind"]
        w("| %s | %s | %d (%d/%d) | %d / %d | %s, %s: %d / %d |" % (
            k, "+".join(v["accepted"]), v["n"], v["rowsAccepted"], v["rowsRejected"],
            v["currentRule"]["acceptedRejectedByRule"], v["currentRule"]["rejectedNotCaughtByRule"],
            _f(b["loud50Db"]), _f(b["above2kHz"], 3), b["acceptedRejectedByRule"], b["rejectedNotCaughtByRule"]))
    w("")
    w("Single measure, fits against wrong, per event (does one threshold separate them?): " + "; ".join(
        "%s: %s" % (e, ", ".join("%s %s" % (k, x["separates"]) for k, x in d["measures"].items() if x["separates"] != "none") or "no measure separates")
        for e, d in s["separation"]["singleMeasure_byEvent"].items() if d["measures"]) + ".")
    w("")
    h = s["holdout"]
    w("")
    w("Held out: thresholds fitted on rounds 4 and 5 (fits against wrong; t1 %s, t2 %s, which reject %d of %d accepted and keep %d of %d wrong there) "
      "and tried on the round-6 fits and wrongs: %d of %d accepted rejected, %d of %d wrong kept. The current rule on the same round-6 rows: "
      "%d of %d accepted rejected, %d of %d wrong kept." % (
          _f(h["fit"]["bestRuleOfThisKind"]["loud50Db"]), _f(h["fit"]["bestRuleOfThisKind"]["above2kHz"], 3),
          h["fit"]["bestRuleOfThisKind"]["acceptedRejectedByRule"], h["fit"]["rowsAccepted"],
          h["fit"]["bestRuleOfThisKind"]["rejectedNotCaughtByRule"], h["fit"]["rowsRejected"],
          h["triedOnRound6FitsVsWrong"]["acceptedRejectedByRule"], h["triedOnRound6FitsVsWrong"]["nAccepted"],
          h["triedOnRound6FitsVsWrong"]["rejectedNotCaughtByRule"], h["triedOnRound6FitsVsWrong"]["nRejected"],
          h["currentRuleOnRound6FitsVsWrong"]["acceptedRejectedByRule"], h["currentRuleOnRound6FitsVsWrong"]["nAccepted"],
          h["currentRuleOnRound6FitsVsWrong"]["rejectedNotCaughtByRule"], h["currentRuleOnRound6FitsVsWrong"]["nRejected"]))
    w("")
    re_ = s["ruleEventsAllRounds"]
    w("The events the rule was made for (shield, fold jump, fold exit), rounds 4 to 6: over both numbers %d candidates (fits %d, close %d, wrong %d); "
      "not over both %d (fits %d, close %d, wrong %d)." % (
          re_["overBoth"]["n"], re_["overBoth"]["fits"], re_["overBoth"]["close"], re_["overBoth"]["wrong"],
          re_["notOverBoth"]["n"], re_["notOverBoth"]["fits"], re_["notOverBoth"]["close"], re_["notOverBoth"]["wrong"]))
    w("")
    w("Notes that name overdrive (the words übersteuert, overdriven, verzerrt, clip, sättig) by round: %s." % "; ".join(
        "round %s: %s" % (k, ", ".join(v) if v else "none") for k, v in s["notesNamingOverdrive"].items()))
    w("")
    w("## 4. The library thruster pulses against the candidates they were cut from")
    w("")
    for p in doc["libraryPulses"]:
        lm, cm = p["library"]["measures"], p["candidate"]["measuresRawCut"]
        w("### %s: library %s%s (%s); candidate %s, round %d, %s%s" % (
            p["libraryId"], p["libraryVerdict"], " '%s'" % p["libraryNote"] if p["libraryNote"] else "", (p["libraryRatedAt"] or "")[:16],
            p["candidate"]["id"], p["candidate"]["round"], p["candidate"]["verdict"],
            " '%s'" % p["candidate"]["note"] if p["candidate"]["note"] else ""))
        w("")
        w("| measure | library file | candidate, raw cut |")
        w("|---|---|---|")
        w("| level | %s LUFS (recorded), %s measured, true peak %s dBFS | %s LUFS target; listening copy measured %s, true peak %s dBFS |" % (
            _f(lm["lufs"]), _f(p["library"]["lufsMeasured"]), _f(p["library"]["truePeakDb"]), _f(cm["lufs"], 0),
            _f(p["candidate"]["listeningCopy"]["lufsMeasured"]), _f(p["candidate"]["listeningCopy"]["truePeakDb"])))
        w("| same signal | library over listening copy %+.2f dB (lag %d samples, residual %.4f of the library file) | |" % (
            p["sameSignal"]["gainLibraryOverListeningCopyDb"], p["sameSignal"]["lagSamples"], p["sameSignal"]["residualRelative"]))
        w("| length, ending | %s s; last 50 ms %s dB under loudest; active %s s; last sample %.5f | %s s; last 50 ms %s dB; active %s s |" % (
            _f(lm["lengthS"], 3), _f(lm["tailDb"]), _f(lm["activeS"], 3), p["library"]["lastSampleAbs"], _f(cm["lengthS"], 3), _f(cm["tailDb"]), _f(cm["activeS"], 3)))
        w("| spectrum | centroid %s Hz, a60 %s, u250 %s, a4k %s, a2k %s | centroid %s Hz, a60 %s, u250 %s, a4k %s, a2k %s |" % (
            _f(lm["centroidHz"], 0), _f(lm["above60Hz"], 3), _f(lm["under250Hz"], 3), _f(lm["above4kHz"], 3), _f(lm["above2kHzLoud"], 3),
            _f(cm["centroidHz"], 0), _f(cm["above60Hz"], 3), _f(cm["under250Hz"], 3), _f(cm["above4kHz"], 3), _f(cm["above2kHzLoud"], 3)))
        w("| peak, crest | peak %s dBFS, crest %s dB, loud50 %s | raw peak %s dBFS, crest %s dB, loud50 %s |" % (
            _f(lm["peakDb"]), _f(lm["crestDb"]), _f(lm["loud50Db"]), _f(cm["peakDb"]), _f(cm["crestDb"]), _f(cm["loud50Db"])))
        w("| plateau | %d windows of 50 ms within 3 dB of the loudest (%s s) | |" % (p["library"]["windows50msWithin3DbOfLoudest"], p["library"]["plateauWithin3DbS"]))
        w("| 50 ms levels, dB under loudest | %s | %s |" % (
            " ".join("%g" % x for x in p["library"]["profile50msDbUnderLoudest"]), " ".join("%g" % x for x in p["candidate"]["profile50msDbUnderLoudest"])))
        w("")
    w("## 5. Ranges for the thruster and the shield")
    w("")
    gl = {"allRoundsAllSources": "all rounds, all sources", "mossOnly": "MOSS only", "round6Only": "round 6 only",
          "valvePromptMoss": "the valve prompt (round 4 thruster_1, MOSS)", "cannonLikeMossAndSa3": "gun and cannon prompts (round 4 thruster_2, bang, gatling, mighty; MOSS and Stable Audio)"}
    for e in ("thruster", "shield"):
        for g, blk in doc["ranges"][e].items():
            t = blk["tally"]
            w("### %s, %s (%d rows: fits %d, close %d, wrong %d)" % (e, gl[g], blk["rows"], t["fits"], t["close"], t["wrong"]))
            w("")
            w("| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |")
            w("|---|---|---|---|")
            for k in RANGE_MEASURES:
                cells = []
                for v in VERDICTS:
                    r = blk["ranges"][k].get(v)
                    d = 3 if k in ("above2kHzLoud", "above60Hz", "under250Hz", "above4kHz", "lengthS", "activeS") else (0 if k in ("centroidHz", "lufs") else 2)
                    cells.append("(%d) %s..%s" % (r["n"], _f(r["min"], d), _f(r["max"], d)) if r else "-")
                w("| %s | %s | %s | %s |" % (k, cells[0], cells[1], cells[2]))
            w("")
    w("## 6. Voices")
    w("")
    v = doc["voices"]
    w("| line | slot | model | variant | verdict | rated | note |")
    w("|---|---|---|---|---|---|---|")
    for r in v["rows"]:
        w("| %d %s | %d | %s | %s | %s | %s | %s |" % (r["lineNumber"], r["line"], r["slot"], r["model"], r["variant"] or "", r["verdict"], r["ratedAt"][:10], r["note"].replace("|", "/")))
    w("")
    for key, label in (("countsByModelAll", "all %d voice ratings now in the file" % len(v["rows"])),
                       ("countsByModelRatedOn2026-11-18", "only those rated on 2026-11-18")):
        w("Counts by model, %s:" % label)
        w("")
        w("| model | fits | close | wrong | n |")
        w("|---|---|---|---|---|")
        for mname, d in sorted(v[key].items()):
            w("| %s | %d | %d | %d | %d |" % (mname, d["fits"], d["close"], d["wrong"], d["n"]))
        w("")
    w("Voice ratings dated before 2026-11-18: %s." % (", ".join(v["ratedBefore2026-11-18"]) or "none"))
    w("")
    return "\n".join(L) + "\n"


def run_place(analysis_json: str, event: str, group: str, rows: list) -> None:
    doc = json.loads(Path(analysis_json).read_text(encoding="utf-8"))
    key = {"all": "allRoundsAllSources", "moss": "mossOnly", "round6": "round6Only", "valve": "valvePromptMoss",
           "cannon": "cannonLikeMossAndSa3"}[group]
    ranges = doc["ranges"][event][key]["ranges"]
    for r in rows:
        print("\n%s" % r["id"])
        for k, p in place(r["measures"], ranges).items():
            where = "inside: " + "+".join(p["insideRangeOf"]) if p["insideRangeOf"] else \
                ("under every range" if p["underAllRanges"] else "over every range" if p["overAllRanges"] else "between ranges")
            print("  %-14s %10s  %s" % (k, p["value"], where))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--kept", action="append", default=[], help="a kept.json of assets/audio/gen/_kept/roundN")
    ap.add_argument("--screen", action="append", default=[], help="a screen.json of a round")
    ap.add_argument("--wav", action="append", default=[], help="FILE or FILE:START:END (seconds)")
    ap.add_argument("--event", help="only this event")
    ap.add_argument("--json", help="write the rows as data to this file")
    ap.add_argument("--analysis", nargs=2, metavar=("JSON", "MD"),
                    help="write the analysis of the ratings of round 6 (docs/reports/2026-11-18) to these two files")
    ap.add_argument("--place-against", metavar="ANALYSIS_JSON",
                    help="for the rows given, say which verdict ranges of the analysis (thruster or shield) hold their measures; needs --event")
    ap.add_argument("--group", choices=("all", "moss", "round6", "valve", "cannon"), default="all", help="the rows the ranges were made from")
    a = ap.parse_args(argv)
    if a.analysis:
        doc, md = build_analysis()
        Path(a.analysis[0]).write_text(json.dumps(doc, indent=1, ensure_ascii=False) + chr(10), encoding="utf-8", newline=chr(10))
        Path(a.analysis[1]).write_text(md, encoding="utf-8", newline=chr(10))
        print("wrote %s and %s" % (a.analysis[0], a.analysis[1]))
        return 0
    rows = []
    for k in a.kept:
        rows += rows_from_kept(Path(k))
    for s in a.screen:
        rows += rows_from_screen(Path(s))
    for w in a.wav:
        rows.append(row_from_wav(w))
    if a.event and not a.place_against:
        rows = [r for r in rows if r["event"] == a.event]
    rows = sort_rows(rows)
    print(table(rows))
    if a.place_against:
        if a.event not in ("thruster", "shield"):
            ap.error("--place-against needs --event thruster or --event shield")
        run_place(a.place_against, a.event, a.group, rows)
    if a.json:
        Path(a.json).write_text(json.dumps({"rows": rows}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
