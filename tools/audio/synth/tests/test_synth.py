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


class StructureRulesTest(unittest.TestCase):
    """The energy-distribution rule for structure sounds and the CLAP hint (SOUND_DESIGN.md 2 and 3)."""

    SPEC = {"kind": "oneshot", "path": "structure", "category": "impacts", "duration": 1.0}
    AN = {"sampleRate": 48000, "truePeakDb": -3.0, "clippedSamples": 0, "dcOffset": 0.0,
          "lowShare": 0.95, "highShare": 0.0}

    def _tone(self, f):
        t = np.arange(48000) / 48000.0
        x = np.sin(2 * np.pi * f * t) * 0.3
        x[:200] *= np.linspace(0, 1, 200)
        x[-4000:] *= np.linspace(1, 0, 4000) ** 4
        return x[:, None]

    def test_deep_throb_fails_and_mid_weight_passes(self):
        from synth import rules

        self.assertIn("structure-mid-share", rules.check(self.SPEC, self._tone(40.0), self.AN))
        self.assertIn("structure-sub-share", rules.check(self.SPEC, self._tone(40.0), self.AN))
        self.assertEqual(rules.check(self.SPEC, self._tone(200.0), self.AN), [])

    def test_fold_sounds_are_allowed_more_pressure(self):
        from synth import rules

        mix = 0.4 * self._tone(40.0) + 0.5 * self._tone(200.0)  # about 39 % below 60 Hz
        self.assertEqual(rules.check(self.SPEC, mix, self.AN, sound_id="fold_jump"), [])
        low = 1.0 * self._tone(40.0) + 0.8 * self._tone(200.0)  # about 60 % low
        self.assertEqual(rules.check(self.SPEC, low, self.AN, sound_id="fold_jump"), ["structure-sub-share"])

    def test_clap_margin_is_a_hint_in_the_build(self):
        src = (Path(__file__).resolve().parents[2] / "build.py").read_text(encoding="utf-8")
        self.assertIn('hints.append("clap-margin")', src)
        self.assertNotIn('failed.append("clap-margin")', src)


# --------------------------------------------------------------------------- two channels and energy

AUDIO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AUDIO / "listen"))
import measure  # noqa: E402


