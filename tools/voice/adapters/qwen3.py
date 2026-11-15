"""Qwen3-TTS adapter: designs the cast with VoiceDesign, speaks the lines with Base 0.6B clones.

    .venv-voice/qwen3/Scripts/python.exe tools/voice/adapters/qwen3.py --cast-only
    .venv-voice/qwen3/Scripts/python.exe tools/voice/adapters/qwen3.py --device cuda
    .venv-voice/qwen3/Scripts/python.exe tools/voice/adapters/qwen3.py --device cpu --threads 4 \
        --lines radio_clearance,computer_fold,station_dock

Extra options (read here, before common.parse_args): --cast-device cuda|cpu (default cuda).
Step 1 (--cast-only): VoiceDesign speaks each reference_text with the voice description as the
instruction, three takes (seed, seed+1, seed+2); the first sound take becomes cast/<voice>.wav.
Step 2/3: Base 0.6B builds one reusable clone prompt per voice from that clip ("voice design then
clone", README of the makers) and speaks the lines.
The package has no audio streaming (only simulated text streaming), so no time to first audio.
"""
from __future__ import annotations

import os
import sys

# --- extra options, removed from argv before common.parse_args sees them -----------------------
_cast_device = "cuda"
if "--cast-device" in sys.argv:
    i = sys.argv.index("--cast-device")
    _cast_device = sys.argv[i + 1]
    del sys.argv[i:i + 2]

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")
os.environ.pop("HF_TOKEN", None)
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402

args = common.parse_args("Qwen3-TTS: VoiceDesign cast, Base 0.6B clone prompts")
_use_cpu = (args.device == "cpu") or (args.cast_only and _cast_device == "cpu")
if _use_cpu:
    os.environ["CUDA_VISIBLE_DEVICES"] = ""  # before torch is imported: the card is not used
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)

import json  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

KEY = "qwen3"
DESIGN_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
BASE_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
LANG = "English"
CAP_LINE_S = 300.0  # five-minute rule for one line on the CPU

if _use_cpu:
    torch.set_num_threads(args.threads)
ON_CUDA = (not _use_cpu) and torch.cuda.is_available()
DEVICE = "cuda:0" if ON_CUDA else "cpu"
DTYPE = torch.bfloat16 if ON_CUDA else torch.float32  # bf16 is slow on a CPU without AMX


def sync() -> None:
    if ON_CUDA:
        torch.cuda.synchronize()


def seed_all(s: int) -> None:
    torch.manual_seed(s)
    if ON_CUDA:
        torch.cuda.manual_seed_all(s)


def load(repo: str):
    from qwen_tts import Qwen3TTSModel
    t = time.perf_counter()
    # no flash-attn: sdpa; weights are safetensors; no trust_remote_code anywhere
    m = Qwen3TTSModel.from_pretrained(repo, device_map=DEVICE, dtype=DTYPE, attn_implementation="sdpa")
    sync()
    return m, time.perf_counter() - t


def sound_check(x: np.ndarray, sr: int) -> dict:
    """Is a take broken? silent, clipped, <6 s, >25 s, or >1.5 s of silence inside."""
    x = common.to_mono(x)
    dur = x.size / sr
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    clipped = int(np.sum(np.abs(x) >= 0.999))
    hop = int(sr * 0.02)
    n = x.size // hop
    rms = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1)) if n else np.zeros(1)
    quiet = rms < max(1e-3, 0.03 * float(rms.max() if rms.size else 0.0))
    idx = np.where(~quiet)[0]
    longest_inside = 0.0
    if idx.size:
        run = 0
        for q in quiet[idx[0]: idx[-1] + 1]:
            run = run + 1 if q else 0
            longest_inside = max(longest_inside, run * 0.02)
    problems = []
    if peak < 0.02 or idx.size == 0:
        problems.append("silent")
    if clipped > 5:
        problems.append("clipped (%d samples at full scale)" % clipped)
    if dur < 6.0:
        problems.append("shorter than 6 s (%.2f s)" % dur)
    if dur > 25.0:
        problems.append("longer than 25 s (%.2f s)" % dur)
    if longest_inside > 1.5:
        problems.append("%.2f s of silence inside" % longest_inside)
    return {"duration_s": round(dur, 3), "peak": round(peak, 4), "clipped_samples": clipped,
            "longest_inner_silence_s": round(longest_inside, 2), "problems": problems, "sound": not problems}


