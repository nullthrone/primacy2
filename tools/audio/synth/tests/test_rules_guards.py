"""Guards for rules.py and levels.py: for every all-sounds rule and every category rule one signal that
must fail it and one that must pass it, fed to rules.check as measure.analyse reads it.

Run: .venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/synth/tests

Every signal has a right answer by construction (a tone at a known level, a known cut, a known
share), and the limits are written here as numbers taken from SOUND_DESIGN.md section 2 (-1 dBFS true
peak, DC 0.001, onset 5 ms, tail -60 dB in 10 ms, correlation 0.3 to 0.9, bass correlation 0.98,
level difference 1.5 dB, ...), so a rule that is switched off or loosened is seen, and a changed
number in rules.py has to be changed here on purpose.
"""
import sys
import unittest
from pathlib import Path

import numpy as np

AUDIO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AUDIO))
sys.path.insert(0, str(AUDIO / "listen"))
import measure  # noqa: E402
import synth  # noqa: E402
from synth import levels, rules  # noqa: E402

SR = 48000


def tone(f, amp=0.3, seconds=1.0):
    t = np.arange(int(round(seconds * SR))) / SR
    return amp * np.sin(2 * np.pi * f * t)


def shape_oneshot(x, fade_ms=50.0):
    """A one-shot that starts at once and ends in silence: a fade, and the last 15 ms are zero."""
    x = np.array(x, dtype=np.float64)
    k = int(fade_ms / 1000 * SR)
    x[-k:] *= np.linspace(1, 0, k)
    x[-int(0.015 * SR):] = 0.0
    return x[:, None]


def col(x):
    return np.asarray(x, dtype=np.float64)[:, None]


def spec(**kw):
    d = {"kind": "oneshot", "path": "pilot", "category": "pilot", "duration": 1.0, "channels": 1}
    d.update(kw)
    return d


def check(x, sp, swing_max=None, level=None):
    an = measure.analyse(x, SR, loop=sp["kind"] == "loop")
    extra = {} if level is None else {"level": level}
    return rules.check(sp, x, an, swing_max, sound_id="x", **extra), an


GOOD = shape_oneshot(tone(1000, 0.3))


