"""Speak given texts in the cast voice 'computer' with Chatterbox-Nano, on the processor (never its built-in voice).

    <python of .venv-voice/chatterbox-nano> tools/voice/say_chatterbox-nano.py --items items.json --out DIR [--threads 4]

Used by tools/voice/countdown.py (stage 'generate'). Same pinned snapshot, offline hub and blocked sockets
as adapters/chatterbox-nano.py, but it writes only into DIR (assets/audio/voice/_countdown/raw/chatterbox-nano)
and does not use common.Run: no timing.json, no cast json and no line wav of the comparison is rewritten.
The reference clip is assets/audio/voice/qwen3/cast/computer.wav; a conds.pt in the snapshot stops the run.

items.json: {"voice": "computer", "items": [{"id": "five_s1", "text": "Five.", "seed": 1}]}
torch.manual_seed(seed) is set right before each item. DIR gets <id>.wav (the model's own rate, float32,
untouched) and say.json.
"""
from __future__ import annotations

import os
import sys

_threads = 4
for _i, _a in enumerate(sys.argv):
    if _a == "--threads" and _i + 1 < len(sys.argv):
        _threads = int(sys.argv[_i + 1])
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["OMP_NUM_THREADS"] = str(_threads)
os.environ["MKL_NUM_THREADS"] = str(_threads)
os.environ["NUMBA_NUM_THREADS"] = str(_threads)
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ.pop("HF_TOKEN", None)

import argparse  # noqa: E402
import json  # noqa: E402
import socket  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

REPO = "ResembleAI/chatterbox-nano"
REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"
FILES = ["ve.safetensors", "t3_nano_v1.safetensors", "s3gen_meanflow.safetensors", "added_tokens.json",
         "merges.txt", "special_tokens_map.json", "tokenizer_config.json", "vocab.json"]
NET_ATTEMPTS: list[str] = []


def block_network() -> None:
    def refuse(self, address, *a, **k):
        NET_ATTEMPTS.append(repr(address))
        raise OSError("network blocked by the script")

    socket.socket.connect = refuse  # type: ignore[assignment]
    socket.socket.connect_ex = lambda self, address, *a, **k: (NET_ATTEMPTS.append(repr(address)) or 10061)  # type: ignore[assignment]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--items", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    import soundfile as sf
    import torch
    from huggingface_hub import snapshot_download

    torch.set_num_threads(args.threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    assert not torch.cuda.is_available(), "graphics card visible on a CPU run"
    spec = json.loads(Path(args.items).read_text(encoding="utf-8"))
    vid = spec.get("voice", "computer")
    clip = common.cast_clip("qwen3", vid)
    if not clip.exists():
        raise SystemExit("reference clip missing: %s" % clip)
    snap = snapshot_download(REPO, revision=REVISION, allow_patterns=FILES, local_files_only=True)
    if (Path(snap) / "conds.pt").exists():
        raise SystemExit("conds.pt is present in the snapshot: the built-in voice must not be available")

    from chatterbox.tts_turbo import ChatterboxTurboTTS

    block_network()
    model = ChatterboxTurboTTS.from_local(snap, "cpu", nano=True)
    assert model.conds is None, "a built-in voice was loaded"
    torch.manual_seed(20261115)
    model.prepare_conditionals(str(clip))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    log = {"model": REPO, "revision": REVISION, "snapshot": snap, "device": "cpu", "threads": args.threads,
           "voice": vid, "clip": str(clip.relative_to(common.ROOT)).replace("\\", "/"), "items": {}}
    for it in spec["items"]:
        torch.manual_seed(int(it["seed"]))
        t = time.perf_counter()
        wav = model.generate(it["text"])
        took = time.perf_counter() - t
        y = common.to_mono(wav.squeeze(0).numpy())
        sf.write(str(out / (it["id"] + ".wav")), y, int(model.sr), subtype="FLOAT")
        log["items"][it["id"]] = {"text": it["text"], "seed": int(it["seed"]), "sr": int(model.sr),
                                  "audio_s": round(y.size / model.sr, 3), "synth_s": round(took, 2)}
        print("%-14s seed %d  %5.2f s audio in %5.2f s  %r" % (it["id"], it["seed"], y.size / model.sr, took, it["text"]))
    log["network_attempts_refused"] = list(NET_ATTEMPTS)
    (out / "say.json").write_text(json.dumps(log, indent=2), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