def make_cast() -> None:
    cast = common.load_cast()
    out = common.model_dir(KEY) / "cast"
    (out / "takes").mkdir(parents=True, exist_ok=True)
    model, load_s = load(DESIGN_REPO)
    print("VoiceDesign loaded on %s in %.1f s" % (DEVICE, load_s))
    import shutil
    summary = {}
    for vid, v in cast.items():
        takes = []
        for n in range(3):
            seed = args.seed + n
            seed_all(seed)
            t = time.perf_counter()
            wavs, sr = model.generate_voice_design(text=v["reference_text"], instruct=v["description"],
                                                   language=LANG, max_new_tokens=600)
            sync()
            took = time.perf_counter() - t
            p = out / "takes" / ("%s_%d.wav" % (vid, n + 1))
            info = common.write_wav(p, wavs[0], sr)
            chk = sound_check(wavs[0], sr)
            chk.update(take=n + 1, seed=seed, file=info["file"], sr=sr, synth_s=round(took, 2))
            takes.append(chk)
            print("%-10s take %d seed %d: %.2f s audio, peak %.3f, %s" % (
                vid, n + 1, seed, chk["duration_s"], chk["peak"], chk["problems"] or "ok"))
        chosen = next((t for t in takes if t["sound"]), None)
        if chosen is None:
            chosen = takes[0]
            why = "no take passed the checks; take 1 kept anyway"
        elif chosen["take"] == 1:
            why = "take 1 passed all checks (not silent, not clipped, 6-25 s, no inner silence over 1.5 s)"
        else:
            why = "take 1 broken (%s); next sound take" % "; ".join(takes[0]["problems"])
        shutil.copyfile(out / "takes" / ("%s_%d.wav" % (vid, chosen["take"])), out / (vid + ".wav"))
        meta = {"voice": vid, "model": DESIGN_REPO, "device": DEVICE, "dtype": str(DTYPE),
                "description": v["description"], "text": v["reference_text"], "language": LANG,
                "seed": chosen["seed"], "base_seed": args.seed, "take": chosen["take"], "why": why,
                "takes": takes, "clip": "assets/audio/voice/qwen3/cast/%s.wav" % vid,
                "sample_rate": chosen["sr"], "load_s": round(load_s, 2)}
        (out / (vid + ".json")).write_text(json.dumps(meta, indent=2), encoding="utf-8")
        summary[vid] = {"take": chosen["take"], "why": why, "duration_s": chosen["duration_s"]}
    if ON_CUDA:
        summary["_peak_gpu_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
    (out / "_cast_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    del model


def speak_lines() -> None:
    import soundfile as sf
    lines = common.load_lines(args.lines)
    cast = common.load_cast()
    run = common.Run(KEY, args.device, args.threads)
    model, load_s = load(BASE_REPO)
    run.loaded(load_s)
    print("Base 0.6B loaded on %s (%s) in %.1f s" % (DEVICE, DTYPE, load_s))
    prompts = {}
    t = time.perf_counter()
    for vid in sorted({ln["voice"] for ln in lines}):
        clip = common.cast_clip(KEY, vid)
        if not clip.exists():
            raise SystemExit("missing cast clip %s: run --cast-only first" % clip)
        x, sr = sf.read(str(clip), dtype="float32")
        prompts[vid] = model.create_voice_clone_prompt(ref_audio=(x, sr), ref_text=cast[vid]["reference_text"],
                                                      x_vector_only_mode=False)
        meta = json.loads(clip.with_suffix(".json").read_text(encoding="utf-8"))
        run.voice(vid, "VoiceDesign clip -> Base 0.6B create_voice_clone_prompt (ICL mode)",
                  description=cast[vid]["description"], clip=meta["clip"], design_seed=meta["seed"], take=meta["take"])
    sync()
    prompt_s = time.perf_counter() - t
    # one untimed warm-up sentence
    first = prompts[lines[0]["voice"]]
    model.generate_voice_clone(text=common.WARM_UP, language=LANG, voice_clone_prompt=first, max_new_tokens=400)
    sync()
    if ON_CUDA:
        torch.cuda.reset_peak_memory_stats()
    state = {"line": None}

    def too_slow() -> None:  # CPU five-minute rule: keep what exists, report the figure
        run.data["aborted"] = "line %s exceeded %.0f s on %s" % (state["line"], CAP_LINE_S, args.device)
        run.save(clone_prompt_s=round(prompt_s, 2), first_audio="not available: the package has no audio streaming")
        print("ABORT:", run.data["aborted"])
        os._exit(3)

    for ln in lines:
        state["line"] = ln["id"]
        timer = None
        if not ON_CUDA:
            timer = threading.Timer(CAP_LINE_S, too_slow)
            timer.daemon = True
            timer.start()
        seed_all(args.seed)
        sync()
        t = time.perf_counter()
        wavs, sr = model.generate_voice_clone(text=common.text_for(ln), language=LANG,
                                              voice_clone_prompt=prompts[ln["voice"]], max_new_tokens=1000)
        sync()
        took = time.perf_counter() - t
        if timer:
            timer.cancel()
        run.line(ln, wavs[0], sr, took)
    extra = {"clone_prompt_s": round(prompt_s, 2), "dtype": str(DTYPE),
             "first_audio": "not available: the package has no audio streaming (non_streaming_mode only simulates streamed text input)"}
    if ON_CUDA:
        extra["peak_gpu_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 3)
    run.save(**extra)


if __name__ == "__main__":
    if args.cast_only:
        make_cast()
    else:
        speak_lines()