class AllSoundsRules(unittest.TestCase):
    def test_a_plain_sound_passes_every_rule(self):
        self.assertEqual(check(GOOD, spec())[0], [])

    def test_sample_rate(self):
        an = measure.analyse(GOOD, 44100)
        self.assertIn("sample-rate", rules.check(spec(), GOOD, an, sound_id="x"))
        self.assertNotIn("sample-rate", check(GOOD, spec())[0])

    def test_channels(self):
        self.assertIn("channels", check(GOOD, spec(channels=2))[0])                 # mono file, two channels listed
        both = np.concatenate([GOOD, GOOD], axis=1)
        self.assertIn("channels", check(both, spec(channels=1))[0])                  # two-channel file, one listed
        self.assertNotIn("channels", check(GOOD, spec(channels=1))[0])
        self.assertNotIn("channels", check(both, spec(channels=2, path="cabin", category="cabin"))[0])

    def test_true_peak_limit_is_minus_one_dbfs(self):
        for db, fails in ((-0.5, True), (-0.8, True), (-1.3, False), (-3.0, False)):
            x = shape_oneshot(tone(1000, 10 ** (db / 20)))
            self.assertEqual("true-peak" in check(x, spec())[0], fails, db)

    def test_true_peak_rule_sees_a_peak_between_the_samples(self):
        # fs/4 at 45 degrees: samples at -3.01 dBFS, real peak 0 dBFS
        t = np.arange(SR) / SR
        x = np.sin(2 * np.pi * (SR / 4) * t + np.pi / 4)
        x[-int(0.05 * SR):] *= np.linspace(1, 0, int(0.05 * SR))
        x[-int(0.015 * SR):] = 0.0
        x[:int(0.05 * SR)] *= np.linspace(0, 1, int(0.05 * SR))
        bad, an = check(col(x), spec())
        self.assertLess(an["samplePeakDb"], -2.5)
        self.assertIn("true-peak", bad)

    def test_clipped(self):
        clipped = shape_oneshot(np.clip(tone(1000, 1.5), -1.0, 1.0))
        self.assertIn("clipped", check(clipped, spec())[0])
        self.assertNotIn("clipped", check(shape_oneshot(tone(1000, 0.9)), spec())[0])

    def test_dc_offset_limit_is_0_001(self):
        for dc, fails in ((0.01, True), (-0.01, True), (0.0015, True), (0.0007, False), (0.0, False)):
            x = shape_oneshot(tone(1000, 0.3)) + dc
            x[-int(0.015 * SR):] = dc  # the tail stays quiet around the offset
            bad, an = check(x, spec())
            self.assertEqual("dc-offset" in bad, fails, (dc, an["dcOffset"]))

    def test_onset_must_come_within_5_ms(self):
        for lead_ms, fails in ((20.0, True), (8.0, True), (3.0, False), (0.0, False)):
            x = np.concatenate([np.zeros((int(lead_ms / 1000 * SR), 1)), shape_oneshot(tone(1000, 0.3, 0.5))])
            self.assertEqual("onset-late" in check(x, spec())[0], fails, lead_ms)

    def test_onset_rule_applies_to_an_impulse_response_too(self):
        late = np.concatenate([np.zeros((int(0.02 * SR), 1)), shape_oneshot(tone(1000, 0.3, 0.5))])
        self.assertIn("onset-late", check(late, spec(kind="ir", category="cabin", path="cabin"))[0])

    def test_the_tail_must_be_silent(self):
        self.assertIn("tail-not-silent", check(col(tone(1000, 0.3)), spec())[0])       # cut off while loud
        self.assertNotIn("tail-not-silent", check(shape_oneshot(tone(1000, 0.3)), spec())[0])
        loud_tail = shape_oneshot(tone(1000, 0.3))
        loud_tail[-int(0.008 * SR), 0] = 10 ** (-50 / 20)  # one sample at -50 dBFS inside the last 10 ms
        self.assertIn("tail-not-silent", check(loud_tail, spec())[0])
        near = shape_oneshot(tone(1000, 0.3))
        near[-int(0.008 * SR), 0] = 10 ** (-70 / 20)       # -70 dBFS: under the -60 dB limit
        self.assertNotIn("tail-not-silent", check(near, spec())[0])

    def test_a_loop_does_not_have_to_end_in_silence_or_start_at_once(self):
        loop = col(tone(1000, 0.3, 0.25))  # 250 whole periods
        bad, _ = check(loop, spec(kind="loop", duration=0.25))
        self.assertNotIn("tail-not-silent", bad)
        self.assertNotIn("onset-late", bad)

    def test_loop_seam(self):
        whole = col(tone(1000, 0.3, 0.25))
        self.assertNotIn("loop-seam", check(whole, spec(kind="loop", duration=0.25))[0])
        cut = col(tone(1000, 0.3, 0.2503))  # ends a quarter period late: a step across the wrap
        self.assertIn("loop-seam", check(cut, spec(kind="loop", duration=0.25))[0])

    def test_loop_level_swing_limit_is_6_db_unless_the_sound_has_its_own(self):
        n = 2 * SR
        t = np.arange(n) / SR
        swung = col(np.random.default_rng(7).standard_normal(n) * 0.1 * (0.5 + 0.45 * np.sin(2 * np.pi * 1.0 * t)))
        sp = spec(kind="loop", duration=2.0)
        bad, an = check(swung, sp)
        self.assertEqual(an["loop"]["levelSwingDb"], 24.4)
        self.assertIn("loop-level-swing", bad)
        self.assertNotIn("loop-level-swing", check(swung, sp, swing_max=40.0)[0])
        self.assertIn("loop-level-swing", check(swung, sp, swing_max=20.0)[0])
        steady = col(np.random.default_rng(1).standard_normal(n) * 0.1)
        self.assertNotIn("loop-level-swing", check(steady, sp)[0])

    def test_a_loop_that_falls_silent_fails_the_swing_rule_at_every_finite_limit_and_passes_only_as_gapped(self):
        k = int(0.005 * SR)
        a = np.random.default_rng(7).standard_normal(SR // 2) * 0.1
        a[:k] *= np.linspace(0, 1, k)
        a[-k:] *= np.linspace(1, 0, k)
        gap = col(np.concatenate([a, np.zeros(SR), a]))
        sp = spec(kind="loop", duration=2.0)
        bad, an = check(gap, sp)
        self.assertGreater(an["loop"]["levelSwingDb"], 90.0)
        self.assertIn("loop-level-swing", bad)
        self.assertIn("loop-level-swing", check(gap, sp, swing_max=80.0)[0])
        # a loop that is sounds and gaps by design is registered as GAPPED: the swing rule is off, the others stay
        self.assertNotIn("loop-level-swing", check(gap, sp, swing_max=synth.GAPPED)[0])
        self.assertIn("loop-seam", check(col(tone(1000, 0.3, 0.2503)), spec(kind="loop", duration=0.25), swing_max=synth.GAPPED)[0])

    def test_only_the_four_alarm_loops_are_gapped_and_no_other_loop_has_a_limit_a_gap_could_pass(self):
        synth.load_categories()
        gapped = sorted(i for i, e in synth.REGISTRY.items() if e.swing_max == synth.GAPPED)
        self.assertEqual(gapped, ["alarm_fuel_low", "alarm_heat", "alarm_hull_critical", "alarm_missile"])
        sounds = synth.load_spec()["sounds"]
        self.assertTrue(all(sounds[i]["kind"] == "loop" for i in gapped))
        # every other limit is one a loop with a silent window (swing over 70 dB) fails
        others = {i: e.swing_max for i, e in synth.REGISTRY.items() if e.swing_max is not None and i not in gapped}
        self.assertTrue(all(v <= 12.0 for v in others.values()), others)


class SilentSounds(unittest.TestCase):
    """R4: a silent render fails on every path, kind and category (it passed all of them but the band rules)."""

    @staticmethod
    def _dither(seconds, seed=1):
        # the 16-bit file of a silent render: +-1 LSB of dither
        return col(np.random.default_rng(seed).integers(-1, 2, int(seconds * SR)) / 32768.0)

    def test_dither_only_fails_for_every_path_kind_and_category(self):
        cats = ("cabin", "engines", "impacts", "alarms", "sensors", "radio", "switches", "pilot")
        for path in ("structure", "energy", "cabin", "pilot", "sensor", "radio"):
            for kind in ("oneshot", "loop", "ir"):
                for cat in cats:
                    sp = spec(kind=kind, path=path, category=cat, duration=1.0)
                    bad, _ = check(self._dither(1.0), sp)
                    self.assertIn("silent", bad, (path, kind, cat))

    def test_exact_zeros_and_two_channels_fail_too(self):
        self.assertIn("silent", check(np.zeros((SR, 1)), spec())[0])
        self.assertIn("silent", check(np.zeros((SR, 2)), spec(channels=2, path="structure", category="engines"))[0])

    def test_an_empty_file_fails_without_a_crash(self):
        an = {"sampleRate": SR}
        self.assertEqual(rules.check(spec(), np.zeros((0, 1)), an, sound_id="x"), ["silent"])

    def test_a_quiet_sound_is_not_silent(self):
        # the quietest sound of the library peaks at -44 dBFS; -60 dBFS is far above the dither
        for db in (-44.0, -60.0, -70.0):
            x = shape_oneshot(tone(1000, 10 ** (db / 20)))
            self.assertNotIn("silent", check(x, spec())[0], db)
        self.assertIn("silent", check(shape_oneshot(tone(1000, 10 ** (-85 / 20))), spec())[0])


class StructurePathRules(unittest.TestCase):
    SP = spec(path="structure", category="impacts")

    def two(self, *pairs):
        return shape_oneshot(sum(tone(f, a) for f, a in pairs))

    def test_a_good_structure_sound_passes(self):
        self.assertEqual(check(self.two((300, 0.3)), self.SP)[0], [])

    def test_low_share_limit_is_85_per_cent_below_500_hz(self):
        bad, an = check(self.two((300, 0.3), (800, 0.2)), self.SP)  # power 0.09 : 0.04 -> 69 % low
        self.assertLess(an["lowShare"], 0.85)
        self.assertIn("structure-low-share", bad)
        ok, an = check(self.two((300, 0.3), (800, 0.08)), self.SP)  # 0.09 : 0.0064 -> 93 % low
        self.assertGreater(an["lowShare"], 0.85)
        self.assertNotIn("structure-low-share", ok)

    def test_high_share_limit_is_2_per_cent_above_4_khz(self):
        self.assertIn("structure-high-share", check(self.two((300, 0.3), (5000, 0.07)), self.SP)[0])   # 5 %
        self.assertNotIn("structure-high-share", check(self.two((300, 0.3), (5000, 0.02)), self.SP)[0])  # 0.4 %

    def test_mid_share_must_reach_35_per_cent_between_125_and_1000_hz(self):
        self.assertIn("structure-mid-share", check(self.two((100, 0.3), (300, 0.14)), self.SP)[0])    # 18 %
        self.assertNotIn("structure-mid-share", check(self.two((100, 0.3), (300, 0.3)), self.SP)[0])  # 50 %

    def test_sub_share_must_stay_under_25_per_cent_below_60_hz(self):
        bad = check(self.two((40, 0.3), (300, 0.3)), self.SP)[0]        # 50 % under 60 Hz
        self.assertIn("structure-sub-share", bad)
        self.assertNotIn("structure-sub-share", check(self.two((40, 0.1), (300, 0.3)), self.SP)[0])  # 10 %

    def test_pressure_sounds_have_their_own_limits(self):
        x = self.two((40, 0.12), (200, 0.15))  # 39 % under 60 Hz, 61 % mid: over 25 %, under 40 %
        bad, an = check(x, self.SP)
        self.assertIn("structure-sub-share", bad)
        self.assertEqual(rules.check(self.SP, x, an, sound_id="fold_jump"), [])
        y = self.two((40, 0.15), (200, 0.1))   # 69 % under 60 Hz: over even the pressure limit of 40 %
        self.assertIn("structure-sub-share", rules.check(self.SP, y, measure.analyse(y, SR), sound_id="fold_jump"))


class EnergyPathRules(unittest.TestCase):
    SP = spec(path="energy", category="impacts")

    def test_peak_share_limit_is_15_per_cent(self):
        hiss = np.random.default_rng(3).standard_normal(SR) * 0.1
        x = shape_oneshot(hiss + tone(2000, 0.1))   # the tone holds about a third of the energy
        bad, an = check(x, self.SP)
        self.assertTrue(0.2 < an["peakShare"] < 0.8, an["peakShare"])
        self.assertIn("energy-peak", bad)
        self.assertNotIn("energy-peak", check(shape_oneshot(hiss), self.SP)[0])

    def test_high_air_and_weight_shares(self):
        rng = np.random.default_rng(5)
        n = SR
        low = shape_oneshot(synth.lowpass(rng.standard_normal(n), 300.0, 4) * 0.2)   # nothing above 1 kHz
        bad = check(low, self.SP)[0]
        self.assertIn("energy-high-share", bad)
        self.assertIn("energy-air-share", bad)
        hiss = shape_oneshot(synth.highpass(rng.standard_normal(n), 2000.0, 4) * 0.2)  # nothing below 250 Hz
        bad = check(hiss, self.SP)[0]
        self.assertIn("energy-weight", bad)
        self.assertNotIn("energy-high-share", bad)
        both = shape_oneshot(synth.highpass(rng.standard_normal(n), 1000.0, 2) * 0.1
                             + synth.lowpass(rng.standard_normal(n), 200.0, 4) * 0.4)
        bad = check(both, self.SP)[0]
        for name in ("energy-high-share", "energy-air-share", "energy-weight"):
            self.assertNotIn(name, bad, bad)


class StereoPathRules(unittest.TestCase):
    SP = spec(kind="loop", path="structure", category="engines", duration=2.0, channels=2)

    def _loop(self, ratio):
        n = 96000
        mid = synth.periodic_noise(n, "pink", "g/mid", lo=100, hi=600)
        side = synth.periodic_noise(n, "pink", "g/side", lo=100, hi=600)
        return 0.1 * synth.mid_side(mid, side, ratio=ratio)

    def test_a_good_width_passes_every_stereo_rule(self):
        bad, an = check(self._loop(0.5), self.SP)
        self.assertEqual([b for b in bad if b.startswith("stereo")], [], an["stereo"])

    def test_correlation_must_lie_between_0_3_and_0_9(self):
        too_narrow = check(self._loop(0.16), self.SP)       # (1 - r^2) / (1 + r^2) = 0.95
        self.assertGreater(too_narrow[1]["stereo"]["corr"], 0.9)
        self.assertIn("stereo-correlation", too_narrow[0])
        too_wide = check(self._loop(1.5), self.SP)          # 0.38 under the lower limit
        self.assertLess(too_wide[1]["stereo"]["corr"], 0.3)
        self.assertIn("stereo-correlation", too_wide[0])

    def test_bass_correlation_must_reach_0_98(self):
        n = 96000
        common_bass = synth.periodic_noise(n, "pink", "g/b0", lo=40, hi=120)
        lb = synth.periodic_noise(n, "pink", "g/b1", lo=40, hi=120)
        rb = synth.periodic_noise(n, "pink", "g/b2", lo=40, hi=120)
        mid = synth.periodic_noise(n, "pink", "g/m", lo=200, hi=600)
        y = 0.1 * np.stack([mid + common_bass + 0.7 * lb, mid + common_bass + 0.7 * rb], axis=1)
        bad, an = check(y, self.SP)
        self.assertTrue(0.5 < an["stereo"]["corrLow"] < 0.95, an["stereo"]["corrLow"])
        self.assertIn("stereo-bass-correlation", bad)

    def test_level_difference_must_stay_under_1_5_db(self):
        y = self._loop(0.5)
        y[:, 1] *= 10 ** (-1.0 / 20)   # 1 dB: inside the limit
        self.assertNotIn("stereo-level-diff", check(y, self.SP)[0])
        y[:, 1] *= 10 ** (-1.0 / 20)   # 2 dB
        self.assertIn("stereo-level-diff", check(y, self.SP)[0])

    def test_a_hard_panned_file_fails_all_three_stereo_rules(self):
        """R2: the silent side used to read as 'identical and equally loud'."""
        y = self._loop(0.5)
        y[:, 1] = 0.0
        bad, an = check(y, self.SP)
        for name in ("stereo-correlation", "stereo-bass-correlation", "stereo-level-diff"):
            self.assertIn(name, bad, (bad, an["stereo"]))

    def test_the_stereo_rules_do_not_apply_to_the_cabin_or_to_an_ir(self):
        y = self._loop(0.0)
        for sp in (dict(self.SP, path="cabin", category="cabin"), dict(self.SP, kind="ir", category="cabin", path="structure")):
            bad = check(y, sp)[0]
            self.assertEqual([b for b in bad if b.startswith("stereo")], [], sp)

    def test_the_energy_path_has_the_stereo_rules_too(self):
        n = SR
        hiss = shape_oneshot(synth.highpass(np.random.default_rng(4).standard_normal(n), 1000.0, 2) * 0.2)
        same = np.concatenate([hiss, hiss], axis=1)   # identical channels: correlation 1.0
        sp = spec(path="energy", category="impacts", channels=2)
        self.assertIn("stereo-correlation", check(same, sp)[0])
        self.assertNotIn("stereo-correlation", check(hiss, spec(path="energy", category="impacts"))[0])

    def test_a_one_channel_sound_has_no_stereo_rules(self):
        bad = check(GOOD, spec(path="structure", category="impacts"))[0]
        self.assertEqual([b for b in bad if b.startswith("stereo")], [])


class CategoryRules(unittest.TestCase):
    def test_switch_must_not_be_longer_than_its_listed_duration(self):
        sp = spec(category="switches", duration=0.15)
        self.assertIn("switch-too-long", check(shape_oneshot(tone(1500, 0.3, 0.3), 20), sp)[0])
        self.assertNotIn("switch-too-long", check(shape_oneshot(tone(1500, 0.3, 0.15), 20), sp)[0])

    def test_switch_centroid_must_lie_between_800_hz_and_5_khz(self):
        sp = spec(category="switches", duration=0.15)
        for f, fails in ((200, True), (400, True), (1500, False), (3000, False), (6500, True)):
            self.assertEqual("switch-centroid" in check(shape_oneshot(tone(f, 0.3, 0.15), 20), sp)[0], fails, f)

    def test_alarm_fundamental_must_lie_between_400_and_1600_hz(self):
        sp = spec(kind="loop", category="alarms", duration=1.0)
        for f, fails in ((200, True), (300, True), (900, False), (1400, False), (2500, True)):
            self.assertEqual("alarm-fundamental" in check(col(tone(f, 0.3)), sp)[0], fails, f)
        noise = col(np.random.default_rng(1).standard_normal(SR) * 0.1)
        self.assertIn("alarm-fundamental", check(noise, sp)[0])  # no pitch at all

    def test_alarm_must_have_nothing_above_5_khz(self):
        sp = spec(kind="loop", category="alarms", duration=1.0)
        self.assertIn("alarm-high-energy", check(col(tone(900, 0.3) + tone(8000, 0.05)), sp)[0])   # 1.4 % of the energy
        self.assertNotIn("alarm-high-energy", check(col(tone(900, 0.3) + tone(8000, 0.005)), sp)[0])  # 0.014 %

    def test_sensor_must_have_nothing_above_6_khz(self):
        sp = spec(category="sensors")
        self.assertIn("sensor-high-energy", check(shape_oneshot(tone(7000, 0.3)), sp)[0])
        self.assertNotIn("sensor-high-energy", check(shape_oneshot(tone(3000, 0.3)), sp)[0])

    def test_radio_must_stay_between_250_and_3800_hz(self):
        sp = spec(category="radio")
        self.assertIn("radio-band", check(shape_oneshot(tone(100, 0.3)), sp)[0])
        self.assertIn("radio-band", check(shape_oneshot(tone(5000, 0.3)), sp)[0])
        self.assertNotIn("radio-band", check(shape_oneshot(tone(1000, 0.3)), sp)[0])

    # Second review: the edges of the category bands, which the tests above only pinned to within a few kHz
    # (a mutant that moved the alarm edge from 5 to 7 kHz, the radio edge from 3.8 to 5 kHz and the clipped
    # count from 0 to 50 samples passed every test).
    def test_alarm_edge_is_5_khz(self):
        sp = spec(kind="loop", category="alarms", duration=1.0)
        self.assertIn("alarm-high-energy", check(col(tone(900, 0.3) + tone(6000, 0.05)), sp)[0])      # 5 % at 6 kHz
        self.assertNotIn("alarm-high-energy", check(col(tone(900, 0.3) + tone(4500, 0.05)), sp)[0])   # 5 % at 4.5 kHz

    def test_sensor_edge_is_6_khz(self):
        sp = spec(category="sensors")
        self.assertIn("sensor-high-energy", check(shape_oneshot(tone(6500, 0.3)), sp)[0])
        self.assertNotIn("sensor-high-energy", check(shape_oneshot(tone(5500, 0.3)), sp)[0])

    def test_radio_edges_are_250_and_3800_hz(self):
        sp = spec(category="radio")
        for f, fails in ((200, True), (300, False), (3500, False), (4200, True)):
            self.assertEqual("radio-band" in check(shape_oneshot(tone(f, 0.3)), sp)[0], fails, f)

    def test_one_clipped_sample_fails_the_clipped_rule(self):
        x = shape_oneshot(tone(1000, 0.3))
        x[2000, 0] = 1.0
        bad, an = check(x, spec())
        self.assertEqual(an["clippedSamples"], 1)
        self.assertIn("clipped", bad)

    def test_energy_share_is_of_the_mono_mix(self):
        y = np.stack([tone(100, 0.3), tone(1000, 0.3)], axis=1)
        self.assertAlmostEqual(rules.energy_share(y, 0, 500), 0.5, delta=0.02)
        self.assertAlmostEqual(rules.energy_share(tone(100, 0.3), 0, 500), 1.0, delta=0.001)


class LevelsCeilingAndTable(unittest.TestCase):
    CEILING = -1.0  # SOUND_DESIGN.md section 2: true peak at most -1 dBFS

    def test_the_ceiling_is_minus_one(self):
        self.assertEqual(levels.CEILING_DB, -1.0)
        self.assertEqual(synth.CEILING_DB, -1.0)

    def test_a_loud_loop_is_stopped_at_the_ceiling_by_an_independent_measure(self):
        x = synth.periodic_noise(96000, "white", "loud", lo=40, hi=800)
        y, info = levels.set_level(x, "lufs", -3.0)
        self.assertTrue(info["limited"])
        self.assertLessEqual(measure.amp_db(measure.true_peak(y[:, None])), self.CEILING + 0.02)
        self.assertGreater(measure.amp_db(measure.true_peak(y[:, None])), self.CEILING - 0.1)  # and it uses the room

    def test_peak_target_is_a_true_peak_not_a_sample_peak(self):
        # every sample at +-0.707 of the crest: set to -3 dB the real peak must be -3 dB, the samples -6 dB
        t = np.arange(SR) / SR
        x = np.sin(2 * np.pi * (SR / 4) * t + np.pi / 4)
        x[:4800] *= np.linspace(0, 1, 4800)
        x[-4800:] *= np.linspace(1, 0, 4800)
        y, info = levels.set_level(x, "peak", -3.0)
        self.assertAlmostEqual(measure.amp_db(measure.true_peak(y[:, None])), -3.0, delta=0.1)
        self.assertAlmostEqual(measure.amp_db(float(np.abs(y).max())), -6.0, delta=0.1)
        self.assertFalse(info["limited"])

    def test_true_peak_function_agrees_with_the_measure(self):
        t = np.arange(SR) / SR
        for f, ph in ((SR / 4, np.pi / 4), (16000, 0.0), (1000, 0.3)):
            x = np.sin(2 * np.pi * f * t + ph)
            x[:4800] *= np.linspace(0, 1, 4800)
            x[-4800:] *= np.linspace(1, 0, 4800)
            self.assertAlmostEqual(levels.true_peak_db(x), measure.amp_db(measure.true_peak(x[:, None])), delta=0.01, msg=f)

    def test_the_table_keeps_the_values_of_the_design(self):
        # engines: one engine at six settings, louder with the throttle; alarms by loudness, the missile loudest
        L = levels.LEVELS
        engines = [L[k] for k in ("engine_main_t000", "engine_main_t025", "engine_main_t050", "engine_main_t075",
                                  "engine_main_t100", "engine_main_boost")]
        self.assertEqual(engines, [("lufs", -38.0), ("lufs", -32.0), ("lufs", -27.0), ("lufs", -23.0),
                                   ("lufs", -20.0), ("lufs", -17.0)])
        self.assertEqual(L["alarm_missile"], ("lufs", -18.0))
        for k in ("alarm_heat", "alarm_shields_down", "alarm_fuel_low", "alarm_hull_critical", "alarm_master_caution"):
            self.assertEqual(L[k], ("lufs", -20.0), k)
        self.assertEqual(L["cabin_ambience_loop"], ("lufs", -45.0))
        self.assertEqual(L["silent_running_loop"], ("lufs", -55.0))
        self.assertEqual(L["fold_jump"], ("peak", -1.5))
        self.assertEqual(L["impact_hull_heavy"], ("peak", -1.5))
        self.assertEqual(L["button_press"], ("peak", -16.0))
        self.assertEqual(levels.target_for("not_in_the_table", "alarms", "oneshot"), ("lufs", -20.0))
        with self.assertRaises(KeyError):
            levels.target_for("not_in_the_table", "nowhere", "loop")

    def test_every_rendered_sound_is_under_the_ceiling_measured_independently(self):
        errors = synth.load_categories()   # every cat_* module, so that all sounds are registered
        self.assertEqual(errors, [])
        self.assertGreaterEqual(len(synth.REGISTRY), 75)
        for sid in sorted(synth.REGISTRY):
            x, _ = synth.render(sid)
            pcm = synth.to_int16(x, sid).astype(np.float64) / 32768.0
            pcm = pcm[:, None] if pcm.ndim == 1 else pcm
            self.assertLessEqual(measure.amp_db(measure.true_peak(pcm)), self.CEILING + 0.01, sid)  # +0.01: 16-bit rounding


# BS.1770-4 table 1 and table 2, 48 kHz. A second copy of the reference of listen/tests/test_measure_guards.py: this
# file must not depend on the other test folder, and the two copies check each other against measure.py and levels.py.
PRE_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
PRE_A = [1.0, -1.69065929318241, 0.73248077421585]
RLB_B = [1.0, -2.0, 1.0]
RLB_A = [1.0, -1.99004745483398, 0.99007225036621]


def ref_lufs(x):
    from scipy.signal import lfilter

    y = lfilter(RLB_B, RLB_A, lfilter(PRE_B, PRE_A, np.asarray(x, dtype=np.float64)))
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(y[i:i + blk] ** 2) for i in range(0, y.size - blk + 1, hop)])
    with np.errstate(divide="ignore"):
        lj = -0.691 + 10 * np.log10(z)
    z1 = z[lj > -70.0]
    gate = -0.691 + 10 * np.log10(z1.mean()) - 10.0
    return -0.691 + 10 * np.log10(z[lj > gate].mean())


