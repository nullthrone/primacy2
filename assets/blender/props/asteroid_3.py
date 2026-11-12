"""asteroid_3 - slab: a tabular block split along its bedding planes, with layered strata on
the broken edges and a large crater on the flat face."""

import random

from props import rockkit as R

KEY = 'asteroid_3'
BEDDING = (0.06, -0.04, 1.0)


def build(export=True, preview=True, ao=True):
    rng = random.Random(410)
    slab = R.Lobe((0.0, 0.0, 0.0), (0.98, 0.78, 0.5), rot=(0, 0, 12))
    slab.plane(BEDDING, 0.50).plane((-0.05, 0.08, -1.0), 0.44)                 # top and bottom
    slab.chip(rng, 9, (0.62, 0.92), bias=(1.0, 1.0, 0.15))                     # broken edges
    knob = R.Lobe((-0.38, 0.22, -0.12), (0.5, 0.44, 0.3), rot=(0, 10, 30)).chip(rng, 2, (0.8, 0.95))
    return R.build_rock(
        KEY, 41, [slab, knob], amp=0.08, freq=2.8, rough=0.025, ridge=0.045, flat_relief=0.3,
        craters=[((0.25, -0.2, 1.0), 0.3, 0.09), ((-0.55, 0.3, 1.0), 0.15, 0.05), ((0.6, 0.5, -1.0), 0.2, 0.07)],
        boulders=7, boulder_at=[(0.0, 0.0, 1.0)], boulder_spread=0.8, strata=0.05, sharp=22.0,
        tones=dict(a=(0.64, 0.60, 0.54), b=(0.46, 0.43, 0.40), dust=(0.25, 0.23, 0.21),
                   fresh=(0.95, 0.92, 0.86), band=(0.30, 0.27, 0.26), band_amount=0.7,
                   band_axis=BEDDING, band_freq=2.3),
        export=export, preview=preview, ao=ao)
