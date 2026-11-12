"""Asteroid builder. Every rock is normalised to a bounding radius of exactly 1 m with its
bounding-box centre at the origin; the game scales and instances them.

A rock starts as a union of convex lobes (ellipsoids) that all contain the origin, so its
surface is one radius per direction. That radius is evaluated on a dense icosphere together
with fractal relief and ridges, fracture planes then cut flat facets through the rough surface,
and crater bowls with raised rims are pressed in. The dense mesh is decimated to the triangle
budget, which leaves large triangles on the fracture planes and small ones on rough ground.
Loose boulders are pushed into the surface last.

There is one material ("rock") and therefore one primitive. Colour variation lives in the
vertex colours: the baked ambient occlusion is multiplied by an albedo tint (dust in hollows
and crater floors, light fresh fracture faces and crater rims, mineral bands).
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector, kdtree, noise

import p2lib as L
from structures import skit as K

DENSE = 5        # icosphere subdivisions of the dense mesh (10242 vertices, 20480 triangles)

# Albedo tints, multiplied into the rock material colour (so 1.0 is the brightest tone).
TONES = dict(
    a=(0.62, 0.59, 0.56), b=(0.44, 0.41, 0.38),      # two ground tones, mixed by low-frequency noise
    dust=(0.24, 0.22, 0.20),                         # settles in hollows and crater floors
    fresh=(1.0, 0.97, 0.93),                         # fracture faces, crater rims, boulders
    band=(0.80, 0.68, 0.52), band_axis=(0.3, 0.2, 1.0), band_freq=2.2, band_amount=0.35,
)


def fbm(p, octaves=4, gain=0.5):
    s, a, f = 0.0, 1.0, 1.0
    for _ in range(octaves):
        s += a * noise.noise(p * f)
        a *= gain
        f *= 2.03
    return s


def rand_dir(rng):
    while True:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if 0.05 < v.length <= 1.0:
            return v.normalized()


class Lobe:
    """Convex lump that contains the origin: an ellipsoid plus the fracture planes that cut it.

    A centre that would leave the origin outside (or close to the skin) is pulled inward, so a
    generator can place lobes freely.
    """

    def __init__(self, center=(0.0, 0.0, 0.0), radii=(1.0, 1.0, 1.0), rot=(0.0, 0.0, 0.0)):
        rm = np.array(Euler([math.radians(a) for a in rot], 'XYZ').to_matrix())
        self.A = rm @ np.diag(np.array(radii, dtype=np.float64))     # unit sphere -> ellipsoid
        self.Ainv = np.linalg.inv(self.A)
        c = np.array(center, dtype=np.float64)
        depth = float(np.linalg.norm(self.Ainv @ c))
        if depth > 0.86:
            c *= 0.86 / depth
        self.c = c
        self.planes = []                              # (unit normal n, h, fresh): keeps n.x <= h

    def plane(self, n, depth, fresh=None):
        """Fracture plane with normal n at `depth` times the lobe's reach in that direction.
        fresh (0..1) is how recently it broke, which is how light it is; random when None."""
        n = np.array(n, dtype=np.float64)
        n /= np.linalg.norm(n)
        reach = float(n @ self.c + np.linalg.norm(self.A.T @ n))
        self.planes.append((n, max(reach * depth, 0.05), fresh))
        return self

    def chip(self, rng, count, depth=(0.78, 0.95), bias=None):
        """Break `count` random facets off; bias scales the normals (0.2 on an axis keeps planes
        nearly parallel to it)."""
        for _ in range(count):
            n = np.array(rand_dir(rng))
            if bias is not None:
                n = n * np.array(bias)
            self.plane(n, rng.uniform(*depth))
        return self

    def exit(self, D, rng):
        """Along each unit direction in D: distance to the ellipsoid skin, distance to the nearest
        fracture plane (infinite where no plane is hit) and that plane's freshness."""
        U = D @ self.Ainv.T
        w = self.Ainv @ self.c
        a = (U * U).sum(axis=1)
        b = -2.0 * (U @ w)
        c = float(w @ w) - 1.0
        skin = (-b + np.sqrt(np.maximum(b * b - 4.0 * a * c, 0.0))) / (2.0 * a)
        cut = np.full(len(D), np.inf)
        age = np.zeros(len(D))
        for n, h, fresh in self.planes:
            nd = D @ n
            tp = np.where(nd > 1e-6, h / np.maximum(nd, 1e-6), np.inf)
            nearer = tp < cut
            cut = np.where(nearer, tp, cut)
            age = np.where(nearer, rng.uniform(0.1, 0.95) if fresh is None else fresh, age)
        return skin, cut, age


