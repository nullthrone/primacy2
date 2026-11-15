"""Adapter for Kokoro-82M v1.0 (kokoro 0.9.4 + misaki), run with .venv-voice/kokoro.

Kokoro cannot build a voice from a description, so every cast voice is a weighted mean of two or
three of the makers' preset voice packs (the same averaging as KPipeline.load_voice). The blend is
saved as cast/<voice>.npy with a .json beside it. Model and packs are pickle files; the loading
code of the package uses weights_only=True, and this adapter enforces it for every torch.load.

    .venv-voice/kokoro/Scripts/python.exe tools/voice/adapters/kokoro.py --device cuda
    .venv-voice/kokoro/Scripts/python.exe tools/voice/adapters/kokoro.py --device cpu --threads 4
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402

# this file is called kokoro.py like the package: take its own folder off the path, or
# "import kokoro" would find the adapter instead of the package
sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != HERE]

KEY = "kokoro"
REPO = "hexgrad/Kokoro-82M"
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"

# Blends, chosen by the makers' overall grade in VOICES.md (af_heart A, af_bella A-, af_nicole B-,
# bf_emma B-; no male pack is graded above C+: am_fenrir, am_michael, am_puck are C+, bm_george C).
BLENDS = {
    "control_f": {"af_heart": 0.4, "bf_emma": 0.4, "af_nicole": 0.2},
    "computer": {"af_bella": 0.5, "af_nicole": 0.5},
    "pilot_m": {"am_puck": 0.4, "am_michael": 0.2, "bm_george": 0.4},
    "dock_m": {"am_fenrir": 0.5, "am_michael": 0.3, "bm_george": 0.2},
}
GRADES = {"af_heart": "A", "af_bella": "A-", "af_nicole": "B-", "bf_emma": "B-", "am_puck": "C+",
          "am_michael": "C+", "am_fenrir": "C+", "bm_george": "C"}


def main() -> None:
    args = common.parse_args("Kokoro-82M adapter")
    # nothing may be fetched while running: the model files are in the local cache already
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.pop("HF_TOKEN", None)
    if args.device == "cpu":
        # "" would delete the variable on Windows, "-1" hides every card; set before torch is imported
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
        for v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
            os.environ[v] = str(args.threads)

    import numpy as np
    import torch

    if args.device == "cpu":
        assert not torch.cuda.is_available(), "card still visible on a cpu run"
        torch.set_num_threads(args.threads)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
    else:
        assert torch.cuda.is_available(), "no cuda"

    # every pickle load must be weights_only=True (kokoro/model.py and pipeline.py already pass it)
    _orig_load = torch.load

    def _safe_load(*a, **k):
        if k.get("weights_only") is not True:
            raise RuntimeError("torch.load without weights_only=True refused")
        return _orig_load(*a, **k)

    torch.load = _safe_load

    from huggingface_hub import constants as hfc

    # only the English files were downloaded, so read the pinned snapshot folder directly
    snap = Path(hfc.HF_HUB_CACHE) / "models--hexgrad--Kokoro-82M" / "snapshots" / REVISION
    assert (snap / "kokoro-v1_0.pth").is_file() and (snap / "config.json").is_file(), snap

    # ---- the cast: weighted means of preset packs -------------------------------------------
    cast = common.load_cast()
    cast_dir = common.model_dir(KEY) / "cast"
    cast_dir.mkdir(parents=True, exist_ok=True)
    voices = {}
    for vid in cast:
        blend = BLENDS[vid]
        wsum = sum(blend.values())
        packs = {n: _safe_load(str(snap / "voices" / (n + ".pt")), map_location="cpu", weights_only=True)
                 for n in blend}
        mix = sum(packs[n] * (w / wsum) for n, w in blend.items()).to(torch.float32)
        voices[vid] = mix
        np.save(cast_dir / (vid + ".npy"), mix.numpy())
        meta = {"voice": vid, "method": "weighted mean of preset voice packs (tensor of shape %s)" % list(mix.shape),
                "packs": {n: {"weight": w / wsum, "makers_grade": GRADES[n]} for n, w in blend.items()},
                "description_wanted": cast[vid]["description"],
                "note": "Origin of the English preset packs is not documented by the makers; a blend is "
                        "artificial only in the sense that it is no single preset."}
        (cast_dir / (vid + ".json")).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    if args.cast_only:
        print("cast written:", ", ".join(voices))
        return

    # ---- load -------------------------------------------------------------------------------
    from kokoro import KModel, KPipeline

    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    kmodel = KModel(repo_id=REPO, config=str(snap / "config.json"), model=str(snap / "kokoro-v1_0.pth"))
    kmodel = kmodel.to(args.device).eval()
    # lang 'a' = American English G2P of misaki with the espeak-ng fallback for unknown words
    pipe = KPipeline(lang_code="a", repo_id=REPO, model=kmodel, device=args.device)
    if args.device == "cuda":
        torch.cuda.synchronize()
    load_s = time.perf_counter() - t0
    assert pipe.g2p.fallback is not None, "espeak fallback not active"

    torch.manual_seed(args.seed)
    run = common.Run(KEY, args.device, args.threads)
    run.loaded(load_s)
    for vid, blend in BLENDS.items():
        if vid in cast:
            run.voice(vid, "weighted mean of preset voice packs", packs=blend, seed=args.seed,
                      file=str((cast_dir / (vid + ".npy")).relative_to(common.ROOT)).replace("\\", "/"))

    def speak(text: str, voice):
        """Whole line in one call; returns (samples, first_audio_s, g2p_s). Pieces the package makes
        by itself are joined without any gap added."""
        pieces, first = [], None
        t = time.perf_counter()
        for res in pipe(text, voice=voice, speed=1, split_pattern=None):
            a = res.audio
            if a is None:
                continue
            if args.device == "cuda":
                torch.cuda.synchronize()
            if first is None:
                first = time.perf_counter() - t
            pieces.append(a.detach().cpu())
        if args.device == "cuda":
            torch.cuda.synchronize()
        return torch.cat(pieces).numpy(), first, len(pieces)

    speak(common.WARM_UP, voices["computer"])  # untimed warm-up

    lines = common.load_lines(args.lines)
    for line in lines:
        text = common.text_for(line)
        voice = voices[line["voice"]]
        torch.manual_seed(args.seed)
        t = time.perf_counter()
        samples, first, n = speak(text, voice)
        synth_s = time.perf_counter() - t
        run.line(line, samples, 24000, synth_s, first_audio_s=first)
        run.data["lines"][line["id"]]["chunks"] = n
        # g2p share of the time, measured apart (not part of the figure above)
        tg = time.perf_counter()
        pipe.g2p(text)
        run.data["lines"][line["id"]]["g2p_s"] = round(time.perf_counter() - tg, 4)

    extra = {"torch": torch.__version__, "threads_set": torch.get_num_threads(),
             "snapshot": REVISION, "chunking": "split_pattern=None; package splits only above 510 phonemes"}
    if args.device == "cuda":
        extra["peak_gpu_mem_mb"] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
        extra["device_name"] = torch.cuda.get_device_name(0)
    run.save(**extra)


if __name__ == "__main__":
    main()
