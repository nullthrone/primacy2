"""asteroid_2 - chunky block with large broken facets."""

from props import rockkit

KEY = 'asteroid_2'


def build(export=True, preview=True, ao=True):
    return rockkit.build_rock(KEY, seed=37, scale=(1.0, 0.9, 0.82), amp=0.16, boxy=0.5, cuts=8, cut_range=(0.6, 0.82), sharp=25.0, export=export, preview=preview, ao=ao)
