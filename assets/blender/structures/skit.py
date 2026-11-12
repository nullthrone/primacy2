"""Shared building blocks for the structure and prop generators (thin layer over p2lib).

Structures are bodies of revolution about Blender +Z (glTF +Y), the axis the server's
colliders in packages/shared/src/structures.ts use. Angles are degrees from +X toward +Y.
"""

import math
import os
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import p2lib as L

TAU = 2.0 * math.pi


def polar(r, deg, z=0.0):
    a = math.radians(deg)
    return (r * math.cos(a), r * math.sin(a), z)


def radial(m, part, n=None, phase=0.0, angles=None, axis='Z'):
    """Merge copies of `part` rotated about `axis` into the model (n evenly spaced, or `angles`)."""
    angs = angles if angles is not None else [phase + 360.0 * k / n for k in range(n)]
    for a in angs:
        b = part.bm.copy()
        bmesh.ops.transform(b, matrix=Matrix.Rotation(math.radians(a), 4, axis), verts=b.verts)
        m._merge(b)
        b.free()
    part.bm.free()


def sweep(p, profile, segs, mat='hull_primary', mats=None, a0=None, a1=None, cap_mat=None, phase=0.0):
    """Revolve a closed (rho, z) cross-section about +Z.

    Full ring when a0 is None (first vertex ring at `phase` degrees), otherwise the arc
    a0..a1 with end caps. mats gives one material per profile edge (edge k runs from point
    k to k+1). Returns (faces[segment][edge], caps).
    """
    bm = p.bm
    n = len(profile)
    area = sum(profile[k][0] * profile[(k + 1) % n][1] - profile[(k + 1) % n][0] * profile[k][1] for k in range(n))
    sgn = 1.0 if area > 0 else -1.0
    full = a0 is None
    if full:
        angs = [math.radians(phase) + TAU * i / segs for i in range(segs)]
        step = TAU / segs
    else:
        angs = [math.radians(a0 + (a1 - a0) * i / segs) for i in range(segs + 1)]
        step = math.radians(a1 - a0) / segs
    rings = [[bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for (r, z) in profile] for a in angs]
    mis = [p.mi(mats[k] if mats else mat) for k in range(n)]
    faces = []
    for i in range(segs):
        i2 = (i + 1) % len(rings)
        am = angs[i] + step * 0.5
        cr, sr = math.cos(am), math.sin(am)
        row = []
        for k in range(n):
            k2 = (k + 1) % n
            dr = profile[k2][0] - profile[k][0]
            dz = profile[k2][1] - profile[k][1]
            want = Vector((dz * cr, dz * sr, -dr)) * sgn
            row.append(L._mkface(bm, (rings[i][k], rings[i][k2], rings[i2][k2], rings[i2][k]), mis[k], want))
        faces.append(row)
    caps = []
    if not full:
        cm = p.mi(cap_mat) if cap_mat else mis[0]
        t0 = Vector((math.sin(angs[0]), -math.cos(angs[0]), 0.0))
        t1 = Vector((-math.sin(angs[-1]), math.cos(angs[-1]), 0.0))
        caps = [L._mkface(bm, rings[0], cm, t0), L._mkface(bm, rings[-1], cm, t1)]
    return faces, caps


def arc_box(p, r0, r1, z0, z1, a0, a1, mat='hull_secondary', n=1, mats=None, cap_mat=None):
    """Box bent around the axis. mats order: bottom, outer, top, inner."""
    return sweep(p, [(r0, z0), (r1, z0), (r1, z1), (r0, z1)], n, mat, mats, a0, a1, cap_mat)


def lamp(p, loc, r, mat='emissive_light', segs=6, axis='Z'):
    """Small faceted lamp (double cone)."""
    p.lathe([(-r, 0.0), (-r * 0.45, r * 0.8), (r * 0.45, r * 0.8), (r, 0.0)], segs, mat, axis=axis, origin=loc)


