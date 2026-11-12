"""Regenerate the PRIMACY2 models.

    blender --background --python assets/blender/build_all.py                 # everything
    blender --background --python assets/blender/build_all.py -- ship_wisp    # selected keys
    ... -- --no-preview ship_wisp                                             # skip the preview render

Inside a running Blender (for example through the MCP server):

    ns = {'__name__': 'build_all', '__file__': path}
    exec(compile(open(path, encoding='utf-8').read(), path, 'exec'), ns)
    result = ns['build'](['ship_wisp'])

Every generator rebuilds its own collection "P2_<key>" in the scene "P2_Assets" from
scratch, exports packages/client/public/models/<key>.glb and renders
assets/blender/previews/<key>.png. Nothing outside those collections is touched.
"""

import importlib
import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# key -> module with a build(export=True, preview=True) function
MODELS = {
    'ship_wisp': 'ships.ship_wisp',
    'ship_lancet': 'ships.ship_lancet',
    'ship_drover': 'ships.ship_drover',
    'ship_delver': 'ships.ship_delver',
    'ship_wayfarer': 'ships.ship_wayfarer',
    'ship_bulwark': 'ships.ship_bulwark',
    'station_ring': 'structures.station_ring',
    'asteroid_0': 'props.asteroid_0',
    'asteroid_1': 'props.asteroid_1',
    'asteroid_2': 'props.asteroid_2',
    'asteroid_3': 'props.asteroid_3',
    'gate': 'structures.gate',
    'station_outpost': 'structures.station_outpost',
    'cargo_pod': 'props.cargo_pod',
    'missile': 'props.missile',
    'beacon': 'structures.beacon',
    'cockpit_generic': 'props.cockpit_generic',
    'debris_0': 'props.debris_0',
    'debris_1': 'props.debris_1',
    'debris_2': 'props.debris_2',
    'debris_3': 'props.debris_3',
}
SHARED = ('p2lib', 'ships.kit', 'structures.skit', 'props.rockkit', 'props.debriskit')


def build(keys=None, export=True, preview=True, **kw):
    """Build the given keys (default: all registered models). Returns {key: report}."""
    for name in SHARED:
        importlib.reload(importlib.import_module(name))
    out = {}
    for key in (keys or list(MODELS)):
        try:
            mod = importlib.reload(importlib.import_module(MODELS[key]))
            out[key] = mod.build(export=export, preview=preview, **kw)
        except Exception:
            out[key] = dict(key=key, error=traceback.format_exc()[-1800:])
    return out


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    reports = build([a for a in argv if not a.startswith('--')] or None, preview='--no-preview' not in argv)
    print(json.dumps(reports, indent=1, default=str))
    bad = [k for k, r in reports.items() if r.get('error') or r.get('problems')]
    if bad:
        print('PROBLEMS: ' + ', '.join(bad))
        sys.exit(1)
