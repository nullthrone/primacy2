"""Re-time a voice adapter several times, with the outside load noted, and put every audio file back.

Timings on this machine are not one number: the graphics card is shared with the owner's desktop
programs (about half busy when idle) and other agents load the processor. So a model is timed
several times, and for every run the load from outside is written down just before it starts.

    <python> tools/voice/retime.py once   --id ID --key K --device D --threads N -- <adapter command>
    <python> tools/voice/retime.py drive  [--repeats 3] [--only key,key]   (loops over RUNS, one lock per run)
    <python> tools/voice/retime.py collect                                  (writes assets/audio/voice/retime.json)

`once` is meant to run under the lock (tools/voice/with_lock.py); `drive` does that for every run
and releases the lock between runs. `once` copies assets/audio/voice/<key> to a scratch folder, measures
the load, runs the adapter, measures again, keeps the run's timing record under
assets/audio/voice/_retime_runs/, then puts the copy back and compares SHA-256 of every file, so
that the scored audio and timing files stay byte-identical.

Load before a run: graphics card from `nvidia-smi --query-gpu=utilization.gpu,memory.used`, processor
from three one-second samples of the kernel counters (GetSystemTimes: the same quantity as the
'% Processor Time' counter, but independent of the Windows language).
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VOICE = ROOT / "assets" / "audio" / "voice"
RUNS_DIR = VOICE / "_retime_runs"
AUDIT_DIR = VOICE / "_audit" / "retime"
LISTEN = "computer_fold,procedural_convoy,radio_clearance,station_dock"
SCRATCH = Path(os.environ.get("RETIME_SCRATCH", str(Path(tempfile.gettempdir()) / "voice-retime")))


def py(key: str) -> str:
    env = {"phonon-q8": "phonon", "phonon-blend": "phonon", "kitten-blend": "kitten", "chatterbox-nano-8t": "chatterbox-nano"}.get(key, key)
    return str(ROOT / ".venv-voice" / env / "Scripts" / "python.exe")


def adapter(name: str) -> str:
    return str(HERE / "adapters" / (name + ".py"))


# the planned runs: (key = model directory, device, threads, adapter arguments after the adapter path)
RUNS = [
    ("qwen3", "cuda", None, "qwen3", ["--device", "cuda", "--lines", LISTEN]),
    ("qwen3", "cpu", 4, "qwen3", ["--device", "cpu", "--threads", "4", "--lines", LISTEN]),
    ("chatterbox-nano", "cpu", 4, "chatterbox-nano", ["--device", "cpu", "--threads", "4", "--cast-from", "qwen3", "--lines", LISTEN]),
    ("chatterbox-nano-8t", "cpu", 8, "chatterbox-nano", ["--device", "cpu", "--threads", "8", "--cast-from", "qwen3", "--lines", LISTEN, "--tag", "8t"]),
    ("kokoro", "cuda", None, "kokoro", ["--device", "cuda", "--lines", LISTEN]),
    ("kokoro", "cpu", 4, "kokoro", ["--device", "cpu", "--threads", "4", "--lines", LISTEN]),
    ("kitten", "cpu", 4, "kitten", ["--device", "cpu", "--threads", "4", "--lines", LISTEN]),
    ("kitten-blend", "cpu", 4, "kitten", ["--device", "cpu", "--threads", "4", "--blend", "--lines", LISTEN]),
    ("phonon", "cpu", 4, "phonon", ["--device", "cpu", "--threads", "4", "--lines", LISTEN]),
    ("phonon-q8", "cpu", 4, "phonon", ["--device", "cpu", "--threads", "4", "--variant", "phonon-q8", "--lines", LISTEN]),
    ("phonon-blend", "cpu", 4, "phonon", ["--device", "cpu", "--threads", "4", "--variant", "phonon-blend", "--lines", LISTEN]),
]


# ----------------------------------------------------------------------------- load from outside

class _FT(ctypes.Structure):
    _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]


def _times() -> tuple[int, int, int]:
    idle, kern, user = _FT(), _FT(), _FT()
    ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user))
    v = lambda f: (f.hi << 32) | f.lo  # noqa: E731
    return v(idle), v(kern), v(user)


def cpu_load(samples: int = 3, interval: float = 1.0) -> dict:
    """Processor busy percent over `samples` one-second windows (kernel time includes idle)."""
    out = []
    a = _times()
    for _ in range(samples):
        time.sleep(interval)
        b = _times()
        idle, kern, user = (b[i] - a[i] for i in range(3))
        total = kern + user
        out.append(round(100.0 * (total - idle) / total, 1) if total else None)
        a = b
    ok = [x for x in out if x is not None]
    return {"samples_pct": out, "mean_pct": round(sum(ok) / len(ok), 1) if ok else None}


def gpu_load() -> dict:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=20)
        line = r.stdout.strip().splitlines()[0]
        u, m = [s.strip() for s in line.split(",")]
        return {"raw": line, "util_pct": int(u.split()[0]), "mem_used_mib": int(m.split()[0])}
    except Exception as e:  # no card or no nvidia-smi: say so, do not guess
        return {"error": "%s: %s" % (type(e).__name__, e)}


def load_now() -> dict:
    g = gpu_load()  # the card first, then the processor over three seconds
    c = cpu_load()
    return {"gpu": g, "cpu": c, "at": time.strftime("%Y-%m-%d %H:%M:%S")}


# ----------------------------------------------------------------------------- files

def manifest(folder: Path) -> dict[str, str]:
    out = {}
    for p in sorted(folder.rglob("*")):
        if p.is_file():
            out[p.relative_to(folder).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def once(a: argparse.Namespace) -> int:
    cmd = a.command[1:] if a.command[:1] == ["--"] else a.command
    if "/" in cmd[0] or "\\" in cmd[0]:
        cmd[0] = str((ROOT / cmd[0]).resolve())
    folder = VOICE / a.key
    SCRATCH.mkdir(parents=True, exist_ok=True)
    backup = SCRATCH / ("%s.%s" % (a.key, a.id))
    if backup.exists():
        shutil.rmtree(backup)
    before = manifest(folder) if folder.exists() else {}
    if folder.exists():
        shutil.copytree(folder, backup)
    pre = load_now()  # outside load just before the run starts (nothing of ours is running)
    t0 = time.time()
    try:
        rc = subprocess.call(cmd, cwd=str(ROOT))
    except BaseException:  # whatever happens, the scored files go back
        if folder.exists():
            shutil.rmtree(folder)
        if backup.exists():
            shutil.copytree(backup, folder)
        raise
    wall = time.time() - t0
    post = load_now()
    rec: dict = {"id": a.id, "model": a.key, "device": a.device, "threads": a.threads, "command": cmd,
                 "exit_code": rc, "wall_s": round(wall, 1), "load_before": pre, "load_after": post,
                 "started": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t0))}
    tp = folder / a.device / "timing.json"
    if rc == 0 and tp.exists():
        t = json.loads(tp.read_text(encoding="utf-8"))
        rec["lines"] = {k: {"audio_s": v["audio_s"], "synth_s": v["synth_s"], "rtf": v["rtf"]} for k, v in t["lines"].items()}
        rtfs = [v["rtf"] for v in t["lines"].values() if v.get("rtf")]
        rec["rtf_median"] = round(float(statistics.median(rtfs)), 3) if rtfs else None
        rec["rtf_min"], rec["rtf_max"] = (min(rtfs), max(rtfs)) if rtfs else (None, None)
        rec["load_s"] = t.get("load_s")
        rec["timing_extras"] = {k: v for k, v in t.items() if k not in ("lines", "voices") and isinstance(v, (int, float, str, list, type(None)))}
    # put every file back, then compare
    if folder.exists():
        shutil.rmtree(folder)
    if backup.exists():
        shutil.copytree(backup, folder)
        shutil.rmtree(backup)
    after = manifest(folder) if folder.exists() else {}
    rec["restored_identical"] = after == before
    rec["files_compared"] = len(before)
    if after != before:
        rec["restore_diff"] = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    (RUNS_DIR / (a.id + ".json")).write_text(json.dumps(rec, indent=2), encoding="utf-8")
    print("RUN %s rc=%s median=%s restored_identical=%s gpu_before=%s cpu_before=%s" % (
        a.id, rc, rec.get("rtf_median"), rec["restored_identical"], pre["gpu"].get("raw"), pre["cpu"]["mean_pct"]))
    return rc if rc else (0 if rec["restored_identical"] else 9)


def drive(a: argparse.Namespace) -> int:
    only = {s for s in (a.only or "").split(",") if s}
    log = SCRATCH / "retime_drive.log"
    SCRATCH.mkdir(parents=True, exist_ok=True)
    plan = []
    for rep in range(1, a.repeats + 1):
        for key, dev, thr, ad, args in RUNS:
            if only and key not in only:
                continue
            plan.append((rep, key, dev, thr, ad, args))
    with open(log, "a", encoding="utf-8") as lg:
        for rep, key, dev, thr, ad, args in plan:
            rid = "%s.%s.r%d" % (key, dev, rep)
            if (RUNS_DIR / (rid + ".json")).exists() and not a.redo:
                print("skip", rid)
                continue
            cmd = [sys.executable, str(HERE / "with_lock.py"), "--wait", "5400", "--",
                   sys.executable, str(HERE / "retime.py"), "once", "--id", rid, "--key", key, "--device", dev]
            if thr:
                cmd += ["--threads", str(thr)]
            cmd += ["--", py(key), adapter(ad)] + args
            lg.write("%s start %s\n" % (time.strftime("%H:%M:%S"), rid))
            lg.flush()
            r = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
            lg.write("%s end %s rc=%s\n%s\n" % (time.strftime("%H:%M:%S"), rid, r.returncode, (r.stdout or "")[-600:]))
            lg.flush()
            print(rid, "rc", r.returncode, (r.stdout.strip().splitlines() or [""])[-1])
    return 0


# ----------------------------------------------------------------------------- collect

def _med(v):
    v = [x for x in v if x is not None]
    return round(float(statistics.median(v)), 3) if v else None


def builder_runs() -> list[dict]:
    """The scored timing.json of each run: the builders' (qwen3 cpu: the run of this fix)."""
    out = []
    names = {}
    for key, dev, thr, ad, args in RUNS:
        names[(key, dev)] = thr
    for (key, dev), thr in names.items():
        tp = VOICE / key / dev / "timing.json"
        if not tp.exists():
            continue
        t = json.loads(tp.read_text(encoding="utf-8"))
        ls = t["lines"]
        listen = [ls[k]["rtf"] for k in LISTEN.split(",") if k in ls]
        out.append({"source": "scored run (timing.json)", "model": key, "device": dev, "threads": thr,
                    "n_lines": len(ls), "rtf_median": t.get("rtf_median"), "rtf_median_4_listen_lines": _med(listen),
                    "outside_load": "not recorded"})
    # the builders' timing of a run that this fix replaced (kept as it was before)
    for p in sorted(RUNS_DIR.glob("builder_*.timing.json")):
        t = json.loads(p.read_text(encoding="utf-8"))
        key, dev = t["model"], t["device"]
        out.append({"source": "builders' run, replaced by this fix (%s)" % p.name, "model": key, "device": dev, "threads": t.get("threads"),
                    "n_lines": len(t["lines"]), "rtf_median": t.get("rtf_median"), "rtf_median_4_listen_lines": None,
                    "outside_load": "not recorded"})
    return out


