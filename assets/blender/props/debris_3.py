"""debris_3 - pipe and conduit cluster: six lines of different gauges still held by two clamp
brackets, sheared off at different lengths, three of them kinked at the break."""

import p2lib as L
from props import debriskit as DK

KEY = 'debris_3'
H, S2 = 'hull_primary', 'hull_secondary'
# (y, z, radius, x0, x1, material, kinked stub (dx, dy, dz) beyond one end or None)
PIPES = [(-0.30, 0.00, 0.100, -1.00, 0.95, H, (0.30, -0.15, 0.20)),
         (-0.06, 0.02, 0.070, -1.35, 0.60, S2, None),
         (0.14, -0.02, 0.085, -0.80, 1.30, H, (-0.30, 0.20, -0.12)),
         (0.34, 0.01, 0.055, -1.15, 1.00, H, (0.26, 0.16, 0.10)),
         (0.05, 0.20, 0.040, -0.90, 0.90, S2, None),
         (-0.20, 0.20, 0.035, -1.20, 0.70, H, None)]
CLAMPS = (-0.45, 0.4)


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'debris', 1.0)
    p = m.part()
    tear = []
    for y, z, r, x0, x1, mat, stub in PIPES:
        p.tube((x0, y, z), (x1, y, z), r, segs=6, mat=mat, cap_mat=S2)
        tear += [(x0, y, z), (x1, y, z)]
        if stub:
            xs = x1 if stub[0] > 0 else x0
            tip = (xs + stub[0], y + stub[1], z + stub[2])
            p.tube((xs, y, z), tip, r, r * 0.8, segs=6, mat=mat, cap_mat=S2)
            tear.append(tip)
        if r > 0.06:                                   # flange on the heavy lines
            fx = -0.1 + y
            p.tube((fx, y, z), (fx + 0.06, y, z), r * 1.4, segs=6, mat=S2)
    for x in CLAMPS:                                   # bracket: two bars and two posts around the bundle
        p.box((x, 0.02, -0.135), (0.1, 0.9, 0.05), S2)
        p.box((x, 0.02, 0.135), (0.1, 0.9, 0.05), S2)
        for y in (-0.45, 0.49):
            p.box((x, y, 0.0), (0.1, 0.04, 0.32), S2)
    p.box((0.0, -0.06, 0.02), (0.3, 0.2, 0.2), S2, chamfer=0.04)                             # valve body
    p.tube((0.0, -0.06, 0.12), (0.0, -0.06, 0.3), 0.025, segs=4, mat=S2)                     # valve stem
    p.tube((-0.08, -0.06, 0.3), (0.08, -0.06, 0.3), 0.02, segs=4, mat=S2)
    m.add(p)
    return DK.finish(m, tear, reach=0.32, export=export, preview=preview, ao=ao)