def _smooth(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _mix(col, to, w):
    return col + (np.asarray(to) - col) * np.asarray(w)[:, None]


def _decimate(key, bm, tris):
    """Collapse-decimate a bmesh to about `tris` triangles (through a temporary object in the
    model's own collection, removed again before returning)."""
    me = bpy.data.meshes.new('p2_tmp_dense')
    bm.to_mesh(me)
    ob = bpy.data.objects.new('p2_tmp_dense', me)
    L.get_collection(key).objects.link(ob)
    try:
        mod = ob.modifiers.new('p2_dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = min(1.0, tris / max(len(bm.faces), 1))
        mod.use_collapse_triangulate = True
        with L.scene_active():
            dg = bpy.context.evaluated_depsgraph_get()
            dg.update()
            low = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    finally:
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
    out = bmesh.new()
    out.from_mesh(low)
    bpy.data.meshes.remove(low)
    return out


def _split_long_edges(bm, limit, rounds=2):
    """Cut edges longer than `limit`, so the large triangles the decimation leaves on fracture
    faces get enough vertices to carry colour bands."""
    for _ in range(rounds):
        long = [e for e in bm.edges if e.calc_length() > limit]
        if not long:
            break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])


def _paint(ob, samples, tints, first_boulder):
    """Multiply the albedo tint into "Col". Every face corner takes the tint of the nearest dense
    sample, looked up a little inside its face so a fracture face stays light up to its edge.
    Boulder corners keep a minimum of occlusion: their buried vertices bake black and would
    drag the visible faces down with them."""
    tree = kdtree.KDTree(len(samples))
    for i, s in enumerate(samples):
        tree.insert(s, i)
    tree.balance()
    near = np.array([tree.find(q)[1] for q in K.corner_points(ob.data, 0.35)])
    K.multiply_col(ob, tints[near], floor=np.where(near >= first_boulder, 0.7, 0.0))


