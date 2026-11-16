"""Choose the candidates of the sound-source listening test and make their listening copies.

    .venv-audio/Scripts/python.exe tools/sound/screen.py [--no-models] [--root DIR] [--device cpu|cuda]

Reads every source directory under assets/audio/gen/ that has a gen.json (moss, sa3, oga) and every
raw file listed in it, and for each file:

1. cuts the event out (first moment within 40 dB of the file's maximum, minus 3 ms; ends where the
   level has stayed 45 dB under the maximum for 150 ms (50 dB for the gear's last sound), or at the family's longest length; for the
   landing gear from the first sound to the last);
2. throws out only what is broken, with the reason: silent, clipped (a flat top: three or more equal
   samples in a row at the extreme of a channel), speech, music, more than one event where one was
   asked for, cut off (still within 20 dB of the maximum in the last 50 ms of the raw file, or in the
   last 50 ms before the cut that the family's longest length makes), shorter than 80 ms. It does not
   look at where the energy sits in the spectrum, at brightness or at attack: the owner disliked
   sounds that met such measures. The share of the event's energy above 60 Hz is recorded per file as
   a measure only (a sound with almost nothing above 60 Hz plays as silence on most loudspeakers);
3. describes what is left by a vector for variety only (third-octave band levels in three parts of
   the event, the length, the share of the energy in the first 60 ms), normalised per family;
4. chooses four per family: per source the candidate nearest to the middle of that source's
   candidates, then, from the two generative sources, the one farthest from the three chosen;
5. writes the listening copies (48 kHz, no step at either end, true peak at most -1.1 dBFS) under
   assets/audio/gen/_listen/ and the whole account to assets/audio/gen/screen.json. The loudness of a
   copy is the one the audition page plays in its Stereo stage: BS.1770 over two channels, a
   one-channel file counted on both, set to the family's target plus 10*log10(2) dB, so that a
   one-channel file stays exactly where the family target put it and a two-channel file leaves the
   page as loud as a one-channel one. It is measured after all processing (resampling, fades, ramp,
   mean removal, the appended silence), the gain corrected and measured again until it is within
   0.05 LU or the true-peak ceiling stops it (recorded);

Candidates that a person has skipped after looking at a spectrogram for a plain fault are listed in
tools/sound/skips.json and read by default (--skips names another file, --skip adds one).

Round 5: --prompts-file FILE (default tools/sound/prompts.json) with --root assets/audio/gen/r5 screens the
families of that file. Per family it reads "maxS", "oneEvent", "lufs", "picks" and the optional "minAbove60Hz" when
they are there, and does what round 4 did when they are not; see "Round 5" in tools/sound/README.md. Ids are
<idPrefix>_<family number>_<family>_<slot>_<source>_<tag> with the idPrefix of the category of that file.

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
import re
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

SKIPS_FILE = HERE / "skips.json"          # hand skips, read by default
PROMPTS_FILE = HERE / "prompts.json"      # round 4; round 5 passes tools/sound/prompts5.json with --prompts-file
SOURCES = ("moss", "sa3", "oga")          # the order of the slots on the page
GENERATIVE = ("moss", "sa3")              # the fourth pick comes from these
SOURCE_NAMES = {"moss": "MOSS-SoundEffect", "sa3": "Stable Audio 3", "oga": "OpenGameArt"}
MAX_LEN_S = {"hull": 2.5, "thruster": 1.2, "gear": 3.8, "shield": 2.5}
ONE_EVENT = ("hull", "thruster", "shield")  # the gear is one event from the first sound to the last
ID_PREFIX = "src"                         # round 5 takes the idPrefix of the category in its prompts file

OUT_SR = 48000
HOP_MS, WIN_MS = 1.0, 4.0
START_DB, END_DB = 40.0, 50.0             # within 40 dB of the maximum starts; 50 dB under ends
QUIET_DB = 45.0                           # one-event families: the quiet between two events can sit at -45..-49 dB (moss thruster_3), so 50 never ended them
QUIET_S = 0.150                           # how long the level must stay under for the event to end
LEAD_S = 0.003
MIN_EVENT_S = 0.080
SILENT_PEAK_DB = -40.0
CLIP_RUN = 3                              # this many equal samples in a row at the extreme of a channel: a flat top
CUTOFF_S, CUTOFF_DB = 0.050, 20.0         # an event still within 20 dB of its maximum in the last 50 ms was cut off
SECOND_DB = 20.0 * math.log10(0.5)        # a second onset of at least half the first one's level
SPEECH_WORDS = 3
MUSIC_TEXT = "music, a melody, an instrument playing a tune"
CEILING_DB = -1.1                         # the listening copy; the page's 16-bit copy keeps -1 with room
DC_LIMIT = 0.001                          # the page's limit for the mean of a file
PAGE_OFFSET_DB = 10.0 * math.log10(2.0)   # a one-channel file is counted on both channels by the page: +3.01 dB in BS.1770
LEVEL_TOL_DB = 0.05                       # the loudness of a copy must come this close to its target
LEVEL_ITERATIONS = 30
LOW_HZ = 60.0                             # the share of the energy above this is recorded (a measure, no rule)
STEP_DB = -72.0                           # a sample above this at an end is a step: the page's static rule is -60 dBFS, but its recorder
                                          # (capture.ts) looks for clicks above -70 dBFS, and a first sample of -60.4 dBFS in a quiet start was found as one
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


def cut_event(x: np.ndarray, sr: int, family: str, max_s: float | None = None, multi: bool | None = None) -> dict:
    """Find the event in a raw file (n, channels). Returns the cut in samples and what was found.
    max_s: the family's longest length (default: MAX_LEN_S of the round-4 family); multi: the family allows
    several sounds, so the cut runs from the first to the last (default: the gear, as in round 4)."""
    max_s = MAX_LEN_S[family] if max_s is None else max_s
    multi = (family not in ONE_EVENT) if multi is None else multi
    env, hop, win = level_env(x, sr)
    mx = float(env.max())
    i0 = int(np.flatnonzero(env >= mx - START_DB)[0])
    # the frame says where to look; the first sample of it that is within 40 dB gives the onset
    thr = 10 ** ((mx - START_DB) / 20.0)
    seg = np.abs(x[i0 * hop: i0 * hop + win]).max(axis=1)
    hit = np.flatnonzero(seg >= thr)
    onset = i0 * hop + (int(hit[0]) if hit.size else 0)
    start = max(0, onset - int(round(LEAD_S * sr)))
    cap = onset + int(round(max_s * sr))
    need = max(1, int(round(QUIET_S * 1000 / HOP_MS)))
    second = None
    if multi:
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

def has_flat_top(x: np.ndarray, run: int = CLIP_RUN) -> bool:
    """True when `run` or more samples in a row of one channel are equal and sit at the extreme (the highest
    or the lowest value) of that channel. A file whose float samples go beyond full scale without such a
    flat top is not clipped; a file the maker clamped at 1.0 is."""
    x = np.asarray(x)
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[0] < run:
        return False
    for ch in range(x.shape[1]):
        c = x[:, ch]
        top, bottom = c.max(), c.min()
        for ext in ([top] if top > 0 else []) + ([bottom] if bottom < 0 else []):  # the positive and the negative extreme
            hit = np.concatenate([[0], np.cumsum((c == ext).astype(np.int64))])
            if bool(((hit[run:] - hit[:-run]) == run).any()):
                return True
    return False


def energy_share_above(event: np.ndarray, sr: int, hz: float = LOW_HZ) -> float:
    """Share of the energy of an event (n, channels) at or above `hz`, over all channels (rectangular window)."""
    x = np.asarray(event, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[0] == 0:
        return 0.0
    spec = np.abs(np.fft.rfft(x, axis=0)) ** 2
    freq = np.fft.rfftfreq(x.shape[0], 1.0 / sr)
    total = float(spec.sum())
    return float(spec[freq >= hz].sum() / total) if total > 0 else 0.0


def raw_faults(x: np.ndarray, sr: int, family: str, max_s: float | None = None,
               one_event: bool | None = None) -> tuple[list[str], dict]:
    """Every fault that needs no model. Returns (reasons in a fixed order, the cut and numbers).
    max_s and one_event come from the family of the prompts file; without them the round-4 table decides."""
    one_event = (family in ONE_EVENT) if one_event is None else one_event
    reasons: list[str] = []
    peak = float(np.abs(x).max()) if x.size else 0.0
    peak_db = 20.0 * math.log10(max(peak, 1e-12))
    info: dict = {"peakDb": round(peak_db, 2)}
    if x.shape[0] == 0 or peak_db < SILENT_PEAK_DB:
        return ["silent"], info
    if has_flat_top(x):
        reasons.append("clipped")
    cut = cut_event(x, sr, family, max_s, not one_event)
    info["cut"] = {"startS": round(cut["start"] / sr, 4), "endS": round(cut["end"] / sr, 4),
                   "lengthS": round((cut["end"] - cut["start"]) / sr, 4), "cappedAtFamilyLength": cut["capped"]}
    if (cut["end"] - cut["start"]) / sr < MIN_EVENT_S:
        reasons.append("too-short")
    last = max(1, int(round(CUTOFF_S * sr)))
    last_db = 10.0 * math.log10(max(float(_power(x[-last:]).mean()), 1e-20))
    info["lastDbBelowMax"] = round(cut["maxDb"] - last_db, 1)
    if last_db >= cut["maxDb"] - CUTOFF_DB:
        reasons.append("cut-off")
        info["cutOffAt"] = "end-of-file"
    elif cut["capped"]:
        # the same rule for an event that the family's longest length cuts: the last 50 ms before the cut
        # against the same maximum, with the same 20 dB
        e = cut["end"]
        cap_db = 10.0 * math.log10(max(float(_power(x[max(0, e - last):e]).mean()), 1e-20))
        info["lastDbBelowMaxAtCap"] = round(cut["maxDb"] - cap_db, 1)
        if cap_db >= cut["maxDb"] - CUTOFF_DB:
            reasons.append("cut-off")
            info["cutOffAt"] = "family-length"
    if one_event and cut["secondOnset"] is not None:
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

def _unpickable(c: dict) -> bool:
    """A candidate that stays in the pool (it counts for the normalisation and the centre) but is never picked:
    a hand skip, or under the family's smallest share of energy above 60 Hz ("minAbove60Hz")."""
    return bool(c.get("skip") or c.get("lowShare"))


