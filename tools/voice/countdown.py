"""A countdown on an exact one-second grid, composed from single numbers (a listening sample, not the game's runtime).

The owner heard "Fold drive charged. Destination: Ysolde Prime. Jump in five, four, three, two, one." from the
speech models and found the count irregular. Here the five numbers are spoken apart, or cut out of the one
utterance, and placed by computer: the anchor of each number is exactly 48,000 samples after the one before.
The anchor of a word is the onset of its vowel (see vowel_onset), not the start of its file.

Run (from the repository root; the driver is not locked itself, it starts every model run through the lock):

    .venv-audio/Scripts/python.exe tools/voice/countdown.py all          # every stage below, in order
    .venv-audio/Scripts/python.exe tools/voice/countdown.py generate     # stage 1
    ...                                                                  # or one stage at a time

Stages (the driver `all` runs them as separate processes, each model run under tools/voice/with_lock.py):

 1 generate  say_qwen3.py (.venv-voice/qwen3, graphics card) and say_chatterbox-nano.py (.venv-voice/chatterbox-nano,
             processor) speak, in the cast voice "computer", 4 takes of the whole line and 6 takes of each of
             "Five." "Four." "Three." "Two." "One." into assets/audio/voice/_countdown/raw/<model>/.
 2 analyse   (.venv-audio, Whisper, locked) 48 kHz copies of every take; the recogniser reads each back; the
             list takes are cut at the word boundaries (Whisper word time stamps, refined to the level minimum
             between two words) into the intro and the five numbers; the pieces go to _countdown/work/<model>/.
             Also measures the two originals the owner heard (vowel onsets of their five numbers).
 3 embed     (.venv-voice/chatterbox-nano, locked) voice-encoder embeddings (the encoder tools/voice/identity.py
             uses) of every piece: work/<model>/emb.npz.
 4 compose   (.venv-audio) chooses takes by measurement only, matches the levels of the words, places them on the
             grid, matches the loudness of the file, writes _countdown/<model>__<variant>.wav and .json.
 5 embed2    (.venv-voice/chatterbox-nano, locked) the same for the pieces cut from the finished files.
 6 measure   (.venv-audio, Whisper, locked) re-measures the finished files blind (it finds the words by the
             silence between them, not from the placement table), reads them back, collects the similarities
             and writes _countdown/measure.json.

Everything is measured on 48 kHz, one channel, integer sample positions. Text files are written with LF.
Nobody can hear the result here: the numbers say what was measured, not how it sounds.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VOICE = ROOT / "assets" / "audio" / "voice"
CD = VOICE / "_countdown"
RAW = CD / "raw"
WORK = CD / "work"
SR = 48000
NUMS = ["five", "four", "three", "two", "one"]
DIGIT = {"five": "5", "four": "4", "three": "3", "two": "2", "one": "1"}
# What counts as the recogniser reading a word as that number. Fixed before the results were looked at:
# the spelled number or its digit, nothing else ("for", "to", "won" are NOT accepted).
ACCEPT = {w: {w, DIGIT[w]} for w in NUMS}
LINE = "Fold drive charged. Destination: Ysolde Prime. Jump in five, four, three, two, one."
INTRO_TEXT = "Fold drive charged. Destination: Ysolde Prime. Jump in"
MODELS = {
    "qwen3": {"say": "say_qwen3.py", "env": ".venv-voice/qwen3", "list_seed": 20261115, "word_tokens": 48,
              "original": "qwen3/cuda/computer_fold.wav", "args": ["--device", "cuda"]},
    "chatterbox-nano": {"say": "say_chatterbox-nano.py", "env": ".venv-voice/chatterbox-nano", "list_seed": 20261120,
                        "word_tokens": None, "original": "chatterbox-nano/cpu/computer_fold.wav",
                        "args": ["--threads", "4"]},
}
VARIANTS = ["single", "list"]
N_LIST_TAKES = 4
N_WORD_TAKES = 6
WORD_SEED0 = 101

# measuring constants
END_DB = -50.0            # a word has ended when its level is below this (dBFS, 5 ms windows)
FADE_S = 0.005            # fade of every word, at both ends
GUARD_S = 0.05            # a word must have ended this long before the next anchor
MIN_AFTER_INTRO_S = 0.45  # five sits at least this long after the end of the intro
LEAD_S = 0.003            # the file begins this long before the first sound (the library's rule: within 5 ms)
SPAN_MIN_S, SPAN_MAX_S = 0.2, 0.8
LEVEL_NEAR_DB = 3.0       # a take's sounding level may differ this much from the median of the takes
TARGET_LUFS = -23.0
TP_LIMIT_DB = -3.0


def _w(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_json(path: Path, obj) -> None:
    _w(path, json.dumps(obj, indent=1, ensure_ascii=False) + "\n")


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


# ======================================================================================= signal basics

def db(v) -> float:
    return float(20.0 * np.log10(max(float(v), 1e-12)))


def to48(x, sr: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sr == SR:
        return x
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(int(sr), SR)
    return resample_poly(x, SR // g, int(sr) // g)


def frame_db(x: np.ndarray, win: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """RMS level in dBFS of windows of `win` samples every `hop` samples: (levels, start sample of each window)."""
    x = np.asarray(x, dtype=np.float64)
    if x.size < win:
        return np.array([db(np.sqrt(np.mean(x ** 2)) if x.size else 0.0)]), np.array([0])
    c = np.concatenate([[0.0], np.cumsum(x * x)])
    starts = np.arange(0, x.size - win + 1, hop)
    p = (c[starts + win] - c[starts]) / win
    return 10.0 * np.log10(np.maximum(p, 1e-24)), starts


def sound_extent(x: np.ndarray, thresh_db: float = END_DB, win_s: float = 0.005, sr: int = SR) -> tuple[int, int] | None:
    """(first, end) sample of the part of x whose 5 ms windows are at or above thresh_db; end is exclusive."""
    win = max(1, int(round(win_s * sr)))
    lv, st = frame_db(x, win, max(1, win // 5))
    ok = np.flatnonzero(lv >= thresh_db)
    if ok.size == 0:
        return None
    return int(st[ok[0]]), int(min(x.size, st[ok[-1]] + win))


def sounding_level_db(x: np.ndarray, sr: int = SR, within_db: float = 20.0) -> float:
    """Level of the sounding part of a word: the power mean (dBFS) of the 20 ms windows within `within_db`
    of the loudest 20 ms window. Short words have no integrated loudness (BS.1770 needs 0.4 s)."""
    win = int(0.020 * sr)
    lv, _ = frame_db(x, win, win // 2)
    top = float(lv.max())
    sel = lv[lv >= top - within_db]
    return float(10.0 * np.log10(np.mean(10 ** (sel / 10.0))))


def sounding_span_s(x: np.ndarray, sr: int = SR, within_db: float = 35.0) -> float:
    """Length of the sounding part: first to last 10 ms window within `within_db` of the loudest."""
    win = int(0.010 * sr)
    lv, st = frame_db(x, win, win // 2)
    ok = np.flatnonzero(lv >= float(lv.max()) - within_db)
    return float((st[ok[-1]] + win - st[ok[0]]) / sr)


def trim_word(x: np.ndarray, rel_db: float = 45.0, pad_s: float = 0.005, sr: int = SR) -> tuple[np.ndarray, int]:
    """Cut the silence round a word: the part within rel_db of its loudest 5 ms window, plus pad_s on both sides.
    Returns (samples, index of the first kept sample in x)."""
    win = int(0.005 * sr)
    lv, st = frame_db(x, win, win // 5)
    ok = np.flatnonzero(lv >= float(lv.max()) - rel_db)
    pad = int(round(pad_s * sr))
    a = max(0, int(st[ok[0]]) - pad)
    b = min(x.size, int(st[ok[-1]]) + win + pad)
    return np.array(x[a:b], dtype=np.float64), a


def fade(x: np.ndarray, sr: int = SR, fade_s: float = FADE_S) -> np.ndarray:
    """Raised-cosine fade in and out; the first and the last sample become exactly zero."""
    y = np.array(x, dtype=np.float64)
    n = min(int(round(fade_s * sr)), y.size // 2)
    if n > 0:
        ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
        y[:n] *= ramp
        y[y.size - n:] *= ramp[::-1]
    return y


# ======================================================================================= vowel onset

def vowel_onset(x: np.ndarray, sr: int = SR, band: tuple[float, float] = (300.0, 3000.0), within_db: float = 15.0,
                level_win_s: float = 0.010, ac_win_s: float = 0.020, hop_s: float = 0.001, ac_min: float = 0.5,
                hold_s: float = 0.020, f0_range: tuple[float, float] = (70.0, 400.0)) -> dict | None:
    """The onset of the vowel of a word, found by measurement.

    The word is band-passed to 300-3000 Hz (4th-order Butterworth, zero phase). At every millisecond m the
    level is the RMS of the 10 ms window centred on m, and the signal is called periodic when the normalised
    autocorrelation of the 20 ms window centred on m reaches `ac_min` at some lag between 1/400 s and 1/70 s.
    The onset is the first m from which the level stays within `within_db` of the word's maximum level AND the
    signal is periodic for `hold_s` (a fricative is loud but not periodic; a click or a noise burst is not
    held). Returns {"sample", "time_s", "level_db", "max_db", "periodicity"} or None when there is no vowel.
    The search steps by 1 ms and is then refined to the sample, so the answer moves with the signal to the sample;
    its accuracy is that of the criteria: the position is the centre of the first qualifying window, so for a tone that
    starts abruptly it lay between -5.9 and +2.9 ms of the true start on the synthetic words of
    tests/test_countdown.py (noise bursts of 0 to 250 ms before a harmonic tone, f0 110 to 240 Hz).
    """
    from scipy.signal import butter, sosfiltfilt

    x = np.asarray(x, dtype=np.float64)
    if x.size < int(0.06 * sr) or not np.any(x):
        return None
    lo, hi = band
    sos = butter(4, [lo / (sr / 2), min(hi, 0.45 * sr) / (sr / 2)], btype="band", output="sos")
    y = sosfiltfilt(sos, x)
    hop = max(1, int(round(hop_s * sr)))
    lw = int(round(level_win_s * sr))
    aw = int(round(ac_win_s * sr))
    lag0, lag1 = int(sr / f0_range[1]), int(sr / f0_range[0])
    first = max(lw, aw) // 2
    last = y.size - max(lw, aw) // 2 - lag1 - 2          # last centre that still has its whole autocorrelation window
    if last <= first:
        return None
    c = np.concatenate([[0.0], np.cumsum(y * y)])
    allc = np.arange(first, last + 1)                     # every sample is a possible centre (level: one value each)
    a0 = allc - lw // 2
    level = 10.0 * np.log10(np.maximum((c[a0 + lw] - c[a0]) / lw, 1e-24))
    mx = float(level.max())
    lags = np.arange(lag0, lag1 + 1)
    e = np.concatenate([[0.0], np.cumsum(y * y)])

    def periodicity(m: int) -> float:
        s0 = m - aw // 2
        seg = y[s0: s0 + aw + lag1 + 1]
        a_ = seg[:aw]
        e0 = float(np.dot(a_, a_))
        if e0 <= 0:
            return 0.0
        r = np.correlate(seg, a_, mode="valid")           # r[lag] = sum a_[i] * seg[i + lag]
        el = e[s0 + lags + aw] - e[s0 + lags]
        return float((r[lags] / np.sqrt(np.maximum(e0 * el, 1e-30))).max())

    def ok(m: int) -> tuple[bool, float]:
        if level[m - first] < mx - within_db:
            return False, 0.0
        p = periodicity(m)
        return p >= ac_min, p

    # coarse: every hop (1 ms); the onset is the start of the first stretch that holds for hold_s
    need = max(1, int(round(hold_s / hop_s)))
    run = 0
    cache: dict[int, tuple[bool, float]] = {}
    for m in range(first, last + 1, hop):
        g, p = ok(m)
        cache[m] = (g, p)
        run = run + 1 if g else 0
        if run >= need:
            k = m - (need - 1) * hop
            # fine: back to the first sample of the stretch (the stretch began at most one hop earlier)
            r0 = k
            for mm in range(k - 1, max(first, k - 2 * hop) - 1, -1):
                if ok(mm)[0]:
                    r0 = mm
                else:
                    break
            g0, p0 = ok(r0)
            return {"sample": int(r0), "time_s": float(r0 / sr), "level_db": float(level[r0 - first]),
                    "max_db": mx, "periodicity": float(p0)}
    return None


# ======================================================================================= levels and placement

def match_levels(words: list[np.ndarray], ref_db: float | None = None, sr: int = SR) -> tuple[list[float], float]:
    """Gain in dB for each word so that all sounding levels are equal, by gain only. The common level is
    ref_db, or the mean of the words' levels when none is given. Returns (gains, common level)."""
    levels = [sounding_level_db(w, sr) for w in words]
    target = float(np.mean(levels)) if ref_db is None else float(ref_db)
    return [target - lv for lv in levels], target


