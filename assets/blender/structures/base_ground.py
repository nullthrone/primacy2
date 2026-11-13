"""base_ground - surface outpost on an airless moon, 470 m across.

In the middle stands the compound: a two-tier hub with the control tower and comms mast, three
habitat modules buried under regolith berms, a tank farm, a vehicle shed, radiators, a comms
dish, a regolith hopper, cargo and a workshop hut, tied together by a ring main and pipe runs.
Eight floodlight masts stand on its rim. Around it lie four landing pads, numbered 1 to 4
clockwise from north: lift platforms (a plate inside a seam and a hazard ring) that could sink
into a hangar, each with edge lights, a touchdown circle and its number. Everything stands on an
apron of sintered regolith.

Matches packages/shared/src/structures.ts (entry base_ground): the compound fills the cylinder
r 90 from the ground to 40 m, the tower the cylinder r 14 up to 110 m, everything lies inside a
250 m sphere, and the pads are the `pads` listed there (centres 170 m out, radius 40). Up is
Blender +Z (glTF +Y), the ground is z = 0 and north is Blender +Y (glTF -Z), the axes of a
ground site. Nothing but the pad furniture (edge lights, a service pit, markings) stands on or
between the pads; that furniture has no colliders.

Nodes: the mesh of the compound; three child meshes that lie flat on the ground and are drawn
with a depth offset by the game so they do not fight with the terrain under them ("ground": the
apron; "pads": the four platforms, their edge lights and pipes; "marks": everything painted);
empties pad_1..pad_4 at the pad centres; empties light_N at every lamp with the properties
p2_light (flood, edge, beacon, work, door) and p2_pad (1..4, or 0). Materials the game drives:
emissive_light_flood (off by day), emissive_light_pad1..4 (the edge lights of one pad),
emissive_light_beacon. Amber accent, as on the orbital outpost.
"""

import math

import numpy as np
from mathutils import Vector

import p2lib as L
from structures import skit as K

KEY = 'base_ground'
BOUND = 250.0
BLOCK_R, BLOCK_H = 90.0, 40.0
TOWER_R, TOWER_H = 14.0, 110.0
COLLIDERS = [dict(kind='cylinder', y0=0.0, y1=BLOCK_H, r=BLOCK_R),
             dict(kind='cylinder', y0=BLOCK_H, y1=TOWER_H, r=TOWER_R)]

PAD_R = 40.0
PAD_DIST = 170.0
# Pad 1 north, 2 east, 3 south, 4 west; angles from Blender +X (east) toward +Y (north).
PAD_ANGLES = (90.0, 0.0, 270.0, 180.0)
APRON_R = 235.0
# Heights of the flat layers above the ground plane. The game orders them by depth offset; the
# small steps only keep them apart up close.
Z_APRON, Z_PAD, Z_MARK_APRON, Z_MARK_PAD = 0.03, 0.08, 0.045, 0.095
PAD_SEGS = 64
EDGE_LIGHTS = 16
EDGE_R = PAD_R + 1.4
MAST_R, MAST_H, MAST_OFF = 85.0, 36.4, 20.0

H, S2, D, GLASS, LAMP = 'hull_primary', 'hull_secondary', 'hull_dark', 'glass', 'emissive_light'
REG, APRON, DECK = 'rock_regolith', 'rock_apron', 'hull_secondary_deck'
HAZ, PAINT, FLOOD, BEACON = 'hull_accent_hazard', 'hull_primary_paint', 'emissive_light_flood', 'emissive_light_beacon'

VARIANTS = {
    REG: dict(base='rock', color=(0.215, 0.205, 0.195), roughness=0.97),
    # The apron's own tone is the regolith's; its vertex colours darken it to sintered ground.
    APRON: dict(base='rock', color=(0.21, 0.205, 0.195), roughness=0.9),
    DECK: dict(base='hull_secondary', color=(0.15, 0.155, 0.165), metallic=0.5, roughness=0.62),
    HAZ: dict(base='hull_accent', color=(0.72, 0.5, 0.03), metallic=0.1, roughness=0.6),
    PAINT: dict(base='hull_primary', color=(0.7, 0.7, 0.68), metallic=0.0, roughness=0.7),
    FLOOD: dict(base='emissive_light', emission=(1.0, 0.9, 0.74), strength=6.0),
    BEACON: dict(base='emissive_light', color=(0.6, 0.05, 0.03), emission=(1.0, 0.07, 0.03), strength=5.0),
}
ACCENT = dict(color=(0.6, 0.3, 0.04), metallic=0.5, roughness=0.5)
for _n in range(1, 5):
    VARIANTS['emissive_light_pad%d' % _n] = dict(base='emissive_light', color=(0.8, 0.9, 1.0),
                                                emission=(0.72, 0.88, 1.0), strength=4.0)


def model():
    """A model (or a geometry container for a child mesh) that knows the materials of the base."""
    m = L.Model(KEY, 'station', BOUND)
    m.variants.update({k: dict(v) for k, v in VARIANTS.items()})
    return m


