"""asteroid_1 - rubble pile: a loose heap of lumps, cratered and strewn with boulders, stony
with rusty mineral bands."""

import random

from props import rockkit as R

KEY = 'asteroid_1'


def build(export=True, preview=True, ao=True):
    rng = random.Random(230)
    lobes = []
    for _ in range(7):
        lobes.append(R.Lobe(R.rand_dir(rng) * rng.uniform(0.24, 0.44),
                            [rng.uniform(0.46, 0.66) for _ in range(3)],
                            rot=[rng.uniform(0.0, 90.0) for _ in range(3)]).chip(rng, 2, (0.84, 0.96)))
    return R.build_rock(
        KEY, 23, lobes, scale=(1.0, 0.9, 0.8), amp=0.11, freq=3.0, rough=0.03, ridge=0.05,
        craters=[((0.5, -0.6, 0.6), 0.34, 0.13), (None, 0.2, 0.08), (None, 0.16, 0.07), (None, 0.24, 0.09)],
        boulders=14, boulder_size=(0.05, 0.13),
        tones=dict(a=(0.68, 0.63, 0.56), b=(0.47, 0.42, 0.36), dust=(0.27, 0.23, 0.20),
                   fresh=(1.0, 0.96, 0.90), band=(0.46, 0.31, 0.22), band_amount=0.45, band_freq=1.8),
        export=export, preview=preview, ao=ao)
