"""asteroid_3 - round, heavily cratered body."""

from props import rockkit

KEY = 'asteroid_3'


def build(export=True, preview=True, ao=True):
    return rockkit.build_rock(KEY, seed=41, scale=(1.0, 0.94, 0.88), amp=0.1, rough=0.035, craters=7, crater_size=(0.3, 0.62), crater_depth=(0.16, 0.3), sharp=34.0, export=export, preview=preview, ao=ao)
