"""The radio loudspeaker filter, as a function and a small command line.

Band-pass 300 to 3,400 Hz, a mild overdrive, a little noise under the signal. Standalone (numpy,
scipy, soundfile only) so that it also runs on speech files made elsewhere:

    .venv-audio/Scripts/python.exe tools/audio/synth/radio.py in.wav out.wav [--drive 2.0] [--noise-db -38]
"""
from __future__ import annotations

import argparse

import numpy as np
from scipy.signal import butter, sosfiltfilt

LOW_HZ = 300.0
HIGH_HZ = 3400.0


def _band(x: np.ndarray, sr: int, order: int = 4) -> np.ndarray:
    # zero-phase, so a transmission keeps its timing; applied twice in effect (forward and back)
    sos = butter(order, [LOW_HZ, min(HIGH_HZ, 0.45 * sr)], btype="bandpass", fs=sr, output="sos")
    return sosfiltfilt(sos, x)


def radio_filter(x: np.ndarray, sr: int = 48000, drive: float = 2.0, noise_db: float | None = -40.0,
                 seed: int = 7) -> np.ndarray:
    """Make x sound like it came out of a small radio speaker.

    drive 1.0 is almost clean, 3.0 clearly overdriven. noise_db is the level of the noise bed
    relative to the signal RMS; None leaves it out (short clicks and bursts carry their own noise).
    The result keeps the input's RMS before the noise, so levels stay predictable."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    rms_in = float(np.sqrt(np.mean(x ** 2))) or 1.0
    y = _band(x, sr)
    # soft clip after the first band-limit; the second band-limit removes the harmonics it makes
    peak = max(float(np.max(np.abs(y))), 1e-9)
    y = np.tanh(drive * y / peak) / np.tanh(drive)
    y = _band(y, sr)
    y *= rms_in / (float(np.sqrt(np.mean(y ** 2))) or 1.0)
    if noise_db is not None:
        rng = np.random.Generator(np.random.PCG64(seed))
        nz = _band(rng.standard_normal(y.size), sr)
        nz *= (rms_in * 10 ** (noise_db / 20)) / (float(np.sqrt(np.mean(nz ** 2))) or 1.0)
        y = y + nz
    return y


def main() -> None:
    import soundfile as sf

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--drive", type=float, default=2.0)
    ap.add_argument("--noise-db", type=float, default=-40.0, help="noise bed under the signal; -200 for none")
    a = ap.parse_args()
    x, sr = sf.read(a.input, always_2d=False)
    y = radio_filter(x, sr, a.drive, None if a.noise_db <= -200 else a.noise_db)
    peak = float(np.max(np.abs(y)))
    if peak > 0.98:  # keep the file from clipping; the filter itself never normalises
        y = y * (0.98 / peak)
    sf.write(a.output, y, sr, subtype="PCM_16")
    print("wrote %s (%d Hz, %.2f s)" % (a.output, sr, y.size / sr))


if __name__ == "__main__":
    main()