def choose_by_picks(cands: list[dict], picks: list[str]) -> tuple[list[dict], list[str]]:
    """The slot rule of a family with its own "picks" (round 5): slot n takes a candidate of the source picks[n-1].
    The first slot of a source takes its most typical candidate (the nearest to the middle of all that source's
    candidates, as in round 4); every further slot of that source takes the candidate farthest from the picks
    already made in the family (the second-pick rule of round 4). A slot whose source has nothing left is left out
    and the notes say so. A pick is {"slot", "cand", "role": "typical" | "farthest", "sourceRank": 1, 2, ...}."""
    notes: list[str] = []
    if not cands:
        return [], ["no candidate in this family"]
    z = normalise(np.array([c["raw"] for c in cands]))
    for c, v in zip(cands, z):
        c["_z"] = v
    out: list[dict] = []
    chosen: list[int] = []
    for slot, s in enumerate(picks, 1):
        idx = [i for i, c in enumerate(cands) if c["source"] == s]
        pickable = [i for i in idx if i not in chosen and not _unpickable(cands[i])]
        if not pickable:
            notes.append("slot %d (%s): no candidate left to pick" % (slot, s))
            continue
        rank = sum(1 for p in out if p["cand"]["source"] == s) + 1
        if rank == 1:
            centre = z[idx].mean(axis=0)
            _, best = min((float(np.linalg.norm(z[i] - centre)), i) for i in pickable)
            role = "typical"
        else:
            ref = [z[i] for i in chosen]
            _, best = min((-min(float(np.linalg.norm(z[i] - r)) for r in ref), i) for i in pickable)
            role = "farthest"
        chosen.append(best)
        out.append({"slot": slot, "cand": cands[best], "role": role, "sourceRank": rank, "_i": best})
    return out, notes


