"""Synthesis library of the sound library. See README.md in this folder.

Typical category file:

    from synth import register, periodic_noise, through_hull, structure_lowpass
"""
from .core import (SR, bandpass, burst_env, db, exp_decay, fade_edges, freq_filter, highpass, lowpass,
                   machine_tone, normalize_rms, periodic_lfo, periodic_noise, resonator, rise, rms,
                   seeded, sine, slow_wander, snap_freq, transformer_tone, undb, white_noise)
from .hull import MODES, N_MODES, hull_blow, hull_ir, rattles, structure_lowpass, thump, through_hull
from .levels import CEILING_DB, LEVELS, lufs, set_level, target_for, true_peak_db
from .registry import (REGISTRY, Ctx, UnknownSoundError, is_mid_side, load_categories, load_spec, register, render,
                       render_dry)
from .room import SIDE_LOW_HZ, apply_cabin, cabin_ir, mid_side
from .wavio import to_int16, write_wav
