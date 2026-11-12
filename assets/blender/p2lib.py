"""p2lib - shared helpers for the PRIMACY2 Blender asset generators.

Everything a generator needs lives here: scene and collection handling, the
material palette, mesh builders (lofted hulls, wings, lathes, prisms, tubes,
greebles), bevel and shading setup, attachment empties, ambient-occlusion
baking into the "Col" colour attribute, GLB export with verification and
EEVEE preview rendering.

Conventions (see docs/ARCHITECTURE.md section 2):
  Blender:  +X right, +Y nose, +Z top, metres.
  glTF:     +X right, +Y top,  -Z nose (the exporter's +Y-up conversion).
  A game/glTF point (x, y, z) is the Blender point (x, -z, y).

The generators never touch datablocks they did not create. Everything lives in
the scene "P2_Assets", one collection "P2_<key>" per model.
"""

import bpy
import bmesh
import json
import math
import os
import random
import struct
from contextlib import contextmanager
from mathutils import Euler, Matrix, Vector

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..'))
MODELS_DIR = os.path.join(REPO, 'packages', 'client', 'public', 'models')
PREVIEW_DIR = os.path.join(HERE, 'previews')
BLEND_PATH = os.path.join(HERE, 'primacy2_assets.blend')

SCENE = 'P2_Assets'
STAGE = 'P2_Stage'
WORLD = 'P2_World'
PREFIX = 'P2_'
SEP = ':'  # in-file empties are named "<key>:<name>" and renamed for export

# Triangle budgets per kind (min, max) and the size limit of one GLB.
BUDGETS = {
    'ship': (6000, 20000),
    'station': (0, 50000),
    'gate': (0, 25000),
    'prop': (0, 3000),
    'asteroid': (800, 2500),
    'cockpit': (0, 6000),
}
MAX_GLB_BYTES = 2 * 1024 * 1024

# ---------------------------------------------------------------------------------------------
# Palette. Colours are linear RGB. Only Principled BSDF values, nothing procedural, so every
# material survives the glTF export and the game can restyle them by name.
# ---------------------------------------------------------------------------------------------

PALETTE = {
    'hull_primary': dict(color=(0.58, 0.60, 0.62), metallic=0.6, roughness=0.45),
    'hull_secondary': dict(color=(0.065, 0.07, 0.08), metallic=0.6, roughness=0.5),
    'hull_dark': dict(color=(0.014, 0.015, 0.018), metallic=0.8, roughness=0.6),
    'hull_accent': dict(color=(0.8, 0.35, 0.03), metallic=0.6, roughness=0.45),
    'glass': dict(color=(0.012, 0.04, 0.11), metallic=0.9, roughness=0.08),
    'emissive_engine': dict(color=(0.5, 0.72, 1.0), metallic=0.0, roughness=0.5,
                            emission=(0.42, 0.7, 1.0), strength=6.0),
    'emissive_light': dict(color=(1.0, 0.88, 0.68), metallic=0.0, roughness=0.5,
                           emission=(1.0, 0.85, 0.6), strength=4.0),
    'emissive_accent': dict(color=(0.05, 0.75, 0.9), metallic=0.0, roughness=0.5,
                            emission=(0.05, 0.85, 1.0), strength=3.0),
    # structures and props
    'rock': dict(color=(0.17, 0.14, 0.12), metallic=0.0, roughness=0.95),
    'portal': dict(color=(0.02, 0.3, 0.42), metallic=0.0, roughness=0.4,
                   emission=(0.1, 0.8, 1.0), strength=2.5),
    'cockpit_frame': dict(color=(0.028, 0.03, 0.034), metallic=0.7, roughness=0.5),
    'cockpit_panel': dict(color=(0.075, 0.08, 0.09), metallic=0.3, roughness=0.65),
}


def gltf_to_blender(p):
    """Game/glTF (x right, y up, z back) to Blender (x right, y forward, z up)."""
    return (p[0], -p[2], p[1])


def blender_to_gltf(p):
    return (p[0], p[2], -p[1])


def material(name, base=None, **override):
    """Get or create the Principled material `name` and (re)apply its palette values."""
    spec = dict(PALETTE.get(base or name, PALETTE['hull_primary']))
    spec.update(override)
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        nt.nodes.clear()
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    col = tuple(spec['color'])[:3]
    bsdf.inputs['Base Color'].default_value = col + (1.0,)
    bsdf.inputs['Metallic'].default_value = spec.get('metallic', 0.0)
    bsdf.inputs['Roughness'].default_value = spec.get('roughness', 0.5)
    em = spec.get('emission')
    bsdf.inputs['Emission Color'].default_value = (tuple(em)[:3] if em else (0.0, 0.0, 0.0)) + (1.0,)
    bsdf.inputs['Emission Strength'].default_value = spec.get('strength', 0.0) if em else 0.0
    mat.use_backface_culling = True  # exported as single sided
    mat.diffuse_color = col + (1.0,)
    mat.metallic = spec.get('metallic', 0.0)
    mat.roughness = spec.get('roughness', 0.5)
    return mat


def is_emissive(name):
    return name.startswith('emissive_') or name == 'portal'


# ---------------------------------------------------------------------------------------------
# Scene, collections, context
# ---------------------------------------------------------------------------------------------

def get_scene():
    sc = bpy.data.scenes.get(SCENE)
    if sc is None:
        sc = bpy.data.scenes.new(SCENE)
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    return sc


@contextmanager
def scene_active(sc=None):
    """Make P2_Assets the window's scene for operators (export, bake, render), then restore.

    A plain temp_override is not enough: the glTF exporter and the view layer
    sync both read the window's scene. In background mode without a window the
    override is the only option.
    """
    sc = sc or get_scene()
    win = bpy.context.window
    if win is None:
        with bpy.context.temp_override(scene=sc, view_layer=sc.view_layers[0]):
            yield sc
        return
    prev = win.scene
    if prev == sc:
        yield sc
        return
    win.scene = sc
    try:
        yield sc
    finally:
        try:
            win.scene = prev
        except Exception:
            pass


def get_collection(key):
    """Collection "P2_<key>", linked into the P2_Assets scene."""
    sc = get_scene()
    name = PREFIX + key
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    if col.name not in sc.collection.children:
        sc.collection.children.link(col)
    return col


def clear_collection(col):
    """Remove the objects of one of our collections together with their orphaned data."""
    if not col.name.startswith(PREFIX):
        raise RuntimeError('refusing to clear a collection that is not ours: ' + col.name)
    datas = []
    for ob in list(col.objects):
        if ob.data is not None:
            datas.append(ob.data)
        bpy.data.objects.remove(ob, do_unlink=True)
    for d in datas:
        if d.users == 0:
            if isinstance(d, bpy.types.Mesh):
                bpy.data.meshes.remove(d)
            elif isinstance(d, bpy.types.Camera):
                bpy.data.cameras.remove(d)
            elif isinstance(d, bpy.types.Light):
                bpy.data.lights.remove(d)


def isolate(key):
    """Hide every other model collection from render (all models sit at the origin)."""
    sc = get_scene()
    for c in sc.collection.children:
        if c.name.startswith(PREFIX) and c.name != STAGE:
            c.hide_render = (c.name != PREFIX + key)


# ---------------------------------------------------------------------------------------------
# Lofted hull description
# ---------------------------------------------------------------------------------------------

