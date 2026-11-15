"""Shared by every adapter of the voice comparison: the lines, the cast, the timing record.

Needs only numpy and soundfile, so it runs in each model's own environment. An adapter never
changes what a model returns: no trimming, no gain, no resampling. Measuring and anything that
makes a line sound like radio happens afterwards, on the files, in tools/voice/score.py.
"""
from __future__ import annotations

import argparse
import json
import platform
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / "assets" / "audio" / "voice"  # ignored by git: rendered speech is rebuilt, not committed

WARM_UP = "This sentence warms the model up and is not timed."


def load_lines(only: str | None = None) -> list[dict]:
    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))["lines"]
    if only:
        want = {s.strip() for s in only.split(",") if s.strip()}
        unknown = want - {ln["id"] for ln in lines}
        if unknown:
            raise SystemExit("unknown line ids: " + ", ".join(sorted(unknown)))
        lines = [ln for ln in lines if ln["id"] in want]
    return lines


def load_cast() -> dict[str, dict]:
    voices = json.loads((HERE / "cast.json").read_text(encoding="utf-8"))["voices"]
    return {v["id"]: v for v in voices}


def text_for(line: dict) -> str:
    """What the model is given: the written-out form, or the raw display text of a 'raw' line."""
    return line["text"] if line.get("raw") else line["spoken"]


def parse_args(description: str = "") -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    ap.add_argument("--threads", type=int, default=4,
                    help="CPU threads for --device cpu (default 4: a small server)")
    ap.add_argument("--lines", help="comma separated line ids (default: all)")
    ap.add_argument("--cast-only", action="store_true",
                    help="only make the voices (reference clips or voice vectors), speak no lines")
    ap.add_argument("--cast-from", help="take the reference clips from this model key instead of making them")
    ap.add_argument("--seed", type=int, default=20261115)
    return ap.parse_args()


def model_dir(key: str) -> Path:
    d = OUT / key
    d.mkdir(parents=True, exist_ok=True)
    return d


def to_mono(samples) -> np.ndarray:
    x = np.asarray(samples, dtype=np.float32)
    x = np.squeeze(x)
    if x.ndim == 2:  # (channels, n) or (n, channels): the short side is the channels
        x = x.mean(axis=0 if x.shape[0] < x.shape[1] else 1)
    if x.ndim != 1:
        raise ValueError("expected one channel of samples, got shape %r" % (x.shape,))
    return x


def write_wav(path: Path, samples, sr: int) -> dict:
    """Write float samples as 32-bit float WAV, untouched. Returns what was written."""
    import soundfile as sf

    x = to_mono(samples)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), x, int(sr), subtype="FLOAT")
    return {"file": str(path.relative_to(ROOT)).replace("\\", "/"), "sr": int(sr),
            "audio_s": round(x.size / float(sr), 3), "peak": round(float(np.max(np.abs(x))) if x.size else 0.0, 4)}


class Run:
    """Collects the timings of one run of one model on one device and writes timing.json."""

    def __init__(self, key: str, device: str, threads: int | None = None):
        self.key, self.device = key, device
        self.dir = model_dir(key) / device
        self.dir.mkdir(parents=True, exist_ok=True)
        self.data: dict = {"model": key, "device": device, "threads": threads if device == "cpu" else None,
                           "machine": platform.processor() or platform.machine(), "lines": {}, "voices": {}}
        self._t0 = time.perf_counter()

    def loaded(self, seconds: float) -> None:
        self.data["load_s"] = round(seconds, 2)

    def voice(self, voice_id: str, how: str, **facts) -> None:
        """Record how a voice was made (description, blend weights, seed, reference clip)."""
        self.data["voices"][voice_id] = {"how": how, **facts}

    def line(self, line: dict, samples, sr: int, synth_s: float, first_audio_s: float | None = None) -> None:
        info = write_wav(self.dir / (line["id"] + ".wav"), samples, sr)
        info["synth_s"] = round(synth_s, 3)
        info["rtf"] = round(synth_s / info["audio_s"], 3) if info["audio_s"] else None
        if first_audio_s is not None:
            info["first_audio_s"] = round(first_audio_s, 3)
        info["voice"] = line["voice"]
        self.data["lines"][line["id"]] = info
        print("%-22s %5.2f s audio in %5.2f s (rtf %s)" % (line["id"], info["audio_s"], synth_s, info["rtf"]))

    def save(self, **extra) -> Path:
        self.data.update(extra)
        self.data["total_s"] = round(time.perf_counter() - self._t0, 1)
        rtfs = [v["rtf"] for v in self.data["lines"].values() if v.get("rtf")]
        if rtfs:
            self.data["rtf_median"] = round(float(np.median(rtfs)), 3)
        p = self.dir / "timing.json"
        p.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        print("wrote", p)
        return p


class Timer:
    def __enter__(self):
        self.t = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.s = time.perf_counter() - self.t
        return False


def cast_clip(key: str, voice_id: str) -> Path:
    """Where a model keeps the reference clip that fixes an invented voice."""
    return model_dir(key) / "cast" / (voice_id + ".wav")