class TwoChannelsTest(unittest.TestCase):
    """mid_side, the stereo measurements, shared dither and level setting on the mono sum."""

    def test_mono_sum_is_the_mid_and_side_has_no_bass(self):
        n = 96000
        mid = synth.periodic_noise(n, "pink", "ms/mid", lo=40, hi=800)
        side = synth.periodic_noise(n, "pink", "ms/side", lo=40, hi=800)
        y = synth.mid_side(mid, side, periodic=True, ratio=0.4)
        self.assertEqual(y.shape, (n, 2))
        self.assertTrue(np.allclose(y.mean(axis=1), mid, atol=1e-12))
        s = 0.5 * (y[:, 0] - y[:, 1])
        spec = np.abs(np.fft.rfft(s)) ** 2
        f = np.fft.rfftfreq(n, 1.0 / synth.SR)
        self.assertLess(spec[f < 100].sum() / spec.sum(), 1e-3)
        self.assertAlmostEqual(synth.rms(s) / synth.rms(mid), 0.4, places=6)

    def test_one_shot_side_is_causal(self):
        n = 24000
        mid = np.zeros(n)
        side = np.zeros(n)
        side[1000:1200] = 1.0
        y = synth.mid_side(mid, side, periodic=False)
        self.assertEqual(np.abs(y[:1000]).max(), 0.0)  # no pre-ringing before the onset

    def test_stats_of_identical_and_independent_channels(self):
        n = 96000
        x = synth.periodic_noise(n, "pink", "st/a", lo=40, hi=800)
        same = measure.stereo_stats(np.stack([x, x], axis=1), synth.SR)
        self.assertAlmostEqual(same["corr"], 1.0, places=6)
        self.assertAlmostEqual(same["levelDiffDb"], 0.0, places=6)
        y = synth.periodic_noise(n, "pink", "st/b", lo=40, hi=800)
        indep = measure.stereo_stats(np.stack([x, y], axis=1), synth.SR)
        self.assertLess(abs(indep["corr"]), 0.1)
        self.assertLess(indep["corrLow"], 0.5)

    def test_measured_correlation_follows_the_side_ratio(self):
        n = 96000
        mid = synth.periodic_noise(n, "pink", "cr/mid", lo=40, hi=800)
        side = synth.periodic_noise(n, "pink", "cr/side", lo=40, hi=800)
        y = synth.mid_side(mid, side, ratio=0.5)
        st = measure.stereo_stats(y, synth.SR)
        # power ratio 0.25 gives (1 - 0.25) / (1 + 0.25) = 0.6 for independent signals
        self.assertAlmostEqual(st["corr"], 0.6, delta=0.08)
        self.assertGreater(st["corrLow"], 0.98)

    def test_analyse_measures_the_mono_sum_as_the_sound(self):
        n = 96000
        mid = synth.periodic_noise(n, "pink", "an/mid", lo=100, hi=600)
        hiss = synth.periodic_noise(n, "white", "an/hiss", lo=5000, hi=9000)
        y = np.stack([mid + 0.5 * hiss, mid - 0.5 * hiss], axis=1) * 0.1  # the hiss is all side
        an = measure.analyse(y, synth.SR, loop=True)
        self.assertLess(an["highShare"], 1e-6)  # the mono sum is the mid only
        self.assertIn("stereo", an)

    def test_shared_dither_keeps_the_mono_sum_close_to_the_mono_file(self):
        n = 48000
        mid = 0.05 * synth.periodic_noise(n, "pink", "dd/mid", lo=100, hi=600)
        side = 0.02 * synth.periodic_noise(n, "pink", "dd/side", lo=200, hi=900)
        old = synth.to_int16(mid, "dd").astype(np.float64)
        pair = np.stack([mid + side, mid - side], axis=1)
        st = synth.to_int16(pair, "dd", shared_dither=True).astype(np.float64)
        diff = st.mean(axis=1) - old
        self.assertLess(np.abs(diff).max(), 1.6)  # rounding only
        plain = synth.to_int16(pair, "dd").astype(np.float64)
        self.assertGreater(np.abs(plain.mean(axis=1) - old).mean(), np.abs(diff).mean())

    def test_level_is_set_on_the_mono_sum(self):
        n = 96000
        mid = synth.periodic_noise(n, "pink", "lv/mid", lo=100, hi=600)
        side = synth.periodic_noise(n, "pink", "lv/side", lo=200, hi=900)
        y = synth.mid_side(mid, side, ratio=0.5)
        z, _ = synth.set_level(y, "lufs", -30.0, mono_sum=True)
        self.assertAlmostEqual(synth.lufs(z.mean(axis=1)), -30.0, delta=0.1)
        ref, _ = synth.set_level(mid, "lufs", -30.0)
        self.assertTrue(np.allclose(z.mean(axis=1), ref, atol=1e-9))

    def test_is_mid_side(self):
        self.assertTrue(synth.is_mid_side({"channels": 2, "path": "structure", "kind": "loop"}))
        self.assertTrue(synth.is_mid_side({"channels": 2, "path": "energy", "kind": "oneshot"}))
        self.assertFalse(synth.is_mid_side({"channels": 2, "path": "cabin", "kind": "loop"}))
        self.assertFalse(synth.is_mid_side({"channels": 2, "path": "cabin", "kind": "ir"}))
        self.assertFalse(synth.is_mid_side({"path": "structure", "kind": "loop"}))


class StereoRulesTest(unittest.TestCase):
    SPEC = {"kind": "loop", "path": "structure", "category": "engines", "duration": 2.0, "channels": 2}

    def _loop(self, ratio):
        n = 96000
        mid = synth.periodic_noise(n, "pink", "sr/mid", lo=100, hi=600)
        side = synth.periodic_noise(n, "pink", "sr/side", lo=100, hi=600)
        return 0.1 * synth.mid_side(mid, side, ratio=ratio)

    def _check(self, spec, y):
        from synth import rules

        an = measure.analyse(y, synth.SR, loop=spec["kind"] == "loop")
        return rules.check(spec, y, an, sound_id="x"), an

    def test_good_width_passes_and_no_width_fails(self):
        bad, _ = self._check(self.SPEC, self._loop(0.5))
        self.assertEqual([b for b in bad if b.startswith("stereo")], [])
        bad, _ = self._check(self.SPEC, self._loop(0.0))
        self.assertIn("stereo-correlation", bad)  # identical channels: nothing wide about it

    def test_too_wide_fails(self):
        bad, _ = self._check(self.SPEC, self._loop(1.5))
        self.assertIn("stereo-correlation", bad)

    def test_bass_that_differs_between_the_channels_fails(self):
        n = 96000
        low = 0.1 * synth.periodic_noise(n, "pink", "sr/low", lo=40, hi=120)
        mid = synth.periodic_noise(n, "pink", "sr/mid2", lo=100, hi=600)
        y = 0.1 * np.stack([mid, mid], axis=1) + np.stack([low, -low], axis=1)  # bass in antiphase
        bad, _ = self._check(self.SPEC, y)
        self.assertIn("stereo-bass-correlation", bad)

    def test_levels_of_left_and_right_must_match(self):
        y = self._loop(0.5)
        y[:, 1] *= 0.6  # about 4.4 dB quieter
        bad, _ = self._check(self.SPEC, y)
        self.assertIn("stereo-level-diff", bad)

    def test_the_mono_sum_is_held_to_the_path_rules(self):
        n = 96000
        mid = synth.periodic_noise(n, "white", "sr/hi", lo=5000, hi=9000)  # not a structure sound
        side = synth.periodic_noise(n, "pink", "sr/s", lo=300, hi=900)
        y = 0.1 * synth.mid_side(mid, side, ratio=0.5)
        bad, _ = self._check(self.SPEC, y)
        self.assertIn("structure-high-share", bad)

    def test_the_stereo_rules_do_not_apply_to_the_cabin(self):
        from synth import rules

        y = self._loop(0.0)
        cabin = dict(self.SPEC, path="cabin", category="cabin")
        an = measure.analyse(y, synth.SR, loop=True)
        self.assertEqual([b for b in rules.check(cabin, y, an) if b.startswith("stereo")], [])


