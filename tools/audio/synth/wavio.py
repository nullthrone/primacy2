"""Writing 16-bit WAV at 48 kHz with dither (deterministic: the dither is seeded by the sound id)."""
from __future__ import annotations

import numpy as np

from .core import SR, seeded


def to_int16(x: np.ndarray, dither_seed: str = "dither", shared_dither: bool = False) -> np.ndarray:
    """Float in -1..1 to int16 with TPDF dither of +-1 LSB and clipping to the int16 range.

    With shared_dither a two-channel file gets the same dither in both channels, drawn exactly as
    a mono file of the same id draws it. The mono sum of such a file then carries the dither of the
    old mono file, so that a sound moved to two channels can be compared with its mono original
    down to the rounding of the samples."""
    x = np.asarray(x, dtype=np.float64)
    rng = seeded("dither/" + dither_seed)
    if shared_dither and x.ndim == 2:
        d = (rng.random(x.shape[0]) - rng.random(x.shape[0]))[:, None]
    else:
        d = rng.random(x.shape) - rng.random(x.shape)
    y = np.rint(x * 32767.0 + d)
    return np.clip(y, -32768, 32767).astype(np.int16)


def write_wav(path, x: np.ndarray, dither_seed: str = "dither", shared_dither: bool = False) -> bytes:
    """Write x (n,) or (n, channels) as 16-bit PCM at 48 kHz. Returns the sample bytes."""
    import soundfile as sf
    from pathlib import Path

    pcm = to_int16(x, dither_seed, shared_dither)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), pcm, SR, subtype="PCM_16")
    return pcm.tobytes()
