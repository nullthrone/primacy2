"""Measure the rendered speech of the voice comparison and make the listening copies.

    .venv-audio/Scripts/python.exe tools/voice/score.py [--models a,b] [--no-whisper] [--listen]
    .venv-audio/Scripts/python.exe tools/voice/with_lock.py -- .venv-audio/Scripts/python.exe tools/voice/score.py

Runs with the environment of the sound library (it only reads it). Reads, never changes, the WAV files
under assets/audio/voice/<model>/<device>/ and writes assets/audio/voice/scores.json (merged with what
is there, per model) and, with --listen, assets/audio/voice/_listen/. Whisper small runs on the graphics
card when that has room, else on the processor; take the lock (with_lock.py) when it will use the card.

Word errors. Reference and recogniser output pass through the same steps, then are aligned by edit
distance. The Whisper English normaliser writes spelled numbers as digits, but it merges "seven four nine"
into 749, keeps "niner", drops the zero of "04" and the percent sign of "20 %". So before it runs this
script (a) reads "niner" as nine, "decimal" as point, "m/s" as metres per second and "%" as percent, (b)
writes every digit string out as spoken digits, and after it (c) cuts every digit run into single digits.
"seven four niner", "749", "7 4 9" and "seven four nine" are then the same three tokens. Radio call signs
("Alpha Kilo", "AK-447") are made equal the same way. Errors are counted apart: ordinary words and the
invented names of a line ('names' in lines.json). An error run (substitutions, deletions, insertions in a
row) that touches a name position counts for the name, not for the ordinary words.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VOICE = ROOT / "assets" / "audio" / "voice"
AUDIO_TOOLS = ROOT / "tools" / "audio"

SILENCE_DB = -50.0
WINDOW_S = 0.010
CLIP_AT = 0.999
LONG_SILENCE_S = 0.8
LISTEN_SR = 48000
LISTEN_LUFS = -23.0
LISTEN_TP_DB = -3.0
FADE_S = 0.008


def db(x) -> float:
    return float(20.0 * np.log10(max(float(x), 1e-12)))


# ----------------------------------------------------------------------------- level and shape

def to_mono(x) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x if x.ndim == 1 else x.mean(axis=1)


def true_peak_db(x, sr: int = 48000) -> float:
    """Peak of the 4x oversampled signal in dBFS (same method as synth/levels.py true_peak_db)."""
    from scipy.signal import resample_poly

    x = to_mono(x)
    if x.size == 0:
        return -240.0
    return db(np.max(np.abs(resample_poly(x, 4, 1))))


def integrated_lufs(x, sr: int):
    """BS.1770 integrated loudness at the file's own rate; None if too short or silent.
    (synth/levels.py lufs() meters at a fixed 48 kHz and tiles short clips, so it is not used here.)"""
    import pyloudnorm as pyln

    x = to_mono(x)
    if x.size < int(0.4 * sr) + 1 or not np.any(x):
        return None
    try:
        v = float(pyln.Meter(sr).integrated_loudness(x[:, None]))
    except Exception:
        return None
    return v if np.isfinite(v) else None


def silence_profile(x, sr: int, thresh_db: float = SILENCE_DB, win_s: float = WINDOW_S) -> dict:
    """Silence (10 ms windows with RMS below thresh_db) at the start, at the end, longest inside."""
    x = to_mono(x)
    w = max(1, int(round(win_s * sr)))
    n = x.size // w
    if n == 0:
        return {"lead_s": 0.0, "tail_s": 0.0, "longest_inside_s": 0.0, "all_silent": bool(x.size)}
    r = np.sqrt(np.mean(x[: n * w].reshape(n, w) ** 2, axis=1))
    quiet = 20 * np.log10(np.maximum(r, 1e-12)) < thresh_db
    if quiet.all():
        return {"lead_s": round(x.size / sr, 3), "tail_s": 0.0, "longest_inside_s": 0.0, "all_silent": True}
    first = int(np.argmax(~quiet))
    last = n - 1 - int(np.argmax(~quiet[::-1]))
    longest = run = 0
    for q in quiet[first: last + 1]:
        run = run + 1 if q else 0
        longest = max(longest, run)
    return {"lead_s": round(first * w / sr, 3), "tail_s": round((x.size - (last + 1) * w) / sr, 3),
            "longest_inside_s": round(longest * w / sr, 3), "all_silent": False}


def level_report(x, sr: int, spoken: str | None = None) -> dict:
    m = to_mono(x)
    dur = m.size / float(sr) if sr else 0.0
    bad = int(np.sum(~np.isfinite(m)))
    m = np.nan_to_num(m)
    peak = float(np.max(np.abs(m))) if m.size else 0.0
    rms = float(np.sqrt(np.mean(m ** 2))) if m.size else 0.0
    lu = integrated_lufs(m, sr)
    out = {
        "sr": int(sr), "duration_s": round(dur, 3), "peak_db": round(db(peak), 2),
        "true_peak_db": round(true_peak_db(m, sr), 2), "rms_db": round(db(rms), 2),
        "lufs": None if lu is None else round(lu, 2),
        "clipped_samples": int(np.sum(np.abs(m) >= CLIP_AT)),
        "dc_offset": round(float(np.mean(m)) if m.size else 0.0, 6),
        "nonfinite_samples": bad,
    }
    out.update(silence_profile(m, sr))
    if spoken is not None and dur > 0:
        out["words_per_s"] = round(len(spoken.split()) / dur, 2)
    return out


# ----------------------------------------------------------------------------- text and alignment

_DIGIT_WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
_NATO = {"alpha": "a", "alfa": "a", "bravo": "b", "charlie": "c", "delta": "d", "echo": "e", "foxtrot": "f",
         "golf": "g", "hotel": "h", "india": "i", "juliet": "j", "juliett": "j", "kilo": "k", "lima": "l",
         "mike": "m", "november": "n", "oscar": "o", "papa": "p", "quebec": "q", "romeo": "r", "sierra": "s",
         "tango": "t", "uniform": "u", "victor": "v", "whiskey": "w", "xray": "x", "yankee": "y", "zulu": "z"}

_normalizer = None


def get_normalizer():
    """Whisper's English text normaliser, with its spelling table from the cached tokenizer."""
    global _normalizer
    if _normalizer is None:
        try:
            from transformers import WhisperTokenizer

            tok = WhisperTokenizer.from_pretrained("openai/whisper-small", local_files_only=True)
            _normalizer = tok.normalize
        except Exception:
            from transformers.models.whisper.english_normalizer import EnglishTextNormalizer

            _normalizer = EnglishTextNormalizer({})
    return _normalizer