class LevelsLoudnessAgainstTheStandard(unittest.TestCase):
    """levels.lufs sets the level of every loop, so it is held to the standard, not to measure.py."""

    def test_k_weighting_100_hz_against_1_khz(self):
        low, mid = levels.lufs(tone(100, 0.5, 4.0)), levels.lufs(tone(1000, 0.5, 4.0))
        self.assertAlmostEqual(low - mid, ref_lufs(tone(100, 0.5, 4.0)) - ref_lufs(tone(1000, 0.5, 4.0)), delta=0.05)
        self.assertLess(low - mid, -1.5)
        self.assertAlmostEqual(low, ref_lufs(tone(100, 0.5, 4.0)), delta=0.1)

    def test_gating(self):
        burst = tone(1000, 0.5, 0.5)
        silent = np.concatenate([burst, np.zeros(3 * SR), burst])
        self.assertAlmostEqual(levels.lufs(silent), ref_lufs(silent), delta=0.1)
        self.assertLess(abs(levels.lufs(silent) - levels.lufs(np.concatenate([burst, burst]))), 2.0)

    def test_a_clip_shorter_than_400_ms_is_repeated_to_one_block(self):
        clip = tone(1000, 0.5, 0.1)
        self.assertAlmostEqual(levels.lufs(clip), ref_lufs(np.tile(clip, 4)), delta=0.1)  # current rule, see the fix report
        self.assertAlmostEqual(levels.lufs(clip), levels.lufs(np.tile(clip, 10)), delta=0.1)

    def test_a_level_set_by_loudness_reads_the_target_by_the_standard(self):
        x = synth.periodic_noise(96000, "pink", "std/lvl", lo=40, hi=800)
        y, _ = levels.set_level(x, "lufs", -30.0)
        self.assertAlmostEqual(ref_lufs(y), -30.0, delta=0.1)


