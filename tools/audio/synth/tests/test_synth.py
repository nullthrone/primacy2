"""Run: .venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/synth/tests -t tools/audio"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import synth  # noqa: E402
from synth import cat_cabin, cat_engines  # noqa: E402,F401  (importing registers them)


class DeterminismTest(unittest.TestCase):
    def test_two_renders_give_the_same_bytes(self):
        for sid in ("engine_main_t050", "cabin_ir", "silent_running_loop"):
            a = synth.to_int16(synth.render(sid)[0], sid).tobytes()
            b = synth.to_int16(synth.render(sid)[0], sid).tobytes()
            self.assertEqual(a, b, sid)


class PeriodicNoiseTest(unittest.TestCase):
    def test_no_seam(self):
        n = 96000
        for color in ("white", "pink", "brown"):
            x = synth.periodic_noise(n, color, "t", lo=30, hi=900)
            tiled = np.concatenate([x, x])
            seam = np.abs(np.diff(tiled))[n - 1]  # the step across the join
            ordinary = np.percentile(np.abs(np.diff(x)), 99)
            self.assertLessEqual(seam, ordinary * 1.5, color)
            self.assertAlmostEqual(synth.rms(x), 1.0, places=6)

    def test_same_phases_whatever_the_band(self):
        a = synth.periodic_noise(48000, "pink", "same", lo=20, hi=2000)
        b = synth.periodic_noise(48000, "pink", "same", lo=20, hi=800)
        self.assertGreater(np.corrcoef(a, b)[0, 1], 0.8)

    def test_filters_and_hull_keep_a_loop_periodic(self):
        n = 48000
        x = synth.periodic_noise(n, "white", "p")
        y = synth.structure_lowpass(synth.through_hull(x, periodic=True), periodic=True)
        shifted = np.roll(y, 1)
        self.assertLess(np.abs(y[0] - shifted[0]), 5 * np.percentile(np.abs(np.diff(y)), 99))


class LevelTest(unittest.TestCase):
    def test_loudness_target(self):
        x = synth.periodic_noise(96000, "pink", "lvl", lo=40, hi=800)
        y, info = synth.set_level(x, "lufs", -30.0)
        self.assertAlmostEqual(synth.lufs(y), -30.0, delta=0.1)
        self.assertFalse(info["limited"])

    def test_peak_target(self):
        x = np.sin(np.linspace(0, 200, 48000)) * 0.1
        y, _ = synth.set_level(x, "peak", -12.0)
        self.assertAlmostEqual(synth.true_peak_db(y), -12.0, delta=0.05)

    def test_ceiling_is_kept(self):
        x = synth.periodic_noise(96000, "white", "loud", lo=40, hi=800)
        y, info = synth.set_level(x, "lufs", -3.0)
        self.assertLessEqual(synth.true_peak_db(y), synth.CEILING_DB + 0.01)
        self.assertTrue(info["limited"])

    def test_every_rendered_sound_is_under_the_ceiling(self):
        for sid in sorted(synth.REGISTRY):
            x, _ = synth.render(sid)
            pcm = synth.to_int16(x, sid).astype(np.float64) / 32768.0
            self.assertLessEqual(synth.true_peak_db(pcm), -1.0, sid)


class RegistryTest(unittest.TestCase):
    def test_refuses_unknown_id(self):
        with self.assertRaises(synth.UnknownSoundError):
            synth.register("no_such_sound")

    def test_refuses_second_renderer(self):
        with self.assertRaises(ValueError):
            synth.register("cabin_ir")(lambda ctx: None)

    def test_shape_is_checked(self):
        entry = synth.REGISTRY["button_press"] if "button_press" in synth.REGISTRY else None
        if entry is None:
            sid = "relay_click_a"
            synth.register(sid)(lambda ctx: np.zeros(5))
            try:
                with self.assertRaises(ValueError):
                    synth.render_dry(sid)
            finally:
                del synth.REGISTRY[sid]


class CabinTest(unittest.TestCase):
    def test_ir_shape(self):
        ir = synth.cabin_ir()
        self.assertEqual(ir.shape, (24000, 2))
        self.assertEqual(ir[0, 0], 1.0)
        early = np.abs(ir[int(0.003 * 48000): int(0.012 * 48000)]).max()
        self.assertGreater(early, 0.1)  # first reflections between 3 and 12 ms
        self.assertLess(np.abs(ir[-480:]).max(), 1e-3)
        self.assertLess(abs(np.corrcoef(ir[:, 0], ir[:, 1])[0, 1]), 0.5)  # decorrelated ears

    def test_apply_cabin_periodic_keeps_loop(self):
        x = synth.periodic_noise(48000, "pink", "c", lo=100, hi=2000)
        y = synth.apply_cabin(x, periodic=True)
        self.assertEqual(y.shape, (48000, 2))
        self.assertLess(abs(y[0, 0] - y[-1, 0]), 5 * np.percentile(np.abs(np.diff(y[:, 0])), 99))


if __name__ == "__main__":
    unittest.main()


class HelpersSmokeTest(unittest.TestCase):
    """The helpers other categories build on must at least run and behave."""

    def test_hull_blow_starts_soft_and_ends_silent(self):
        n = 48000
        y = synth.hull_blow(n, 0.8, "blow")
        self.assertEqual(y.shape, (n,))
        self.assertLess(abs(y[0]), 0.01 * np.abs(y).max())
        self.assertLess(np.abs(y[-480:]).max(), 1e-6 + 1e-3 * np.abs(y).max())
        self.assertLess(synth.rattles(n, 0.0, "r", periodic=False).std(), 1e-12)

    def test_transformer_and_machine_tone_are_periodic(self):
        n = 96000
        for y in (synth.transformer_tone(n, 100.0, 0.7, "t"), synth.machine_tone(n, 50.0, rng="m")):
            self.assertLess(abs(y[0] - np.roll(y, 1)[0]), 5 * np.percentile(np.abs(np.diff(y)), 99))
            self.assertLess(abs(y.mean()), 0.05)
