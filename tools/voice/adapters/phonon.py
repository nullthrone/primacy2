"""Phonon 31M English (Gradium), runtime ptts 0.7.1 (Rust, CPU only on this Windows wheel).

Variants, chosen with --variant (removed from argv before common.parse_args reads it):
  phonon        weights model.safetensors (f32), main run
  phonon-q8     weights model.q8.gguf (8 bit), same voices
  phonon-blend  f32, the lines marked listen only, voices blended from two character embeddings

    .venv-voice/phonon/Scripts/python.exe tools/voice/adapters/phonon.py --device cpu --threads 4

Model and voice files are read from the local Hugging Face cache at a pinned revision, with the
hub set offline, so the runtime fetches nothing. Only the twelve voices that the voices card
states were made with Gradium Voice Design are ever taken; the 90 catalogue voices are not.
"""
from __future__ import annotations

import os
import sys

# CPU only: no graphics card may be used, and the runtime must not reach the network.
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ.pop("HF_TOKEN", None)

variant = "phonon"
if "--variant" in sys.argv:
    i = sys.argv.index("--variant")
    variant = sys.argv[i + 1]
    del sys.argv[i:i + 2]
if variant not in ("phonon", "phonon-q8", "phonon-blend"):
    raise SystemExit("unknown variant " + variant)

import json  # noqa: E402
import shutil  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import common  # noqa: E402

MODEL_REPO, MODEL_REV = "gradium/phonon-31m-en", "92741c5b07d085ff840e26fea8ce43110b87852f"
VOICE_REPO, VOICE_REV = "gradium/phonon-voices", "0ee17205f254b5abc43b266c8a0f215565c352f7"

# Characters used (all among the twelve that the card states were made with Gradium Voice Design).
CHARACTERS = {
    "Snow Queen": "NIWoEurJHMJjyUTe", "Fairy Godmother": "QXNr0SvkukLB4wPq",
    "Vyrmathrax": "xO8xQo3BrB8FuI6J", "Grub": "cYtsRSxV5q9IMehn", "Old Mortlake": "lX3LavMNdlIbgEHH",
}
# cast voice -> (character, why)
PICK = {
    "control_f": ("Fairy Godmother", "woman; low, unhurried, calm alto. Age (sixties vs forties) and warmth do not fit, clipped delivery is not described"),
    "pilot_m": ("Vyrmathrax", "no human man of thirties among the characters; dry, offhand, gravelly, slow and low is the nearest manner, but far deeper than a thirty-year-old"),
    "computer": ("Snow Queen", "woman; cool, poised, precise articulation, unhurried: the closest description to a composed machine voice"),
    "dock_m": ("Grub", "man; gruff, grainy, low, slow, warm humour under the grumble; nearer to a fifty-year-old foreman than the other male characters"),
}
# blend run: cast voice -> {character: weight}
BLEND = {
    "control_f": {"Fairy Godmother": 0.5, "Snow Queen": 0.5},
    "computer": {"Snow Queen": 0.7, "Fairy Godmother": 0.3},
    "dock_m": {"Grub": 0.5, "Old Mortlake": 0.5},
}


def peak_working_set_mb():
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        if ctypes.windll.psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return round(pmc.PeakWorkingSetSize / 1e6, 1)
    except Exception:
        pass
    return None


