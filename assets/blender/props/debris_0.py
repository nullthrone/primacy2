"""debris_0 - torn hull plate: a curved piece of outer skin with bites ripped out of its outline
and one corner peeled up, stringers and two frames still riveted to the inside."""

import math
import random

from mathutils import Vector

import p2lib as L
from props import debriskit as DK

KEY = 'debris_0'
H, S2 = 'hull_primary', 'hull_secondary'
NX, NY = 9, 6          # skin cells
SKIN = 0.045           # skin thickness
# cells ripped out of the outline
GONE = {(0, 0), (1, 0), (0, 1), (NX - 1, NY - 1), (NX - 1, NY - 2), (NX - 2, NY - 1), (4, 0), (NX - 1, 0), (3, NY - 1)}


def surf(x, y):
    """Height of the outer skin: a cylinder section with the (+x, +y) corner peeled upward."""
    return -0.28 * y * y + 1.5 * max(0.0, x - 0.5) * max(0.0, y - 0.05)


def build(export=True, preview=True, ao=True):
    rng = random.Random(501)
    m = L.Model(KEY, 'debris', 1.0)
    p = m.part()
    bm = p.bm
    mh, ms = p.mi(H), p.mi(S2)

    def kept(i, j):
        return 0 <= i < NX and 0 <= j < NY and (i, j) not in GONE

    top, bot, tear = {}, {}, []
    for i in range(NX + 1):
        for j in range(NY + 1):
            around = [kept(i - 1, j - 1), kept(i, j - 1), kept(i - 1, j), kept(i, j)]
            if not any(around):
                continue
            x, y = -1.1 + 2.2 * i / NX, -0.7 + 1.4 * j / NY
            if not all(around):                        # outline vertex: ragged
                x += rng.uniform(-0.075, 0.075)
                y += rng.uniform(-0.075, 0.075)
            z = surf(x, y)
            top[i, j] = bm.verts.new((x, y, z))
            bot[i, j] = bm.verts.new((x, y, z - SKIN))
            if not all(around) and (i < 4 or (i, j) in ((4, 0), (5, 0), (4, 1), (5, 1)) or (i > 6 and j > 3)):
                tear.append((x, y, z))

    up = Vector((0, 0, 1))
    for i in range(NX):
        for j in range(NY):
            if not kept(i, j):
                continue
            ring = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            L._mkface(bm, [top[k] for k in ring], ms if i == 6 else mh, up)       # one darker panel row
            L._mkface(bm, [bot[k] for k in ring], ms, -up)
            centre = sum((top[k].co for k in ring), Vector()) / 4.0
            for (a, b), (di, dj) in zip(zip(ring, ring[1:] + ring[:1]), ((0, -1), (1, 0), (0, 1), (-1, 0))):
                if not kept(i + di, j + dj):           # torn edge of the skin
                    mid = (top[a].co + top[b].co) * 0.5
                    L._mkface(bm, [top[a], top[b], bot[b], bot[a]], ms, mid - centre)

    def tilt(y):
        return math.degrees(math.atan(-0.56 * y))

    for y, x0, x1 in ((-0.42, -0.72, 1.32), (0.0, -1.3, 0.62), (0.4, -0.9, 0.42)):         # stringers
        p.box(((x0 + x1) / 2, y, surf(0.0, y) - SKIN - 0.055), (x1 - x0, 0.05, 0.11), S2, rot=(tilt(y), 0, 0))
        tear += [(x0, y, surf(0.0, y) - 0.1), (x1, y, surf(0.0, y) - 0.1)]
    for x, ya, yb in ((-0.38, -0.62, 0.66), (0.45, -0.55, 0.3)):                           # frames
        n = 4
        for k in range(n):
            y0, y1 = ya + (yb - ya) * k / n, ya + (yb - ya) * (k + 1) / n
            ym = (y0 + y1) / 2
            p.box((x, ym, surf(0.0, ym) - SKIN - 0.085), (0.045, (y1 - y0) * 1.03, 0.17), S2, rot=(tilt(ym), 0, 0))
    m.add(p)
    return DK.finish(m, tear, direction=(0.5, -0.6, -0.62), export=export, preview=preview, ao=ao)
