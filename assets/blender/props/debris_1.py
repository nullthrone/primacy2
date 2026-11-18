"""debris_1 - broken truss section: three bays of a box girder. The longerons snapped at
different lengths and two are bent where they tore, some braces are gone and one hangs loose."""

import p2lib as L
from props import debriskit as DK

KEY = 'debris_1'
H, S2 = 'hull_primary', 'hull_secondary'
W = 0.32                                              # half width of the square section
CORNERS = [(-W, -W), (W, -W), (W, W), (-W, W)]
FRAMES = [-0.9, -0.3, 0.3, 0.9]
# per longeron: where it starts and ends along x, and the bent stub beyond one end (dx, dy, dz) or None
LONGERONS = [(-1.25, 1.05, None), (-0.95, 1.10, (0.32, 0.20, -0.25)), (-1.15, 0.72, (-0.30, -0.12, 0.28)),
             (-1.05, 1.30, None)]
MISSING = {(0, 1), (2, 2), (1, 3), (2, 1)}            # (bay, face) braces that broke away


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'debris', 1.0)
    p = m.part()
    tear = []
    for (y, z), (x0, x1, stub) in zip(CORNERS, LONGERONS):
        p.tube((x0, y, z), (x1, y, z), 0.046, segs=5, mat=H)
        tear += [(x0, y, z), (x1, y, z)]
        if stub:
            xs = x1 if stub[0] > 0 else x0
            tip = (xs + stub[0], y + stub[1], z + stub[2])
            p.tube((xs, y, z), tip, 0.046, 0.04, segs=5, mat=H)
            tear.append(tip)

    def reaches(j, x):
        return LONGERONS[j][0] - 0.02 <= x <= LONGERONS[j][1] + 0.02

    for x in FRAMES:                                   # frames, only between longerons that still reach them
        for j in range(4):
            k = (j + 1) % 4
            a, b = (x, *CORNERS[j]), (x, *CORNERS[k])
            if reaches(j, x) and reaches(k, x):
                p.tube(a, b, 0.03, segs=4, mat=S2, cap0=False, cap1=False)
            elif reaches(j, x):                        # snapped member, half left
                half = tuple((a[q] + b[q]) * 0.5 + (0.05 if q == 0 else 0.0) for q in range(3))
                p.tube(a, half, 0.03, segs=4, mat=S2)
                tear.append(half)
        for j in range(4):                             # gusset blocks at the nodes
            if reaches(j, x):
                p.box((x, *CORNERS[j]), (0.1, 0.1, 0.1), S2)

    for bay in range(3):                               # diagonal braces on the four faces
        x0, x1 = FRAMES[bay], FRAMES[bay + 1]
        for j in range(4):
            k = (j + 1) % 4
            if (bay, j) in MISSING or not (reaches(j, x0) and reaches(k, x1) and reaches(j, x1) and reaches(k, x0)):
                continue
            a, b = ((x0, *CORNERS[j]), (x1, *CORNERS[k])) if (bay + j) % 2 == 0 else ((x0, *CORNERS[k]), (x1, *CORNERS[j]))
            p.tube(a, b, 0.022, segs=4, mat=S2, cap0=False, cap1=False)
    loose = (0.28, -W - 0.3, W + 0.22)                 # a brace hanging by one end
    p.tube((FRAMES[0], *CORNERS[0]), loose, 0.022, segs=4, mat=S2)
    tear.append(loose)
    m.add(p)
    return DK.finish(m, tear, reach=0.32, export=export, preview=preview, ao=ao)
