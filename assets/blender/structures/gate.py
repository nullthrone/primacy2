"""gate - warp gate, 900 m across.

Twelve heavy emitter blocks, one every 30 degrees, joined by open box-truss bays. A fat
waveguide and four power and coolant conduits run through the truss from block to block. Every
block carries a field emitter on its inner face (pole piece, focusing vanes, glowing slot) and a
slim field rail links the emitters around the aperture. Bays alternate between a pair of
radiator panels standing outward in the ring plane and a service module with tanks; every bay
has a maintenance gantry on its upper chord. Four of the blocks are anchor blocks with an
outboard station-keeping module, thrusters and axial masts.

Matches packages/shared/src/structures.ts: torus major 450 / minor 45, inside a 520 m sphere,
axis along Blender +Z (glTF +Y). The heavy parts stay inside the torus tube; only radiator
panels, anchor modules and masts stand a few metres out of it (they have no colliders), and all
of them stay inside the construction cage. Child meshes:
"portal" (disc r 400, material "portal") and "scaffold" (construction cage with work platforms
and cranes) so the game can show or hide them. light_0..3 sit on the anchor blocks, light_4..11
on the other blocks. Violet accent.
"""

import math

import bmesh

import p2lib as L
from structures import skit as K

KEY = 'gate'
BOUND = 520.0
R, T = 450.0, 45.0
COLLIDERS = [dict(kind='torus', y=0.0, major=R, minor=T)]
N = 12                 # emitter blocks
PITCH = 360.0 / N
HW = 6.5               # half arc of a block, degrees
COLLAR = 1.5           # stepped collar at each block end, degrees
BAY0, BAY1 = HW + COLLAR, PITCH - HW - COLLAR      # truss bay after a block, degrees from its centre
FRAMES = 5             # truss frames per bay
RAIL_SEGS = 96

H, S2, D, E, LAMP = 'hull_primary', 'hull_secondary', 'hull_dark', 'emissive_accent', 'emissive_light'
ACC = dict(color=(0.15, 0.09, 0.5), metallic=0.55, roughness=0.4)

# Block cross-section (a = rho - R, z), counter-clockwise, with the material of the edge that
# starts at each point: 0 outer face, 2 upper deck, 4 inner face, 6 lower deck, odd = chamfers.
BLOCK = [(36, -22, H), (36, 22, H), (24, 35, H), (-14, 35, S2), (-30, 22, D), (-30, -22, S2),
         (-14, -35, H), (24, -35, H)]
TRUSS = [(26, -24), (26, 24), (-22, 24), (-22, -24)]          # longerons of the truss bays


def block_part(m, acc, prime):
    """One emitter block centred on angle 0 (radial +X, tangential +Y)."""
    p = m.part()
    f, _ = K.sweep(p, [(R + a, z) for a, z, _ in BLOCK], 4, mats=[s[2] for s in BLOCK], a0=-HW, a1=HW, cap_mat=D)
    for s in (-1, 1):                                  # stepped collars toward the truss
        a0, a1 = sorted((s * (HW - 0.2), s * (HW + COLLAR)))
        K.sweep(p, [(R + a * 0.82, z * 0.82) for a, z, _ in BLOCK], 1, mat=S2, a0=a0, a1=a1, cap_mat=D)
    p.inset([f[i][0] for i in (0, 3)], 3.0, -1.2, rim=H, inner=D, individual=True)         # outer grilles
    p.inset([f[i][0] for i in (1, 2)], 2.0, 0.5, rim=S2, inner=acc if prime else H, individual=True)
    for sy in (-1, 1):                                 # lit window strips above and below the grilles
        for sz in (-1, 1):
            p.box((R + 36.2, sy * 38, sz * 20.6), (0.5, 15, 1.0), LAMP)
    p.inset([row[j] for row in f for j in (2, 6)], 1.8, 0.6, rim=D, inner=H, individual=True)     # deck plates
    p.inset([row[j] for row in f[1:3] for j in (1, 3, 5, 7)], 1.5, -0.6, rim=S2, inner=D, individual=True)

    # field emitter on the inner face: pole piece, glowing slot, focusing vanes
    K.sweep(p, [(R - 30, -16), (R - 30, 16), (R - 40, 7), (R - 40, -7)], 2, mats=[D, S2, D, S2],
            a0=-HW + 0.7, a1=HW - 0.7, cap_mat=S2)
    K.arc_box(p, R - 40.7, R - 39.9, -2.6, 2.6, -HW + 1.5, HW - 1.5, mat=E, n=2)
    for ang in (-4.6, -1.6, 1.6, 4.6):
        K.arc_box(p, R - 42.5, R - 33.0, -14, 14, ang - 0.08, ang + 0.08, mat=D)

    for sz in (-1, 1):                                 # equipment on both decks
        for y, w in ((-27, 16), (25, 20)):
            p.box((R + 5, y, sz * 37.6), (20, w, 4.4), S2, chamfer=1.0)
        p.tube((R - 6, -7, sz * 38.2), (R - 6, 9, sz * 38.2), 2.6, segs=6, mat=H)
        p.box((R + 12, 0, sz * 36.6), (6, 6, 2.4), D)

    if prime:                                          # station-keeping module with thrusters and masts
        p.box((R + 41.5, 0, 0), (11, 40, 26), H, chamfer=3.0)
        p.box((R + 47.2, 0, 0), (0.6, 30, 7), acc)
        for sy in (-1, 1):
            p.tube((R + 42, sy * 20, 0), (R + 42, sy * 24.5, 0), 2.0, 3.4, segs=6, mat=D)
            for sz in (-1, 1):
                p.tube((R + 42, sy * 12, sz * 13), (R + 42, sy * 12, sz * 17), 1.5, 2.6, segs=6, mat=D)
        for sz in (-1, 1):
            K.mast(p, (R + 8, 0, sz * 36), (R + 8, 0, sz * 49.5), 1.5, lamp_r=1.7, lamp_mat=E)   # stays inside the cage
        K.lamp(p, (R + 49.6, 0, 0), 2.4, axis='X')
    else:
        p.box((R + 37.2, 0, 0), (2.4, 7, 7), S2, chamfer=0.8)
        K.lamp(p, (R + 40.4, 0, 0), 2.2, axis='X')
    return p