class BuildHints(unittest.TestCase):
    """build_sound hands the level to rules.check and puts its hints, and only as hints, into checks."""

    def _build(self, level):
        import tempfile
        from unittest import mock

        import build
        import common
        from synth import cat_thrusters  # noqa: F401  (registers thruster_pulse_a)

        seconds = synth.load_spec()["sounds"]["thruster_pulse_a"]["duration"]
        x = shape_oneshot(tone(1000, 10 ** (-1.2 / 20), seconds), fade_ms=20.0)[:, 0]     # peaks at -1.2 dBFS
        with tempfile.TemporaryDirectory() as d, mock.patch.object(build.synth, "render", return_value=(x, level)):
            return build.build_sound("thruster_pulse_a", Path(d), None, None, measure, common)["checks"]

    def test_a_limited_sound_that_missed_its_target_has_the_hint_and_still_passes(self):
        c = self._build({"mode": "peak", "target": 0.0, "gainDb": 1.0, "requestedGainDb": 2.0, "truePeakDb": -1.0,
                         "limited": True, "monoSum": False})
        self.assertEqual(len(c["hints"]), 1, c)
        self.assertTrue(c["hints"][0].startswith("level-missed-by-ceiling"), c["hints"])
        self.assertNotIn("level-missed-by-ceiling", c["failed"])

    def test_a_sound_that_reached_its_target_has_no_hint(self):
        c = self._build({"mode": "peak", "target": -1.2, "gainDb": 1.0, "requestedGainDb": 1.0, "truePeakDb": -1.2,
                         "limited": False, "monoSum": False})
        self.assertNotIn("hints", c)

    def test_a_level_that_says_it_was_not_limited_gets_no_hint_whatever_the_file_reads(self):
        verdict = rules.check(spec(), GOOD, measure.analyse(GOOD, SR), sound_id="x",
                              level={"mode": "lufs", "target": -10.0, "limited": False, "monoSum": False})
        self.assertEqual(verdict.hints, [])

    def test_dry_categories(self):
        self.assertEqual(rules.DRY_CATEGORIES, {"alarms", "sensors", "radio"})  # SOUND_DESIGN.md: dry sounds, no room


