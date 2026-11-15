"""Does a voice stay the same voice, and do the voices of the cast differ? Measured with the voice
encoder of the Chatterbox package (ve.safetensors, MIT).

    .venv-voice/chatterbox-nano/Scripts/python.exe tools/voice/identity.py
    <python> tools/voice/with_lock.py -- .venv-voice/chatterbox-nano/Scripts/python.exe tools/voice/identity.py

Embeds every WAV under assets/audio/voice/<model>/<device>/ (and the clips under <model>/cast/,
WAV only) and writes assets/audio/voice/identity.json. Per model and device, per cast voice:

- same_voice:  mean pairwise cosine between the lines of that voice (needs two lines or more);
- to_cast:     mean cosine of the lines to the cast clip of that voice. The clip is the model's own
               cast/<voice>.wav; a model that took its clips from another model (--cast-from) has none
               of its own, so the clip named in its cast/<voice>.json (or timing.json) is used and
               'cast_clip' says which file it was;
- different_voices: mean cosine between lines of different voices (all such pairs), plus the same
               figure per pair of voices. Lower is better apart; same_voice higher is more stable.

A model that is missing, or has only some lines, simply has fewer numbers; a file whose name is no
line id of lines.json is listed under 'unknown_files'. Everything is recomputed from the files on
every run, so the script can be run again whenever more models exist. Only the CPU is used.
"""
from __future__ import annotations

import os
import sys

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ.pop("HF_TOKEN", None)

import itertools  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np  # noqa: E402
import common  # noqa: E402

REPO = "ResembleAI/chatterbox-nano"
REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"
OUTFILE = common.OUT / "identity.json"


def load_encoder():
    import torch
    from huggingface_hub import snapshot_download
    from safetensors.torch import load_file
    from chatterbox.models.voice_encoder import VoiceEncoder

    torch.set_num_threads(4)
    snap = snapshot_download(REPO, revision=REVISION, allow_patterns=["ve.safetensors"], local_files_only=True)
    ve = VoiceEncoder()
    ve.load_state_dict(load_file(Path(snap) / "ve.safetensors"))
    return ve.eval(), VoiceEncoder.__module__


def embed(ve, path: Path) -> np.ndarray | None:
    import soundfile as sf

    try:
        x, sr = sf.read(str(path), dtype="float32", always_2d=False)
        x = common.to_mono(x)
        if x.size < sr * 0.5:
            return None
        if sr != 16000:  # resampled here (librosa default, as the package does in prepare_conditionals): its own kaiser_fast route needs resampy
            import librosa
            x = librosa.resample(x, orig_sr=sr, target_sr=16000)
        e = ve.embeds_from_wavs([x], sample_rate=16000)
        v = np.asarray(e[0], dtype=np.float64)
        return v / np.linalg.norm(v)
    except Exception as exc:  # a broken file must not stop the others
        print("skipped %s: %s" % (path, exc))
        return None


def mean(vals):
    return round(float(np.mean(vals)), 4) if len(vals) else None


def reference_clip(model_dir: Path, vid: str) -> Path | None:
    own = model_dir / "cast" / (vid + ".wav")
    if own.exists():
        return own
    for meta, getter in ((model_dir / "cast" / (vid + ".json"), lambda d: d.get("reference_clip")),
                         (None, None)):
        if meta is None:
            break
        if meta.exists():
            try:
                rel = getter(json.loads(meta.read_text(encoding="utf-8")))
                if rel and (common.ROOT / rel).exists():
                    return common.ROOT / rel
            except Exception:
                pass
    for t in sorted(model_dir.glob("*/timing.json")):
        try:
            rel = json.loads(t.read_text(encoding="utf-8")).get("voices", {}).get(vid, {}).get("reference")
            if rel and (common.ROOT / rel).exists():
                return common.ROOT / rel
        except Exception:
            pass
    return None