def _pipe(p, a, z, r, sides, mat, a0, a1, n=4):
    sec = [(R + a + r * math.cos(K.TAU * k / sides), z + r * math.sin(K.TAU * k / sides)) for k in range(sides)]
    K.sweep(p, sec, n, mat=mat, a0=a0, a1=a1)


def bay_part(m, acc):
    """Truss bay after the block at angle 0: lattice, waveguide, conduits, rail struts, gantry."""
    p = m.part()
    angs = [BAY0 + (BAY1 - BAY0) * i / (FRAMES - 1) for i in range(FRAMES)]
    for i, th in enumerate(angs):
        pts = [K.polar(R + a, th, z) for a, z in TRUSS]
        for j in range(4):                             # frame
            p.tube(pts[j], pts[(j + 1) % 4], 1.3, segs=4, mat=S2, cap0=False, cap1=False)
        for z in (-24, 24):                            # V struts carrying the field rail
            p.tube(K.polar(R - 22, th, z), K.polar(R - 34, th, z * 0.12), 0.8, segs=3, mat=D, cap0=False, cap1=False)
        if i + 1 < FRAMES:
            nxt = [K.polar(R + a, angs[i + 1], z) for a, z in TRUSS]
            for j in range(4):
                p.tube(pts[j], nxt[j], 1.7, segs=4, mat=H, cap0=False, cap1=False)                 # longeron
                a, b = (pts[j], nxt[(j + 1) % 4]) if (i + j) % 2 == 0 else (pts[(j + 1) % 4], nxt[j])
                p.tube(a, b, 1.0, segs=3, mat=H, cap0=False, cap1=False)                           # diagonal

    lo, hi = BAY0 - 0.4, BAY1 + 0.4                   # the pipes end inside the collars
    _pipe(p, 0, 0, 9.0, 8, S2, lo, hi)                # waveguide
    for th in angs[1:-1]:
        _pipe(p, 0, 0, 11.0, 8, H, th - 0.22, th + 0.22, 1)                                        # flanges
    _pipe(p, 24, 6, 2.2, 5, D, lo, hi)
    _pipe(p, 24, -6, 2.2, 5, acc, lo, hi)
    _pipe(p, -19, 10, 1.8, 5, D, lo, hi)
    _pipe(p, -19, -10, 1.8, 5, H, lo, hi)

    K.arc_box(p, R - 5, R + 5, 26.0, 26.8, BAY0, BAY1, mat=S2, n=2, cap_mat=D)                    # gantry deck
    for a in (-5, 5):
        K.arc_box(p, R + a - 0.25, R + a + 0.25, 28.6, 29.0, BAY0, BAY1, mat=H, n=2)              # hand rails
        for th in angs[::2]:
            K.arc_box(p, R + a - 0.25, R + a + 0.25, 26.8, 28.6, th - 0.03, th + 0.03, mat=D)
    return p


def radiator_part(m):
    """Two radiator panels standing outward in the ring plane, centred on angle 0."""
    p = m.part()
    for th in (-3.3, 3.3):
        # the panels end at R + 52 so the construction cage (outer face at R + 56) clears them
        f, _ = K.arc_box(p, R + 30, R + 52, -0.5, 0.5, th - 2.2, th + 2.2, mats=[H, D, H, D], cap_mat=D)
        p.inset([f[0][0], f[0][2]], 1.4, 0.0, rim=S2, inner=H, individual=True)
        p.tube(K.polar(R + 26, th, 0), K.polar(R + 30.5, th, 0), 1.2, segs=4, mat=D)               # root boom
        for z in (-24, 24):                                                                        # stays
            p.tube(K.polar(R + 26, th, z), K.polar(R + 41, th, z * 0.03), 0.6, segs=3, mat=D, cap0=False, cap1=False)
    return p