def choose(cands: list[dict], picks: list[str] | None = None) -> tuple[list[dict], list[str]]:
    """cands: dicts with "source", "name", "raw" (description). Returns (picks, notes). A pick is
    {"slot": 1..4, "cand": cand, "role": "typical" | "second" | "farthest"}. Slot 1 to 3 are moss,
    sa3, oga (a source without a candidate has its slot filled by a second pick); slot 4 is the
    fourth pick. Deterministic: ties go to the lower source, then the lower name.
    picks: the ordered sources of the slots of a family that has its own list (round 5); without it the rule above
    is used, as in round 4."""
    notes: list[str] = []
    cands = sorted(cands, key=lambda c: (SOURCES.index(c["source"]) if c["source"] in SOURCES else 99, c["name"]))
    if picks:
        return choose_by_picks(cands, list(picks))
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


def page_lufs(y: np.ndarray) -> float:
    """Loudness as the audition page plays it in the Stereo stage: BS.1770 integrated over the two channels of a
    two-channel file; a one-channel file is counted on both channels, which is its own loudness plus 10*log10(2)
    (3.01 dB; measured at the page: a two-channel file leaves 3.02 dB lower than a one-channel file of the same
    file loudness). A one-channel file is not measured by duplicating it: the absolute gate of BS.1770 can
    count different blocks for the two and the offset is then 1.8 dB, not 3.01, for an event whose tail sits at the
    gate, so the family target would no longer put one-channel files where it put them in the first run."""
    from synth.levels import lufs

    y = np.asarray(y, dtype=np.float64)
    if y.ndim == 1:
        y = y[:, None]
    if y.shape[1] == 1:
        return lufs(y) + PAGE_OFFSET_DB
    return lufs(y)


