"""station_ring - large wheel station. An octagonal habitat ring braced to a long spindle hub
by four spokes and sixteen stays; docking bay on the +Z (glTF +Y) end of the hub.

Matches packages/shared/src/structures.ts: torus major 700 / minor 75, hub cylinder r 150
from -260 to +260 on the axis, everything inside an 800 m sphere. Amber accent.
"""

import math
import random

import p2lib as L
from structures import skit as K

KEY = 'station_ring'
BOUND = 800.0
R, T = 700.0, 75.0
HUB_R, HUB_Z = 150.0, 260.0
COLLIDERS = [dict(kind='torus', y=0.0, major=R, minor=T),
             dict(kind='cylinder', y0=-HUB_Z, y1=HUB_Z, r=HUB_R)]
SEGS = 144    # ring segments (2.5 degrees, about 30 m)
HSEGS = 48    # hub segments
DOCK_Z = 280.0

H, S2, D = 'hull_primary', 'hull_secondary', 'hull_dark'
OCT = [(70, -26), (70, 26), (26, 70), (-26, 70), (-70, 26), (-70, -26), (-26, -70), (26, -70)]


def _lerp(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


def ring_section():
    """Habitat cross-section as (a, z, material, tag) with a = rho - R, counter-clockwise.

    An octagon inscribed in the 75 m collider circle: tread band on the outer face, a service
    trench on both axial faces, a glass skylight facing the hub, window bands in between.
    """
    pts = []

    def side(p, q, cuts, mats, tags):
        for t, mm, tg in zip([0.0] + cuts, mats, tags):
            pts.append(_lerp(p, q, t) + (mm, tg))

    pts += [(70, -26, H, ''), (70, -14, D, 'dash'), (73, -12, D, 'tread'), (73, 12, D, 'dash'), (70, 14, H, '')]
    side((70, 26), (26, 70), [0.44, 0.56], [S2, S2, S2], ['', 'win', ''])
    pts += [(26, 70, H, ''), (22, 70, H, 'win'), (18, 70, H, ''), (15, 70, D, ''), (13, 66, S2, 'trench'),
            (-13, 66, D, ''), (-15, 70, H, ''), (-18, 70, H, 'win'), (-22, 70, H, '')]
    side((-26, 70), (-70, 26), [0.26, 0.36, 0.64, 0.74], [H] * 5, ['', 'win', '', 'win', ''])
    pts += [(-70, 26, H, ''), (-70, 17, D, ''), (-67, 14, 'glass', 'sky'), (-67, -14, D, ''), (-70, -17, H, '')]
    side((-70, -26), (-26, -70), [0.26, 0.36, 0.64, 0.74], [H] * 5, ['', 'win', '', 'win', ''])
    pts += [(-26, -70, H, ''), (-22, -70, H, 'win'), (-18, -70, H, ''), (-15, -70, D, ''), (-13, -66, S2, 'trench'),
            (13, -66, D, ''), (15, -70, H, ''), (18, -70, H, 'win'), (22, -70, H, '')]
    side((26, -70), (70, -26), [0.44, 0.56], [S2, S2, S2], ['', 'win', ''])
    return pts


def build_ring(m, acc):
    rng = random.Random(7)
    sec = ring_section()
    step = 360.0 / SEGS
    p = m.part()
    # phase -step/2: segment i is centred on the angle i * step
    faces, _ = K.sweep(p, [(R + a, z) for a, z, _, _ in sec], SEGS, mats=[s[2] for s in sec], phase=-step / 2)
    ribs = [k * 9 for k in range(16)]                 # one structural rib every 22.5 degrees
    covered = set(ribs)
    for k in range(4):                                # wide accent collars where the spokes land
        covered.update(((k * 36 - 1) % SEGS, (k * 36 + 1) % SEGS))
    lit = []
    for k, s in enumerate(sec):
        tag = s[3]
        if tag == 'win':
            i = rng.randint(0, 2)
            while i < SEGS:
                run = rng.randint(2, 6)
                lit += [faces[j][k] for j in range(i, min(i + run, SEGS)) if j not in covered]
                i += run + rng.randint(1, 3)
        elif tag == 'dash':
            p.paint([faces[i][k] for i in range(SEGS) if i % 6 < 4 and i not in covered], 'emissive_accent')
        elif tag == 'sky':
            p.paint([faces[i][k] for i in range(SEGS) if i % 3 == 1], D)
        elif tag == 'tread':
            near = [i for i in range(SEGS) if min((i - 36 * q) % SEGS for q in range(4)) <= 6
                    or min((36 * q - i) % SEGS for q in range(4)) <= 6]
            p.paint([faces[i][k] for i in near], acc)
    p.inset(lit, 1.0, -0.5, rim=D, inner='emissive_light', individual=True)
    m.add(p)

    q = m.part()
    for k in range(16):
        big = (k % 4 == 0)
        w, sc = (1.5, 1.045) if big else (0.5, 1.03)
        K.sweep(q, [(R + a * sc, z * sc) for a, z in OCT], 3 if big else 1, mat=acc if big else S2,
                a0=(k * 9 - w) * step, a1=(k * 9 + w) * step, cap_mat=D)
    m.add(q)

    g = m.part()                                      # plant and cargo blocks in the service trenches
    for sz in (1, -1):
        for _ in range(64):
            ang = rng.uniform(0.0, 360.0)
            la = math.degrees(rng.uniform(6.0, 22.0) / R)
            ra, rw, h = rng.uniform(-11.0, 5.0), rng.uniform(3.0, 7.0), rng.uniform(1.2, 3.4)
            z0, z1 = (65.5, 66.0 + h) if sz > 0 else (-66.0 - h, -65.5)
            K.arc_box(g, R + ra, R + ra + rw, z0, z1, ang, ang + la, mat=rng.choice((D, S2, H)))
    m.add(g)

    n = m.part()                                      # navigation lamps on the rim, between the spokes
    n.box((0, R + 73.6, 0), (5, 3, 5), 'emissive_light', chamfer=1.2)
    K.radial(m, n, 4, phase=-45)
    for j in range(4):
        m.empty('light_%d' % (4 + j), K.polar(R + 76.0, 45 + 90 * j))

    a = m.part()                                      # antenna cluster (built toward +Y)
    for x, z, ln, r in ((-9, 7, 19, 1.3), (9, -6, 13, 1.0), (-3, -9, 9, 0.8), (11, 8, 6, 0.7)):
        K.mast(a, (x, R + 71, z), (x, R + 73 + ln, z), r, lamp_r=r * 1.3)
    a.box((0, R + 74, 0), (30, 3, 24), S2, chamfer=4)
    K.radial(m, a, angles=[-45, 135])


def build_hub(m, acc):
    p = m.part()
    prof = [  # (z, r, material of the span starting here, tag)
        (-260, 0, D, ''), (-260, 58, S2, ''), (-238, 104, D, ''), (-234, 132, H, ''), (-222, 132, acc, ''),
        (-214, 132, H, ''), (-196, 132, S2, ''), (-186, 118, D, ''), (-182, 100, S2, ''), (-88, 100, D, ''),
        (-84, 140, H, ''), (-74, 150, H, ''), (-52, 150, H, 'win'), (-46, 150, H, ''), (-22, 150, D, ''),
        (-20, 146, D, ''), (20, 146, D, ''), (22, 150, H, ''), (46, 150, H, 'win'), (52, 150, H, ''),
        (74, 150, H, ''), (84, 140, D, ''), (88, 100, S2, ''), (168, 100, D, ''), (172, 120, H, ''),
        (206, 150, H, ''), (222, 150, H, 'win'), (228, 150, acc, ''), (240, 150, H, ''), (252, 150, S2, ''),
        (260, 142, S2, ''), (260, 118, D, ''), (250, 112, D, ''), (250, 98, 'emissive_accent', ''),
        (250, 92, S2, ''), (250, 40, 'emissive_accent', ''), (250, 34, D, ''), (253, 30, H, ''), (253, 0, H, ''),
    ]
    rows = p.lathe([(z, r) for z, r, _, _ in prof], HSEGS, mats=[s[2] for s in prof[:-1]], axis='Z')
    win = [f for i, s in enumerate(prof[:-1]) if s[3] == 'win' for k, f in enumerate(rows[i]) if k % 4 != 3]
    p.inset(win, 0.9, -0.4, rim=D, inner='emissive_light', individual=True)
    m.add(p)

    f = m.part()                                      # radiator fins around the lower neck
    f.box((0, 123, -135), (3.2, 46, 86), D)
    f.box((0, 144.5, -135), (4.6, 3, 86), S2)
    K.radial(m, f, 16, phase=11.25)

    t = m.part()                                      # tanks around the upper neck
    t.tube((0, 123, 91), (0, 123, 165), 15, segs=12, mat=H, cap_mat=D)
    t.tube((0, 123, 120), (0, 123, 134), 15.8, segs=12, mat=acc)
    K.radial(m, t, 8, phase=22.5)

    d = m.part()                                      # docking bay: rim lamps
    d.box((0, 130, 260.6), (5, 5, 2.4), 'emissive_light', chamfer=0.8)
    K.radial(m, d, 12)
    d = m.part()                                      # approach strips on the bay floor, guide pylons
    d.box((0, 65, 250.3), (3, 44, 1.4), 'emissive_accent')
    d.tube((0, 131, 258), (0, 131, 274), 2.6, 1.6, 8, S2)
    K.lamp(d, (0, 131, 276), 2.8)
    K.radial(m, d, 4, phase=45)
    for j in range(4):
        m.empty('light_%d' % j, K.polar(131, 135 + 90 * j, 277))
    m.empty('dock_0', (0, 0, DOCK_Z))

    a = m.part()                                      # antenna cluster on the far end
    K.mast(a, (0, 0, -256), (0, 0, -320), 3.2, lamp_r=2.2)
    for ang, ln, rr in ((20, 34, 34), (140, 24, 40), (255, 42, 30)):
        x, y, _ = K.polar(rr, ang)
        K.mast(a, (x, y, -252), (x, y, -260 - ln), 1.6, lamp_r=1.4)
    a.tube((-13, 0, -292), (13, 0, -292), 0.8, segs=6, mat=D)
    a.tube((0, -9, -304), (0, 9, -304), 0.7, segs=6, mat=D)
    a.lathe([(-262, 0.0), (-266, 12), (-274, 21), (-275, 21), (-268, 12.5), (-264.5, 0.0)], 16, S2,
            axis='Z', origin=(-30, -22, 0))
    m.add(a)


def build_spokes(m, acc):
    s = m.part()                                      # one spoke toward +Y, copied four times
    s.prism(L.octo(24, 18, 5), 146, 634, S2)
    s.prism(L.octo(46, 36, 9), 143, 180, H, scale1=(0.6, 0.6))
    s.prism(L.octo(30, 22, 6), 592, 634, H, scale1=(1.9, 1.7))
    for y in (262, 400, 520):
        s.box((0, y, 0), (32, 16, 26), H, chamfer=6)
    s.box((0, 331, 0), (34, 30, 30), acc, chamfer=7)   # lift car
    for sz in (1, -1):
        s.box((0, 390, sz * 9.3), (2.2, 400, 1.6), 'emissive_accent')
    for da in (-14, 14):                              # stays from the hub ends to the ring
        for sz in (1, -1):
            r0 = 138 if sz > 0 else 122
            s.tube(K.polar(r0, 90 + da * 0.25, sz * 216), K.polar(657, 90 + da, sz * 47), 2.2, segs=6, mat=D)
    K.radial(m, s, 4)


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'station', BOUND)
    acc = m.variant('hull_accent', color=(0.62, 0.27, 0.03), metallic=0.55, roughness=0.42)
    build_ring(m, acc)
    build_hub(m, acc)
    build_spokes(m, acc)
    m.props['p2_bound'] = BOUND
    return K.finish(m, COLLIDERS, BOUND, ao=ao, ao_distance=60.0, export=export, preview=preview,
                    direction=(0.5, -0.72, 0.62), zoom=1.0, require=('dock_0',))
