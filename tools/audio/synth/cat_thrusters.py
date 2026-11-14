"""Thrusters: manoeuvring thruster pulses (one event, three thrusters) and the sustained burn.

The pulses are blows on the hull with a valve knock in front; the burn is gas noise, valve chatter
and a feed pump through the hull. Shared helpers come from cat_impacts.
"""
import numpy as np

from . import (LEVELS, SR, bandpass, burst_env, fade_edges, machine_tone, normalize_rms, periodic_lfo,
               periodic_noise, rattles, register, rms, seeded, slow_wander, structure_lowpass,
               through_hull, MODES)
from .cat_impacts import blow, creak, no_dc, ring_events

LEVELS.update({"thruster_burn_loop": ("lufs", -30.0)})  # provisional; pulses are in the core table


THRUSTERS = {
    "thruster_pulse_a": dict(f_start=95, f_end=52, thump_t60=0.11, ring=0.6, ring_sharp=0.3, attack_ms=4.5, tick=0.5, tick_delay_ms=0, delay_ms=6),
    "thruster_pulse_b": dict(f_start=82, f_end=46, thump_t60=0.14, ring=0.65, ring_sharp=0.35, attack_ms=5.0, tick=0.4, tick_delay_ms=1, delay_ms=8),
    "thruster_pulse_c": dict(f_start=112, f_end=58, thump_t60=0.16, ring=0.9, ring_sharp=0.4, attack_ms=4.5, tick=0.5, tick_delay_ms=0, delay_ms=5, rattle=0.3),
}


def _make_pulse(sid):
    @register(sid)
    def _render(ctx):
        y = blow(ctx.n, "thruster_pulse", **THRUSTERS[sid])
        # the hull rings for seconds; a short file must end in silence
        return no_dc(fade_edges(y, 0.0, 0.5 * 1000.0 * ctx.n / SR))
    return _render


for _sid in THRUSTERS:
    _make_pulse(_sid)


@register("thruster_burn_loop")
def thruster_burn_loop(ctx):
    n = ctx.n
    s = lambda name: seeded("thruster_burn/" + name)
    # gas through the nozzle: muffled hiss, only what the hull lets through
    hiss = periodic_noise(n, "pink", s("hiss"), lo=140, hi=1000)
    hiss = hiss * (1.0 + 0.18 * slow_wander(n, s("hiss_wander"), 1.0, 7.0))
    # valve chatter and feed pump: a low buzz of two beating partial series
    buzz = machine_tone(n, 58.0, (1, 2, 3, 4), (1.0, 0.7, 0.4, 0.2), beat_hz=0.8, flutter_hz=4.0,
                        flutter=0.006, beat_depth=0.3, rng=s("buzz"))
    buzz = normalize_rms(buzz * (1.0 + 0.35 * periodic_lfo(n, 29.0, 0.2)))
    base = periodic_noise(n, "brown", s("brown"), lo=25, hi=300)
    base = through_hull(base, periodic=True, sharp=0.2, dry=0.7)
    y = 1.0 * normalize_rms(base) + 0.9 * buzz + 0.35 * normalize_rms(hiss)
    y = structure_lowpass(y, periodic=True)
    return y - y.mean()