class LevelInfo(unittest.TestCase):
    def test_gain_is_the_applied_gain_and_the_requested_gain_has_its_own_name(self):
        x = synth.periodic_noise(96000, "white", "loud2", lo=40, hi=800)
        y, info = levels.set_level(x, "lufs", -3.0)   # far over the ceiling: limited
        applied = 20 * np.log10(np.abs(y).max() / np.abs(x).max())
        self.assertTrue(info["limited"])
        self.assertAlmostEqual(info["gainDb"], applied, delta=0.006)
        self.assertGreater(info["requestedGainDb"], info["gainDb"] + 3.0)
        z, info2 = levels.set_level(x, "lufs", -30.0)  # not limited: the two agree
        self.assertFalse(info2["limited"])
        self.assertEqual(info2["gainDb"], info2["requestedGainDb"])
        self.assertAlmostEqual(info2["gainDb"], 20 * np.log10(np.abs(z).max() / np.abs(x).max()), delta=0.006)

    def test_the_samples_are_the_same_as_before_the_gain_was_renamed(self):
        # the two multiplications are unchanged: the limited signal is x * requested gain * ceiling correction
        x = synth.periodic_noise(96000, "white", "loud3", lo=40, hi=800)
        y, info = levels.set_level(x, "lufs", -3.0)
        want = x * 10.0 ** (info["requestedGainDb"] / 20.0)
        tp = levels.true_peak_db(want)
        want = want * 10.0 ** ((-1.0 - tp) / 20.0)
        np.testing.assert_allclose(y, want, rtol=0, atol=2e-4 * np.abs(y).max())  # the info is rounded to 0.01 dB

    def test_the_mono_sum_basis_is_recorded(self):
        x = synth.periodic_noise(48000, "pink", "mono/a", lo=100, hi=600)
        s = synth.periodic_noise(48000, "pink", "mono/b", lo=100, hi=600)
        y2 = synth.mid_side(x, s, ratio=0.5)
        self.assertTrue(levels.set_level(y2, "lufs", -30.0, mono_sum=True)[1]["monoSum"])
        self.assertFalse(levels.set_level(y2, "lufs", -30.0)[1]["monoSum"])
        self.assertFalse(levels.set_level(x, "lufs", -30.0, mono_sum=True)[1]["monoSum"])

    def test_silence_has_no_level_in_either_mode(self):
        for mode in ("peak", "lufs"):
            with self.assertRaises(ValueError) as cm:
                levels.set_level(np.zeros(SR), mode, -12.0)
            self.assertIn("silent", str(cm.exception), mode)
            with self.assertRaises(ValueError):
                levels.set_level(np.zeros((SR, 2)), mode, -12.0)
            with self.assertRaises(ValueError) as cm:
                levels.set_level(np.zeros(0), mode, -12.0)
            self.assertIn("empty", str(cm.exception), mode)

    def test_loudness_of_silence_and_of_nothing(self):
        with self.assertRaises(ValueError) as cm:
            levels.lufs(np.zeros(SR))
        self.assertIn("silent", str(cm.exception))
        with self.assertRaises(ValueError) as cm:
            levels.lufs(np.zeros(0))
        self.assertIn("empty", str(cm.exception))

    def test_a_very_quiet_signal_is_still_levelled(self):
        y, info = levels.set_level(tone(1000, 1e-6), "peak", -12.0)   # -120 dBFS is a signal, not silence
        self.assertAlmostEqual(levels.true_peak_db(y), -12.0, delta=0.05)