def place_words(intro: np.ndarray, words: list[np.ndarray], onsets: list[int], first_anchor: int, sr: int = SR,
                fade_s: float = FADE_S, end_db: float = END_DB, guard_s: float = GUARD_S,
                spacing: int = SR) -> tuple[np.ndarray, list[dict]]:
    """Put the intro at sample 0 and word k with its vowel onset exactly on sample first_anchor + k * spacing.

    `onsets[k]` is the index of the vowel onset inside words[k]. Each word gets a fade of fade_s at both ends,
    a word is never shortened: when it does not end (level below end_db) guard_s before the next anchor, it is
    laid as it is, and the report says so. The file is exactly first_anchor + len(words) * spacing samples
    long (the last anchor plus one spacing is the moment of the jump); only a last word that runs past that
    point makes it longer, and the report says that too.
    Returns (samples, one record per word).
    """
    n_words = len(words)
    total = first_anchor + n_words * spacing
    recs: list[dict] = []
    placed = []
    for k, (w, o) in enumerate(zip(words, onsets)):
        anchor = first_anchor + k * spacing
        start = anchor - int(o)
        if start < 0:
            raise ValueError("word %d would start before the file (anchor %d, onset %d)" % (k, anchor, o))
        fw = fade(w, sr, fade_s)
        ext = sound_extent(fw, end_db, sr=sr)
        end = start + (ext[1] if ext else fw.size)  # exclusive end of the sounding part, in file samples
        nxt_anchor = anchor + spacing
        placed.append((start, fw))
        recs.append({"index": k, "anchor": int(anchor), "start": int(start), "vowel_onset_in_word": int(o),
                     "sound_end": int(end), "end_after_anchor_s": round((end - anchor) / sr, 4),
                     "ends_before_next_anchor_minus_guard": bool(end <= nxt_anchor - int(round(guard_s * sr))),
                     "samples": int(fw.size)})
    end_all = max([total] + [s + w.size for s, w in placed])
    out = np.zeros(end_all, dtype=np.float64)
    i0 = min(intro.size, out.size)
    out[:i0] += intro[:i0]
    for s, w in placed:
        out[s: s + w.size] += w
    for k, r in enumerate(recs):
        nxt = recs[k + 1]["start"] if k + 1 < n_words else None
        r["overlaps_next_word_start"] = bool(nxt is not None and r["sound_end"] > nxt)
        if k == n_words - 1:
            r["runs_past_the_jump"] = bool(placed[k][0] + placed[k][1].size > total)
    return out, recs


