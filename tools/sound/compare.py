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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--kept", action="append", default=[], help="a kept.json of assets/audio/gen/_kept/roundN")
    ap.add_argument("--screen", action="append", default=[], help="a screen.json of a round")
    ap.add_argument("--wav", action="append", default=[], help="FILE or FILE:START:END (seconds)")
    ap.add_argument("--event", help="only this event")
    ap.add_argument("--json", help="write the rows as data to this file")
    a = ap.parse_args(argv)
    rows = []
    for k in a.kept:
        rows += rows_from_kept(Path(k))
    for s in a.screen:
        rows += rows_from_screen(Path(s))
    for w in a.wav:
        rows.append(row_from_wav(w))
    if a.event:
        rows = [r for r in rows if r["event"] == a.event]
    rows = sort_rows(rows)
    print(table(rows))
    if a.json:
        Path(a.json).write_text(json.dumps({"rows": rows}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
