"""Thrusters: manoeuvring thruster pulses (one event, three thrusters) and the sustained burn.

The pulses are blows on the hull with a valve knock in front; the burn is gas noise, valve chatter
and a feed pump through the hull. Shared helpers come from cat_impacts.
"""
import numpy as np

from . import (LEVELS, SR, bandpass, burst_env, fade_edges, machine_tone, normalize_rms, periodic_lfo,
               periodic_noise, rattles, register, rms, seeded, slow_wander, structure_lowpass,
               through_hull, MODES, freq_filter)
from .cat_impacts import blow, creak, no_dc, ring_events

LEVELS.update({"thruster_burn_loop": ("lufs", -30.0)})  # provisional; pulses are in the core table


# A valve tick first (500 Hz to 1.6 kHz, a few ms), then the thump of the gas pulse 6 to 8 ms later.
THRUSTERS = {
    "thruster_pulse_a": dict(f_start=150, f_end=92, thump_t60=0.1, ring=0.8, ring_sharp=0.3, attack_ms=4.5, tick=0.3, tick_delay_ms=0, delay_ms=7),
    "thruster_pulse_b": dict(f_start=135, f_end=84, thump_t60=0.13, ring=0.85, ring_sharp=0.35, attack_ms=5.0, tick=0.25, tick_delay_ms=1, delay_ms=8),
    "thruster_pulse_c": dict(f_start=170, f_end=100, thump_t60=0.15, ring=1.0, ring_sharp=0.4, attack_ms=4.5, tick=0.3, tick_delay_ms=0, delay_ms=6, rattle=0.3),
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
    hiss = periodic_noise(n, "pink", s("hiss"), lo=160, hi=1000)
    hiss = hiss * (1.0 + 0.18 * slow_wander(n, s("hiss_wander"), 1.0, 7.0))
    # valve chatter and feed pump: two beating partial series on 96 Hz, so the weight is in the
    # harmonics and not below 100 Hz; flutter and a slow swell keep it from being a ruler-straight line
    buzz = machine_tone(n, 96.0, (1, 2, 3, 4), (0.7, 1.0, 0.7, 0.35), beat_hz=0.8, flutter_hz=4.0,
                        flutter=0.01, beat_depth=0.3, rng=s("buzz"))
    buzz = normalize_rms(buzz * (1.0 + 0.35 * periodic_lfo(n, 29.0, 0.2)) *
                         (1.0 + 0.12 * slow_wander(n, s("swell"), 0.3, 1.5)))
    base = periodic_noise(n, "pink", s("brown"), lo=90, hi=420)
    base = through_hull(base, periodic=True, sharp=0.3, gains=np.where(MODES[:, 0] < 100, 0.25, 1.0), dry=0.7)
    y = 1.0 * normalize_rms(base) + 0.9 * buzz + 0.5 * normalize_rms(hiss)
    y = structure_lowpass(y, periodic=True)
    y = freq_filter(y, lo=50.0, order=4)
    return y - y.mean()


