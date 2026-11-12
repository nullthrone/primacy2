"""asteroid_0 - elongated rock with a waist and a slight bend."""

from props import rockkit

KEY = 'asteroid_0'


def build(export=True, preview=True, ao=True):
    return rockkit.build_rock(KEY, seed=11, scale=(1.0, 0.5, 0.46), amp=0.24, waist=0.26, bend=0.22, cuts=3, craters=2, crater_size=(0.3, 0.45), crater_depth=(0.12, 0.2), export=export, preview=preview, ao=ao)
