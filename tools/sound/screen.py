"""Choose the candidates of the sound-source listening test and make their listening copies.

    .venv-audio/Scripts/python.exe tools/sound/screen.py [--no-models] [--root DIR] [--device cpu|cuda]

Reads every source directory under assets/audio/gen/ that has a gen.json (moss, sa3, oga) and every
raw file listed in it, and for each file:

1. cuts the event out (first moment within 40 dB of the file's maximum, minus 3 ms; ends where the
   level has stayed 45 dB under the maximum for 150 ms (50 dB for the gear's last sound), or at the family's longest length; for the
   landing gear from the first sound to the last);
2. throws out only what is broken, with the reason: silent, clipped, speech, music, more than one
   event where one was asked for, cut off, shorter than 80 ms. It does not look at where the energy
   sits in the spectrum, at brightness or at attack: the owner disliked sounds that met such
   measures;
3. describes what is left by a vector for variety only (third-octave band levels in three parts of
   the event, the length, the share of the energy in the first 60 ms), normalised per family;
4. chooses four per family: per source the candidate nearest to the middle of that source's
   candidates, then, from the two generative sources, the one farthest from the three chosen;
5. writes the listening copies (48 kHz, family loudness, true peak at most -1 dBFS, no step at
   either end) under assets/audio/gen/_listen/ and the whole account to assets/audio/gen/screen.json.

The speech recogniser (Whisper small) and CLAP are the models of the sound library, read from the
local cache only. They run on the processor by default (they are small); with --device cuda the
whole command has to be run through tools/voice/with_lock.py. Runs with the environment of the sound
library (.venv-audio), which it only reads. publish.py takes screen.json from here.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from math import gcd
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
AUDIO = ROOT / "tools" / "audio"
GEN = ROOT / "assets" / "audio" / "gen"
for _p in (AUDIO, AUDIO / "listen"):  # in front of the folder of this script, which has its own common.py
    sys.path.insert(0, str(_p))

SOURCES = ("moss", "sa3", "oga")          # the order of the slots on the page
GENERATIVE = ("moss", "sa3")              # the fourth pick comes from these
SOURCE_NAMES = {"moss": "MOSS-SoundEffect", "sa3": "Stable Audio 3", "oga": "OpenGameArt"}
MAX_LEN_S = {"hull": 2.5, "thruster": 1.2, "gear": 3.8, "shield": 2.5}
ONE_EVENT = ("hull", "thruster", "shield")  # the gear is one event from the first sound to the last

OUT_SR = 48000
HOP_MS, WIN_MS = 1.0, 4.0
START_DB, END_DB = 40.0, 50.0             # within 40 dB of the maximum starts; 50 dB under ends
QUIET_DB = 45.0                           # one-event families: the quiet between two events can sit at -45..-49 dB (moss thruster_3), so 50 never ended them
QUIET_S = 0.150                           # how long the level must stay under for the event to end
LEAD_S = 0.003
MIN_EVENT_S = 0.080
SILENT_PEAK_DB = -40.0
CLIP_LEVEL, CLIP_RUN = 0.999, 3
CUTOFF_S, CUTOFF_DB = 0.050, 20.0
SECOND_DB = 20.0 * math.log10(0.5)        # a second onset of at least half the first one's level
SPEECH_WORDS = 3
MUSIC_TEXT = "music, a melody, an instrument playing a tune"
CEILING_DB = -1.1                         # the listening copy; the page's 16-bit copy keeps -1 with room
DC_LIMIT = 0.001                          # the page's limit for the mean of a file
STEP_DB = -60.0                           # a sample above this at an end is a step
RAMP_S = 0.0015
FADE_S = 0.030
TAIL_CHECK_S = 0.010
FIRST_PART_S = 0.060
BAND_CENTRES = [1000.0 * 2.0 ** (k / 3.0) for k in range(-15, 14)]  # 31 Hz .. 16 kHz, thirds of an octave
FLOOR_DB = -90.0


# ----------------------------------------------------------------------------------------------
# cutting the event out

def _power(x: np.ndarray) -> np.ndarray:
    """Power per sample, the mean over the channels: x is (n, channels)."""
    return (x.astype(np.float64) ** 2).mean(axis=1)


def level_env(x: np.ndarray, sr: int) -> tuple[np.ndarray, int, int]:
    """Level in dB (RMS of 4 ms, every 1 ms). Returns (env, hop, win) in samples. Frame i covers
    samples i*hop .. i*hop+win."""
    hop, win = max(1, int(round(sr * HOP_MS / 1000))), max(1, int(round(sr * WIN_MS / 1000)))
    p = _power(x)
    if p.size < win:
        p = np.concatenate([p, np.zeros(win - p.size)])
    c = np.concatenate([[0.0], np.cumsum(p)])
    nfr = (p.size - win) // hop + 1
    idx = np.arange(nfr) * hop
    mean = (c[idx + win] - c[idx]) / win
    return 10.0 * np.log10(np.maximum(mean, 1e-20)), hop, win


def _first_quiet_run(quiet: np.ndarray, start: int, need: int) -> int | None:
    """First frame >= start from which `need` frames in a row are quiet."""
    q = np.concatenate([[0], np.cumsum(quiet.astype(np.int64))])
    last = quiet.size - need
    if last < start:
        return None
    s = np.arange(start, last + 1)
    ok = (q[s + need] - q[s]) == need
    hit = np.flatnonzero(ok)
    return int(s[hit[0]]) if hit.size else None


def cut_event(x: np.ndarray, sr: int, family: str) -> dict:
    """Find the event in a raw file (n, channels). Returns the cut in samples and what was found."""
    env, hop, win = level_env(x, sr)
    mx = float(env.max())
    i0 = int(np.flatnonzero(env >= mx - START_DB)[0])
    # the frame says where to look; the first sample of it that is within 40 dB gives the onset
    thr = 10 ** ((mx - START_DB) / 20.0)
    seg = np.abs(x[i0 * hop: i0 * hop + win]).max(axis=1)
    hit = np.flatnonzero(seg >= thr)
    onset = i0 * hop + (int(hit[0]) if hit.size else 0)
    start = max(0, onset - int(round(LEAD_S * sr)))
    cap = onset + int(round(MAX_LEN_S[family] * sr))
    need = max(1, int(round(QUIET_S * 1000 / HOP_MS)))
    second = None
    if family == "gear":
        loud = np.flatnonzero(env[i0:] > mx - END_DB) + i0
        loud = loud[loud * hop <= cap]
        end = int(loud[-1]) * hop + win
        run = None
    else:
        run = _first_quiet_run(env <= mx - QUIET_DB, i0, need)
        end = x.shape[0] if run is None else run * hop + win
        if run is not None:  # a second onset after the quiet run
            peak1 = float(env[i0:run].max())
            later = np.flatnonzero(env[run + need:] >= peak1 + SECOND_DB) + run + need
            if later.size:
                second = int(later[0]) * hop
    capped = end > cap
    end = min(end, cap, x.shape[0])
    return {"start": start, "end": end, "onset": onset, "maxDb": mx, "capped": bool(capped),
            "secondOnset": second, "nEnvFrames": int(env.size)}


# ----------------------------------------------------------------------------------------------
# throwing out what is broken

def raw_faults(x: np.ndarray, sr: int, family: str) -> tuple[list[str], dict]:
    """Every fault that needs no model. Returns (reasons in a fixed order, the cut and numbers)."""
    reasons: list[str] = []
    peak = float(np.abs(x).max()) if x.size else 0.0
    peak_db = 20.0 * math.log10(max(peak, 1e-12))
    info: dict = {"peakDb": round(peak_db, 2)}
    if x.shape[0] == 0 or peak_db < SILENT_PEAK_DB:
        return ["silent"], info
    full = (np.abs(x) >= CLIP_LEVEL).any(axis=1).astype(np.int64)
    c = np.concatenate([[0], np.cumsum(full)])
    if x.shape[0] >= CLIP_RUN and bool(((c[CLIP_RUN:] - c[:-CLIP_RUN]) == CLIP_RUN).any()):
        reasons.append("clipped")
    cut = cut_event(x, sr, family)
    info["cut"] = {"startS": round(cut["start"] / sr, 4), "endS": round(cut["end"] / sr, 4),
                   "lengthS": round((cut["end"] - cut["start"]) / sr, 4), "cappedAtFamilyLength": cut["capped"]}
    if (cut["end"] - cut["start"]) / sr < MIN_EVENT_S:
        reasons.append("too-short")
    last = max(1, int(round(CUTOFF_S * sr)))
    last_db = 10.0 * math.log10(max(float(_power(x[-last:]).mean()), 1e-20))
    info["lastDbBelowMax"] = round(cut["maxDb"] - last_db, 1)
    if last_db >= cut["maxDb"] - CUTOFF_DB:
        reasons.append("cut-off")
    if family in ONE_EVENT and cut["secondOnset"] is not None:
        reasons.append("several-events")
        info["secondOnsetS"] = round(cut["secondOnset"] / sr, 3)
    info["_cut"] = cut
    return reasons, info


def is_speech(text: str) -> bool:
    import re

    words = re.sub(r"[^\w\s']", " ", text.lower().replace("-", " ")).replace("'", "").split()
    return len(words) >= SPEECH_WORDS


def is_music(scores: dict[str, float], music_text: str = MUSIC_TEXT) -> bool:
    """CLAP puts the music description above every description of the family."""
    others = [v for k, v in scores.items() if k != music_text]
    return bool(others) and scores[music_text] > max(others)


class Models:
    """Whisper small and CLAP (local cache only), loaded when first needed."""

    def __init__(self, device: str):
        self.device = device
        self._whisper = None
        self._clap = None

    def whisper(self):
        if self._whisper is None:
            from transcribe import Whisper

            self._whisper = Whisper(self.device)
        return self._whisper

    def clap(self):
        if self._clap is None:
            from compare import Clap

            self._clap = Clap(self.device)
        return self._clap

    def speech_and_music(self, mono: np.ndarray, sr: int, texts: list[str]) -> dict:
        text = self.whisper().transcribe(mono, sr, lang="en")
        res = {"transcript": text, "speech": is_speech(text)}
        sc = self.clap().score(mono, sr, list(texts) + [MUSIC_TEXT])
        scores = dict(zip(list(texts) + [MUSIC_TEXT], sc))
        res["clapMusic"] = round(scores[MUSIC_TEXT], 4)
        res["clapBestFamily"] = round(max(scores[t] for t in texts), 4)
        res["music"] = is_music(scores)
        return res


# ----------------------------------------------------------------------------------------------
# the vector for variety

def _band_levels(seg: np.ndarray, sr: int, ref_power: float) -> np.ndarray:
    n = seg.size
    out = np.full(len(BAND_CENTRES), FLOOR_DB)
    if n < 8 or ref_power <= 0:
        return out
    w = np.hanning(n)
    nfft = 1 << max(12, int(math.ceil(math.log2(n))))
    spec = np.abs(np.fft.rfft(seg * w, nfft)) ** 2 * 2.0 / (nfft * float((w ** 2).sum()))
    freq = np.fft.rfftfreq(nfft, 1.0 / sr)
    for i, fc in enumerate(BAND_CENTRES):
        lo, hi = fc * 2 ** (-1 / 6), fc * 2 ** (1 / 6)
        if hi > sr / 2:
            continue
        sel = (freq >= lo) & (freq < hi)
        if sel.any():
            out[i] = max(FLOOR_DB, 10.0 * math.log10(max(float(spec[sel].sum()) / ref_power, 1e-12)))
    return out


def describe(event: np.ndarray, sr: int) -> np.ndarray:
    """Raw description of a cut event (n, channels): 3 x bands, log length, share in the first 60 ms."""
    x = event.astype(np.float64).mean(axis=1)
    ref = float((x ** 2).mean())
    k = min(x.size, int(round(FIRST_PART_S * sr)))
    rest = x[k:]
    half = rest.size // 2
    parts = [x[:k], rest[:half], rest[half:]]
    bands = np.concatenate([_band_levels(p, sr, ref) for p in parts])
    share = float((x[:k] ** 2).sum() / max(float((x ** 2).sum()), 1e-20))
    return np.concatenate([bands, [math.log(x.size / sr), share]])


def normalise(raw: np.ndarray) -> np.ndarray:
    """Per family: every dimension to zero mean and unit spread; the band block counts as one
    dimension of weight 1 in all, the length and the share as 0.5 each."""
    raw = np.asarray(raw, dtype=np.float64)
    sd = raw.std(axis=0)
    z = (raw - raw.mean(axis=0)) / np.where(sd < 1e-9, 1.0, sd)
    nb = raw.shape[1] - 2
    w = np.concatenate([np.full(nb, 1.0 / math.sqrt(nb)), [0.5, 0.5]])
    return z * w


# ----------------------------------------------------------------------------------------------
# the choice

def choose(cands: list[dict]) -> tuple[list[dict], list[str]]:
    """cands: dicts with "source", "name", "raw" (description). Returns (picks, notes). A pick is
    {"slot": 1..4, "cand": cand, "role": "typical" | "second" | "farthest"}. Slot 1 to 3 are moss,
    sa3, oga (a source without a candidate has its slot filled by a second pick); slot 4 is the
    fourth pick. Deterministic: ties go to the lower source, then the lower name."""
    notes: list[str] = []
    cands = sorted(cands, key=lambda c: (SOURCES.index(c["source"]) if c["source"] in SOURCES else 99, c["name"]))
    if not cands:
        return [], ["no candidate in this family"]
    z = normalise(np.array([c["raw"] for c in cands]))
    for c, v in zip(cands, z):
        c["_z"] = v
    picks: list[dict] = []
    chosen: set[int] = set()
    by_src = {s: [i for i, c in enumerate(cands) if c["source"] == s] for s in SOURCES}
    for slot, s in enumerate(SOURCES, 1):
        idx = by_src[s]
        pickable = [i for i in idx if not cands[i].get("skip")]  # a skipped one still counts for the centre
        if not pickable:
            idx = []
        if not idx:
            notes.append("%s has no remaining candidate in this family" % s)
            continue
        centre = z[idx].mean(axis=0)
        d = [(float(np.linalg.norm(z[i] - centre)), i) for i in pickable]
        _, best = min(d)
        chosen.add(best)
        picks.append({"slot": slot, "cand": cands[best], "role": "typical", "_i": best})

    def farthest(pool: list[int]) -> int | None:
        pool = [i for i in pool if i not in chosen and not cands[i].get("skip")]
        if not pool:
            return None
        ref = [z[p["_i"]] for p in picks]
        score = [(-min(float(np.linalg.norm(z[i] - r)) for r in ref) if ref else 0.0, i) for i in pool]
        return min(score)[1]  # the largest distance to the nearest chosen, ties to the lower index

    free = [s for s in range(1, 4) if s not in {p["slot"] for p in picks}]
    for slot in free:
        left = {s: [i for i in by_src[s] if i not in chosen and not cands[i].get("skip")] for s in SOURCES}
        richest = max(SOURCES, key=lambda s: (len(left[s]), -SOURCES.index(s)))
        i = farthest(left[richest]) if left[richest] else None
        if i is None:
            notes.append("no second candidate to fill slot %d" % slot)
            continue
        chosen.add(i)
        picks.append({"slot": slot, "cand": cands[i], "role": "second", "_i": i})
        notes.append("slot %d filled with a second candidate of %s" % (slot, cands[i]["source"]))
    pool = [i for s in GENERATIVE for i in by_src[s]]
    i = farthest(pool)
    if i is None:
        notes.append("no remaining generative candidate for the fourth pick")
    else:
        chosen.add(i)
        picks.append({"slot": 4, "cand": cands[i], "role": "farthest", "_i": i})
    picks.sort(key=lambda p: p["slot"])
    return picks, notes


# ----------------------------------------------------------------------------------------------
# the listening copy

def to_channels(x: np.ndarray) -> np.ndarray:
    """One or two channels are kept; more than two are mixed down to two (odd to the left, even to the right)."""
    if x.shape[1] <= 2:
        return x
    return np.stack([x[:, 0::2].mean(axis=1), x[:, 1::2].mean(axis=1)], axis=1)


def resample(x: np.ndarray, sr: int, out_sr: int = OUT_SR) -> np.ndarray:
    if sr == out_sr:
        return x.astype(np.float64)
    from scipy.signal import resample_poly

    g = gcd(sr, out_sr)
    return resample_poly(x.astype(np.float64), out_sr // g, sr // g, axis=0)


def listening_copy(event: np.ndarray, sr: int, target_lufs: float, ceiling_db: float = CEILING_DB) -> tuple[np.ndarray, dict]:
    """event: the cut (n, channels) at the source's rate. Returns (48 kHz copy, numbers)."""
    from synth.levels import lufs, set_level, true_peak_db

    x = resample(to_channels(event), sr)
    y, lv = set_level(x, "lufs", target_lufs, ceiling_db=ceiling_db)
    thr = 10 ** (STEP_DB / 20.0)
    tail = int(round(TAIL_CHECK_S * OUT_SR))  # the page's check looks at the last 10 ms
    fade = bool(np.abs(y[-tail:]).max() > thr)
    if fade:
        m = min(int(round(FADE_S * OUT_SR)), y.shape[0])
        y[-m:] *= (0.5 + 0.5 * np.cos(np.pi * (np.arange(m) + 1) / m))[:, None]
        # the last 10 ms of a 30 ms fade are still audible for a loud event, and the page flags a file
        # whose last 10 ms are not silent: 10 ms of digital silence follow the fade
        y = np.concatenate([y, np.zeros((tail, y.shape[1]))], axis=0)
    first = np.abs(y[0])
    ramp = bool(first.max() > thr)
    if ramp:
        n = int(round(RAMP_S * OUT_SR))
        r = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
        y = np.concatenate([y[0][None, :] * r[:, None], y], axis=0)
    # the page's rules fail a file whose mean is 0.001 or more (about -60 dBFS). A short event that is
    # mostly sub-bass has such a mean (shield_3 s16 of MOSS: 0.0099); it is taken out with a window that
    # is 1 in the middle and tapers over the first 1.5 ms and the last 5 ms, so that no step is made
    dc_before = float(np.abs(y.mean(axis=0)).max())
    if dc_before >= DC_LIMIT / 2:
        n = y.shape[0] - tail  # the last 10 ms (the page's tail check) are left as they are: silence after a fade, below -60 dB otherwise
        a_, b_ = min(int(round(RAMP_S * OUT_SR)), n // 4), min(int(round(0.005 * OUT_SR)), n // 4)
        w = np.ones(n)
        w[:a_] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a_) / max(a_, 1))
        w[n - b_:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(b_) / max(b_, 1))
        corr = np.zeros_like(y)
        corr[:n] = (y.mean(axis=0, keepdims=True) * (y.shape[0] / float(w.sum()))) * w[:, None]
        y = y - corr
    dc_after = float(np.abs(y.mean(axis=0)).max())
    info = {"sr": OUT_SR, "channels": int(y.shape[1]), "durationS": round(y.shape[0] / OUT_SR, 4),
            "lufsTarget": target_lufs, "lufsReached": round(lufs(y), 2), "gainDb": lv["gainDb"],
            "limitedByPeak": bool(lv["limited"]), "truePeakDb": round(true_peak_db(y), 2),
            "dcBefore": round(dc_before, 6), "dcAfter": round(dc_after, 6), "rampIn": ramp, "fadeOut": fade, "firstSampleDb": round(20 * math.log10(max(float(np.abs(y[0]).max()), 1e-12)), 1),
            "lastSampleDb": round(20 * math.log10(max(float(np.abs(y[-1]).max()), 1e-12)), 1)}
    return y, info


