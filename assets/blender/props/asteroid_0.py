"""asteroid_0 - contact binary: two unequal lobes joined by a narrow neck, dark carbonaceous
rock with a boulder field in the neck."""

import random

from props import rockkit as R

KEY = 'asteroid_0'


def build(export=True, preview=True, ao=True):
    rng = random.Random(110)
    big = R.Lobe((-0.42, 0.0, 0.03), (0.68, 0.56, 0.50), rot=(12, 0, 14)).chip(rng, 6, (0.72, 0.93))
    small = R.Lobe((0.46, 0.05, -0.04), (0.60, 0.46, 0.42), rot=(0, 16, -18)).chip(rng, 5, (0.74, 0.93))
    return R.build_rock(
        KEY, 11, [big, small], waist=0.36, waist_width=0.17, waist_at=0.07, bend=0.16,
        amp=0.12, freq=2.5, rough=0.03, ridge=0.06, flat_relief=0.25,
        craters=[((-0.55, -0.6, 0.55), 0.24, 0.10), ((0.85, -0.35, 0.4), 0.17, 0.07),
                 ((-0.3, 0.6, -0.7), 0.22, 0.09), ((-0.9, -0.2, -0.3), 0.13, 0.05), ((0.5, -0.8, -0.2), 0.11, 0.045)],
        boulders=11, boulder_at=[(0.08, -0.6, 0.75), (0.05, 0.7, 0.3), (0.1, -0.2, -0.9)], boulder_spread=0.3,
        tones=dict(a=(0.52, 0.50, 0.48), b=(0.36, 0.34, 0.33), dust=(0.20, 0.19, 0.18),
                   fresh=(0.90, 0.87, 0.83), band=(0.66, 0.56, 0.44), band_amount=0.35),
        export=export, preview=preview, ao=ao)