def main():
    args = common.parse_args(__doc__.splitlines()[0])
    if args.device != "cpu":
        raise SystemExit("phonon: ptts 0.7.1 on Windows offers the device cpu only; no graphics card run exists")
    import numpy as np
    from huggingface_hub import snapshot_download
    from safetensors.numpy import load_file, save_file
    import ptts

    ptts.set_num_threads(args.threads)
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    quant = "q8" if variant == "phonon-q8" else "f32"

    model_dir = snapshot_download(MODEL_REPO, revision=MODEL_REV, local_files_only=True,
                                  allow_patterns=["config.json", "tokenizer.json", "model.safetensors", "model.q8.gguf", "generation_config.json"])
    voice_dir = Path(snapshot_download(VOICE_REPO, revision=VOICE_REV, local_files_only=True,
                                       allow_patterns=["voices/%s.safetensors" % v for v in CHARACTERS.values()])) / "voices"

    lines = common.load_lines(args.lines)
    if variant == "phonon-blend":
        lines = [ln for ln in lines if ln.get("listen")]
    cast = common.load_cast()
    used = sorted({ln["voice"] for ln in lines})
    run = common.Run(variant, "cpu", args.threads)
    cast_dir = common.model_dir(variant) / "cast"
    cast_dir.mkdir(parents=True, exist_ok=True)

    def emb(char):
        x = load_file(str(voice_dir / (CHARACTERS[char] + ".safetensors")))["speaker_wavs"]  # (1, 512, 125)
        return np.ascontiguousarray(x[0].T.astype(np.float32))  # (125, 512), as in the Transformers example

    t0 = time.perf_counter()
    tts = ptts.TTS(str(model_dir), device="cpu", quant=quant, seed=args.seed, lang="en")
    sr = tts.sample_rate
    for vid in used:
        if variant == "phonon-blend":
            mix = BLEND[vid]
            # add_voice_from_embedding gave 33 percent longer audio than the same embedding read from its
            # file (the null branch of CFG is missing), so the blend is written as a file in the card's
            # format (1, 512, 125, metadata sig/epoch) and loaded through add_voice, like every other voice.
            e = sum(w * np.asarray(load_file(str(voice_dir / (CHARACTERS[c] + ".safetensors")))["speaker_wavs"], dtype=np.float32)
                    for c, w in mix.items()).astype(np.float32)
            bfile = cast_dir / (vid + ".safetensors")
            save_file({"speaker_wavs": np.ascontiguousarray(e)}, str(bfile), metadata={"sig": "ba7a5a45", "epoch": "300"})
            tts.add_voice(vid, str(bfile))
            how = "weighted average of character embedding files (1, 512, 125), written as a safetensors file in the card's format and loaded with add_voice"
            facts = {"blend": mix}
        else:
            char, why = PICK[vid]
            tts.add_voice(vid, str(voice_dir / (CHARACTERS[char] + ".safetensors")))
            how = "character voice of the voices card, made by the makers with Gradium Voice Design; used as is"
            facts = {"character": char, "embedding_id": CHARACTERS[char], "why": why, "cast_description": cast[vid]["description"]}
            shutil.copyfile(voice_dir / (CHARACTERS[char] + ".safetensors"), cast_dir / (vid + ".safetensors"))
        run.voice(vid, how, seed=args.seed, temperature=0.3, **facts)
        (cast_dir / (vid + ".json")).write_text(json.dumps(run.data["voices"][vid], indent=2), encoding="utf-8")
    first_voice = used[0]
    run.loaded(time.perf_counter() - t0)

    tts.synth(common.WARM_UP, voice=first_voice, seed=args.seed)  # untimed warm-up

    for ln in lines:
        text = common.text_for(ln)
        t = time.perf_counter()
        pcm = tts.synth(text, voice=ln["voice"], seed=args.seed)
        synth_s = time.perf_counter() - t
        # a second, separate pass through the streaming call, only for the time to the first audio
        t = time.perf_counter()
        with tts.stream(text, voice=ln["voice"], seed=args.seed) as audio:
            first = next(iter(audio))
            first_s = time.perf_counter() - t
            n_first = int(np.asarray(first).size)
        run.line(ln, pcm, sr, synth_s, first_audio_s=first_s)
        run.data["lines"][ln["id"]]["first_chunk_samples"] = n_first
    run.save(quant=tts.quant, runtime="ptts " + ptts.__version__, sample_rate=sr, peak_gpu_mb=None,
             peak_working_set_mb=peak_working_set_mb(), model_dir=str(model_dir), build=ptts.build_info(),
             note="Rust runtime, CPU only; no PyTorch, no graphics card. first_audio_s comes from a second, separate streaming pass of the same text.")


if __name__ == "__main__":
    main()
