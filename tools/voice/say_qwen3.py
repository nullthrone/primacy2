"""Speak given texts in the cast voice 'computer' with Qwen3-TTS Base 0.6B (clone prompt of the designed clip).

    <python of .venv-voice/qwen3> tools/voice/say_qwen3.py --items items.json --out DIR [--device cuda]

Used by tools/voice/countdown.py (stage 'generate'). It never touches what the comparison scored: it
writes only into DIR (assets/audio/voice/_countdown/raw/qwen3), reads the clip
assets/audio/voice/qwen3/cast/computer.wav and its reference text from cast.json, and does not use
common.Run (so no timing.json, no cast json, no line wav of the comparison is rewritten).

items.json: {"voice": "computer", "items": [{"id": "five_s1", "text": "Five.", "seed": 1, "max_new_tokens": 48}]}
Each item is spoken with torch.manual_seed(seed) set right before it. DIR gets <id>.wav (the model's own
rate, float32, untouched) and say.json (what was spoken, seed, duration). The hub is offline and
sockets that leave the machine are refused, like in the adapter.
"""
from __future__ import annotations

import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ.pop("HF_TOKEN", None)
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

import argparse  # noqa: E402
import json  # noqa: E402
import socket  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument("--items", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
args = ap.parse_args()
if args.device == "cpu":
    os.environ["CUDA_VISIBLE_DEVICES"] = ""

import numpy as np  # noqa: E402,F401
import torch  # noqa: E402

BASE_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
NET_ATTEMPTS: list[str] = []


def block_network() -> None:
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def local(address) -> bool:
        return (address[0] if isinstance(address, tuple) and address else "") in ("127.0.0.1", "::1", "localhost")

    def refuse(self, address, *a, **k):
        if local(address):
            return real_connect(self, address, *a, **k)
        NET_ATTEMPTS.append(repr(address))
        raise OSError("network blocked by the script")

    def refuse_ex(self, address, *a, **k):
        if local(address):
            return real_connect_ex(self, address, *a, **k)
        NET_ATTEMPTS.append(repr(address))
        return 10061

    socket.socket.connect = refuse  # type: ignore[assignment]
    socket.socket.connect_ex = refuse_ex  # type: ignore[assignment]


def main() -> int:
    import huggingface_hub
    import soundfile as sf
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSModel

    block_network()
    spec = json.loads(Path(args.items).read_text(encoding="utf-8"))
    vid = spec.get("voice", "computer")
    cast = common.load_cast()
    on_cuda = args.device == "cuda" and torch.cuda.is_available()
    device = "cuda:0" if on_cuda else "cpu"
    dtype = torch.bfloat16 if on_cuda else torch.float32
    assert huggingface_hub.constants.HF_HUB_OFFLINE, "the hub must be offline"
    snap = snapshot_download(BASE_REPO, revision=REVISION, local_files_only=True)
    if os.path.basename(os.path.normpath(snap)) != REVISION:
        raise SystemExit("snapshot %s is not revision %s" % (snap, REVISION))
    model = Qwen3TTSModel.from_pretrained(snap, device_map=device, dtype=dtype, attn_implementation="sdpa")
    clip = common.cast_clip("qwen3", vid)
    x, sr = sf.read(str(clip), dtype="float32")
    prompt = model.create_voice_clone_prompt(ref_audio=(x, sr), ref_text=cast[vid]["reference_text"],
                                             x_vector_only_mode=False)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    log = {"model": BASE_REPO, "revision": REVISION, "snapshot": snap, "device": device, "dtype": str(dtype),
           "voice": vid, "clip": str(clip.relative_to(common.ROOT)).replace("\\", "/"), "items": {}}
    for it in spec["items"]:
        torch.manual_seed(int(it["seed"]))
        if on_cuda:
            torch.cuda.manual_seed_all(int(it["seed"]))
            torch.cuda.synchronize()
        t = time.perf_counter()
        wavs, osr = model.generate_voice_clone(text=it["text"], language="English", voice_clone_prompt=prompt,
                                               max_new_tokens=int(it.get("max_new_tokens", 1000)))
        if on_cuda:
            torch.cuda.synchronize()
        took = time.perf_counter() - t
        y = common.to_mono(wavs[0])
        sf.write(str(out / (it["id"] + ".wav")), y, int(osr), subtype="FLOAT")
        log["items"][it["id"]] = {"text": it["text"], "seed": int(it["seed"]), "sr": int(osr),
                                  "audio_s": round(y.size / osr, 3), "synth_s": round(took, 2)}
        print("%-14s seed %d  %5.2f s audio in %5.2f s  %r" % (it["id"], it["seed"], y.size / osr, took, it["text"]))
    log["network_attempts_refused"] = list(NET_ATTEMPTS)
    (out / "say.json").write_text(json.dumps(log, indent=2), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