def annulus(p, r0, r1, z, segs, mat=None, mats=None, twist=0, z1=None, phase=0.0):
    """Flat ring between two radii, facing up. `mats` alternates per segment (None leaves a gap);
    `twist` joins inner vertex k to outer vertex k + twist, which slants the segments (hazard
    stripes). r0 = 0 is a disc."""
    bm = p.bm
    z1 = z if z1 is None else z1
    up = Vector((0, 0, 1))
    angs = [math.radians(phase) + K.TAU * k / segs for k in range(segs)]
    outer = [bm.verts.new((r1 * math.cos(a), r1 * math.sin(a), z1)) for a in angs]
    centre = bm.verts.new((0.0, 0.0, z)) if r0 <= 1e-6 else None
    inner = None if centre is not None else [bm.verts.new((r0 * math.cos(a), r0 * math.sin(a), z)) for a in angs]
    for k in range(segs):
        name = mats[k % len(mats)] if mats else mat
        if name is None:
            continue
        k2 = (k + 1) % segs
        if centre is not None:
            L._mkface(bm, (centre, outer[k], outer[k2]), p.mi(name), up)
        else:
            L._mkface(bm, (inner[k], inner[k2], outer[(k2 + twist) % segs], outer[(k + twist) % segs]), p.mi(name), up)


