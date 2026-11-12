"""Shared building blocks for the ship generators (thin layer over p2lib)."""

import math
import os

import numpy as np

import p2lib as L
from p2lib import S  # noqa: F401  (re-exported for the generators)

RING = (-90.0, 90.0)  # Grid.paint(..., *RING, mat) paints the whole circumference


def canopy(m, stations, segs=16, spacing=0.4, y_cuts=None, a_cuts=(8.0, 50.0), frame='hull_secondary',
           bar=0.05):
    """Glass bubble: a loft sunk into the hull. Panes are separated by frame bars."""
    p = m.part()
    g = p.loft(stations, segs=segs, mat='glass', spacing=spacing, cap_mat=frame)
    lf = g.loft
    g.paint(lf.y0, lf.y1, -90.0, a_cuts[0], frame)
    if y_cuts is None:
        n = max(2, int(round((lf.y1 - lf.y0) / 1.2)))
        y_cuts = [lf.y0 + (lf.y1 - lf.y0) * k / n for k in range(n + 1)]
    g.panels(y_cuts, list(a_cuts), width=bar, depth=-0.012, rim=frame)
    m.add(p)
    return lf


def gun(p, tip, length=1.3, r=0.08, mat='hull_dark', body='hull_secondary'):
    """Fixed gun: the muzzle sits exactly on the hardpoint `tip` (Blender coordinates)."""
    x, y, z = tip
    p.tube((x, y - length, z), (x, y, z), r, r, 8, mat)
    p.tube((x, y - 0.22 * length, z), (x, y - 0.04, z), r * 1.5, r * 1.5, 8, body)
    p.tube((x, y - length, z), (x, y - 0.55 * length, z), r * 2.2, r * 1.9, 8, body)


def antenna(p, base, tip, r=0.03, mat='hull_dark', light=None):
    p.tube(base, tip, r, r * 0.4, 6, mat)
    if light:
        p.lathe([(-r * 2, 0.0), (0.0, r * 2.2), (r * 2, 0.0)], 6, light, axis='Z', origin=tip)


def lamp(m, p, idx, loc, size=0.12, mat='emissive_light'):
    """Small emissive navigation light plus its light_<idx> empty."""
    p.box(loc, (size, size * 1.6, size), mat, chamfer=size * 0.25)
    m.empty('light_%d' % idx, loc)


def engine(m, p, idx, loc, r, length, segs=16, **kw):
    """Engine bell whose nozzle exit plane is at loc (x, y, z); adds engine_<idx>."""
    p.engine(loc[1], r, length, segs=segs, origin=(loc[0], 0.0, loc[2]), **kw)
    m.empty('engine_%d' % idx, loc)


def finish(m, sharp=38.0, ao=True, export=True, preview=True, view='front34', zoom=1.4):
    """Finalize, export, verify and render one preview. Returns a compact report."""
    m.finalize(sharp_angle=sharp, ao=ao)
    me = m.object.data
    co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    st = m.stats
    rep = dict(key=m.key, tris=st['triangles'], radius=st['bounding_radius'], catalog=m.radius,
               bbox=[st['bbox_min'], st['bbox_max']],
               centre=[round((a + b) / 2, 2) for a, b in zip(st['bbox_min'], st['bbox_max'])],
               ao=st.get('ao'))
    # distance from every hardpoint to the nearest mesh vertex: a mount must be on the hull
    hp = []
    for h in m.hardpoints:
        b = np.array(L.gltf_to_blender(h), dtype=np.float32)
        hp.append(round(float(np.sqrt(((co - b) ** 2).sum(axis=1)).min()), 2))
    rep['hardpoint_gap'] = hp
    if export:
        v = L.process(m, export=True, previews=())['glb']
        rep.update(glb_tris=v['triangles'], glb_radius=v['bounding_radius'], size_kb=v['size_kb'],
                   glb_bbox=[v['bbox_min'], v['bbox_max']], problems=v['problems'],
                   nose_at_min_z=bool(-v['bbox_min'][2] > 0 and v['empties'].get('cockpit', [0, 0, 1])[2] < 0),
                   empties=sorted(v['empties'].keys()), materials=v['materials'])
    if preview:
        path = os.path.join(L.PREVIEW_DIR, m.key + '.png')
        L.render_preview(m.key, view, m.radius, path=path, zoom=zoom)
        rep['preview'] = path
    return rep
