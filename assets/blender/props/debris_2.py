"""debris_2 - shattered engine bell: two thirds of a nozzle skirt with a jagged, broken rim,
still on its thrust chamber, with cooling manifolds and the stumps of two feed lines.
The outside and the machinery are dark, the liner and the fittings light."""

import math
import random

import p2lib as L
from props import debriskit as DK
from structures import skit as K

KEY = 'debris_2'
H, S2 = 'hull_primary', 'hull_secondary'
# bell wall (rho, z): outer skin from the throat to the exit, then the inner skin back down
OUTER = [(0.24, 0.0), (0.36, 0.25), (0.52, 0.55), (0.66, 0.88), (0.76, 1.25)]
INNER = [(0.71, 1.25), (0.61, 0.88), (0.47, 0.55), (0.31, 0.25), (0.19, 0.0)]
ARC, SEGS = 255.0, 12


def build(export=True, preview=True, ao=True):
    rng = random.Random(521)
    m = L.Model(KEY, 'debris', 1.0)
    p = m.part()
    K.sweep(p, OUTER + INNER, SEGS, mats=[S2] * 4 + [H] * 6, a0=0.0, a1=ARC, cap_mat=H)

    # break the rim: every column of the exit ring is pulled back toward the ring below it by
    # its own amount, the columns at the two torn ends furthest
    keep = [rng.choice((0.0, 0.25, 0.55, 0.8, 1.0, 1.0)) for _ in range(SEGS + 1)]
    keep[0], keep[1], keep[-1], keep[-2] = 0.0, 0.4, 0.05, 0.5
    tear = []
    for v in p.bm.verts:
        if v.co.z < 1.2:
            continue
        rho = math.hypot(v.co.x, v.co.y)
        ang = math.degrees(math.atan2(v.co.y, v.co.x)) % 360.0
        f = keep[min(int(round(ang / (ARC / SEGS))), SEGS)]
        below = 0.66 if rho > 0.74 else 0.61
        r2 = below + (rho - below) * f
        v.co.x, v.co.y, v.co.z = v.co.x * r2 / rho, v.co.y * r2 / rho, 0.88 + 0.37 * f
        if f < 0.75:
            tear.append(tuple(v.co))
    for z in (0.0, 0.3, 0.6, 0.9):                     # the two radial tears
        for ang in (0.0, ARC):
            tear.append(K.polar(0.3 + 0.4 * z, ang, z))

    p.tube((0, 0, -0.36), (0, 0, 0.02), 0.27, segs=10, mat=S2, cap_mat=H)                    # thrust chamber
    p.tube((0, 0, -0.07), (0, 0, 0.0), 0.34, segs=10, mat=H)                                 # throat flange
    p.tube((0, 0, -0.46), (0, 0, -0.36), 0.12, segs=6, mat=H)                                # gimbal stub
    for z, rho, a1 in ((0.55, 0.53, 215.0), (0.9, 0.675, 150.0)):                             # cooling manifolds
        K.sweep(p, [(rho, z - 0.035), (rho + 0.06, z - 0.035), (rho + 0.06, z + 0.035), (rho, z + 0.035)], 8,
                mat=H, a0=8.0, a1=a1)
        tear.append(K.polar(rho, a1, z))
    for a, b, c in (((0.25, 0.05, -0.22), (0.52, 0.12, -0.14), (0.63, 0.18, 0.3)),
                    ((-0.1, 0.25, -0.2), (-0.2, 0.5, -0.3), (-0.42, 0.62, -0.26))):           # feed line stumps
        p.tube(a, b, 0.05, segs=5, mat=H)
        p.tube(b, c, 0.05, segs=5, mat=H)
        tear.append(c)
    m.add(p)
    return DK.finish(m, tear, reach=0.36, direction=(-0.45, 0.65, 0.6), export=export, preview=preview, ao=ao)
