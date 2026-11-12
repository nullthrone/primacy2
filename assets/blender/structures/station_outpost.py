"""station_outpost - small platform. A squat three-deck drum with the landing pad on its +Z
(glTF +Y) face, two solar wings, a tank arm, a dish arm and a long instrument mast below.

Matches packages/shared/src/structures.ts: core cylinder r 110 from -90 to +90 on the axis,
everything inside a 240 m sphere. Amber accent (station class).
"""

import p2lib as L
from structures import skit as K

KEY = 'station_outpost'
BOUND = 240.0
CORE_R, CORE_Z = 110.0, 90.0
COLLIDERS = [dict(kind='cylinder', y0=-CORE_Z, y1=CORE_Z, r=CORE_R)]
SEGS = 40
DOCK_Z = 105.0

H, S2, D, E = 'hull_primary', 'hull_secondary', 'hull_dark', 'emissive_accent'


def build_core(m, acc):
    p = m.part()
    prof = [  # (z, r, material of the span starting here, tag)
        (-90, 0, D, ''), (-90, 60, S2, ''), (-74, 92, D, ''), (-72, 106, H, ''), (-68, 110, H, ''),
        (-50, 110, H, 'win'), (-45, 110, H, ''), (-30, 110, D, ''), (-28, 100, D, ''), (-4, 100, D, ''),
        (-2, 110, H, ''), (14, 110, H, 'win'), (19, 110, H, ''), (34, 110, acc, ''), (42, 110, H, ''),
        (58, 110, S2, ''), (70, 98, S2, ''), (70, 88, D, ''), (84, 84, H, ''), (90, 80, E, ''), (90, 76, S2, ''),
        (90, 30, E, ''), (90, 27, D, ''), (90, 0, D, ''),
    ]
    rows = p.lathe([(z, r) for z, r, _, _ in prof], SEGS, mats=[s[2] for s in prof[:-1]], axis='Z')
    win = [f for i, s in enumerate(prof[:-1]) if s[3] == 'win' for k, f in enumerate(rows[i]) if k % 3 != 2]
    p.inset(win, 0.8, -0.35, rim=D, inner='emissive_light', individual=True)
    m.add(p)

    d = m.part()                                      # landing pad: cross of approach strips
    d.box((0, 53, 90.2), (2.4, 42, 1.0), 'emissive_light')
    K.radial(m, d, 4, phase=45)
    d = m.part()                                      # pad perimeter lamps
    d.box((0, 72, 90.5), (3.2, 3.2, 1.8), 'emissive_light', chamfer=0.7)
    K.radial(m, d, 8, phase=22.5)
    for j in range(4):
        m.empty('light_%d' % j, K.polar(72, 112.5 + 90 * j, 92))
    m.empty('dock_0', (0, 0, DOCK_Z))

    t = m.part()                                      # control tower on the shoulder
    t.box((0, 93, 80), (14, 9, 22), H, chamfer=2)
    t.box((0, 93, 86), (14.8, 9.8, 3.2), 'glass', chamfer=1.2)
    K.mast(t, (3, 93, 90), (3, 93, 101), 0.6, lamp_r=0.9)
    K.radial(m, t, angles=[-60])
    c = m.part()                                      # cargo stacked on the shoulder
    for ang, mat, h in ((20, acc, 6), (28, S2, 9), (36, H, 6), (150, S2, 6), (158, acc, 10),
                        (200, H, 7), (208, D, 5), (262, S2, 8)):
        x, y, _ = K.polar(93, ang)
        c.box((x, y, 70 + h / 2 - 0.3), (7, 7, h), mat, chamfer=1.0, rot=(0, 0, ang))
    m.add(c)


def build_arms(m, acc):
    s = m.part()                                      # solar wing toward +Y
    s.tube((0, 98, -16), (0, 231, -16), 2.6, segs=8, mat=S2)
    s.box((0, 104, -16), (13, 12, 13), H, chamfer=3)
    for yc in (132, 172, 212):
        s.tube((-38, yc - 19.5, -16), (38, yc - 19.5, -16), 0.9, segs=6, mat=D)
        for sx in (-1, 1):
            b = s.box((sx * 21.5, yc, -16), (33, 35, 1.0), D)
            s.inset([b['sides'][0], b['sides'][2]], 1.2, 0.0, rim=H, inner='glass', individual=True)
    K.radial(m, s, angles=[0, 180])

    t = m.part()                                      # tank arm
    t.tube((0, 98, -16), (0, 150, -16), 2.4, segs=6, mat=S2)
    t.box((0, 148, -16), (36, 5, 4), D)
    for sx in (-1, 1):
        t.lathe([(-44, 0.0), (-42, 9), (-36, 13), (-20, 13), (-14, 13), (6, 13), (12, 9), (14, 0.0)], 12,
                mats=[D, H, H, acc, H, H, D], axis='Z', origin=(sx * 16, 148, -16))
    K.radial(m, t, angles=[-90])

    c = m.part()                                      # dish arm
    c.tube((0, 98, -16), (0, 141, -16), 2.0, segs=6, mat=S2)
    c.lathe([(140, 0.0), (144, 14), (152, 24), (153.5, 24), (148, 14.5), (144.5, 0.0)], 16,
            mats=[S2, S2, D, H, H], axis='Y', origin=(0, 0, -16))
    c.tube((0, 144, -16), (0, 160, -16), 0.7, segs=6, mat=D)
    K.lamp(c, (0, 160, -16), 1.2, mat=E)
    K.radial(m, c, angles=[90])

    a = m.part()                                      # instrument mast below the core
    K.mast(a, (0, 0, -86), (0, 0, -226), 5.0, mat=S2, lamp_r=2.4, segs=8)
    a.lathe([(-110, 4.0), (-108, 14), (-98, 14), (-96, 4.0)], 12, mats=[D, acc, D], axis='Z')
    for z, ln in ((-126, 26), (-152, 18), (-180, 12)):
        a.tube((-ln, 0, z), (ln, 0, z), 1.0, segs=6, mat=D)
        a.tube((0, -ln * 0.7, z - 7), (0, ln * 0.7, z - 7), 0.8, segs=6, mat=D)
        for sx in (-1, 1):
            K.lamp(a, (sx * ln, 0, z), 1.3, mat=E)
    m.add(a)
    m.empty('light_4', (0, 0, -228))


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'station', BOUND)
    acc = m.variant('hull_accent', color=(0.62, 0.27, 0.03), metallic=0.55, roughness=0.42)
    build_core(m, acc)
    build_arms(m, acc)
    m.props['p2_bound'] = BOUND
    return K.finish(m, COLLIDERS, BOUND, ao=ao, ao_distance=25.0, export=export, preview=preview,
                    direction=(0.62, -0.62, 0.48), zoom=1.05, require=('dock_0',))
