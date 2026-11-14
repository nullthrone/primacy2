"""Transcribe speech with Whisper (openai/whisper-small, local cache only) and score it.

    python tools/audio/listen/transcribe.py a.wav b.wav [--lang en] [--ref-text "..." | --ref-file F] [--json]

With a reference text the word error rate (WER) is printed: (substitutions + deletions +
insertions) / words in the reference, after lower-casing and removing punctuation.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

MODEL_ID = "openai/whisper-small"
MODEL_SR = 16000
WINDOW_S = 30


def normalise(text: str) -> list[str]:
    text = text.lower().replace("-", " ")
    text = re.sub(r"[^\w\s']", " ", text)
    text = text.replace("'", "")
    return text.split()


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate by Levenshtein distance over words; 0.0 is perfect, may exceed 1.0."""
    ref, hyp = normalise(reference), normalise(hypothesis)
    if not ref:
        return 0.0 if not hyp else float(len(hyp))
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)


class Whisper:
    def __init__(self, device: str | None = None):
        common.offline_env()
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        self.torch = torch
        self.device = common.pick_device(device)
        self.dtype = torch.float16 if self.device == "cuda" else torch.float32
        t0 = time.time()
        self.processor = WhisperProcessor.from_pretrained(MODEL_ID, local_files_only=True)
        self.model = (
            WhisperForConditionalGeneration.from_pretrained(MODEL_ID, local_files_only=True, dtype=self.dtype)
            .to(self.device)
            .eval()
        )
        self.load_seconds = round(time.time() - t0, 1)

    def transcribe(self, mono: np.ndarray, sr: int, lang: str = "en") -> str:
        x = common.resample(mono.astype(np.float32), sr, MODEL_SR)
        win = WINDOW_S * MODEL_SR
        parts = []
        for i in range(0, max(1, len(x)), win):
            piece = x[i : i + win]
            if len(piece) < MODEL_SR // 4 and i > 0:
                break
            feats = self.processor.feature_extractor(piece, sampling_rate=MODEL_SR, return_tensors="pt")
            feats = feats.input_features.to(self.device, self.dtype)
            with self.torch.no_grad():
                ids = self.model.generate(feats, language=lang, task="transcribe", max_new_tokens=220)
            parts.append(self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip())
        return " ".join(p for p in parts if p)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--ref-text")
    ap.add_argument("--ref-file")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--device")
    args = ap.parse_args(argv)
    ref = args.ref_text
    if args.ref_file:
        ref = Path(args.ref_file).read_text(encoding="utf-8")

    out = {}
    with common.gpu_lock("transcribe.py"):
        w = Whisper(args.device)
        for fn in args.files:
            try:
                data, sr = common.load_audio(fn)
                t0 = time.time()
                text = w.transcribe(common.to_mono(data), sr, args.lang)
                out[fn] = {"text": text, "seconds": round(time.time() - t0, 2)}
                if ref is not None:
                    out[fn]["wer"] = round(wer(ref, text), 4)
            except Exception as exc:
                out[fn] = {"error": "%s: %s" % (type(exc).__name__, exc)}
    if args.json:
        common.dump(out, True)
    else:
        for fn, r in out.items():
            if "error" in r:
                print("%s: ERROR %s" % (fn, r["error"]))
            else:
                print("%s: %s" % (fn, r["text"] or "(nothing recognised)"))
                if "wer" in r:
                    print("  WER %.3f" % r["wer"])
    return 1 if any("error" in r for r in out.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