def _finish(x: np.ndarray, gain_db: float) -> tuple[np.ndarray, dict]:
    """Everything that is done to a resampled event after its level: the gain, the end fade and the silence
    after it, the ramp in, the mean removal. What the page plays is what comes out; the level is measured on it."""
    y = x * 10.0 ** (gain_db / 20.0)
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
    return y, {"fade": fade, "ramp": ramp, "dcBefore": dc_before, "dcAfter": float(np.abs(y.mean(axis=0)).max())}


def listening_copy(event: np.ndarray, sr: int, target_lufs: float, ceiling_db: float = CEILING_DB) -> tuple[np.ndarray, dict]:
    """event: the cut (n, channels) at the source's rate; target_lufs: the family's target, which a
    one-channel file reaches in its own BS.1770 loudness. Every copy is set to the page's loudness
    (page_lufs) of that target plus PAGE_OFFSET_DB, measured after all processing and corrected until it is
    within LEVEL_TOL_DB, or until the true-peak ceiling stops it. Returns (48 kHz copy, numbers)."""
    from synth.levels import lufs, true_peak_db

    x = resample(to_channels(event), sr)
    page_target = target_lufs + PAGE_OFFSET_DB
    g = page_target - page_lufs(x)  # first guess; the gate of BS.1770 and the fades make it a little wrong
    lo = hi = None  # gains that were too quiet / too loud: the loudness jumps where the gate of BS.1770 changes its blocks
    best = None
    iters = 0
    for _ in range(LEVEL_ITERATIONS):
        y, fl = _finish(x, g)
        iters += 1
        err = page_target - page_lufs(y)
        tp = true_peak_db(y)
        over = tp - ceiling_db
        bad = (True, over) if over > 1e-3 else (False, abs(err))  # a copy under the ceiling beats one over it; then the nearer to the target
        if best is None or bad < best[0]:
            best = (bad, g, y, fl)
        if over > 1e-3 or err < -LEVEL_TOL_DB:  # too loud (for the ceiling or the target)
            hi = g if hi is None else min(hi, g)
            step = -over if over > 1e-3 else err
            if over > 1e-3 and err < 0:
                step = min(step, err)
        elif err > LEVEL_TOL_DB:
            room = ceiling_db - tp
            if room <= 1e-3:  # at the ceiling and still too quiet: nothing more can be done
                break
            lo = g if lo is None else max(lo, g)
            step = min(err, room)
        else:
            break
        g_next = g + step
        if lo is not None and hi is not None:  # the answer lies between: halve it, the loudness only jumps
            if hi - lo < 0.002:
                break
            if not lo < g_next < hi:
                g_next = 0.5 * (lo + hi)
        g = g_next
    else:
        y, fl = _finish(x, g)
        iters += 1
        err = page_target - page_lufs(y)
        over = true_peak_db(y) - ceiling_db
        bad = (True, over) if over > 1e-3 else (False, abs(err))
        if bad < best[0]:
            best = (bad, g, y, fl)
    _, g, y, fl = best  # the one that met the target; if none did (the ceiling, or a jump of the gate), the nearest under the ceiling
    reached_page = page_lufs(y)
    err = page_target - reached_page
    tp = true_peak_db(y)
    info = {"sr": OUT_SR, "channels": int(y.shape[1]), "durationS": round(y.shape[0] / OUT_SR, 4),
            "lufsTarget": target_lufs, "lufsPageTarget": round(page_target, 3),
            "lufsReached": round(lufs(y), 2), "lufsReachedPage": round(reached_page, 2),
            "levelErrorDb": round(err, 3), "gainDb": round(float(g), 3), "levelIterations": iters,
            "limitedByPeak": bool(err > LEVEL_TOL_DB and ceiling_db - tp < 0.05), "truePeakDb": round(tp, 2),
            "levelMissed": bool(abs(err) > LEVEL_TOL_DB and not (err > 0 and ceiling_db - tp < 0.05)),
            "dcBefore": round(fl["dcBefore"], 6), "dcAfter": round(fl["dcAfter"], 6), "rampIn": fl["ramp"], "fadeOut": fl["fade"],
            "firstSampleDb": round(20 * math.log10(max(float(np.abs(y[0]).max()), 1e-12)), 1),
            "lastSampleDb": round(20 * math.log10(max(float(np.abs(y[-1]).max()), 1e-12)), 1)}
    return y, info