def vowel_onsets_blind(x: np.ndarray, sr: int = SR, thresh_db: float = END_DB, merge_s: float = 0.12,
                       margin_s: float = 0.01, **onset_kw) -> tuple[list[dict], list[tuple[int, int]]]:
    """Find the sounding runs of a finished file by silence alone (5 ms windows at or above thresh_db, gaps
    shorter than merge_s joined) and the vowel onset of each run. Returns (onsets, runs)."""
    win = int(0.005 * sr)
    hop = win // 5
    lv, st = frame_db(x, win, hop)
    on = lv >= thresh_db
    runs: list[list[int]] = []
    for i in np.flatnonzero(on):
        a, b = int(st[i]), int(st[i] + win)
        if runs and a - runs[-1][1] <= int(merge_s * sr):
            runs[-1][1] = b
        else:
            runs.append([a, b])
    out = []
    m = int(margin_s * sr)
    for a, b in runs:
        a0, b0 = max(0, a - m), min(x.size, b + m)
        o = vowel_onset(x[a0:b0], sr, **onset_kw)
        out.append(None if o is None else {**o, "sample_in_file": a0 + o["sample"]})
    return out, [(a, b) for a, b in runs]


def refine_boundary(x: np.ndarray, t_end: float, t_start: float, sr: int = SR, half_s: float = 0.06) -> int:
    """The cut between two words: the level minimum (5 ms windows) within half_s of the middle of the gap
    between the end of the first word and the start of the second, as Whisper gives them. Returns a sample."""
    c = 0.5 * (t_end + t_start)
    lo, hi = max(0, int((c - half_s) * sr)), min(x.size, int((c + half_s) * sr))
    win = int(0.005 * sr)
    if hi - lo <= win:
        return int(c * sr)
    lv, st = frame_db(x[lo:hi], win, max(1, win // 5))
    k = int(np.argmin(lv + 1e-6 * np.abs(st + win / 2 - (c * sr - lo)) / sr))  # ties: nearest to the middle
    return int(lo + st[k] + win // 2)


def loudness_and_peak(x: np.ndarray, sr: int = SR) -> tuple[float | None, float]:
    sys.path.insert(0, str(HERE))
    import score

    return score.integrated_lufs(x, sr), score.true_peak_db(x, sr)


# ======================================================================================= recogniser

def norm_token(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", t.lower())


def read_number(text: str, word: str) -> bool:
    """Does the reading of a single-word clip say that number? (strict, see ACCEPT)"""
    toks = [norm_token(t) for t in text.replace("-", " ").split()]
    toks = [t for t in toks if t]
    return len(toks) == 1 and toks[0] in ACCEPT[word]


class Asr:
    """Whisper small (the one tools/voice/score.py uses). Clips are padded with 0.3 s of silence on both sides."""

    def __init__(self):
        sys.path.insert(0, str(HERE))
        import score

        self.w = score.load_whisper()
        self.pipe = None

    def text(self, x48: np.ndarray, pad_s: float = 0.3) -> str:
        pad = np.zeros(int(pad_s * SR))
        return self.w.transcribe(np.concatenate([pad, x48, pad]).astype(np.float32), SR, "en").strip()

    def words(self, x48: np.ndarray) -> list[dict]:
        """Word time stamps (seconds) of Whisper small: [{"word", "start", "end"}]."""
        from transformers import pipeline

        if self.pipe is None:
            self.pipe = pipeline("automatic-speech-recognition", model=self.w.model, tokenizer=self.w.processor.tokenizer,
                                 feature_extractor=self.w.processor.feature_extractor, device=self.w.device)
        sys.path.insert(0, str(HERE))
        import score

        x16 = score.resample_to(np.asarray(x48), SR, 16000).astype(np.float32)
        out = self.pipe({"raw": x16, "sampling_rate": 16000}, return_timestamps="word",
                        generate_kwargs={"language": "en", "task": "transcribe"})
        res = []
        for ch in out.get("chunks", []):
            a, b = ch["timestamp"]
            res.append({"word": ch["text"].strip(), "start": None if a is None else float(a),
                        "end": None if b is None else float(b)})
        return res


def find_count_words(words: list[dict]) -> list[int] | None:
    """Indices of the five numbers (in order) among the recogniser's words: the last five words that read as
    five, four, three, two, one in that order. None when they are not all there."""
    toks = [norm_token(w["word"]) for w in words]
    for i in range(len(toks) - 4, -1, -1):
        if all(toks[i + k] in ACCEPT[NUMS[k]] for k in range(5)):
            return list(range(i, i + 5))
    return None


def cut_list_take(x48: np.ndarray, words: list[dict], idx: list[int]) -> dict:
    """Boundaries (samples) between the intro and the five numbers of a list take, from the word time stamps
    refined to the level minimum between two words. Returns {"bounds": [b0..b5], "intro_end": b0}."""
    bounds = []
    first = idx[0]
    prev_end = words[first - 1]["end"] if first > 0 else None
    t0 = words[first]["start"]
    bounds.append(refine_boundary(x48, prev_end if prev_end is not None else t0 - 0.1, t0))
    for k in range(4):
        bounds.append(refine_boundary(x48, words[idx[k]]["end"], words[idx[k + 1]]["start"]))
    last_end = words[idx[4]]["end"]
    lo = int(last_end * SR)
    hi = min(x48.size, int((last_end + 0.15) * SR))
    win = int(0.005 * SR)
    if hi - lo > win:
        lv, st = frame_db(x48[lo:hi], win, win // 5)
        bounds.append(int(lo + st[int(np.argmin(lv))] + win // 2))
    else:
        bounds.append(min(x48.size, hi))
    return {"bounds": bounds}


# ======================================================================================= stage 1: generate

def items_for(model: str) -> dict:
    m = MODELS[model]
    items = []
    for i in range(N_LIST_TAKES):
        items.append({"id": "list_s%d" % (i + 1), "text": LINE, "seed": m["list_seed"] + i})
    for w in NUMS:
        for k in range(N_WORD_TAKES):
            it = {"id": "%s_s%d" % (w, k + 1), "text": w.capitalize() + ".", "seed": WORD_SEED0 + k}
            if m["word_tokens"]:
                it["max_new_tokens"] = m["word_tokens"]
            items.append(it)
    return {"voice": "computer", "items": items}


def py_of(env: str) -> str:
    return str(ROOT / env / "Scripts" / "python.exe")


def locked(cmd: list[str], wait: int = 3600) -> int:
    full = [py_of(".venv-audio"), str(HERE / "with_lock.py"), "--wait", str(wait), "--"] + cmd
    print(">", " ".join(full))
    return subprocess.call(full, cwd=str(ROOT))


def stage_generate(force: bool = False) -> int:
    for model, m in MODELS.items():
        out = RAW / model
        if (out / "say.json").is_file() and not force:
            print("generate: %s exists, skipped (--force to redo)" % model)
            continue
        items = RAW / ("items_%s.json" % model)
        write_json(items, items_for(model))
        rc = locked([py_of(m["env"]), str(HERE / m["say"]), "--items", str(items), "--out", str(out)] + m["args"])
        if rc:
            return rc
    return 0


# ======================================================================================= stage 2: analyse

def save_wav(path: Path, x: np.ndarray, sr: int = SR) -> None:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.asarray(x, dtype=np.float32), sr, subtype="FLOAT")


def load_wav48(path: Path) -> np.ndarray:
    import soundfile as sf

    x, sr = sf.read(str(path), dtype="float64", always_2d=False)
    return to48(x, sr)


def piece_metrics(asr: Asr, x: np.ndarray, word: str | None) -> dict:
    ext = trim_word(x)[0]
    d = {"samples": int(x.size), "span_s": round(sounding_span_s(ext), 4), "level_db": round(sounding_level_db(ext), 2)}
    o = vowel_onset(ext)
    d["vowel_onset_in_piece"] = None if o is None else o["sample"]
    if word is not None:
        d["reading"] = asr.text(ext)
        d["reads_as_number"] = read_number(d["reading"], word)
    return d


def analyse_original(asr: Asr, rel: str) -> dict:
    """Vowel onsets of the five numbers in a file of the comparison, by the same method as for the new files."""
    x = load_wav48(VOICE / rel)
    words = asr.words(x)
    idx = find_count_words(words)
    rec = {"file": "assets/audio/voice/" + rel, "duration_s": round(x.size / SR, 3), "text": asr.text(x, 0.0),
           "recogniser_words": words}
    if idx is None:
        rec["error"] = "the five numbers were not all found among the recogniser's words"
        return rec
    cut = cut_list_take(x, words, idx)["bounds"]
    onsets, segs = [], []
    for k in range(5):
        a, b = cut[k], cut[k + 1]
        o = vowel_onset(x[a:b])
        onsets.append(None if o is None else a + o["sample"])
        segs.append([int(a), int(b)])
    rec["segments"] = segs
    rec["vowel_onsets_s"] = [None if o is None else round(o / SR, 4) for o in onsets]
    if all(o is not None for o in onsets):
        iv = [round((onsets[k + 1] - onsets[k]) * 1000.0 / SR, 1) for k in range(4)]
        rec["intervals_ms"] = iv
        rec["target_ms"] = 1000.0
        rec["deviation_ms"] = [round(v - 1000.0, 1) for v in iv]
    return rec


def stage_analyse() -> int:
    asr = Asr()
    originals = {}
    for model, m in MODELS.items():
        originals[model] = analyse_original(asr, m["original"])
        print("original", model, originals[model].get("intervals_ms"), originals[model].get("error", ""))
    write_json(CD / "originals.json", originals)
    for model in MODELS:
        raw = RAW / model
        say = read_json(raw / "say.json")
        wd = WORK / model
        res = {"model": model, "say": {"model": say["model"], "revision": say["revision"], "device": say["device"]},
               "lists": {}, "singles": {}}
        for i in range(N_LIST_TAKES):
            tid = "list_s%d" % (i + 1)
            x = load_wav48(raw / (tid + ".wav"))
            words = asr.words(x)
            rec = {"seed": say["items"][tid]["seed"], "duration_s": round(x.size / SR, 3), "text": asr.text(x, 0.0),
                   "recogniser_words": words}
            idx = find_count_words(words)
            if idx is None or idx[0] < 1:
                rec["error"] = "the five numbers were not all found among the recogniser's words"
                res["lists"][tid] = rec
                print(model, tid, "no five numbers:", rec["text"])
                continue
            cut = cut_list_take(x, words, idx)["bounds"]
            rec["bounds"] = [int(b) for b in cut]
            intro = x[:cut[0]]
            ie = trim_word(intro)  # lead trimmed (the intro's start is placed by compose)
            rec["intro"] = {"samples": int(intro.size), "reading": asr.text(intro, 0.0),
                            "sound_start": int(ie[1]), "level_db": round(sounding_level_db(intro), 2)}
            save_wav(wd / tid / "intro.wav", intro)
            rec["words"] = {}
            for k, w in enumerate(NUMS):
                piece = x[cut[k]:cut[k + 1]]
                tw, off = trim_word(piece)
                met = piece_metrics(asr, piece, w)
                met.update({"cut_from": int(cut[k]), "cut_to": int(cut[k + 1]), "trim_offset": int(off),
                            "recogniser_word": words[idx[k]]["word"]})
                save_wav(wd / tid / (w + ".wav"), tw)
                rec["words"][w] = met
            o5 = vowel_onset(x[cut[0]:cut[1]])
            rec["original_anchor_five"] = None if o5 is None else int(cut[0] + o5["sample"])
            rec["all_pass"] = all(v["reads_as_number"] and SPAN_MIN_S <= v["span_s"] <= SPAN_MAX_S and
                                  v["vowel_onset_in_piece"] is not None for v in rec["words"].values())
            res["lists"][tid] = rec
            print(model, tid, "readings:", [v["reading"] for v in rec["words"].values()], "pass" if rec["all_pass"] else "")
        for w in NUMS:
            for k in range(N_WORD_TAKES):
                tid = "%s_s%d" % (w, k + 1)
                x = load_wav48(raw / (tid + ".wav"))
                tw, off = trim_word(x)
                met = piece_metrics(asr, x, w)
                met["seed"] = say["items"][tid]["seed"]
                met["raw_duration_s"] = round(x.size / SR, 3)
                save_wav(wd / "single" / (tid + ".wav"), tw)
                res["singles"][tid] = met
                print(model, tid, repr(met["reading"]), met["span_s"], met["level_db"])
        write_json(CD / ("analysis_%s.json" % model), res)
    return 0


# ======================================================================================= stage 3 and 5: embed

def stage_embed(target: str) -> int:
    """Run in .venv-voice/chatterbox-nano: embeddings of every wav under work/<model>/ (target 'work') or under
    work/composed/ (target 'composed'), as float64 vectors in emb.npz beside them."""
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ.pop("HF_TOKEN", None)
    sys.path.insert(0, str(HERE))
    import identity
    import librosa

    ve, _ = identity.load_encoder()
    if target == "work":
        roots = [WORK / m for m in MODELS]
    else:
        roots = [d for d in sorted((WORK / "composed").glob("*")) if d.is_dir()]
    for root in roots:
        vecs = {}
        for p in sorted(root.rglob("*.wav")):
            x = load_wav48(p)
            x16 = librosa.resample(x.astype(np.float32), orig_sr=SR, target_sr=16000)
            e = np.asarray(ve.embeds_from_wavs([x16], sample_rate=16000)[0], dtype=np.float64)
            vecs[str(p.relative_to(root)).replace("\\", "/")] = e / np.linalg.norm(e)
        np.savez(root / "emb.npz", **{k.replace("/", "__"): v for k, v in vecs.items()})
        print("embed", root.name, len(vecs), "files")
    return 0


def load_emb(root: Path) -> dict[str, np.ndarray]:
    z = np.load(root / "emb.npz")
    return {k.replace("__", "/"): z[k] for k in z.files}


def cos(a, b) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


# ======================================================================================= stage 4: compose

def choose_single_takes(an: dict, emb: dict, intro_key: str) -> dict:
    """One take per word, by measurement only. A take passes when the recogniser reads it as the number, its
    sounding part is 0.2 to 0.8 s long, its level is within LEVEL_NEAR_DB of the median level of the takes that
    read right, and a vowel onset was found. Among the passing takes the one most similar to the intro wins; a
    word with no passing take gets the take that meets the most conditions (then the most similar), and is said so."""
    singles = an["singles"]
    ok_read = [v["level_db"] for v in singles.values() if v["reads_as_number"]]
    ref_level = float(np.median(ok_read)) if ok_read else float(np.median([v["level_db"] for v in singles.values()]))
    iv = emb[intro_key]
    out = {}
    for w in NUMS:
        cands = []
        for k in range(N_WORD_TAKES):
            tid = "%s_s%d" % (w, k + 1)
            v = singles[tid]
            conds = {"reads_as_number": bool(v["reads_as_number"]),
                     "span_ok": SPAN_MIN_S <= v["span_s"] <= SPAN_MAX_S,
                     "level_near_others": abs(v["level_db"] - ref_level) <= LEVEL_NEAR_DB,
                     "vowel_found": v["vowel_onset_in_piece"] is not None}
            sim = cos(emb["single/%s.wav" % tid], iv)
            cands.append({"take": tid, "seed": v["seed"], "reading": v["reading"], "span_s": v["span_s"],
                          "level_db": v["level_db"], "similarity_to_intro": round(sim, 4), "conditions": conds,
                          "passes": all(conds.values())})
        passing = [c for c in cands if c["passes"]]
        pool = passing or cands
        best = max(pool, key=lambda c: (sum(c["conditions"].values()), c["similarity_to_intro"]))
        out[w] = {"take": best["take"], "passes": best["passes"], "candidates": cands, "reference_level_db": round(ref_level, 2),
                  "note": None if best["passes"] else "no take of this word passes every condition; the nearest was taken (%s)" %
                  ", ".join(k for k, v in best["conditions"].items() if not v)}
    return out


def choose_list_take(an: dict, emb: dict) -> dict:
    cands = []
    for tid, rec in an["lists"].items():
        if "error" in rec:
            cands.append({"take": tid, "passes": False, "n_pass": 0, "error": rec["error"], "reading": rec["text"]})
            continue
        iv = emb["%s/intro.wav" % tid]
        sims = {w: cos(emb["%s/%s.wav" % (tid, w)], iv) for w in NUMS}
        n_pass = sum(1 for v in rec["words"].values()
                     if v["reads_as_number"] and SPAN_MIN_S <= v["span_s"] <= SPAN_MAX_S and v["vowel_onset_in_piece"] is not None)
        cands.append({"take": tid, "passes": bool(rec["all_pass"]), "n_pass": n_pass, "reading": rec["text"],
                      "mean_similarity_to_intro": round(float(np.mean(list(sims.values()))), 4),
                      "similarity_to_intro": {w: round(s, 4) for w, s in sims.items()}})
    pool = [c for c in cands if c["passes"]] or cands
    best = max(pool, key=lambda c: (c["n_pass"], c.get("mean_similarity_to_intro", -1)))
    return {"take": best["take"], "passes": best["passes"], "candidates": cands,
            "note": None if best["passes"] else "no list take passes every condition for all five words; the nearest was taken"}


def compose_file(model: str, variant: str, an: dict, emb: dict, list_choice: dict, single_choice: dict | None) -> dict:
    wd = WORK / model
    lt = list_choice["take"]
    lrec = an["lists"][lt]
    intro_raw = load_wav48(wd / lt / "intro.wav")
    # --- the intro: the whole-take gain to the target loudness first, so that the -50 dBFS rules mean what they
    # say on a file near its final level (the exact file gain is applied once the mix exists, see below)
    lufs_take, _ = loudness_and_peak(load_wav48(RAW / model / (lt + ".wav")))
    g0 = 10 ** ((TARGET_LUFS - (lufs_take if lufs_take is not None else TARGET_LUFS)) / 20.0)
    intro_raw = intro_raw * g0
    ext = sound_extent(intro_raw, END_DB) or (0, intro_raw.size)
    lead = max(0, ext[0] - int(round(LEAD_S * SR)))
    intro = np.array(intro_raw[lead:])
    nf = int(round(LEAD_S * SR))
    intro[:nf] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(nf) / nf)
    nf2 = int(round(FADE_S * SR))
    intro[-nf2:] *= 0.5 + 0.5 * np.cos(np.pi * (np.arange(nf2) + 1) / nf2)
    isnd = sound_extent(intro, END_DB)
    intro_end = int(isnd[1]) if isnd else intro.size
    # --- the words
    pieces, srcs = [], {}
    for w in NUMS:
        if variant == "list":
            p = load_wav48(wd / lt / (w + ".wav"))
            srcs[w] = {"source": "list", "take": lt, "cut_from_s": round(lrec["words"][w]["cut_from"] / SR, 4),
                       "cut_to_s": round(lrec["words"][w]["cut_to"] / SR, 4)}
        else:
            tid = single_choice[w]["take"]
            p = load_wav48(wd / "single" / (tid + ".wav"))
            srcs[w] = {"source": "single", "take": tid, "seed": an["singles"][tid]["seed"],
                       "passes_every_condition": single_choice[w]["passes"], "note": single_choice[w]["note"]}
        pieces.append(p)
    ref_db = sounding_level_db(intro)
    gains, common_db = match_levels(pieces, ref_db=ref_db)
    words = [p * 10 ** (g / 20.0) for p, g in zip(pieces, gains)]
    onsets = []
    for w, p in zip(NUMS, words):
        o = vowel_onset(p)
        if o is None:
            raise SystemExit("%s %s: no vowel onset found in %s" % (model, variant, w))
        onsets.append(o["sample"])
    o_orig = lrec.get("original_anchor_five")
    orig_in_timeline = None if o_orig is None else int(o_orig - lead)
    a5 = intro_end + int(round(MIN_AFTER_INTRO_S * SR))
    if orig_in_timeline is not None and orig_in_timeline > a5:
        a5 = orig_in_timeline
    a5_why = "original position in the list take" if (orig_in_timeline is not None and orig_in_timeline >= intro_end + int(round(MIN_AFTER_INTRO_S * SR))) else "0.45 s after the end of the intro"
    mix, _ = place_words(intro, words, onsets, a5)
    # --- loudness of the whole file: gain only (BS.1770 integrated loudness), true peak guard. The gain is applied
    # to the parts and the file is placed again, so that every record below is measured at the final level.
    lufs_in, tp_in = loudness_and_peak(mix)
    gain = TARGET_LUFS - lufs_in
    limited = False
    if tp_in + gain > TP_LIMIT_DB:
        gain = TP_LIMIT_DB - tp_in
        limited = True
    k_gain = 10 ** (gain / 20.0)
    intro, words = intro * k_gain, [w * k_gain for w in words]
    final, recs = place_words(intro, words, onsets, a5)
    lufs_out, tp_out = loudness_and_peak(final)
    intro_end = int(sound_extent(intro, END_DB)[1])
    name = "%s__%s" % (model, variant)
    save_wav(CD / (name + ".wav"), final)
    # the word records on the finished file
    for k, r in enumerate(recs):
        seg = final[r["start"]: r["start"] + words[k].size]
        r["word"] = NUMS[k]
        r.update(srcs[NUMS[k]])
        r["gain_db_word_level_match"] = round(float(gains[k]), 3)
        r["level_db"] = round(sounding_level_db(seg), 3)
        r["anchor_s"] = round(r["anchor"] / SR, 6)
        r["vowel_onset_found_in_word_s"] = round(onsets[k] / SR, 5)
        r["word_end_s"] = round(r["sound_end"] / SR, 5)
    levels = [r["level_db"] for r in recs]
    # pieces of the finished file for the second embedding: intro, each word, the count as it is heard
    cdir = WORK / "composed" / name
    save_wav(cdir / "intro.wav", final[:intro_end])
    for k, r in enumerate(recs):
        save_wav(cdir / (NUMS[k] + ".wav"), final[r["start"]: r["start"] + words[k].size])
    c0, c1 = recs[0]["start"], recs[-1]["start"] + words[-1].size
    save_wav(cdir / "count.wav", final[c0:c1])
    save_wav(cdir / "count_joined.wav", np.concatenate([final[r["start"]: r["start"] + words[k].size] for k, r in enumerate(recs)]))
    meta = {
        "name": name, "model": model, "variant": variant, "file": "assets/audio/voice/_countdown/%s.wav" % name,
        "sample_rate": SR, "channels": 1, "samples": int(final.size), "duration_s": round(final.size / SR, 6),
        "line": LINE, "intro_text": INTRO_TEXT, "list_take_for_intro": lt,
        "intro": {"samples": int(intro.size), "sound_end": int(intro_end), "lead_trim_samples": int(lead)},
        "first_anchor": int(a5), "first_anchor_s": round(a5 / SR, 6), "first_anchor_rule": a5_why,
        "original_anchor_in_timeline": orig_in_timeline,
        "grid_samples": SR, "anchors": [r["anchor"] for r in recs],
        "jump_sample": int(a5 + 5 * SR), "ends_at_jump": bool(final.size == a5 + 5 * SR),
        "word_level_match": {"common_level_db_before_file_gain": round(common_db, 3), "reference": "sounding level of the intro",
                             "spread_db_after": round(max(levels) - min(levels), 3)},
        "loudness": {"lufs_before_gain": round(lufs_in, 3), "gain_db": round(gain, 3), "lufs": round(lufs_out, 3),
                     "true_peak_db": round(tp_out, 3), "limited_by_true_peak": limited, "target_lufs": TARGET_LUFS,
                     "true_peak_limit_db": TP_LIMIT_DB},
        "words": recs,
        "choices": {"list": list_choice if variant == "list" else {"take": lt, "note": "intro only"},
                    **({"singles": single_choice} if single_choice else {})},
        "all_words_end_before_next_anchor_minus_50ms": all(r["ends_before_next_anchor_minus_guard"] for r in recs),
    }
    write_json(CD / (name + ".json"), meta)
    print("composed", name, "%.3f s" % (final.size / SR), "lufs %.2f tp %.2f" % (lufs_out, tp_out), "anchors", a5)
    return meta


def stage_compose() -> int:
    for model in MODELS:
        an = read_json(CD / ("analysis_%s.json" % model))
        emb = load_emb(WORK / model)
        lc = choose_list_take(an, emb)
        print(model, "list take", lc["take"], "passes" if lc["passes"] else "NO full pass")
        sc = choose_single_takes(an, emb, "%s/intro.wav" % lc["take"])
        for w in NUMS:
            print("  ", w, sc[w]["take"], "pass" if sc[w]["passes"] else sc[w]["note"])
        for variant in VARIANTS:
            compose_file(model, variant, an, emb, lc, sc if variant == "single" else None)
    return 0


# ======================================================================================= stage 6: measure

def stage_measure() -> int:
    asr = Asr()
    originals = read_json(CD / "originals.json")
    out = {"note": "Measured, not listened to. Intervals are between the vowel onsets (tools/voice/countdown.py vowel_onset) "
                   "of the five numbers, in milliseconds; the target is 1000. 'blind' means the words were found in the "
                   "finished file by the silence between them, without the placement table.",
           "files": {}, "originals": {}}
    for model, o in originals.items():
        out["originals"][model] = {k: o.get(k) for k in ("file", "vowel_onsets_s", "intervals_ms", "deviation_ms", "error", "text")}
    for model in MODELS:
        for variant in VARIANTS:
            name = "%s__%s" % (model, variant)
            meta = read_json(CD / (name + ".json"))
            x = load_wav48(CD / (name + ".wav"))
            emb = load_emb(WORK / "composed" / name)
            iv = emb["intro.wav"]
            onsets, runs = vowel_onsets_blind(x)
            rec = {"samples": int(x.size), "duration_s": round(x.size / SR, 6), "ends_at_jump_point": meta["ends_at_jump"],
                   "jump_sample": meta["jump_sample"], "runs_found_blind": len(runs),
                   "loudness": meta["loudness"], "first_anchor_s": meta["first_anchor_s"], "first_anchor_rule": meta["first_anchor_rule"]}
            rec["intervals_by_construction_ms"] = [round((meta["anchors"][k + 1] - meta["anchors"][k]) * 1000.0 / SR, 3) for k in range(4)]
            if len(runs) >= 6 and all(o is not None for o in onsets[-5:]):
                rec["runs_before_the_count"] = len(runs) - 5
                ob = [o["sample_in_file"] for o in onsets[-5:]]
                rec["blind_vowel_onsets_s"] = [round(o / SR, 5) for o in ob]
                rec["intervals_blind_ms"] = [round((ob[k + 1] - ob[k]) * 1000.0 / SR, 3) for k in range(4)]
                rec["deviation_blind_ms"] = [round(v - 1000.0, 3) for v in rec["intervals_blind_ms"]]
                rec["blind_onset_minus_anchor_ms"] = [round((ob[k] - meta["anchors"][k]) * 1000.0 / SR, 3) for k in range(5)]
                # how much the exactness depends on the definition of "onset": the same blind search with the level
                # criterion 10 dB and 20 dB instead of 15 dB below the maximum
                rec["sensitivity_to_the_definition"] = {}
                for wd in (10.0, 20.0):
                    on2, _ = vowel_onsets_blind(x, within_db=wd)
                    if all(o is not None for o in on2[-5:]):
                        o2 = [o["sample_in_file"] for o in on2[-5:]]
                        rec["sensitivity_to_the_definition"]["within_%gdb" % wd] = {
                            "intervals_ms": [round((o2[k + 1] - o2[k]) * 1000.0 / SR, 2) for k in range(4)],
                            "onset_minus_anchor_ms": [round((o2[k] - meta["anchors"][k]) * 1000.0 / SR, 2) for k in range(5)]}
            else:
                rec["blind_error"] = "expected at least 6 sounding runs (intro and five numbers), found %d" % len(runs)
                rec["runs"] = [[int(a), int(b)] for a, b in runs]
            rec["words"] = {}
            for k, w in enumerate(NUMS):
                r = meta["words"][k]
                seg = x[r["start"]: r["start"] + r["samples"]]
                reading = asr.text(seg)
                rec["words"][w] = {"anchor_s": r["anchor_s"], "vowel_onset_found_in_word_s": r["vowel_onset_found_in_word_s"],
                                   "word_end_s": r["word_end_s"], "end_after_anchor_s": r["end_after_anchor_s"],
                                   "ends_before_next_anchor_minus_50ms": r["ends_before_next_anchor_minus_guard"],
                                   "overlaps_next_word_start": r["overlaps_next_word_start"],
                                   "level_db": r["level_db"], "peak_db": round(db(np.abs(seg).max()), 2),
                                   "rms_db_of_the_sounding_extent": round(db(np.sqrt(np.mean(seg[slice(*sound_extent(seg, END_DB))] ** 2))), 2),
                                   "reading": reading, "reads_as_number": read_number(reading, w),
                                   "similarity_to_intro": round(cos(emb[w + ".wav"], iv), 4), "source": {
                                       kk: r[kk] for kk in ("source", "take") if kk in r}}
                r["recogniser_reading"] = reading
                r["reads_as_number"] = read_number(reading, w)
                r["similarity_to_intro"] = rec["words"][w]["similarity_to_intro"]
            lv = [rec["words"][w]["level_db"] for w in NUMS]
            rec["word_levels_spread_db"] = round(max(lv) - min(lv), 3)
            rr = [rec["words"][w]["rms_db_of_the_sounding_extent"] for w in NUMS]
            pk = [rec["words"][w]["peak_db"] for w in NUMS]
            rec["word_rms_spread_db_whole_word"] = round(max(rr) - min(rr), 2)
            rec["word_peak_spread_db"] = round(max(pk) - min(pk), 2)
            rec["all_words_end_before_next_anchor_minus_50ms"] = all(rec["words"][w]["ends_before_next_anchor_minus_50ms"] for w in NUMS)
            rec["similarity_whole_count_as_heard_to_intro"] = round(cos(emb["count.wav"], iv), 4)
            rec["similarity_whole_count_words_joined_to_intro"] = round(cos(emb["count_joined.wav"], iv), 4)
            rec["recogniser_reading_whole_file"] = asr.text(x, 0.0)
            meta["measure"] = {k: rec[k] for k in rec if k not in ("words",)}
            write_json(CD / (name + ".json"), meta)
            out["files"][name] = rec
            print(name, "blind intervals", rec.get("intervals_blind_ms"), "|", rec["recogniser_reading_whole_file"])
    write_json(CD / "measure.json", out)
    print("wrote", CD / "measure.json")
    return 0


# ======================================================================================= driver

def run_self(*args: str, env: str = ".venv-audio", lock: bool = True) -> int:
    cmd = [py_of(env), str(Path(__file__).resolve())] + list(args)
    if lock:
        return locked(cmd)
    print(">", " ".join(cmd))
    return subprocess.call(cmd, cwd=str(ROOT))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("stage", choices=["all", "generate", "analyse", "embed", "compose", "embed2", "measure"])
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    s = a.stage
    if s == "generate":
        return stage_generate(a.force)
    if s == "analyse":
        return stage_analyse()
    if s == "embed":
        return stage_embed("work")
    if s == "embed2":
        return stage_embed("composed")
    if s == "compose":
        return stage_compose()
    if s == "measure":
        return stage_measure()
    for step in (lambda: stage_generate(a.force),
                 lambda: run_self("analyse"),
                 lambda: run_self("embed", env=".venv-voice/chatterbox-nano"),
                 lambda: run_self("compose", lock=False),
                 lambda: run_self("embed2", env=".venv-voice/chatterbox-nano"),
                 lambda: run_self("measure")):
        rc = step()
        if rc:
            return rc
    return 0


if __name__ == "__main__":
    sys.exit(main())