def _pre(text: str, names: list[str]) -> str:
    t = text.replace("’", "'")
    for nm in names:  # the normaliser turns "Drover's" into "drover is": keep possessive names whole
        if nm.lower().endswith("'s"):
            t = re.sub(re.escape(nm[:-2]) + r"'s\b", nm[:-2] + "s", t, flags=re.I)
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)
    t = re.sub(r"\bm\s*/\s*s\b", " metres per second ", t, flags=re.I)
    t = t.replace("%", " percent ")
    t = re.sub(r"\bniner\b", "nine", t, flags=re.I)
    t = re.sub(r"\bdecimal\b", "point", t, flags=re.I)

    def spell(m: re.Match) -> str:
        return " " + " ".join("point" if c == "." else _DIGIT_WORD[int(c)] for c in m.group(0)) + " "

    return re.sub(r"\d+(?:\.\d+)?", spell, t)


def _name_key(nm: str) -> str:
    return nm[:-2] + "s" if nm.lower().endswith("'s") else nm


def normalise_tokens(text: str, names: list[str] | None = None, normalizer=None) -> list[str]:
    """Words of a text in the common form used for comparing speech (see the module text)."""
    norm = normalizer or get_normalizer()
    toks: list[str] = []
    for w in norm(_pre(text, names or [])).split():
        for part in re.findall(r"\d+(?:\.\d+)?|\D+", w):
            if part[0].isdigit():
                toks.extend("point" if c == "." else c for c in part)
            elif part == "%":
                toks.append("percent")
            else:
                toks.append(part)
    return [t for t in toks if t.strip()]


