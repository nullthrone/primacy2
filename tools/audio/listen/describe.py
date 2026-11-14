"""Ask Qwen2-Audio-7B-Instruct (local cache only) what a sound is.

    python tools/audio/listen/describe.py a.wav b.wav [--question "What is this sound?"] [--mode auto|bnb4|quanto|offload] [--json]

The model does not fit the 16 GB card in half precision, so it is loaded 4-bit (bitsandbytes,
language model only; the audio encoder stays in fp16), or with another strategy, see --mode.
Exit code 3 and one sentence on stderr if no strategy works on this machine.
No other tool depends on this one.
"""
from __future__ import annotations

import argparse
import gc
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

MODEL_ID = "Qwen/Qwen2-Audio-7B-Instruct"
MODEL_SR = 16000
MAX_S = 30  # the audio encoder takes at most 30 s; longer clips are cut here
SKIP_QUANT = ["audio_tower", "multi_modal_projector", "lm_head"]
DEFAULT_QUESTION = "What is this sound?"


class Describer:
    def __init__(self, mode: str = "auto"):
        common.offline_env()
        import torch

        self.torch = torch
        errors = []
        order = ["bnb4", "quanto", "offload"] if mode == "auto" else [mode]
        for m in order:
            t0 = time.time()
            try:
                self._load(m)
                self.mode = m
                self.load_seconds = round(time.time() - t0, 1)
                return
            except Exception as exc:
                errors.append("%s: %s: %s" % (m, type(exc).__name__, str(exc)[:300]))
                self.model = None
                gc.collect()
                torch.cuda.empty_cache()
        raise RuntimeError("; ".join(errors))

    def _load(self, mode: str):
        torch = self.torch
        from transformers import AutoProcessor, Qwen2AudioForConditionalGeneration

        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA device")
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, local_files_only=True)
        kw = dict(local_files_only=True, dtype=torch.float16)
        if mode == "bnb4":
            from transformers import BitsAndBytesConfig

            kw["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
                llm_int8_skip_modules=SKIP_QUANT,
            )
            kw["device_map"] = {"": 0}
        elif mode == "quanto":
            from transformers import QuantoConfig

            kw["quantization_config"] = QuantoConfig(weights="int4", modules_to_not_convert=SKIP_QUANT)
            kw["device_map"] = {"": 0}
        elif mode == "offload":
            # What does not fit in 12 GiB of video memory lies in main memory (slow).
            kw["device_map"] = "auto"
            kw["max_memory"] = {0: "12GiB", "cpu": "30GiB"}
        else:
            raise ValueError(mode)
        torch.cuda.reset_peak_memory_stats()
        self.model = Qwen2AudioForConditionalGeneration.from_pretrained(MODEL_ID, **kw).eval()

    def ask(self, mono: np.ndarray, sr: int, question: str, max_new_tokens: int = 80) -> str:
        torch = self.torch
        x = common.resample(mono.astype(np.float32), sr, MODEL_SR)[: MAX_S * MODEL_SR]
        conv = [
            {"role": "user", "content": [{"type": "audio", "audio_url": "clip"}, {"type": "text", "text": question}]}
        ]
        text = self.processor.apply_chat_template(conv, add_generation_prompt=True, tokenize=False)
        inputs = self.processor(text=text, audio=[x], sampling_rate=MODEL_SR, return_tensors="pt", padding=True)
        dev = next(self.model.parameters()).device
        inputs = {k: (v.to(dev) if hasattr(v, "to") else v) for k, v in inputs.items()}
        for k, v in inputs.items():
            if hasattr(v, "dtype") and v.dtype == torch.float32 and "feature" in k:
                inputs[k] = v.to(torch.float16)
        with torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        out = out[:, inputs["input_ids"].shape[1] :]
        return self.processor.batch_decode(out, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0].strip()

    def peak_gib(self) -> float:
        return round(self.torch.cuda.max_memory_allocated() / 2**30, 2)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--question", default=DEFAULT_QUESTION)
    ap.add_argument("--mode", default="auto", choices=["auto", "bnb4", "quanto", "offload"])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    with common.gpu_lock("describe.py"):
        try:
            d = Describer(args.mode)
        except Exception as exc:
            print(
                "describe.py: Qwen2-Audio-7B cannot be loaded on this machine (%s); use measure.py and compare.py instead."
                % str(exc)[:600],
                file=sys.stderr,
            )
            return 3
        out = {}
        for fn in args.files:
            try:
                data, sr = common.load_audio(fn)
                t0 = time.time()
                ans = d.ask(common.to_mono(data), sr, args.question)
                out[fn] = {"answer": ans, "seconds": round(time.time() - t0, 1)}
            except Exception as exc:
                out[fn] = {"error": "%s: %s" % (type(exc).__name__, str(exc)[:400])}
        meta = {"mode": d.mode, "loadSeconds": d.load_seconds, "peakGpuGiB": d.peak_gib()}
    if args.json:
        common.dump({"meta": meta, "results": out}, True)
    else:
        print("# mode %(mode)s, load %(loadSeconds)s s, peak GPU %(peakGpuGiB)s GiB" % meta)
        for fn, r in out.items():
            print("%s: %s" % (fn, r.get("answer", "ERROR " + r.get("error", ""))))
    return 1 if any("error" in r for r in out.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
