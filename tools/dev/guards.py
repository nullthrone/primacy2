"""Switches one guard off at a time, runs the tests that should catch it, and restores the file.

Usage: python guards.py <spec.json>
The spec is a list of {name, file, find, replace, tests: [files], expect: [test name fragments]}.
Waits when a checkpoint commit is due, so that no mutated file is ever committed.
"""
import json
import subprocess
import sys
import time


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')


def wait_for_checkpoint_gap(need=60):
    last = int(sh('git log -1 --format=%ct').stdout.strip())
    phase = (int(time.time()) - last) % 300
    if phase > 300 - need:
        time.sleep(300 - phase + 8)


spec = json.load(open(sys.argv[1], encoding='utf-8'))
bad = 0
for m in spec:
    src = open(m['file'], encoding='utf-8').read()
    if src.count(m['find']) != 1:
        print('SKIP  %s: pattern found %d times' % (m['name'], src.count(m['find'])))
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
    print('%s  %s' % ('CAUGHT' if caught else 'MISSED', m['name']))
    for line in failed[:6]:
        print('        ' + line[:150])
    if not caught:
        bad += 1
print('restored; %d problem(s)' % bad)