def S(y, w, t, b=None, n=2.5, nb=None, zc=0.0, x=0.0, sub=None):
    """One hull station: y position, half-width, height above and below the section centre,
    superellipse exponent for the top (n) and bottom (nb) half (2 = ellipse, 5+ = boxy),
    vertical (zc) and lateral (x) offset of the section centre, optional ring count to the
    next station."""
    return dict(y=y, w=w, t=t, b=t if b is None else b, n=n, nb=n if nb is None else nb,
                zc=zc, x=x, sub=sub)


_KEYS = ('w', 't', 'b', 'n', 'nb', 'zc', 'x')


def _pchip_slopes(xs, ys):
    n = len(xs)
    if n < 2:
        return [0.0] * n
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0.0:
            m[i] = 0.0
        else:
            w1 = 2.0 * h[i] + h[i - 1]
            w2 = h[i] + 2.0 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    return m


def _sgnpow(v, e):
    return math.copysign(abs(v) ** e, v)


class Loft:
    """An analytic hull: superellipse cross-sections interpolated along Y.

    The same object skins the mesh and answers surface queries, so strips,
    windows and greebles can be placed exactly on the hull.
    """

    def __init__(self, stations, smooth=True):
        self.st = sorted(stations, key=lambda s: s['y'])
        self.ys = [s['y'] for s in self.st]
        for i in range(len(self.ys) - 1):
            if self.ys[i + 1] - self.ys[i] < 1e-5:
                raise ValueError('loft stations need strictly increasing y')
        self.smooth = smooth
        self.vals = {k: [s[k] for s in self.st] for k in _KEYS}
        self.slopes = {k: _pchip_slopes(self.ys, self.vals[k]) for k in _KEYS}
        self.y0, self.y1 = self.ys[0], self.ys[-1]

    def params(self, y):
        ys = self.ys
        y = min(max(y, ys[0]), ys[-1])
        i = 0
        while i < len(ys) - 2 and y > ys[i + 1]:
            i += 1
        h = ys[i + 1] - ys[i]
        u = (y - ys[i]) / h
        out = {}
        for k in _KEYS:
            a, b = self.vals[k][i], self.vals[k][i + 1]
            if self.smooth:
                m0, m1 = self.slopes[k][i] * h, self.slopes[k][i + 1] * h
                u2, u3 = u * u, u * u * u
                out[k] = ((2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * m0
                          + (-2 * u3 + 3 * u2) * b + (u3 - u2) * m1)
            else:
                out[k] = a + (b - a) * u
        return out

    @staticmethod
    def section(p, a):
        """Point (x, z) of the cross-section `p` at angle a (radians; 0 = +X, 90 deg = top)."""
        c, s = math.cos(a), math.sin(a)
        if abs(c) < 1e-9:
            c = 0.0
        if abs(s) < 1e-9:
            s = 0.0
        if s >= 0.0:
            e, hgt = 2.0 / p['n'], p['t']
        else:
            e, hgt = 2.0 / p['nb'], p['b']
        return (p['w'] * _sgnpow(c, e) + p['x'], hgt * _sgnpow(s, e) + p['zc'])

    def point(self, y, a_deg, lift=0.0):
        x, z = self.section(self.params(y), math.radians(a_deg))
        p = Vector((x, y, z))
        if lift:
            p += self.normal(y, a_deg) * lift
        return p

    def frame(self, y, a_deg):
        """(position, outward normal, tangent along +Y, tangent around the section)."""
        dy = 0.02
        da = 1.0
        ya = min(max(y - dy, self.y0), self.y1)
        yb = min(max(y + dy, self.y0), self.y1)
        p = self.point(y, a_deg)
        ty = (self.point(yb, a_deg) - self.point(ya, a_deg))
        ta = (self.point(y, a_deg + da) - self.point(y, a_deg - da))
        if ty.length < 1e-9:
            ty = Vector((0, 1, 0))
        if ta.length < 1e-9:
            ta = Vector((-math.sin(math.radians(a_deg)), 0, math.cos(math.radians(a_deg))))
        ty.normalize()
        ta.normalize()
        n = ty.cross(ta)
        if n.length < 1e-9:
            n = Vector((math.cos(math.radians(a_deg)), 0, math.sin(math.radians(a_deg))))
        n.normalize()
        return p, n, ty, ta

    def normal(self, y, a_deg):
        return self.frame(y, a_deg)[1]

    def top(self, y):
        p = self.params(y)
        return p['zc'] + p['t']

    def bottom(self, y):
        p = self.params(y)
        return p['zc'] - p['b']

    def halfwidth(self, y):
        return self.params(y)['w']

    def rings(self, spacing):
        out = [self.ys[0]]
        for i in range(len(self.ys) - 1):
            a, b = self.ys[i], self.ys[i + 1]
            n = self.st[i].get('sub')
            if not n:
                n = max(1, int(math.ceil((b - a) / spacing - 1e-6)))
            for k in range(1, n + 1):
                out.append(a + (b - a) * k / n)
        return out


def _mkface(bm, verts, mi, want=None):
    try:
        f = bm.faces.new(verts)
    except ValueError:
        return None
    f.material_index = mi
    if want is not None:
        f.normal_update()
        if f.normal.dot(want) < 0.0:
            f.normal_flip()
    return f


def rect(w, h):
    """Rectangle profile (x, z), full width w and height h."""
    return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]


def octo(w, h, c):
    """Rectangle with chamfered corners (chamfer c); a cheap pre-bevelled section."""
    a, b = w / 2, h / 2
    return [(-a + c, -b), (a - c, -b), (a, -b + c), (a, b - c), (a - c, b), (-a + c, b), (-a, b - c), (-a, -b + c)]


def ngon(r, n, phase=0.0):
    return [(r * math.cos(phase + 2 * math.pi * k / n), r * math.sin(phase + 2 * math.pi * k / n)) for k in range(n)]


