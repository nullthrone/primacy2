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
OUT = ROOT / "assets" / "audio" / "gen"  # ignored by git: candidates are made again, not committed


def load_prompts() -> dict:
    return json.loads((HERE / "prompts.json").read_text(encoding="utf-8"))


def jobs(only_family: str | None = None, only_prompts: str | None = None, seeds: str | None = None) -> list[dict]:
    """Every (family, prompt, seed) to make, in a fixed order."""
    spec = load_prompts()
    want_seeds = [int(s) for s in seeds.split(",")] if seeds else spec["seeds"]
    want_prompts = {s.strip() for s in only_prompts.split(",")} if only_prompts else None
    out = []
    for fam in spec["families"]:
        if only_family and fam["id"] != only_family:
            continue
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
    return ap.parse_args()


def raw_dir(key: str) -> Path:
    d = OUT / key / "raw"
    d.mkdir(parents=True, exist_ok=True)
    return d


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
    return {"file": str(path.relative_to(ROOT)).replace("\\", "/"), "sr": int(sr),
            "channels": 1 if x.ndim == 1 else int(x.shape[1]),
            "audio_s": round(x.shape[0] / float(sr), 3),
            "peak": round(float(np.max(np.abs(x))) if x.size else 0.0, 4)}


class Record:
    """Collects what was made by one source and writes gen.json beside the raw files."""

    def __init__(self, key: str, **facts):
        self.key = key
        self.path = OUT / key / "gen.json"
        self.data: dict = {"source": key, "items": {}, **facts}
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
