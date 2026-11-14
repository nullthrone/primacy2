"""Quiet stand-in sounds for the audition page.

Writes one WAV per sound of tools/audio/sounds.json into assets/audio/render/<category>/<id>.wav,
a small spectrogram PNG next to it, and render/manifest.json after the contract in
tools/audio/SOUND_DESIGN.md section 3, marked "placeholder": true. The tones are not meant to be
good: they only give every sound the right duration, channel count, kind and a shape of its own,
so that the page can be built and tested before the real sounds exist.

    .venv-audio/Scripts/python.exe tools/audio/placeholder.py [--force]

Refuses to run when a manifest without "placeholder": true exists (the real sounds are there).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
SOUNDS = ROOT / "tools" / "audio" / "sounds.json"
RENDER = ROOT / "assets" / "audio" / "render"
MANIFEST = RENDER / "manifest.json"

# Loudspeaker sounds are rendered dry; everything else has the cabin baked in (SOUND_DESIGN.md, section 3).
DRY_CATEGORIES = {"alarms", "sensors", "radio"}
# The list does not carry a channel count; these are the two-channel ones named in the design.
STEREO_IDS = {"cabin_ambience_loop", "silent_running_loop", "cabin_ir"}
PEAK = 10 ** (-12 / 20)


def rng_for(sound_id: str) -> np.random.Generator:
    seed = int.from_bytes(hashlib.sha256(sound_id.encode()).digest()[:8], "little")
    return np.random.default_rng(seed)


def periodic_noise(rng: np.random.Generator, n: int, sr: int, lo: float, hi: float) -> np.ndarray:
    """Band-limited noise built from random phases on integer bins, so it repeats exactly after n samples."""
    spec = np.zeros(n // 2 + 1, dtype=complex)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    spec[band] = np.exp(1j * rng.uniform(0, 2 * np.pi, band.sum()))
    x = np.fft.irfft(spec, n)
    return x / (np.max(np.abs(x)) + 1e-9)


def loop_wave(s: dict, rng: np.random.Generator, sr: int) -> np.ndarray:
    dur = s["duration"]
    n = int(round(dur * sr))
    t = np.arange(n) / sr
    structure = s["path"] == "structure"
    thrust = (s.get("params") or {}).get("thrust")
    base = rng.uniform(40, 110) if structure else rng.uniform(200, 900)
    # Whole cycles per loop so the seam is silent.
    base = max(1, round(base * dur)) / dur
    level = 0.35 if thrust is None else 0.2 + 0.5 * min(thrust, 1.4)
    x = np.zeros(n)
    for k, amp in enumerate((1.0, 0.5, 0.3), start=1):
        f = max(1, round(base * k * (1 + 0.013 * k) * dur)) / dur
        x += amp * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28))
    hi = 300 + (900 * thrust if thrust is not None else 400) if structure else 3000
    x = x * level + 0.6 * level * periodic_noise(rng, n, sr, 20, hi)
    if "alarm" in s["id"] or "pulse" in s["id"]:
        # A pulse pattern of its own, a whole number of beats per loop.
        beats = int(rng.integers(2, 6)) * max(1, int(dur))
        x *= 0.55 + 0.45 * (np.sin(2 * np.pi * beats / dur * t) > 0)
    return x


def oneshot_wave(s: dict, rng: np.random.Generator, sr: int) -> np.ndarray:
    dur = s["duration"]
    n = int(round(dur * sr))
    t = np.arange(n) / sr
    structure = s["path"] == "structure"
    f = rng.uniform(45, 180) if structure else rng.uniform(300, 1800)
    decay = max(0.03, dur / rng.uniform(3, 6))
    env = np.exp(-t / decay)
    attack = np.minimum(1.0, t / 0.003)
    body = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 2.31 * t)
    noise = rng.standard_normal(n)
    # A sweep for the drive and power sounds so that they differ from the thumps.
    if any(w in s["id"] for w in ("charge", "power_up", "engage", "jump")):
        body = np.sin(2 * np.pi * (f + (f * 3) * (t / dur) ** 2) * t)
        env = np.minimum(1.0, t / (dur * 0.6)) * np.minimum(1.0, (dur - t) / 0.1)
    x = (body * 0.8 + noise * (0.15 if structure else 0.05)) * env * attack
    tail = int(0.02 * sr)
    x[-tail:] *= np.linspace(1, 0, tail)
    return x


def impulse_response(rng: np.random.Generator, sr: int, n: int, channels: int) -> np.ndarray:
    t = np.arange(n) / sr
    out = np.stack([rng.standard_normal(n) * np.exp(-t / 0.08) for _ in range(channels)], axis=1)
    out[0, :] = 1.0
    return out


def make_audio(s: dict, sr: int) -> np.ndarray:
    rng = rng_for(s["id"])
    channels = 2 if s["id"] in STEREO_IDS else 1
    if s["kind"] == "ir":
        ir = impulse_response(rng, sr, int(s["duration"] * sr), channels)
        return ir / np.max(np.abs(ir)) * 0.5
    x = loop_wave(s, rng, sr) if s["kind"] == "loop" else oneshot_wave(s, rng, sr)
    x = x - np.mean(x)
    x = x / (np.max(np.abs(x)) + 1e-9) * PEAK
    if channels == 2:
        # Slightly different second channel; a copy would hide a left/right mix-up on the page.
        shift = 7
        x = np.stack([x, np.roll(x, shift)], axis=1)
    return x.reshape(-1, channels) if channels == 1 else x


def checks_for(s: dict, x: np.ndarray, sr: int) -> dict:
    mono = x.mean(axis=1) if x.ndim == 2 else x
    peak = float(np.max(np.abs(x)))
    peak_db = 20 * np.log10(peak + 1e-12)
    rms_db = 20 * np.log10(np.sqrt(np.mean(mono**2)) + 1e-12)
    spec = np.abs(np.fft.rfft(mono)) ** 2
    freqs = np.fft.rfftfreq(len(mono), 1 / sr)
    total = spec.sum() + 1e-18
    rng = rng_for(s["id"] + "clap")
    failed = []
    if peak_db > -1:
        failed.append("true peak above -1 dBFS")
    if abs(float(np.mean(mono))) >= 0.001:
        failed.append("DC offset")
    pos = s.get("pos") or ["placeholder"]
    return {
        "pass": not failed,
        "failed": failed,
        "peakDb": round(float(peak_db), 1),
        # Rough stand-in for loudness: RMS level with the usual K-weighting offset; the real tool measures properly.
        "lufs": round(float(rms_db - 0.7), 1),
        "lowShare": round(float(spec[freqs < 500].sum() / total), 3),
        "highShare": round(float(spec[freqs > 4000].sum() / total), 4),
        "clap": {"best": pos[0], "margin": round(float(rng.uniform(0.02, 0.12)), 3)},
        "described": "Placeholder tone, not described by a model.",
    }


def write_png(path: Path, rgb: np.ndarray) -> None:
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def spectrogram_png(path: Path, x: np.ndarray, sr: int) -> None:
    mono = x.mean(axis=1) if x.ndim == 2 else x
    win, hop, width, height = 1024, max(256, len(mono) // 320), 320, 80
    frames = []
    for i in range(width):
        seg = mono[i * hop : i * hop + win]
        if len(seg) < win:
            seg = np.pad(seg, (0, win - len(seg)))
        frames.append(np.abs(np.fft.rfft(seg * np.hanning(win))))
    mag = np.array(frames).T[::-1]  # low frequencies at the bottom
    # Squash 513 bins to the picture height on a log-ish axis, 0 to 8 kHz.
    keep = mag[mag.shape[0] - int(win / 2 * 8000 / (sr / 2)) :, :]
    rows = np.linspace(0, keep.shape[0] - 1, height).astype(int)
    db = 20 * np.log10(keep[rows] + 1e-6)
    v = np.clip((db - (db.max() - 70)) / 70, 0, 1)
    rgb = np.stack([v**1.5 * 255, v**1.1 * 220 + 20, 40 + v * 180 * (1 - v * 0.4)], axis=2).astype(np.uint8)
    write_png(path, rgb)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="overwrite even when real sounds are rendered")
    args = ap.parse_args()

    if MANIFEST.exists() and not args.force:
        try:
            existing = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing = {}
        if not existing.get("placeholder"):
            print(f"{MANIFEST} holds real sounds; not overwriting. Use --force to replace them.", file=sys.stderr)
            return 1

    spec = json.loads(SOUNDS.read_text(encoding="utf-8"))
    sr = spec.get("sampleRate", 48000)
    sounds = []
    for s in spec["sounds"]:
        x = make_audio(s, sr)
        out = RENDER / s["category"] / f"{s['id']}.wav"
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, x, sr, subtype="PCM_16")
        png = out.with_suffix(".png")
        spectrogram_png(png, x, sr)
        entry = {
            "id": s["id"],
            "file": f"{s['category']}/{s['id']}.wav",
            "spectrogram": f"{s['category']}/{s['id']}.png",
            "category": s["category"],
            "kind": s["kind"],
            "path": s["path"],
            "family": s.get("family"),
            "params": s.get("params") or {},
            "en": s["en"],
            "de": s["de"],
            "intent": s["intent"],
            "source": "synth",
            "licence": "AGPL-3.0-or-later",
            "duration": s["duration"],
            "channels": 1 if x.ndim == 1 or x.shape[1] == 1 else x.shape[1],
            "gain": 1.0,
            "dry": s["category"] in DRY_CATEGORIES,
            "checks": checks_for(s, x, sr),
        }
        sounds.append(entry)

    manifest = {
        "version": 1,
        "placeholder": True,
        "categories": [{k: c[k] for k in ("id", "en", "de")} for c in spec["categories"]],
        "sounds": sounds,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(sounds)} placeholder sounds and {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
