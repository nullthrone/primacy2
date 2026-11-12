"""gate - warp gate. A slim conduit ring carrying twelve emitter housings (four of them
anchor nodes with outboard capacitor blocks and axial horns); every housing points emitter
prongs at the aperture.

Matches packages/shared/src/structures.ts: torus major 450 / minor 45, inside a 520 m sphere,
axis along Blender +Z (glTF +Y). Child meshes: "portal" (disc r 400, material "portal") and
"scaffold" (construction cage around the tube) so the game can show or hide them.
Violet accent.
"""

import bmesh

import p2lib as L
from structures import skit as K

KEY = 'gate'
BOUND = 520.0
R, T = 450.0, 45.0
COLLIDERS = [dict(kind='torus', y=0.0, major=R, minor=T)]
N = 12        # emitter housings
SEGS = 96

H, S2, D, E = 'hull_primary', 'hull_secondary', 'hull_dark', 'emissive_accent'
ACC = dict(color=(0.16, 0.09, 0.6), metallic=0.55, roughness=0.4)

# (a, z, material of the edge starting here); a = rho - R, counter-clockwise. The inner face
# carries the emitter slot.
SEC = [(40, -16, H), (40, 16, S2), (29, 33, H), (8, 42, H), (-22, 36, S2), (-38, 14, D), (-38, 7, D),
       (-34, 5, E), (-34, -5, D), (-38, -7, D), (-38, -14, S2), (-22, -36, H), (8, -42, H), (29, -33, S2)]


def section(scale=1.0):
    return [(R + a * scale, z * scale) for a, z, _ in SEC]


def build_ring(m, acc):
    step = 360.0 / SEGS
    p = m.part()                                      # conduit ring between the housings
    neck = [{H: S2, S2: D}.get(s[2], s[2]) for s in SEC]
    faces, _ = K.sweep(p, section(0.7), SEGS, mats=neck, phase=-step / 2)
    p.paint([faces[i][7] for i in range(SEGS) if i % 4 == 3], D)        # dashed emitter line
    p.paint([faces[i][k] for i in range(SEGS) if i % 2 for k in (2, 3, 11, 12)], D)
    m.add(p)

    p = m.part()                                      # service pipes spanning from housing to housing
    for a, z, mat in ((33, 9, D), (33, -9, S2), (12, 34.5, acc), (12, -34.5, D)):
        K.sweep(p, [(R + a + 2.6, z), (R + a, z + 2.6), (R + a - 2.6, z), (R + a, z - 2.6)], 48, mat=mat)
    m.add(p)

    mats = [s[2] for s in SEC]
    p = m.part()
    for k in range(N):
        c = k * 30.0
        prime = (k % 3 == 0)
        hw = 9.0 if prime else 6.5
        f, _ = K.sweep(p, section(1.0), 6 if prime else 4, mats=mats, a0=c - hw, a1=c + hw, cap_mat=D)
        for sgn in (-1, 1):                           # stepped shoulders
            e0, e1 = c + sgn * (hw + 1.7), c + sgn * (hw - 0.3)
            K.sweep(p, section(0.86), 1, mats=mats, a0=min(e0, e1), a1=max(e0, e1), cap_mat=D)
        p.inset([row[0] for row in f], 1.6, -0.9, rim=S2, inner=D, individual=True)      # outer grilles
        p.inset([row[j] for row in f for j in (3, 11)], 1.5, 0.5, rim=D, inner=acc if prime else H,
                individual=True)
    m.add(p)

    def prong(big):                                   # emitter prong pointing at the aperture (toward -Y here)
        q = m.part()
        w, t, tip = (11.0, 8.0, 404.6) if big else (6.0, 5.0, 409.0)
        q.prism(L.octo(w, t, min(w, t) * 0.25), 420.0, tip, S2, scale1=(0.4, 0.45))
        q.box((0, tip - 0.2, 0), (w * 0.3, 1.4, t * 0.34), E)
        return q

    cs = [k * 30.0 - 90.0 for k in range(N)]
    K.radial(m, prong(True), angles=cs)
    side = []
    for k in range(N):
        d = 6.0 if k % 3 == 0 else 4.2
        side += [cs[k] - d, cs[k] + d]
    K.radial(m, prong(False), angles=side)

    q = m.part()                                      # anchor nodes: capacitor block, lamp, axial horns
    q.box((0, 494, 0), (46, 14, 30), acc, chamfer=5)
    q.box((0, 499.5, 0), (30, 8, 18), S2, chamfer=3)
    K.lamp(q, (0, 505.5, 0), 2.6, axis='Y')
    for sz in (1, -1):
        K.mast(q, (0, 452, sz * 40), (0, 452, sz * 63), 2.2, lamp_r=1.8, lamp_mat=E)
        q.box((0, 470, sz * 37.5), (20, 16, 5), S2, chamfer=1.5)
    K.radial(m, q, 4)
    for j in range(4):
        m.empty('light_%d' % j, K.polar(507.0, 90.0 * j))

    q = m.part()                                      # smaller heat sinks on the other housings
    q.box((0, 492.5, 0), (22, 8, 18), S2, chamfer=3)
    for x in (-6, 0, 6):
        q.box((x, 497.2, 0), (1.6, 3.0, 15), D)
    K.radial(m, q, angles=[k * 30.0 - 90.0 for k in range(N) if k % 3])


