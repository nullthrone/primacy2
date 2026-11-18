"""cockpit_generic - first-person cockpit interior. The pilot's eye is the origin, looking
toward +Y (glTF -Z). A wrap-around dashboard fills the bottom of the view, canopy struts
frame its edges, side consoles and a rear hoop close the tub; the centre of the view is
clear. About 2.7 m wide. Materials: cockpit_frame, cockpit_panel, emissive_accent.
"""

import math
import os

import p2lib as L
from structures import skit as K

KEY = 'cockpit_generic'
F, P, E = 'cockpit_frame', 'cockpit_panel', 'emissive_accent'

# dashboard cross-section (y, z): glare shield top, lip, recess, instrument face, underside
DASH = [(1.26, -0.30), (0.62, -0.36), (0.60, -0.40), (0.66, -0.44), (0.58, -0.80), (1.26, -0.80)]
FACE_C = (0.612, -0.62)                     # middle of the instrument face
FACE_U = (0.2169, 0.9762)                   # unit vector up the face (y, z)
FACE_TILT = -12.5                           # degrees about X
SLOPE = 5.36                                # glare shield rises toward the windshield, degrees
WING = -30.0                                # the outer dashboard sections swing toward the pilot
HINGE = (0.7, 1.26, 0.0)


def _face_pt(x, up, out=0.0):
    return (x, FACE_C[0] + FACE_U[0] * up - out, FACE_C[1] + FACE_U[1] * up)


def _mfd(p, x, w=0.34, h=0.26):
    """Display bezel on the instrument face with lit edge strips and soft keys."""
    p.box(_face_pt(x, 0.0, 0.004), (w, 0.03, h), P, rot=(FACE_TILT, 0, 0), chamfer=0.02)
    for up in (h / 2 - 0.018, -h / 2 + 0.018):
        p.box(_face_pt(x, up, 0.02), (w - 0.07, 0.012, 0.007), E, rot=(FACE_TILT, 0, 0))
    for k in range(5):
        p.box(_face_pt(x - w / 2 + 0.05 + k * (w - 0.1) / 4, -h / 2 - 0.035, 0.006), (0.034, 0.02, 0.022), F,
              rot=(FACE_TILT, 0, 0))


