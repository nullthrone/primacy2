"""Put the chosen candidates of the sound-source listening test onto the audition page, or take them off.

    .venv-audio/Scripts/python.exe tools/sound/publish.py            write assets/audio/render/source
    .venv-audio/Scripts/python.exe tools/sound/publish.py --remove   delete it and rebuild the manifest

Takes assets/audio/gen/screen.json (written by screen.py) and the listening copies under
assets/audio/gen/_listen/, writes each as a file of the category "source" (listed first in
tools/audio/sounds.json as "Klangquellen (Runde 4)"), 16 bit at 48 kHz through the sound library's
own writer, with spectrogram and record as tools/voice/publish.py does for the voice samples, then
assembles the manifest and validates it. Runs with the environment of the sound library, which it
only reads. --root and --out name other folders (the tests use them).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
AUDIO = ROOT / "tools" / "audio"
for _p in (AUDIO, AUDIO / "listen"):  # in front of the folder of this script, which has its own common.py
    sys.path.insert(0, str(_p))

CATEGORY = "source"
HINT = "candidate: only the level rules apply"
STABLE_NOTE = ("Stable Audio 3 Small-SFX Base is the checkpoint before the makers' last training stage, so a weak "
               "showing does not settle the model. Test material under the Stability AI Community License: it is "
               "not to be shipped until the owner has decided.")
NAMES = {  # (German, English) after the family name
    "moss": ("MOSS-SoundEffect", "MOSS-SoundEffect"),
    "sa3": ("Stable Audio 3 (nur Test)", "Stable Audio 3 (test only)"),
    "oga": ("Aufnahme (CC0)", "Recording (CC0)"),
}
SECOND = (", zweite Auswahl", ", second pick")
LICENCE = {
    "moss": "generated with MOSS-SoundEffect v2.0 (code and weights Apache-2.0)",
    "sa3": "generated with Stable Audio 3 Small-SFX Base (Stability AI Community License): test material, not to be "
           "shipped until the owner has decided",
}


def _first(d: dict, keys: tuple, default: str = "unknown") -> str:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return default


def describe_source(c: dict, fam: dict) -> tuple[str, str]:
    """(intent, licence) of a chosen candidate."""
    rec = c.get("record", {})
    cut = c["cut"]
    how = ("Cut out of the raw file (%.2f to %.2f s)%s, set to %s LUFS on the page." % (
        cut["startS"], cut["endS"], ", at the family's longest length" if cut.get("cappedAtFamilyLength") else "",
        c["listen"]["lufsTarget"]))
    if c["role"] != "typical" or c["slot"] == 4:
        how += (" Second pick: " + ("the candidate farthest from the other three in the description used for variety."
                                    if c["role"] == "farthest" else "chosen because this family has no candidate from the source of its slot."))
    else:
        how += " Chosen as the most typical candidate of its source in this family."
    if c["listen"].get("limitedByPeak"):
        how += " The true peak ceiling lowered the gain: the loudness reached is %s LUFS." % c["listen"]["lufsReached"]
    if c["source"] == "oga":
        title = _first(rec, ("title", "name", "itemTitle", "pageTitle"), c["name"])
        author = _first(rec, ("author", "credit", "creator", "user"))
        page = _first(rec, ("pageUrl", "page", "pageURL", "page_url", "url"))
        intent = 'Recording called "%s" on its OpenGameArt page, by %s (%s), CC0. %s' % (title, author, page, how)
        return intent, "%s, %s, CC0" % (author, page)
    text = rec.get("text_given", "")
    name = "MOSS-SoundEffect v2.0" if c["source"] == "moss" else "Stable Audio 3 Small-SFX Base"
    intent = 'Prompt given to %s: "%s" (seed %s). %s' % (name, text, rec.get("seed", "?"), how)
    if c["source"] == "sa3":
        intent += " " + STABLE_NOTE
    return intent, LICENCE[c["source"]]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--root", default=str(ROOT / "assets" / "audio" / "gen"), help="folder with screen.json and _listen")
    ap.add_argument("--out", default=str(ROOT / "assets" / "audio" / "render"))
    a = ap.parse_args(argv)

    import build  # tools/audio/build.py
    import common  # tools/audio/listen/common.py
    import measure  # tools/audio/listen/measure.py
    import soundfile as sf
    import synth

    out = Path(a.out).resolve()
    root = Path(a.root).resolve()
    target = out / CATEGORY
    if target.exists():
        shutil.rmtree(target)
    if not a.remove:
        if CATEGORY not in synth.load_spec()["categories"]:
            print("the category %r is not listed in tools/audio/sounds.json" % CATEGORY)
            return 2
        sj = root / "screen.json"
        if not sj.is_file():
            print("no screen.json under %s: run tools/sound/screen.py first" % root)
            return 1
        screen = json.loads(sj.read_text(encoding="utf-8"))
        fams = {f["id"]: f for f in json.loads((HERE / "prompts.json").read_text(encoding="utf-8"))["families"]}
        target.mkdir(parents=True)
        for c in screen["chosen"]:
            fam = fams[c["family"]]
            sid = c["id"]
            src = root / "_listen" / (sid + ".wav")
            if not src.is_file():
                print("missing: %s" % src)
                return 1
            x, sr = sf.read(str(src), dtype="float64", always_2d=True)
            if sr != 48000:
                print("%s is not 48 kHz" % src)
                return 1
            wav = target / (sid + ".wav")
            synth.write_wav(wav, x[:, 0] if x.shape[1] == 1 else x, dither_seed=sid)
            data, sr = common.load_audio(wav)
            an = measure.analyse(data, sr, loop=False)
            measure.write_png(wav.with_suffix(".png"), sid, data, sr, an)
            failed = []
            if an["truePeakDb"] > -1.0:
                failed.append("true-peak")
            if an["clippedSamples"] > 0:
                failed.append("clipped")
            if an["dcOffset"] >= 0.001:
                failed.append("dc-offset")
            if np.abs(data[-int(0.010 * sr):]).max() > 10 ** (-60 / 20):
                failed.append("tail-not-silent")
            de_name, en_name = NAMES[c["source"]]
            second = c["slot"] == 4 or c["role"] != "typical"
            intent, licence = describe_source(c, fam)
            ch = int(data.shape[1])
            checks = {"pass": not failed, "failed": failed, "hints": [HINT],
                      "peakDb": an["truePeakDb"], "lufs": an["lufs"], "lowShare": an["lowShare"],
                      "highShare": an["highShare"], "centroidHz": an["spectralCentroidHz"]}
            download = c["source"] == "oga"
            if download:
                checks["sourceClipped"] = False
            entry = {
                "id": sid, "file": "%s/%s.wav" % (CATEGORY, sid), "spectrogram": "%s/%s.png" % (CATEGORY, sid),
                "category": CATEGORY, "kind": "oneshot", "path": "energy" if c["family"] == "shield" else "structure",
                "en": "%s · %s%s" % (fam["en"], en_name, SECOND[1] if second else ""),
                "de": "%s · %s%s" % (fam["de"], de_name, SECOND[0] if second else ""),
                "intent": intent, "source": "download" if download else "synth", "licence": licence,
                "duration": round(data.shape[0] / sr, 4), "channels": ch, "gain": 1.0, "dry": False,
                "hash": build.file_hash(wav), "checks": checks,
                "candidate": {"source": c["source"], "family": c["family"], "slot": c["slot"], "role": c["role"],
                              "raw": c["raw"], "cut": c["cut"], "listen": c["listen"]},
            }
            if ch == 1:
                entry["place"] = 0  # a fixed place, ahead: otherwise the page picks a new direction on every play
            wav.with_suffix(".json").write_text(
                json.dumps({"manifest": entry, "measure": an}, indent=1, default=build._json_default), encoding="utf-8")
            print("%-26s %5.2f s %d ch  %6.1f LUFS  tp %5.1f dB  %s" % (
                sid, entry["duration"], ch, an["lufs"], an["truePeakDb"], "ok" if not failed else "FAILED " + ",".join(failed)))

    manifest = build.assemble_manifest(out, measure, common)
    bad = build.validate_manifest(manifest, out)
    n = sum(1 for s in manifest["sounds"] if s["category"] == CATEGORY)
    print("manifest: %d sounds, %d in %r" % (len(manifest["sounds"]), n, CATEGORY))
    for b in bad:
        print("manifest problem: " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