class Grid:
    """The quad grid of a lofted hull, addressable by y range and section angle."""

    def __init__(self, part, loft, ys, segs, faces, rings, caps):
        self.part, self.loft, self.ys, self.segs = part, loft, ys, segs
        self.faces, self.rings, self.caps = faces, rings, caps

    def block(self, y0, y1, a0, a1):
        """Valid faces whose centre lies in [y0, y1] and whose mid angle lies in [a0, a1] deg."""
        out = []
        step = 360.0 / self.segs
        for i, row in enumerate(self.faces):
            ym = 0.5 * (self.ys[i] + self.ys[i + 1])
            if ym < y0 or ym > y1:
                continue
            for j, f in enumerate(row):
                if f.is_valid and ((j + 0.5) * step - a0) % 360.0 <= (a1 - a0):
                    out.append(f)
        return out

    def sym(self, y0, y1, a0, a1):
        """block() plus its mirror image across the YZ plane."""
        fs = self.block(y0, y1, a0, a1)
        seen = set(fs)
        for f in self.block(y0, y1, 180.0 - a1, 180.0 - a0):
            if f not in seen:
                fs.append(f)
        return fs

    def paint(self, y0, y1, a0, a1, mat, sym=True):
        fs = self.sym(y0, y1, a0, a1) if sym else self.block(y0, y1, a0, a1)
        mi = self.part.mi(mat)
        for f in fs:
            f.material_index = mi
        return fs

    def panels(self, y_cuts, a_cuts, width=0.03, depth=0.012, rim='hull_dark'):
        """Cut the hull into raised panels separated by V grooves.

        a_cuts lists the right-hand cut angles in degrees (between -90 and 90);
        they are mirrored to the left side. The strips across the top and bottom
        centre lines stay in one piece.
        """
        right = sorted(a_cuts)
        full = right + [180.0 - a for a in reversed(right)]
        full.append(full[0] + 360.0)
        n = 0
        for yi in range(len(y_cuts) - 1):
            for ai in range(len(full) - 1):
                if full[ai + 1] - full[ai] < 1e-6:
                    continue
                fs = self.block(y_cuts[yi], y_cuts[yi + 1], full[ai], full[ai + 1])
                if fs:
                    self.part.inset(fs, width, depth, rim=rim)
                    n += 1
        return n

    def ribbon(self, y0, y1, a_deg, width, lift=0.02, mat='emissive_accent', n=None, sym=True):
        """A thin raised strip following the hull at section angle a_deg."""
        angles = [a_deg, 180.0 - a_deg] if sym and abs(math.cos(math.radians(a_deg))) > 1e-6 else [a_deg]
        for a in angles:
            self.part.ribbon(self.loft, y0, y1, a, width, lift, mat, n)

    def windows(self, y0, y1, a_deg, count, length, height, lift=0.02, mat='emissive_light', sym=True):
        """A row of small emissive windows between y0 and y1 at section angle a_deg."""
        angles = [a_deg, 180.0 - a_deg] if sym else [a_deg]
        for a in angles:
            for k in range(count):
                yc = y0 + (y1 - y0) * (k + 0.5) / count
                self.part.ribbon(self.loft, yc - length / 2, yc + length / 2, a, height, lift, mat, 1)

    def greebles(self, y0, y1, a0, a1, count, size=(0.1, 0.35), height=(0.03, 0.12), seed=1,
                 mats=('hull_dark', 'hull_secondary'), sym=True):
        """Random small boxes sitting on the hull inside the given patch."""
        rng = random.Random(seed)
        mis = [self.part.mi(m) for m in mats]
        for _ in range(count):
            y = rng.uniform(y0, y1)
            a = rng.uniform(a0, a1)
            su, sv = rng.uniform(*size), rng.uniform(*size)
            h = rng.uniform(*height)
            mi = rng.choice(mis)
            for aa in ([a, 180.0 - a] if sym else [a]):
                p, nrm, ty, ta = self.loft.frame(y, aa)
                ta = nrm.cross(ty).normalized()
                _box_on(self.part.bm, p - nrm * 0.03, ty, ta, nrm, su, sv, h + 0.03, mi)


def _box_on(bm, pos, tu, tv, tn, su, sv, h, mi, top_mi=None):
    """Open-bottomed box standing on a surface point."""
    lo, hi = [], []
    for (a, b) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        base = pos + tu * (a * su * 0.5) + tv * (b * sv * 0.5)
        lo.append(bm.verts.new(base))
        hi.append(bm.verts.new(base + tn * h))
    faces = [_mkface(bm, hi, mi if top_mi is None else top_mi, tn)]
    centre = pos + tn * (h * 0.5)
    for k in range(4):
        k2 = (k + 1) % 4
        mid = (lo[k].co + lo[k2].co) * 0.5
        faces.append(_mkface(bm, (lo[k], lo[k2], hi[k2], hi[k]), mi, mid - centre))
    return faces


# ---------------------------------------------------------------------------------------------
# Part: one sub-assembly in its own bmesh
# ---------------------------------------------------------------------------------------------

