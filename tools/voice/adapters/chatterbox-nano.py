"""Adapter for Chatterbox-Nano (ResembleAI/chatterbox-nano, 110M, English), on the CPU.

    .venv-voice/chatterbox-nano/Scripts/python.exe tools/voice/adapters/chatterbox-nano.py --device cpu --threads 4 --cast-from qwen3
    .venv-voice/chatterbox-nano/Scripts/python.exe tools/voice/adapters/chatterbox-nano.py --device cpu --threads 8 --cast-from qwen3 --listen-only --tag 8t

The model speaks only in the voice of a reference clip. The clips are the four that the Qwen3
voice-design run invented (assets/audio/voice/qwen3/cast/<voice>.wav); --cast-from qwen3 is
required, and the model's built-in default voice (conds.pt, origin not stated) is neither
downloaded nor ever used: the loader finds no conds.pt, and a missing clip stops the run.

Own options (stripped before common.parse_args): --listen-only (only the lines marked listen),
--tag T (the key becomes chatterbox-nano-T, so that the 8-thread run does not overwrite the 4-thread one).

Shims, all inside this file:
- the model is built with the package's own ChatterboxTurboTTS.from_local(snapshot, "cpu", nano=True)
  from the local snapshot of a pinned revision (from_pretrained would also fetch s3gen.safetensors and conds.pt);
- HF_HUB_OFFLINE is set and sockets are blocked from before loading on; refused attempts are counted in timing.json;
- the reference clip is turned into the model's conditionals once per voice, outside the timed
  region (a server keeps them per voice); the time is recorded as cond_prep_s. Timed is
  model.generate(text) alone, which in the package includes the Perth watermark (always on,
  not touched here) and returns the whole line at once: the model does not stream, so there is no first-audio time.
- the random seed is set before every line (seed + index of the line in lines.json).
"""
from __future__ import annotations

import os
import sys

_ARGV = sys.argv[1:]
_LISTEN_ONLY = "--listen-only" in _ARGV
_TAG = None
_clean = []
_skip = False
for _i, _a in enumerate(_ARGV):
    if _skip:
        _skip = False
        continue
    if _a == "--listen-only":
        continue
    if _a == "--tag":
        _TAG = _ARGV[_i + 1]
        _skip = True
        continue
    if _a.startswith("--tag="):
        _TAG = _a.split("=", 1)[1]
        continue
    _clean.append(_a)
sys.argv = [sys.argv[0]] + _clean

_threads = 4
for _i, _a in enumerate(sys.argv):
    if _a == "--threads" and _i + 1 < len(sys.argv):
        _threads = int(sys.argv[_i + 1])
    elif _a.startswith("--threads="):
        _threads = int(_a.split("=", 1)[1])
# before anything imports torch: no graphics card, thread counts, no network, no telemetry
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["OMP_NUM_THREADS"] = str(_threads)
os.environ["MKL_NUM_THREADS"] = str(_threads)
os.environ["NUMBA_NUM_THREADS"] = str(_threads)
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ.pop("HF_TOKEN", None)

import ctypes  # noqa: E402
import json  # noqa: E402
import socket  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import numpy as np  # noqa: E402,F401
import common  # noqa: E402

KEY = "chatterbox-nano" + ("-" + _TAG if _TAG else "")
REPO = "ResembleAI/chatterbox-nano"
REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"
FILES = ["ve.safetensors", "t3_nano_v1.safetensors", "s3gen_meanflow.safetensors", "added_tokens.json",
         "merges.txt", "special_tokens_map.json", "tokenizer_config.json", "vocab.json"]  # no conds.pt, no s3gen.safetensors
NET_ATTEMPTS: list[str] = []


def block_network() -> None:
    def refuse(self, address, *a, **k):
        NET_ATTEMPTS.append(repr(address))
        raise OSError("network blocked by the adapter")

    socket.socket.connect = refuse  # type: ignore[assignment]
    socket.socket.connect_ex = lambda self, address, *a, **k: (NET_ATTEMPTS.append(repr(address)) or 10061)  # type: ignore[assignment]