def _nato_fold(ref: list[str], hyp: list[str]) -> tuple[list[str], list[str]]:
    """Make "Alpha Kilo" and "AK" the same tokens: spoken letters become single letters, and a
    letter group written as one token ("ak") is split where the reference spells it with NATO words."""
    groups: set[str] = set()
    run: list[str] = []
    for t in ref + [""]:
        if t in _NATO:
            run.append(_NATO[t])
        else:
            if len(run) > 1:
                groups.add("".join(run))
            run = []
    r = [_NATO.get(t, t) for t in ref]
    h: list[str] = []
    for t in (_NATO.get(t, t) for t in hyp):
        h.extend(list(t) if t in groups else [t])
    return r, h


def align(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Edit-distance alignment. Ops: ('eq'|'sub', i, j), ('del', i, None), ('ins', None, j).
    Ties prefer the diagonal, so a wrong word is a substitution, not a deletion plus insertion."""
    n, m = len(ref), len(hyp)
    d = np.zeros((n + 1, m + 1), dtype=np.int32)
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (ref[i - 1] != hyp[j - 1]))
    ops: list[tuple[str, int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i, j] == d[i - 1, j - 1] + (ref[i - 1] != hyp[j - 1]):
            ops.append(("eq" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and d[i, j] == d[i - 1, j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    ops.reverse()
    return ops


def name_positions(ref: list[str], names: list[str], normalizer=None) -> dict[int, int]:
    """Reference token index -> index of the name it belongs to (a name may be several tokens)."""
    pos: dict[int, int] = {}
    for k, nm in enumerate(names):
        nt = normalise_tokens(_name_key(nm), None, normalizer)
        for s in range(len(ref) - len(nt) + 1):
            if nt and ref[s: s + len(nt)] == nt and not any((s + q) in pos for q in range(len(nt))):
                for q in range(len(nt)):
                    pos[s + q] = k
    return pos


def score_text(reference: str, hypothesis: str, names: list[str] | None = None, normalizer=None) -> dict:
    """Word errors of one line, ordinary words and invented names counted apart."""
    names = names or []
    ref = normalise_tokens(reference, names, normalizer)
    hyp = normalise_tokens(hypothesis, names, normalizer)
    ref, hyp = _nato_fold(ref, hyp)
    npos = name_positions(ref, names, normalizer)
    ops = align(ref, hyp)
    runs: list[list[tuple]] = []  # error runs: consecutive non-equal ops
    cur: list[tuple] = []
    for op in ops:
        if op[0] == "eq":
            if cur:
                runs.append(cur)
                cur = []
        else:
            cur.append(op)
    if cur:
        runs.append(cur)
    ordinary = {"sub": 0, "del": 0, "ins": 0}
    present = sorted(set(npos.values()))
    hit = {k: True for k in present}
    heard: dict[int, list[str]] = {k: [] for k in present}
    for run in runs:
        touched = sorted({npos[o[1]] for o in run if o[1] is not None and o[1] in npos})
        if touched:  # a run that touches a name belongs to the name
            for k in touched:
                hit[k] = False
            heard[touched[0]].extend(hyp[o[2]] for o in run if o[2] is not None)
            others = [o for o in run if o[1] is None or o[1] not in npos]
            # the ordinary words inside such a run that sit on no name and no insertion are still errors
            for o in others:
                if o[0] != "ins":
                    ordinary[o[0]] += 1
        else:
            for o in run:
                ordinary[o[0]] += 1
    ordinary_words = len(ref) - len(npos)
    errs = sum(ordinary.values())
    return {
        "ref_words": len(ref), "ordinary_words": ordinary_words,
        "ordinary_errors": errs, "substitutions": ordinary["sub"], "deletions": ordinary["del"],
        "insertions": ordinary["ins"],
        "wer": round(errs / ordinary_words, 4) if ordinary_words else (0.0 if not errs else 1.0),
        "names_total": len(names), "names_in_reference": len(present),
        "names_hit": sum(1 for k in present if hit[k]),
        "names_missed": [{"name": names[k], "heard": " ".join(heard[k]) or None} for k in present if not hit[k]],
        "ref_tokens": " ".join(ref), "hyp_tokens": " ".join(hyp),
    }


# ----------------------------------------------------------------------------- Whisper

def load_whisper(prefer: str | None = None):
    """Whisper small from the local cache (via tools/audio/listen/transcribe.py): on the graphics
    card when it has 3 GB free, else on the processor."""
    sys.path.insert(0, str(AUDIO_TOOLS / "listen"))
    try:
        import transcribe
    finally:
        sys.path.remove(str(AUDIO_TOOLS / "listen"))
    import torch

    dev = prefer
    if dev is None:
        dev = "cpu"
        try:
            if torch.cuda.is_available() and torch.cuda.mem_get_info()[0] > 3 * 1024 ** 3:
                dev = "cuda"
        except Exception:
            pass
    return transcribe.Whisper(dev)


# ----------------------------------------------------------------------------- listening copies

def resample_to(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return np.asarray(x, dtype=np.float64)
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(int(sr_in), int(sr_out))
    return resample_poly(np.asarray(x, dtype=np.float64), sr_out // g, sr_in // g)


def fade_edges(x: np.ndarray, sr: int, fade_s: float = FADE_S) -> np.ndarray:
    """Raised-cosine fade in and out; the first and last sample become exactly zero."""
    n = min(int(round(fade_s * sr)), x.size // 2)
    y = np.array(x, dtype=np.float64)
    if n > 0:
        ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
        y[:n] *= ramp
        y[-n:] *= ramp[::-1]
    return y


def match_loudness(x: np.ndarray, sr: int, target_lufs: float = LISTEN_LUFS, tp_db: float = LISTEN_TP_DB):
    """Gain to the target integrated loudness; if the true peak would pass tp_db the gain is cut."""
    lu = integrated_lufs(x, sr)
    if lu is None:
        return np.asarray(x, dtype=np.float64), {"gain_db": 0.0, "limited": False, "lufs_in": None}
    gain = target_lufs - lu
    y = x * 10 ** (gain / 20)
    tp = true_peak_db(y, sr)
    limited = False
    if tp > tp_db:
        gain -= tp - tp_db
        y = x * 10 ** (gain / 20)
        limited = True
    return y, {"gain_db": round(gain, 2), "limited": limited, "lufs_in": round(lu, 2)}


def _r(v, n=2):
    return None if v is None else round(float(v), n)


def make_listen_copy(x, sr: int, radio: bool, radio_filter=None) -> dict:
    """Samples as read from a model file in; {'dry', 'wet' (None unless radio), 'info'} out, at 48 kHz mono."""
    m = to_mono(np.nan_to_num(np.asarray(x, dtype=np.float64)))
    y, info = match_loudness(resample_to(m, sr, LISTEN_SR), LISTEN_SR)
    out = {"dry": fade_edges(y, LISTEN_SR), "wet": None, "info": info}
    if radio:
        w = np.asarray(radio_filter(y, LISTEN_SR), dtype=np.float64)
        tp = true_peak_db(w, LISTEN_SR)
        if tp > LISTEN_TP_DB:  # overdrive and noise can lift the peak: gain only
            w = w * 10 ** ((LISTEN_TP_DB - tp) / 20)
            info["radio_peak_guard_db"] = round(LISTEN_TP_DB - tp, 2)
        out["wet"] = fade_edges(w, LISTEN_SR)
    final = out["wet"] if out["wet"] is not None else out["dry"]
    info["lufs_out"] = _r(integrated_lufs(final, LISTEN_SR))
    info["true_peak_out_db"] = round(true_peak_db(final, LISTEN_SR), 2)
    return out


def best_device(model_dir: Path) -> str | None:
    for dev in ("cuda", "cpu"):
        if (model_dir / dev / "timing.json").exists():
            return dev
    return None


def write_listen(models: list[str], lines: list[dict], out_dir: Path, root: Path = VOICE) -> dict:
    import soundfile as sf

    sys.path.insert(0, str(AUDIO_TOOLS / "synth"))
    try:
        from radio import radio_filter  # tools/audio/synth/radio.py (numpy and scipy only)
    finally:
        sys.path.remove(str(AUDIO_TOOLS / "synth"))
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {}
    for ln in lines:
        if not ln.get("listen"):
            continue
        for model in models:
            dev = best_device(root / model)
            wav = root / model / dev / (ln["id"] + ".wav") if dev else None
            if not wav or not wav.exists():
                continue
            x, sr = sf.read(str(wav), dtype="float64", always_2d=False)
            radio = ln.get("role") == "radio"
            res = make_listen_copy(x, sr, radio, radio_filter)
            stem = "%s__%s" % (model, ln["id"])
            if radio:
                sf.write(str(out_dir / (stem + ".wav")), res["wet"], LISTEN_SR, subtype="PCM_24")
                sf.write(str(out_dir / (stem + "__dry.wav")), res["dry"], LISTEN_SR, subtype="PCM_24")
            else:
                sf.write(str(out_dir / (stem + ".wav")), res["dry"], LISTEN_SR, subtype="PCM_24")
            res["info"].update({"device": dev, "radio": radio})
            report[stem] = res["info"]
    return report


# ----------------------------------------------------------------------------- the run

def _median(v):
    v = [a for a in v if a is not None]
    return round(float(np.median(v)), 3) if v else None


def summarise(rec: dict) -> dict:
    ls = rec["lines"]
    words = {k: l["words"] for k, l in ls.items() if l.get("words")}
    wers = [w["wer"] for w in words.values()]
    bad = [{"line": k, "reference": w["ref_tokens"], "hypothesis": w["hyp_tokens"], "ordinary_errors": w["ordinary_errors"]}
           for k, w in words.items() if w["ordinary_errors"]]
    n_all = sum(w["names_in_reference"] for w in words.values())
    n_hit = sum(w["names_hit"] for w in words.values())
    lev = {k: l["level"] for k, l in ls.items() if l.get("level")}
    t = rec.get("timing") or {}
    tl = list((t.get("lines") or {}).values())
    return {
        "lines_scored": len(wers), "wer_median": _median(wers), "wer_worst": round(max(wers), 4) if wers else None,
        "lines_with_ordinary_errors": bad,
        "name_hit_rate": round(n_hit / n_all, 3) if n_all else None, "names_hit": n_hit, "names_total": n_all,
        "rms_db_median": _median([v["rms_db"] for v in lev.values()]),
        "clipped_lines": [k for k, v in lev.items() if v["clipped_samples"]],
        "lines_with_long_inner_silence": [k for k, v in lev.items() if v["longest_inside_s"] > LONG_SILENCE_S],
        "timing": {
            "rtf_median": t.get("rtf_median"), "load_s": t.get("load_s"), "threads": t.get("threads"),
            "first_audio_s_median": _median([l.get("first_audio_s") for l in tl]),
            "all_scalars": {k: v for k, v in t.items() if isinstance(v, (int, float, str)) or v is None},
        },
    }


def run(models_filter: list[str] | None, use_whisper: bool, root: Path = VOICE, lines_path: Path | None = None,
        whisper=None) -> dict:
    import soundfile as sf

    lines = json.loads((lines_path or HERE / "lines.json").read_text(encoding="utf-8"))["lines"]
    models = sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))) if root.exists() else []
    if models_filter:
        models = [m for m in models if m in models_filter]
    todo = [(m, d) for m in models for d in sorted(p.name for p in (root / m).iterdir()
                                                   if p.is_dir() and (p / "timing.json").exists())]
    if use_whisper and todo and whisper is None:
        whisper = load_whisper()
    result: dict = {"models": {}, "whisper": None}
    if use_whisper and whisper is not None:
        result["whisper"] = {"model": "openai/whisper-small", "device": whisper.device, "load_s": whisper.load_seconds}
    for m, d in todo:
        folder = root / m / d
        try:
            timing = json.loads((folder / "timing.json").read_text(encoding="utf-8"))
        except Exception as e:  # a broken timing file must not stop the other models
            timing = {"error": "%s: %s" % (type(e).__name__, e)}
        rec: dict = {"timing": timing, "lines": {}, "missing_lines": []}
        for ln in lines:
            wav = folder / (ln["id"] + ".wav")
            if not wav.exists():
                rec["missing_lines"].append(ln["id"])
                continue
            ref_text = ln["text"] if ln.get("raw") else ln["spoken"]
            entry: dict = {"file": str(wav)}
            try:
                x, sr = sf.read(str(wav), dtype="float64", always_2d=False)
                entry["level"] = level_report(x, sr, ref_text)
                if use_whisper and whisper is not None:
                    hyp = whisper.transcribe(np.nan_to_num(to_mono(x)).astype(np.float32), sr)
                    entry["hypothesis"] = hyp
                    entry["words"] = score_text(ref_text, hyp, ln.get("names", []))
            except Exception as e:
                entry["error"] = "%s: %s" % (type(e).__name__, e)
            rec["lines"][ln["id"]] = entry
        rec["summary"] = summarise(rec)
        result["models"].setdefault(m, {})[d] = rec
    return result


def print_table(result: dict) -> None:
    rows = [("model", "device", "lines", "WERmed", "WERmax", "names", "RTF", "load s", "1st s", "RMS dB", "clip", "gap>0.8")]

    def f(v, n=2):
        return "-" if v is None else ("%.*f" % (n, v) if isinstance(v, float) else str(v))

    for m, devs in result["models"].items():
        for d, rec in devs.items():
            s, t = rec["summary"], rec["summary"]["timing"]
            rows.append((m, d, "%d/%d" % (len(rec["lines"]), len(rec["lines"]) + len(rec["missing_lines"])),
                         f(s["wer_median"], 3), f(s["wer_worst"], 3),
                         "-" if s["name_hit_rate"] is None else "%d/%d" % (s["names_hit"], s["names_total"]),
                         f(t["rtf_median"], 3), f(t["load_s"], 1), f(t["first_audio_s_median"], 2),
                         f(s["rms_db_median"], 1), str(len(s["clipped_lines"])), str(len(s["lines_with_long_inner_silence"]))))
    if len(rows) == 1:
        print("no model directory with a timing.json under", VOICE)
        return
    w = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(r)))
    for m, devs in result["models"].items():
        for d, rec in devs.items():
            for b in rec["summary"]["lines_with_ordinary_errors"]:
                print("  %s/%s %s\n    ref: %s\n    hyp: %s" % (m, d, b["line"], b["reference"], b["hypothesis"]))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--models", help="comma separated model keys (default: all under assets/audio/voice)")
    ap.add_argument("--no-whisper", action="store_true", help="level and shape only")
    ap.add_argument("--listen", action="store_true", help="also make the listening copies in _listen/")
    ap.add_argument("--root", default=str(VOICE), help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    root = Path(a.root)
    flt = [s.strip() for s in a.models.split(",") if s.strip()] if a.models else None
    t0 = time.time()
    result = run(flt, not a.no_whisper, root)
    out = root / "scores.json"
    merged: dict = {"models": {}}
    if out.exists():
        try:
            merged = json.loads(out.read_text(encoding="utf-8"))
        except Exception:
            merged = {"models": {}}
    merged.setdefault("models", {}).update(result["models"])
    if result["whisper"]:
        merged["whisper"] = result["whisper"]
    merged["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    merged["settings"] = {"silence_db": SILENCE_DB, "window_s": WINDOW_S, "clip_at": CLIP_AT, "long_silence_s": LONG_SILENCE_S}
    if a.listen:
        lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))["lines"]
        mods = sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))) if root.exists() else []
        if flt:
            mods = [m for m in mods if m in flt]
        merged.setdefault("listen", {}).update(write_listen(mods, lines, root / "_listen", root))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print_table(result)
    print("wrote %s (%.1f s)" % (out, time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