class Part:
    def __init__(self, model):
        self.model = model
        self.bm = bmesh.new()

    def mi(self, mat):
        return self.model.mat(mat)

    # -- primitives ---------------------------------------------------------------------------

    def loft(self, stations, segs=24, mat='hull_primary', spacing=0.6, smooth=True,
             cap0=True, cap1=True, cap_mat=None):
        """Skin a hull from stations (see S). Returns a Grid."""
        lf = stations if isinstance(stations, Loft) else Loft(stations, smooth)
        ys = lf.rings(spacing)
        bm, mi = self.bm, self.mi(mat)
        rings = []
        for y in ys:
            p = lf.params(y)
            rings.append([bm.verts.new((lambda xz: (xz[0], y, xz[1]))(Loft.section(p, 2 * math.pi * j / segs)))
                          for j in range(segs)])
        faces = []
        for i in range(len(ys) - 1):
            row = []
            for j in range(segs):
                j2 = (j + 1) % segs
                f = bm.faces.new((rings[i][j], rings[i + 1][j], rings[i + 1][j2], rings[i][j2]))
                f.material_index = mi
                row.append(f)
            faces.append(row)
        cmi = self.mi(cap_mat or mat)
        caps = [None, None]
        if cap0:
            caps[0] = _mkface(bm, rings[0], cmi, Vector((0, -1, 0)))
        if cap1:
            caps[1] = _mkface(bm, rings[-1], cmi, Vector((0, 1, 0)))
        return Grid(self, lf, ys, segs, faces, rings, caps)

    def lathe(self, profile, segs=16, mat='hull_primary', mats=None, axis='Y', origin=(0, 0, 0)):
        """Revolve a (position along axis, radius) profile. mats: one material per span."""
        bm = self.bm
        o = Vector(origin)

        def place(t, r, a):
            c, s = r * math.cos(a), r * math.sin(a)
            if axis == 'Y':
                return o + Vector((c, t, s))
            if axis == 'Z':
                return o + Vector((c, s, t))
            return o + Vector((t, c, s))

        rings = []
        for (t, r) in profile:
            if r <= 1e-6:
                rings.append([bm.verts.new(place(t, 0.0, 0.0))])
            else:
                rings.append([bm.verts.new(place(t, r, 2 * math.pi * k / segs)) for k in range(segs)])
        rows = []
        for i in range(len(rings) - 1):
            mi = self.mi(mats[i] if mats else mat)
            ra, rb = rings[i], rings[i + 1]
            row = []
            for k in range(segs):
                k2 = (k + 1) % segs
                if len(ra) == 1 and len(rb) == 1:
                    continue
                if len(ra) == 1:
                    f = _mkface(bm, (ra[0], rb[k], rb[k2]), mi)
                elif len(rb) == 1:
                    f = _mkface(bm, (ra[k], rb[0], ra[k2]), mi)
                else:
                    f = _mkface(bm, (ra[k], rb[k], rb[k2], ra[k2]), mi)
                if f:
                    row.append(f)
            rows.append(row)
        allf = [f for row in rows for f in row]
        if allf:
            bmesh.ops.recalc_face_normals(bm, faces=allf)
        return rows

    def prism(self, profile, y0, y1, mat='hull_primary', scale0=(1, 1), scale1=(1, 1),
              offset0=(0, 0), offset1=(0, 0), cap_mat=None):
        """Extrude an (x, z) profile from y0 to y1; either end can be scaled and shifted."""
        bm, mi = self.bm, self.mi(mat)
        a = [bm.verts.new((x * scale0[0] + offset0[0], y0, z * scale0[1] + offset0[1])) for x, z in profile]
        b = [bm.verts.new((x * scale1[0] + offset1[0], y1, z * scale1[1] + offset1[1])) for x, z in profile]
        n = len(profile)
        sides = []
        for k in range(n):
            k2 = (k + 1) % n
            sides.append(_mkface(bm, (a[k], a[k2], b[k2], b[k]), mi))
        cmi = self.mi(cap_mat or mat)
        c0 = _mkface(bm, a, cmi)
        c1 = _mkface(bm, b, cmi)
        fs = [f for f in sides + [c0, c1] if f]
        bmesh.ops.recalc_face_normals(bm, faces=fs)
        return dict(sides=sides, cap0=c0, cap1=c1, verts=a + b)

    def box(self, center, size, mat='hull_primary', taper=(1, 1), rot=None, chamfer=0.0):
        """Box centred at `center`; taper scales the +Y end; rot = Euler degrees about the centre."""
        sx, sy, sz = size
        prof = octo(sx, sz, chamfer) if chamfer > 0 else rect(sx, sz)
        r = self.prism(prof, -sy / 2, sy / 2, mat, scale1=taper)
        m = Matrix.Translation(Vector(center))
        if rot:
            m = m @ Euler([math.radians(v) for v in rot], 'XYZ').to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=m, verts=r['verts'])
        return r

    def tube(self, p0, p1, r0, r1=None, segs=8, mat='hull_dark', cap0=True, cap1=True, cap_mat=None):
        """Cylinder or cone between two points."""
        bm, mi = self.bm, self.mi(mat)
        p0, p1 = Vector(p0), Vector(p1)
        r1 = r0 if r1 is None else r1
        d = (p1 - p0).normalized()
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        u = d.cross(ref).normalized()
        v = d.cross(u).normalized()
        ra = [bm.verts.new(p0 + (u * math.cos(2 * math.pi * k / segs) + v * math.sin(2 * math.pi * k / segs)) * r0)
              for k in range(segs)]
        rb = [bm.verts.new(p1 + (u * math.cos(2 * math.pi * k / segs) + v * math.sin(2 * math.pi * k / segs)) * r1)
              for k in range(segs)]
        sides = []
        for k in range(segs):
            k2 = (k + 1) % segs
            mid = (ra[k].co + ra[k2].co + rb[k].co + rb[k2].co) * 0.25
            axis_pt = p0 + d * (mid - p0).dot(d)
            sides.append(_mkface(bm, (ra[k], ra[k2], rb[k2], rb[k]), mi, mid - axis_pt))
        cmi = self.mi(cap_mat or mat)
        c0 = _mkface(bm, ra, cmi, -d) if cap0 else None
        c1 = _mkface(bm, rb, cmi, d) if cap1 else None
        return dict(sides=sides, cap0=c0, cap1=c1, verts=ra + rb)

    def pipe(self, pts, r, segs=6, mat='hull_dark'):
        """Round pipe through a polyline (simple mitred joints)."""
        pts = [Vector(p) for p in pts]
        for a, b in zip(pts[:-1], pts[1:]):
            self.tube(a, b, r, r, segs, mat)
        for p in pts[1:-1]:
            self.lathe([(-r, 0.0), (-r * 0.7, r * 0.75), (0, r * 1.05), (r * 0.7, r * 0.75), (r, 0.0)],
                       segs, mat, origin=p)

    def wing(self, sections, mat='hull_primary', sub=1, cap_root=True, cap_tip=True, le=0.16, te=0.3,
             edge_mat=None):
        """Hexagonal-section wing through sections (x, z, y_le, y_te, thickness).

        The thickness direction is perpendicular to the span in the XZ plane, so
        the same call makes wings, canted fins and vertical tails. Returns the
        faces grouped as top / bottom / le / te (lists per span segment).
        """
        bm, mi = self.bm, self.mi(mat)
        emi = self.mi(edge_mat) if edge_mat else mi
        secs = []
        for i in range(len(sections) - 1):
            a, b = sections[i], sections[i + 1]
            for k in range(sub):
                u = k / sub
                secs.append(tuple(a[q] + (b[q] - a[q]) * u for q in range(5)))
        secs.append(tuple(sections[-1]))
        rings = []
        for i, (x, z, yle, yte, th) in enumerate(secs):
            j0, j1 = max(i - 1, 0), min(i + 1, len(secs) - 1)
            d = Vector((secs[j1][0] - secs[j0][0], 0.0, secs[j1][1] - secs[j0][1]))
            d.normalize()
            up = Vector((-d.z, 0.0, d.x))
            c = yle - yte
            h = th * 0.5
            pts = [(yle, 0.0), (yle - c * le, h), (yte + c * te, h), (yte, 0.0), (yte + c * te, -h), (yle - c * le, -h)]
            rings.append([bm.verts.new(Vector((x, y, z)) + up * dz) for (y, dz) in pts])
        out = dict(top=[], bottom=[], le=[], te=[], caps=[])
        names = ['le', 'top', 'te', 'te', 'bottom', 'le']
        for i in range(len(rings) - 1):
            for k in range(6):
                k2 = (k + 1) % 6
                use = emi if names[k] in ('le',) and edge_mat else mi
                f = _mkface(bm, (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), use)
                if f:
                    out[names[k]].append(f)
        if cap_root:
            out['caps'].append(_mkface(bm, rings[0], mi))
        if cap_tip:
            out['caps'].append(_mkface(bm, rings[-1], mi))
        fs = [f for k in ('top', 'bottom', 'le', 'te', 'caps') for f in out[k] if f]
        bmesh.ops.recalc_face_normals(bm, faces=fs)
        return out

    def plate(self, outline, thickness, mat='hull_primary', plane='XY', offset=0.0):
        """Flat plate from a 2D outline: 'XY' outline of (x, y) extruded along Z, 'YZ' outline
        of (y, z) extruded along X, 'XZ' outline of (x, z) extruded along Y. Centred on offset."""
        bm, mi = self.bm, self.mi(mat)
        h = thickness * 0.5

        def co(p, d):
            if plane == 'XY':
                return (p[0], p[1], offset + d)
            if plane == 'YZ':
                return (offset + d, p[0], p[1])
            return (p[0], offset + d, p[1])

        a = [bm.verts.new(co(p, -h)) for p in outline]
        b = [bm.verts.new(co(p, h)) for p in outline]
        n = len(outline)
        fs = [_mkface(bm, (a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]), mi) for k in range(n)]
        lo = _mkface(bm, a, mi)
        hi = _mkface(bm, b, mi)
        allf = [f for f in fs + [lo, hi] if f]
        bmesh.ops.recalc_face_normals(bm, faces=allf)
        return dict(sides=fs, lo=lo, hi=hi, verts=a + b)

    def ribbon(self, loft, y0, y1, a_deg, width, lift=0.02, mat='emissive_accent', n=None):
        """Raised strip on a Loft surface from y0 to y1 at angle a_deg (top + two side walls)."""
        bm, mi = self.bm, self.mi(mat)
        if n is None:
            n = max(1, int(math.ceil(abs(y1 - y0) / 0.5)))
        rows = []
        for k in range(n + 1):
            y = y0 + (y1 - y0) * k / n
            p, nrm, ty, ta = loft.frame(y, a_deg)
            side = nrm.cross(ty).normalized()
            rows.append((
                bm.verts.new(p - side * (width / 2) - nrm * 0.02),
                bm.verts.new(p - side * (width / 2) + nrm * lift),
                bm.verts.new(p + side * (width / 2) + nrm * lift),
                bm.verts.new(p + side * (width / 2) - nrm * 0.02),
                nrm, side, ty))
        for k in range(n):
            a, b = rows[k], rows[k + 1]
            nrm, side = a[4], a[5]
            _mkface(bm, (a[1], a[2], b[2], b[1]), mi, nrm)
            _mkface(bm, (a[0], a[1], b[1], b[0]), mi, -side)
            _mkface(bm, (a[2], a[3], b[3], b[2]), mi, side)
        _mkface(bm, rows[0][:4], mi, -rows[0][6])
        _mkface(bm, rows[-1][:4], mi, rows[-1][6])

    def strip(self, p0, p1, width, normal, lift=0.02, mat='emissive_accent'):
        """Straight raised strip between two points on a flat surface with the given normal."""
        bm, mi = self.bm, self.mi(mat)
        p0, p1, nrm = Vector(p0), Vector(p1), Vector(normal).normalized()
        d = (p1 - p0).normalized()
        side = nrm.cross(d).normalized() * (width / 2)
        a = [bm.verts.new(p0 - side - nrm * 0.02), bm.verts.new(p0 - side + nrm * lift),
             bm.verts.new(p0 + side + nrm * lift), bm.verts.new(p0 + side - nrm * 0.02)]
        b = [bm.verts.new(p1 - side - nrm * 0.02), bm.verts.new(p1 - side + nrm * lift),
             bm.verts.new(p1 + side + nrm * lift), bm.verts.new(p1 + side - nrm * 0.02)]
        _mkface(bm, (a[1], a[2], b[2], b[1]), mi, nrm)
        _mkface(bm, (a[0], a[1], b[1], b[0]), mi, -side)
        _mkface(bm, (a[2], a[3], b[3], b[2]), mi, side)
        _mkface(bm, a, mi, -d)
        _mkface(bm, b, mi, d)

    def greebles(self, origin, u, v, count, size=(0.1, 0.4), height=(0.03, 0.15), seed=1,
                 mats=('hull_dark', 'hull_secondary')):
        """Random boxes on the flat rectangle origin + s*u + t*v (normal = u x v)."""
        rng = random.Random(seed)
        o, u, v = Vector(origin), Vector(u), Vector(v)
        nrm = u.cross(v).normalized()
        un, vn = u.normalized(), v.normalized()
        mis = [self.mi(m) for m in mats]
        for _ in range(count):
            su = min(rng.uniform(*size), u.length * 0.9)
            sv = min(rng.uniform(*size), v.length * 0.9)
            s = rng.uniform(su / 2, u.length - su / 2) / u.length
            t = rng.uniform(sv / 2, v.length - sv / 2) / v.length
            _box_on(self.bm, o + u * s + v * t - nrm * 0.02, un, vn, nrm, su, sv,
                    rng.uniform(*height) + 0.02, rng.choice(mis))

    def engine(self, y_exit, r, length, segs=16, shell='hull_dark', lip='hull_secondary', origin=(0, 0, 0)):
        """Engine bell pointing toward -Y with a glowing throat. `y_exit` is the nozzle plane."""
        L = length
        prof = [
            (y_exit + L, 0.0), (y_exit + L, r * 0.72), (y_exit + L * 0.55, r * 0.8), (y_exit + L * 0.5, r * 0.92),
            (y_exit + L * 0.12, r), (y_exit, r * 0.97), (y_exit, r * 0.86),
            (y_exit + L * 0.3, r * 0.74), (y_exit + L * 0.34, r * 0.6), (y_exit + L * 0.42, r * 0.22),
            (y_exit + L * 0.3, 0.0),
        ]
        mats = [shell, shell, lip, lip, lip, lip, shell, 'emissive_engine', 'emissive_engine', shell]
        return self.lathe(prof, segs, mats=mats, origin=origin)

    # -- operations ---------------------------------------------------------------------------

    def faces(self, normal=None, tol=0.8, min_area=0.0, mat=None, where=None):
        """Pick faces by direction, size, material or a predicate on the face centre."""
        self.bm.normal_update()
        want = Vector(normal).normalized() if normal is not None else None
        mi = self.mi(mat) if mat else None
        out = []
        for f in self.bm.faces:
            if want is not None and f.normal.dot(want) < tol:
                continue
            if mi is not None and f.material_index != mi:
                continue
            if min_area and f.calc_area() < min_area:
                continue
            if where is not None and not where(f.calc_center_median()):
                continue
            out.append(f)
        return out

    def paint(self, faces, mat):
        mi = self.mi(mat)
        for f in faces:
            if f is not None and f.is_valid:
                f.material_index = mi

    def inset(self, faces, thickness, depth=0.0, rim=None, inner=None, individual=False):
        """Inset faces; depth > 0 raises the inner faces, depth < 0 sinks them. Returns rim faces."""
        faces = [f for f in faces if f is not None and f.is_valid]
        if not faces:
            return []
        if individual:
            r = bmesh.ops.inset_individual(self.bm, faces=faces, thickness=thickness, depth=depth,
                                           use_even_offset=True)
        else:
            r = bmesh.ops.inset_region(self.bm, faces=faces, thickness=thickness, depth=depth,
                                       use_even_offset=True, use_boundary=True)
        rimf = r['faces']
        if rim:
            self.paint(rimf, rim)
        if inner:
            self.paint(faces, inner)
        return rimf

    def vent(self, face, bars=4, margin=0.05, depth=0.05, frame='hull_secondary', slot='hull_dark'):
        """Turn a quad into a recessed vent: sunken dark floor with raised bars across it."""
        if face is None or not face.is_valid:
            return
        self.inset([face], margin, -depth, rim=frame, inner=slot)
        vs = [v.co.copy() for v in face.verts]
        if len(vs) != 4:
            return
        face.normal_update()
        nrm = face.normal.copy()
        e0, e1 = vs[1] - vs[0], vs[3] - vs[0]
        if e0.length < e1.length:
            vs = [vs[1], vs[2], vs[3], vs[0]]
            e0, e1 = vs[1] - vs[0], vs[3] - vs[0]
        mi = self.mi(frame)
        for k in range(bars):
            t = (k + 0.5) / bars
            a = vs[0] + e0 * t
            _box_on(self.bm, a + e1 * 0.5, e0.normalized(), e1.normalized(), nrm,
                    e0.length / bars * 0.45, e1.length, depth * 0.8, mi)

    def sharp_edges(self, angle=40.0):
        self.bm.normal_update()
        lim = math.radians(angle)
        return [e for e in self.bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim]

    def bevel(self, width=0.03, segments=2, angle=40.0, edges=None):
        """Bevel every edge sharper than `angle` (or the given edges)."""
        if edges is None:
            edges = self.sharp_edges(angle)
        edges = [e for e in edges if e.is_valid]
        if edges and width > 0:
            bmesh.ops.bevel(self.bm, geom=edges, offset=width, offset_type='OFFSET', segments=segments,
                            profile=0.5, affect='EDGES', clamp_overlap=True)
        return self

    def xform(self, matrix, verts=None):
        bmesh.ops.transform(self.bm, matrix=matrix, verts=verts if verts is not None else self.bm.verts)
        return self

    def move(self, x=0.0, y=0.0, z=0.0, verts=None):
        return self.xform(Matrix.Translation((x, y, z)), verts)

    def rot(self, axis, deg, center=(0, 0, 0), verts=None):
        c = Vector(center)
        m = Matrix.Translation(c) @ Matrix.Rotation(math.radians(deg), 4, axis) @ Matrix.Translation(-c)
        return self.xform(m, verts)

    def scale(self, sx=1.0, sy=1.0, sz=1.0, verts=None):
        return self.xform(Matrix.Diagonal((sx, sy, sz, 1.0)), verts)

    def mark(self):
        return len(self.bm.verts)

    def since(self, mark):
        """Vertices created after mark() (valid while nothing was deleted in between)."""
        return list(self.bm.verts)[mark:]


