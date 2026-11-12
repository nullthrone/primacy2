"""Shared finish for the debris pieces (debris_0..3) that explosions and wrecks scatter.

Like the asteroids, a piece is normalised to a bounding radius of exactly 1 m around its
bounding-box centre; the effects scale it. Each generator hands over the points where its
metal tore. The vertex colours are the baked ambient occlusion multiplied by a scorch tint:
soot at the tears, a band of heat discolouration behind it, clean paint beyond.
"""

import numpy as np
from mathutils import Vector, kdtree, noise

import p2lib as L
from structures import skit as K

SOOT = np.array((0.10, 0.09, 0.08))
HEAT = np.array((0.52, 0.40, 0.30))


def _smooth(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _scorch(ob, tear, reach):
    tree = kdtree.KDTree(len(tear))
    for i, q in enumerate(tear):
        tree.insert(q, i)
    tree.balance()
    pts = K.corner_points(ob.data, 0.15)
    d = np.array([tree.find(q)[2] / reach + 0.22 * noise.noise(Vector(q) * 5.0) for q in pts])   # ragged edge
    heat = _smooth(d * 2.2)[:, None]
    clean = _smooth((d - 0.35) / 0.65)[:, None]
    tint = SOOT * (1.0 - heat) + HEAT * heat
    K.multiply_col(ob, tint * (1.0 - clean) + clean)


def finish(m, tear, reach=0.45, sharp=35.0, direction=(0.6, -0.8, 0.45), export=True, preview=True, ao=True):
    """Normalise the model to radius 1, bake, scorch around the `tear` points (given in the
    generator's own coordinates; `reach` is in normalised metres), export and preview."""
    co = np.array([v.co[:] for v in m.bm.verts], dtype=np.float64)
    c = (co.min(axis=0) + co.max(axis=0)) * 0.5
    rmax = float(np.linalg.norm(co - c, axis=1).max())
    for v in m.bm.verts:
        v.co = (v.co - Vector(c)) / rmax
    tear = (np.array(tear, dtype=np.float64) - c) / rmax
    return K.finish(m, sharp=sharp, ao=ao, ao_distance=0.5, export=export, preview=preview,
                    direction=direction, zoom=0.85, post=lambda mm: _scorch(mm.object, tear, reach))
