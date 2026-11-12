"""asteroid_2 - shard: a long splinter of metal-rich rock, all fracture planes and sharp edges,
tapering to one end."""

import random

from props import rockkit as R

KEY = 'asteroid_2'


def build(export=True, preview=True, ao=True):
    rng = random.Random(370)
    core = R.Lobe((0.0, 0.0, 0.0), (1.0, 0.46, 0.36), rot=(18, 0, 0))
    core.chip(rng, 9, (0.5, 0.82), bias=(0.25, 1.0, 1.0))                      # long faces
    core.plane((1.0, 0.35, 0.2), 0.72).plane((-1.0, -0.2, 0.45), 0.8)          # sheared ends
    core.chip(rng, 4, (0.8, 0.93))                                             # smaller chips
    return R.build_rock(
        KEY, 37, [core], taper=-0.35, amp=0.07, freq=3.0, rough=0.02, ridge=0.05, flat_relief=0.2,
        craters=[((0.1, -0.5, 0.85), 0.15, 0.05), ((-0.7, 0.3, -0.6), 0.12, 0.04)], boulders=3,
        strata=0.018, sharp=20.0,
        tones=dict(a=(0.55, 0.56, 0.59), b=(0.38, 0.38, 0.41), dust=(0.22, 0.21, 0.21),
                   fresh=(0.96, 0.97, 1.0), band=(0.72, 0.60, 0.40), band_amount=0.4,
                   band_axis=(1.0, 0.5, 0.3), band_freq=2.0),
        export=export, preview=preview, ao=ao)
