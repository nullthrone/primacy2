"""Shared helpers of the listening tools: audio loading, output, device choice, GPU lock."""
from __future__ import annotations

import contextlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
CACHE_DIR = ROOT / "assets" / "audio" / "cache"
LOCK_FILE = CACHE_DIR / "gpu.lock"
LOCK_WAIT_SECONDS = 600


def load_audio(path, mono: bool = False):
    """Read a file as float32, shape (frames, channels). Returns (data, sample_rate)."""
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if mono and data.shape[1] > 1:
        data = data.mean(axis=1, keepdims=True)
    return data, int(sr)


def to_mono(data: np.ndarray) -> np.ndarray:
    return data if data.ndim == 1 else data.mean(axis=1)


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Polyphase resampling along axis 0; exact rational ratio, no phase shift."""
    if sr_in == sr_out:
        return x
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(sr_in, sr_out)
    return resample_poly(x, sr_out // g, sr_in // g, axis=0).astype(np.float32)


def dump(obj, as_json: bool, text: str | None = None) -> None:
    """Print JSON for machines or the given compact text for readers."""
    if as_json or text is None:
        print(json.dumps(obj, indent=2, ensure_ascii=False))
    else:
        print(text)


def pick_device(prefer: str | None = None) -> str:
    import torch

    if prefer:
        return prefer
    return "cuda" if torch.cuda.is_available() else "cpu"


def offline_env() -> None:
    """Models come from the local Hugging Face cache only; never download."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _pid_alive(pid: int) -> bool:
    try:
        import psutil

        return psutil.pid_exists(pid)
    except ImportError:
        return True


@contextlib.contextmanager
def gpu_lock(label: str, wait_seconds: float = LOCK_WAIT_SECONDS):
    """Only one process at a time holds a large model. O_EXCL create is atomic on Windows.

    A lock whose owner process is gone is taken over, so a crashed run does not block everybody.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + wait_seconds
    announced = False
    while True:
        try:
            fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, json.dumps({"pid": os.getpid(), "label": label, "since": time.time()}).encode())
            os.close(fd)
            break
        except FileExistsError:
            holder = {}
            try:
                holder = json.loads(LOCK_FILE.read_text())
            except Exception:
                pass
            pid = holder.get("pid")
            if pid and not _pid_alive(int(pid)):
                with contextlib.suppress(FileNotFoundError, PermissionError):
                    LOCK_FILE.unlink()
                continue
            if time.time() > deadline:
                sys.exit(
                    f"GPU lock {LOCK_FILE} still held by pid {pid} ({holder.get('label')}) "
                    f"after {int(wait_seconds)} s; try again later."
                )
            if not announced:
                print(f"waiting for the GPU lock held by {holder.get('label')} (pid {pid})", file=sys.stderr)
                announced = True
            time.sleep(1.0)
    try:
        yield
    finally:
        with contextlib.suppress(FileNotFoundError, PermissionError):
            LOCK_FILE.unlink()