def peak_rss_gb() -> float | None:
    """Peak working set of this process (Windows)."""
    try:
        class PMC(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        h = k32.GetCurrentProcess()
        ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(h), ctypes.byref(pmc), pmc.cb)
        return round(pmc.PeakWorkingSetSize / 1024 ** 3, 2)
    except Exception:
        return None


def main() -> int:
    args = common.parse_args(__doc__.splitlines()[0])
    if args.device != "cpu":
        raise SystemExit("Chatterbox-Nano runs here on the CPU only (torch 2.6.0 CPU build); use --device cpu")
    if args.cast_from is None:
        raise SystemExit("--cast-from qwen3 is required: the model never speaks without a reference clip")
    lines = common.load_lines(args.lines)
    if _LISTEN_ONLY and not args.lines:
        lines = [ln for ln in lines if ln.get("listen")]
    cast = common.load_cast()
    all_ids = [ln["id"] for ln in common.load_lines()]

    clips = {}
    for vid in cast:
        p = common.cast_clip(args.cast_from, vid)
        if not p.exists():
            raise SystemExit("reference clip missing: %s" % p)
        clips[vid] = p

    import torch  # noqa: E402
    from huggingface_hub import snapshot_download  # noqa: E402

    torch.set_num_threads(args.threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    assert not torch.cuda.is_available(), "graphics card visible on a CPU run"

    snap = snapshot_download(REPO, revision=REVISION, allow_patterns=FILES, local_files_only=True)
    if (Path(snap) / "conds.pt").exists():
        raise SystemExit("conds.pt is present in the snapshot: the built-in voice must not be available")

    from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402

    block_network()
    t0 = time.perf_counter()
    model = ChatterboxTurboTTS.from_local(snap, "cpu", nano=True)
    load_s = time.perf_counter() - t0
    assert model.conds is None, "a built-in voice was loaded"

    run = common.Run(KEY, "cpu", args.threads)
    run.loaded(load_s)

    # conditionals per voice, from the reference clip (outside the timed region)
    conds, prep = {}, {}
    for vid, clip in clips.items():
        torch.manual_seed(args.seed)
        t = time.perf_counter()
        model.prepare_conditionals(str(clip))
        prep[vid] = round(time.perf_counter() - t, 3)
        conds[vid] = model.conds
        rel = str(clip.relative_to(common.ROOT)).replace("\\", "/")
        run.voice(vid, "reference clip made by another model (Qwen3-TTS VoiceDesign) from the text description in cast.json",
                  reference=rel, cond_prep_s=prep[vid], seed=args.seed, source_model=args.cast_from)
        d = common.model_dir(KEY) / "cast"
        d.mkdir(parents=True, exist_ok=True)
        (d / (vid + ".json")).write_text(json.dumps(
            {"voice": vid, "model": REPO, "revision": REVISION, "reference_clip": rel,
             "reference_from": args.cast_from, "cond_prep_s": prep[vid],
             "note": "no clip of its own: the clip of another model is the voice"}, indent=2), encoding="utf-8")
    if args.cast_only:
        return 0

    # untimed warm-up
    model.conds = conds[next(iter(conds))]
    torch.manual_seed(args.seed)
    model.generate(common.WARM_UP)

    for ln in lines:
        model.conds = conds[ln["voice"]]
        torch.manual_seed(args.seed + all_ids.index(ln["id"]))
        t = time.perf_counter()
        wav = model.generate(common.text_for(ln))
        s = time.perf_counter() - t
        run.line(ln, wav.squeeze(0).numpy(), model.sr, s)

    run.save(model=REPO, revision=REVISION, package="chatterbox-tts 0.1.7 source at ab55923c27757c90cfcc407baa57dc25a7d25217",
             torch=torch.__version__, torch_threads=torch.get_num_threads(), cond_prep_s=prep,
             peak_rss_gb=peak_rss_gb(), net_attempts=NET_ATTEMPTS, watermark="Perth implicit, always on (package default, untouched)",
             first_audio="not available: generate() returns the whole line, no streaming",
             builtin_voice_used=False, cuda_used=False)
    print("network attempts after loading start:", NET_ATTEMPTS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