def audit_runs() -> list[dict]:
    """Re-times of the audit (assets/audio/voice/_audit/retime). Load: the audit driver log noted the
    load when the run was queued (not at its start) and the processor after it."""
    import re
    log = (VOICE / "_audit" / "retime_driver.log")
    loads: dict[str, dict] = {}
    if log.exists():
        cur = None
        text = re.sub(r"MiB\s+\]", "MiB ]", log.read_text(encoding="utf-8", errors="replace"))  # nvidia-smi output broke some lines
        for ln in text.splitlines():
            m = re.match(r"== (\S+) (\S+) queued (\S+) cpu=(\d+)% gpu=\[(\d+) %, (\d+) MiB \]", ln)
            if m:
                cur = (m.group(1), m.group(2))
                loads[cur] = {"at_queue": m.group(3), "cpu_pct": int(m.group(4)), "gpu_util_pct": int(m.group(5)), "gpu_mem_mib": int(m.group(6))}
                continue
            m = re.match(r"exit \d+ at (\S+) cpu_after=(\d+)% gpu=\[(\d+) %, (\d+) MiB \]", ln)
            if m and cur:
                loads[cur].update({"after_at": m.group(1), "cpu_after_pct": int(m.group(2)), "gpu_after_util_pct": int(m.group(3))})
    out = []
    for p in sorted(AUDIT_DIR.glob("*.json")):
        stem = p.stem
        key, _, rest = stem.partition("__")
        dev, _, rep = rest.partition("_")
        t = json.loads(p.read_text(encoding="utf-8"))
        ls = t.get("lines", {})
        l = loads.get((key, dev)) if not rep else None
        note = ("audit run, load noted by the audit driver when the run was queued (not at its start): " + json.dumps(l)) if l else \
            "audit run %s: load as the audit report states (card about 50 percent busy for kokoro r2/r3 and qwen3 r2); not measured per run" % rep
        out.append({"source": "audit (%s)" % p.name, "model": key, "device": dev, "threads": t.get("threads"),
                    "n_lines": len(ls), "rtf_median": t.get("rtf_median"), "outside_load": note})
    return out


