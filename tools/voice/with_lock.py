"""Run one command while holding the bench lock, so that timed runs never overlap.

    <python> tools/voice/with_lock.py [--wait 3600] -- <command> [args...]

Several models are measured on one machine. A timing is worth nothing if another model runs on
the graphics card or eats the processor at the same moment, so every timed run and every use of
the graphics card goes through this lock. The lock is a directory (creating one is atomic); a
lock older than --stale seconds is taken over, because its owner has died.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

LOCK = Path(__file__).resolve().parent.parent.parent / "assets" / "audio" / "voice" / ".bench.lock"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--wait", type=float, default=3600.0, help="seconds to wait for the lock")
    ap.add_argument("--stale", type=float, default=2400.0, help="take over a lock older than this")
    ap.add_argument("command", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.command[1:] if a.command[:1] == ["--"] else a.command
    if not cmd:
        ap.error("no command given")
    # Windows does not find a relative program path written with forward slashes
    if "/" in cmd[0] or "\\" in cmd[0]:
        cmd[0] = str(Path(cmd[0]).resolve())
    else:
        cmd[0] = shutil.which(cmd[0]) or cmd[0]

    LOCK.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    while True:
        try:
            LOCK.mkdir()
            break
        except FileExistsError:
            try:
                age = time.time() - LOCK.stat().st_mtime
            except FileNotFoundError:
                continue
            if age > a.stale:
                print("with_lock: taking over a lock that is %.0f s old" % age, file=sys.stderr)
                try:
                    (LOCK / "owner.txt").unlink(missing_ok=True)
                    LOCK.rmdir()
                except OSError:
                    pass
                continue
            if time.time() - t0 > a.wait:
                print("with_lock: gave up after %.0f s" % a.wait, file=sys.stderr)
                return 75
            time.sleep(2.0)
    waited = time.time() - t0
    try:
        (LOCK / "owner.txt").write_text("pid %d\n%s\n" % (os.getpid(), " ".join(cmd)), encoding="utf-8")
        if waited > 1:
            print("with_lock: waited %.0f s" % waited, file=sys.stderr)
        return subprocess.call(cmd)
    finally:
        try:
            (LOCK / "owner.txt").unlink(missing_ok=True)
            LOCK.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