def mast(p, base, tip, r, mat='hull_dark', lamp_r=0.0, lamp_mat='emissive_light', segs=6):
    """Tapered antenna mast with an optional lamp on the tip."""
    p.tube(base, tip, r, r * 0.35, segs, mat)
    if lamp_r > 0:
        lamp(p, tip, lamp_r, lamp_mat)


def white_col(me):
    """Give a mesh the "Col" attribute the game expects, filled with white."""
    ca = me.color_attributes.get('Col')
    if ca is None:
        ca = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    ca.data.foreach_set('color', np.ones(len(me.loops) * 4, dtype=np.float32))
    try:
        me.color_attributes.active_color = ca
    except Exception:
        pass
    me.update()


def child_mesh(m, name, sub, sharp=38.0, ao=False, ao_distance=20.0, double_sided=False):
    """Extra mesh object "<name>" under the model root (call after m.finalize()).

    `sub` is an L.Model used only as a geometry container (never finalized). In the file
    the object is named "<key>:<name>"; the exporter strips the prefix.
    """
    key = m.key
    col = L.get_collection(key)
    me = bpy.data.meshes.new('%s_%s_mesh' % (key, name))
    sub.bm.normal_update()
    sub.bm.to_mesh(me)
    sub.bm.free()
    me.validate()
    n = len(me.polygons)
    mi = np.zeros(n, dtype=np.int32)
    me.polygons.foreach_get('material_index', mi)
    used = sorted(set(int(v) for v in mi))
    remap = np.zeros(max(len(sub.mat_names), 1), dtype=np.int32)
    for new, oldi in enumerate(used):
        remap[oldi] = new
        nm = sub.mat_names[oldi]
        if nm in sub.variants:
            spec = dict(sub.variants[nm])
            mat = L.material(nm, spec.pop('base'), **spec)
        else:
            mat = L.material(nm)
        if double_sided:
            mat.use_backface_culling = False
        me.materials.append(mat)
    me.polygons.foreach_set('material_index', remap[mi])
    me.polygons.foreach_set('use_smooth', np.ones(n, dtype=bool))
    me.set_sharp_from_angle(angle=math.radians(sharp))
    me.update()
    ob = bpy.data.objects.new(key + L.SEP + name, me)
    col.objects.link(ob)
    ob.parent = m.root
    with L.scene_active():
        L.isolate(key)
        L._apply_weighted_normals(ob)
        done = False
        if ao:
            try:
                L.bake_ao(ob, distance=ao_distance)
                done = True
            except Exception:
                done = False
        if not done:
            white_col(ob.data)
    return ob


def _coords(obs):
    out = []
    for ob in obs:
        me = ob.data
        co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get('co', co)
        out.append(co.reshape(-1, 3))
    return np.concatenate(out)


def fit(obs, colliders, bound):
    """How well the meshes match the server's colliders (packages/shared/src/structures.ts).

    Colliders use the structure axis coordinate `y`, which is Blender Z here. Reports the
    largest vertex distance from the origin against `bound`, the largest protrusion outside
    the union of the colliders and how far the model fills each collider.
    """
    co = _coords(obs).astype(np.float64)
    rho = np.hypot(co[:, 0], co[:, 1])
    z = co[:, 2]
    out = np.full(len(co), 1e9)
    info = {}
    for c in colliders:
        if c['kind'] == 'torus':
            d = np.hypot(rho - c['major'], z - c['y'])
            sd = d - c['minor']
            skin = d[sd < 4.0]
            info['torus_section_reach'] = [round(float(skin.max()), 2), c['minor']] if len(skin) else None
        elif c['kind'] == 'cylinder':
            sd = np.maximum(rho - c['r'], np.maximum(z - c['y1'], c['y0'] - z))
            ins = sd <= 0.5
            if ins.any():
                info['cylinder_reach'] = dict(r=[round(float(rho[ins].max()), 2), c['r']],
                                              axis=[round(float(z[ins].min()), 2), round(float(z[ins].max()), 2),
                                                    c['y0'], c['y1']])
        else:
            d = np.hypot(rho, z - c['y'])
            sd = d - c['r']
            ins = sd <= 0.5
            info['sphere_reach'] = [round(float(d[ins].max()), 2) if ins.any() else None, c['r']]
        out = np.minimum(out, sd)
    i = int(out.argmax())
    rmax = float(np.sqrt((co * co).sum(axis=1)).max())
    return dict(max_radius=round(rmax, 2), bound=bound, inside_bound=bool(rmax <= bound),
                max_outside_colliders=round(float(out[i]), 1),
                max_outside_at_rho_axis=[round(float(rho[i]), 1), round(float(z[i]), 1)],
                pct_verts_outside_3m=round(float((out > 3.0).mean() * 100.0), 1), **info)


