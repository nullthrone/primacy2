"""Stable Audio 3 Small-SFX Base (Stability AI) for the sound comparison, key "sa3".

    .venv-sound/sa3/Scripts/python.exe tools/sound/adapters/sa3.py [--family hull] [--seeds 11,12]
    .venv-sound/sa3/Scripts/python.exe tools/sound/adapters/sa3.py --repro   (same seed twice, compared)

Run it through tools/voice/with_lock.py: it uses the graphics card.

Terms: Stability AI Community License. Testing is free; use for a product needs registration with
Stability AI and ends above USD 1,000,000 of yearly revenue; the text encoder is under Google's
Gemma terms. Everything this model makes here is test material, not to be shipped until the owner
has decided (the field "terms" of gen.json says so).

What is different from the makers' own from_pretrained("small-sfx-base"), and why:
- everything is read from the local copy of the one approved repository (.venv-sound/sa3/weights,
  revision pinned below), never from the Hugging Face hub (HF_HUB_OFFLINE=1);
- the makers' model_config.json of the base checkpoint names the text encoder as a subfolder of the
  GATED sibling repository (stabilityai/stable-audio-3-small-sfx). That is out of scope, so the
  conditioner config is patched in memory: repo_id and subfolder are dropped and model_path points
  at t5gemma-b-b-ul2/ of the base repository, which holds the same encoder. Nothing else changes;
- svd_bases.pt (the one pickle file) is only used by the makers' code for -XS LoRA adapters, which
  this adapter never loads, so the file is never opened here. Where the makers' package does open it
  it passes weights_only=True (stable_audio_3/models/lora/loader.py and bake_dora.py).
"""
from __future__ import annotations

import copy
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")
os.environ.pop("HF_TOKEN", None)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import common  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

KEY = "sa3"
REPO = "stabilityai/stable-audio-3-small-sfx-base"
REVISION = "b332479a012f83c24c4381f331ce594284ec8a81"  # revision of the model repository on disk
CODE_COMMIT = "790793b89ddceea612be9ce42ff6830d18f6fa57"  # github.com/Stability-AI/stable-audio-3
WEIGHTS = common.ROOT / ".venv-sound" / "sa3" / "weights"
PREFIX = "TrackType: SFX, "  # the makers' recommended tag for sound effects (docs/guides/prompting.md)
SETTINGS = {"steps": 50, "cfg_scale": 7.0, "sampler_type": "euler", "apg_scale": 1.0,
            "duration_padding_sec": 6.0, "dtype": "float16"}
TERMS = ("Stability AI Community License: test material, not to be shipped until the owner has "
         "decided. Testing is free; product use needs registration with Stability AI and ends above "
         "USD 1,000,000 of yearly revenue; the text encoder is under Google's Gemma terms.")


def load_model(device: str):
    from stable_audio_3.loading_utils import load_diffusion_cond
    from stable_audio_3.model import StableAudioModel

    cfg = json.loads((WEIGHTS / "model_config.json").read_text(encoding="utf-8"))
    cfg = copy.deepcopy(cfg)
    patched = 0
    for c in cfg["model"]["conditioning"]["configs"]:
        if c.get("type") == "t5gemma":
            c["config"].pop("repo_id", None)
            c["config"].pop("subfolder", None)
            c["config"]["model_path"] = str(WEIGHTS / "t5gemma-b-b-ul2")
            patched += 1
    assert patched == 1, "expected exactly one t5gemma conditioner in model_config.json"
    half = device == "cuda"
    model = load_diffusion_cond(cfg, str(WEIGHTS / "model.safetensors"), device=device, model_half=half)
    model.use_lora = False
    model.lora_names = []
    return StableAudioModel(model, cfg, device, half)


def make(sam, job: dict, seed: int | None = None):
    """Returns (float32 array (2, n) as the model gave it, seconds taken)."""
    text = PREFIX + job["text"]
    t0 = time.perf_counter()
    out = sam.generate(prompt=text, duration=float(job["seconds"]), steps=SETTINGS["steps"],
                       cfg_scale=SETTINGS["cfg_scale"], sampler_type=SETTINGS["sampler_type"],
                       seed=int(job["seed"] if seed is None else seed))
    if sam.device == "cuda":
        torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    return out[0].detach().float().cpu().numpy(), dt


def main() -> int:
    ap_repro = "--repro" in sys.argv
    if ap_repro:
        sys.argv.remove("--repro")
    args = common.parse_args(__doc__.splitlines()[0])
    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        print("no cuda device", file=sys.stderr)
        return 2
    t0 = time.perf_counter()
    sam = load_model(device)
    load_s = time.perf_counter() - t0
    print("model loaded in %.1f s on %s" % (load_s, device))
    sr = int(sam.model.sample_rate)

    if ap_repro:
        job = common.jobs("hull", "hull_1", "11")[0]
        a, _ = make(sam, job)
        b, _ = make(sam, job)
        c, _ = make(sam, job, seed=12)
        res = {"same_seed_identical_bits": bool(np.array_equal(a, b)),
               "same_seed_max_abs_diff": float(np.max(np.abs(a - b))),
               "other_seed_max_abs_diff": float(np.max(np.abs(a - c))),
               "shape": list(a.shape), "peak_gpu_mem_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2)}
        raw = common.raw_dir(KEY) / "hull_1__s11.wav"
        if raw.is_file():
            import soundfile as sf
            r, _sr = sf.read(str(raw), dtype="float32")
            res["equals_file_on_disk"] = bool(np.array_equal(r.T, a))
            res["file_max_abs_diff"] = float(np.max(np.abs(r.T - a)))
        print("REPRO", json.dumps(res))
        return 0

    rec = common.Record(KEY, model=REPO, model_revision=REVISION, code="Stability-AI/stable-audio-3",
                        code_commit=CODE_COMMIT, terms=TERMS, load_s=round(load_s, 1))
    todo = common.jobs(args.family, args.prompts, args.seeds)
    for job in todo:
        audio, dt = make(sam, job)
        rec.item(job, audio, sr, dt, text_given=PREFIX + job["text"], terms=TERMS,
                 steps=SETTINGS["steps"], cfg_scale=SETTINGS["cfg_scale"],
                 sampler=SETTINGS["sampler_type"], apg_scale=SETTINGS["apg_scale"],
                 duration_padding_sec=SETTINGS["duration_padding_sec"], dtype=SETTINGS["dtype"],
                 duration_given=float(job["seconds"]))
        rec.save()  # after every file, so a stop loses nothing
    rec.save(settings=SETTINGS, prefix=PREFIX, peak_gpu_mem_gb=round(torch.cuda.max_memory_allocated() / 1e9, 2)
             if device == "cuda" else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
