"""ship_lancet - light fighter. Needle nose, one large and two small engines, thin swept
wings carrying long lance cannons, chin gun pod. Crimson accent. Catalog radius 10 m."""

import p2lib as L
from p2lib import S
from ships import kit

KEY = 'ship_lancet'
RADIUS = 10.0
HARDPOINTS = [(-3.4, -0.2, -2.0), (3.4, -0.2, -2.0), (0.0, -0.9, -5.5)]


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'ship', RADIUS, HARDPOINTS)
    red = m.variant('hull_accent', color=(0.42, 0.015, 0.03), metallic=0.5, roughness=0.4)

    # -- fuselage: long needle ------------------------------------------------------------------
    p = m.part()
    g = p.loft([
        S(-7.8, 0.82, 0.82, 0.74, n=2.4, zc=0.1),
        S(-5.5, 1.00, 0.95, 0.80, n=2.6, zc=0.1),
        S(-2.5, 1.05, 0.95, 0.78, n=2.8, nb=3.4, zc=0.08),
        S(0.5, 0.90, 0.80, 0.70, n=2.6, nb=3.0, zc=0.04),
        S(3.0, 0.62, 0.60, 0.52, n=2.4, zc=0.0),
        S(5.5, 0.36, 0.34, 0.32, n=2.2, zc=-0.05),
        S(7.8, 0.16, 0.15, 0.15, n=2.0, zc=-0.1),
        S(9.4, 0.03, 0.03, 0.03, n=2.0, zc=-0.12),
    ], segs=24, spacing=0.55, cap_mat='hull_dark')
    g.paint(6.0, 7.3, *kit.RING, red)
    g.paint(-7.8, 1.0, 66.0, 90.0, 'hull_secondary')
    g.paint(-7.8, 5.4, -90.0, -50.0, 'hull_secondary')
    g.paint(-7.8, -6.9, *kit.RING, 'hull_dark')
    g.panels([-7.8, -6.9, -5.5, -4.0, -2.5, -1.0, 0.5, 1.8, 3.0, 4.3, 5.5, 6.0, 7.3, 9.4],
             [-50.0, -12.0, 28.0, 66.0], width=0.028, depth=0.013)
    g.ribbon(-6.4, 3.4, 12.0, 0.06, lift=0.03)
    g.greebles(-6.6, 0.4, 70.0, 88.0, 8, size=(0.12, 0.38), height=(0.03, 0.08), seed=11)
    kit.engine(m, p, 0, (0.0, -8.9, 0.1), 0.9, 1.5, segs=20)
    # chin gun pod under the nose
    c = p.loft([
        S(1.2, 0.16, 0.20, 0.10, n=2.2, zc=-0.60),
        S(2.6, 0.30, 0.34, 0.26, n=2.4, zc=-0.68),
        S(4.3, 0.28, 0.36, 0.24, n=2.4, zc=-0.72),
        S(5.1, 0.17, 0.30, 0.15, n=2.2, zc=-0.80),
    ], segs=12, spacing=0.6, mat='hull_secondary', cap_mat='hull_dark')
    c.ribbon(2.2, 4.4, -8.0, 0.045, lift=0.02)
    kit.gun(p, (0.0, 5.5, -0.9), length=1.3, r=0.065)
    m.add(p)

    kit.canopy(m, [
        S(1.4, 0.20, 0.18, 0.3, n=2.2, zc=0.62),
        S(2.6, 0.46, 0.50, 0.4, n=2.2, zc=0.54),
        S(4.0, 0.40, 0.44, 0.4, n=2.2, zc=0.38),
        S(5.4, 0.20, 0.22, 0.3, n=2.2, zc=0.18),
        S(6.2, 0.05, 0.05, 0.1, n=2.0, zc=0.1),
    ], y_cuts=[1.4, 2.6, 4.0, 6.2], spacing=0.35)
    m.empty('cockpit', (0.0, 3.3, 0.72))

    # -- side engine nacelle with intake, wing, lance cannon (right, mirrored) -------------------
    p = m.part()
    nx = 1.3
    g = p.loft([
        S(-7.0, 0.44, 0.44, n=2.4, x=nx + 0.05, zc=-0.02),
        S(-5.0, 0.52, 0.52, n=2.8, x=nx, zc=-0.02),
        S(-2.6, 0.46, 0.46, n=3.2, x=nx - 0.05, zc=-0.02),
        S(-1.2, 0.36, 0.38, n=3.6, x=nx - 0.12, zc=-0.02),
    ], segs=16, spacing=0.6, mat='hull_secondary', cap_mat='hull_dark')
    g.paint(-1.8, -1.2, *kit.RING, 'hull_primary', sym=False)
    g.panels([-7.0, -5.0, -3.4, -1.8, -1.2], [-40.0, 40.0], width=0.028, depth=0.012)
    for f in g.block(-4.8, -3.6, 20.0, 70.0):
        p.vent(f, bars=3, margin=0.04, depth=0.04, frame='hull_primary')
    p.engine(-7.9, 0.46, 1.0, origin=(nx + 0.05, 0.0, -0.02))
    # lance cannon pod under the wing; the muzzle is the hardpoint
    g = p.loft([
        S(-3.8, 0.10, 0.10, n=2.0, x=3.4, zc=-0.2),
        S(-2.6, 0.24, 0.24, n=2.4, x=3.4, zc=-0.2),
        S(-0.6, 0.24, 0.24, n=2.4, x=3.4, zc=-0.2),
        S(0.2, 0.13, 0.13, n=2.0, x=3.4, zc=-0.2),
    ], segs=12, spacing=0.7, mat='hull_secondary', cap_mat='hull_dark')
    g.paint(-1.4, -0.9, *kit.RING, red, sym=False)
    kit.gun(p, (3.4, 2.0, -0.2), length=2.0, r=0.06)
    m.add(p, mirror=True)
    m.empties_sym('engine', 1, (nx + 0.05, -7.9, -0.02))

    p = m.part()
    w = p.wing([(0.8, 0.0, 2.2, -4.8, 0.26), (3.4, -0.07, -0.7, -5.25, 0.16), (6.9, -0.17, -4.6, -6.3, 0.07)],
               sub=3, le=0.14, te=0.25)
    p.paint(w['top'][-1:] + w['bottom'][-1:], red)
    p.inset(w['top'] + w['bottom'], 0.08, 0.012, rim='hull_dark', individual=True)
    # ventral strake below the nacelle
    f = p.wing([(1.5, -0.4, -5.0, -7.2, 0.12), (1.85, -0.9, -5.9, -7.5, 0.08), (2.15, -1.35, -6.7, -7.8, 0.04)])
    p.paint(f['top'][-1:] + f['bottom'][-1:], red)
    p.bevel(0.018, 2, 35.0)
    p.strip((1.3, 1.45, 0.13), (6.6, -4.45, -0.13), 0.05, (0.05, 0.0, 1.0), lift=0.02)
    kit.lamp(m, p, 1, (6.92, -5.4, -0.17), 0.09)
    m.add(p, mirror=True)
    m.empty('light_0', (-6.92, -5.4, -0.17))

    # -- dorsal fin -----------------------------------------------------------------------------
    p = m.part()
    f = p.wing([(0.0, 0.75, -3.2, -7.4, 0.22), (0.0, 1.6, -5.2, -7.9, 0.13), (0.0, 2.35, -6.8, -8.4, 0.05)], sub=2)
    p.paint(f['top'][-2:] + f['bottom'][-2:], red)
    p.inset(f['top'] + f['bottom'], 0.07, 0.01, rim='hull_dark', individual=True)
    p.bevel(0.018, 2, 35.0)
    kit.antenna(p, (0.0, -7.6, 2.3), (0.0, -8.3, 2.9), 0.025, light='emissive_light')
    m.add(p)
    m.empty('light_2', (0.0, -8.3, 2.9))

    return kit.finish(m, ao=ao, export=export, preview=preview)
