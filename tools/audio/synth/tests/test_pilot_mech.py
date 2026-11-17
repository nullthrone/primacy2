"""Run: .venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/synth/tests -t tools/audio

Round 3 direction samples, mechanical set: each id is rendered twice (equal), has the right shape,
is finite, and meets two or three of its key targets (the full list of targets is in the report)."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import synth  # noqa: E402
from synth import cat_pilot_mech  # noqa: E402,F401  (importing registers the sounds)

IDS = ("pilot_hull_a", "pilot_hull_b", "pilot_hull_c", "pilot_gear_a", "pilot_gear_b", "pilot_gear_c")
_CACHE: dict = {}

AUDIO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AUDIO / "listen"))
import measure  # noqa: E402
from synth import rules  # noqa: E402

# the rules that apply to every sound (SOUND_DESIGN.md section 2), by their names in rules.py
ALL_SOUNDS_RULES = {"sample-rate", "channels", "true-peak", "clipped", "dc-offset", "onset-late", "tail-not-silent", "silent"}


def failed_general_rules(sid):
    """The all-sounds rules that the levelled, 16-bit render of sid fails, by rules.check itself (the
    limits are those of rules.py: no copy of -1 dBFS, 0.001, 5 ms or -60 dB here)."""
    spec = synth.load_spec()["sounds"][sid]
    y, _ = synth.render(sid)
    pcm = synth.to_int16(y, sid, shared_dither=synth.is_mid_side(spec)).astype(np.float64) / 32768.0
    pcm = pcm[:, None] if pcm.ndim == 1 else pcm
    an = measure.analyse(pcm, synth.SR, loop=spec["kind"] == "loop")
    return [b for b in rules.check(spec, pcm, an, sound_id=sid) if b in ALL_SOUNDS_RULES]


def render(sid):
    if sid not in _CACHE:
        _CACHE[sid] = synth.render(sid)[0]
    return _CACHE[sid]


def mono(x):
    return x.mean(axis=1) if x.ndim == 2 else x


def share(x, lo, hi, t0=0.0, t1=None):
    """Share of the energy of the mono sum between lo and hi Hz, over a time window."""
    m = mono(x)[int(t0 * synth.SR): None if t1 is None else int(t1 * synth.SR)]
    p = np.abs(np.fft.rfft(m - m.mean())) ** 2
    f = np.fft.rfftfreq(m.size, 1.0 / synth.SR)
    return float(p[(f >= lo) & (f < hi)].sum() / p.sum())


def onset(x):
    m = np.abs(mono(x))
    return int(np.argmax(m > m.max() * 0.01)) / synth.SR


class BasicsTest(unittest.TestCase):
    def test_same_bytes_twice_shape_finite_rules(self):
        for sid in IDS:
            a = synth.render_dry(sid)
            b = synth.render_dry(sid)
            self.assertTrue(np.array_equal(a, b), sid)
            spec = synth.load_spec()["sounds"][sid]
            n = int(round(spec["duration"] * synth.SR))
            want = (n,) if int(spec.get("channels", 1)) == 1 else (n, 2)
            self.assertEqual(a.shape, want, sid)
            self.assertTrue(np.all(np.isfinite(a)), sid)
            self.assertEqual(failed_general_rules(sid), [], sid)  # true peak, DC, onset, tail: rules.check decides


class HullTest(unittest.TestCase):
    def test_a_metal(self):
        y = render("pilot_hull_a")
        # the attack: at least 60 % above 1 kHz, centre at or above 2.5 kHz
        a = mono(y)[: int(0.030 * synth.SR)]
        p = np.abs(np.fft.rfft(a - a.mean())) ** 2
        f = np.fft.rfftfreq(a.size, 1.0 / synth.SR)
        self.assertGreaterEqual(p[f >= 1000].sum() / p.sum(), 0.60)
        self.assertGreaterEqual(float((p * f).sum() / p.sum()), 2500.0)
        self.assertTrue(0.20 <= share(y, 1000, 1e5) <= 0.45)
        self.assertGreaterEqual(share(y, 0, 125), 0.20)
        for lo in (62.5, 125, 250, 500, 1000, 2000, 4000, 8000):
            self.assertLessEqual(share(y, lo, 2 * lo), 0.40, lo)

    def test_b_cinema(self):
        y = render("pilot_hull_b")
        self.assertEqual(y.shape[1], 2)
        self.assertGreaterEqual(share(y, 0, 125), 0.30)
        self.assertGreaterEqual(share(y, 250, 2000), 0.25)
        self.assertGreaterEqual(share(y, 2000, 1e5), 0.08)
        low = synth.lowpass(y, 150.0, 4)
        self.assertGreater(np.corrcoef(low[:, 0], low[:, 1])[0, 1], 0.98)
        c = float(np.corrcoef(y[:, 0], y[:, 1])[0, 1])
        self.assertTrue(0.3 <= c <= 0.9, c)

    def test_c_weight(self):
        y = render("pilot_hull_c")
        self.assertGreaterEqual(share(y, 0, 125), 0.50)
        self.assertGreaterEqual(share(y, 0, 60), 0.15)
        self.assertLessEqual(share(y, 1000, 1e5), 0.03)
        for lo in (125, 250, 500, 1000):
            self.assertLessEqual(share(y, lo, 2 * lo), 0.25, lo)


class GearTest(unittest.TestCase):
    def test_a_machinery(self):
        y = render("pilot_gear_a")
        self.assertTrue(0.15 <= share(y, 1000, 1e5) <= 0.40)
        # the lock: a bright clack (centre at or above 2.5 kHz), the clunk about 60 ms later
        i = int(1.80 * synth.SR)
        a = mono(y)[i:i + int(0.030 * synth.SR)]
        p = np.abs(np.fft.rfft(a - a.mean())) ** 2
        f = np.fft.rfftfreq(a.size, 1.0 / synth.SR)
        self.assertGreaterEqual(float((p * f).sum() / p.sum()), 2500.0)

    def test_b_cinema(self):
        y = render("pilot_gear_b")
        self.assertEqual(y.shape[1], 2)
        low = synth.lowpass(y, 150.0, 4)
        self.assertGreater(np.corrcoef(low[:, 0], low[:, 1])[0, 1], 0.98)
        c = float(np.corrcoef(y[:, 0], y[:, 1])[0, 1])
        self.assertTrue(0.3 <= c <= 0.9, c)
        # the hiss at the start sits at 3 to 9 kHz
        self.assertGreater(share(y, 3000, 9000, 0.0, 0.2), 0.8)

    def test_c_dark_but_clear(self):
        y = render("pilot_gear_c")
        self.assertGreaterEqual(share(y, 500, 1500), 0.10)
        self.assertLessEqual(share(y, 3000, 1e5), 0.02)
        i = int(1.55 * synth.SR)
        m = mono(y)
        a = m[i:i + int(0.030 * synth.SR)]
        p = np.abs(np.fft.rfft(a - a.mean())) ** 2
        f = np.fft.rfftfreq(a.size, 1.0 / synth.SR)
        self.assertTrue(0.15 <= p[f >= 1000].sum() / p.sum() <= 0.35)
        b = m[i:i + int(0.300 * synth.SR)]
        p = np.abs(np.fft.rfft(b - b.mean())) ** 2
        f = np.fft.rfftfreq(b.size, 1.0 / synth.SR)
        self.assertGreaterEqual(p[f < 80].sum() / p.sum(), 0.10)


if __name__ == "__main__":
    unittest.main()
