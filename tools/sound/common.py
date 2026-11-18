"""Shared by every adapter of the sound comparison: the prompts, where files go, the record.

Needs only numpy and soundfile, so it runs in each model's own environment. An adapter never
changes what a model returns: no trimming, no gain, no resampling, no channel mix. Cutting the
event out, levelling and choosing happen afterwards, on the files, in tools/sound/screen.py.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_OUT = ROOT / "assets" / "audio" / "gen"
DEFAULT_PROMPTS = HERE / "prompts.json"
OUT = DEFAULT_OUT  # ignored by git: candidates are made again, not committed
PROMPTS_FILE = DEFAULT_PROMPTS  # round 4; round 5 passes tools/sound/prompts5.json


def configure(prompts_file: str | None = None, out_root: str | None = None) -> None:
    """Point the module at another prompts file and another output root (--prompts-file, --out-root).
    Without arguments nothing changes: round 4 is the default."""
    global OUT, PROMPTS_FILE
    if prompts_file:
        PROMPTS_FILE = Path(prompts_file).resolve()
    if out_root:
        OUT = Path(out_root).resolve()


def load_prompts() -> dict:
    return json.loads(PROMPTS_FILE.read_text(encoding="utf-8"))


def jobs(only_family: str | None = None, only_prompts: str | None = None, seeds: str | None = None) -> list[dict]:
    """Every (family, prompt, seed) to make, in a fixed order. Seeds: --seeds if given, else the family's own
    "seeds" (round 5 has some), else the "seeds" of the file."""
    spec = load_prompts()
    cli_seeds = [int(s) for s in seeds.split(",")] if seeds else None
    want_prompts = {s.strip() for s in only_prompts.split(",")} if only_prompts else None
    out = []
    for fam in spec["families"]:
        if only_family and fam["id"] != only_family:
            continue
        want_seeds = cli_seeds or fam.get("seeds") or spec["seeds"]
        for pr in fam["prompts"]:
            if want_prompts and pr["id"] not in want_prompts:
                continue
            for seed in want_seeds:
                out.append({"family": fam["id"], "prompt": pr["id"], "text": pr["text"],
                            "seconds": fam["seconds"], "seed": seed,
                            "name": "%s__s%d" % (pr["id"], seed)})
    return out


def parse_args(description: str = "") -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--family", help="only this family id (hull, thruster, gear, shield)")
    ap.add_argument("--prompts", help="comma separated prompt ids (default: all)")
    ap.add_argument("--seeds", help="comma separated seeds (default: those of prompts.json)")
    ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    ap.add_argument("--prompts-file", metavar="FILE", help="the prompts to make (default tools/sound/prompts.json, round 4)")
    ap.add_argument("--out-root", metavar="DIR", help="where <source>/raw and <source>/gen.json go (default assets/audio/gen)")
    ap.add_argument("--list-jobs", action="store_true", help="print the jobs that would be made and stop (no model is loaded)")
    args = ap.parse_args()
    configure(args.prompts_file, args.out_root)
    return args


def print_jobs(todo: list[dict], key: str) -> None:
    """The dry listing of --list-jobs: one line per job, and which raw file is there already."""
    for j in todo:
        have = (raw_dir(key, create=False) / (j["name"] + ".wav")).is_file()
        print("%-24s family %-14s seed %3d  %ss  %s%s" % (j["name"], j["family"], j["seed"], j["seconds"],
                                                          j["text"][:60], "  [have]" if have else ""))
    print("%d jobs for %s, raw files under %s" % (len(todo), key, OUT / key / "raw"))


def raw_dir(key: str, create: bool = True) -> Path:
    d = OUT / key / "raw"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT)).replace("\\", "/")
    except ValueError:  # an output root outside the repository
        return str(path).replace("\\", "/")


def write_wav(path: Path, samples, sr: int) -> dict:
    """Write float samples as 32-bit float WAV, untouched. samples: (n,), (n, ch) or (ch, n)."""
    import soundfile as sf

    x = np.asarray(samples, dtype=np.float32)
    x = np.squeeze(x)
    if x.ndim == 2 and x.shape[0] < x.shape[1] and x.shape[0] <= 8:  # (channels, n) -> (n, channels)
        x = x.T
    if x.ndim not in (1, 2):
        raise ValueError("expected (n,) or (n, channels), got shape %r" % (x.shape,))
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), x, int(sr), subtype="FLOAT")
    return {"file": _rel(path), "sr": int(sr),
            "channels": 1 if x.ndim == 1 else int(x.shape[1]),
            "audio_s": round(x.shape[0] / float(sr), 3),
            "peak": round(float(np.max(np.abs(x))) if x.size else 0.0, 4)}


class Record:
    """Collects what was made by one source and writes gen.json beside the raw files."""

    def __init__(self, key: str, **facts):
        self.key = key
        self.path = OUT / key / "gen.json"
        self.data: dict = {"source": key, "items": {}, **facts}
        if PROMPTS_FILE != DEFAULT_PROMPTS:  # round 4's gen.json files stay as they were
            self.data["promptsFile"] = _rel(PROMPTS_FILE)
        if self.path.is_file():  # a second run adds to the first
            try:
                old = json.loads(self.path.read_text(encoding="utf-8"))
                self.data["items"].update(old.get("items", {}))
            except Exception:
                pass
        self._t0 = time.perf_counter()

    def item(self, job: dict, samples, sr: int, synth_s: float, **settings) -> None:
        info = write_wav(raw_dir(self.key) / (job["name"] + ".wav"), samples, sr)
        info.update({"family": job["family"], "prompt": job["prompt"], "seed": job["seed"],
                     "text_given": settings.pop("text_given", job["text"]),
                     "seconds_asked": job["seconds"], "synth_s": round(synth_s, 2), **settings})
        self.data["items"][job["name"]] = info
        print("%-18s %5.2f s audio, %d ch, %d Hz, peak %.3f, made in %.1f s" % (
            job["name"], info["audio_s"], info["channels"], info["sr"], info["peak"], synth_s))

    def save(self, **extra) -> Path:
        self.data.update(extra)
        self.data["total_s"] = round(time.perf_counter() - self._t0, 1)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(self.data, f, indent=1, ensure_ascii=False)
        print("wrote", self.path)
        return self.path
