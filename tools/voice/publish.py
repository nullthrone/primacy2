"""Put the listening set of the voice comparison onto the audition page, or take it off again.

    .venv-audio/Scripts/python.exe tools/voice/publish.py            write assets/audio/render/voice
    .venv-audio/Scripts/python.exe tools/voice/publish.py --remove   delete it and rebuild the manifest

The set is listening.json: a few lines, each spoken by every model. The source of each file is the
loudness-matched dry copy that score.py --listen wrote (assets/audio/voice/_listen). Here the
silence a model leaves before and after a line is cut, the file is written the way the sound
library writes its files (48 kHz, 16 bit), measured and drawn, and given a record like a rendered
sound, so that the manifest takes it up and the owner can rate it on the page. Lines of the role
radio keep the path "radio": the page then plays them through its radio filter.

A "composed" block of listening.json lists files that countdown.py made; they follow the lines as further entries
and are not trimmed.

Runs with the environment of the sound library, which it only reads. The category itself
(listening.json, "category") must be listed in tools/audio/sounds.json.
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
sys.path.insert(0, str(AUDIO))
sys.path.insert(0, str(AUDIO / "listen"))

LISTEN = ROOT / "assets" / "audio" / "voice" / "_listen"
SR = 48000
SILENCE_DB = -50.0   # what counts as the silence around a line
LEAD_S = 0.003       # kept before the first sound (the library's rule: a one-shot starts within 5 ms)
TAIL_S = 0.150       # kept after the last sound
FADE_OUT_S = 0.030
HINT = "speech sample: only the level rules apply"


def trim(x: np.ndarray) -> tuple[np.ndarray, dict]:
    """Cut the silence before and after the speech; fade the kept edges."""
    win = int(0.010 * SR)
    k = x.size // win
    rms = np.sqrt((x[: k * win].reshape(k, win) ** 2).mean(axis=1))
    loud = np.flatnonzero(rms >= 10 ** (SILENCE_DB / 20.0))
    if loud.size == 0:
        raise ValueError("the file is silent")
    a = max(0, loud[0] * win - int(LEAD_S * SR))
    b = min(x.size, (loud[-1] + 1) * win + int(TAIL_S * SR))
    y = np.array(x[a:b], dtype=np.float64)
    lead = min(int(LEAD_S * SR), y.size)
    y[:lead] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(lead) / max(lead, 1))
    tail = min(int(FADE_OUT_S * SR), y.size)
    y[-tail:] *= 0.5 + 0.5 * np.cos(np.pi * (np.arange(tail) + 1) / tail)
    return y, {"cutStartS": round(a / SR, 3), "cutEndS": round((x.size - b) / SR, 3)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "assets" / "audio" / "render"))
    a = ap.parse_args()

    import soundfile as sf

    import build  # tools/audio/build.py
    import common  # tools/audio/listen/common.py
    import measure  # tools/audio/listen/measure.py
    import synth

    out = Path(a.out).resolve()
    cfg = json.loads((HERE / "listening.json").read_text(encoding="utf-8"))
    cat = cfg["category"]["id"]
    target = out / cat
    if target.exists():
        shutil.rmtree(target)
    if not a.remove:
        if cat not in synth.load_spec()["categories"]:
            print("the category %r is not listed in tools/audio/sounds.json" % cat)
            return 2
        lines = {ln["id"]: ln for ln in json.loads((HERE / "lines.json").read_text(encoding="utf-8"))["lines"]}
        target.mkdir(parents=True)
        for li in cfg["lines"]:
            line = lines[li["line"]]
            radio = line["role"] == "radio"
            for mo in cfg["models"]:
                sid = "%s_%s_%s" % (cat, li["slug"], mo["slug"])
                src = LISTEN / ("%s__%s__dry.wav" % (mo["key"], li["line"]))
                if not src.is_file():
                    src = LISTEN / ("%s__%s.wav" % (mo["key"], li["line"]))
                if not src.is_file():
                    print("missing: %s" % src)
                    return 1
                x, sr = sf.read(str(src), always_2d=True)
                if sr != SR:
                    print("%s is not 48 kHz" % src)
                    return 1
                y, cut = trim(x.mean(axis=1))
                wav = target / (sid + ".wav")
                synth.write_wav(wav, y, dither_seed=sid)
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
                if np.abs(data[-int(0.010 * SR):]).max() > 10 ** (-60 / 20):
                    failed.append("tail-not-silent")
                entry = {
                    "id": sid, "file": "%s/%s.wav" % (cat, sid), "spectrogram": "%s/%s.png" % (cat, sid),
                    "category": cat, "kind": "oneshot", "path": "radio" if radio else "cabin",
                    # a fixed place, ahead: without one the page puts a one-channel sound at a new random
                    # direction on every play (behind the listener it is also made duller), and no two
                    # plays of a voice could be compared
                    "place": 0,
                    "en": "%s · %s" % (li["en"], mo["name"]), "de": "%s · %s" % (li["de"], mo["name"]),
                    "intent": "The line: \"%s\" %s" % (line["text"], mo["about"]),
                    "source": "synth", "licence": mo["licence"],
                    "duration": round(data.shape[0] / sr, 4), "channels": 1, "gain": 1.0, "dry": True,
                    "hash": build.file_hash(wav),
                    "checks": {"pass": not failed, "failed": failed, "hints": [HINT],
                               "peakDb": an["truePeakDb"], "lufs": an["lufs"],
                               "lowShare": an["lowShare"], "highShare": an["highShare"],
                               "centroidHz": an["spectralCentroidHz"]},
                    "voice": {"model": mo["key"], "device": mo["device"], "line": li["line"],
                              "source": str(src.relative_to(ROOT)).replace("\\", "/"), **cut},
                }
                wav.with_suffix(".json").write_text(
                    json.dumps({"manifest": entry, "measure": an}, indent=1, default=build._json_default),
                    encoding="utf-8")
                print("%-34s %5.2f s  %6.1f LUFS  tp %5.1f dB  cut %.2f/%.2f s  %s" % (
                    sid, entry["duration"], an["lufs"], an["truePeakDb"], cut["cutStartS"], cut["cutEndS"],
                    "ok" if not failed else "FAILED " + ",".join(failed)))

        # Composed files (tools/voice/countdown.py) follow the lines above as further entries of the category. They
        # are written as they are: not trimmed, because the silence up to the moment of the jump is part of them.
        comp = cfg.get("composed", {})
        mods = {m["key"]: m for m in cfg["models"]}
        for e in comp.get("entries", []):
            sid, mo = e["id"], mods[e["model"]]
            src = ROOT / e["source"]
            if not src.is_file():
                print("missing: %s" % src)
                return 1
            x, sr = sf.read(str(src), always_2d=True)
            if sr != SR or x.shape[1] != 1:
                print("%s is not 48 kHz mono" % src)
                return 1
            meta = json.loads(src.with_suffix(".json").read_text(encoding="utf-8"))
            line = lines[comp.get("line", e["line"])]
            wav = target / (sid + ".wav")
            synth.write_wav(wav, x[:, 0], dither_seed=sid)
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
            if np.abs(data[-int(0.010 * SR):]).max() > 10 ** (-60 / 20):
                failed.append("tail-not-silent")
            intent = ('The line: "%s" Model: %s, voice: the designed ship-computer voice (no real person’s voice). Made so: %s. '
                      'The intro ("Fold drive charged. Destination: Ysolde Prime. Jump in") comes from one utterance of the whole line. '
                      'The numbers sit on a one-second grid by their vowel onsets: each lies exactly %d samples (one second at 48 kHz) '
                      'after the one before, and the file ends one second after the vowel onset of "one", at the moment of the jump. '
                      'Each number has a 5 ms fade and the five numbers are set to the same level by gain only. '
                      'Composed by tools/voice/countdown.py: a listening sample, not the game’s runtime.') % (
                          line["text"], mo["name"], e["how"], meta["grid_samples"])
            entry = {
                "id": sid, "file": "%s/%s.wav" % (cat, sid), "spectrogram": "%s/%s.png" % (cat, sid),
                "category": cat, "kind": "oneshot", "path": e["path"], "place": e["place"],
                "en": e["en"], "de": e["de"], "intent": intent,
                "source": "synth", "licence": mo["licence"],
                "duration": round(data.shape[0] / sr, 4), "channels": 1, "gain": 1.0, "dry": True,
                "hash": build.file_hash(wav),
                "checks": {"pass": not failed, "failed": failed, "hints": [HINT],
                           "peakDb": an["truePeakDb"], "lufs": an["lufs"],
                           "lowShare": an["lowShare"], "highShare": an["highShare"],
                           "centroidHz": an["spectralCentroidHz"]},
                "voice": {"model": mo["key"], "device": mo["device"], "line": e["line"], "variant": e["variant"],
                          "source": e["source"], "composed": True, "gridSamples": meta["grid_samples"],
                          "firstAnchorS": meta["first_anchor_s"], "anchorsSamples": meta["anchors"]},
            }
            wav.with_suffix(".json").write_text(
                json.dumps({"manifest": entry, "measure": an}, indent=1, default=build._json_default), encoding="utf-8")
            print("%-40s %5.2f s  %6.1f LUFS  tp %5.1f dB  composed  %s" % (
                sid, entry["duration"], an["lufs"], an["truePeakDb"], "ok" if not failed else "FAILED " + ",".join(failed)))

    manifest = build.assemble_manifest(out, measure, common)
    bad = build.validate_manifest(manifest, out)
    n = sum(1 for s in manifest["sounds"] if s["category"] == cat)
    print("manifest: %d sounds, %d in %r" % (len(manifest["sounds"]), n, cat))
    for b in bad:
        print("manifest problem: " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
