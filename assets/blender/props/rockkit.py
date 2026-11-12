"""Asteroid builder: a displaced icosphere, normalised to a bounding radius of 1 m.

The game scales the rocks, so every asteroid has its geometric centre at the origin and its
farthest vertex exactly 1 m away. Shapes differ through the anisotropic scale, waist and bend
(elongated), plane cuts (shards and blocks) and crater bowls.
"""

import math
import random

import bmesh
from mathutils import Vector, noise

import p2lib as L
from structures import skit as K


def fbm(p, octaves=4, gain=0.5):
    s, a, f = 0.0, 1.0, 1.0
    for _ in range(octaves):
        s += a * noise.noise(p * f)
        a *= gain
        f *= 2.03
    return s


def _rand_dir(rng):
    while True:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if 0.05 < v.length <= 1.0:
            return v.normalized()


def build_rock(key, seed, scale=(1.0, 1.0, 1.0), amp=0.25, freq=1.3, rough=0.05, boxy=0.0, waist=0.0,
               bend=0.0, cuts=0, cut_range=(0.62, 0.86), cut_bias=None, craters=0, crater_size=(0.3, 0.55),
               crater_depth=(0.1, 0.2), sharp=27.0, grid=14, ridge=0.1, direction=(0.6, -0.8, 0.45),
               export=True, preview=True, ao=True):
    rng = random.Random(seed)
    off = Vector((rng.uniform(-40, 40), rng.uniform(-40, 40), rng.uniform(-40, 40)))
    m = L.Model(key, 'asteroid', 1.0)
    p = m.part()
    bm = p.bm
    # spherified cube: 6 * grid * grid quads (2352 triangles for grid 14), evenly spread
    bmesh.ops.create_cube(bm, size=2.0)
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=grid - 1, use_grid_fill=True)
    mi = p.mi('rock')
    for f in bm.faces:
        f.material_index = mi
    bowl = [(_rand_dir(rng), rng.uniform(*crater_size), rng.uniform(*crater_depth)) for _ in range(craters)]
    for v in bm.verts:
        d = v.co.normalized()
        r = 1.0 + amp * fbm(d * freq + off) + rough * noise.noise(d * 6.5 - off)
        r += ridge * (0.5 - abs(noise.noise(d * 2.6 + off * 0.37)))   # creases
        if boxy:
            r *= (1.0 / max(abs(d.x), abs(d.y), abs(d.z))) ** boxy
        for c, a, depth in bowl:
            t = d.angle(c) / a
            if t < 1.0:
                r -= depth * (1.0 - t ** 3)
            r += depth * 0.42 * math.exp(-((t - 1.0) / 0.16) ** 2)
        co = d * r
        co.x *= scale[0]
        co.y *= scale[1]
        co.z *= scale[2]
        if waist:
            k = 1.0 - waist * math.exp(-(co.x / 0.33) ** 2)
            co.y *= k
            co.z *= k
        if bend:
            co.y += bend * co.x * co.x
        v.co = co
    bmesh.ops.smooth_vert(bm, verts=list(bm.verts), factor=0.3, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for _ in range(cuts):                             # chip flat facets off the lump
        n = _rand_dir(rng)
        if cut_bias:
            n = Vector((n.x * cut_bias[0], n.y * cut_bias[1], n.z * cut_bias[2])).normalized()
        h = max(v.co.dot(n) for v in bm.verts) * rng.uniform(*cut_range)
        for v in bm.verts:
            s = v.co.dot(n) - h
            if s > 0.0:
                v.co -= n * (s * 0.95)
    lo = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
    hi = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
    c = (lo + hi) * 0.5
    rmax = max((v.co - c).length for v in bm.verts)
    for v in bm.verts:
        v.co = (v.co - c) / rmax
    m.add(p)
    return K.finish(m, sharp=sharp, ao=ao, ao_distance=0.45, export=export, preview=preview,
                    direction=direction, zoom=0.85)