def collect(a: argparse.Namespace) -> int:
    mine = []
    for p in sorted(RUNS_DIR.glob("*.json")):
        r = json.loads(p.read_text(encoding="utf-8"))
        if r.get("exit_code") != 0 or not r.get("lines") or str(r.get("id", "")).startswith("proof"):
            continue
        mine.append(r)
    runs = [{"source": "this fix (retime.py)", "id": r["id"], "model": r["model"], "device": r["device"], "threads": r["threads"],
             "started": r["started"], "n_lines": len(r["lines"]), "rtf_per_line": {k: v["rtf"] for k, v in r["lines"].items()},
             "rtf_median": r["rtf_median"], "load_s": r.get("load_s"),
             "outside_load_before": {"gpu_util_pct": r["load_before"]["gpu"].get("util_pct"),
                                     "gpu_mem_used_mib": r["load_before"]["gpu"].get("mem_used_mib"),
                                     "cpu_busy_pct_last_3_s": r["load_before"]["cpu"]["samples_pct"],
                                     "cpu_busy_pct_mean": r["load_before"]["cpu"]["mean_pct"]},
             "outside_load_after": {"gpu_util_pct": r["load_after"]["gpu"].get("util_pct"), "cpu_busy_pct_mean": r["load_after"]["cpu"]["mean_pct"]},
             "audio_restored_identical": r["restored_identical"], "files_compared": r["files_compared"]} for r in mine]
    known = builder_runs() + audit_runs()
    groups: dict[str, dict] = {}
    for r in known + runs:
        k = "%s/%s" % (r["model"], r["device"])
        g = groups.setdefault(k, {"model": r["model"], "device": r["device"], "threads": r.get("threads"), "medians": []})
        g["medians"].append({"source": r["source"], "rtf_median": r["rtf_median"], "n_lines": r["n_lines"],
                             **({"id": r["id"]} if "id" in r else {})})
    summary = {}
    for k, g in groups.items():
        vals = [m["rtf_median"] for m in g["medians"] if m["rtf_median"] is not None]
        mine_v = [m["rtf_median"] for m in g["medians"] if m["source"].startswith("this fix")]
        loads = [r["outside_load_before"] for r in runs if r["model"] == g["model"] and r["device"] == g["device"]]
        summary[k] = {"threads": g["threads"], "runs_known": len(vals), "runs_this_fix": len(mine_v),
                      "median_low": min(vals) if vals else None, "median_high": max(vals) if vals else None,
                      "this_fix_medians": mine_v,
                      "this_fix_outside_load": {
                          "gpu_util_pct_range": [min(l["gpu_util_pct"] for l in loads if l["gpu_util_pct"] is not None),
                                                 max(l["gpu_util_pct"] for l in loads if l["gpu_util_pct"] is not None)] if any(l["gpu_util_pct"] is not None for l in loads) else None,
                          "cpu_busy_pct_mean_range": [min(l["cpu_busy_pct_mean"] for l in loads), max(l["cpu_busy_pct_mean"] for l in loads)] if loads else None},
                      "all_medians": g["medians"]}
    doc = {"written": time.strftime("%Y-%m-%d %H:%M:%S"),
           "what": "Real-time factor (synthesis time / audio length; below 1 is faster than real time) of the four lines marked listen "
                   "(computer_fold, procedural_convoy, radio_clearance, station_dock), re-timed through the bench lock, per model and device, with the "
                   "load from outside measured just before each run. The graphics card is shared with the owner's desktop programs; other agents load the processor.",
           "how_load_was_measured": "gpu: nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader just before the run starts; "
                                    "cpu: three one-second samples of whole-machine busy percent (GetSystemTimes) just before the run starts. Nothing of ours runs at that moment.",
           "audio_note": "Before every run the model's directory under assets/audio/voice was copied to a scratch folder and put back afterwards; "
                         "SHA-256 of every file was compared (audio_restored_identical).",
           "runs": runs, "known_runs_other_sources": known, "summary_by_model_and_device": summary}
    (VOICE / "retime.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print("wrote", VOICE / "retime.json", "runs:", len(runs))
    for k, s in summary.items():
        print("%-26s known %2d  this fix %s  range %s - %s" % (k, s["runs_known"], s["this_fix_medians"], s["median_low"], s["median_high"]))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("once")
    o.add_argument("--id", required=True)
    o.add_argument("--key", required=True)
    o.add_argument("--device", required=True)
    o.add_argument("--threads", type=int)
    o.add_argument("command", nargs=argparse.REMAINDER)
    d = sub.add_parser("drive")
    d.add_argument("--repeats", type=int, default=3)
    d.add_argument("--only")
    d.add_argument("--redo", action="store_true")
    sub.add_parser("collect")
    a = ap.parse_args()
    return {"once": once, "drive": drive, "collect": collect}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
