"""Adapter for Kitten TTS 2 Mini (KittenML/kitten-tts-2-mini), int8 ONNX on the CPU.

    .venv-voice/kitten/Scripts/python.exe tools/voice/adapters/kitten.py --device cpu --threads 4
    .venv-voice/kitten/Scripts/python.exe tools/voice/adapters/kitten.py --device cpu --threads 4 --blend

The model has no voice design and no cloning: a voice is a fixed style pack ([510, 256] floats, one
row per input length) with a character name. The cast voices are the nearest presets by their
card descriptions (PRESET below). With --blend the packs are mixed 50/50 (key "kitten-blend",
by default only the lines marked listen): a finding, not the main run.

Shims, all inside this file: sockets are blocked after loading (proof that nothing is fetched while
speaking), HF_HUB_OFFLINE is set, the model is read from the local snapshot, and the first-audio time
is taken by running the package's own generate_stream and joining the chunks exactly as
KittenTTS2Tiny.generate does (0.15 s of silence between chunks). The audio is what the package returns.
"""
from __future__ import annotations

import os
import sys

# before anything imports torch / onnxruntime: threads, no graphics card, no network, no telemetry
_ARGV = sys.argv[1:]
_BLEND = "--blend" in _ARGV
sys.argv = [sys.argv[0]] + [a for a in _ARGV if a != "--blend"]
_threads = 4
for _i, _a in enumerate(sys.argv):
    if _a == "--threads" and _i + 1 < len(sys.argv):
        _threads = int(sys.argv[_i + 1])
    elif _a.startswith("--threads="):
        _threads = int(_a.split("=", 1)[1])
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["OMP_NUM_THREADS"] = str(_threads)
os.environ["MKL_NUM_THREADS"] = str(_threads)
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
import numpy as np  # noqa: E402
import common  # noqa: E402

KEY = "kitten-blend" if _BLEND else "kitten"
REPO = "KittenML/kitten-tts-2-mini"
REVISION = "c01797caec3967b400da457656e011eb81f530a4"

# cast voice -> (nearest preset, second nearest preset for the blend, why). Chosen from the card's
# one-line descriptions only; nobody could listen.
PRESET = {
    "control_f": ("martha", "diana",
                  "woman, radio traffic control: 'Weathered radio journalist (female)' is the only radio preset; "
                  "'Stern military officer (female)' is the nearest in clipped, no-nonsense delivery"),
    "pilot_m": ("vincent", "danny",
                "man, relaxed and matter-of-fact: of four male presets 'Hushed museum guide (male)' is the calmest "
                "and least performed; 'Cheerful podcast host (male)' is the plain conversational one"),
    "computer": ("eleanor", "iris",
                 "woman, composed and even: 'Somber historian (female)' reads as measured and neutral; "
                 "'Hushed museum guide (female)' is the other quiet, precise one"),
    "dock_m": ("otis", "vincent",
               "man in his fifties, rough, low, tired: 'Rumbling blues musician (male)' is the only low and rough "
               "male preset; 'Hushed museum guide (male)' is the second, for the unhurried part"),
}
BLEND_W = 0.5  # weight of the first preset


def peak_ram_mb() -> float | None:
    """Peak working set of this process (Windows), in MB."""
    try:
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return round(pmc.PeakWorkingSetSize / 1048576, 1)
    except Exception:
        pass
    return None


NET_ATTEMPTS: list[str] = []


def block_network() -> None:
    real = socket.socket.connect

    def refuse(self, address, *a, **k):
        NET_ATTEMPTS.append(repr(address))
        raise OSError("network blocked by the adapter")

    socket.socket.connect = refuse  # type: ignore[assignment]
    socket.socket.connect_ex = lambda self, address, *a, **k: (NET_ATTEMPTS.append(repr(address)) or 10061)  # type: ignore[assignment]
    block_network.real = real  # type: ignore[attr-defined]