def candidate_tag(source: str, name: str, item: dict | None = None) -> str:
    """What names a candidate in its id: prompt number and seed for a generated file ("p2s16"), a short slug of
    the excerpt's name for a recording. The same candidate always gives the same tag, so an id never comes to
    mean another sound when a pick is replaced."""
    item = item or {}
    if source in GENERATIVE:
        r4 = "r4" if item.get("fromRound4") else ""  # a file of round 4 kept its prompt number: "r4p1s12" is not "p1s12" of round 5
        m = re.search(r"(\d+)__s(\d+)$", name)
        if m:
            return "%sp%ss%s" % (r4, m.group(1), m.group(2))
        pm = re.search(r"(\d+)$", str(item.get("prompt", "")))
        if pm and item.get("seed") is not None:
            return "%sp%ss%s" % (r4, pm.group(1), item["seed"])
    part = name.split("__", 1)[1] if "__" in name else name
    slug = re.sub(r"[^a-z0-9]+", "-", part.lower()).strip("-")[:32].strip("-")
    return slug or "x"


ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$")  # the manifest's rule for an id (tools/audio/fetch.py: it becomes a file name)


def load_skips(path: Path | None) -> dict[str, str]:
    """{"source/name": reason} from a skips file ({"skips": [{"candidate": ..., "reason": ...}]})."""
    if path is None or not Path(path).is_file():
        return {}
    rec = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    for e in rec.get("skips", []):
        out[str(e["candidate"]).strip()] = str(e.get("reason") or "skipped by hand")
    return out


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


