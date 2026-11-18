"""Score audio against text descriptions with CLAP (laion/larger_clap_general, local cache only).

Single file:
    python tools/audio/listen/compare.py file.wav --pos "a low hum" --pos "engine drone" --neg "a beep"
Batch (every sound of the spec that has a rendered file):
    python tools/audio/listen/compare.py --spec tools/audio/sounds.json --dir assets/audio/render [--only id,id]

The score is the cosine similarity between the audio embedding and the text embedding. CLAP is a
sanity check ("is it closer to what it should be than to what it must not be"), not a target.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

MODEL_ID = "laion/larger_clap_general"
MODEL_SR = 48000
WINDOW_S = 10  # the model's input length; the feature extractor repeat-pads shorter clips
MIN_TAIL_S = 2  # a trailing piece shorter than this is dropped when a longer clip is windowed


class Clap:
    def __init__(self, device: str | None = None):
        common.offline_env()
        import torch
        from transformers import ClapModel, ClapProcessor

        self.torch = torch
        self.device = common.pick_device(device)
        t0 = time.time()
        self.processor = ClapProcessor.from_pretrained(MODEL_ID, local_files_only=True)
        self.model = ClapModel.from_pretrained(MODEL_ID, local_files_only=True).to(self.device).eval()
        self.load_seconds = round(time.time() - t0, 1)
        self._text_cache: dict[str, np.ndarray] = {}

    @staticmethod
    def _tensor(out):
        """Newer transformers versions may wrap the projected embedding in an output object."""
        if hasattr(out, "pooler_output") and out.pooler_output is not None:
            return out.pooler_output
        if hasattr(out, "text_embeds"):
            return out.text_embeds
        return out

    def text_embed(self, texts: list[str]) -> np.ndarray:
        todo = [t for t in dict.fromkeys(texts) if t not in self._text_cache]
        if todo:
            tok = self.processor.tokenizer(todo, padding=True, return_tensors="pt").to(self.device)
            with self.torch.no_grad():
                e = self._tensor(self.model.get_text_features(**tok))
            e = self.torch.nn.functional.normalize(e.float(), dim=-1).cpu().numpy()
            for t, v in zip(todo, e):
                self._text_cache[t] = v
        return np.stack([self._text_cache[t] for t in texts])

    def audio_embed(self, mono: np.ndarray, sr: int) -> np.ndarray:
        x = common.resample(mono.astype(np.float32), sr, MODEL_SR)
        win = WINDOW_S * MODEL_SR
        pieces = [x[i : i + win] for i in range(0, max(1, len(x)), win)]
        if len(pieces) > 1 and len(pieces[-1]) < MIN_TAIL_S * MODEL_SR:
            pieces = pieces[:-1]
        fe = self.processor.feature_extractor(
            pieces, sampling_rate=MODEL_SR, return_tensors="pt", padding="repeatpad", truncation="rand_trunc"
        )
        feats = {k: v.to(self.device) for k, v in fe.items()}
        with self.torch.no_grad():
            e = self._tensor(self.model.get_audio_features(**feats))
        e = self.torch.nn.functional.normalize(e.float(), dim=-1).mean(dim=0)  # average over windows
        e = self.torch.nn.functional.normalize(e, dim=-1)
        return e.cpu().numpy()

    def score(self, mono: np.ndarray, sr: int, texts: list[str]) -> list[float]:
        a = self.audio_embed(mono, sr)
        return [float(v) for v in self.text_embed(texts) @ a]


def judge(clap: Clap, mono: np.ndarray, sr: int, pos: list[str], neg: list[str]) -> dict:
    texts = list(dict.fromkeys(pos + neg))
    sc = dict(zip(texts, clap.score(mono, sr, texts)))
    pos_s = {t: round(sc[t], 4) for t in pos}
    neg_s = {t: round(sc[t], 4) for t in neg if t not in pos}
    best = max(sc, key=sc.get)
    best_pos = max(pos_s, key=pos_s.get) if pos_s else None
    best_neg = max(neg_s, key=neg_s.get) if neg_s else None
    out = {"pos": pos_s, "neg": neg_s, "best": best, "bestScore": round(sc[best], 4)}
    if best_pos is not None and best_neg is not None:
        out["bestPos"], out["bestNeg"] = best_pos, best_neg
        out["margin"] = round(pos_s[best_pos] - neg_s[best_neg], 4)
        out["pass"] = bool(out["margin"] > 0)
    return out


def find_clip(root: Path, s: dict) -> Path | None:
    for cand in (root / s["category"] / (s["id"] + ".wav"), root / (s["id"] + ".wav")):
        if cand.is_file():
            return cand
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="single mode: the clip")
    ap.add_argument("--pos", action="append", default=[], help="a description that should fit (repeatable)")
    ap.add_argument("--neg", action="append", default=[], help="a description that must not fit (repeatable)")
    ap.add_argument("--spec", help="batch mode: sounds.json")
    ap.add_argument("--dir", help="batch mode: folder with the rendered files (<dir>/<category>/<id>.wav)")
    ap.add_argument("--only", help="batch mode: comma separated sound ids")
    ap.add_argument("--out", help="batch mode: result file (default assets/audio/cache/compare.json)")
    ap.add_argument("--json", action="store_true", help="single mode: JSON instead of a table")
    ap.add_argument("--device")
    args = ap.parse_args(argv)

    if args.spec:
        if not args.dir:
            ap.error("--spec needs --dir")
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        cat_neg = {c["id"]: c.get("neg", []) for c in spec["categories"]}
        only = set(args.only.split(",")) if args.only else None
        todo = []
        for s in spec["sounds"]:
            if only and s["id"] not in only:
                continue
            todo.append(s)
        result = {"model": MODEL_ID, "sounds": {}}
        with common.gpu_lock("compare.py"):
            clap = Clap(args.device)
            result["loadSeconds"] = clap.load_seconds
            for s in todo:
                clip = find_clip(Path(args.dir), s)
                if clip is None:
                    result["sounds"][s["id"]] = {"error": "no rendered file found"}
                    continue
                try:
                    data, sr = common.load_audio(clip)
                    neg = list(spec.get("neg", [])) + list(cat_neg.get(s["category"], []))
                    r = judge(clap, common.to_mono(data), sr, list(s["pos"]), neg)
                    r["file"] = str(clip)
                    result["sounds"][s["id"]] = r
                except Exception as exc:
                    result["sounds"][s["id"]] = {"error": "%s: %s" % (type(exc).__name__, exc)}
        out = Path(args.out) if args.out else common.CACHE_DIR / "compare.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        for sid, r in result["sounds"].items():
            if "error" in r:
                print("%-28s ERROR %s" % (sid, r["error"]))
            else:
                print("%-28s %s margin %+.3f  best: %s" % (sid, "ok  " if r.get("pass") else "FAIL", r.get("margin", 0), r["best"]))
        print("wrote %s (model load %.1f s)" % (out, result["loadSeconds"]))
        return 0

    if not args.file or not args.pos:
        ap.error("single mode needs a file and at least one --pos (or use --spec and --dir)")
    data, sr = common.load_audio(args.file)
    with common.gpu_lock("compare.py"):
        clap = Clap(args.device)
        r = judge(clap, common.to_mono(data), sr, args.pos, args.neg)
    if args.json:
        print(json.dumps(r, indent=2, ensure_ascii=False))
    else:
        rows = [("pos", t, v) for t, v in r["pos"].items()] + [("neg", t, v) for t, v in r["neg"].items()]
        for kind, t, v in sorted(rows, key=lambda x: -x[2]):
            print("%.4f  %s  %s" % (v, kind, t))
        if "margin" in r:
            print("margin %+.4f (%s)" % (r["margin"], "ok" if r["pass"] else "a 'neg' description fits better"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
