"""Derive fixed candidates from the raw files of an earlier round (round 7): a room, a pitch, a shelf.

    .venv-audio/Scripts/python.exe tools/sound/derive.py --prompts-file tools/sound/prompts7.json --out-root assets/audio/gen/r7

For every family of the prompts file that has a "derived" list, and for every item of it: the sha256 of
from.raw is checked (an item whose file differs is refused with a message, the others go on, the exit code is 1),
the raw file is loaded whole (one channel, its own sample rate, float), the operations of "process" are applied in
order, and the result is written to <out-root>/derived/raw/<item id>.wav (32-bit float WAV, as the MOSS adapter
writes) with <out-root>/derived/gen.json in the form of the gen.json of a MOSS run ("source": "derived").
No random state except numpy.random.default_rng(seed). A second run makes the same samples (the header of a float WAV
can carry another time stamp; gen.json holds no time and is byte for byte the same).

Operations ("op"):
  room   {rt60S, wetDb, channels 1|2, seed}  an impulse response made here (see room_ir), the raw file convolved with
         it, scaled to wetDb (10 log10 of wet energy over raw energy; two channels: the mean of the two wet channels);
         output = raw (in both channels alike) + wet, as long as the raw file plus the response.
  pitch  {semitones}  resampled so that everything lies 2^(semitones/12) higher and the sound is shorter by that
         factor; the sample rate written in the file stays.
  shelf  {hz, gainDb}  a high shelf, the second-order shelf of the audio EQ cookbook (slope 1), applied once.
A room and a shelf scale the whole output down to a peak of 0.999 when it would be above (the gain is recorded);
nothing else is normalised or limited.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_PROMPTS = HERE / "prompts.json"
DEFAULT_OUT = ROOT / "assets" / "audio" / "gen"
PEAK_LIMIT = 0.999

# the room of the plan: early reflections as single samples, then a tail of band-limited noise
EARLY_MS = ((19.0, 27.0, 37.0, 49.0, 61.0), (21.0, 25.0, 39.0, 47.0, 63.0))  # channel 1, channel 2
EARLY_DB = (-5.0, -7.0, -9.0, -11.0, -13.0)
TAIL_START_S = 0.030
TAIL_START_DB = -13.0   # not in the plan: the tail begins at the level of the weakest early reflection, so there is no step
BAND_EDGES_HZ = (300.0, 3000.0)
BAND_RT60_FACTORS = (1.2, 1.0, 0.5)   # low, middle, high band: 60 dB down in rt60S x factor
HP_HZ, LP_HZ = 80.0, 8000.0


def _load_common():
    """tools/sound/common.py by its path: tools/audio/listen has a common.py of its own that may be in sys.path."""
    spec = importlib.util.spec_from_file_location("sound_common", HERE / "common.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


common = _load_common()


# ----------------------------------------------------------------------------------------------
# measures

def _as2d(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x[:, None] if x.ndim == 1 else x


def measures(x: np.ndarray, sr: int) -> dict:
    """Peak, length, the share of the energy under 250 Hz and above 2 kHz (whole file, rectangular window, all
    channels) and the spectral centroid (power-weighted mean frequency)."""
    x = _as2d(x)
    if x.shape[0] == 0:
        return {"peak": 0.0, "lengthS": 0.0, "shareUnder250Hz": 0.0, "shareAbove2kHz": 0.0, "centroidHz": 0.0}
    spec = (np.abs(np.fft.rfft(x, axis=0)) ** 2).sum(axis=1)
    freq = np.fft.rfftfreq(x.shape[0], 1.0 / sr)
    tot = float(spec.sum())
    return {"peak": round(float(np.abs(x).max()), 5), "lengthS": round(x.shape[0] / sr, 4),
            "shareUnder250Hz": round(float(spec[freq < 250.0].sum() / tot), 4) if tot > 0 else 0.0,
            "shareAbove2kHz": round(float(spec[freq >= 2000.0].sum() / tot), 4) if tot > 0 else 0.0,
            "centroidHz": round(float((spec * freq).sum() / tot), 1) if tot > 0 else 0.0}


def _limit(y: np.ndarray) -> tuple[np.ndarray, float]:
    """An output peak above PEAK_LIMIT scales the whole output down to it. Returns (output, gain in dB)."""
    peak = float(np.abs(y).max()) if y.size else 0.0
    if peak > PEAK_LIMIT:
        g = PEAK_LIMIT / peak
        return y * g, 20.0 * math.log10(g)
    return y, 0.0


# ----------------------------------------------------------------------------------------------
# the operations

def room_ir(sr: int, rt60_s: float, seed: int, channel: int = 0) -> np.ndarray:
    """The impulse response of a room, without the direct sound (the direct sound is the raw file itself).
    Length 1.5 x rt60S. Early reflections at EARLY_MS[channel] with EARLY_DB and alternating sign (+, -, +, ...).
    A tail from 30 ms: Gaussian noise of default_rng(seed), high-passed at 80 Hz and low-passed at 8 kHz, split into
    three bands (under 300 Hz, 300 Hz to 3 kHz, above 3 kHz; Butterworth of fourth order), each band of equal energy,
    each with an exponential decay of 60 dB in rt60S x 1.2, x 1.0 and x 0.5 (counted from the start of the tail).
    The tail starts at the root mean square of TAIL_START_DB (a choice made here: the plan does not give the level of
    the tail against the early reflections; the wet level of the whole response is set afterwards)."""
    from scipy import signal

    n = max(1, int(round(1.5 * rt60_s * sr)))
    ir = np.zeros(n)
    for k, (ms, db) in enumerate(zip(EARLY_MS[channel], EARLY_DB)):
        i = int(round(ms * sr / 1000.0))
        if i < n:
            ir[i] += (-1.0) ** k * 10.0 ** (db / 20.0)
    t0 = int(round(TAIL_START_S * sr))
    m = n - t0
    if m <= 8:
        return ir
    rng = np.random.default_rng(seed + channel)
    w = rng.standard_normal(m)
    w = signal.sosfilt(signal.butter(4, HP_HZ, "highpass", fs=sr, output="sos"), w)
    w = signal.sosfilt(signal.butter(4, LP_HZ, "lowpass", fs=sr, output="sos"), w)
    lo, hi = BAND_EDGES_HZ
    bands = (signal.sosfilt(signal.butter(4, lo, "lowpass", fs=sr, output="sos"), w),
             signal.sosfilt(signal.butter(4, [lo, hi], "bandpass", fs=sr, output="sos"), w),
             signal.sosfilt(signal.butter(4, hi, "highpass", fs=sr, output="sos"), w))
    t = np.arange(m) / float(sr)
    flat = np.zeros(m)
    shaped = np.zeros(m)
    for b, f in zip(bands, BAND_RT60_FACTORS):
        b = b / max(float(np.sqrt((b ** 2).mean())), 1e-30)  # equal energy
        flat += b
        shaped += b * 10.0 ** (-3.0 * t / (rt60_s * f))      # 60 dB down in rt60S x f
    flat_rms = max(float(np.sqrt((flat ** 2).mean())), 1e-30)
    ir[t0:] += shaped * (10.0 ** (TAIL_START_DB / 20.0) / flat_rms)
    return ir


def op_room(x: np.ndarray, sr: int, p: dict) -> tuple[np.ndarray, dict]:
    from scipy.signal import fftconvolve

    x = _as2d(x)
    if x.shape[1] != 1:
        raise ValueError("a room is made from a one-channel file")
    nch = int(p["channels"])
    if nch not in (1, 2):
        raise ValueError("room: channels must be 1 or 2")
    dry = x[:, 0]
    irs = [room_ir(sr, float(p["rt60S"]), int(p["seed"]), c) for c in range(nch)]
    wet = np.stack([fftconvolve(dry, ir) for ir in irs], axis=1)  # (n + len(ir) - 1, nch)
    e_raw = float((dry ** 2).sum())
    e_wet = float((wet ** 2).sum(axis=0).mean())
    target = float(p["wetDb"])
    s = math.sqrt(e_raw * 10.0 ** (target / 10.0) / e_wet) if e_wet > 0 and e_raw > 0 else 0.0
    wet = wet * s
    out = wet.copy()
    out[:dry.shape[0], :] += dry[:, None]  # the direct sound, in both channels alike
    reached = 10.0 * math.log10(max(float((wet ** 2).sum(axis=0).mean()), 1e-300) / max(e_raw, 1e-300))
    out, gain = _limit(out)
    return out, {"op": "room", "wetDryDbAsked": target, "wetDryDbReached": round(reached, 3),
                 "irLengthS": round(irs[0].shape[0] / sr, 4), "channels": nch, "outputGainDb": round(gain, 4)}


def op_pitch(x: np.ndarray, sr: int, p: dict) -> tuple[np.ndarray, dict]:
    from scipy.signal import resample_poly

    x = _as2d(x)
    semi = float(p["semitones"])
    factor = 2.0 ** (semi / 12.0)
    fr = Fraction(factor).limit_denominator(1000)  # fr = up / down in pitch; the sound gets shorter by this factor
    if fr.numerator == fr.denominator:
        y = x.copy()
    else:
        y = resample_poly(x, fr.denominator, fr.numerator, axis=0)  # fewer samples, played at the same rate: higher
    return y, {"op": "pitch", "semitones": semi, "factor": round(factor, 6), "ratioUsed": "%d/%d" % (fr.numerator, fr.denominator),
               "lengthFactor": round(y.shape[0] / max(x.shape[0], 1), 6)}


def high_shelf_sos(sr: int, hz: float, gain_db: float) -> np.ndarray:
    """The high shelf of the audio EQ cookbook (R. Bristow-Johnson) with slope S = 1, as one second-order section."""
    a_ = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * hz / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / 2.0 * math.sqrt((a_ + 1.0 / a_) * (1.0 / 1.0 - 1.0) + 2.0)
    r = 2.0 * math.sqrt(a_) * alpha
    b0 = a_ * ((a_ + 1) + (a_ - 1) * cw + r)
    b1 = -2.0 * a_ * ((a_ - 1) + (a_ + 1) * cw)
    b2 = a_ * ((a_ + 1) + (a_ - 1) * cw - r)
    a0 = (a_ + 1) - (a_ - 1) * cw + r
    a1 = 2.0 * ((a_ - 1) - (a_ + 1) * cw)
    a2 = (a_ + 1) - (a_ - 1) * cw - r
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def op_shelf(x: np.ndarray, sr: int, p: dict) -> tuple[np.ndarray, dict]:
    from scipy.signal import sosfilt

    x = _as2d(x)
    y = sosfilt(high_shelf_sos(sr, float(p["hz"]), float(p["gainDb"])), x, axis=0)
    y, gain = _limit(y)
    return y, {"op": "shelf", "hz": float(p["hz"]), "gainDb": float(p["gainDb"]), "outputGainDb": round(gain, 4)}


OPS = {"room": op_room, "pitch": op_pitch, "shelf": op_shelf}


def apply_process(x: np.ndarray, sr: int, process: list[dict]) -> tuple[np.ndarray, list[dict]]:
    """The operations in order. Returns (result (n, channels), what each operation reported)."""
    y = _as2d(x).copy()
    done = []
    for p in process:
        if p["op"] not in OPS:
            raise ValueError("unknown operation %r" % p["op"])
        y, info = OPS[p["op"]](y, sr, p)
        done.append(info)
    return y, done


# ----------------------------------------------------------------------------------------------
# the run

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def say(process: list[dict]) -> str:
    """The operations in plain words, with their numbers (for text_given)."""
    parts = []
    for p in process:
        if p["op"] == "room":
            parts.append("a room was added (decay time %g s, wet level %g dB against the dry sound, %s, seed %d)" % (
                p["rt60S"], p["wetDb"], "one channel" if int(p["channels"]) == 1 else "two channels", int(p["seed"])))
        elif p["op"] == "pitch":
            parts.append("the sound was tuned %g semitones %s by resampling, which also made it shorter" % (
                abs(p["semitones"]), "higher" if p["semitones"] >= 0 else "lower"))
        elif p["op"] == "shelf":
            parts.append("the highs above %g Hz were changed by %g dB with a high shelf" % (p["hz"], p["gainDb"]))
        else:
            parts.append("operation %s" % p["op"])
    return "; ".join(parts) if parts else "nothing was changed"


def derive_item(item: dict, out_raw: Path) -> dict:
    """Make one derived candidate. Returns its record for gen.json. Raises ValueError when the raw file is not the one
    the plan names."""
    import soundfile as sf

    frm = item["from"]
    raw = ROOT / frm["raw"]
    if not raw.is_file():
        raise ValueError("%s: raw file %s is missing" % (item["id"], frm["raw"]))
    have = sha256_of(raw)
    if have != frm["sha256"]:
        raise ValueError("%s: sha256 of %s is %s, the plan says %s: refused" % (item["id"], frm["raw"], have, frm["sha256"]))
    x, sr = sf.read(str(raw), dtype="float64", always_2d=True)
    if x.shape[1] != 1:
        raise ValueError("%s: %s has %d channels, one is expected" % (item["id"], frm["raw"], x.shape[1]))
    y, ops = apply_process(x[:, 0], int(sr), item["process"])
    numbers = {"raw": measures(x, sr), "result": measures(y, sr), "operations": ops}
    for o in ops:
        if o["op"] == "room":
            numbers["wetDryDb"] = o["wetDryDbReached"]
            numbers["irLengthS"] = o["irLengthS"]
    info = common.write_wav(out_raw / (item["id"] + ".wav"), y, int(sr))
    text = "Made from the raw file of %s (round %s, which the owner called %s): %s." % (
        frm["candidate"], frm["round"], frm["verdict"], say(item["process"]))
    return {**info, "family": item["family"], "prompt": item["id"], "seed": None, "text_given": text,
            "derived": {"tag": item["tag"], "from": frm, "process": item["process"], "numbers": numbers}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--prompts-file", metavar="FILE", default=str(DEFAULT_PROMPTS),
                    help="the prompts file with the families that have a \"derived\" list (default tools/sound/prompts.json: none)")
    ap.add_argument("--out-root", metavar="DIR", default=str(DEFAULT_OUT),
                    help="where derived/raw and derived/gen.json go (default assets/audio/gen)")
    a = ap.parse_args(argv)
    pf = Path(a.prompts_file).resolve()
    out_root = Path(a.out_root).resolve()
    spec = json.loads(pf.read_text(encoding="utf-8"))
    todo = [dict(it, family=f["id"]) for f in spec["families"] for it in f.get("derived", [])]
    if not todo:
        print("no family of %s has a \"derived\" list" % pf)
        return 1
    ids = [it["id"] for it in todo]
    if len(set(ids)) != len(ids):
        print("item ids are not unique: %s" % ids)
        return 1
    common.configure(str(pf), str(out_root))
    out_raw = out_root / "derived" / "raw"
    items: dict = {}
    refused = []
    for it in todo:
        try:
            items[it["id"]] = derive_item(it, out_raw)
        except ValueError as e:
            print("REFUSED " + str(e))
            refused.append(it["id"])
            continue
        r = items[it["id"]]
        n = r["derived"]["numbers"]
        print("%-22s %5.2f s %d ch, peak %.3f  %s" % (it["id"], r["audio_s"], r["channels"], r["peak"], r["text_given"]))
        print("    raw    %s" % n["raw"])
        print("    result %s" % n["result"])
    rec = {"source": "derived", "tool": "tools/sound/derive.py", "promptsFile": common._rel(pf), "items": items}
    path = out_root / "derived" / "gen.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(rec, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote", path, "(%d items%s)" % (len(items), ", refused: " + ", ".join(refused) if refused else ""))
    return 1 if refused else 0


if __name__ == "__main__":
    sys.exit(main())
