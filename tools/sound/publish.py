"""Put the chosen candidates of the sound-source listening test onto the audition page, or take them off.

    .venv-audio/Scripts/python.exe tools/sound/publish.py            write assets/audio/render/source
    .venv-audio/Scripts/python.exe tools/sound/publish.py --remove   delete it and rebuild the manifest
    .venv-audio/Scripts/python.exe tools/sound/publish.py --prompts-file tools/sound/prompts5.json --root assets/audio/gen/r5
                                                                     round 5: category "events5" (render/events5)

Takes assets/audio/gen/screen.json (written by screen.py) and the listening copies under
assets/audio/gen/_listen/, writes each as a file of the category "source" (listed first in
tools/audio/sounds.json as "Klangquellen (Runde 4)"), 16 bit at 48 kHz through the sound library's
own writer, with spectrogram and record as tools/voice/publish.py does for the voice samples, then
removes every file in render/source that does not belong to the new set (the manifest is assembled
from whatever lies there), assembles the manifest and validates it. The order of manifest.json is
the one of tools/audio/build.py; the page lists the categories in the order of manifest.categories,
and tools/dev/audition-check.mjs finds its first rows that way. Runs with the environment of the
sound library, which it only reads. --root and --out name other folders (the tests use them).

--prompts-file names the prompts file whose families are on the page; its "category" gives the id of the category
(the folder under render, which is the only one that is pruned), the names and the id prefix. The default is
tools/sound/prompts.json and the category "source", as in round 4. The screen.json that is read must have been
made with the same prompts file.
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

DEFAULT_CATEGORY = "source"
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
ORDINALS = ((None, None), ("zweite", "second"), ("dritte", "third"), ("vierte", "fourth"), ("fünfte", "fifth"), ("sechste", "sixth"))
LICENCE = {
    "moss": "generated with MOSS-SoundEffect v2.0 (code and weights Apache-2.0)",
    "sa3": "generated with Stable Audio 3 Small-SFX Base (Stability AI Community License): test material, not to be "
           "shipped until the owner has decided",
}


LOW_SHARE_HINT = 0.10  # below this share of the energy above 60 Hz the page shows a hint (a measure shown, not a rule)


def _first(d: dict, keys: tuple, default: str = "unknown") -> str:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return default


def pick_suffix(rank: int) -> tuple[str, str]:
    """The ending of the name of a further pick of the same source: second pick, third pick, ..."""
    if rank <= 1:
        return "", ""
    de, en = ORDINALS[rank - 1] if rank <= len(ORDINALS) else ("%d." % rank, "%dth" % rank)
    return ", %s Auswahl" % de, ", %s pick" % en


def describe_source(c: dict, fam: dict) -> tuple[str, str]:
    """(intent, licence) of a chosen candidate."""
    rec = c.get("record", {})
    cut = c["cut"]
    lis = c["listen"]
    how = ("Cut out of the raw file (%.2f to %.2f s)%s. Level: family target %s LUFS (one channel); as the page plays "
           "it in the Stereo stage, over two channels with a one-channel file counted on both, %s LUFS, reached %s." % (
               cut["startS"], cut["endS"], ", at the family's longest length" if cut.get("cappedAtFamilyLength") else "",
               lis["lufsTarget"], lis.get("lufsPageTarget", "?"), lis.get("lufsReachedPage", "?")))
    share = c.get("energyAbove60Hz")
    if share is not None:
        how += " Share of the event's energy above 60 Hz: %d %%." % round(100 * share)
    if "picks" in fam:  # round 5: the family names the sources of its slots
        if c.get("sourceRank", 1) > 1:
            how += " A further pick of this source: the candidate farthest from the picks already made in this family in the description used for variety."
        else:
            how += " Chosen as the most typical candidate of its source in this family."
    elif c["role"] != "typical" or c["slot"] == 4:
        how += (" Second pick: " + ("the candidate farthest from the other three in the description used for variety."
                                    if c["role"] == "farthest" else "chosen because this family has no candidate from the source of its slot."))
    else:
        how += " Chosen as the most typical candidate of its source in this family."
    if "proven" in fam:
        # 'provenRound' of the family names the round in which he accepted the prompt (round 4 where it is not given,
        # which is what every proven family of prompts5.json rests on)
        how += (" This family rests on a prompt the owner accepted in round %d." % int(fam.get("provenRound", 4)) if fam["proven"]
                else " This family is a first try: no prompt of it has been heard yet.")
    if rec.get("fromRound4"):
        how += " The file was made in round 4 (prompt %s, seed %s) and was not heard then." % (rec.get("round4Prompt", rec.get("prompt", "?")), rec.get("seed", "?"))
    if c["listen"].get("limitedByPeak"):
        how += " The true peak ceiling lowered the gain: the loudness reached is %s LUFS on the page." % lis.get("lufsReachedPage", lis["lufsReached"])
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


def prune(target: Path, keep_ids: set[str]) -> list[str]:
    """Delete every file in the folder of the category whose id (the name up to the first dot) is not in the
    new set: build.assemble_manifest lists whatever record lies there, so a file of an earlier pick would
    stay on the page. Returns the names removed."""
    gone = []
    for p in sorted(target.iterdir()):
        if p.name.split(".")[0] not in keep_ids:
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
            gone.append(p.name)
    return gone


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--root", default=str(ROOT / "assets" / "audio" / "gen"), help="folder with screen.json and _listen")
    ap.add_argument("--out", default=str(ROOT / "assets" / "audio" / "render"))
    ap.add_argument("--prompts-file", default=str(HERE / "prompts.json"), metavar="FILE",
                    help="the prompts file whose families are published (default tools/sound/prompts.json, round 4)")
    a = ap.parse_args(argv)

    import build  # tools/audio/build.py
    import common  # tools/audio/listen/common.py
    import measure  # tools/audio/listen/measure.py
    import soundfile as sf
    import synth

    out = Path(a.out).resolve()
    root = Path(a.root).resolve()
    spec = json.loads(Path(a.prompts_file).read_text(encoding="utf-8"))
    cat = spec.get("category") or {}
    CATEGORY = cat.get("id", DEFAULT_CATEGORY)
    id_prefix = cat.get("idPrefix", "src")
    target = out / CATEGORY
    if a.remove and target.exists():
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
        fams = {f["id"]: f for f in spec["families"]}
        made_for = (screen.get("category") or {}).get("id", DEFAULT_CATEGORY)
        if made_for != CATEGORY:
            print("%s was made for the category %r, not %r: run screen.py with the same --prompts-file" % (sj, made_for, CATEGORY))
            return 1
        target.mkdir(parents=True, exist_ok=True)
        new_ids = {c["id"] for c in screen["chosen"]}
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
            if "picks" in fam:  # round 5: second pick, third pick, ... by the order of the slots within the source
                rank = c.get("sourceRank") or 1 + sum(1 for o in screen["chosen"] if o["family"] == c["family"]
                                                      and o["source"] == c["source"] and o["slot"] < c["slot"])
                suffix_de, suffix_en = pick_suffix(rank)
            else:
                suffix_de, suffix_en = (SECOND[0], SECOND[1]) if second else ("", "")
            intent, licence = describe_source(c, fam)
            ch = int(data.shape[1])
            share = c.get("energyAbove60Hz")
            hints = [HINT]
            if share is not None and share < LOW_SHARE_HINT:
                hints.append("only %d %% of the energy is above 60 Hz: it may play as silence on most loudspeakers" % round(100 * share))
            checks = {"pass": not failed, "failed": failed, "hints": hints,
                      "peakDb": an["truePeakDb"], "lufs": an["lufs"], "lowShare": an["lowShare"],
                      "highShare": an["highShare"], "centroidHz": an["spectralCentroidHz"]}
            if share is not None:
                checks["energyAbove60Hz"] = share
            download = c["source"] == "oga"
            if download:
                checks["sourceClipped"] = False
            entry = {
                "id": sid, "file": "%s/%s.wav" % (CATEGORY, sid), "spectrogram": "%s/%s.png" % (CATEGORY, sid),
                "category": CATEGORY, "kind": "oneshot", "path": "energy" if c["family"].startswith("shield") else "structure",
                "en": "%s · %s%s" % (fam["en"], en_name, suffix_en),
                "de": "%s · %s%s" % (fam["de"], de_name, suffix_de),
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

    if not a.remove:
        for old in prune(target, new_ids):
            print("removed %s (not part of the new set)" % old)
    manifest = build.assemble_manifest(out, measure, common)
    bad = build.validate_manifest(manifest, out)
    n = sum(1 for s in manifest["sounds"] if s["category"] == CATEGORY)
    print("manifest: %d sounds, %d in %r" % (len(manifest["sounds"]), n, CATEGORY))
    for b in bad:
        print("manifest problem: " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
