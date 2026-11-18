"""ship_bulwark - gunship. Broad armoured wedge with two layers of plating, aft citadel,
forward bridge, dorsal turret between them, twin engine blocks with two engines each.
Gunmetal and olive. Catalog radius 26 m."""

import p2lib as L
from p2lib import S
from ships import kit

KEY = 'ship_bulwark'
RADIUS = 26.0
HARDPOINTS = [(-8.0, 0.5, -6.0), (8.0, 0.5, -6.0), (-4.0, -2.0, -10.0), (4.0, -2.0, -10.0), (0.0, 3.0, -4.0)]


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'ship', RADIUS, HARDPOINTS)
    gm = m.variant('hull_primary', color=(0.21, 0.225, 0.245), metallic=0.75, roughness=0.42)
    olive = m.variant('hull_accent', color=(0.19, 0.24, 0.07), metallic=0.4, roughness=0.55)

    # -- the wedge: lens section with a hard edge, broad stern, blunt prow --------------------------
    p = m.part()
    g = p.loft([
        S(-17.0, 13.0, 2.6, 2.2, n=1.8),
        S(-14.0, 14.5, 3.1, 2.6, n=1.7),
        S(-6.0, 12.3, 3.3, 2.8, n=1.7),
        S(2.0, 9.6, 3.0, 2.7, n=1.7),
        S(6.0, 8.3, 2.75, 2.5, n=1.7),
        S(10.0, 6.9, 2.45, 2.3, n=1.8),
        S(16.0, 4.7, 1.9, 1.9, n=2.0),
        S(20.5, 3.0, 1.3, 1.4, n=2.2),
        S(22.8, 1.6, 0.6, 0.7, n=2.4),
    ], segs=32, spacing=1.35, mat=gm, cap_mat='hull_dark')
    ys = [-17.0, -14.0, -10.0, -6.0, -2.0, 2.0, 6.0, 10.0, 13.0, 16.0, 18.25, 20.5, 22.8]
    g.paint(-17.0, 22.8, -90.0, -62.0, 'hull_secondary')
    g.paint(18.25, 20.5, -62.0, 90.0, olive)
    g.panels(ys, [-62.0, -22.0, 8.0, 31.0, 62.0], width=0.11, depth=0.07)
    # second layer: thicker plates bolted over the first
    for (y0, y1, a0, a1) in ((-14.0, -6.0, 31.0, 62.0), (-2.0, 6.0, 31.0, 62.0), (10.0, 16.0, 31.0, 62.0),
                             (-10.0, -2.0, 8.0, 31.0), (6.0, 13.0, 8.0, 31.0), (-14.0, -2.0, -62.0, -22.0),
                             (2.0, 10.0, -62.0, -22.0)):
        for (b0, b1) in ((a0, a1), (180.0 - a1, 180.0 - a0)):
            fs = g.block(y0, y1, b0, b1)
            p.paint(fs, olive)
            p.inset(fs, 0.3, 0.16, rim=olive)
    g.ribbon(-13.4, 15.4, 4.0, 0.16, lift=0.1)
    g.windows(-5.0, 1.0, -12.0, 5, 0.7, 0.3, lift=0.1)
    kit.turret(p, (0.0, 4.0, 3.0), r=1.55, h=0.9, blen=2.8, mat=gm, segs=16)
    for sx in (-8.0, 8.0):
        kit.turret(p, (sx, 6.0, 0.5), r=0.95, h=0.9, blen=2.9, mat=gm)
    for sx in (-4.0, 4.0):  # semi-recessed ventral cannons
        kit.gun(p, (sx, 10.0, -2.0), length=4.6, r=0.2)
    m.add(p)

    # -- aft citadel and forward bridge ---------------------------------------------------------------
    p = m.part()
    c = p.loft([
        S(-15.0, 2.6, 1.0, 1.2, n=3.5, zc=3.0),
        S(-12.5, 3.3, 1.8, 1.2, n=4.0, zc=3.2),
        S(-4.0, 3.1, 1.7, 1.2, n=4.0, zc=3.1),
        S(-0.6, 2.0, 0.5, 1.0, n=3.5, zc=2.9),
    ], segs=20, spacing=1.3, mat=gm, cap_mat='hull_secondary')
    c.paint(-12.5, -10.4, 16.0, 90.0, olive)
    c.panels([-15.0, -12.5, -10.4, -8.3, -6.1, -4.0, -0.6], [16.0, 58.0], width=0.09, depth=0.05)
    c.windows(-9.9, -4.4, 30.0, 5, 0.55, 0.3, lift=0.07)
    for f in c.block(-10.4, -6.1, 62.0, 118.0):
        p.vent(f, bars=4, margin=0.12, depth=0.12, frame=gm)
    b = p.loft([
        S(6.9, 1.9, 0.5, 0.8, n=3.5, zc=2.5),
        S(8.2, 2.5, 1.35, 0.9, n=4.0, zc=2.6),
        S(10.6, 2.3, 1.2, 0.9, n=4.0, zc=2.45),
        S(12.6, 1.5, 0.35, 0.8, n=3.5, zc=2.0),
    ], segs=20, spacing=0.8, mat=gm, cap_mat='hull_secondary')
    b.paint(10.6, 12.6, 18.0, 90.0, 'glass')
    b.paint(8.2, 9.4, 18.0, 90.0, olive)
    b.panels([6.9, 8.2, 9.4, 10.6, 12.6], [18.0, 58.0], width=0.08, depth=0.04, rim='hull_secondary')
    b.windows(8.5, 10.4, 30.0, 3, 0.4, 0.26, lift=0.06)
    kit.antenna(p, (-1.6, -11.6, 4.8), (-1.6, -12.3, 6.1), 0.08, light='emissive_light')
    kit.antenna(p, (1.6, -11.6, 4.8), (1.6, -12.1, 5.6), 0.06)
    p.lathe([(0.0, 0.0), (0.3, 1.1), (0.7, 1.2), (0.8, 0.0)], 12, 'hull_secondary', axis='Z',
            origin=(0.0, -7.6, 4.85))
    # ventral keel
    k = p.wing([(0.0, -2.3, -7.6, -16.2, 0.6), (0.0, -3.5, -10.6, -16.5, 0.38), (0.0, -4.5, -13.0, -16.8, 0.18)],
               mat=gm, sub=2)
    p.inset(k['top'] + k['bottom'], 0.16, 0.04, rim='hull_dark', individual=True)
    m.add(p)
    m.empty('cockpit', (0.0, 11.2, 2.9))
    m.empty('light_2', (-1.6, -12.3, 6.1))

    # -- engine block (right, mirrored) ---------------------------------------------------------------
    p = m.part()
    bx, bz = 7.2, 0.3
    e = p.loft([
        S(-12.4, 3.3, 2.2, 2.0, n=5.0, x=bx, zc=bz),
        S(-15.0, 3.8, 2.7, 2.4, n=5.0, x=bx, zc=bz),
        S(-19.6, 3.8, 2.7, 2.4, n=5.0, x=bx, zc=bz),
        S(-20.7, 3.3, 2.3, 2.0, n=5.0, x=bx, zc=bz),
    ], segs=24, spacing=1.2, mat=gm, cap_mat='hull_dark')
    e.paint(-17.3, -16.1, *kit.RING, olive, sym=False)
    e.paint(-20.7, -19.6, *kit.RING, 'hull_secondary', sym=False)
    e.panels([-20.7, -19.6, -17.3, -16.1, -15.0, -12.4], [-50.0, -12.0, 12.0, 50.0], width=0.09, depth=0.05)
    for f in e.block(-19.6, -17.3, 62.0, 118.0):
        p.vent(f, bars=4, margin=0.12, depth=0.14, frame=gm)
    e.ribbon(-19.4, -15.2, 0.0, 0.18, lift=0.08, sym=False)
    for ex in (bx - 1.8, bx + 1.8):
        p.engine(-23.3, 1.62, 3.0, segs=20, origin=(ex, 0.0, bz))
    kit.lamp(m, p, 1, (14.45, -14.0, 0.0), 0.24)
    m.add(p, mirror=True)
    m.empty('light_0', (-14.45, -14.0, 0.0))
    for i, ex in enumerate((-bx - 1.8, -bx + 1.8, bx - 1.8, bx + 1.8)):
        m.empty('engine_%d' % i, (ex, -23.3, bz))

    return kit.finish(m, ao=ao, export=export, preview=preview)