def flat(p, cx, cy, sx, sy, z, mat, deg=0.0):
    """Painted rectangle lying on the ground: centre, size along x and y, turned by `deg`."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    vs = []
    for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x, y = a * sx * 0.5, b * sy * 0.5
        vs.append(p.bm.verts.new((cx + x * c - y * s, cy + x * s + y * c, z)))
    L._mkface(p.bm, vs, p.mi(mat), Vector((0, 0, 1)))


def place(m, part, ang):
    """Merge a part built on the +X axis into the model, turned to `ang` degrees."""
    K.radial(m, part, angles=[ang])


# ---------------------------------------------------------------------------------------------
# The compound: everything inside the r 90 collider
# ---------------------------------------------------------------------------------------------

def build_hub(m, acc):
    p = m.part()
    lower = [  # (z, r, material of the span starting here, tag)
        (0.0, 26.0, S2, ''), (1.6, 26.0, S2, ''), (2.4, 24.0, H, 'panel'), (5.0, 24.0, H, 'win'), (7.4, 24.0, H, 'panel'),
        (13.4, 24.0, acc, ''), (14.8, 24.0, H, ''), (17.4, 24.0, S2, ''), (18.4, 23.0, D, ''), (18.4, 17.0, S2, ''),
        (19.2, 16.0, H, 'panel'), (21.4, 16.0, H, 'win'), (23.6, 16.0, H, ''), (25.6, 16.0, S2, ''), (26.4, 15.0, D, ''),
        (26.4, 0.0, D, ''),
    ]
    rows = p.lathe([(z, r) for z, r, _, _ in lower], 16, mats=[s[2] for s in lower[:-1]], axis='Z')
    win = [f for i, s in enumerate(lower[:-1]) if s[3] == 'win' for k, f in enumerate(rows[i]) if k % 4 in (0, 1)]
    p.inset(win, 0.55, -0.25, rim=D, inner=LAMP, individual=True)
    panel = [f for i, s in enumerate(lower[:-1]) if s[3] == 'panel' for f in rows[i]]
    p.inset(panel, 0.3, 0.12, rim=D, individual=True)
    # Roof of the lower tier: radiators, hatches and plant between the tiers.
    for ang in (22, 67, 112, 202, 247, 337):
        x, y, _ = K.polar(20.0, ang)
        b = p.box((x, y, 19.4), (3.6, 5.2, 2.0), S2, chamfer=0.4, rot=(0, 0, ang))
        p.inset([b['sides'][4]], 0.4, -0.15, rim=D, inner=D)
    for ang in (157, 292):
        x, y, _ = K.polar(20.0, ang)
        p.tube((x, y, 18.4), (x, y, 21.8), 1.3, segs=8, mat=H, cap_mat=D)
    p.greebles((-9, -9, 26.4), (18, 0, 0), (0, 18, 0), 26, size=(0.8, 3.2), height=(0.4, 1.6), seed=7, mats=(D, S2, H))
    m.add(p)

    t = m.part()                                      # control tower
    t.tube((0, 0, 26.4), (0, 0, 56.5), 4.2, 3.6, segs=8, mat=H)
    for z in (30.0, 38.0, 46.0, 53.0):
        t.tube((0, 0, z), (0, 0, z + 0.7), 4.9, segs=8, mat=S2)
    for ang in (45, 135, 225, 315):                   # work lights on the shaft, over the compound
        x, y, _ = K.polar(4.7, ang)
        t.box((x, y, 33.2), (0.7, 1.5, 0.9), D, rot=(0, 0, ang))
        x, y, _ = K.polar(5.1, ang)
        t.box((x, y, 33.0), (0.16, 1.2, 0.6), FLOOD, rot=(0, 0, ang))
    cab = [(56.0, 3.6, S2), (57.4, 9.4, H), (58.6, 10.2, GLASS), (61.4, 10.8, S2), (62.2, 10.4, H), (63.4, 8.4, D),
           (63.4, 0.0, D)]
    t.lathe([(z, r) for z, r, _ in cab], 16, mats=[s[2] for s in cab[:-1]], axis='Z')
    K.mast(t, (0, 0, 63.0), (0, 0, 107.0), 1.3, mat=S2, lamp_r=0.9, lamp_mat=BEACON, segs=8)
    for z, ln in ((74.0, 5.0), (84.0, 3.6), (94.0, 2.4)):                  # yards with whips
        t.tube((-ln, 0, z), (ln, 0, z), 0.22, segs=4, mat=D)
        t.tube((0, -ln * 0.8, z - 2.0), (0, ln * 0.8, z - 2.0), 0.2, segs=4, mat=D)
        for sx in (-1, 1):
            t.tube((sx * ln, 0, z), (sx * ln, 0, z + 2.6), 0.1, 0.04, 4, D)
    for ang, tilt in ((30, 55), (200, 35)):          # two dishes on the cab roof
        mk = t.mark()
        t.lathe([(0.0, 0.0), (0.35, 1.3), (1.1, 2.7), (1.3, 2.7), (0.6, 1.4), (0.25, 0.0)], 12, mats=[S2, S2, D, H, H],
                axis='Z')
        t.tube((0, 0, 0.3), (0, 0, 2.0), 0.1, segs=4, mat=D)
        vs = t.since(mk)
        t.rot('Y', tilt, verts=vs)
        t.move(7.2, 0.0, 66.2, verts=vs)
        t.rot('Z', ang, verts=vs)
        x, y, _ = K.polar(7.2, ang)
        t.tube((x, y, 63.2), (x, y, 66.0), 0.35, segs=6, mat=D)
    m.add(t)


def habitat(m, acc):
    """One habitat module along +X: a pressure hull from r 30 to 68 under a regolith berm, the
    airlock end standing clear, a tunnel to the hub. Returns the hull and the berm as two parts."""
    p = m.part()
    p.tube((30.0, 0, 2.2), (68.0, 0, 2.2), 5.2, segs=16, mat=H, cap_mat=S2)
    for x in (61.0, 64.5):                             # stiffening rings on the exposed end
        p.tube((x, 0, 2.2), (x + 0.6, 0, 2.2), 5.5, segs=16, mat=S2)
    p.tube((66.4, 0, 2.2), (67.0, 0, 2.2), 5.45, segs=16, mat=acc)
    b = p.box((69.0, 0, 2.3), (2.2, 3.6, 4.6), S2, chamfer=0.35)           # airlock
    p.inset([b['sides'][2]], 0.45, -0.2, rim=D, inner=D)
    p.box((70.15, 0, 4.25), (0.12, 2.2, 0.3), LAMP)
    for sy in (-1, 1):                                 # windows on the exposed flanks
        for x in (62.6, 65.6):
            p.box((x, sy * 5.0, 3.4), (1.9, 0.3, 1.3), D)
            p.box((x, sy * 5.05, 3.4), (1.4, 0.35, 0.8), LAMP)
    p.tube((23.0, 0, 2.6), (31.0, 0, 2.6), 2.3, segs=10, mat=S2)           # tunnel to the hub
    for x in (25.0, 27.5, 30.0):
        p.tube((x, 0, 2.6), (x + 0.35, 0, 2.6), 2.6, segs=10, mat=D)
    p.tube((47.0, 0, 7.6), (47.0, 0, 10.4), 0.55, segs=6, mat=D)           # vent stacks through the berm
    p.tube((52.0, 1.5, 7.4), (52.0, 1.5, 9.4), 0.4, segs=6, mat=D)

    g = m.part()                                      # the berm, lofted along +Y and laid along +X
    S = L.S
    g.loft([S(32.5, 5.0, 0.8, 0.3, n=2.2), S(35.5, 10.5, 6.2, 0.3, n=2.2), S(40.0, 12.6, 8.5, 0.3, n=2.3),
            S(55.0, 12.6, 8.5, 0.3, n=2.3), S(59.0, 10.8, 7.0, 0.3, n=2.2), S(61.8, 6.0, 1.2, 0.3, n=2.2)],
           segs=20, mat=REG, spacing=3.2)
    g.rot('Z', -90.0)
    return p, g


def tank_farm(m, acc):
    """Propellant store along +X: four upright tanks and two spheres on a plinth, with a manifold."""
    p = m.part()
    p.box((60.0, 0, 0.35), (34.0, 26.0, 0.7), S2, chamfer=0.2)
    tank = [(0.7, 0.0), (0.7, 4.2), (5.0, 4.2), (6.2, 4.2), (11.6, 4.2), (13.2, 3.2), (14.0, 1.2), (14.0, 0.0)]
    for x in (48.5, 59.0):
        for sy in (-1, 1):
            p.lathe(tank, 12, mats=[D, H, acc, H, H, S2, D], axis='Z', origin=(x, sy * 6.6, 0.0))
            p.tube((x, sy * 6.6, 14.0), (x, sy * 6.6, 15.2), 0.5, segs=6, mat=D)
            p.pipe([(x, sy * 2.0, 1.5), (x, sy * 2.0, 3.2), (x, sy * 2.6, 3.2)], 0.3, 6, D)
    ball = [(-1.0, 0.0), (-0.92, 0.38), (-0.71, 0.71), (-0.38, 0.92), (0.0, 1.0), (0.38, 0.92), (0.71, 0.71),
            (0.92, 0.38), (1.0, 0.0)]
    for sy in (-1, 1):
        c = (71.5, sy * 6.4, 6.4)
        p.lathe([(t * 4.6, r * 4.6) for t, r in ball], 14, mats=[H, H, H, acc, acc, H, H, H], axis='Z', origin=c)
        for a in (45, 135, 225, 315):
            dx, dy, _ = K.polar(3.4, a)
            p.tube((c[0] + dx, c[1] + dy, 0.7), (c[0] + dx * 0.85, c[1] + dy * 0.85, 4.6), 0.3, segs=4, mat=S2)
        p.pipe([(71.5, sy * 2.0, 1.5), (71.5, sy * 2.0, 2.4), (71.5, sy * 5.0, 2.4)], 0.3, 6, D)
    p.tube((43.5, 0.0, 1.5), (76.0, 0.0, 1.5), 0.45, segs=8, mat=D)        # manifold down the middle
    for sy in (-1, 1):
        p.tube((45.0, sy * 2.0, 1.5), (72.5, sy * 2.0, 1.5), 0.3, segs=6, mat=acc if sy > 0 else D)
    for x in (46.0, 54.0, 64.0, 74.0):
        p.box((x, 0.0, 1.05), (0.5, 5.4, 0.7), S2)
    p.tube((29.5, 0.0, 1.1), (43.8, 0.0, 1.1), 0.36, segs=6, mat=D)        # feed from the ring main
    return p


def vehicle_shed(m, acc):
    """Shed with its door toward +X and a rover parked in front of it."""
    p = m.part()
    b = p.box((60.0, 0, 4.2), (20.0, 14.0, 8.4), H, chamfer=0.5)
    p.inset([b['sides'][2]], 1.2, -0.35, rim=S2, inner=D)                 # roller door
    for z in (2.2, 3.8, 5.4):
        p.box((70.0, 0, z), (0.25, 10.6, 0.2), S2)
    p.inset([b['cap0'], b['cap1']], 1.0, 0.1, rim=D)
    p.box((60.0, 0, 8.8), (21.0, 15.0, 0.7), S2, chamfer=0.2)              # roof slab
    p.box((55.0, 3.0, 9.6), (3.0, 2.4, 1.0), D, chamfer=0.2)
    p.tube((63.0, -4.0, 9.1), (63.0, -4.0, 11.4), 0.4, segs=6, mat=D)
    p.box((70.1, 6.2, 6.4), (0.14, 1.2, 0.5), LAMP)
    # Rover: a pressurised cab on six wheels.
    p.box((79.0, 3.2, 1.75), (5.6, 2.6, 1.5), acc, chamfer=0.3)
    p.box((80.6, 3.2, 2.75), (2.2, 2.3, 1.1), GLASS, chamfer=0.25)
    p.box((77.6, 3.2, 2.7), (2.6, 2.0, 0.8), S2, chamfer=0.2)
    for x in (77.0, 79.0, 81.0):
        for y in (1.7, 4.7):
            p.tube((x, y - 0.3, 0.75), (x, y + 0.3, 0.75), 0.75, segs=10, mat=D)
    return p


def radiators(m):
    """Three radiator panels standing edge-on to +X, with their header pipe."""
    p = m.part()
    for x in (50.0, 59.0, 68.0):
        b = p.box((x, 0, 4.4), (0.35, 15.0, 6.4), D)
        p.inset([b['sides'][1], b['sides'][3]], 0.5, 0.0, rim=S2, inner=H, individual=True)
        for y in (-6.0, 6.0):
            p.tube((x, y, 0.0), (x, y, 1.3), 0.35, segs=6, mat=S2)
    p.tube((47.0, -7.6, 0.7), (71.0, -7.6, 0.7), 0.35, segs=6, mat=D)
    return p


def comms_dish(m):
    """Ground station: a 9 m dish on a pedestal with its equipment hut."""
    p = m.part()
    p.tube((66.0, 0, 0.0), (66.0, 0, 6.6), 1.3, 0.9, segs=8, mat=S2)
    p.box((66.0, 0, 0.5), (4.4, 4.4, 1.0), D, chamfer=0.2)
    mk = p.mark()
    p.lathe([(0.0, 0.0), (0.5, 2.0), (1.5, 4.0), (1.9, 4.6), (2.1, 4.6), (1.1, 2.3), (0.35, 0.0)], 16,
            mats=[S2, S2, S2, D, H, H], axis='Z')
    p.tube((0, 0, 0.4), (0, 0, 3.4), 0.14, segs=4, mat=D)
    p.box((0, 0, 3.5), (0.6, 0.6, 0.5), D)
    vs = p.since(mk)
    p.rot('Y', 38.0, verts=vs)
    p.move(66.0, 0.0, 7.4, verts=vs)
    p.box((58.5, 3.5, 1.5), (4.0, 3.2, 3.0), H, chamfer=0.3)
    p.box((58.5, 1.85, 2.2), (1.2, 0.12, 0.4), LAMP)
    return p


def cargo_yard(m, acc, seed):
    """Stacked containers on +X."""
    p = m.part()
    rng = np.random.RandomState(seed)
    mats = (acc, H, S2, D)
    spots = [(54.0, -5.0), (54.0, 0.0), (54.0, 5.0), (62.0, -4.0), (62.0, 2.5), (70.0, -1.0)]
    for i, (x, y) in enumerate(spots):
        for level in range(1 if rng.rand() < 0.45 else 2):
            yaw = 0.0 if level == 0 else float(rng.uniform(-4, 4))
            p.box((x + float(rng.uniform(-0.4, 0.4)), y, 1.4 + 2.7 * level), (6.0, 2.5, 2.6),
                  mats[int(rng.randint(0, len(mats)))], chamfer=0.12, rot=(0, 0, yaw))
    return p


def hopper(m, acc):
    """Regolith plant: a silo on legs, the conveyor that feeds it and the heap it is fed from."""
    p = m.part()
    silo = [(4.0, 0.0), (4.0, 0.8), (7.5, 4.0), (15.0, 4.0), (16.2, 3.0), (16.2, 0.0)]
    p.lathe(silo, 12, mats=[D, S2, H, S2, D], axis='Z', origin=(58.0, 0.0, 0.0))
    for a in (45, 135, 225, 315):
        dx, dy, _ = K.polar(3.6, a)
        p.tube((58.0 + dx, dy, 0.0), (58.0 + dx, dy, 8.0), 0.3, segs=4, mat=S2)
    p.tube((58.0, 0.0, 9.8), (58.0, 0.0, 10.6), 4.15, segs=12, mat=acc)
    p.box((68.0, 0.0, 9.6), (22.0, 1.6, 0.9), S2, rot=(0, 41.0, 0))        # conveyor up to the silo top
    p.tube((76.3, 0.0, 0.0), (76.3, 0.0, 2.2), 0.3, segs=4, mat=D)
    p.tube((66.0, 0.0, 0.0), (66.0, 0.0, 11.0), 0.3, segs=4, mat=D)
    p.lathe([(-0.3, 0.0), (-0.3, 6.5), (1.2, 4.6), (2.6, 2.4), (3.2, 0.9), (3.4, 0.0)], 12, mat=REG, axis='Z',
            origin=(80.0, 3.0, 0.0))
    p.box((50.5, -4.5, 2.0), (5.0, 4.0, 4.0), H, chamfer=0.3)
    return p


def workshop(m, acc):
    """Workshop hut: half a cylinder lying across +X, closed by two end walls."""
    p = m.part()
    shell = [(60.0 - 6.0 * math.cos(math.pi * k / 8.0), 6.0 * math.sin(math.pi * k / 8.0)) for k in range(9)]
    hut = p.prism(shell, -9.0, 9.0, H, cap_mat=S2)
    p.inset([hut['cap0'], hut['cap1']], 0.8, -0.2, rim=S2, inner=D)
    for y in (-6.0, -2.0, 2.0, 6.0):
        p.prism([(60.0 - 6.2 * math.cos(math.pi * k / 8.0), 6.2 * math.sin(math.pi * k / 8.0)) for k in range(9)],
                y - 0.2, y + 0.2, S2)
    p.box((60.0, 9.15, 4.6), (2.0, 0.12, 0.4), LAMP)
    return p


def power_bank(m, acc):
    """Battery and switchgear modules in a row along +X, with a cable tray."""
    p = m.part()
    for x in (54.0, 61.0, 68.0):
        b = p.box((x, 0.0, 2.2), (5.0, 8.0, 4.0), H, chamfer=0.3)
        p.inset([b['sides'][4]], 0.6, 0.15, rim=D, inner=S2)
        p.box((x, -4.1, 2.2), (3.4, 0.12, 2.4), D)
        p.box((x + 1.4, -4.2, 3.2), (0.5, 0.1, 0.25), LAMP)
    p.box((61.0, 4.9, 0.5), (20.0, 0.9, 0.5), D)
    p.box((61.0, 0.0, 0.25), (22.0, 9.6, 0.5), S2, chamfer=0.15)
    return p


def flood_mast(m, side):
    """Floodlight mast on the rim of the compound at +X, its head turned toward the pad that lies
    MAST_OFF degrees to one side (`side` +1: the mast stands counter-clockwise of its pad)."""
    p = m.part()
    x0 = MAST_R
    p.box((x0, 0, 0.7), (2.2, 2.2, 1.4), D, chamfer=0.25)
    p.tube((x0, 0, 1.4), (x0, 0, MAST_H), 0.75, 0.4, segs=4, mat=S2)
    p.box((x0, 0, 18.0), (1.9, 1.9, 0.25), D)
    # Direction from the mast to the centre of its pad, in the mast's own frame.
    a = math.radians(MAST_OFF)
    yaw = math.degrees(math.atan2(-side * PAD_DIST * math.sin(a), PAD_DIST * math.cos(a) - MAST_R))
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    sx, sy = -s, c
    p.tube((x0 - sx * 2.6, -sy * 2.6, MAST_H), (x0 + sx * 2.6, sy * 2.6, MAST_H), 0.22, segs=4, mat=D)
    pitch = 24.0
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    for off in (-2.1, -0.7, 0.7, 2.1):
        cx, cy, cz = x0 + sx * off + c * 0.35, sy * off + s * 0.35, MAST_H - 0.35
        p.box((cx, cy, cz), (0.9, 1.15, 0.9), D, rot=(0, pitch, yaw))
        p.box((cx + c * cp * 0.47, cy + s * cp * 0.47, cz - sp * 0.47), (0.08, 0.95, 0.72), FLOOD, rot=(0, pitch, yaw))
    return p


def pipe_run(m, acc):
    """Fuel and coolant lines from the ring main out to the rim of the compound, beside +X."""
    p = m.part()
    p.pipe([(29.5, 3.2, 1.0), (52.0, 3.2, 1.0), (52.0, 5.8, 1.0), (55.5, 5.8, 1.0), (55.5, 3.2, 1.0), (89.6, 3.2, 1.0)],
           0.32, 6, D)
    p.tube((29.5, 2.3, 0.6), (89.6, 2.3, 0.6), 0.2, segs=6, mat=acc)
    for x in range(34, 90, 8):
        p.box((float(x), 2.8, 0.35), (0.5, 2.0, 0.7), S2)
    return p


def build_compound(m, acc):
    build_hub(m, acc)
    for ang in (45.0, 135.0, 225.0):
        hull, berm = habitat(m, acc)
        place(m, hull, ang)
        place(m, berm, ang)
    place(m, tank_farm(m, acc), 315.0)
    place(m, vehicle_shed(m, acc), 292.0)
    place(m, radiators(m), 338.0)
    place(m, comms_dish(m), 68.0)
    place(m, cargo_yard(m, acc, 3), 112.0)
    place(m, cargo_yard(m, acc, 11), 248.0)
    place(m, hopper(m, acc), 202.0)
    place(m, workshop(m, acc), 158.0)
    place(m, power_bank(m, acc), 22.0)
    for side in (1, -1):
        K.radial(m, flood_mast(m, side), angles=[c + side * MAST_OFF for c in PAD_ANGLES])
    K.radial(m, pipe_run(m, acc), angles=list(PAD_ANGLES))

    r = m.part()                                      # ring main around the hub on low supports
    K.sweep(r, [(29.5 + 0.38 * math.cos(K.TAU * k / 6), 1.1 + 0.38 * math.sin(K.TAU * k / 6)) for k in range(6)], 48,
            mat=D)
    m.add(r)
    s = m.part()
    s.box((29.5, 0.0, 0.4), (0.6, 0.6, 0.8), S2)
    K.radial(m, s, 16, phase=11.25)


# ---------------------------------------------------------------------------------------------
# What lies flat on the ground: apron, pads, markings
# ---------------------------------------------------------------------------------------------

def build_ground():
    """The apron: a disc of sintered regolith whose rim dips into the ground."""
    g = model()
    p = g.part()
    radii = [0.0] + [12.0 * k for k in range(1, 20)] + [APRON_R]
    for a, b in zip(radii[:-1], radii[1:]):
        annulus(p, a, b, Z_APRON, 72, APRON, z1=-0.12 if b == APRON_R else Z_APRON)
    g.add(p)
    return g


# Strokes of the pad numbers on a seven-segment grid: (centre right, centre up, width, height) in
# units of the digit's half height.
STROKE = 0.27
_W = 0.58
_SEG = {
    'a': (0.0, 1.0 - STROKE / 2, 2 * _W, STROKE), 'd': (0.0, -1.0 + STROKE / 2, 2 * _W, STROKE), 'g': (0.0, 0.0, 2 * _W, STROKE),
    'b': (_W - STROKE / 2, 0.5, STROKE, 1.0), 'c': (_W - STROKE / 2, -0.5, STROKE, 1.0),
    'f': (-_W + STROKE / 2, 0.5, STROKE, 1.0), 'e': (-_W + STROKE / 2, -0.5, STROKE, 1.0),
}
DIGITS = {
    1: [(0.0, 0.0, STROKE, 2.0), (-0.24, 0.72, 0.3, 0.3), (0.0, -1.0 + STROKE / 2, 0.9, STROKE)],
    2: [_SEG[k] for k in 'abged'],
    3: [_SEG[k] for k in 'abgcd'],
    4: [_SEG[k] for k in 'fgbc'],
}


def pad_parts(g, k, n):
    """Pad `n` built around the origin with the hub toward -X: (platform part, markings part)."""
    lamp = 'emissive_light_pad%d' % n
    p = g.part()
    annulus(p, 0.0, 34.0, Z_PAD, PAD_SEGS, DECK)                           # the lift plate
    annulus(p, 34.0, 34.6, Z_PAD, PAD_SEGS, D)                             # the seam it moves in
    annulus(p, 34.6, 37.6, Z_PAD, PAD_SEGS, mats=[HAZ, D], twist=1)        # hazard stripes
    annulus(p, 37.6, 39.3, Z_PAD, PAD_SEGS, S2)                            # collar
    annulus(p, 39.3, PAD_R, Z_PAD, PAD_SEGS, S2, z1=0.0)
    for i in range(EDGE_LIGHTS):
        x, y, _ = K.polar(EDGE_R, (i + 0.5) * 360.0 / EDGE_LIGHTS)
        p.box((x, y, 0.2), (0.55, 0.55, 0.4), D)
        p.box((x, y, 0.46), (0.36, 0.36, 0.14), lamp)
    # Service pit on the hub side, at the end of the pipes from the compound.
    b = p.box((-43.2, 3.0, 0.5), (2.6, 3.2, 1.0), S2, chamfer=0.15)
    p.inset([b['sides'][4]], 0.35, -0.08, rim=D, inner=D)
    p.tube((-80.4, 3.2, 1.0), (-44.4, 3.2, 1.0), 0.32, segs=6, mat=D)
    p.tube((-80.4, 2.3, 0.6), (-44.4, 2.3, 0.6), 0.2, segs=6, mat='hull_accent_' + KEY)
    for x in range(-78, -44, 8):
        p.box((float(x), 2.8, 0.35), (0.5, 2.0, 0.7), S2)

    q = k.part()
    annulus(q, 19.4, 20.2, Z_MARK_PAD, PAD_SEGS, PAINT)                    # touchdown circle
    for r in (10.5, 22.5):                                                 # plate segments
        annulus(q, r, r + 0.24, Z_MARK_PAD, PAD_SEGS, D)
    for i in range(8):
        a = 22.5 + 45.0 * i
        x, y, _ = K.polar(27.9, a)
        flat(q, x, y, 11.6, 0.24, Z_MARK_PAD, D, deg=a)
    # The number, its top toward the hub: read upright by a pilot coming in from outside.
    half = 7.0
    for (u, v, w, h) in DIGITS[n]:
        flat(q, -v * half, u * half, h * half, w * half, Z_MARK_PAD + 0.004, PAINT)
    flat(q, -43.6, -3.0, 0.7, 7.0, Z_MARK_APRON, PAINT)                    # hold line
    for x in (-76.0, -68.0, -60.0, -52.0):                                 # taxi line from the compound
        flat(q, x, -3.0, 4.0, 0.5, Z_MARK_APRON, HAZ)
    return p, q


def build_pads():
    g, k = model(), model()
    g.variants['hull_accent_' + KEY] = dict(base='hull_accent', **ACCENT)
    for i, ang in enumerate(PAD_ANGLES):
        p, q = pad_parts(g, k, i + 1)
        for part in (p, q):
            part.move(x=PAD_DIST)
        K.radial(g, p, angles=[ang])
        K.radial(k, q, angles=[ang])
    q = k.part()                                      # a broken ring road line around the compound
    annulus(q, 95.6, 96.1, Z_MARK_APRON, 96, mats=[PAINT, None, None])
    k.add(q)
    return g, k


# ---------------------------------------------------------------------------------------------
# Lamps, wear, build
# ---------------------------------------------------------------------------------------------

def add_empties(m):
    """pad_1..4 and one light_N per lamp, tagged with what kind of lamp it is and whose pad."""
    lights = []
    for i, ang in enumerate(PAD_ANGLES):
        m.empty('pad_%d' % (i + 1), K.polar(PAD_DIST, ang))
        for side in (1, -1):
            lights.append((K.polar(MAST_R, ang + side * MAST_OFF, MAST_H - 0.3), 'flood', i + 1))
    lights.append(((0.0, 0.0, 108.0), 'beacon', 0))
    lights.append(((0.0, 0.0, 33.0), 'work', 0))
    for ang in (45.0, 135.0, 225.0):
        lights.append((K.polar(70.3, ang, 4.25), 'door', 0))
    for i, ang in enumerate(PAD_ANGLES):
        cx, cy, _ = K.polar(PAD_DIST, ang)
        for j in range(EDGE_LIGHTS):
            x, y, _ = K.polar(EDGE_R, ang + (j + 0.5) * 360.0 / EDGE_LIGHTS)
            lights.append(((cx + x, cy + y, 0.55), 'edge', i + 1))
    for j, (loc, kind, pad) in enumerate(lights):
        m.empty('light_%d' % j, loc, p2_light=kind, p2_pad=pad)
    return len(lights)


def _waves(x, y, f):
    """Smooth blotches in 0..1 from a few crossed sine waves; cheap and good enough for stains."""
    return 0.5 + 0.25 * (np.sin(x * f + 1.7) * np.cos(y * f * 1.13 - 0.6) + np.sin((x * 0.61 - y * 0.43) * f + 2.2))


def _corners(me):
    """Per face corner: position of its vertex, and the name of its face's material."""
    n = len(me.loops)
    vidx = np.zeros(n, dtype=np.int32)
    me.loops.foreach_get('vertex_index', vidx)
    co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    ls = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_start', ls)
    poly = np.zeros(n, dtype=np.int64)
    poly[ls] = 1
    poly = np.cumsum(poly) - 1
    pm = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('material_index', pm)
    names = np.array([mt.name for mt in me.materials])
    return co.reshape(-1, 3)[vidx].astype(np.float64), names[pm[poly]]