def build_scaffold():
    """Construction cage around the tube: square frames, corner rails, cross bracing, platforms."""
    s = L.Model(KEY, 'gate')
    acc = s.variant('hull_accent', **ACC)
    p = s.part()
    corners = [(-50, -52), (54, -52), (54, 52), (-50, 52)]
    nf = 48
    for i in range(nf):
        th, th2 = (i + 0.5) * 360.0 / nf, (i + 1.5) * 360.0 / nf
        pts = [K.polar(R + a, th, z) for a, z in corners]
        nxt = [K.polar(R + a, th2, z) for a, z in corners]
        for j in range(4):
            p.tube(pts[j], pts[(j + 1) % 4], 1.7, segs=4, mat=H)
            p.tube(pts[j], nxt[j], 1.5, segs=4, mat=H, cap0=False, cap1=False)
        for j0, j1 in ((1, 2), (2, 3), (0, 1)):       # bracing on the outer and both axial faces
            a, b = (pts[j0], nxt[j1]) if i % 2 == 0 else (pts[j1], nxt[j0])
            p.tube(a, b, 1.0, segs=4, mat=S2, cap0=False, cap1=False)
    for th in (41.25, 161.25, 288.75):                # work platforms with a crane and lamps
        K.arc_box(p, R + 55.5, R + 60.5, -30, 30, th - 3.75, th + 3.75, mat=acc, n=2, cap_mat=D)
        p.tube(K.polar(R + 58, th + 2.5, 28), K.polar(R + 50, th + 2.5, 66), 1.4, segs=4, mat=S2)
        p.tube(K.polar(R + 50, th + 2.5, 66), K.polar(R + 18, th + 2.5, 62), 1.2, segs=4, mat=S2)
        for dz in (-24, 24):
            K.lamp(p, K.polar(R + 62.5, th, dz), 2.0)
    s.add(p)
    return s


def build_portal():
    s = L.Model(KEY, 'gate')
    p = s.part()
    p.lathe([(0.0, 0.0), (0.0, 130.0), (0.0, 265.0), (0.0, 400.0)], 64, 'portal', axis='Z')
    p.bm.normal_update()
    down = [f for f in p.bm.faces if f.normal.z < 0.0]
    if down:
        bmesh.ops.reverse_faces(p.bm, faces=down)
    s.add(p)
    return s


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'gate', BOUND)
    acc = m.variant('hull_accent', **ACC)
    build_ring(m, acc)
    m.props['p2_bound'] = BOUND
    rep = K.finish(m, COLLIDERS, BOUND, ao=ao, ao_distance=30.0, export=export, preview=preview,
                   children=[('scaffold', build_scaffold(), {}), ('portal', build_portal(), dict(double_sided=True))],
                   fit_skip=('portal', 'scaffold'), preview_hide=('scaffold',),
                   direction=(0.45, -0.75, 0.5), zoom=1.0)
    if export:
        js = L.read_glb(L.glb_path(KEY))[0]
        rep['portal_double_sided'] = any(mt.get('name') == 'portal' and mt.get('doubleSided')
                                         for mt in js.get('materials', []))
    return rep