def main() -> int:
    t0 = time.perf_counter()
    line_voice = {ln["id"]: ln["voice"] for ln in common.load_lines()}
    voices = list(common.load_cast())
    ve, _ = load_encoder()
    cache: dict[Path, np.ndarray | None] = {}

    def emb(p: Path):
        if p not in cache:
            cache[p] = embed(ve, p)
        return cache[p]

    models = {}
    for mdir in sorted(p for p in common.OUT.iterdir() if p.is_dir() and not p.name.startswith(("_", "."))):
        entry: dict = {"devices": {}, "cast": {}, "unknown_files": []}
        # cast clips of the model itself
        cast_e = {}
        for vid in voices:
            w = mdir / "cast" / (vid + ".wav")
            if w.exists():
                e = emb(w)
                if e is not None:
                    cast_e[vid] = e
        if cast_e:
            pairs = {"%s|%s" % (a, b): round(float(cast_e[a] @ cast_e[b]), 4)
                     for a, b in itertools.combinations(sorted(cast_e), 2)}
            entry["cast"] = {"voices": sorted(cast_e), "different_voices": mean(list(pairs.values())), "pairs": pairs}
        for ddir in sorted(p for p in mdir.iterdir() if p.is_dir() and p.name != "cast"):
            wavs = sorted(ddir.glob("*.wav"))
            if not wavs:
                continue
            per_voice: dict[str, dict[str, np.ndarray]] = {}
            for w in wavs:
                vid = line_voice.get(w.stem)
                if vid is None:
                    entry["unknown_files"].append(str(w.relative_to(common.ROOT)).replace("\\", "/"))
                    continue
                e = emb(w)
                if e is not None:
                    per_voice.setdefault(vid, {})[w.stem] = e
            dev = {"lines_embedded": sum(len(v) for v in per_voice.values()), "voices": {}}
            for vid in voices:
                lines = per_voice.get(vid)
                if not lines:
                    continue
                es = list(lines.values())
                same = [float(a @ b) for a, b in itertools.combinations(es, 2)]
                clip = reference_clip(mdir, vid)
                ce = emb(clip) if clip else None
                dev["voices"][vid] = {
                    "n_lines": len(es),
                    "same_voice": mean(same),
                    "to_cast": mean([float(e @ ce) for e in es]) if ce is not None else None,
                    "cast_clip": str(clip.relative_to(common.ROOT)).replace("\\", "/") if clip else None,
                }
            # lines of different voices, pooled and per pair of voices
            cross, per_pair = [], {}
            for a, b in itertools.combinations(sorted(per_voice), 2):
                sims = [float(x @ y) for x in per_voice[a].values() for y in per_voice[b].values()]
                per_pair["%s|%s" % (a, b)] = mean(sims)
                cross += sims
            dev["different_voices"] = mean(cross)
            dev["different_voices_pairs"] = per_pair
            same_all = [v["same_voice"] for v in dev["voices"].values() if v["same_voice"] is not None]
            dev["same_voice_mean_of_voices"] = mean(same_all)
            cast_all = [v["to_cast"] for v in dev["voices"].values() if v["to_cast"] is not None]
            dev["to_cast_mean_of_voices"] = mean(cast_all)
            entry["devices"][ddir.name] = dev
        if entry["devices"] or entry["cast"]:
            if not entry["unknown_files"]:
                del entry["unknown_files"]
            models[mdir.name] = entry

    out = {"encoder": "Chatterbox VoiceEncoder (ve.safetensors of %s @ %s)" % (REPO, REVISION),
           "note": "cosine similarity of L2-normalised 256-d speaker embeddings, audio resampled to 16 kHz with librosa's default resampler. "
                   "same_voice: higher is steadier. different_voices: lower is better apart. "
                   "to_cast: the lines against the cast clip that fixes the voice.",
           "made_in_s": round(time.perf_counter() - t0, 1),
           "models": models}
    OUTFILE.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("wrote", OUTFILE)
    for name, m in models.items():
        for dname, d in m["devices"].items():
            print("%-24s %-5s lines %2d  same %s  apart %s  to_cast %s" % (
                name, dname, d["lines_embedded"], d["same_voice_mean_of_voices"], d["different_voices"], d["to_cast_mean_of_voices"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
