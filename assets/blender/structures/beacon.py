"""beacon - navigation buoy. Lantern body with a caged lamp, three canted solar vanes, a
ballast keel below and a whip antenna above. Spins about +Z (glTF +Y) in the game.

Matches packages/shared/src/structures.ts: body inside the 12 m collision sphere, antenna
inside the 20 m bound. Signal-red accent.
"""

import p2lib as L
from structures import skit as K

KEY = 'beacon'
BOUND = 20.0
BODY_R = 12.0
COLLIDERS = [dict(kind='sphere', y=0.0, r=BODY_R)]

H, S2, D, E = 'hull_primary', 'hull_secondary', 'hull_dark', 'emissive_accent'


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'prop', BOUND)
    acc = m.variant('hull_accent', color=(0.7, 0.1, 0.02), metallic=0.5, roughness=0.45)
    p = m.part()
    prof = [  # (z, r, material of the span starting here)
        (-11.6, 0.0, D), (-11.2, 0.5, S2), (-7.0, 1.3, acc), (-6.2, 1.3, S2), (-4.2, 1.6, D), (-3.6, 3.4, H),
        (-3.0, 3.8, H), (-1.3, 3.8, E), (-0.9, 3.8, H), (2.4, 3.8, acc), (3.4, 3.8, H), (4.2, 3.8, D), (4.8, 2.9, D),
        (5.0, 2.5, 'emissive_light'), (5.6, 2.9, 'emissive_light'), (8.2, 2.9, 'emissive_light'), (8.8, 2.5, D),
        (9.2, 3.3, S2), (9.8, 3.3, S2), (10.5, 1.2, D), (10.8, 0.45, D), (10.8, 0.0, D),
    ]
    rows = p.lathe([(z, r) for z, r, _ in prof], 16, mats=[s[2] for s in prof[:-1]], axis='Z')
    p.inset([f for k, f in enumerate(rows[8]) if k % 2 == 0], 0.22, -0.1, rim=D, inner=S2, individual=True)
    K.mast(p, (0, 0, 10.6), (0, 0, 18.6), 0.32, lamp_r=0.42, lamp_mat=E)
    p.tube((1.6, 0, 9.9), (4.4, 0, 14.6), 0.14, 0.06, 6, D)        # side whip
    m.add(p)

    c = m.part()                                      # cage struts around the lamp
    c.tube((0, 3.45, 4.3), (0, 3.45, 9.4), 0.17, segs=6, mat=S2)
    K.radial(m, c, 4, phase=45)

    v = m.part()                                      # solar vane toward +Y, canted like a pinwheel
    b = v.box((0, 7.6, 0.9), (4.2, 6.2, 0.14), D)
    v.inset([b['sides'][0], b['sides'][2]], 0.22, 0.0, rim=S2, inner='glass', individual=True)
    v.rot('Y', 22.0, center=(0, 0, 0.9))
    v.tube((0, 3.6, 0.9), (0, 11.0, 0.9), 0.2, segs=6, mat=S2)
    v.box((0, 10.9, 0.9), (0.5, 0.5, 0.5), acc)
    K.radial(m, v, 3)

    m.empty('light_0', (0, 0, 6.9))
    m.props['p2_bound'] = BOUND
    return K.finish(m, COLLIDERS, BOUND, ao=ao, ao_distance=3.0, export=export, preview=preview,
                    direction=(0.7, -0.8, 0.35), zoom=1.0, preview_radius=15.0, target=(0, 0, 3),
                    require=('light_0',))
