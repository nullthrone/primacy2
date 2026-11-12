"""ship_wayfarer - explorer. Slender white hull, large panoramic canopy over the nose,
ventral scoop intake, long radiator wings in a shallow X, canards carrying the two
utility mounts. White and blue. Catalog radius 16 m."""

import p2lib as L
from p2lib import S
from ships import kit

KEY = 'ship_wayfarer'
RADIUS = 16.0
HARDPOINTS = [(-3.0, -0.8, -6.0), (3.0, -0.8, -6.0)]


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'ship', RADIUS, HARDPOINTS)
    white = m.variant('hull_primary', color=(0.80, 0.82, 0.84), metallic=0.25, roughness=0.42)
    blue = m.variant('hull_accent', color=(0.02, 0.12, 0.52), metallic=0.5, roughness=0.4)

    # -- slender hull ---------------------------------------------------------------------------------
    p = m.part()
    g = p.loft([
        S(-12.6, 2.3, 1.2, 1.2, n=3.5),
        S(-9.0, 2.2, 1.6, 1.4, n=3.0),
        S(-3.0, 1.9, 1.8, 1.5, n=2.6),
        S(3.0, 1.8, 1.7, 1.4, n=2.5),
        S(8.0, 1.6, 1.4, 1.2, n=2.4, zc=-0.05),
        S(12.0, 1.1, 0.9, 0.9, n=2.3, zc=-0.2),
        S(14.6, 0.5, 0.4, 0.45, n=2.2, zc=-0.4),
        S(15.6, 0.1, 0.08, 0.1, n=2.0, zc=-0.5),
    ], segs=24, spacing=0.9, mat=white, cap_mat='hull_dark')
    g.paint(-12.6, 6.0, -14.0, 2.0, blue)
    g.paint(-12.6, 13.0, -90.0, -58.0, 'hull_secondary')
    g.paint(-12.6, -11.4, *kit.RING, 'hull_secondary')
    g.paint(12.9, 13.8, *kit.RING, blue)
    g.panels([-12.6, -11.4, -9.0, -7.0, -5.0, -3.0, -1.0, 1.0, 3.0, 5.5, 8.0, 10.0, 12.0, 12.9, 13.8, 15.6],
             [-58.0, -14.0, 2.0, 32.0, 64.0], width=0.05, depth=0.024)
    g.windows(-8.2, 3.4, 18.0, 9, 0.5, 0.22, lift=0.04)
    g.ribbon(-11.0, 4.6, -28.0, 0.1, lift=0.04)
    g.greebles(-9.0, -1.0, 72.0, 88.0, 8, size=(0.25, 0.8), height=(0.05, 0.2), seed=8)
    for i, ex in enumerate((-1.2, 1.2)):
        kit.engine(m, p, i, (ex, -15.2, 0.0), 1.06, 2.9, segs=20)
    # ventral scoop intake with a deep mouth and guide vanes
    sc = p.loft([
        S(-5.0, 0.8, 0.5, 0.4, n=3.0, zc=-1.6),
        S(-2.0, 1.3, 0.6, 0.8, n=3.5, zc=-1.7),
        S(2.6, 1.5, 0.6, 1.0, n=4.0, zc=-1.75),
        S(3.7, 1.65, 0.6, 1.1, n=4.0, zc=-1.8),
    ], segs=16, spacing=1.2, mat=white, cap_mat='hull_dark')
    sc.paint(2.6, 3.7, *kit.RING, blue)
    sc.panels([-5.0, -2.0, 0.3, 2.6, 3.7], [-60.0, -15.0], width=0.05, depth=0.022)
    p.inset([sc.caps[1]], 0.14, -1.0, rim='hull_secondary', inner='hull_dark')
    for dx in (-0.75, 0.0, 0.75):
        p.box((dx, 3.35, -2.05), (0.08, 0.7, 1.35), 'hull_secondary')
    p.strip((-1.1, 3.72, -2.78), (1.1, 3.72, -2.78), 0.08, (0.0, 0.3, -1.0), lift=0.03)
    # dorsal sensor dish and mast, ventral probe
    p.lathe([(0.0, 0.0), (0.12, 0.55), (0.4, 1.0), (0.46, 1.0), (0.16, 0.5), (0.08, 0.0)], 14,
            mats=['hull_secondary', 'hull_secondary', white, 'hull_dark', 'hull_dark'], axis='Z',
            origin=(0.0, 1.6, 2.25))
    p.tube((0.0, 1.6, 1.5), (0.0, 1.6, 2.3), 0.12, 0.09, 8, 'hull_secondary')
    kit.antenna(p, (0.0, 1.6, 2.3), (0.0, 1.6, 3.1), 0.03, light='emissive_light')
    kit.antenna(p, (0.0, -9.6, -1.2), (0.0, -10.6, -2.9), 0.04)
    m.add(p)
    m.empty('light_0', (0.0, 1.6, 3.1))

    # -- panoramic canopy -----------------------------------------------------------------------------
    kit.canopy(m, [
        S(4.6, 0.7, 0.45, 0.6, n=2.4, zc=1.1),
        S(7.0, 1.5, 1.2, 0.9, n=2.4, zc=0.6),
        S(10.0, 1.32, 1.0, 0.9, n=2.4, zc=0.3),
        S(12.6, 0.82, 0.62, 0.6, n=2.3, zc=0.0),
        S(14.1, 0.3, 0.2, 0.3, n=2.2, zc=-0.2),
    ], segs=20, spacing=0.55, a_cuts=(6.0, 46.0), y_cuts=[4.6, 7.0, 8.5, 10.0, 11.3, 12.6, 14.1], bar=0.06)
    m.empty('cockpit', (0.0, 10.4, 0.7))

    # -- radiator wings and canard (right, mirrored) ----------------------------------------------------
    p = m.part()
    up = p.wing([(1.6, 0.6, -4.0, -9.6, 0.32), (7.2, 1.7, -6.0, -10.0, 0.17), (12.7, 2.75, -8.0, -10.4, 0.08)],
                mat=white, sub=3, le=0.1, te=0.14)
    lo = p.wing([(1.5, -0.6, -5.2, -9.2, 0.28), (4.4, -1.5, -6.4, -9.5, 0.16), (7.2, -2.35, -7.6, -9.8, 0.08)],
                mat=white, sub=2, le=0.1, te=0.14)
    rad = up['top'][:-1] + up['bottom'][:-1] + lo['top'][:-1] + lo['bottom'][:-1]
    p.paint(up['top'][-1:] + up['bottom'][-1:] + lo['top'][-1:] + lo['bottom'][-1:], blue)
    p.inset(rad, 0.14, -0.02, rim=white, inner='hull_secondary', individual=True)
    ca = p.wing([(1.45, -0.62, 8.4, 4.4, 0.24), (3.0, -0.8, 5.5, 4.2, 0.12)], mat=white, sub=2)
    p.inset(ca['top'] + ca['bottom'], 0.08, 0.012, rim='hull_dark', individual=True)
    p.bevel(0.03, 2, 35.0)
    # heat strips along the radiators
    p.strip((2.4, -6.3, 0.92), (12.2, -8.95, 2.71), 0.09, (-0.19, 0.0, 1.0), lift=0.03)
    p.strip((2.4, -8.2, 0.92), (12.2, -9.7, 2.71), 0.09, (-0.19, 0.0, 1.0), lift=0.03)
    p.strip((2.0, -7.4, -0.63), (6.8, -8.9, -2.19), 0.08, (0.3, 0.0, 1.0), lift=0.03)
    # utility mount pod at the canard tip; the muzzle is the hardpoint
    g = p.loft([
        S(3.4, 0.08, 0.08, n=2.0, x=3.0, zc=-0.8),
        S(4.0, 0.22, 0.22, n=2.4, x=3.0, zc=-0.8),
        S(5.2, 0.22, 0.22, n=2.4, x=3.0, zc=-0.8),
        S(5.6, 0.12, 0.12, n=2.0, x=3.0, zc=-0.8),
    ], segs=12, spacing=0.7, mat='hull_secondary', cap_mat='hull_dark')
    g.paint(4.5, 5.0, *kit.RING, blue, sym=False)
    kit.gun(p, (3.0, 6.0, -0.8), length=0.9, r=0.055)
    kit.lamp(m, p, 2, (12.72, -9.2, 2.76), 0.13)
    m.add(p, mirror=True)
    m.empty('light_1', (-12.72, -9.2, 2.76))

    return kit.finish(m, ao=ao, export=export, preview=preview)