class EnergyRulesTest(unittest.TestCase):
    SPEC = {"kind": "oneshot", "path": "energy", "category": "impacts", "duration": 1.0, "channels": 2}

    def _burst(self, tone_hz=None):
        n = 48000
        rng = synth.seeded("er/burst")
        env = synth.burst_env(n, 3.0, 0.3)
        hiss = synth.highpass(rng.standard_normal(n), 1000.0, 2) * env
        weight = synth.lowpass(rng.standard_normal(n), 200.0, 4) * env * 6.0
        mid = hiss + weight
        if tone_hz:
            mid = mid + 20.0 * np.sin(2 * np.pi * tone_hz * np.arange(n) / synth.SR) * env
        side = synth.highpass(rng.standard_normal(n), 800.0, 2) * env
        y = synth.fade_edges(synth.mid_side(mid, side, periodic=False, ratio=0.4), 0.0, 50.0)
        return 0.5 * y / np.abs(y).max()

    def _check(self, y):
        from synth import rules

        an = measure.analyse(y, synth.SR)
        return rules.check(self.SPEC, y, an, sound_id="x")

    def test_a_hissing_burst_with_weight_passes_the_energy_rules(self):
        bad = self._check(self._burst())
        self.assertEqual([b for b in bad if b.startswith("energy")], [])

    def test_a_dull_blow_fails(self):
        n = 48000
        env = synth.burst_env(n, 3.0, 0.3)
        low = synth.lowpass(synth.seeded("er/dull").standard_normal(n), 300.0, 4) * env
        y = synth.fade_edges(0.1 * np.stack([low, low], axis=1), 0.0, 50.0)
        bad = self._check(y)
        self.assertIn("energy-high-share", bad)
        self.assertIn("energy-air-share", bad)

    def test_a_standing_pitch_fails(self):
        bad = self._check(self._burst(tone_hz=2000.0))
        self.assertIn("energy-peak", bad)

    def test_no_weight_fails(self):
        n = 48000
        env = synth.burst_env(n, 3.0, 0.3)
        hiss = synth.highpass(synth.seeded("er/air").standard_normal(n), 2000.0, 4) * env
        y = synth.fade_edges(0.1 * np.stack([hiss, hiss], axis=1), 0.0, 50.0)
        self.assertIn("energy-weight", self._check(y))


class BuildManifestTest(unittest.TestCase):
    def test_hash_place_and_channels_come_into_the_manifest(self):
        import tempfile

        import build
        import common
        from synth import cat_thrusters  # noqa: F401  (registers thruster_pulse_a, which has a place)

        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            e = build.build_sound("thruster_pulse_a", out, None, None, measure, common)
            spec = synth.load_spec()["sounds"]["thruster_pulse_a"]
            self.assertEqual(e["place"], spec["place"])
            self.assertEqual(e["channels"], 1)
            self.assertEqual(len(e["hash"]), 12)
            self.assertEqual(e["hash"], build.file_hash(out / "thrusters" / "thruster_pulse_a.wav"))
            self.assertIn("peakShare", e["checks"])

    def test_old_json_without_hash_is_completed_when_assembling(self):
        import json
        import tempfile

        import build
        import common

        spec = synth.load_spec()["sounds"]["cruise_charge"]  # has a cue and a place
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / "drive").mkdir()
            synth.write_wav(out / "drive" / "cruise_charge.wav", np.zeros(4800), "t")
            rec = {"manifest": {"id": "cruise_charge", "category": spec["category"]}}
            (out / "drive" / "cruise_charge.json").write_text(json.dumps(rec), encoding="utf-8")
            m = build.assemble_manifest(out, measure, common)
            s = m["sounds"][0]
            self.assertEqual(s["cue"], spec["cue"])
            self.assertEqual(s["place"], spec["place"])
            self.assertEqual(len(s["hash"]), 12)