def build(export=True, preview=True, ao=True):
    m = L.Model(KEY, 'cockpit', None)

    # -- dashboard: centre section -----------------------------------------------------------
    p = m.part()
    r = p.plate(DASH, 1.4, F, plane='YZ', offset=0.0)
    p.paint([r['sides'][3]], P)
    p.bevel(0.012, 2, 40.0)
    for x in (-0.42, 0.0, 0.42):
        _mfd(p, x)
    p.box((0, 0.86, -0.30), (0.5, 0.3, 0.1), F, chamfer=0.03)             # binnacle on the glare shield
    p.box((0, 0.706, -0.297), (0.4, 0.012, 0.055), P)
    p.box((0, 0.7, -0.335), (0.36, 0.01, 0.008), E)
    p.box((0, 1.12, -0.3105), (1.3, 0.012, 0.012), E)                     # light line at the windshield base
    for sx in (-1, 1):
        p.box((sx * 0.62, 0.9, -0.3317), (0.008, 0.36, 0.012), E, rot=(SLOPE, 0, 0))   # glare shield markers
        p.box((sx * 0.42, 0.78, -0.341), (0.2, 0.1, 0.018), P, rot=(SLOPE, 0, 0), chamfer=0.005)
        for k in range(3):
            p.box((sx * 0.42 + (k - 1) * 0.055, 0.78, -0.3325), (0.03, 0.04, 0.006), E if k == 1 else F,
                  rot=(SLOPE, 0, 0))
        p.box((sx * 0.5, 1.0, -0.321), (0.26, 0.12, 0.012), P, rot=(SLOPE, 0, 0))            # vent grille
        for k in range(4):
            p.box((sx * 0.5 + (k - 1.5) * 0.06, 1.0, -0.316), (0.012, 0.1, 0.008), F, rot=(SLOPE, 0, 0))
    p.box((0, 0.42, -0.86), (0.3, 0.5, 0.3), F, chamfer=0.04)             # centre pedestal
    p.box((0, 0.42, -0.705), (0.24, 0.42, 0.02), P)
    for k in range(3):
        p.box((0, 0.3 + k * 0.12, -0.692), (0.18, 0.012, 0.008), E)
    m.add(p)

    # -- dashboard wings (right, mirrored) -----------------------------------------------------
    w = m.part()
    r = w.plate(DASH, 0.78, F, plane='YZ', offset=0.7 + 0.39)
    w.paint([r['sides'][3]], P)
    w.bevel(0.012, 2, 40.0)
    _mfd(w, 1.09, w=0.5, h=0.24)
    w.box((1.09, 1.12, -0.3105), (0.62, 0.012, 0.012), E)
    w.box((1.09, 0.9, -0.33), (0.36, 0.16, 0.035), P, chamfer=0.01)      # switch panel on the shield
    for k in range(4):
        w.box((0.96 + k * 0.085, 0.9, -0.31), (0.03, 0.05, 0.012), E if k % 2 == 0 else F)
    w.rot('Z', WING, center=HINGE)
    m.add(w, mirror=True)

    # -- side consoles with the canopy sill (right, mirrored) -----------------------------------
    c = m.part()
    sec = [(0.58, -1.0), (1.36, -1.0), (1.36, -0.26), (1.24, -0.26), (1.2, -0.5), (0.62, -0.5), (0.58, -0.54)]
    r = c.plate(sec, 1.4, F, plane='XZ', offset=0.05)
    c.paint([r['sides'][4]], P)
    c.bevel(0.012, 2, 40.0)
    c.box((0.9, 0.3, -0.492), (0.44, 0.5, 0.03), P, chamfer=0.008)       # keypad
    for i in range(4):
        for j in range(3):
            lit = (i + j) % 3 == 0
            c.box((0.76 + j * 0.14, 0.12 + i * 0.12, -0.474), (0.09, 0.07, 0.012), E if lit else F)
    c.box((0.9, -0.4, -0.492), (0.44, 0.3, 0.03), P, chamfer=0.008)
    for j in range(3):
        c.box((0.76 + j * 0.14, -0.4, -0.474), (0.012, 0.22, 0.01), E)
    c.box((1.22, 0.05, -0.375), (0.012, 1.1, 0.012), E)                   # sill light line
    m.add(c, mirror=True)

    # -- controls: stick on the right console, throttle on the left ---------------------------
    p = m.part()
    p.box((0.9, -0.08, -0.47), (0.16, 0.16, 0.05), F, chamfer=0.03)
    p.tube((0.9, -0.08, -0.46), (0.88, -0.02, -0.27), 0.022, 0.02, 8, F)
    p.box((0.878, -0.012, -0.23), (0.05, 0.06, 0.11), P, chamfer=0.015, rot=(-18, 0, 0))
    p.box((0.878, 0.018, -0.19), (0.02, 0.012, 0.02), E)
    p.box((-0.9, -0.08, -0.47), (0.2, 0.34, 0.05), P, chamfer=0.02)
    for dx in (-0.04, 0.04):
        p.tube((-0.9 + dx, -0.12, -0.46), (-0.9 + dx, 0.0, -0.31), 0.014, segs=6, mat=F)
    p.tube((-0.97, 0.0, -0.31), (-0.83, 0.0, -0.31), 0.026, segs=8, mat=P)
    p.box((-0.9, -0.2, -0.447), (0.16, 0.012, 0.008), E)
    m.add(p)

    # -- canopy frame (right, mirrored): windshield rail, A-pillar, roof rail, rear hoop -------
    def swing(pt):                                    # a dashboard point carried along by the wing rotation
        a = math.radians(WING)
        dx, dy = pt[0] - HINGE[0], pt[1] - HINGE[1]
        return (HINGE[0] + dx * math.cos(a) - dy * math.sin(a), HINGE[1] + dx * math.sin(a) + dy * math.cos(a), pt[2])

    f = m.part()
    corner = swing((1.48, 1.26, -0.29))
    base = swing((1.1, 1.26, -0.29))
    knee, rear, sill = (0.78, 0.92, 0.5), (0.7, -0.45, 0.8), (1.3, -0.55, -0.26)
    f.pipe([(0.0, 1.27, -0.29), (HINGE[0], 1.27, -0.29), corner, (1.3, 0.72, -0.26)], 0.03, 6, F)
    f.pipe([base, knee, rear, sill], 0.045, 6, F)
    f.pipe([knee, (0.42, 0.99, 0.585), (0.0, 1.02, 0.61)], 0.04, 6, F)    # windshield header
    f.tube(rear, (0.0, -0.45, 0.84), 0.04, segs=6, mat=F)                 # rear hoop
    f.box(((knee[0] + rear[0]) / 2 - 0.02, 0.25, 0.655), (0.012, 0.5, 0.012), E, rot=(12.4, 0, 0))
    m.add(f, mirror=True)

    p = m.part()                                      # overhead panel between the roof rails
    p.box((0, 0.3, 0.72), (0.56, 0.36, 0.05), F, chamfer=0.015, rot=(8, 0, 0))
    p.box((0, 0.3, 0.692), (0.46, 0.26, 0.012), P, rot=(8, 0, 0))
    for k in range(4):
        p.box((-0.165 + k * 0.11, 0.3, 0.683), (0.05, 0.16, 0.008), E if k in (0, 3) else F, rot=(8, 0, 0))
    m.add(p)

    m.empty('eye', (0, 0, 0))
    rep = K.finish(m, sharp=38.0, ao=ao, ao_distance=0.4, export=export, preview=False)
    if preview:
        path = os.path.join(L.PREVIEW_DIR, KEY + '.png')
        K.render_pov(KEY, path)
        rep['preview'] = path
    return rep
