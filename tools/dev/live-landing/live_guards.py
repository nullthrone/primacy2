"""Switches one piece of the client's view wiring off at a time, rebuilds the client, runs the
live check (live2.mts) and restores the file. The live check must then fail at the named step.

A mutation is only applied when no checkpoint loop (`sleep 300`) is about to end: a mutated file
must never be committed. The client is rebuilt from the restored tree at the end.
"""
import json
import os
import subprocess
import sys
import time

S = os.path.dirname(os.path.abspath(__file__)).replace(os.sep, '/')
GAME = 'packages/client/src/game/Game.ts'
HUD = 'packages/client/src/ui/Hud.tsx'
SPEC = [
    ('own ship position left in frame axes', GAME,
     "id: this.selfId, hull: this.hull, state: st, stats, rel: toSystem(frame, v3.sub(shipPos, camLocal)),",
     "id: this.selfId, hull: this.hull, state: st, stats, rel: v3.sub(shipPos, camLocal),",
     ['ship relative to the base']),
    ('other entities left in frame axes', GAME,
     "id, info, rel: toSystem(frame, v3.sub(e.pos, camLocal)), vel: toSystem(frame, e.vel), rot: rotToSystem(frame, e.rot),",
     "id, info, rel: v3.sub(e.pos, camLocal), vel: e.vel, rot: e.rot,",
     ['parked ship relative to ours']),
    ('zoneRot always the identity', GAME,
     "zoneRot: inZone ? (frame.rot ?? [0, 0, 0, 1]) : null,",
     "zoneRot: inZone ? [0, 0, 0, 1] : null,",
     ['zoneRot is the rotation']),
    ('own velocity left in frame axes', GAME,
     "vel: toSystem(frame, st.vel), rot: shipRotSys, input: this.lastInput,",
     "vel: st.vel, rot: shipRotSys, input: this.lastInput,",
     ['velocity marker']),
    ('own orientation left in frame axes', GAME,
     "const shipRotSys = rotToSystem(frame, shipRot);",
     "const shipRotSys = shipRot;",
     ['FAIL']),
    ('a landed ship is not flown', GAME,
     "const isFlying = (m: FlightMode): boolean => m === FlightMode.Normal || m === FlightMode.Cruise || m === FlightMode.Landed;",
     "const isFlying = (m: FlightMode): boolean => m === FlightMode.Normal || m === FlightMode.Cruise;",
     ['FAIL']),
    ('touchdown clears the contacts', GAME,
     "const zoneClass = (m: FlightMode): FlightMode => (m === FlightMode.Landed ? FlightMode.Normal : m);",
     "const zoneClass = (m: FlightMode): FlightMode => m;",
     ['FAIL']),
    ('no surface data in the view', GAME,
     "surface: placed ? surfaceView(sys, t, frame, camLocal, bodyStates, flying ? { state: { ...st, pos: shipPos }, stats } : null) : null,",
     "surface: null,",
     ['FAIL']),
    ('velocity marker from the raw state velocity', HUD,
     "const p = api.project(v3.addScaled(self.rel, self.vel, 1000 / speed));",
     "const p = api.project(v3.addScaled(self.rel, st.vel, 1000 / speed));",
     ['velocity marker']),
    ('no dock prompt at a base', HUD,
     "(base !== null && base.dist < (base.site.radius ?? 300) + DOCK_RANGE);",
     "false;",
     ['dock prompt shown']),
    ('cruise-drop prompt only by frame radius', HUD,
     "const canDrop = cruise && navSite && (navGround ? v3.len(view.surface!.cam) < navGround.enter : navSite.dist < navSite.def.frameRadius);",
     "const canDrop = cruise && navSite && navSite.dist < navSite.def.frameRadius;",
     ['with the base as nav target']),
]


def sh(cmd, env=None):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)


def checkpoint_due_in():
    out = sh('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'sleep.exe\'\\" | ForEach-Object { [int]((Get-Date) - $_.CreationDate).TotalSeconds }"').stdout.split()
    ages = [int(x) for x in out if x.strip().lstrip('-').isdigit()]
    return min(300 - a for a in ages) if ages else None


def wait_gap(need=150):
    while True:
        due = checkpoint_due_in()
        if due is None or due > need:
            return
        time.sleep(max(1, due) + 12)


only = sys.argv[1:]
env = dict(os.environ, LIVE_STAND_MS='3000')
bad = 0
for name, path, find, replace, expect in SPEC:
    if only and not any(o in name for o in only):
        continue
    src = open(path, encoding='utf-8', newline='').read()
    if src.count(find) != 1:
        print('SKIP  %s: pattern found %d times' % (name, src.count(find)), flush=True)
        bad += 1
        continue
    wait_gap()
    try:
        open(path, 'w', encoding='utf-8', newline='').write(src.replace(find, replace))
        b = sh('npm run build')
        if b.returncode != 0:
            text = 'BUILD FAILED\n' + (b.stdout + b.stderr)[-600:]
            code = -1
        else:
            out = sh('npx tsx "%s/live2.mts" "%s/live-mut" 8431' % (S, S), env)
            text = out.stdout + out.stderr
            code = out.returncode
    finally:
        open(path, 'w', encoding='utf-8', newline='').write(src)
    fails = [l.strip() for l in text.splitlines() if l.startswith('FAIL') or 'pageerror' in l or 'script failed' in l or l.startswith('BUILD FAILED')]
    caught = code == 1 and all(any(f in l for l in fails) for f in expect)
    print('%s  %s  (exit %d)' % ('CAUGHT' if caught else 'MISSED', name, code), flush=True)
    for l in fails[:5]:
        print('        ' + l[:230], flush=True)
    if not caught:
        bad += 1
b = sh('npm run build')
print('restored and rebuilt (build exit %d); %d problem(s)' % (b.returncode, bad), flush=True)