def service_part(m):
    """Service module on the outer chord and four tanks inside the truss, centred on angle 0."""
    p = m.part()
    p.box((R + 33, 0, 0), (9, 30, 16), H, chamfer=2.5)
    p.box((R + 37.6, 0, 2.6), (0.5, 22, 1.6), LAMP)                                                # window strip
    p.box((R + 33, 0, -9.2), (5, 8, 2.4), D)                                                       # docking collar
    K.mast(p, (R + 37, 12, 6), (R + 50, 12, 11), 0.7, lamp_r=1.0)
    for sz in (-1, 1):
        for y in (-13, 13):
            p.tube((R + 8, y - 9, sz * 17), (R + 8, y + 9, sz * 17), 5.0, segs=8, mat=H, cap_mat=S2)
    return p


def build_ring(m, acc):
    centres = [k * PITCH for k in range(N)]
    prime = [c for k, c in enumerate(centres) if k % 3 == 0]
    plain = [c for k, c in enumerate(centres) if k % 3]
    K.radial(m, block_part(m, acc, True), angles=prime)
    K.radial(m, block_part(m, acc, False), angles=plain)
    K.radial(m, bay_part(m, acc), angles=centres)
    K.radial(m, radiator_part(m), angles=[c + PITCH / 2 for k, c in enumerate(centres) if k % 2 == 0])
    K.radial(m, service_part(m), angles=[c + PITCH / 2 for k, c in enumerate(centres) if k % 2])

    p = m.part()                                       # field rail linking the emitters
    rail = [(R - 32, -3), (R - 32, 3), (R - 36, 5.5), (R - 40, 3), (R - 40, -3), (R - 36, -5.5)]
    f, _ = K.sweep(p, rail, RAIL_SEGS, mats=[S2, D, D, S2, D, D])
    per = RAIL_SEGS // N                               # glowing dash in the middle of every bay
    p.paint([f[i][3] for i in range(RAIL_SEGS) if i % per in (per // 2 - 1, per // 2)], E)
    m.add(p)

    for j, c in enumerate(prime + plain):
        m.empty('light_%d' % j, K.polar(R + (51.0 if c in prime else 42.0), c))


def build_scaffold():
    """Construction cage around the tube: square frames, rails, bracing, work platforms with
    cranes and stacked material, work lights."""
    s = L.Model(KEY, 'gate')
    p = s.part()
    corners = [(-48, -52), (56, -52), (56, 52), (-48, 52)]
    nf = 36
    step = 360.0 / nf
    for i in range(nf):
        th, th2 = (i + 0.5) * step, (i + 1.5) * step
        pts = [K.polar(R + a, th, z) for a, z in corners]
        nxt = [K.polar(R + a, th2, z) for a, z in corners]
        for j in range(4):
            p.tube(pts[j], pts[(j + 1) % 4], 1.6, segs=4, mat=S2, cap0=False, cap1=False)
            p.tube(pts[j], nxt[j], 1.3, segs=3, mat=S2, cap0=False, cap1=False)
            a, b = (pts[j], nxt[(j + 1) % 4]) if (i + j) % 2 == 0 else (pts[(j + 1) % 4], nxt[j])
            p.tube(a, b, 0.8, segs=3, mat=H, cap0=False, cap1=False)
        if i % 3 == 0:                                 # work lights on the outer corners
            for z in (-52, 52):
                K.lamp(p, K.polar(R + 58.5, th, z), 1.8, axis='Z')
    for k in range(6):                                 # work platforms on the outer face
        th = 20.0 + 60.0 * k
        K.arc_box(p, R + 57, R + 59.5, -30, 30, th - 3.5, th + 3.5, mat='hull_accent', n=2, cap_mat=D)
        foot, top, tip = K.polar(R + 58, th + 2.4, 30), K.polar(R + 58, th + 2.4, 72), K.polar(R + 14, th + 2.4, 66)
        p.tube(foot, top, 1.5, segs=4, mat='hull_accent')                                          # crane mast
        p.tube(top, tip, 1.1, segs=4, mat='hull_accent')                                           # jib
        p.tube(K.polar(R + 58, th + 2.4, 50), K.polar(R + 36, th + 2.4, 69), 0.6, segs=3, mat=D)   # jib stay
        p.tube(tip, K.polar(R + 14, th + 2.4, 50), 0.4, segs=3, mat=D)                             # hoist cable
        for q in s_stack(th):
            K.arc_box(p, *q, cap_mat=D)
        K.lamp(p, K.polar(R + 61.5, th - 2.5, 24), 1.8)
        K.lamp(p, K.polar(R + 61.5, th - 2.5, -24), 1.8)
    s.add(p)
    return s


def s_stack(th):
    """Stacked girders and crates on a work platform: arc_box arguments."""
    return [(R + 59.5, R + 63.5, -22, -6, th - 2.6, th - 0.6, H),
            (R + 59.5, R + 62.0, -2, 12, th - 2.2, th + 0.4, S2),
            (R + 62.0, R + 64.0, 0, 9, th - 1.8, th - 0.2, H)]


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