def item_family(name: str, item: dict, known=None) -> str | None:
    """The family of a raw file; known: the family ids of the prompts file (default: the four of round 4)."""
    fam = item.get("family") or name.split("__")[0].split("_")[0]
    return fam if fam in (MAX_LEN_S if known is None else known) else None


def family_settings(f: dict) -> dict:
    """What a family of the prompts file asks of the screening: "maxS", "oneEvent", "lufs", "picks" and the optional
    "minAbove60Hz". A key that is not there falls back to what round 4 did: the constants above for the four
    round-4 families and the slot rule of choose() (one MOSS, one Stable Audio, one recording, one further
    generated pick)."""
    fid = f["id"]
    max_s = f.get("maxS", MAX_LEN_S.get(fid))
    if max_s is None:
        raise ValueError("family %r has no maxS and is not a family of round 4" % fid)
    return {"maxS": float(max_s), "oneEvent": bool(f["oneEvent"]) if "oneEvent" in f else fid in ONE_EVENT,
            "lufs": float(f["lufs"]), "picks": list(f["picks"]) if f.get("picks") else None,
            "minAbove60Hz": float(f["minAbove60Hz"]) if f.get("minAbove60Hz") is not None else None}


def run(root: Path, use_models: bool, device: str, skips: dict[str, str] | None = None,
        prompts_file: Path | None = None) -> dict:
    """skips: {"source/name": reason}. A skipped candidate stays in the pool (it counts for the
    normalisation and the centre) but is never picked: the next nearest takes its place. Used after
    looking at the spectrograms of the picks, for plain faults the measures do not see."""
    skips = skips or {}
    import soundfile as sf

    prompts_file = Path(prompts_file) if prompts_file else PROMPTS_FILE
    round4 = prompts_file.resolve() == PROMPTS_FILE.resolve()
    spec = json.loads(prompts_file.read_text(encoding="utf-8"))
    fams = {f["id"]: f for f in spec["families"]}
    fam_no = {f["id"]: i + 1 for i, f in enumerate(spec["families"])}
    sets = {fid: family_settings(f) for fid, f in fams.items()}
    category = spec.get("category") or {}
    id_prefix = category.get("idPrefix", ID_PREFIX)
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
            fam = item_family(name, item, fams.keys())
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
            reasons, info = raw_faults(x, sr, fam, sets[fam]["maxS"], sets[fam]["oneEvent"])
            cut = info.pop("_cut", None)
            row.update(info)
            if cut is not None:
                row["energyAbove60Hz"] = round(energy_share_above(x[cut["start"]:cut["end"]], sr), 4)
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
            # a file carried over from round 4 keeps the hand skip it had there (the same file, the same cut)
            skip = skips.get("%s/%s" % (key, name)) or item.get("round4Skip")
            cand = {"source": key, "name": name, "raw": describe(event, sr),
                    "cut": cut, "x": x, "sr": sr, "item": item, "skip": skip}
            floor = sets[fam]["minAbove60Hz"]
            share = row.get("energyAbove60Hz")
            if floor is not None and share is not None and share < floor:
                cand["lowShare"] = True  # stays in the pool for the statistics, is never picked
                row["notPickedLowShare"] = "energy above 60 Hz %.4f is under the family's minimum %.2f" % (share, floor)
            cands[fam].append(cand)
            if skip:
                row["skippedAsPick"] = skip
    listen = root / "_listen"
    listen.mkdir(parents=True, exist_ok=True)
    for old in listen.glob(id_prefix + "_*.wav"):
        old.unlink()
    chosen: list[dict] = []
    fam_out: dict[str, dict] = {}
    for fam, f in fams.items():
        cs = cands[fam]
        picks, notes = choose(cs, sets[fam]["picks"])
        counts = {s: sum(1 for c in cs if c["source"] == s) for s in SOURCES}
        fam_out[fam] = {"number": fam_no[fam], "candidates": counts, "notes": notes, "chosen": []}
        for p in picks:
            c = p["cand"]
            tag = candidate_tag(c["source"], c["name"], c["item"])
            sid = "%s_%d_%s_%d_%s_%s" % (id_prefix, fam_no[fam], fam, p["slot"], c["source"], tag)
            if not ID_PATTERN.match(sid):
                raise ValueError("%r is not a valid id of the manifest" % sid)
            cut = c["cut"]
            event = c["x"][cut["start"]:cut["end"]]
            y, info = listening_copy(event, c["sr"], sets[fam]["lufs"])
            out = listen / (sid + ".wav")
            sf.write(str(out), y.astype(np.float32), OUT_SR, subtype="FLOAT")
            row = next(r for r in files if r["source"] == c["source"] and r["name"] == c["name"])
            chosen.append({"id": sid, "family": fam, "familyNumber": fam_no[fam], "slot": p["slot"], "role": p["role"],
                           "source": c["source"], "name": c["name"], "tag": tag, "raw": row["file"],
                           "energyAbove60Hz": row.get("energyAbove60Hz"),
                           "cut": {"startS": round(cut["start"] / c["sr"], 4), "endS": round(cut["end"] / c["sr"], 4),
                                   "cappedAtFamilyLength": cut["capped"]},
                           "listen": dict(info, file=_rel(out, ROOT)),
                           "record": c["item"]})
            if "sourceRank" in p:  # only a family with its own "picks" has it: round 4 files stay as they were
                chosen[-1]["sourceRank"] = p["sourceRank"]
            fam_out[fam]["chosen"].append(sid)
    for key, v in sources_found.items():
        v["perFamily"] = {fam: sum(1 for c in cands[fam] if c["source"] == key) for fam in fams}
    extra = {} if round4 else {"category": category, "promptsFile": _rel(prompts_file.resolve(), ROOT)}
    return {"version": 1, **extra, "skippedAsPick": skips,
            "settings": {"models": bool(use_models), "modelDevice": device if use_models else None,
                         "note": None if use_models else "speech and music were NOT checked (--no-models)",
                         "maxLengthS": MAX_LEN_S, "startWithinDb": START_DB, "endUnderDb": END_DB, "quietUnderDb": QUIET_DB, "quietS": QUIET_S,
                         "leadS": LEAD_S, "minEventS": MIN_EVENT_S, "ceilingDb": CEILING_DB,
                         "pageOffsetDb": round(PAGE_OFFSET_DB, 4), "levelToleranceDb": LEVEL_TOL_DB,
                         "cutOffDb": CUTOFF_DB, "cutOffS": CUTOFF_S, "flatTopRun": CLIP_RUN, "lowHz": LOW_HZ},
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
    ap.add_argument("--skips", default=str(SKIPS_FILE), metavar="FILE",
                    help="the committed list of hand skips (default tools/sound/skips.json); pass an empty name to read none")
    ap.add_argument("--skip", action="append", default=[], metavar="SOURCE/NAME=REASON",
                    help="never pick this candidate either (it stays in the pool); repeatable; adds to the file; the reason is written to screen.json")
    ap.add_argument("--device", choices=["cpu", "cuda"], default="cpu", help="for the two models; cuda only under with_lock.py")
    ap.add_argument("--prompts-file", default=str(PROMPTS_FILE), metavar="FILE",
                    help="the prompts and the family settings (default tools/sound/prompts.json, round 4)")
    a = ap.parse_args(argv)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    root = Path(a.root).resolve()
    prompts_file = Path(a.prompts_file).resolve()
    skips_arg = Path(a.skips)
    if prompts_file != PROMPTS_FILE.resolve() and skips_arg == SKIPS_FILE:
        # round 5 reads its own list, tools/sound/skips5.json for prompts5.json; round 4's list names round-4 files
        skips_arg = HERE / (prompts_file.stem.replace("prompts", "skips", 1) + ".json")
    skips = load_skips(skips_arg) if a.skips else {}
    for t in a.skip:
        k, _, why = t.partition("=")
        skips[k.strip()] = why.strip() or "skipped by hand"
    result = run(root, not a.no_models, a.device, skips, prompts_file)
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