def build_rock(key, seed, lobes, scale=(1.0, 1.0, 1.0), amp=0.09, freq=2.4, rough=0.02, ridge=0.04,
               waist=0.0, waist_width=0.2, waist_at=0.0, taper=0.0, bend=0.0, craters=(), boulders=0,
               boulder_size=(0.05, 0.11), boulder_at=(), boulder_spread=0.45, tris=1900, tones=None,
               strata=0.0, flat_relief=0.12, max_edge=0.24, sharp=24.0, direction=(0.6, -0.8, 0.45),
               export=True, preview=True, ao=True):
    """craters: (direction or None for a random one, radius, depth), all in metres on the 1 m rock.
    boulder_at: directions the boulders gather around (random when empty).
    strata: depth of the ledges that follow the mineral bands (bedding that weathered unevenly).
    tris: triangles of the body after decimation; splitting long edges and the boulders add to it."""
    rng = random.Random(seed)
    off = Vector([rng.uniform(-40.0, 40.0) for _ in range(3)])
    tn = dict(TONES)
    tn.update(tones or {})

    dense = bmesh.new()
    bmesh.ops.create_icosphere(dense, subdivisions=DENSE, radius=1.0)
    dv = list(dense.verts)
    D = np.array([v.co.normalized()[:] for v in dv], dtype=np.float64)
    n = len(D)

    exits = [lb.exit(D, rng) for lb in lobes]
    skin = np.max([e[0] for e in exits], axis=0)

    # relief and the noise fields of the tint, sampled on the smooth skin
    relief, tone, band, grain = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    axis = Vector(tn['band_axis']).normalized()
    for i in range(n):
        p = Vector(D[i] * skin[i])
        h = amp * fbm(p * freq + off, 3) + rough * noise.noise(p * 8.0 - off)
        h += ridge * ((1.0 - abs(noise.noise(p * freq * 1.4 + off * 0.37))) ** 2 - 0.45)
        relief[i] = h
        tone[i] = noise.noise(p * 1.2 - off * 0.61)
        band[i] = math.sin(math.tau * (p.dot(axis) * tn['band_freq'] + 0.35 * noise.noise(p * 1.6 + off * 0.83)))
        grain[i] = noise.noise(p * 5.0 + off * 0.2)

    # rough lobes, each cut by its own fracture planes, then the union
    r = np.zeros(n)
    flat = np.zeros(n, dtype=bool)
    fresh = np.zeros(n)
    for sk, cut, age in exits:
        rough_r = sk + relief
        rl = np.minimum(rough_r, cut)
        win = rl > r
        r = np.where(win, rl, r)
        flat = np.where(win, cut < rough_r, flat)
        fresh = np.where(win, np.where(cut < rough_r, age, 0.0), fresh)
    r = np.where(flat, r + flat_relief * relief, r)   # fracture faces are nearly, not perfectly, flat
    layer = _smooth((band + 0.35) / 0.7)              # 1 on the mineral bands, 0 between them
    r = r + strata * (layer - 0.5)
    base = D * r[:, None]

    floor, rim, dh = np.zeros(n), np.zeros(n), np.zeros(n)
    for c, rad, depth in craters:
        cdir = np.array(Vector(c).normalized() if c is not None else rand_dir(rng))
        t = np.linalg.norm(base - base[int(np.argmax(D @ cdir))], axis=1) / rad
        dh -= depth * np.clip(1.0 - t ** 2.4, 0.0, None)
        dh += depth * 0.32 * np.exp(-((t - 1.0) / 0.2) ** 2)
        floor = np.maximum(floor, np.clip(1.0 - t * t, 0.0, 1.0))
        rim = np.maximum(rim, np.exp(-((t - 1.06) / 0.17) ** 2))
    r = np.maximum(r + dh, 0.1)

    P = D * r[:, None] * np.array(scale, dtype=np.float64)
    if taper:
        k = np.clip(1.0 + taper * P[:, 0], 0.3, None)
        P[:, 1] *= k
        P[:, 2] *= k
    if waist:
        k = 1.0 - waist * np.exp(-((P[:, 0] - waist_at) / waist_width) ** 2)
        P[:, 1] *= k
        P[:, 2] *= k
    if bend:
        P[:, 1] += bend * P[:, 0] ** 2

    # albedo tint on the dense vertices
    rough_ground = ~flat
    col = _mix(np.tile(np.array(tn['a']), (n, 1)), tn['b'], _smooth(0.5 + 1.6 * tone))
    col = _mix(col, tn['dust'], 0.7 * np.clip(-relief / (amp * 0.5 + 1e-6), 0.0, 1.0) * np.where(flat, 0.35, 1.0))
    col *= (1.0 + 0.10 * np.clip(relief / (amp * 0.6 + 1e-6), 0.0, 1.0) * rough_ground)[:, None]
    col = _mix(col, tn['fresh'], fresh)
    col = _mix(col, tn['band'], layer * tn['band_amount'])       # bands show on fresh faces too
    col = _mix(col, tn['dust'], 0.8 * floor)
    col = _mix(col, tn['fresh'], 0.55 * rim * (1.0 - floor))
    col = np.clip(col * (1.0 + 0.07 * grain)[:, None], 0.0, 1.0)

    for v, co in zip(dv, P):
        v.co = co
    dense.normal_update()
    N = np.array([v.normal[:] for v in dv], dtype=np.float64)
    body = _decimate(key, dense, tris)
    dense.free()
    _split_long_edges(body, max_edge)

    # loose boulders: squashed, jittered icosahedra sunk into the surface
    samples, tints = [P], [col]
    for _ in range(boulders):
        d = rand_dir(rng)
        if boulder_at:
            d = (Vector(rng.choice(boulder_at)).normalized() + d * boulder_spread).normalized()
        i = int(np.argmax(D @ np.array(d)))
        s = rng.uniform(*boulder_size)
        centre = Vector(P[i]) + Vector(N[i]) * (s * 0.3)
        mat = (Matrix.Translation(centre)
               @ Euler([rng.uniform(0.0, math.tau) for _ in range(3)], 'XYZ').to_matrix().to_4x4()
               @ Matrix.Diagonal((s * rng.uniform(0.8, 1.25), s * rng.uniform(0.7, 1.1), s * rng.uniform(0.5, 0.85), 1.0)))
        made = bmesh.ops.create_icosphere(body, subdivisions=1, radius=1.0, matrix=mat)['verts']
        for v in made:
            v.co = centre + (v.co - centre) * rng.uniform(0.72, 1.12)
        shade = _mix(np.array([tn['a']]), tn['fresh'], [rng.uniform(0.2, 0.6)])[0] * rng.uniform(0.85, 1.0)
        samples.append(np.array([v.co[:] for v in made]))
        tints.append(np.tile(shade, (len(made), 1)))

    # centre the bounding box and scale the farthest vertex to exactly 1 m
    co = np.array([v.co[:] for v in body.verts], dtype=np.float64)
    c = (co.min(axis=0) + co.max(axis=0)) * 0.5
    rmax = float(np.linalg.norm(co - c, axis=1).max())
    for v in body.verts:
        v.co = (v.co - Vector(c)) / rmax
    samples = (np.concatenate(samples) - c) / rmax
    tints = np.concatenate(tints)

    m = L.Model(key, 'asteroid', 1.0)
    p = m.part()
    p.bm.free()
    p.bm = body
    mi = p.mi('rock')
    for f in body.faces:
        f.material_index = mi
    m.add(p)
    return K.finish(m, sharp=sharp, ao=ao, ao_distance=0.45, export=export, preview=preview,
                    direction=direction, zoom=0.85,
                    post=lambda mm: _paint(mm.object, samples, tints, len(P)))
