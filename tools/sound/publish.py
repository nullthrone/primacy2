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
    "derived": "generated with MOSS-SoundEffect v2.0 (code and weights Apache-2.0), processed with tools/sound/derive.py",
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


def _g(v) -> str:
    return "%g" % v


def _derive():
    """tools/sound/derive.py, loaded by its path (the folder of this script is not always on the path, and tools/audio has a common.py of
    its own). The shelf numbers of the page text are read off the filter itself."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("sound_derive", HERE / "derive.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("sound_derive", mod)
    spec.loader.exec_module(sys.modules["sound_derive"])
    return sys.modules["sound_derive"]


def describe_process(process: list[dict], numbers: dict) -> str:
    """The operations of a derived candidate in plain words with their numbers (plan and run)."""
    ops = numbers.get("operations", [])
    out = []
    for i, p in enumerate(process):
        o = ops[i] if i < len(ops) else {}
        if p["op"] == "room":
            nch = int(p["channels"])
            t = ("A room was added: decay time (60 dB) %s s, wet level %s dB against the dry sound%s, %s." % (
                _g(p["rt60S"]), _g(p["wetDb"]),
                " (reached %s dB)" % _g(o["wetDryDbReached"]) if "wetDryDbReached" in o else "",
                "one channel" if nch == 1 else "two channels, the direct sound stays in the middle"))
        elif p["op"] == "pitch":
            r, e = numbers.get("raw", {}), numbers.get("result", {})
            t = "Tuned %s semitones %s by resampling, so the sound is shorter%s." % (
                _g(abs(p["semitones"])), "higher" if p["semitones"] >= 0 else "lower",
                ": %s s instead of %s s" % (_g(e["lengthS"]), _g(r["lengthS"])) if r and e else "")
        elif p["op"] == "shelf":
            t = "The sound was filtered with %s." % _derive().shelf_words(float(p["hz"]), float(p["gainDb"]))
        elif p["op"] == "append":
            lv = o.get("levelsDbUnderPeak") or {}
            what = "the raw file" if i == 0 else "the sound as it was at that point"
            t = ("A copy of the samples from %s s to %s s of %s was appended to its end (no fade, no gain): the appended part, "
                 "%s s long, is a copy, not new material%s." % (
                     _g(p["fromS"]), _g(p["toS"]), what, _g(o.get("copiedS", p["toS"] - p["fromS"])),
                     "; it starts at %s s. Levels under the peak: last 10 ms before the splice %s dB, first 10 ms of the copy %s dB, "
                     "last 10 ms of the copy %s dB; largest sample step within 1 ms of the splice %s" % (
                         _g(o["spliceS"]), _g(lv.get("beforeSpliceDb")), _g(lv.get("copyFirstDb")), _g(lv.get("copyLastDb")),
                         _g(o.get("maxStepWithin1ms"))) if "spliceS" in o else ""))
        else:
            t = "Operation %s." % p["op"]
        if o.get("outputGainDb"):
            t += " The output was scaled by %s dB to stay under a peak of 0.999." % _g(o["outputGainDb"])
        out.append(t)
    return " ".join(out)


def _typical_sentence(c: dict, screen: dict | None) -> str:
    """The sentence for the first pick of a source. In a round-7 screen.json (it lists "derived" among its sources) a pick that was
    the only one left to choose from does not get "most typical": nothing was weighed, and the sentence counts what ruled the others out.
    Every other case, and every older round, keeps the sentence it always had."""
    usual = " Chosen as the most typical candidate of its source in this family."
    if not screen or "derived" not in (screen.get("sources") or []):
        return usual
    rows = [f for f in screen.get("files", []) if f.get("family") == c["family"] and f.get("source") == c["source"]
            and f.get("status") == "kept" and not f.get("fixed")]
    free = [f for f in rows if not (f.get("notPickedShots") or f.get("notPickedLowShare") or f.get("notPickedSaturatedNoise")
                                    or f.get("skip") or f.get("skipped"))]
    if len(free) != 1 or len(rows) < 2:
        return usual
    n_shots = sum(1 for f in rows if f.get("notPickedShots"))
    n_low = sum(1 for f in rows if f.get("notPickedLowShare"))
    n_sat = sum(1 for f in rows if f.get("notPickedSaturatedNoise"))
    n_skip = sum(1 for f in rows if f.get("skip") or f.get("skipped"))
    why = [t for t in ("%d with another number of shots than the family asks for" % n_shots if n_shots else "",
                       "%d under the family's smallest share of energy above 60 Hz" % n_low if n_low else "",
                       "%d pressed noise" % n_sat if n_sat else "", "%d on the hand skip list" % n_skip if n_skip else "") if t]
    return (" The only eligible candidate of its source in this family: of the %d kept candidates of this source, the other %d were "
            "ruled out (%s), so no typicality was weighed." % (len(rows), len(rows) - 1, "; ".join(why)))


def describe_source(c: dict, fam: dict, screen: dict | None = None) -> tuple[str, str]:
    """(intent, licence) of a chosen candidate."""
    rec = c.get("record", {})
    cut = c["cut"]
    lis = c["listen"]
    derived = c["source"] == "derived"
    how = ("Cut out of the %s file (%.2f to %.2f s)%s. Level: family target %s LUFS (one channel); as the page plays "
           "it in the Stereo stage, over two channels with a one-channel file counted on both, %s LUFS, reached %s." % (
               "processed" if derived else "raw", cut["startS"], cut["endS"], ", at the family's longest length" if cut.get("cappedAtFamilyLength") else "",
               lis["lufsTarget"], lis.get("lufsPageTarget", "?"), lis.get("lufsReachedPage", "?")))
    share = c.get("energyAbove60Hz")
    if share is not None:
        how += " Share of the event's energy above 60 Hz: %d %%." % round(100 * share)
    if c.get("role") == "fixed":
        how += " A fixed candidate: it is on the page whatever the rules find, no pick rule applies to it."
    elif c.get("pressedNoiseFallback"):  # round 6/7: a fallback is never called "the most typical candidate"
        rule = fam.get("notSaturatedNoise") or {}
        how += (" A fallback, not a typical pick: no candidate of this family was left that is not pressed noise, and this one was "
                "put in to fill the slot (the one with the lowest level of them). Its loudest 50 ms is %s dBFS and its share above 2 kHz "
                "in the loud frames is %s; the family's limits are above %s dBFS and %s or more, so it is over both." % (
                    "%.2f" % c["loud50Db"] if c.get("loud50Db") is not None else "unknown",
                    "%.4f" % c["above2kHzLoud"] if c.get("above2kHzLoud") is not None else "unknown",
                    _g(rule["loud50Db"]) if "loud50Db" in rule else "unknown",
                    _g(rule["above2kHz"]) if "above2kHz" in rule else "unknown"))
    elif "picks" in fam:  # round 5: the family names the sources of its slots
        if c.get("sourceRank", 1) > 1:
            how += " A further pick of this source: the candidate farthest from the picks already made in this family in the description used for variety."
        else:
            how += _typical_sentence(c, screen)
    elif c["role"] != "typical" or c["slot"] == 4:
        how += (" Second pick: " + ("the candidate farthest from the other three in the description used for variety."
                                    if c["role"] == "farthest" else "chosen because this family has no candidate from the source of its slot."))
    else:
        how += " Chosen as the most typical candidate of its source in this family."
    if fam.get("proven") is True:
        # 'provenRound' of the family names the round in which he accepted the prompt (round 4 where it is not given,
        # which is what every proven family of prompts5.json rests on)
        how += " This family rests on a prompt the owner accepted in round %d." % int(fam.get("provenRound", 4))
    elif fam.get("history"):  # round 7: a sentence of the plan replaces the sentence that the family is a first try
        how += " " + str(fam["history"]).strip()
    elif "proven" in fam:
        how += " This family is a first try: no prompt of it has been heard yet."
    if rec.get("fromRound4"):
        how += " The file was made in round 4 (prompt %s, seed %s) and was not heard then." % (rec.get("round4Prompt", rec.get("prompt", "?")), rec.get("seed", "?"))
    if c["listen"].get("limitedByPeak"):
        how += " The true peak ceiling lowered the gain: the loudness reached is %s LUFS on the page." % lis.get("lufsReachedPage", lis["lufsReached"])
    if derived:
        d = rec.get("derived") or {}
        frm = d.get("from") or {}
        made = "Made from the raw file of the candidate %s of round %s, which the owner called %s. %s " % (
            frm.get("candidate", "?"), frm.get("round", "?"), frm.get("verdict", "?"),
            describe_process(d.get("process", []), d.get("numbers", {})))
        intent = made + how
        if c["family"].startswith("thruster") and c.get("shots") is not None:
            intent += " Measured in the file: %d separate shots." % c["shots"]
        return intent, LICENCE["derived"]
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
    if c["family"].startswith("thruster") and c.get("shots") is not None:
        intent += " Measured in the file: %d separate shots." % c["shots"]
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
            if c["source"] == "derived":  # round 7: the family's name, then the name of the item in the plan
                item = next(it for it in fam["derived"] if it["id"] == c["name"])
                de_name, en_name = item["de"], item["en"]
                suffix_de = suffix_en = ""
            else:
                de_name, en_name = NAMES[c["source"]]
            second = c["slot"] == 4 or c["role"] != "typical"
            if c["source"] == "derived":
                pass
            elif "picks" in fam:  # round 5: second pick, third pick, ... by the order of the slots within the source
                rank = c.get("sourceRank") or 1 + sum(1 for o in screen["chosen"] if o["family"] == c["family"]
                                                      and o["source"] == c["source"] and o["slot"] < c["slot"])
                suffix_de, suffix_en = pick_suffix(rank)
            else:
                suffix_de, suffix_en = (SECOND[0], SECOND[1]) if second else ("", "")
            intent, licence = describe_source(c, fam, screen)
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
            if c["source"] == "derived":
                entry["candidate"]["derived"] = {k: v for k, v in (c.get("record", {}).get("derived") or {}).items()}
            if c.get("shots") is not None:
                entry["candidate"]["shots"] = c["shots"]
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
