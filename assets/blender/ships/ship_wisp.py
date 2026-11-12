"""ship_wisp - starter multirole. Compact dart, twin outboard engine pods, short
forward-swept winglets, bubble canopy. Teal accent. Catalog radius 9 m."""

import p2lib as L
from p2lib import S
from ships import kit

KEY = 'ship_wisp'
RADIUS = 9.0
HARDPOINTS = [(-2.6, -0.4, -3.5), (2.6, -0.4, -3.5)]


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'ship', RADIUS, HARDPOINTS)
    teal = m.variant('hull_accent', color=(0.0, 0.36, 0.34), metallic=0.5, roughness=0.4)

    # -- fuselage: a dart, widest behind the middle, flat-bottomed ------------------------------
    p = m.part()
    g = p.loft([
        S(-6.7, 0.50, 0.42, 0.40, n=2.6, zc=0.22),
        S(-5.2, 0.95, 0.74, 0.58, n=2.8, nb=3.4, zc=0.16),
        S(-2.2, 1.30, 0.98, 0.74, n=3.0, nb=3.8, zc=0.08),
        S(1.4, 1.24, 0.94, 0.78, n=2.8, nb=3.6, zc=0.02),
        S(4.6, 0.88, 0.66, 0.64, n=2.5, nb=3.0, zc=-0.06),
        S(7.0, 0.42, 0.32, 0.36, n=2.3, zc=-0.14),
        S(8.7, 0.05, 0.04, 0.05, n=2.0, zc=-0.2),
    ], segs=24, spacing=0.55, cap_mat='hull_dark')
    g.paint(5.6, 6.8, *kit.RING, teal)
    g.paint(-6.7, 1.0, 62.0, 90.0, 'hull_secondary')
    g.paint(-6.7, 4.4, -90.0, -52.0, 'hull_secondary')
    g.panels([-6.7, -5.2, -3.7, -2.2, -0.4, 1.4, 3.0, 4.6, 5.6, 6.8, 8.7], [-52.0, -15.0, 25.0, 62.0],
             width=0.03, depth=0.014)
    g.ribbon(-5.4, 4.2, 3.0, 0.07, lift=0.03)
    g.greebles(-5.6, 0.2, 68.0, 88.0, 7, size=(0.12, 0.4), height=(0.03, 0.09), seed=3)
    kit.antenna(p, (0.0, -1.2, 1.0), (0.0, -2.0, 2.0), 0.03, light='emissive_light')
    m.add(p)

    # -- bubble canopy --------------------------------------------------------------------------
    kit.canopy(m, [
        S(1.3, 0.26, 0.22, 0.3, n=2.2, zc=0.84),
        S(2.4, 0.62, 0.66, 0.4, n=2.2, zc=0.78),
        S(3.8, 0.60, 0.62, 0.4, n=2.2, zc=0.62),
        S(5.2, 0.34, 0.30, 0.3, n=2.2, zc=0.34),
        S(5.9, 0.08, 0.06, 0.1, n=2.0, zc=0.16),
    ], y_cuts=[1.3, 2.4, 3.8, 5.9])
    m.empty('cockpit', (0.0, 3.5, 1.1))

    # -- engine pod (right, mirrored) with its gun and pylon ------------------------------------
    px, pz = 2.6, -0.15
    p = m.part()
    g = p.loft([
        S(-7.3, 0.60, 0.60, n=2.4, x=px, zc=pz),
        S(-5.6, 0.78, 0.78, n=2.6, x=px, zc=pz),
        S(-1.0, 0.74, 0.72, n=2.6, x=px, zc=pz),
        S(1.5, 0.52, 0.48, n=2.4, x=px, zc=pz - 0.05),
        S(2.9, 0.22, 0.2, n=2.2, x=px, zc=pz - 0.15),
    ], segs=16, spacing=0.55, mat='hull_secondary', cap_mat='hull_dark')
    g.paint(-5.5, -4.5, *kit.RING, teal, sym=False)
    g.paint(0.9, 1.5, *kit.RING, 'hull_dark', sym=False)
    g.panels([-7.3, -5.6, -4.4, -1.4, 0.9, 2.9], [-45.0, 30.0], width=0.03, depth=0.012)
    for f in g.block(-4.2, -1.6, 70.0, 110.0):
        p.vent(f, bars=3, margin=0.05, depth=0.05, frame='hull_primary')
    p.engine(-8.2, 0.64, 1.2, origin=(px, 0.0, pz))
    kit.gun(p, (px, 3.5, -0.4), length=1.5, r=0.07)
    # blended strake: the body reads as one delta with the pods at its corners
    w = p.wing([(0.8, -0.05, 3.6, -5.0, 0.40), (2.3, pz, 0.7, -4.7, 0.34)], sub=3, le=0.12, te=0.2)
    p.inset(w['top'] + w['bottom'], 0.1, 0.015, rim='hull_dark', individual=True)
    m.add(p, mirror=True)
    m.empties_sym('engine', 0, (px, -8.2, pz))

    # -- forward-swept winglet and canted tail fin (right, mirrored) -----------------------------
    p = m.part()
    w = p.wing([(3.1, pz, -2.4, -5.6, 0.30), (4.6, 0.1, -0.5, -2.7, 0.2), (6.1, 0.38, 1.4, 0.2, 0.1)], sub=2)
    p.paint(w['top'][-2:] + w['bottom'][-2:], teal)
    p.inset(w['top'] + w['bottom'], 0.08, 0.012, rim='hull_dark', individual=True)
    f = p.wing([(2.75, 0.4, -4.6, -7.2, 0.16), (3.05, 1.2, -5.6, -7.5, 0.11), (3.35, 1.95, -6.5, -7.8, 0.06)])
    p.paint(f['top'][-1:] + f['bottom'][-1:], teal)
    p.bevel(0.02, 2, 35.0)
    p.strip((3.3, -2.25, pz + 0.17), (5.9, 1.2, 0.47), 0.06, (-0.15, 0.0, 1.0), lift=0.025)
    kit.lamp(m, p, 1, (6.12, 0.8, 0.38), 0.1)
    m.add(p, mirror=True)
    m.empty('light_0', (-6.12, 0.8, 0.38))

    return kit.finish(m, ao=ao, export=export, preview=preview)
