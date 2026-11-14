"""Measure sound files: levels, loudness, spectrum, envelope, loop seam, optional spectrogram PNG.

    python tools/audio/listen/measure.py a.wav b.wav [--json] [--png DIR] [--loop]

Every number is computed from the file alone; nothing here needs a model or the GPU.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

FLOOR_DB = -120.0
BAND_EDGES = [0, 60, 125, 250, 500, 1000, 2000, 4000, 8000, None]
BAND_NAMES = ["<60", "60-125", "125-250", "250-500", "500-1k", "1k-2k", "2k-4k", "4k-8k", ">8k"]
CLIP_LEVEL = 0.9999
ENV_CHARS = " .:-=+*#%@"


def amp_db(a: float) -> float:
    """Amplitude to dB with a floor so that silence stays a finite number."""
    return float(max(FLOOR_DB, 20 * np.log10(a))) if a > 0 else FLOOR_DB


def pow_db(p: float) -> float:
    return float(max(FLOOR_DB, 10 * np.log10(p))) if p > 0 else FLOOR_DB


def true_peak(data: np.ndarray) -> float:
    """Peak of the 4x oversampled signal (the inter-sample peak a DAC would reconstruct)."""
    from scipy.signal import resample_poly

    return float(np.max(np.abs(resample_poly(data, 4, 1, axis=0))))


def loudness_lufs(data: np.ndarray, sr: int):
    """Integrated loudness per ITU-R BS.1770-4 (K-weighting, 400 ms blocks, two gates)."""
    import pyloudnorm as pyln

    note = None
    x = data.astype(np.float64)
    min_len = int(0.4 * sr) + 1
    if x.shape[0] < min_len:
        # The standard needs one full 400 ms block; a shorter clip is repeated to fill it.
        x = np.tile(x, (int(np.ceil(min_len / x.shape[0])), 1))[:min_len]
        note = "clip shorter than 400 ms was repeated to one block"
    if x.shape[1] > 5:
        x = x[:, :5]
    val = pyln.Meter(sr).integrated_loudness(x)
    if not np.isfinite(val):
        return None, note or "silent or fully gated"
    return float(val), note


def mean_psd(data: np.ndarray, sr: int):
    """Welch power spectrum averaged over channels, mean removed so DC does not skew the shares."""
    from scipy.signal import welch

    x = data - data.mean(axis=0, keepdims=True)
    nper = int(min(8192, x.shape[0]))
    f, p = welch(x, fs=sr, nperseg=nper, window="hann", axis=0, scaling="spectrum")
    return f, p.mean(axis=1)


def band_shares(f: np.ndarray, p: np.ndarray) -> dict:
    total = p.sum()
    out = {}
    for i, name in enumerate(BAND_NAMES):
        lo = BAND_EDGES[i]
        hi = BAND_EDGES[i + 1]
        sel = (f >= lo) & (f < (hi if hi is not None else np.inf))
        out[name] = float(p[sel].sum() / total) if total > 0 else 0.0
    return out


def spectral_peaks(f: np.ndarray, p: np.ndarray, count: int = 6):
    """Strongest spectral peaks and a fundamental estimate (None for noise-like material)."""
    from scipy.signal import find_peaks

    sel = f >= 20
    f, p = f[sel], p[sel]
    if p.size < 5 or p.max() <= 0:
        return [], None
    pdb = 10 * np.log10(np.maximum(p, 1e-20))
    idx, _ = find_peaks(pdb, prominence=10)
    if idx.size:
        idx = idx[pdb[idx] >= pdb[idx].max() - 60]  # window leakage and rounding noise are not peaks
    if idx.size == 0:
        return [], None
    order = idx[np.argsort(pdb[idx])[::-1]][:count]
    top = pdb[order[0]]

    def refined(i):  # parabolic interpolation: better than the 6 Hz bin spacing
        if 0 < i < len(f) - 1:
            a, b, c = pdb[i - 1], pdb[i], pdb[i + 1]
            den = a - 2 * b + c
            if den < 0:
                return float(f[i] + 0.5 * (a - c) / den * (f[1] - f[0]))
        return float(f[i])

    peaks = [{"hz": round(refined(i), 1), "db": round(float(pdb[i] - top), 1)} for i in order]
    if top - np.median(pdb) < 15:
        return peaks, None
    pmax = p.max()
    best, best_score = None, -1.0
    cands = sorted([i for i in order if pdb[i] >= top - 30], key=lambda i: f[i])
    for i in cands:
        f0 = refined(i)
        score = 0.0
        for k in range(1, 7):
            fk = k * f0
            if fk >= f[-1]:
                break
            win = (f > fk * 0.97) & (f < fk * 1.03)
            if win.any():
                score += p[win].max() / pmax
        if score > best_score * 1.05:  # near-ties go to the lower candidate
            best, best_score = f0, score
    return peaks, (round(float(best), 1) if best is not None else None)


def envelope(data: np.ndarray, sr: int) -> dict:
    mono_pow = (data.astype(np.float64) ** 2).mean(axis=1)
    n = mono_pow.shape[0]
    frame = max(1, int(round(sr * 0.010)))
    nfr = max(1, n // frame)
    fr = mono_pow[: nfr * frame].reshape(nfr, frame).mean(axis=1) if n >= frame else np.array([mono_pow.mean()])
    lvl = np.array([pow_db(v) for v in fr])
    peak_frame = int(np.argmax(lvl))
    peak_lvl = float(lvl[peak_frame])

    # Sample-level onset and attack from a 1 ms peak-hold envelope.
    a = np.abs(data).max(axis=1)
    peak_amp = float(a.max()) if a.size else 0.0
    onset_ms = attack_ms = None
    if peak_amp > 0:
        thr = max(peak_amp * 10 ** (-40 / 20), 10 ** (-70 / 20))
        above = np.nonzero(a >= thr)[0]
        if above.size:
            onset_ms = float(above[0] / sr * 1000)
        blk = max(1, int(sr * 0.001))
        nb = a.shape[0] // blk
        if nb >= 2:
            pk = a[: nb * blk].reshape(nb, blk).max(axis=1)
            lo = np.nonzero(pk >= 0.1 * peak_amp)[0]
            hi = np.nonzero(pk >= 0.9 * peak_amp)[0]
            if lo.size and hi.size:
                attack_ms = float(max(0, hi[0] - lo[0]))  # resolution 1 ms

    fall = None
    below = np.nonzero(lvl[peak_frame:] <= peak_lvl - 60)[0]
    if below.size:
        fall = float(below[0] * 10)  # ms after the loudest 10 ms frame

    last_n = min(n, frame)
    last_level = pow_db(float((data[-last_n:].astype(np.float64) ** 2).mean()))

    width = 80
    group = int(np.ceil(lvl.size / width))
    cols = [lvl[i : i + group].max() for i in range(0, lvl.size, group)]
    chars = []
    for v in cols:
        rel = v - peak_lvl  # 0 at the loudest frame
        if rel > -45:
            k = int(np.clip(np.floor((rel + 45) / 5) + 1, 1, len(ENV_CHARS) - 1))
        else:
            k = 0
        chars.append(ENV_CHARS[k])
    return {
        "onsetMs": None if onset_ms is None else round(onset_ms, 2),
        "attackMs": attack_ms,
        "fall60Ms": fall,
        "lastTenMsDb": round(last_level, 1),
        "peakFrameMs": peak_frame * 10,
        "printed": "".join(chars),
        "printedMsPerChar": group * 10,
        "frameDb": [round(float(v), 1) for v in lvl] if lvl.size <= 3000 else None,
    }


def _seg_bands(seg: np.ndarray, sr: int):
    x = seg - seg.mean(axis=0, keepdims=True)
    w = np.hanning(x.shape[0])[:, None]
    spec = (np.abs(np.fft.rfft(x * w, axis=0)) ** 2).mean(axis=1)
    f = np.fft.rfftfreq(x.shape[0], 1 / sr)
    tot = spec.sum()
    out = []
    for i in range(len(BAND_NAMES)):
        lo, hi = BAND_EDGES[i], BAND_EDGES[i + 1]
        sel = (f >= lo) & (f < (hi if hi is not None else np.inf))
        out.append(float(spec[sel].sum()))
    cen = float((f * spec).sum() / tot) if tot > 0 else 0.0
    return np.array(out), cen


def loop_check(data: np.ndarray, sr: int) -> dict:
    n = data.shape[0]
    x = data.astype(np.float64)
    if n < 8:
        return {"error": "too short for a seam check"}
    # Value step across the wrap against the 99th percentile of ordinary steps; the second
    # difference catches a kink (slope flips) where the value itself happens to match.
    d1 = np.abs(np.diff(x, axis=0))
    d2 = np.abs(x[2:] - 2 * x[1:-1] + x[:-2])
    step = np.abs(x[0] - x[-1]).max()
    kink = max(np.abs(x[0] - 2 * x[-1] + x[-2]).max(), np.abs(x[1] - 2 * x[0] + x[-1]).max())
    p1 = max(float(np.percentile(d1, 99)), 1e-9)
    p2 = max(float(np.percentile(d2, 99)), 1e-9)
    step_ratio = float(step / p1)
    kink_ratio = float(kink / p2)
    seam_ratio = max(step_ratio, kink_ratio)

    seg = int(sr * 0.050)
    out = {
        "stepRatio": round(step_ratio, 2),
        "kinkRatio": round(kink_ratio, 2),
        "seamRatio": round(seam_ratio, 2),
    }
    level_diff = None
    if n >= 2 * seg:
        a, b = x[:seg], x[-seg:]
        la = pow_db(float((a**2).mean()))
        lb = pow_db(float((b**2).mean()))
        level_diff = abs(la - lb)
        ba, ca = _seg_bands(a, sr)
        bb, cb = _seg_bands(b, sr)
        diffs = []
        for i in range(len(BAND_NAMES)):
            # only bands that matter at one end (above -40 dB of that end's total)
            if ba[i] > ba.sum() * 1e-4 or bb[i] > bb.sum() * 1e-4:
                diffs.append(abs(pow_db(ba[i]) - pow_db(bb[i])))
        out.update(
            {
                "edgeLevelDb": [round(la, 1), round(lb, 1)],
                "edgeLevelDiffDb": round(level_diff, 2),
                "edgeBandDiffDb": round(max(diffs), 1) if diffs else 0.0,
                "edgeCentroidHz": [round(ca), round(cb)],
            }
        )
    # Level swing over the loop: 100 ms RMS windows, hop 50 ms.
    win, hop = int(sr * 0.100), int(sr * 0.050)
    if n >= win * 2:
        levs = [pow_db(float((x[i : i + win] ** 2).mean())) for i in range(0, n - win + 1, hop)]
        levs = [v for v in levs if v > -90]
        out["levelSwingDb"] = round(max(levs) - min(levs), 1) if levs else 0.0
    out["seamOk"] = bool(seam_ratio <= 2.0)
    out["edgeOk"] = bool(level_diff is None or level_diff <= 3.0)
    out["pass"] = out["seamOk"] and out["edgeOk"]
    return out


def analyse(data: np.ndarray, sr: int, loop: bool = False) -> dict:
    n, ch = data.shape
    peak = float(np.abs(data).max()) if data.size else 0.0
    tp = true_peak(data)
    rms = float(np.sqrt((data.astype(np.float64) ** 2).mean())) if data.size else 0.0
    lufs, lufs_note = loudness_lufs(data, sr)
    f, p = mean_psd(data, sr)
    tot = p.sum()
    centroid = float((f * p).sum() / tot) if tot > 0 else None
    shares = band_shares(f, p)
    peaks, f0 = spectral_peaks(f, p)
    res = {
        "sampleRate": sr,
        "channels": ch,
        "durationS": round(n / sr, 4),
        "samplePeakDb": round(amp_db(peak), 2),
        "truePeakDb": round(amp_db(tp), 2),
        "clippedSamples": int((np.abs(data) >= CLIP_LEVEL).sum()),
        "dcOffset": round(float(np.abs(data.mean(axis=0)).max()), 6),
        "rmsDb": round(amp_db(rms), 2),
        "crestDb": round(amp_db(peak) - amp_db(rms), 2) if rms > 0 else None,
        "lufs": None if lufs is None else round(lufs, 2),
        "spectralCentroidHz": None if centroid is None else round(centroid, 1),
        "bands": {k: round(v, 4) for k, v in shares.items()},
        "lowShare": round(sum(shares[k] for k in BAND_NAMES[:4]), 4),
        "highShare": round(sum(shares[k] for k in BAND_NAMES[7:]), 4),
        "peaks": peaks,
        "fundamentalHz": f0,
        "envelope": envelope(data, sr),
    }
    if lufs_note:
        res["lufsNote"] = lufs_note
    if loop:
        res["loop"] = loop_check(data, sr)
    return res


def spectrogram_db(data: np.ndarray, sr: int, n_fft: int = 4096, hop: int = 512):
    """STFT magnitude in dB re full scale (a full-scale sine reads 0 dB)."""
    x = common.to_mono(data).astype(np.float64)
    if x.size < n_fft:
        x = np.pad(x, (0, n_fft - x.size))
    win = np.hanning(n_fft)
    nfr = 1 + (x.size - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nfr)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * win, axis=1)) * 2 / win.sum()
    return np.fft.rfftfreq(n_fft, 1 / sr), (np.arange(nfr) * hop + n_fft / 2) / sr, 20 * np.log10(np.maximum(spec, 1e-9)).T


def write_png(path: Path, name: str, data: np.ndarray, sr: int, res: dict) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    f, t, s = spectrogram_db(data, sr)
    keep = f >= 20
    if t.size > 1500:  # max-pool columns so that long files stay cheap to draw
        k = int(np.ceil(t.size / 1500))
        m = (t.size // k) * k
        s = s[:, :m].reshape(s.shape[0], -1, k).max(axis=2)
        t = t[:m].reshape(-1, k).mean(axis=1)
    dur = data.shape[0] / sr
    fig, (a0, a1) = plt.subplots(2, 1, figsize=(10, 6), height_ratios=[1, 3], sharex=True, constrained_layout=True)
    tt = np.arange(data.shape[0]) / sr
    step = max(1, data.shape[0] // 20000)  # envelope-preserving decimation
    for c in range(data.shape[1]):
        ch = data[:, c]
        if step > 1:
            m = (ch.size // step) * step
            blocks = ch[:m].reshape(-1, step)
            a0.fill_between(tt[:m:step], blocks.min(axis=1), blocks.max(axis=1), lw=0.5, color="#1b4f8a", alpha=0.9)
        else:
            a0.plot(tt, ch, lw=0.6, color="#1b4f8a", alpha=0.9)
    a0.set_ylim(-1, 1)
    a0.set_ylabel("amplitude")
    a0.grid(alpha=0.3)
    mesh = a1.pcolormesh(t, f[keep], s[keep], vmin=-90, vmax=0, cmap="magma", shading="auto")
    a1.set_yscale("log")
    a1.set_ylim(20, 20000)
    a1.set_xlim(0, dur)
    a1.set_yticks([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
    a1.set_yticklabels(["20", "50", "100", "200", "500", "1k", "2k", "5k", "10k", "20k"])
    a1.set_xlabel("time (s)")
    a1.set_ylabel("frequency (Hz)")
    fig.colorbar(mesh, ax=a1, label="dB re full scale", pad=0.01)
    lufs = res["lufs"]
    lufs_txt = "-" if lufs is None else "%.1f" % lufs
    fig.suptitle(
        "%s  %d Hz  %d ch  %.2f s  peak %.1f / true %.1f dBFS  %s LUFS  centroid %.0f Hz"
        % (name, sr, res["channels"], res["durationS"], res["samplePeakDb"], res["truePeakDb"], lufs_txt,
           res["spectralCentroidHz"] or 0),
        fontsize=9,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=100)
    plt.close(fig)


def _fmt(v, unit=""):
    return "n/a" if v is None else "%g%s" % (v, unit)


def format_text(name: str, r: dict) -> str:
    e = r["envelope"]
    lines = [
        name,
        "  %d Hz, %d ch, %.3f s" % (r["sampleRate"], r["channels"], r["durationS"]),
        "  peak %s dBFS, true peak %s dBFS, clipped %d, DC %s, RMS %s dBFS, crest %s, LUFS %s"
        % (r["samplePeakDb"], r["truePeakDb"], r["clippedSamples"], r["dcOffset"], r["rmsDb"],
           _fmt(r["crestDb"], " dB"), _fmt(r["lufs"])),
        "  centroid %s, fundamental %s, low(<500) %.1f%%, high(>4k) %.1f%%"
        % (_fmt(r["spectralCentroidHz"], " Hz"), _fmt(r["fundamentalHz"], " Hz"), r["lowShare"] * 100, r["highShare"] * 100),
        "  bands " + "  ".join("%s:%.1f%%" % (k, v * 100) for k, v in r["bands"].items()),
        "  peaks " + (", ".join("%g Hz (%+.0f dB)" % (p["hz"], p["db"]) for p in r["peaks"]) or "none"),
        "  onset %s, attack %s, fall60 %s, last10ms %s dBFS"
        % (_fmt(e["onsetMs"], " ms"), _fmt(e["attackMs"], " ms"), _fmt(e["fall60Ms"], " ms"), e["lastTenMsDb"]),
        "  env [%s] %d ms/char" % (e["printed"], e["printedMsPerChar"]),
    ]
    if "lufsNote" in r:
        lines.append("  note: " + r["lufsNote"])
    if "loop" in r:
        l = r["loop"]
        if "error" in l:
            lines.append("  loop: " + l["error"])
        else:
            lines.append(
                "  loop: %s seamRatio %s (step %s, kink %s), edge level diff %s dB, edge band diff %s dB, swing %s dB"
                % ("PASS" if l["pass"] else "FAIL", l["seamRatio"], l["stepRatio"], l["kinkRatio"],
                   l.get("edgeLevelDiffDb", "n/a"), l.get("edgeBandDiffDb", "n/a"), l.get("levelSwingDb", "n/a"))
            )
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--png", metavar="DIR", help="write a waveform + spectrogram picture per file into DIR")
    ap.add_argument("--loop", action="store_true", help="add the loop seam check")
    args = ap.parse_args(argv)

    results, texts, failed = {}, [], 0
    for fn in args.files:
        try:
            data, sr = common.load_audio(fn)
            r = analyse(data, sr, loop=args.loop)
            if args.png:
                write_png(Path(args.png) / (Path(fn).stem + ".png"), Path(fn).name, data, sr, r)
            results[fn] = r
            texts.append(format_text(fn, r))
        except Exception as exc:  # one bad file must not hide the others
            failed += 1
            results[fn] = {"error": "%s: %s" % (type(exc).__name__, exc)}
            texts.append("%s\n  ERROR %s: %s" % (fn, type(exc).__name__, exc))
    common.dump(results, args.json, "\n".join(texts))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
