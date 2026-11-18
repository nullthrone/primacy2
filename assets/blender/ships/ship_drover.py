"""ship_drover - freighter. Hammerhead bow with a raised bridge, a long spine carrying
rows of cargo containers between rack frames, an engine block with four heavy engines.
Amber accent. Catalog radius 24 m."""

import random

import p2lib as L
from p2lib import S
from ships import kit

KEY = 'ship_drover'
RADIUS = 24.0
HARDPOINTS = [(-6.5, 2.0, -9.0), (6.5, 2.0, -9.0)]


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'ship', RADIUS, HARDPOINTS)
    amber = m.variant('hull_accent', color=(0.72, 0.30, 0.02), metallic=0.5, roughness=0.45)
    crate = m.variant('hull_primary', color=(0.30, 0.32, 0.34), metallic=0.5, roughness=0.55)

    # -- hammerhead bow -------------------------------------------------------------------------
    p = m.part()
    g = p.loft([
        S(6.6, 6.6, 1.7, 1.9, n=5.0),
        S(9.0, 7.3, 1.8, 2.0, n=5.0),
        S(11.5, 6.7, 1.8, 2.0, n=4.5),
        S(15.0, 4.7, 1.7, 1.9, n=4.0),
        S(19.0, 3.0, 1.3, 1.6, n=3.5, zc=-0.1),
        S(21.5, 1.7, 0.7, 0.9, n=3.0, zc=-0.3),
    ], segs=28, spacing=1.3, cap_mat='hull_dark')
    g.paint(6.6, 21.5, -90.0, -38.0, 'hull_secondary')
    g.paint(17.6, 19.2, -38.0, 90.0, amber)
    g.paint(6.6, 8.0, -38.0, 90.0, amber)
    g.panels([6.6, 8.0, 10.2, 12.6, 15.0, 17.6, 19.2, 21.5], [-38.0, -9.0, 11.0, 50.0], width=0.07, depth=0.035)
    g.windows(9.4, 18.4, 2.0, 9, 0.55, 0.26, lift=0.05)
    g.ribbon(8.2, 17.4, -16.0, 0.14, lift=0.05)
    g.greebles(8.2, 11.4, 62.0, 84.0, 9, size=(0.4, 1.2), height=(0.08, 0.3), seed=5)
    for hp in HARDPOINTS:
        kit.turret(p, L.gltf_to_blender(hp), r=0.75, h=0.75, blen=2.0)
    # raised bridge
    b = p.loft([
        S(11.6, 2.0, 1.1, 1.5, n=4.0, zc=2.7),
        S(13.0, 2.5, 1.6, 1.5, n=4.5, zc=3.0),
        S(16.4, 2.4, 1.5, 1.5, n=4.5, zc=2.9),
        S(18.4, 1.7, 0.5, 1.2, n=3.5, zc=2.3),
    ], segs=20, spacing=0.9, cap_mat='hull_secondary')
    b.paint(16.4, 18.4, 14.0, 90.0, 'glass')
    b.paint(11.6, 16.4, 56.0, 90.0, amber)
    b.panels([11.6, 13.0, 14.7, 16.4, 18.4], [14.0, 56.0], width=0.06, depth=0.025, rim='hull_secondary')
    b.windows(13.2, 16.2, 30.0, 5, 0.4, 0.32, lift=0.04)
    kit.antenna(p, (-1.4, 12.6, 4.4), (-1.4, 12.2, 5.6), 0.06, light='emissive_light')
    kit.antenna(p, (0.0, 13.6, -1.8), (0.0, 12.8, -4.3), 0.07)
    kit.antenna(p, (1.4, 12.6, 4.4), (1.4, 12.4, 5.2), 0.05)
    p.lathe([(0.0, 0.0), (0.25, 0.9), (0.5, 1.0), (0.55, 0.0)], 12, 'hull_secondary', axis='Z',
            origin=(0.9, 14.0, 4.55))
    m.add(p)
    m.empty('cockpit', (0.0, 17.2, 3.2))
    m.empty('light_0', (-1.4, 12.2, 5.6))

    # -- spine, rack frames and containers --------------------------------------------------------
    p = m.part()
    bays = [-12.4, -8.3, -4.2, -0.1, 4.0]
    for k in range(6):
        y = -14.45 + 4.1 * k
        r = p.box((0.0, y, 0.0), (14.5, 0.34, 6.0), 'hull_secondary', chamfer=0.45)
        p.inset([r['cap0'], r['cap1']], 0.3, -0.05, rim='hull_secondary', inner='hull_dark')
    p.bevel(0.05, 2, 35.0)
    g = p.loft([S(-15.0, 1.5, 1.5, n=6.0), S(7.0, 1.5, 1.5, n=6.0)], segs=16, spacing=2.05, mat='hull_secondary')
    g.panels([-15.0 + 2.05 * k for k in range(12)], [-45.0, 45.0], width=0.06, depth=0.03)
    for side in (-1.0, 1.0):  # service pipes along the rack
        p.pipe([(side * 7.0, -14.4, 2.85), (side * 7.0, 6.0, 2.85)], 0.13, 6, 'hull_dark')
        p.pipe([(side * 7.0, -14.4, -2.85), (side * 7.0, 6.0, -2.85)], 0.13, 6, 'hull_dark')
    rng = random.Random(7)
    mats = ['hull_primary', 'hull_primary', crate, crate, amber, 'hull_secondary']
    for y in bays:
        for cx in (-5.72, -2.98, 2.98, 5.72):
            for cz in (-1.5, 1.5):
                if abs(cx) > 4.0 and rng.random() < 0.09:
                    continue  # an empty slot shows the rack
                mat = rng.choice(mats)
                r = p.box((cx, y, cz), (2.56, 3.68, 2.7), mat, chamfer=0.14)
                big = [f for f in r['sides'] if f.calc_area() > 3.0]
                p.inset(big, 0.24, -0.07, individual=True)
                if abs(cx) > 4.0 and rng.random() < 0.5:
                    sx = 1.0 if cx > 0 else -1.0
                    p.strip((cx + sx * 1.21, y - 1.2, cz + 0.9), (cx + sx * 1.21, y + 1.2, cz + 0.9), 0.1,
                            (sx, 0.0, 0.0), lift=0.03)
    m.add(p)

    # -- engine block with four heavy engines -----------------------------------------------------
    p = m.part()
    g = p.loft([
        S(-14.7, 5.0, 2.7, n=5.0),
        S(-16.2, 6.3, 3.4, n=5.0),
        S(-19.0, 6.1, 3.3, n=5.0),
        S(-19.9, 5.3, 2.8, n=5.0),
    ], segs=28, spacing=1.0, cap_mat='hull_dark')
    g.paint(-17.2, -16.2, *kit.RING, amber)
    g.paint(-19.9, -19.0, *kit.RING, 'hull_secondary')
    g.panels([-14.7, -16.2, -17.2, -19.0, -19.9][::-1], [-50.0, -12.0, 12.0, 50.0], width=0.07, depth=0.035)
    for f in g.block(-19.0, -17.2, 62.0, 118.0):
        p.vent(f, bars=4, margin=0.1, depth=0.12)
    g.ribbon(-18.8, -15.4, 0.0, 0.16, lift=0.06)
    i = 0
    for ez in (1.62, -1.62):
        for ex in (-3.0, 3.0):
            kit.engine(m, p, i, (ex, -21.7, ez), 1.48, 2.6, segs=20)
            i += 1
    for sx in (-1.0, 1.0):  # radiator fins
        f = p.wing([(sx * 6.2, 0.0, -15.6, -19.4, 0.3), (sx * 8.0, 0.0, -17.0, -19.8, 0.14)], sub=2)
        p.inset(f['top'] + f['bottom'], 0.12, 0.03, rim='hull_dark', individual=True)
        kit.lamp(m, p, 1 if sx < 0 else 2, (sx * 8.05, -18.4, 0.0), 0.2)
    m.add(p)

    return kit.finish(m, ao=ao, export=export, preview=preview)