# ---------------------------------------------------------------------------------------------
# Model: collects parts, attachment points and metadata, then becomes Blender objects
# ---------------------------------------------------------------------------------------------

class Model:
    def __init__(self, key, kind='ship', radius=None, hardpoints=None):
        self.key, self.kind, self.radius = key, kind, radius
        self.hardpoints = [tuple(h) for h in (hardpoints or [])]
        self.bm = bmesh.new()
        self.mat_names = []
        self.variants = {}
        self.empties = []
        self.props = {}
        self.stats = {}
        for i, h in enumerate(self.hardpoints):
            self.empty('hardpoint_%d' % i, gltf_to_blender(h))

    def mat(self, name):
        if name not in self.mat_names:
            self.mat_names.append(name)
        return self.mat_names.index(name)

    def variant(self, base, **spec):
        """Per-model material "<base>_<key>" with its own colour values."""
        name = '%s_%s' % (base, self.key)
        self.variants[name] = dict(base=base, **spec)
        return name

    def part(self):
        return Part(self)

    def _merge(self, bm):
        tmp = bpy.data.meshes.new('p2_tmp_merge')
        bm.to_mesh(tmp)
        self.bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)

    def add(self, part, mirror=False, matrix=None, only_mirror=False):
        """Merge a part into the model; mirror=True also adds its image across the YZ plane."""
        bm = part.bm
        if matrix is not None:
            bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
        if not only_mirror:
            self._merge(bm)
        if mirror or only_mirror:
            b2 = bm.copy()
            bmesh.ops.scale(b2, vec=(-1.0, 1.0, 1.0), verts=b2.verts)
            bmesh.ops.reverse_faces(b2, faces=b2.faces)
            self._merge(b2)
            b2.free()
        bm.free()

    def empty(self, name, loc, **extras):
        self.empties.append((name, tuple(loc), extras))

    def empties_sym(self, base, start, loc, **extras):
        """Two empties mirrored across the YZ plane: index `start` on the left (-X), start+1 right."""
        x, y, z = loc
        self.empty('%s_%d' % (base, start), (-abs(x), y, z), **extras)
        self.empty('%s_%d' % (base, start + 1), (abs(x), y, z), **extras)

    # -- finalize -----------------------------------------------------------------------------

    def finalize(self, sharp_angle=50.0, ao=True, ao_floor=0.28, ao_distance=None, merge_dist=0.0):
        """Turn the collected geometry into objects in collection P2_<key>."""
        key = self.key
        col = get_collection(key)
        clear_collection(col)
        for nm in (key, key + '_mesh'):
            stale = bpy.data.objects.get(nm)
            if stale is not None:
                raise RuntimeError('an object named %r already exists outside %s' % (nm, col.name))
        old = bpy.data.meshes.get(key + '_mesh')
        if old is not None and old.users == 0:
            bpy.data.meshes.remove(old)

        bm = self.bm
        if merge_dist > 0:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist)
        bm.normal_update()
        me = bpy.data.meshes.new(key + '_mesh')
        bm.to_mesh(me)
        bm.free()
        me.validate()

        # material slots: only the ones in use, in a stable order
        n = len(me.polygons)
        mi = np.zeros(n, dtype=np.int32)
        me.polygons.foreach_get('material_index', mi)
        used = sorted(set(int(v) for v in mi))
        remap = np.zeros(max(len(self.mat_names), 1), dtype=np.int32)
        names = []
        for new, oldi in enumerate(used):
            remap[oldi] = new
            names.append(self.mat_names[oldi])
        me.polygons.foreach_set('material_index', remap[mi])
        for nm in names:
            if nm in self.variants:
                spec = dict(self.variants[nm])
                me.materials.append(material(nm, spec.pop('base'), **spec))
            else:
                me.materials.append(material(nm))
        self.materials = names

        me.polygons.foreach_set('use_smooth', np.ones(n, dtype=bool))
        me.set_sharp_from_angle(angle=math.radians(sharp_angle))
        me.update()

        root = bpy.data.objects.new(key, None)
        root.empty_display_type = 'PLAIN_AXES'
        root.empty_display_size = 1.0
        col.objects.link(root)
        ob = bpy.data.objects.new(key + '_mesh', me)
        col.objects.link(ob)
        ob.parent = root
        if root.name != key or ob.name != key + '_mesh':
            raise RuntimeError('object name collision for ' + key)
        root['p2_key'] = key
        root['p2_kind'] = self.kind
        if self.radius is not None:
            root['p2_radius'] = float(self.radius)
        for k, v in self.props.items():
            root[k] = v
        for name, loc, extras in self.empties:
            e = bpy.data.objects.new(key + SEP + name, None)
            e.empty_display_type = 'PLAIN_AXES'
            e.empty_display_size = 0.15
            e.location = loc
            col.objects.link(e)
            e.parent = root
            for k, v in extras.items():
                e[k] = v
        self.root, self.object = root, ob

        with scene_active():
            isolate(key)
            _apply_weighted_normals(ob)
            if ao:
                dist = ao_distance or (0.22 * self.radius if self.radius else 2.0)
                try:
                    bake_ao(ob, distance=dist, floor=ao_floor)
                    self.stats['ao'] = 'cycles'
                except Exception as ex:  # baking is optional; the model is still valid
                    self.stats['ao'] = 'failed: %r' % (ex,)
        me = ob.data
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        self.stats.update(
            triangles=int(tris), vertices=len(me.vertices), polygons=len(me.polygons),
            bbox_min=[round(float(v), 3) for v in co.min(axis=0)],
            bbox_max=[round(float(v), 3) for v in co.max(axis=0)],
            bounding_radius=round(float(np.sqrt((co * co).sum(axis=1)).max()), 3),
            materials=list(names))
        return self