def finish(m, colliders=None, bound=None, sharp=38.0, ao=True, ao_distance=2.0, export=True, preview=True,
           direction=(0.5, -0.72, 0.62), zoom=1.2, preview_radius=None, target=(0, 0, 0), children=(),
           require=(), merge=0.0, fit_skip=('portal',), preview_hide=()):
    """Finalize, add child meshes, check collider fit, export, verify and render one preview."""
    t0 = time.time()
    m.finalize(sharp_angle=sharp, ao=ao, ao_distance=ao_distance, merge_dist=merge)
    if 'Col' not in m.object.data.color_attributes:
        white_col(m.object.data)
    kids = []
    for name, sub, kw in children:
        kids.append((name, child_mesh(m, name, sub, **kw)))
    st = m.stats
    tris = st['triangles'] + sum(sum(len(pl.vertices) - 2 for pl in ob.data.polygons) for _, ob in kids)
    rep = dict(key=m.key, tris=tris, radius=st['bounding_radius'], bbox=[st['bbox_min'], st['bbox_max']],
               ao=st.get('ao'))
    if colliders:
        rep['fit'] = fit([m.object] + [ob for nm, ob in kids if nm not in fit_skip], colliders, bound)
    if export:
        v = L.process(m, export=True, previews=(), require=require)['glb']
        rep.update(glb_tris=v['triangles'], glb_radius=v['bounding_radius'], size_kb=v['size_kb'],
                   glb_bbox=[v['bbox_min'], v['bbox_max']], problems=v['problems'],
                   empties=v['empties'], nodes=[n for n in v['nodes'] if n not in v['empties']],
                   materials=v['materials'])
    if preview:
        path = os.path.join(L.PREVIEW_DIR, m.key + '.png')
        for nm, ob in kids:
            ob.hide_render = nm in preview_hide
        try:
            L.render_preview(m.key, 'front34', preview_radius or m.radius or st['bounding_radius'],
                             direction=direction, target=target, zoom=zoom, path=path)
        finally:
            for nm, ob in kids:
                ob.hide_render = False
        rep['preview'] = path
    rep['seconds'] = round(time.time() - t0, 1)
    return rep


def contact_sheet(keys, name, cols=2, scale=2):
    """Tile the previews of `keys` into previews/_sheet_<name>.png (downscaled) for a quick look."""
    tiles = []
    for k in keys:
        img = bpy.data.images.load(os.path.join(L.PREVIEW_DIR, k + '.png'), check_existing=False)
        w, h = img.size
        px = np.zeros(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        tiles.append(px.reshape(h, w, 4)[::scale, ::scale])
    th, tw = tiles[0].shape[:2]
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * th, cols * tw, 4), dtype=np.float32)
    sheet[..., 3] = 1.0
    for i, a in enumerate(tiles):
        r, c = divmod(i, cols)
        y0 = (rows - 1 - r) * th
        sheet[y0:y0 + th, c * tw:(c + 1) * tw] = a
    path = os.path.join(L.PREVIEW_DIR, '_sheet_%s.png' % name)
    out = bpy.data.images.new('p2_sheet', cols * tw, rows * th, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    return path
