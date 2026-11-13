"""guards.py with one more safety: before every mutation it looks for a running checkpoint loop.

The checkpoint job is a shell loop around `sleep 300` (see checkpoint.sh). guards.py times its
waits from the last commit, which says nothing when the tree has been clean for hours. Here a
mutation is only applied when no `sleep` process is alive, or when the one alive has more than
60 seconds and less than 285 seconds... (its commit comes when it ends) left to run.
Same spec format and same output as guards.py.
"""
import json
import subprocess
import sys
import time


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')


def checkpoint_due_in():
    """Seconds until a running `sleep` ends, or None when there is none (300 s loops assumed)."""
    out = sh('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'sleep.exe\'\\" | ForEach-Object { [int]((Get-Date) - $_.CreationDate).TotalSeconds }"').stdout.split()
    ages = [int(x) for x in out if x.strip().lstrip('-').isdigit()]
    if not ages:
        return None
    return min(300 - a for a in ages)


def wait_for_checkpoint_gap(need=45):
    while True:
        due = checkpoint_due_in()
        if due is None or due > need:
            return due
        time.sleep(max(1, due) + 12)


spec = json.load(open(sys.argv[1], encoding='utf-8'))
bad = 0
for m in spec:
    src = open(m['file'], encoding='utf-8').read()
    if src.count(m['find']) != 1:
        print('SKIP  %s: pattern found %d times' % (m['name'], src.count(m['find'])), flush=True)
        bad += 1
        continue
    wait_for_checkpoint_gap()
    try:
        open(m['file'], 'w', encoding='utf-8', newline='').write(src.replace(m['find'], m['replace']))
        out = sh('npx vitest run ' + ' '.join(m['tests']))
        text = out.stdout + out.stderr
    finally:
        open(m['file'], 'w', encoding='utf-8', newline='').write(src)
    failed = [line.strip() for line in text.splitlines() if line.strip().startswith('×') or ' FAIL ' in line]
    caught = out.returncode != 0 and all(any(frag in line for line in failed) for frag in m.get('expect', []))
    print('%s  %s' % ('CAUGHT' if caught else 'MISSED', m['name']), flush=True)
    for line in failed[:6]:
        print('        ' + line[:150], flush=True)
    if not caught:
        bad += 1
print('restored; %d problem(s)' % bad, flush=True)
