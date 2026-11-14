"""Render the registered sounds, measure them, check them against SOUND_DESIGN.md and write the manifest.

    .venv-audio/Scripts/python.exe tools/audio/build.py [--only id,id] [--category name]
        [--out DIR] [--no-clap] [--describe] [--manifest-only]

For every sound: <out>/<category>/<id>.wav, a spectrogram <id>.png and a small <id>.json with the
measurements and the result of every rule. The manifest is assembled from all the small JSON
files in <out>, so several people can build their own categories into one folder.
"""
from __future__ import annotations

import argparse
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


def build_sound(sound_id: str, out: Path, clap, describe_fn, measure, common) -> dict:
    spec = synth.load_spec()
    s = spec["sounds"][sound_id]
    entry = synth.REGISTRY[sound_id]
    x, level = synth.render(sound_id)
    wav = out / s["category"] / (sound_id + ".wav")
    synth.write_wav(wav, x, dither_seed=sound_id)
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
    checks["midShare"] = round(rules.energy_share(data, 125, 1000), 3)
    checks["subShare"] = round(rules.energy_share(data, 0, 60), 3)

    dry = s["category"] in rules.DRY_CATEGORIES
    manifest_entry = {
        "id": sound_id,
        "file": "%s/%s.wav" % (s["category"], sound_id),
        "spectrogram": "%s/%s.png" % (s["category"], sound_id),
        "category": s["category"], "kind": s["kind"], "path": s["path"],
    }
    for k in ("family", "params"):
        if k in s:
            manifest_entry[k] = s[k]
    manifest_entry.update({
        "en": s["en"], "de": s["de"], "intent": s["intent"],
        "source": "synth", "licence": LICENCE,
        "duration": round(data.shape[0] / sr, 4), "channels": data.shape[1], "gain": 1.0,
        "dry": dry, "checks": checks,
    })
    record = {"manifest": manifest_entry, "measure": an}
    _atomic_write(wav.with_suffix(".json"), json.dumps(record, indent=1, default=_json_default))
    return manifest_entry


def _excerpt_downloads(out: Path, measure_mod, common) -> list[dict]:
    """Downloaded files chosen in assets/audio/selection.json (schema as far as known: a list, or
    {"selected": [...]}, of {id, category, file, licence, en, de, intent, kind, excerpt}; file is
    relative to assets/audio/downloads; excerpt is [start, end] seconds or {start, end})."""
    if not SELECTION.is_file():
        return []
    raw = json.loads(SELECTION.read_text(encoding="utf-8"))
    items = raw if isinstance(raw, list) else raw.get("selected", raw.get("sounds", []))
    entries = []
    for it in items:
        try:
            src = DOWNLOADS / it["file"]
            if not src.is_file():
                print("  download missing on disk: %s" % it["file"])
                continue
            ex = it.get("excerpt")
            sid = it.get("id") or Path(it["file"]).stem
            path = src
            if ex:
                a, b = (ex["start"], ex["end"]) if isinstance(ex, dict) else (ex[0], ex[1])
                data, sr = common.load_audio(src)
                cut = data[int(a * sr): int(b * sr)]
                path = out / "downloads" / (sid + ".wav")
                import soundfile as sf

                path.parent.mkdir(parents=True, exist_ok=True)
                sf.write(str(path), cut, sr, subtype="PCM_16")
            rel = os.path.relpath(path, out).replace(os.sep, "/")
            entries.append({
                "id": sid, "file": rel, "spectrogram": it.get("spectrogram", ""),
                "category": it.get("category", "downloads"), "kind": it.get("kind", "oneshot"),
                "path": it.get("path", "structure"), "en": it.get("en", sid), "de": it.get("de", sid),
                "intent": it.get("intent", ""), "source": "download", "licence": it.get("licence", "unknown"),
                "duration": it.get("duration", 0), "channels": it.get("channels", 1), "gain": 1.0,
                "dry": True, "checks": {"pass": True, "failed": []},
            })
        except Exception as e:
            print("  selection entry skipped (%s): %s" % (type(e).__name__, e))
    return entries


def assemble_manifest(out: Path, measure_mod, common) -> dict:
    spec = synth.load_spec()
    order = {sid: i for i, sid in enumerate(spec["order"])}
    sounds = []
    for p in sorted(out.glob("*/*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(rec, dict) and "manifest" in rec and (p.with_suffix(".wav")).is_file():
            sounds.append(rec["manifest"])
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
            "licence", "duration", "channels", "gain", "dry", "checks")


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
        if s.get("source") == "synth" and s.get("spectrogram") and not (out / s["spectrogram"]).is_file():
            bad.append("%s: spectrogram not found" % name)
        c = s.get("checks", {})
        for k in ("pass", "failed", "peakDb", "lufs", "lowShare", "highShare"):
            if s.get("source") == "synth" and k not in c:
                bad.append("%s: checks.%s missing" % (name, k))
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