# ----------------------------------------------------------------------------------------------
# the run

def _rel(p: Path, base: Path) -> str:
    try:
        return str(p.relative_to(base)).replace("\\", "/")
    except ValueError:
        return str(p).replace("\\", "/")


def find_raw(root: Path, key: str, name: str, item: dict) -> Path | None:
    for p in (root / key / "raw" / (name + ".wav"), ROOT / str(item.get("file", "")), root.parent / str(item.get("file", ""))):
        if p.is_file():
            return p
    return None


def item_family(name: str, item: dict) -> str | None:
    fam = item.get("family") or name.split("__")[0].split("_")[0]
    return fam if fam in MAX_LEN_S else None


def run(root: Path, use_models: bool, device: str, skips: dict[str, str] | None = None) -> dict:
    """skips: {"source/name": reason}. A skipped candidate stays in the pool (it counts for the
    normalisation and the centre) but is never picked: the next nearest takes its place. Used after
    looking at the spectrograms of the picks, for plain faults the measures do not see."""
    skips = skips or {}
    import soundfile as sf

    spec = json.loads((HERE / "prompts.json").read_text(encoding="utf-8"))
    fams = {f["id"]: f for f in spec["families"]}
    fam_no = {f["id"]: i + 1 for i, f in enumerate(spec["families"])}
    models = Models(device) if use_models else None
    files: list[dict] = []
    cands: dict[str, list[dict]] = {f: [] for f in fams}
    sources_found: dict[str, dict] = {}
    for gj in sorted(root.glob("*/gen.json")):
        key = gj.parent.name
        rec = json.loads(gj.read_text(encoding="utf-8"))
        items = rec.get("items", {})
        sources_found[key] = {"files": len(items), "kept": 0}
        for name in sorted(items):
            item = items[name]
            fam = item_family(name, item)
            row = {"source": key, "name": name, "family": fam, "status": "thrown-out", "reason": None, "reasons": []}
            files.append(row)
            raw = find_raw(root, key, name, item)
            if fam is None or raw is None:
                row["reason"] = "unknown-family" if fam is None else "missing-file"
                row["reasons"] = [row["reason"]]
                continue
            row["file"] = _rel(raw, ROOT)
            x, sr = sf.read(str(raw), dtype="float32", always_2d=True)
            row["sr"], row["channels"], row["rawS"] = int(sr), int(x.shape[1]), round(x.shape[0] / sr, 3)
            reasons, info = raw_faults(x, sr, fam)
            cut = info.pop("_cut", None)
            row.update(info)
            if cut is not None and models is not None and not reasons:
                ev = x[cut["start"]:cut["end"]].mean(axis=1)
                texts = [p["text"] for p in fams[fam]["prompts"]]
                m = models.speech_and_music(ev, sr, texts)
                row["models"] = m
                if m["speech"]:
                    reasons.append("speech")
                if m["music"]:
                    reasons.append("music")
            row["reasons"] = reasons
            if reasons:
                row["reason"] = reasons[0]
                continue
            event = x[cut["start"]:cut["end"]]
            row["status"] = "kept"
            sources_found[key]["kept"] += 1
            cands[fam].append({"source": key, "name": name, "raw": describe(event, sr),
                               "cut": cut, "x": x, "sr": sr, "item": item,
                               "skip": skips.get("%s/%s" % (key, name))})
            if skips.get("%s/%s" % (key, name)):
                row["skippedAsPick"] = skips["%s/%s" % (key, name)]
    listen = root / "_listen"
    listen.mkdir(parents=True, exist_ok=True)
    for old in listen.glob("src_*.wav"):
        old.unlink()
    chosen: list[dict] = []
    fam_out: dict[str, dict] = {}
    for fam, f in fams.items():
        cs = cands[fam]
        picks, notes = choose(cs)
        counts = {s: sum(1 for c in cs if c["source"] == s) for s in SOURCES}
        fam_out[fam] = {"number": fam_no[fam], "candidates": counts, "notes": notes, "chosen": []}
        for p in picks:
            c = p["cand"]
            sid = "src_%d_%s_%d_%s" % (fam_no[fam], fam, p["slot"], c["source"])
            cut = c["cut"]
            event = c["x"][cut["start"]:cut["end"]]
            y, info = listening_copy(event, c["sr"], float(f["lufs"]))
            out = listen / (sid + ".wav")
            sf.write(str(out), y.astype(np.float32), OUT_SR, subtype="FLOAT")
            chosen.append({"id": sid, "family": fam, "familyNumber": fam_no[fam], "slot": p["slot"], "role": p["role"],
                           "source": c["source"], "name": c["name"], "raw": next(r["file"] for r in files if r["source"] == c["source"] and r["name"] == c["name"]),
                           "cut": {"startS": round(cut["start"] / c["sr"], 4), "endS": round(cut["end"] / c["sr"], 4),
                                   "cappedAtFamilyLength": cut["capped"]},
                           "listen": dict(info, file=_rel(out, ROOT)),
                           "record": c["item"]})
            fam_out[fam]["chosen"].append(sid)
    for key, v in sources_found.items():
        v["perFamily"] = {fam: sum(1 for c in cands[fam] if c["source"] == key) for fam in fams}
    return {"version": 1, "skippedAsPick": skips,
            "settings": {"models": bool(use_models), "modelDevice": device if use_models else None,
                         "note": None if use_models else "speech and music were NOT checked (--no-models)",
                         "maxLengthS": MAX_LEN_S, "startWithinDb": START_DB, "endUnderDb": END_DB, "quietUnderDb": QUIET_DB, "quietS": QUIET_S,
                         "leadS": LEAD_S, "minEventS": MIN_EVENT_S, "ceilingDb": CEILING_DB},
            "sources": sources_found, "families": fam_out, "chosen": chosen, "files": files}


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items() if not k.startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.generic):
        return o.item()
    return o


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-models", action="store_true", help="skip the speech recogniser and CLAP (then speech and music are not checked)")
    ap.add_argument("--root", default=str(GEN), help="the folder with the source folders (default assets/audio/gen)")
    ap.add_argument("--skip", action="append", default=[], metavar="SOURCE/NAME=REASON",
                    help="never pick this candidate (it stays in the pool); repeatable; the reason is written to screen.json")
    ap.add_argument("--device", choices=["cpu", "cuda"], default="cpu", help="for the two models; cuda only under with_lock.py")
    a = ap.parse_args(argv)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    root = Path(a.root).resolve()
    skips = {}
    for t in a.skip:
        k, _, why = t.partition("=")
        skips[k.strip()] = why.strip() or "skipped by hand"
    result = run(root, not a.no_models, a.device, skips)
    path = root / "screen.json"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(_clean(result), f, indent=1, ensure_ascii=False)
        f.write("\n")
    for s, v in result["sources"].items():
        print("%-5s %3d files, %3d kept  %s" % (s, v["files"], v["kept"], v["perFamily"]))
    why: dict[str, int] = {}
    for r in result["files"]:
        if r["status"] != "kept":
            why[r["reason"]] = why.get(r["reason"], 0) + 1
    print("thrown out:", why or "none")
    for fam, v in result["families"].items():
        print("%-9s chosen %s  %s" % (fam, ", ".join(v["chosen"]) or "-", "; ".join(v["notes"])))
    print("wrote", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
