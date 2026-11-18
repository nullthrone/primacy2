"""ship_delver - miner. Wide industrial bow with a visor cab, two mining laser booms
(emitter head at the hull, focusing rings along twin rails), ore drums on the flanks, a
refinery stack and two heavy engines. Hazard yellow. Catalog radius 17 m."""

import p2lib as L
from p2lib import S
from ships import kit

KEY = 'ship_delver'
RADIUS = 17.0
HARDPOINTS = [(-4.2, -1.2, -7.0), (4.2, -1.2, -7.0), (0.0, 1.8, -6.0)]


def drum(p, x, z, y0, y1, r, body, band):
    """Ribbed ore drum lying along Y."""
    prof = [(y0, 0.0), (y0, r * 0.6), (y0 + 0.15, r * 0.7), (y0 + 0.35, r)]
    mats = ['hull_dark', 'hull_secondary', 'hull_secondary']
    n = 4
    step = (y1 - y0 - 0.7) / n
    for k in range(n):
        a = y0 + 0.35 + step * k
        prof += [(a + 0.12, r * 1.06), (a + 0.4, r * 1.06), (a + 0.52, r), (a + step, r)]
        mats += ['hull_secondary', 'hull_secondary', 'hull_secondary', band if k == 1 else body]
    prof += [(y1 - 0.15, r * 0.7), (y1, r * 0.6), (y1, 0.0)]
    mats += ['hull_secondary', 'hull_secondary', 'hull_dark']
    p.lathe(prof, 20, mats=mats, origin=(x, 0.0, z))


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'ship', RADIUS, HARDPOINTS)
    yellow = m.variant('hull_accent', color=(0.78, 0.50, 0.02), metallic=0.4, roughness=0.5)
    drumc = m.variant('hull_primary', color=(0.26, 0.27, 0.28), metallic=0.55, roughness=0.55)

    # -- main hull: stout body, wide blunt bow -----------------------------------------------------
    p = m.part()
    g = p.loft([
        S(-12.0, 3.0, 2.2, 2.2, n=4.0),
        S(-9.0, 3.9, 2.7, 2.6, n=4.0),
        S(-3.0, 3.7, 2.6, 2.5, n=4.0),
        S(1.5, 4.8, 2.2, 2.4, n=4.5),
        S(5.0, 5.5, 1.7, 2.3, n=5.0),
        S(6.4, 5.3, 1.5, 2.1, n=5.0),
        S(6.9, 4.8, 1.2, 1.8, n=5.0),
    ], segs=28, spacing=1.15, cap_mat='hull_dark')
    g.paint(-12.0, 6.9, -90.0, -42.0, 'hull_secondary')
    g.paint(-10.0, -9.0, -42.0, 90.0, yellow)
    for j, f in enumerate(g.block(5.0, 6.4, -180.0, 180.0)):  # hazard band around the bow rim
        f.material_index = p.mi(yellow if (j // 2) % 2 == 0 else 'hull_dark')
    g.panels([-12.0, -10.0, -9.0, -7.0, -5.0, -3.0, -0.75, 1.5, 3.25, 5.0, 6.4, 6.9], [-42.0, -10.0, 14.0, 52.0],
             width=0.055, depth=0.028)
    g.ribbon(-8.6, 4.6, 8.0, 0.11, lift=0.045)
    g.windows(-2.4, 1.2, 24.0, 4, 0.5, 0.24, lift=0.04)
    g.greebles(-2.6, 4.4, 62.0, 86.0, 12, size=(0.3, 0.9), height=(0.06, 0.26), seed=17)
    kit.turret(p, (0.0, 6.0, 1.8), r=0.62, h=0.5, blen=1.7, barrels=1)
    for i, ex in enumerate((-1.56, 1.56)):
        kit.engine(m, p, i, (ex, -15.4, 0.0), 1.42, 3.3, segs=20)
    # ventral ore hopper
    h = p.loft([
        S(-8.4, 1.4, 0.6, 0.9, n=4.0, zc=-2.2),
        S(-7.0, 2.2, 0.8, 1.5, n=4.5, zc=-2.2),
        S(-2.0, 2.2, 0.8, 1.5, n=4.5, zc=-2.2),
        S(-0.4, 1.4, 0.6, 0.8, n=4.0, zc=-2.2),
    ], segs=16, spacing=1.3, mat='hull_secondary', cap_mat='hull_dark')
    h.paint(-5.2, -3.8, *kit.RING, yellow)
    h.panels([-8.4, -7.0, -5.2, -3.8, -2.0, -0.4], [-60.0, -20.0], width=0.05, depth=0.025)
    m.add(p)

    # -- refinery stack on the back ------------------------------------------------------------------
    p = m.part()
    t = p.loft([
        S(-10.4, 1.6, 0.8, 1.2, n=4.0, zc=2.6),
        S(-9.2, 2.2, 1.3, 1.2, n=4.5, zc=2.8),
        S(-4.6, 2.2, 1.3, 1.2, n=4.5, zc=2.8),
        S(-3.0, 1.5, 0.6, 1.0, n=4.0, zc=2.5),
    ], segs=20, spacing=1.2, cap_mat='hull_secondary')
    t.paint(-9.2, -8.0, 20.0, 90.0, yellow)
    t.panels([-10.4, -9.2, -8.0, -6.9, -5.75, -4.6, -3.0], [20.0, 60.0], width=0.05, depth=0.022)
    for f in t.block(-8.0, -4.6, 22.0, 58.0) + t.block(-8.0, -4.6, 122.0, 158.0):
        p.vent(f, bars=3, margin=0.08, depth=0.08)
    for sx in (-0.9, 0.9):  # exhaust stacks
        p.lathe([(3.6, 0.0), (3.6, 0.34), (4.9, 0.38), (5.0, 0.46), (5.3, 0.46), (5.3, 0.36), (4.6, 0.3), (4.6, 0.0)],
                10, mats=['hull_dark', 'hull_secondary', 'hull_secondary', 'hull_dark', 'hull_dark', 'hull_dark',
                          'emissive_light'], axis='Z', origin=(sx, -6.4, 0.0))
    kit.antenna(p, (0.0, -9.4, 4.0), (0.0, -10.2, 5.6), 0.05, light='emissive_light')
    m.add(p)
    m.empty('light_0', (0.0, -10.2, 5.6))

    # -- visor cab under the bow brow ----------------------------------------------------------------
    kit.canopy(m, [
        S(4.4, 2.2, 0.9, 1.0, n=3.0, zc=-0.25),
        S(6.6, 2.5, 1.0, 1.1, n=3.0, zc=-0.3),
        S(7.7, 2.1, 0.8, 0.95, n=2.6, zc=-0.35),
        S(8.3, 1.1, 0.35, 0.5, n=2.2, zc=-0.45),
    ], segs=20, spacing=0.55, a_cuts=(-38.0, 20.0), y_cuts=[4.4, 6.6, 7.7, 8.3], bar=0.07)
    m.empty('cockpit', (0.0, 7.2, -0.1))

    # -- flank assembly (right, mirrored): ore drums, cradle, mining laser boom ----------------------
    p = m.part()
    for y in (-7.9, -5.6, -3.0, -0.9):
        p.box((4.6, y, 0.0), (2.2, 0.7, 1.7), 'hull_secondary', chamfer=0.2)
    p.box((5.6, -4.3, 2.0), (0.5, 7.6, 0.3), yellow, chamfer=0.08)
    # boom: two rails from the bow, focusing rings, emitter head at the hardpoint
    bx, bz = 4.2, -1.2
    for dx in (-0.74, 0.74):
        p.box((bx + dx, 10.4, bz), (0.34, 9.6, 0.56), yellow, taper=(0.6, 0.6), chamfer=0.07)
        p.box((bx + dx, 6.4, bz), (0.5, 2.0, 0.8), 'hull_secondary', chamfer=0.1)
    p.bevel(0.035, 2, 35.0)
    drum(p, 5.65, 0.0, -9.2, -4.9, 1.85, drumc, yellow)
    drum(p, 5.65, 0.0, -4.5, -0.2, 1.85, drumc, yellow)
    p.lathe([(5.6, 0.0), (5.6, 0.66), (6.7, 0.66), (6.92, 0.54), (7.0, 0.4), (6.86, 0.3), (6.86, 0.0)], 16,
            mats=['hull_dark', 'hull_secondary', 'hull_secondary', 'hull_dark', 'hull_dark', 'emissive_accent'],
            origin=(bx, 0.0, bz))
    for k, y in enumerate((9.2, 12.2, 15.0)):
        ro = 1.02 - 0.1 * k
        p.lathe([(y - 0.2, 0.5), (y - 0.2, ro), (y + 0.2, ro), (y + 0.2, 0.5), (y - 0.2, 0.5)], 16,
                mats=['hull_dark', 'hull_secondary', 'hull_dark', 'emissive_accent'], origin=(bx, 0.0, bz))
    kit.lamp(m, p, 2, (bx, 15.25, bz + 0.95), 0.16)
    p.pipe([(4.3, -2.4, 2.3), (4.3, 2.6, 2.1), (4.9, 5.4, 1.5)], 0.11, 6, 'hull_dark')
    m.add(p, mirror=True)
    m.empty('light_1', (-bx, 15.25, bz + 0.95))

    return kit.finish(m, ao=ao, export=export, preview=preview)
