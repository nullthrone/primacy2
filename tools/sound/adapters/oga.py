"""OpenGameArt recordings (CC0 per item) for the sound comparison, key "oga".

Run (no graphics card, so no lock; numpy and soundfile are enough):
    .venv-audio/Scripts/python.exe -I tools/sound/adapters/oga.py [--family hull]

There is no model here. The table tools/sound/oga_cuts.json says, per excerpt, which file of
which download (assets/audio/downloads.json, fetched by tools/audio/fetch.py) is cut from where
to where, and whose item it is. This script reads the table and writes

    assets/audio/gen/oga/raw/<family>__<name>.wav   the excerpt exactly as decoded: the file's own
                                                    sample rate and channels, float32, no gain,
                                                    no fade, no resampling, no channel mix
    assets/audio/gen/oga/gen.json                   per excerpt: family, title, author, pageUrl,
                                                    licence, sourceFile, cutS [start, end]

It refuses an excerpt whose download entry is missing, whose page is not the entry's page, or
whose licence line is not CC0. An .ogg source is decoded by libsndfile (lossy to float32); the
excerpt is therefore not bit-identical to a lossless recording, and the record says so.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import common  # noqa: E402
import soundfile as sf  # noqa: E402

CUTS = common.HERE / "oga_cuts.json"
DOWNLOADS = common.ROOT / "assets" / "audio" / "downloads"
LIST = common.ROOT / "assets" / "audio" / "downloads.json"


def main() -> int:
    ap = argparse.ArgumentParser(description="Cut the OpenGameArt excerpts listed in tools/sound/oga_cuts.json")
    ap.add_argument("--family", help="only this family id (hull, thruster, gear, shield)")
    args = ap.parse_args()

    table = json.loads(CUTS.read_text(encoding="utf-8"))
    entries = {e["id"]: e for e in json.loads(LIST.read_text(encoding="utf-8"))["entries"]}
    known = {f["id"] for f in common.load_prompts()["families"]}

    rec = common.Record("oga", note="Recordings from opengameart.org, CC0 per item (the page of each says so). "
                                    "Cut by tools/sound/oga_cuts.json; nothing else is done to the samples.")
    rec.data["items"] = {}  # the table is the truth: no leftovers of an earlier table
    made = 0
    for c in table["cuts"]:
        if c["family"] not in known:
            raise SystemExit("unknown family %r in %s" % (c["family"], c["name"]))
        if args.family and c["family"] != args.family:
            continue
        entry = entries.get(c["entry"])
        if entry is None or not c["entry"].startswith("oga-"):
            raise SystemExit("%s: no OpenGameArt download entry %r" % (c["name"], c["entry"]))
        if entry["pageUrl"] != c["pageUrl"]:
            raise SystemExit("%s: page differs from the entry" % c["name"])
        if not entry["licence"].startswith("CC0") or not c["licence"].startswith("CC0"):
            raise SystemExit("%s: licence is not CC0" % c["name"])
        path = DOWNLOADS / c["entry"] / Path(*c["file"].split("/"))
        if DOWNLOADS.resolve() not in path.resolve().parents:
            raise SystemExit("%s: file escapes the downloads directory" % c["name"])
        x, sr = sf.read(str(path), dtype="float32", always_2d=False)
        n0 = int(round(c["startS"] * sr))
        n1 = len(x) if c["endS"] is None else min(len(x), int(round(c["endS"] * sr)))
        if not 0 <= n0 < n1:
            raise SystemExit("%s: empty cut %r-%r of %.3f s" % (c["name"], c["startS"], c["endS"], len(x) / sr))
        out = common.raw_dir("oga") / ("%s__%s.wav" % (c["family"], c["name"]))
        info = common.write_wav(out, x[n0:n1], sr)
        info.update({
            "family": c["family"], "title": c["title"], "author": c["author"], "pageUrl": c["pageUrl"],
            "licence": c["licence"],
            "sourceFile": "%s/%s" % (c["entry"], c["file"]),
            "cutS": [round(n0 / sr, 4), round(n1 / sr, 4)],
            "sourceDecodedFrom": Path(c["file"]).suffix.lower().lstrip("."),
        })
        rec.data["items"]["%s__%s" % (c["family"], c["name"])] = info
        made += 1
        print("%-34s %.2f s, %d ch, %d Hz, peak %.3f" % (out.stem, info["audio_s"], info["channels"], sr, info["peak"]))
    rec.save()
    print("%d excerpts" % made)
    return 0


if __name__ == "__main__":
    sys.exit(main())