def _apply_weighted_normals(ob):
    """Face-area weighted normals so large flat panels stay flat and bevels carry the turn."""
    mod = ob.modifiers.new('p2_wn', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.mode = 'FACE_AREA'
    mod.weight = 50
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = ob.evaluated_get(dg)
    new = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    ob.modifiers.remove(mod)
    old = ob.data
    name = old.name
    ob.data = new
    bpy.data.meshes.remove(old)
    new.name = name


def bake_ao(ob, distance=2.0, samples=48, floor=0.28, gamma=0.9):
    """Bake Cycles ambient occlusion into the corner colour attribute "Col".

    Must run inside scene_active(). The raw bake is then averaged per vertex and
    shading normal (per-corner noise would split vertices in the GLB and triple
    its size), lifted to `floor` so buried vertices do not turn panels black,
    and emissive faces are reset to white.
    """
    me = ob.data
    ca = me.color_attributes.get('Col')
    if ca is None:
        ca = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    me.color_attributes.active_color = ca
    try:
        me.color_attributes.render_color_index = list(me.color_attributes).index(ca)
    except Exception:
        pass
    sc = bpy.context.scene
    vl = bpy.context.view_layer
    for o in vl.objects:
        o.select_set(False)
    ob.select_set(True)
    vl.objects.active = ob
    if sc.world is None:
        sc.world = _world()
    prev_engine = sc.render.engine
    prev_dist = sc.world.light_settings.distance
    try:
        sc.render.engine = 'CYCLES'
        sc.cycles.device = 'CPU'
        sc.cycles.samples = samples
        sc.world.light_settings.distance = distance
        bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    finally:
        sc.render.engine = prev_engine
        sc.world.light_settings.distance = prev_dist
        ob.select_set(False)

    me = ob.data
    ca = me.color_attributes['Col']
    n = len(me.loops)
    col = np.zeros(n * 4, dtype=np.float32)
    ca.data.foreach_get('color', col)
    ao = col.reshape(n, 4)[:, 0].astype(np.float64)
    vidx = np.zeros(n, dtype=np.int32)
    me.loops.foreach_get('vertex_index', vidx)
    nor = np.zeros(n * 3, dtype=np.float32)
    me.corner_normals.foreach_get('vector', nor)
    q = np.round(nor.reshape(n, 3) * 6.0).astype(np.int64) + 8
    keys = vidx.astype(np.int64) * 4096 + q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    _, inv = np.unique(keys, return_inverse=True)
    ao = (np.bincount(inv, weights=ao) / np.maximum(np.bincount(inv), 1))[inv]
    ao = floor + (1.0 - floor) * np.clip(ao, 0.0, 1.0) ** gamma
    # emissive faces stay white
    pm = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('material_index', pm)
    ls = np.zeros(len(me.polygons), dtype=np.int32)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_start', ls)
    me.polygons.foreach_get('loop_total', lt)
    emis = np.array([is_emissive(m.name) if m else False for m in me.materials], dtype=bool)
    if emis.any():
        loop_poly = np.repeat(np.arange(len(me.polygons)), lt)
        order = np.argsort(np.repeat(ls, lt) + (np.arange(lt.sum()) - np.repeat(np.cumsum(lt) - lt, lt)))
        lp = np.empty(n, dtype=np.int64)
        lp[np.repeat(ls, lt) + (np.arange(lt.sum()) - np.repeat(np.cumsum(lt) - lt, lt))] = loop_poly
        ao[emis[pm[lp]]] = 1.0
        del order
    out = np.ones((n, 4), dtype=np.float32)
    out[:, 0] = out[:, 1] = out[:, 2] = ao
    ca.data.foreach_set('color', out.ravel())
    me.update()
    return float(ao.min()), float(ao.mean())


# ---------------------------------------------------------------------------------------------
# Export and verification
# ---------------------------------------------------------------------------------------------

def glb_path(key):
    return os.path.join(MODELS_DIR, key + '.glb')


def export_glb(key, path=None):
    """Export collection P2_<key> to packages/client/public/models/<key>.glb."""
    path = path or glb_path(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    col = bpy.data.collections[PREFIX + key]
    want = dict(
        filepath=path, check_existing=False, export_format='GLB', use_selection=True, use_active_scene=True,
        export_yup=True, export_apply=True, export_extras=True, export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
        export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False,
        export_draco_mesh_compression_enable=False, export_meshopt_compression_enable=False,
    )
    known = set(p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties)
    args = {k: v for k, v in want.items() if k in known}
    with scene_active():
        vl = bpy.context.view_layer
        for o in vl.objects:
            o.select_set(False)
        renamed = []
        try:
            for o in col.objects:
                o.select_set(True)
                if o.name.startswith(key + SEP):
                    orig = o.name
                    bare = orig[len(key) + len(SEP):]
                    renamed.append((o, orig))
                    o.name = bare
                    if o.name != bare:
                        raise RuntimeError('cannot export %s: an object named %r already exists' % (key, bare))
            vl.objects.active = bpy.data.objects[key]
            bpy.ops.export_scene.gltf(**args)
        finally:
            for o, orig in renamed:
                o.name = orig
            for o in col.objects:
                o.select_set(False)
    return path


def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, _ver, total = struct.unpack_from('<4sII', data, 0)
    if magic != b'glTF':
        raise ValueError('not a GLB: ' + path)
    off, js, blob = 12, None, b''
    while off < total:
        ln, typ = struct.unpack_from('<I4s', data, off)
        off += 8
        if typ == b'JSON':
            js = json.loads(data[off:off + ln].decode('utf-8'))
        elif typ == b'BIN\x00':
            blob = data[off:off + ln]
        off += ln
    return js, blob, len(data)


def _mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _node_matrix(n):
    if 'matrix' in n:
        m = n['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get('translation', [0, 0, 0])
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    s = n.get('scale', [1, 1, 1])
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def verify_glb(path, key, kind='ship', radius=None, hardpoints=None, require=()):
    """Parse a GLB and check it against the PRIMACY2 model contract.

    Pure standard library, so it also runs outside Blender. Returns a report
    dict; report['problems'] is empty when everything holds.
    """
    js, blob, size = read_glb(path)
    problems = []
    nodes = js.get('nodes', [])
    names = [n.get('name', '') for n in nodes]
    scene = js['scenes'][js.get('scene', 0)]
    roots = [names[i] for i in scene.get('nodes', [])]
    if roots != [key]:
        problems.append('scene roots are %r, expected [%r]' % (roots, key))
    if len(set(names)) != len(names):
        problems.append('duplicate node names')
    for nm in names:
        if len(nm) > 4 and nm[-4] == '.' and nm[-3:].isdigit():
            problems.append('node name with numeric suffix: ' + nm)

    world = {}

    def walk(i, parent):
        m = _mat_mul(parent, _node_matrix(nodes[i]))
        world[i] = m
        for c in nodes[i].get('children', []):
            walk(c, m)

    ident = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
    for i in scene.get('nodes', []):
        walk(i, ident)

    acc, views = js.get('accessors', []), js.get('bufferViews', [])
    tris = verts = 0
    lo, hi, r2 = [1e30] * 3, [-1e30] * 3, 0.0
    no_color = 0
    for i, n in enumerate(nodes):
        if 'mesh' not in n or i not in world:
            continue
        m = world[i]
        for prim in js['meshes'][n['mesh']]['primitives']:
            if 'COLOR_0' not in prim['attributes']:
                no_color += 1
            pa = acc[prim['attributes']['POSITION']]
            bv = views[pa['bufferView']]
            stride = bv.get('byteStride', 12)
            base = bv.get('byteOffset', 0) + pa.get('byteOffset', 0)
            verts += pa['count']
            for k in range(pa['count']):
                x, y, z = struct.unpack_from('<3f', blob, base + k * stride)
                p = [m[r][0] * x + m[r][1] * y + m[r][2] * z + m[r][3] for r in range(3)]
                for q in range(3):
                    lo[q] = min(lo[q], p[q])
                    hi[q] = max(hi[q], p[q])
                r2 = max(r2, p[0] * p[0] + p[1] * p[1] + p[2] * p[2])
            tris += (acc[prim['indices']]['count'] if 'indices' in prim else pa['count']) // 3
    if no_color:
        problems.append('%d primitive(s) without COLOR_0' % no_color)
    bound = math.sqrt(r2)

    empties = {}
    for i, n in enumerate(nodes):
        if 'mesh' not in n and i in world and n.get('name') != key:
            empties[n['name']] = [round(world[i][r][3], 4) for r in range(3)]

    mats = [m.get('name', '') for m in js.get('materials', [])]
    allowed = tuple(PALETTE.keys())
    for nm in mats:
        if not any(nm == a or nm.startswith(a + '_') for a in allowed):
            problems.append('material outside the palette naming scheme: ' + nm)
    if any(m.get('emissiveFactor') for m in js.get('materials', [])) and \
            'KHR_materials_emissive_strength' not in js.get('extensionsUsed', []):
        problems.append('emissive strength extension missing')
    if js.get('textures') or js.get('images'):
        problems.append('GLB contains textures')
    if any(e in js.get('extensionsUsed', []) for e in ('KHR_draco_mesh_compression', 'EXT_meshopt_compression')):
        problems.append('GLB is compressed')

    for i, h in enumerate(hardpoints or []):
        nm = 'hardpoint_%d' % i
        if nm not in empties:
            problems.append('missing ' + nm)
        elif max(abs(empties[nm][q] - h[q]) for q in range(3)) > 1e-3:
            problems.append('%s at %r, catalog says %r' % (nm, empties[nm], list(h)))
    for nm in require:
        if nm not in empties:
            problems.append('missing empty ' + nm)
    if kind == 'ship':
        if 'cockpit' not in empties:
            problems.append('missing empty cockpit')
        elif empties['cockpit'][2] >= 0:
            problems.append('cockpit is not in the forward (-Z) half')
        engines = [v for k, v in empties.items() if k.startswith('engine_')]
        if not engines:
            problems.append('no engine_* empties')
        if any(v[2] <= 0 for v in engines):
            problems.append('an engine empty is not in the aft (+Z) half')
        if -lo[2] < hi[2] * 0.6:
            problems.append('nose does not reach forward (-Z) as far as expected')
    if radius:
        dev = bound / radius - 1.0
        if abs(dev) > 0.15:
            problems.append('bounding radius %.2f deviates %.0f %% from collision radius %.1f'
                            % (bound, dev * 100, radius))
    tmin, tmax = BUDGETS.get(kind, (0, 10 ** 9))
    if tris < tmin or tris > tmax:
        problems.append('%d triangles outside the %s budget %d..%d' % (tris, kind, tmin, tmax))
    if size > MAX_GLB_BYTES:
        problems.append('GLB is %.2f MB, limit 2 MB' % (size / 1048576.0))
    if tris and verts > tris * 2.2:
        problems.append('vertex count %d is high for %d triangles (split vertices)' % (verts, tris))

    return dict(
        key=key, path=path, ok=not problems, problems=problems, triangles=tris, vertices=verts,
        size_kb=round(size / 1024.0, 1), roots=roots, nodes=names, materials=mats, empties=empties,
        bbox_min=[round(v, 3) for v in lo], bbox_max=[round(v, 3) for v in hi],
        bounding_radius=round(bound, 3), extensions=js.get('extensionsUsed', []))


# ---------------------------------------------------------------------------------------------
# Preview rendering
# ---------------------------------------------------------------------------------------------

def _world():
    w = bpy.data.worlds.get(WORLD)
    if w is None:
        w = bpy.data.worlds.new(WORLD)
    if w.node_tree is None:
        w.use_nodes = True
    bg = next((n for n in w.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bg is not None:
        bg.inputs[0].default_value = (0.01, 0.01, 0.012, 1.0)
        bg.inputs[1].default_value = 1.0
    w.color = (0.01, 0.01, 0.012)
    return w


def _stage_object(name, data_factory):
    ob = bpy.data.objects.get(name)
    if ob is None:
        ob = bpy.data.objects.new(name, data_factory())
    return ob


def setup_stage():
    """Camera, three sun lights and the dark world used for previews."""
    sc = get_scene()
    col = bpy.data.collections.get(STAGE)
    if col is None:
        col = bpy.data.collections.new(STAGE)
    if col.name not in sc.collection.children:
        sc.collection.children.link(col)
    cam = _stage_object('P2_Cam', lambda: bpy.data.cameras.new('P2_Cam'))
    lights = {}
    for nm, energy, colr, angle in (('P2_Key', 4.5, (1.0, 0.96, 0.9), 2.0),
                                    ('P2_Rim', 6.0, (0.7, 0.82, 1.0), 1.0),
                                    ('P2_Fill', 0.9, (0.75, 0.82, 1.0), 20.0)):
        ob = _stage_object(nm, lambda nm=nm: bpy.data.lights.new(nm, 'SUN'))
        ob.data.energy = energy
        ob.data.color = colr
        ob.data.angle = math.radians(angle)
        lights[nm] = ob
    for ob in [cam] + list(lights.values()):
        if ob.name not in col.objects:
            col.objects.link(ob)
    cam.data.lens = 60.0
    cam.data.clip_start = 0.5
    cam.data.clip_end = 5000.0
    sc.camera = cam
    sc.world = _world()
    r = sc.render
    r.engine = 'BLENDER_EEVEE'
    r.resolution_x, r.resolution_y, r.resolution_percentage = 1280, 720, 100
    r.film_transparent = False
    try:
        r.image_settings.file_format = 'PNG'
        r.image_settings.color_mode = 'RGB'
    except Exception:
        pass
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    try:
        sc.view_settings.view_transform = 'Standard'
        sc.view_settings.look = 'None'
    except Exception:
        pass
    return cam, lights


VIEWS = {
    'front34': (0.75, 1.0, 0.45),
    'rear34': (-0.8, -1.0, 0.5),
    'top': (0.0, -0.02, 1.0),
    'side': (1.0, 0.05, 0.08),
    'front': (0.05, 1.0, 0.12),
    'below34': (0.7, 0.9, -0.55),
}


def _aim(ob, direction):
    """Point the object's -Z axis along `direction`."""
    ob.rotation_euler = (-Vector(direction)).to_track_quat('Z', 'Y').to_euler()


def render_preview(key, view, radius, direction=None, target=(0, 0, 0), zoom=1.0, path=None, debug_ao=False):
    """Render assets/blender/previews/<key>_<view>.png with EEVEE."""
    cam, lights = setup_stage()
    d = Vector(direction or VIEWS[view]).normalized()
    tgt = Vector(target)
    path = path or os.path.join(PREVIEW_DIR, '%s_%s.png' % (key, view))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    half_v = math.atan(0.5 * 36.0 * 720 / 1280 / cam.data.lens)
    dist = radius / math.sin(half_v) * 0.78 / zoom
    cam.location = tgt + d * dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    fwd = -d
    right = fwd.cross(Vector((0, 0, 1)))
    if right.length < 1e-3:
        right = Vector((1, 0, 0))
    right.normalize()
    up = right.cross(fwd).normalized()
    for nm, src in (('P2_Key', -fwd * 0.55 + up * 0.75 - right * 0.65),
                    ('P2_Rim', fwd * 0.9 + up * 0.45 + right * 0.55),
                    ('P2_Fill', -fwd * 0.5 - up * 0.35 + right * 0.9)):
        lights[nm].location = tgt + src.normalized() * (radius * 4.0)
        _aim(lights[nm], -src)
    with scene_active() as sc:
        isolate(key)
        vl = bpy.context.view_layer
        prev_override = vl.material_override
        if debug_ao:
            vl.material_override = _ao_debug_material()
        sc.render.filepath = path
        try:
            bpy.ops.render.render(write_still=True, scene=sc.name)
        finally:
            vl.material_override = prev_override
    return path


def _ao_debug_material():
    """Preview-only material that shows the baked "Col" attribute (never exported)."""
    name = 'P2_debug_ao'
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        if m.node_tree is None:
            m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        att = nt.nodes.new('ShaderNodeAttribute')
        att.attribute_name = 'Col'
        em = nt.nodes.new('ShaderNodeEmission')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(att.outputs['Color'], em.inputs['Color'])
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m


def save_blend():
    """Save a copy of the working file; the user's session keeps its own (unsaved) state."""
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH, copy=True, check_existing=False)
    return BLEND_PATH


# ---------------------------------------------------------------------------------------------
# One call per model: export, verify, previews
# ---------------------------------------------------------------------------------------------

def process(model, export=True, previews=('front34', 'rear34'), require=()):
    """Export a finalized Model, verify the GLB and render previews. Returns a report dict."""
    rep = dict(key=model.key, build=dict(model.stats))
    if export:
        path = export_glb(model.key)
        rep['glb'] = verify_glb(path, model.key, kind=model.kind, radius=model.radius,
                                hardpoints=model.hardpoints, require=require)
    rep['previews'] = []
    r = model.radius or model.stats.get('bounding_radius', 10.0)
    for v in previews or ():
        rep['previews'].append(render_preview(model.key, v, r))
    return rep
