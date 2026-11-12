"""asteroid_2 - shard: a long splinter of metal-rich rock, all fracture planes and sharp edges,
tapering to one end."""

import math
import random

from props import rockkit as R

KEY = 'asteroid_2'


def build(export=True, preview=True, ao=True):
    rng = random.Random(370)
    core = R.Lobe((0.0, 0.0, 0.0), (1.0, 0.52, 0.44), rot=(18, 0, 0))
    for k in range(6):                                                         # long faces around the axis
        a = math.radians(k * 60.0 + rng.uniform(-20.0, 20.0))
        core.plane((rng.uniform(-0.3, 0.3), math.cos(a), math.sin(a)), rng.uniform(0.42, 0.7))
    core.plane((1.0, 0.35, 0.2), 0.7).plane((-1.0, -0.2, 0.45), 0.78)          # sheared ends
    core.chip(rng, 5, (0.72, 0.92))                                            # smaller chips
    return R.build_rock(
        KEY, 37, [core], taper=-0.3, amp=0.07, freq=3.0, rough=0.02, ridge=0.05, flat_relief=0.22,
        craters=[((0.1, -0.5, 0.85), 0.14, 0.045), ((-0.7, 0.3, -0.6), 0.12, 0.04)], boulders=3,
        sharp=20.0,
        tones=dict(a=(0.52, 0.53, 0.56), b=(0.36, 0.36, 0.39), dust=(0.21, 0.20, 0.20),
                   fresh=(0.96, 0.97, 1.0), band=(0.74, 0.60, 0.38), band_amount=0.45,
                   band_axis=(1.0, 0.5, 0.3), band_freq=2.6),
        export=export, preview=preview, ao=ao)
