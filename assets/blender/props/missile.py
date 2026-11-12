"""missile - seeker missile, 3 m long, nose toward +Y (glTF -Z). Glass seeker head, four
swept tail fins, four canards, glowing nozzle with engine_0 at the exit. Red accent band."""

import p2lib as L
from structures import skit as K

KEY = 'missile'
RADIUS = 1.5

H, S2, D = 'hull_primary', 'hull_secondary', 'hull_dark'


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'prop', RADIUS)
    acc = m.variant('hull_accent', color=(0.7, 0.05, 0.03), metallic=0.5, roughness=0.45)
    rb = 0.13
    p = m.part()
    prof = [  # (y, r, material of the span starting here); starts inside the nozzle
        (-1.34, 0.0, 'emissive_engine'), (-1.36, 0.07, 'emissive_engine'), (-1.5, 0.105, D), (-1.5, 0.128, D),
        (-1.4, 0.142, S2), (-1.1, 0.142, D), (-1.07, rb, H), (-0.2, rb, acc), (-0.08, rb, H), (0.62, rb, S2),
        (0.66, 0.142, S2), (0.8, 0.142, D), (0.84, 0.125, 'glass'), (1.1, 0.105, 'glass'), (1.32, 0.064, 'glass'),
        (1.45, 0.026, 'glass'), (1.5, 0.0, 'glass'),
    ]
    p.lathe([(y, r) for y, r, _ in prof], 12, mats=[s[2] for s in prof[:-1]], axis='Y')
    m.add(p)
    f = m.part()                                      # tail fin toward +X
    f.wing([(0.11, 0.0, -0.98, -1.44, 0.036), (0.3, 0.0, -1.16, -1.46, 0.024), (0.45, 0.0, -1.3, -1.47, 0.012)],
           mat=S2)
    K.radial(m, f, 4, phase=45, axis='Y')
    c = m.part()                                      # canards
    c.wing([(0.11, 0.0, 0.52, 0.2, 0.03), (0.3, 0.0, 0.37, 0.23, 0.012)], mat=acc)
    K.radial(m, c, 4, axis='Y')
    s = m.part()                                      # cable ducts
    s.box((0, -0.45, rb + 0.012), (0.036, 1.1, 0.03), D)
    K.radial(m, s, 2, phase=45, axis='Y')
    m.empty('engine_0', (0, -1.5, 0))
    rep = K.finish(m, ao=ao, ao_distance=0.2, export=export, preview=preview, direction=(0.75, 1.0, 0.45),
                   zoom=1.3, require=('engine_0',))
    if export:
        zs = rep['glb_bbox']
        rep['nose_at_min_z'] = bool(abs(zs[0][2] + 1.5) < 0.01 and rep['empties']['engine_0'][2] > 1.4)
    return rep