class LevelHint(unittest.TestCase):
    """R3: a sound the ceiling stopped, whose reached level misses the table target by more than 0.5 dB, gets a hint."""

    SP = spec(kind="loop", path="cabin", category="engines", duration=2.0)

    def _noise(self, seed="hint"):
        return synth.periodic_noise(96000, "white", seed, lo=40, hi=800) * 0.1

    def _run(self, y, info, **kw):
        data = y if np.ndim(y) == 2 else col(y)
        an = measure.analyse(data, SR, loop=True)
        return rules.check(self.SP, data, an, swing_max=100.0, sound_id="x", level=info, **kw), an

    def test_a_limited_loop_that_misses_its_target_gets_the_hint_with_both_numbers(self):
        y, info = levels.set_level(self._noise(), "lufs", -3.0)
        self.assertTrue(info["limited"])
        verdict, an = self._run(y, info)
        self.assertEqual(len(verdict.hints), 1, verdict.hints)
        h = verdict.hints[0]
        self.assertTrue(h.startswith("level-missed-by-ceiling"), h)
        self.assertIn("%.2f" % an["lufs"], h)       # the level it reached
        self.assertIn("-3.00", h)                   # the target of the table
        self.assertLess(an["lufs"], -3.0 - 0.5)
        self.assertNotIn("level-missed-by-ceiling", list(verdict))  # a hint, not a failure
        self.assertNotIn("level-missed-by-ceiling", " ".join(verdict))

    def test_a_loop_that_reaches_its_target_has_no_hint(self):
        y, info = levels.set_level(self._noise(), "lufs", -30.0)
        self.assertFalse(info["limited"])
        self.assertEqual(self._run(y, info)[0].hints, [])

    def test_limited_but_within_half_a_db_has_no_hint(self):
        x = self._noise("hint2")
        tp = levels.true_peak_db(x)
        l0 = levels.lufs(x)
        target = l0 + (-0.8 - tp)        # the gain that puts the true peak at -0.8 dBFS: 0.2 dB over the ceiling
        y, info = levels.set_level(x, "lufs", target)
        self.assertTrue(info["limited"])
        verdict, an = self._run(y, info)
        self.assertLess(abs(an["lufs"] - target), 0.5)
        self.assertEqual(verdict.hints, [])

    def test_the_half_db_limit(self):
        x = self._noise("hint3")
        tp, l0 = levels.true_peak_db(x), levels.lufs(x)
        y, info = levels.set_level(x, "lufs", l0 + (-0.3 - tp))          # 0.7 dB over the ceiling
        verdict, an = self._run(y, info)
        self.assertEqual(len(verdict.hints), 1, (info, an["lufs"]))

    def test_a_peak_target_over_the_ceiling_gets_the_hint_with_the_peaks(self):
        x = tone(1000, 0.5)
        y, info = levels.set_level(x, "peak", 0.0)                       # asked for 0 dBFS, the ceiling gives -1
        self.assertTrue(info["limited"])
        data = shape_oneshot(y)
        an = measure.analyse(data, SR)
        verdict = rules.check(spec(), data, an, sound_id="x", level=info)
        self.assertEqual(len(verdict.hints), 1, verdict.hints)
        self.assertIn("-1.00", verdict.hints[0])
        self.assertIn("0.00", verdict.hints[0])

    def test_mid_side_sounds_are_compared_on_the_mono_sum(self):
        mid = synth.periodic_noise(96000, "pink", "hm/mid", lo=100, hi=600)
        side = synth.periodic_noise(96000, "pink", "hm/side", lo=100, hi=600)
        y2 = 0.1 * synth.mid_side(mid, side, ratio=0.5)
        y, info = levels.set_level(y2, "lufs", -30.0, mono_sum=True)     # reached on the mono sum, not limited
        an = measure.analyse(y, SR, loop=True)
        self.assertGreater(abs(an["lufs"] - an["lufsMono"]), 0.5)        # the file and its mono sum differ
        verdict = rules.check(dict(self.SP, channels=2), y, an, swing_max=100.0, sound_id="x", level=info)
        self.assertEqual(verdict.hints, [])
        # the same limited: the number in the hint is the mono-sum loudness
        z, info2 = levels.set_level(y2, "lufs", -3.0, mono_sum=True)
        self.assertTrue(info2["limited"])
        an2 = measure.analyse(z, SR, loop=True)
        h = rules.check(dict(self.SP, channels=2), z, an2, swing_max=100.0, sound_id="x", level=info2).hints
        self.assertEqual(len(h), 1)
        self.assertIn("%.2f" % an2["lufsMono"], h[0])

    def test_without_level_info_there_is_no_hint_and_the_result_is_a_plain_list(self):
        verdict = check(GOOD, spec())[0]
        self.assertEqual(verdict, [])
        self.assertEqual(verdict.hints, [])
        self.assertIsInstance(verdict, list)


class AnalysisOfTheRulesInputs(unittest.TestCase):
    def test_structure_rules_are_fed_measurements_not_constants(self):
        """The shares come from measure.analyse of the signal (a 40 Hz and a 300 Hz tone), not from a made-up dict."""
        x = shape_oneshot(tone(40, 0.3) + tone(300, 0.3))
        an = measure.analyse(x, SR)
        self.assertAlmostEqual(an["lowShare"], 1.0, delta=0.02)
        self.assertAlmostEqual(rules.energy_share(x, 0, 60), 0.5, delta=0.03)
        self.assertAlmostEqual(rules.energy_share(x, 125, 1000), 0.5, delta=0.03)


if __name__ == "__main__":
    unittest.main()
