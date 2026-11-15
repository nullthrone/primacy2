"""MOSS-SoundEffect v2.0 (OpenMOSS-Team, Apache-2.0) for the sound comparison, key "moss".

Run (through the lock, because it uses the graphics card):
    .venv-sound/moss/venv/Scripts/python.exe tools/voice/with_lock.py --wait 3600 -- \
        .venv-sound/moss/venv/Scripts/python.exe tools/sound/adapters/moss.py [--family hull] [--seeds 11,12]

What it does, and the three things it changes on purpose:
 1. TORCHDYNAMO_DISABLE=1 is set before torch is imported: the makers' denoiser is wrapped in
    torch.compile with Triton CUDA graphs, which has an open issue on native Windows. The maths is
    the same, only not compiled.
 2. The VAE file vae_128d_48k.pth is a pickle. The makers' loader (audiotools BaseModel.load)
    first tries torch.package (which unpickles with the full pickle importer) and then calls
    torch.load without weights_only. Here DAC.load is replaced by a loader that calls
    torch.load(weights_only=True). The file holds only collections.OrderedDict, torch.FloatStorage
    and torch._utils._rebuild_tensor_v2 (read with pickletools), all of which weights_only allows,
    so no extra class is allowed (the allow-list is empty and is asserted below).
 3. The Hugging Face hub is kept offline; the model directory is local.
The prompt text is given as it stands; the makers' pipeline appends " duration: <s>s" (their
training convention, append_duration_suffix=True); the record says what text went in.
Settings are the makers' defaults: 100 steps, cfg_scale 4.0, sigma_shift 5.0, bfloat16, mono.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

os.environ["TORCHDYNAMO_DISABLE"] = "1"
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")
os.environ.setdefault("DISABLE_TELEMETRY", "1")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(ROOT / ".venv-sound" / "moss" / "src" / "MOSS-TTS"))  # package "moss_soundeffect_v2"
MODEL_DIR = ROOT / "assets" / "audio" / "gen" / "moss" / "model"
CODE_COMMIT = "934d6826b084c46a0d033402174d5f8ac4ed2519"
MODEL_REVISION = "e35df4d82fbe87fcd5d14e5d100e349c0c3c076d"

import common  # noqa: E402

import torch  # noqa: E402

ALLOWED_CLASSES: list = []  # nothing beyond what weights_only=True allows by default


def _safe_dac_load(cls, location, *args, package_name=None, strict=False, **kwargs):
    import inspect

    d = torch.load(str(location), map_location="cpu", weights_only=True)
    meta = d["metadata"]
    meta["kwargs"].update(kwargs)
    keys = list(inspect.signature(cls).parameters.keys())
    for k in list(meta["kwargs"].keys()):
        if k not in keys:
            meta["kwargs"].pop(k)
    model = cls(*args, **meta["kwargs"])
    res = model.load_state_dict(d["state_dict"], strict=strict)
    print("  VAE loaded with weights_only=True: missing=%d unexpected=%d" % (
        len(res.missing_keys), len(res.unexpected_keys)))
    model.metadata = meta
    return model


def main() -> None:
    args = common.parse_args(__doc__.splitlines()[0])
    jobs = common.jobs(args.family, args.prompts, args.seeds)
    from moss_soundeffect_v2.diffsynth.models import dac_vae
    dac_vae.DAC.load = classmethod(_safe_dac_load)
    from moss_soundeffect_v2 import MossSoundEffectPipeline  # noqa: E402  (package __init__)

    steps, cfg, shift = 100, 4.0, 5.0
    t0 = time.perf_counter()
    pipe = MossSoundEffectPipeline.from_pretrained(str(MODEL_DIR), torch_dtype=torch.bfloat16, device=args.device)
    print("loaded in %.1f s" % (time.perf_counter() - t0))
    if args.device == "cuda":
        # The card is shared with whatever else runs on the desktop (a game held 3.9 GB of the 16 GB
        # during this test): with all weights resident the run spilled into shared memory and
        # stalled. The text encoder (4 GB) is only needed while the prompt is encoded, so it
        # lives on the CPU between calls and visits the card for its forward pass. Same maths,
        # same numbers; only where the weights sit changes.
        te = pipe.text_encoder
        te.to("cpu")
        te.register_forward_pre_hook(lambda m, a: m.to("cuda") and None)
        te.register_forward_hook(lambda m, a, o: (m.to("cpu"), torch.cuda.empty_cache(), None)[-1])
        torch.cuda.empty_cache()
    rec = common.Record("moss", model="OpenMOSS-Team/MOSS-SoundEffect-v2.0", model_revision=MODEL_REVISION,
                        code="https://github.com/OpenMOSS/MOSS-TTS moss_soundeffect_v2", code_commit=CODE_COMMIT,
                        torch=torch.__version__, compile="disabled (TORCHDYNAMO_DISABLE=1)")
    for job in jobs:
        if (common.raw_dir("moss") / (job["name"] + ".wav")).is_file() and job["name"] in rec.data["items"]:
            print("have", job["name"])  # a second run adds to the first, and does not repeat
            continue
        if args.device == "cuda":
            torch.cuda.empty_cache()  # 16 GB card: the 30 s latent decode otherwise spills into shared memory
        t = time.perf_counter()
        audio = pipe(prompt=job["text"], seconds=job["seconds"], num_inference_steps=steps,
                     cfg_scale=cfg, sigma_shift=shift, seed=job["seed"], progress_bar_cmd=lambda x: x)
        if args.device == "cuda":
            torch.cuda.synchronize()
        dt = time.perf_counter() - t
        wav = audio[0].float().cpu().numpy()  # (C, T): exactly what the model returned
        rec.item(job, wav, pipe.sample_rate, dt, text_given=job["text"] + " duration: %.1fs" % job["seconds"],
                 steps=steps, cfg_scale=cfg, sigma_shift=shift, dtype="bfloat16",
                 note="makers' pipeline appends the duration suffix itself")
        rec.save()
        del audio, wav
    rec.save()


if __name__ == "__main__":
    assert not ALLOWED_CLASSES
    main()
