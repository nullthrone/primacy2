"""cargo_pod - jettisoned cargo canister. Ribbed drum along +Y with grab rails, a grapple
fixture on one end and a status lamp. About 2 m bounding radius. Ochre accent."""

import p2lib as L
from structures import skit as K

KEY = 'cargo_pod'
RADIUS = 2.0
RB, RR = 0.93, 1.03   # body and rib radius

H, S2, D, E = 'hull_primary', 'hull_secondary', 'hull_dark', 'emissive_accent'


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'prop', RADIUS)
    acc = m.variant('hull_accent', color=(0.7, 0.42, 0.03), metallic=0.45, roughness=0.5)
    p = m.part()
    prof = [(-1.6, 0.0, D), (-1.6, 0.55, S2), (-1.44, 0.86, S2), (-1.34, RB, H)]
    body = []
    for i, y in enumerate((-1.02, -0.51, 0.0, 0.51, 1.02)):
        body.append(len(prof) - 1)
        prof += [(y - 0.11, RB, D), (y - 0.07, RR, acc if i == 2 else S2), (y + 0.07, RR, D), (y + 0.11, RB, H)]
    body.append(len(prof) - 1)
    prof += [(1.34, RB, S2), (1.44, 0.86, S2), (1.6, 0.55, D), (1.6, 0.0, D)]
    rows = p.lathe([(y, r) for y, r, _ in prof], 16, mats=[s[2] for s in prof[:-1]], axis='Y')
    panels = [f for i in body[1:-1] for k, f in enumerate(rows[i]) if k % 2 == 0]
    p.inset(panels, 0.045, 0.014, rim=D, individual=True)
    p.tube((0, 1.58, 0), (0, 1.72, 0), 0.3, segs=10, mat=D)             # grapple fixture
    p.tube((0, 1.7, 0), (0, 1.82, 0), 0.13, segs=8, mat=S2)
    p.box((0, -1.62, 0), (0.5, 0.06, 0.16), S2, chamfer=0.04)             # door bar
    p.box((0, 0.26, RR + 0.03), (0.24, 0.34, 0.1), S2, chamfer=0.03)      # lamp housing
    K.lamp(p, (0, 0.26, RR + 0.12), 0.07)
    for sx in (-1, 1):
        p.box((sx * (RB + 0.01), -0.255, 0), (0.035, 0.3, 0.2), E)        # status bars
    m.add(p)
    r = m.part()                                      # grab rails
    r.box((0, 0, RR + 0.035), (0.13, 2.6, 0.09), S2, chamfer=0.025)
    K.radial(m, r, 4, phase=45, axis='Y')
    m.empty('light_0', (0, 0.26, RR + 0.16))
    return K.finish(m, ao=ao, ao_distance=0.5, export=export, preview=preview, direction=(0.75, 1.0, 0.5),
                    zoom=0.9, require=('light_0',))
