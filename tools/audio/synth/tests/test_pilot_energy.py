"""Run: .venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/synth/tests -t tools/audio

Checks the direction samples of the energy family (cat_pilot_energy): deterministic, the right
shape, finite, and the key targets of each brief, computed on the mono sum of the dry render
(shares are of the whole file, a plain FFT of the mono sum).
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import synth  # noqa: E402
from synth import cat_pilot_energy  # noqa: E402,F401  (importing registers the sounds)

IDS = ("pilot_thruster_a", "pilot_thruster_b", "pilot_thruster_c", "pilot_shield_a", "pilot_shield_b")
SR = synth.SR


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


def share(x, lo, hi):
    m = mono(x)
    m = m - m.mean()
    p = np.abs(np.fft.rfft(m)) ** 2
    f = np.fft.rfftfreq(m.size, 1.0 / SR)
    return float(p[(f >= lo) & (f < hi)].sum() / p.sum())


def band_env_db(x, lo, hi, frame_ms=20.0):
    """RMS envelope in dB of the band lo to hi Hz (causal Butterworth), frame_ms frames."""
    from scipy.signal import butter, sosfilt

    sos = butter(4, [lo, hi], "band", fs=SR, output="sos")
    y = sosfilt(sos, mono(x))
    m = int(frame_ms * SR / 1000.0)
    k = y.size // m
    return 20.0 * np.log10(np.sqrt((y[: k * m].reshape(k, m) ** 2).mean(axis=1)) + 1e-12)


def attack_window(x, ms=30.0):
    m = mono(x)
    on = int(np.argmax(np.abs(m) > np.abs(m).max() * 10 ** (-40 / 20)))
    return m[on:on + int(ms * SR / 1000.0)]


class RenderTest(unittest.TestCase):
    def test_deterministic_shape_finite(self):
        spec = synth.load_spec()["sounds"]
        for sid in IDS:
            a = synth.render_dry(sid)           # render_dry already checks shape and finiteness
            b = synth.render_dry(sid)
            self.assertTrue(np.array_equal(a, b), sid)
            ch = int(spec[sid].get("channels", 1))
            self.assertEqual(a.shape, (round(spec[sid]["duration"] * SR),) if ch == 1 else
                             (round(spec[sid]["duration"] * SR), 2), sid)
            self.assertTrue(np.all(np.isfinite(a)), sid)
            self.assertGreater(float(np.max(np.abs(a))), 0.0, sid)

    def test_levelled_render_meets_the_general_rules(self):
        for sid in IDS:
            y, info = synth.render(sid)
            self.assertLessEqual(synth.true_peak_db(y), -1.0 + 1e-6, sid)
            self.assertLess(abs(float(np.mean(y))), 0.001, sid)
            m = np.abs(y if y.ndim == 1 else y.max(axis=1))
            self.assertLess(int(np.argmax(m > m.max() * 10 ** (-40 / 20))), int(0.005 * SR), sid)
            self.assertLess(float(m[-int(0.010 * SR):].max()), 10 ** (-60 / 20), sid)

    def test_family_loudness_is_matched(self):
        for family in (IDS[:3], IDS[3:]):
            lufs = [synth.lufs(mono(synth.render(s)[0])) for s in family]
            self.assertLess(max(lufs) - min(lufs), 2.0, family)


class ThrusterTest(unittest.TestCase):
    def test_gas_jet(self):
        x = synth.render_dry("pilot_thruster_a")
        self.assertGreaterEqual(share(x, 1000, 1e5), 0.55)
        self.assertGreaterEqual(share(x, 4000, 1e5), 0.15)
        self.assertTrue(0.10 <= share(x, 0, 250) <= 0.25, share(x, 0, 250))

    def test_cinema_punch(self):
        x = synth.render_dry("pilot_thruster_b")
        a = attack_window(x)
        p = np.abs(np.fft.rfft(a)) ** 2
        f = np.fft.rfftfreq(a.size, 1.0 / SR)
        self.assertGreaterEqual(float((f * p).sum() / p.sum()), 2000.0)
        self.assertTrue(0.40 <= share(x, 0, 500) <= 0.60, share(x, 0, 500))
        self.assertGreaterEqual(share(x, 1000, 1e5), 0.25)

    def test_valve_and_thump(self):
        x = synth.render_dry("pilot_thruster_c")
        a = attack_window(x)
        p = np.abs(np.fft.rfft(a)) ** 2
        f = np.fft.rfftfreq(a.size, 1.0 / SR)
        self.assertGreaterEqual(float(p[f >= 1000].sum() / p.sum()), 0.50)
        self.assertGreaterEqual(share(x, 0, 250), 0.60)
        self.assertLessEqual(share(x[int(0.015 * SR):], 1000, 1e5), 0.10)


class ShieldTest(unittest.TestCase):
    def test_bass_throb(self):
        x = synth.render_dry("pilot_shield_a")
        self.assertGreaterEqual(share(x, 0, 250), 0.30)
        self.assertGreaterEqual(share(x, 250, 2000), 0.15)
        self.assertGreaterEqual(share(x, 2000, 1e5), 0.15)
        env = band_env_db(x, 20, 125)                      # 20 ms frames
        within = env >= env.max() - 12.0
        run = 0
        while run < within.size and within[run]:
            run += 1
        self.assertGreaterEqual(run * 0.020, 0.4)          # contiguous, from the start
        # the bass is the same in both ears
        from scipy.signal import butter, sosfilt

        sos = butter(4, 150, "low", fs=SR, output="sos")
        lo = sosfilt(sos, x, axis=0)
        self.assertGreater(float(np.corrcoef(lo[:, 0], lo[:, 1])[0, 1]), 0.98)

    def test_cinema_whoomp(self):
        x = synth.render_dry("pilot_shield_b")
        self.assertGreaterEqual(share(x, 0, 250), 0.40)
        self.assertLessEqual(share(x, 8000, 1e5), 0.05)
        self.assertGreaterEqual(share(x, 250, 2000), 0.15)
        env = band_env_db(x, 20, 125, frame_ms=10.0)
        self.assertLessEqual(int(np.argmax(env)) * 0.010, 0.060)


class StereoTest(unittest.TestCase):
    def test_correlation_and_balance(self):
        for sid in ("pilot_shield_a", "pilot_shield_b"):
            y = synth.render(sid)[0]
            c = float(np.corrcoef(y[:, 0], y[:, 1])[0, 1])
            self.assertTrue(0.3 <= c <= 0.9, (sid, c))
            d = abs(20 * np.log10(y[:, 0].std() / y[:, 1].std()))
            self.assertLess(d, 1.5, sid)


if __name__ == "__main__":
    unittest.main()
