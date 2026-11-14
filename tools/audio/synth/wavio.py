"""Writing 16-bit WAV at 48 kHz with dither (deterministic: the dither is seeded by the sound id)."""
from __future__ import annotations

import numpy as np

from .core import SR, seeded


def to_int16(x: np.ndarray, dither_seed: str = "dither") -> np.ndarray:
    """Float in -1..1 to int16 with TPDF dither of +-1 LSB and clipping to the int16 range."""
    x = np.asarray(x, dtype=np.float64)
    rng = seeded("dither/" + dither_seed)
    d = rng.random(x.shape) - rng.random(x.shape)
    y = np.rint(x * 32767.0 + d)
    return np.clip(y, -32768, 32767).astype(np.int16)


def write_wav(path, x: np.ndarray, dither_seed: str = "dither") -> bytes:
    """Write x (n,) or (n, channels) as 16-bit PCM at 48 kHz. Returns the sample bytes."""
    import soundfile as sf
    from pathlib import Path

    pcm = to_int16(x, dither_seed)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), pcm, SR, subtype="PCM_16")
    return pcm.tobytes()