def wear(m):
    """Dust and age in the vertex colours of the compound: regolith is mottled, and everything
    built carries a skirt of dust that thins out a few metres above the ground."""
    pos, mat = _corners(m.object.data)
    x, y, z = pos[:, 0], pos[:, 1], pos[:, 2]
    tint = np.ones((len(pos), 3))
    rock = np.char.startswith(mat, 'rock')
    built = np.char.startswith(mat, 'hull')
    mottle = 0.74 + 0.26 * _waves(x, y, 0.21) * (0.6 + 0.4 * _waves(x, y, 0.9))
    skirt = np.clip((z - 0.2) / 5.0, 0.0, 1.0)
    dusty = (0.66 + 0.34 * skirt * skirt * (3.0 - 2.0 * skirt)) * (0.9 + 0.1 * _waves(x + z, y - z, 0.5))
    # The dust is a little warmer than the paint it lies on, most so near the ground.
    for ch, warm in enumerate((1.0, 0.97, 0.92)):
        tint[rock, ch] = mottle[rock]
        tint[built, ch] = dusty[built] * (warm + (1.0 - warm) * skirt[built])
    K.multiply_col(m.object, tint)


def stain(m, kids):
    """Vertex colours of the flat layers. The apron is darkest where it is driven and landed on,
    scorched around the pads and fades into loose regolith at its rim; plates and paint are worn."""
    for name, ob in kids.items():
        me = ob.data
        pos, mat = _corners(me)
        x, y = pos[:, 0], pos[:, 1]
        r = np.hypot(x, y)
        if name == 'ground':
            edge = np.clip((r - 150.0) / (APRON_R - 150.0), 0.0, 1.0)
            v = 0.5 + 0.5 * edge * edge
            v *= 0.86 + 0.14 * _waves(x, y, 0.045)
            v = np.where(r < 96.0, v * 0.9, v)
            for ang in PAD_ANGLES:
                cx, cy, _ = K.polar(PAD_DIST, ang)
                d = np.hypot(x - cx, y - cy)
                v *= 1.0 - 0.3 * np.clip((66.0 - d) / 22.0, 0.0, 1.0)
        else:
            v = 0.8 + 0.2 * _waves(x, y, 0.33)
            v = np.where(np.char.startswith(mat, 'emissive'), 1.0, v)
        col = np.ones((len(pos), 4), dtype=np.float32)
        col[:, 0] = col[:, 1] = col[:, 2] = np.clip(v, 0.0, 1.0)
        me.color_attributes['Col'].data.foreach_set('color', col.ravel())
        me.update()


def build(export=True, preview=True, ao=True):
    m = model()
    acc = m.variant('hull_accent', **ACCENT)
    build_compound(m, acc)
    lamps = add_empties(m)
    pads, marks = build_pads()
    m.props['p2_bound'] = BOUND
    m.props['p2_pad_radius'] = PAD_R
    rep = K.finish(m, COLLIDERS, BOUND, ao=ao, ao_distance=9.0, export=export, preview=preview, post=wear,
                   children=[('ground', build_ground(), {}), ('pads', pads, {}), ('marks', marks, {})],
                   child_post=stain, fit_skip=('ground', 'pads', 'marks'),
                   direction=(0.5, -0.74, 0.46), zoom=1.05, target=(0, 0, 8),
                   require=('pad_1', 'pad_2', 'pad_3', 'pad_4', 'light_0'))
    rep['lamps'] = lamps
    rep['pads'] = [dict(pad=i + 1, blender=[round(v, 3) for v in K.polar(PAD_DIST, a)],
                        gltf=[round(v, 3) for v in L.blender_to_gltf(K.polar(PAD_DIST, a))], r=PAD_R)
                   for i, a in enumerate(PAD_ANGLES)]
    return rep
