"""Bring the unheard, kept candidates of round 4 into the pool of the families of round 5 that ask for them.

    .venv-audio/Scripts/python.exe tools/sound/from_round4.py [--dry-run]
        [--prompts-file tools/sound/prompts5.json] [--round4 assets/audio/gen] [--out-root assets/audio/gen/r5]

For every family of the prompts file that has "fromRound4": {"prompt": "thruster_1" | ["shield_1", "shield_3"],
"sources": ["moss"] (optional), "exclude": ["moss/thruster_1__s11"] (optional)}, one item per candidate of round 4
that

- belongs to one of the named prompts (the "prompt" of its item in <round4>/<source>/gen.json),
- has the status "kept" in <round4>/screen.json (thrown out candidates are not brought along),
- comes from one of "sources" when that is given,
- is not in "exclude" (as source/name), and
- was not published in round 4 (is not one of the "chosen" of that screen.json: the owner has heard those),

is added to <out-root>/<source>/gen.json. The item is a copy of the round-4 item with its "family" set to the
round-5 family, "fromRound4": true, and "file" naming the raw file where it lies: nothing is copied or moved, and
nothing under the round-4 folders is written. A hand skip that the candidate had in round 4 is carried as
"round4Skip" (the same file with the same cut has the same plain fault; screen.py then never picks it).

It is safe to run twice: items without "fromRound4" are never touched, items with it are made again from the same
sources, and one that no longer matches (the prompts file changed) is removed. It can run before or after the
adapters have made the new candidates: they add their items to the same gen.json and keep these.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GEN = ROOT / "assets" / "audio" / "gen"
PROMPTS5 = HERE / "prompts5.json"


def as_list(v) -> list:
    if v is None:
        return []
    return list(v) if isinstance(v, (list, tuple)) else [v]


def wanted_items(spec: dict, round4: Path) -> dict[str, dict[str, dict]]:
    """{source: {name: item}} of what the families of the prompts file take from round 4."""
    screen = json.loads((round4 / "screen.json").read_text(encoding="utf-8"))
    published = {(c["source"], c["name"]) for c in screen["chosen"]}
    rows = {(r["source"], r["name"]): r for r in screen["files"]}
    gens: dict[str, dict] = {}
    out: dict[str, dict[str, dict]] = {}
    claimed: dict[tuple[str, str], str] = {}
    for fam in spec["families"]:
        want = fam.get("fromRound4")
        if not want:
            continue
        prompts = set(as_list(want.get("prompt")))
        sources = set(as_list(want.get("sources"))) or None
        exclude = {str(e).strip() for e in as_list(want.get("exclude"))}
        if not prompts:
            raise ValueError("family %s: fromRound4 names no prompt" % fam["id"])
        for (source, name), row in sorted(rows.items()):
            if row.get("status") != "kept" or (sources and source not in sources):
                continue
            if "%s/%s" % (source, name) in exclude or (source, name) in published:
                continue
            if source not in gens:
                gj = round4 / source / "gen.json"
                gens[source] = json.loads(gj.read_text(encoding="utf-8")).get("items", {}) if gj.is_file() else {}
            item = gens[source].get(name)
            if item is None or item.get("prompt") not in prompts:
                continue
            if (source, name) in claimed:
                raise ValueError("%s/%s is wanted by the families %s and %s" % (source, name, claimed[(source, name)], fam["id"]))
            claimed[(source, name)] = fam["id"]
            new = dict(item)
            new["file"] = item.get("file") or row.get("file")
            new.update({"family": fam["id"], "fromRound4": True, "round4Family": item.get("family"),
                        "round4Prompt": item.get("prompt")})
            if row.get("skippedAsPick"):
                new["round4Skip"] = row["skippedAsPick"]
            out.setdefault(source, {})[name] = new
    return out


def merge(out_root: Path, wanted: dict[str, dict[str, dict]], dry_run: bool = False, keys=()) -> dict[str, dict]:
    """Write the wanted items into <out_root>/<source>/gen.json. Returns {source: {"added", "kept", "removed"}}."""
    res: dict[str, dict] = {}
    for source in sorted(set(wanted) | set(keys)):
        path = out_root / source / "gen.json"
        data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"source": source, "items": {}}
        items = data.setdefault("items", {})
        new = wanted.get(source, {})
        for name in new:
            if name in items and not items[name].get("fromRound4"):
                raise ValueError("%s already has an item %r that is not from round 4" % (path, name))
        stale = [n for n, it in items.items() if it.get("fromRound4") and n not in new]
        added = [n for n in new if n not in items]
        for n in stale:
            del items[n]
        items.update(new)
        res[source] = {"added": sorted(added), "kept": sorted(n for n in new if n not in added), "removed": sorted(stale)}
        if not dry_run and (added or stale or not path.is_file() or any(items[n] != new[n] for n in new)):
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                json.dump(data, f, indent=1, ensure_ascii=False)
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--prompts-file", default=str(PROMPTS5))
    ap.add_argument("--round4", default=str(GEN), help="the round-4 folder with screen.json and the source folders")
    ap.add_argument("--out-root", default=str(GEN / "r5"))
    ap.add_argument("--dry-run", action="store_true", help="list what would be written, write nothing")
    a = ap.parse_args(argv)
    spec = json.loads(Path(a.prompts_file).read_text(encoding="utf-8"))
    round4, out_root = Path(a.round4).resolve(), Path(a.out_root).resolve()
    if round4 == out_root:
        print("the round-4 folder and the output root are the same")
        return 2
    wanted = wanted_items(spec, round4)
    # a source that already has from-round-4 items in the output must be visited, so that stale ones go
    keys = [p.parent.name for p in out_root.glob("*/gen.json")] if out_root.is_dir() else []
    res = merge(out_root, wanted, a.dry_run, keys)
    for source, r in res.items():
        print("%-5s added %2d, already there %2d, removed %d" % (source, len(r["added"]), len(r["kept"]), len(r["removed"])))
    by_fam: dict[str, list[str]] = {}
    for source, items in wanted.items():
        for name, it in items.items():
            by_fam.setdefault(it["family"], []).append("%s/%s%s" % (source, name, " (round-4 skip)" if it.get("round4Skip") else ""))
    for fam, names in sorted(by_fam.items()):
        print("%s: %d candidates from round 4: %s" % (fam, len(names), ", ".join(sorted(names))))
    print("dry run, nothing written" if a.dry_run else "wrote under %s" % out_root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
