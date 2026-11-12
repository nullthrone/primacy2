"""asteroid_1 - flat shard, chipped along its edges."""

from props import rockkit

KEY = 'asteroid_1'


def build(export=True, preview=True, ao=True):
    return rockkit.build_rock(KEY, seed=23, scale=(1.0, 0.8, 0.3), amp=0.2, cuts=7, cut_range=(0.55, 0.8), cut_bias=(1.0, 1.0, 0.25), sharp=25.0, export=export, preview=preview, ao=ao)