def main() -> int:
    args = common.parse_args(__doc__.splitlines()[0])
    if args.device != "cpu":
        raise SystemExit("Kitten TTS 2 Mini runs here on the CPU only (the int8 ONNX route); use --device cpu")
    if args.cast_from:
        print("note: --cast-from ignored, this model has no reference clips")
    only = args.lines
    lines = common.load_lines(only)
    if _BLEND and not only:
        lines = [ln for ln in lines if ln.get("listen")]
    cast = common.load_cast()

    t_all = time.perf_counter()
    # the partial snapshot the download step made (English files only), found in the default HF cache
    hub = Path(os.environ.get("HF_HUB_CACHE") or (Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"))
    snap = str(hub / ("models--" + REPO.replace("/", "--")) / "snapshots" / REVISION)
    if not Path(snap, "kitten_tts_2_mini.onnx").is_file():
        raise SystemExit("model files missing under " + snap)

    t0 = time.perf_counter()
    import torch  # the English G2P fallback (a small BART) runs in PyTorch, on the CPU
    torch.set_num_threads(args.threads)
    import onnxruntime as ort
    from kittenml import KittenTTS2Tiny
    t_import = time.perf_counter() - t0

    t0 = time.perf_counter()
    m = KittenTTS2Tiny(snap, backend="cpu", threads=args.threads)
    t_construct = time.perf_counter() - t0
    t0 = time.perf_counter()
    _ = m.frontend.g2p("en")          # spaCy, misaki lexicon, CMUdict, BART
    t_frontend = time.perf_counter() - t0
    t0 = time.perf_counter()
    _ = m._session("en")              # ONNX session
    pack_names = sorted({v[0] for v in PRESET.values()} | {v[1] for v in PRESET.values()})
    for k in pack_names:
        m._pack("en", k)
    t_session = time.perf_counter() - t0
    load_s = t_construct + t_frontend + t_session
    block_network()

    run = common.Run(KEY, "cpu", args.threads)
    run.loaded(load_s)

    # voices
    voice_key: dict[str, str] = {}
    for vid, v in cast.items():
        first, second, why = PRESET[vid]
        if _BLEND:
            bkey = "blend_" + vid
            pa, pb = m._pack("en", first), m._pack("en", second)
            m._packs[m.config["languages"]["en"]["voices"]][bkey] = (BLEND_W * pa + (1 - BLEND_W) * pb).astype(np.float32)
            m._voices["en"].append({"key": bkey, "name": bkey, "description": "blend " + first + "+" + second})
            voice_key[vid] = bkey
            how = "weighted mean of two preset packs, %.2f %s + %.2f %s (row by row, float32); nearest and second nearest by card description" % (BLEND_W, first, 1 - BLEND_W, second)
            facts = dict(presets=[first, second], weights=[BLEND_W, 1 - BLEND_W], why=why, seed=None)
        else:
            voice_key[vid] = first
            how = "fixed preset pack '%s' of KittenML/kitten-tts-2-mini, nearest by card description; makers do not say where the voices come from" % first
            facts = dict(preset=first, why=why, seed=None, seed_note="no seed: voices are stored vectors, the model takes none")
        run.voice(vid, how, **facts)
        d = common.model_dir(KEY) / "cast"
        d.mkdir(parents=True, exist_ok=True)
        (d / (vid + ".json")).write_text(json.dumps({"voice": vid, "description": v["description"], "how": how, **facts}, indent=2), encoding="utf-8")
    if args.cast_only:
        run.save(peak_ram_mb=peak_ram_mb())
        return 0

    gap = np.zeros(int(0.15 * m.sample_rate), dtype=np.float32)

    def speak(text: str, vkey: str):
        """-> (audio, seconds to first chunk). Same joining as KittenTTS2Tiny.generate."""
        t = time.perf_counter()
        first = None
        out = []
        for w in m.generate_stream(text, voice=vkey, language="en"):
            if first is None:
                first = time.perf_counter() - t
            out += [w, gap]
        audio = np.concatenate(out[:-1]) if out else np.zeros(0, dtype=np.float32)
        return audio, time.perf_counter() - t, first

    # one untimed warm-up sentence
    speak(common.WARM_UP, voice_key[lines[0]["voice"]])

    for ln in lines:
        text = common.text_for(ln)
        audio, secs, first = speak(text, voice_key[ln["voice"]])
        run.line(ln, audio, m.sample_rate, secs, first_audio_s=first)

    # determinism and equality with the package's own generate(), untimed
    ln = lines[0]
    a1, _, _ = speak(common.text_for(ln), voice_key[ln["voice"]])
    a2 = m.generate(common.text_for(ln), voice=voice_key[ln["voice"]], language="en")
    check = {"stream_join_equals_generate": bool(a1.shape == a2.shape and np.array_equal(a1, a2)),
             "line": ln["id"], "max_abs_diff": float(np.max(np.abs(a1 - a2))) if a1.shape == a2.shape else None}

    run.save(load_breakdown_s={"imports": round(t_import, 2), "construct": round(t_construct, 2),
                               "frontend_spacy_misaki_cmu_bart": round(t_frontend, 2), "onnx_session_and_packs": round(t_session, 2)},
             peak_ram_mb=peak_ram_mb(), gpu_peak_bytes=None,
             onnxruntime=ort.__version__, torch=torch.__version__, snapshot=REVISION,
             network_attempts_after_load=NET_ATTEMPTS, determinism=check,
             first_audio_note="seconds until the first chunk came out of generate_stream, text front end included; short lines are one chunk, so first audio equals the whole line",
             blend=_BLEND, wall_s=round(time.perf_counter() - t_all, 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
