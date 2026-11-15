"""Tests for the download handling of tools/audio/build.py (process_download and friends).

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

Synthetic input only: nothing under assets/ is read or written.
"""
import importlib.util
import os
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))  # build.py finds synth and listen itself, but -I hides this
_spec = importlib.util.spec_from_file_location('build_under_test', os.path.join(HERE, '..', 'build.py'))
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

from synth.levels import lufs, true_peak_db  # noqa: E402

SR = 48000


def sine(freq, seconds, amp=0.9, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return amp * np.sin(2 * np.pi * freq * t)


def ms_envelope(y):
    """Peak of every millisecond (48 samples) of a 48 kHz signal."""
    m = np.abs(y).max(axis=1) if y.ndim == 2 else np.abs(y)
    n = len(m) // 48
    return m[: n * 48].reshape(n, 48).max(axis=1)


class Ends(unittest.TestCase):
    """One-shots: a lead-in where the first sample is a step, a fade-out where the end is not silent."""

    def test_a_start_that_is_a_step_gets_a_lead_in_and_the_recording_is_not_touched(self):
        x = sine(1000, 1.0)
        x = np.concatenate([[0.9], x[1:]])  # the first sample is 0.9, not silent
        x[-1] = 0.9
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        k = 72  # 1.5 ms
        self.assertEqual((info['leadInMs'], info['fadeInMs'], info['fadeOutMs']), (1.5, 0.0, 30.0))
        self.assertEqual(y.shape, (SR + k, 1))
        self.assertEqual(y[0, 0], 0.0)
        self.assertEqual(y[-1, 0], 0.0)
        ramp = y[:k, 0] / y[k, 0]            # rises from 0 towards the first sample of the file
        self.assertTrue(np.all(np.diff(ramp) > 0))
        self.assertLess(ramp[-1], 1.0)
        self.assertGreater(ramp[-1], 0.99)
        self.assertAlmostEqual(ramp[k // 2], 0.5, delta=0.02)   # raised cosine: half way at half time
        # the file after the lead-in is the recording, only scaled: one factor all the way to the fade-out
        end = SR - 1500
        body, src = y[k:k + end, 0], x[:end]
        m = np.abs(src) > 0.2
        g = body[m] / src[m]
        np.testing.assert_allclose(g, g[0], rtol=1e-9)
        # the fade-out is 30 ms, raised cosine
        e = ms_envelope(y)
        self.assertAlmostEqual(e[-31] / e[200], 1.0, places=3)
        self.assertTrue(0.6 * e[200] < e[-21] < 0.9 * e[200])
        self.assertLess(e[-1], 0.01 * e[200])

    def test_a_start_below_minus_60_dbfs_is_left_alone(self):
        x = sine(440, 0.5)
        x[0] = 0.0009  # -61 dBFS: not a step
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual(info['leadInMs'], 0.0)
        self.assertEqual(y.shape[0], x.shape[0])
        x2 = x.copy()
        x2[0] = 0.0011  # -59 dBFS: a step
        y2, info2 = build.process_download(x2, SR, 'oneshot', 'sensors')
        self.assertEqual(info2['leadInMs'], 1.5)
        self.assertEqual(y2.shape[0], x.shape[0] + 72)

    def test_silent_edges_are_left_alone(self):
        x = np.concatenate([np.zeros(4800), sine(440, 0.5), np.zeros(4800)])
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual((info['leadInMs'], info['fadeOutMs']), (0.0, 0.0))
        k = np.abs(y).max() / np.abs(x).max()   # same shape as the input, only scaled
        np.testing.assert_allclose(y[:, 0], x * k, atol=1e-9)

    def test_a_signal_that_rises_at_once_from_a_silent_first_sample_is_untouched(self):
        # the old rule faded this for 8 ms: its first millisecond is loud, its first sample is zero
        x = sine(2000, 0.3, amp=0.8)
        self.assertEqual(x[0], 0.0)
        y, info = build.process_download(x, SR, 'oneshot', 'impacts')
        self.assertEqual((info['leadInMs'], info['fadeInMs']), (0.0, 0.0))
        k = np.abs(y[:200, 0]).max() / np.abs(x[:200]).max()
        np.testing.assert_allclose(y[:200, 0], x[:200] * k, atol=1e-9)

    def test_only_the_loud_end_is_faded(self):
        # decaying, so that the envelope maximum is early and the fade does not reach it
        x = np.concatenate([np.zeros(4800), sine(440, 0.5) * np.linspace(1.0, 0.3, 24000)])
        x[-1] = 0.2  # not silent at the end
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual((info['leadInMs'], info['fadeOutMs'], info['appendedTailMs']), (0.0, 30.0, 0.0))
        xs, ys = x[100:-1500], y[100:-1500, 0]
        k = ys[np.abs(xs) > 0.1] / xs[np.abs(xs) > 0.1]
        np.testing.assert_allclose(k, k[0], rtol=1e-6)  # unfaded part is only scaled

    def test_the_lead_in_runs_per_channel_to_the_first_sample_of_each(self):
        left = sine(300, 0.25, amp=0.5) + 0.4
        right = -sine(300, 0.25, amp=0.2) - 0.1
        y, info = build.process_download(np.stack([left, right], axis=1), SR, 'oneshot', 'switches')
        self.assertEqual(info['leadInMs'], 1.5)
        self.assertEqual(tuple(y[0]), (0.0, 0.0))
        self.assertGreater(y[71, 0], 0)
        self.assertLess(y[71, 1], 0)   # the second channel starts negative and ramps towards that
        # the first sample of the file keeps the proportion of the two channels
        self.assertAlmostEqual(y[72, 0] / y[72, 1], left[0] / right[0], places=6)

    def test_the_attack_keeps_its_place_and_the_gain_does_not_jump(self):
        # a click: full level from the first sample, over in 20 ms
        n = int(0.02 * SR)
        t = np.arange(n) / SR
        x = 0.9 * np.sin(2 * np.pi * 3000 * t + 1.0) * np.exp(-t / 0.004)
        before = x.copy()
        y, info = build.process_download(x, SR, 'oneshot', 'cabin')   # short: set by true peak
        self.assertEqual(info['leadInMs'], 1.5)

        def t90(v):
            return np.argmax(np.abs(v) >= 0.9 * np.abs(v).max()) / SR * 1000.0

        self.assertLessEqual(abs(t90(y[:, 0]) - t90(before)), 1.6)
        # the level is what the unprocessed recording needs, not what is left of it after a fade
        want = -16.0 - true_peak_db(before[:, None])
        self.assertAlmostEqual(info['level']['gainDb'], want, delta=0.25)   # the ramp moves the oversampled peak a little
        self.assertAlmostEqual(true_peak_db(y), -16.0, delta=0.05)

    def test_a_very_short_clip_gets_ends_that_fit(self):
        x = np.full(240, 0.5)  # 5 ms
        x[::2] = -0.5
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        self.assertEqual(y.shape[0], 240 + 72)
        self.assertEqual(y[0, 0], 0.0)
        self.assertEqual(y[-1, 0], 0.0)


def _tile_steps(y, times=3):
    """Absolute steps of a loop played `times` times, and the indices of the joins."""
    t = np.tile(y, (times, 1))
    d = np.abs(np.diff(t, axis=0)).max(axis=1)
    joins = [i * y.shape[0] - 1 for i in range(1, times)]  # d[j] is the step from sample j to j+1
    return d, joins


class Loops(unittest.TestCase):
    def _noise_with_step(self, seconds=3.0, seed=1):
        rng = np.random.default_rng(seed)
        x = rng.normal(0, 0.1, int(seconds * SR))
        x += np.linspace(0.0, 0.5, x.shape[0])     # first and last sample far apart: a hard seam
        return x

    def test_a_loop_is_shorter_by_the_crossfade_and_gets_no_lead_in_or_fade_out(self):
        x = self._noise_with_step(3.0)
        y, info = build.process_download(x, SR, 'loop', 'sensors')
        k = min(int(0.3 * SR), x.shape[0] // 10)
        self.assertEqual(k, 14400)
        self.assertEqual(y.shape[0], x.shape[0] - k)
        self.assertEqual((info['leadInMs'], info['fadeInMs'], info['fadeOutMs']), (0.0, 0.0, 0.0))
        self.assertEqual(info['loopCrossfadeMs'], 300.0)
        self.assertGreater(abs(y[0, 0]), 0.0)

    def test_the_crossfade_is_a_tenth_of_a_short_file(self):
        x = self._noise_with_step(1.0)
        y, info = build.process_download(x, SR, 'loop', 'sensors')
        self.assertEqual(y.shape[0], SR - SR // 10)
        self.assertEqual(info['loopCrossfadeMs'], 100.0)

    def test_the_last_sample_runs_into_the_first(self):
        x = self._noise_with_step(3.0)
        y, info = build.process_download(x, SR, 'loop', 'sensors')
        self.assertEqual(info['loopStartMs'], 0.0)
        steps = np.abs(np.diff(y[:, 0]))
        self.assertLessEqual(abs(y[0, 0] - y[-1, 0]), np.percentile(steps, 99.9))
        self.assertGreater(abs(x[0] - x[-1]), 0.3)   # the recording itself had a step of that size

    def test_tiled_three_times_the_joins_are_no_larger_than_the_steps_around_them(self):
        for seed, cat in ((1, 'sensors'), (2, 'engines'), (3, 'cabin')):
            y, _ = build.process_download(self._noise_with_step(3.0, seed), SR, 'loop', cat)
            d, joins = _tile_steps(y)
            for j in joins:
                around = np.concatenate([d[j - 200:j], d[j + 1:j + 201]])
                self.assertLessEqual(d[j], around.max(), (seed, j))
                self.assertLessEqual(d[j], 3.0 * np.percentile(d, 99), (seed, j))

    def test_the_crossfade_keeps_the_power_for_uncorrelated_material(self):
        rng = np.random.default_rng(5)
        x = rng.normal(0, 0.1, 5 * SR)
        k = 14400
        y, _ = build._loop_crossfade(x[:, None])
        rms = lambda v: float(np.sqrt((v ** 2).mean()))
        self.assertAlmostEqual(rms(y[:k]) / rms(y[k:]), 1.0, delta=0.03)

    def test_the_loop_check_passes_where_the_recording_is_louder_at_one_end(self):
        import measure
        rng = np.random.default_rng(7)
        env = np.concatenate([np.full(SR, 1.0), np.linspace(1.0, 0.05, 3 * SR), np.full(SR, 0.05)])
        x = rng.normal(0, 0.2, env.shape[0]) * env
        stereo = np.stack([x, np.roll(x, 100)], axis=1)
        y, info = build.process_download(stereo, SR, 'loop', 'engines')
        self.assertGreater(info['loopStartMs'], 0.0)   # the wrap point was moved
        res = measure.loop_check(y, SR)
        self.assertTrue(res['pass'], res)
        d, joins = _tile_steps(y)
        self.assertLessEqual(d[joins[0]], np.percentile(d, 99.9))

    def test_a_loop_that_wraps_already_is_not_moved(self):
        y, info = build.process_download(sine(500, 4.0, amp=0.5), SR, 'loop', 'sensors')
        self.assertEqual(info['loopStartMs'], 0.0)


class EndsLoudestAtTheEnd(unittest.TestCase):
    """A fade-out must not reach into the loudest part of a one-shot (k_door_close_1 of the library:
    its envelope maximum lies 10 ms before the end of the recording)."""

    def _rising(self):
        t = np.arange(int(0.5 * SR)) / SR
        env = np.concatenate([np.full(int(0.05 * SR), 0.0), 0.05 + 0.95 * np.linspace(0, 1, int(0.45 * SR)) ** 3])
        x = env * np.sin(2 * np.pi * 300 * t)
        x[-1] = x[-2] * 0.9 + 0.01                       # not silent at the end
        return x

    def test_the_recording_stays_untouched_and_a_tail_of_3_ms_is_appended(self):
        x = self._rising()
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        self.assertEqual((info['fadeOutMs'], info['appendedTailMs'], info['leadInMs']), (0.0, 3.0, 0.0))
        self.assertEqual(y.shape[0], x.shape[0] + 144)
        g = 10.0 ** (info['level']['gainDb'] / 20.0)
        np.testing.assert_allclose(y[: x.shape[0], 0], x * g, atol=4e-5)   # nothing multiplied by a fade (16 bit)
        tail = y[x.shape[0]:, 0] / g
        want = x[-1] * (0.5 + 0.5 * np.cos(np.pi * np.arange(1, 145) / 144))
        np.testing.assert_allclose(tail, want, atol=1e-3)   # 16 bit, divided by the gain
        self.assertEqual(y[-1, 0], 0.0)
        self.assertTrue(np.all(np.diff(tail) <= 1e-12) if x[-1] > 0 else np.all(np.diff(tail) >= -1e-12))

    def test_the_gain_is_what_the_unprocessed_recording_needs(self):
        from synth import set_level
        x = self._rising()
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        _, level = set_level(x[:, None], 'peak', -14.0, ceiling_db=build.DOWNLOAD_CEILING_DB)
        self.assertAlmostEqual(info['level']['gainDb'], level['gainDb'], delta=0.1)
        self.assertAlmostEqual(true_peak_db(y[:, 0]), -14.0, delta=0.1)

    def test_the_tail_is_per_channel(self):
        x = self._rising()
        st = np.stack([x, -0.5 * x], axis=1)
        y, info = build.process_download(st, SR, 'oneshot', 'switches')
        self.assertEqual(info['appendedTailMs'], 3.0)
        self.assertEqual(float(np.abs(y[-1]).max()), 0.0)
        n = x.shape[0]
        self.assertAlmostEqual(y[n, 1] / y[n, 0], -0.5, delta=0.02)   # both continue from their own last sample

    def test_a_maximum_before_the_last_30_ms_keeps_the_fade(self):
        x = np.concatenate([sine(440, 0.3), sine(440, 0.1, amp=0.2)])
        x[-1] = 0.1
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual((info['fadeOutMs'], info['appendedTailMs']), (30.0, 0.0))
        self.assertEqual(y.shape[0], x.shape[0])

    def test_a_maximum_inside_the_last_30_ms_but_before_a_shorter_fade_keeps_the_fade(self):
        # 20 ms file: the fade is 10 ms (half the file); the maximum is in the first half
        x = np.concatenate([np.linspace(0, 0.9, 240), np.linspace(0.9, 0.3, 720)])
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual(info['appendedTailMs'], 0.0)
        self.assertEqual(info['fadeOutMs'], 10.0)

    def test_fade_out_ms_states_the_fade_that_was_applied(self):
        x = np.concatenate([np.linspace(0, 0.9, 300), np.linspace(0.9, 0.5, 900)])   # 25 ms
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual(info['fadeOutMs'], 12.5)
        self.assertEqual(y.shape[0], x.shape[0])
        self.assertLess(abs(y[-1, 0]), 1e-12)

    def test_an_end_that_is_silent_gets_neither(self):
        x = np.concatenate([sine(440, 0.3), np.zeros(1000)])
        _, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual((info['fadeOutMs'], info['appendedTailMs']), (0.0, 0.0))

    def test_envelope_peak_index(self):
        x = np.zeros((4800, 1))
        x[4000:4010, 0] = 0.8
        self.assertTrue(3950 <= build.envelope_peak_index(x) <= 4050)


def _window_db(y, a, w=2400):
    idx = np.arange(a, a + w) % y.shape[0]
    return 10 * np.log10(max(float((y[idx] ** 2).mean()), 1e-12))


class TonalLoops(unittest.TestCase):
    """A steady tone whose tail and head are out of phase (n_ingenuity of the library, 84 Hz)."""

    def _tone(self, n_extra=137, seconds=6.0, f=84.0, noise=0.01, seed=11):
        rng = np.random.default_rng(seed)
        n = int(seconds * SR) + n_extra
        t = np.arange(n) / SR
        return 0.3 * np.sin(2 * np.pi * f * t + 0.7) + rng.normal(0, noise, n)

    def test_the_old_equal_power_fade_of_the_cut_as_it_was_dipped_and_the_new_one_does_not(self):
        x = self._tone()
        y, k = build._loop_crossfade(x[:, None])
        outside = _window_db(y[:, 0], k + 24000)
        zone = [_window_db(y[:, 0], a) for a in range(0, k - 2400, 480)]
        self.assertLess(max(abs(z - outside) for z in zone), 1.5)
        t = np.arange(k) / k
        old = x[:k, None] * np.sin(0.5 * np.pi * t)[:, None] + x[-k:, None] * np.cos(0.5 * np.pi * t)[:, None]
        old_zone = [_window_db(old[:, 0], a) for a in range(0, k - 2400, 480)]
        self.assertGreater(max(abs(z - outside) for z in old_zone), 1.5)   # the old law was off for this input

    def test_the_cut_moves_to_the_best_alignment_within_30_ms_and_the_law_is_linear(self):
        x = self._tone()
        info = {}
        y, k = build._loop_crossfade(x[:, None], info)
        self.assertEqual(info['loopLaw'], 'linear')
        self.assertGreater(info['loopCorrelation'], 0.9)
        self.assertGreater(info['loopShiftMs'], 0.0)
        self.assertLessEqual(info['loopShiftMs'], 30.0)
        s = int(round(info['loopShiftMs'] * 48))
        self.assertEqual(y.shape[0], x.shape[0] - k - s)
        best = build._align_tail(x[:, None], k, 1440)
        self.assertAlmostEqual(float(best.max()), info['loopCorrelation'], places=3)
        self.assertEqual(int(np.argmax(best)), s)

    def test_the_whole_process_keeps_the_level_in_the_zone_and_the_seam_and_the_joins(self):
        import measure
        x = self._tone()
        y, info = build.process_download(x, SR, 'loop', 'engines')
        self.assertEqual(info['loopStartMs'], 0.0)
        k = int(round(info['loopCrossfadeMs'] * 48))
        zone = [_window_db(y[:, 0], a) for a in range(0, k - 2400 + 1, 480)]
        outside = [_window_db(y[:, 0], a) for a in range(k, k + 4 * 24000, 2400)]
        self.assertLess(max(abs(z - np.mean(outside)) for z in zone), 1.5)
        self.assertLess(abs(info['loopZone']['vsSourcesDb']), 1.5)
        self.assertTrue(measure.loop_check(y, SR)['pass'])
        d, joins = _tile_steps(y)
        for j in joins:
            self.assertLessEqual(d[j], np.percentile(d, 99.9) * 3.0)
            self.assertLessEqual(d[j], d[j - 200:j].max() * 3.0)

    def test_uncorrelated_noise_gets_equal_power_and_is_not_shifted(self):
        rng = np.random.default_rng(3)
        x = rng.normal(0, 0.1, 5 * SR)
        info = {}
        y, k = build._loop_crossfade(x[:, None], info)
        self.assertEqual((info['loopLaw'], info['loopShiftMs']), ('equal-power', 0.0))
        self.assertLess(info['loopCorrelation'], 0.5)
        self.assertEqual(y.shape[0], x.shape[0] - k)

    def test_the_fields_reach_the_info_that_goes_into_the_manifest(self):
        _, info = build.process_download(self._tone(), SR, 'loop', 'engines')
        for key in ('loopShiftMs', 'loopCorrelation', 'loopLaw', 'loopZone'):
            self.assertIn(key, info)


class HonestLevel(unittest.TestCase):
    def test_the_applied_gain_is_stated_and_what_was_asked_for_too(self):
        x = 0.0005 * sine(80, 2.0, amp=1.0)       # a quiet floor under three snaps: loudness asks for a lot
        x[[1000, 30000, 60000]] = 0.8
        x[0] = 0.0
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        lv = info['level']
        self.assertEqual(lv['mode'], 'lufs')
        self.assertTrue(lv['limited'])
        self.assertGreater(lv['requestedGainDb'], lv['gainDb'] + 3.0)
        applied = 20 * np.log10(np.abs(y).max() / np.abs(x).max())
        self.assertAlmostEqual(lv['gainDb'], applied, delta=0.02)
        self.assertAlmostEqual(lv['truePeakDb'], build.DOWNLOAD_CEILING_DB, delta=0.01)

    def test_without_limiting_the_two_agree(self):
        y, info = build.process_download(sine(800, 0.5, amp=0.99), SR, 'oneshot', 'thrusters')
        lv = info['level']
        self.assertFalse(lv['limited'])
        self.assertEqual(lv['gainDb'], lv['requestedGainDb'])


class Level(unittest.TestCase):
    def test_short_oneshot_is_set_by_true_peak(self):
        y, info = build.process_download(sine(800, 0.5, amp=0.99), SR, 'oneshot', 'thrusters')
        self.assertEqual(info['level']['mode'], 'peak')
        self.assertAlmostEqual(true_peak_db(y), -12.0, delta=0.05)

    def test_long_oneshot_is_set_by_loudness(self):
        y, info = build.process_download(sine(300, 4.0, amp=0.99), SR, 'oneshot', 'engines')
        self.assertEqual(info['level']['mode'], 'lufs')
        self.assertAlmostEqual(lufs(y), -27.0, delta=0.15)
        self.assertLessEqual(true_peak_db(y), -1.0)

    def test_loop_is_set_by_loudness_even_when_short(self):
        y, info = build.process_download(sine(300, 1.0, amp=0.99), SR, 'loop', 'sensors')
        self.assertEqual(info['level']['mode'], 'lufs')
        self.assertAlmostEqual(lufs(y), -27.0, delta=0.15)

    def test_no_long_one_shot_sits_at_a_bed_level(self):
        # a long one-shot is within 8 dB of the loudness of a short one at its peak target (peak - 16 dB)
        for (cat, length), (mode, value) in build.DOWNLOAD_TARGETS.items():
            if length != 'long':
                continue
            short_mode, short_peak = build.DOWNLOAD_TARGETS[(cat, 'short')]
            self.assertEqual((mode, short_mode), ('lufs', 'peak'), cat)
            self.assertGreaterEqual(value, short_peak - 16.0 - 8.0, cat)

    def test_the_ceiling_wins_over_the_target(self):
        x = np.zeros(SR)
        x[:2000] = 0.5 * np.sin(2 * np.pi * 200 * np.arange(2000) / SR)
        x += 0.0005 * sine(80, 1.0, amp=1.0)  # a quiet floor so that it is not silent
        y, info = build.process_download(x * 1.0, SR, 'oneshot', 'impacts')  # long, -26 LUFS wanted
        self.assertLessEqual(true_peak_db(y), -1.0)

    def test_target_table(self):
        self.assertEqual(build.download_target('radio', 'oneshot', 1.5)[0], 'peak')
        self.assertEqual(build.download_target('radio', 'oneshot', 1.51)[0], 'lufs')
        self.assertEqual(build.download_target('radio', 'loop', 0.2)[0], 'lufs')
        # a bed level is not given to an event: a long cabin one-shot is -32 LUFS, the cabin loop stays -45
        self.assertEqual(build.download_target('cabin', 'oneshot', 5.0), ('lufs', -32.0))
        self.assertEqual(build.download_target('cabin', 'loop', 5.0), ('lufs', -45.0))
        self.assertEqual(build.download_target('landing', 'oneshot', 3.0), ('lufs', -24.0))
        self.assertEqual(build.download_target('landing', 'loop', 3.0), ('lufs', -32.0))
        self.assertEqual(build.download_target('sensors', 'loop', 3.0), build.download_target('sensors', 'oneshot', 3.0))
        self.assertEqual(build.download_target('no-such-category', 'oneshot', 0.2), build.DOWNLOAD_FALLBACK['short'])
        # every category of the selection has a short and a long row
        import json
        with open(os.path.join(build.ROOT, 'assets', 'audio', 'selection.json'), encoding='utf8') as f:
            for it in json.load(f):
                for length in ('short', 'long'):
                    self.assertIn((it['category'], length), build.DOWNLOAD_TARGETS, it['id'])


class Clipping(unittest.TestCase):
    def test_flat_runs_at_the_maximum_are_counted(self):
        x = np.zeros(1000)
        x[100:105] = 1.0
        x[300:302] = 1.0   # two samples are not a run
        x[500:504] = -1.0
        x[700] = 0.4
        self.assertEqual(build.detect_source_clipping(x[:, None]), 9)

    def test_a_clipped_sine_is_detected_and_a_clean_one_is_not(self):
        self.assertGreater(build.detect_source_clipping(np.clip(sine(200, 1.0, amp=1.6), -1, 1)[:, None]), 100)
        # 1 kHz: a clean peak lasts well under one sample within 0.1 %; a 200 Hz sine at 0.99 would give
        # a run of three (the rule as specified cannot tell that from a clipped plateau)
        self.assertEqual(build.detect_source_clipping(sine(1000, 1.0, amp=0.99)[:, None]), 0)

    def test_a_flat_top_below_98_percent_is_no_clipping(self):
        x = np.clip(sine(200, 1.0, amp=1.0), -0.9, 0.9)
        self.assertEqual(build.detect_source_clipping(x[:, None]), 0)

    def test_overshoot_of_a_lossy_decoder_does_not_hide_the_plateau(self):
        x = np.zeros(1000)
        x[100:106] = 1.0
        x[99] = x[106] = 1.14   # decoder overshoot next to the plateau
        self.assertGreaterEqual(build.detect_source_clipping(x[:, None]), 6)

    def test_clipping_is_counted_on_the_source_and_reported(self):
        x = np.clip(sine(200, 1.0, amp=1.6), -1, 1)
        _y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual(info['sourceClipped'], build.detect_source_clipping(x[:, None]))
        _y, info = build.process_download(sine(200, 1.0, amp=0.5), SR, 'oneshot', 'sensors')
        self.assertEqual(info['sourceClipped'], 0)


class Channels(unittest.TestCase):
    def test_mono_stays_mono_and_stereo_stays_stereo(self):
        mono, _ = build.process_download(sine(500, 0.3), SR, 'oneshot', 'switches')
        self.assertEqual(mono.shape[1], 1)
        st = np.stack([sine(500, 0.3), sine(900, 0.3)], axis=1)
        y, _ = build.process_download(st, SR, 'oneshot', 'switches')
        self.assertEqual(y.shape, (int(0.3 * SR), 2))
        self.assertGreater(np.abs(y[:, 0] - y[:, 1]).max(), 0.01)  # the channels are still different

    def test_more_than_two_channels_are_mixed_to_two(self):
        six = np.stack([sine(100 * (i + 1), 0.3) for i in range(6)], axis=1)
        y, _ = build.process_download(six, SR, 'oneshot', 'switches')
        self.assertEqual(y.shape[1], 2)


class Resampling(unittest.TestCase):
    def test_to_48_khz_keeps_pitch_and_duration(self):
        for sr in (44100, 22050, 32000, 96000):
            x = sine(1000, 1.0, sr=sr)
            y, info = build.process_download(x, sr, 'loop', 'sensors')
            self.assertEqual(info['sourceSr'], sr)
            # a loop is shorter by its crossfade and by the shift that lines the tail up with the head
            self.assertLessEqual(y.shape[0], SR - SR // 10, sr)
            self.assertGreaterEqual(y.shape[0], SR - SR // 10 - 1440, sr)
            n = y.shape[0]
            spec = np.abs(np.fft.rfft(y[:, 0] * np.hanning(n)))
            self.assertAlmostEqual(np.argmax(spec) * SR / n, 1000, delta=2, msg=str(sr))

    def test_excerpt_is_cut_in_source_seconds(self):
        x = sine(1000, 3.0, sr=44100)
        y, _ = build.process_download(x, 44100, 'oneshot', 'switches', excerpt=(1.0, 1.5))
        self.assertEqual(y.shape[0], 24000)
        with self.assertRaises(ValueError):
            build.process_download(x, 44100, 'oneshot', 'switches', excerpt=(5.0, 6.0))


class Determinism(unittest.TestCase):
    def test_same_input_same_bytes_and_input_untouched(self):
        x = sine(700, 0.8, amp=0.95)
        before = x.copy()
        a, _ = build.process_download(x, SR, 'oneshot', 'impacts')
        b, _ = build.process_download(x, SR, 'oneshot', 'impacts')
        self.assertEqual(a.tobytes(), b.tobytes())
        np.testing.assert_array_equal(x, before)


class Manifest(unittest.TestCase):
    def test_validate_requires_the_measured_numbers_for_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = build.Path(tmp)
            (out / 'downloads').mkdir()
            (out / 'downloads' / 'a.wav').write_bytes(b'x')
            (out / 'downloads' / 'a.png').write_bytes(b'x')
            entry = {
                'id': 'a', 'file': 'downloads/a.wav', 'spectrogram': 'downloads/a.png', 'category': 'radio',
                'kind': 'oneshot', 'path': 'structure', 'en': 'a', 'de': 'a', 'intent': '', 'source': 'download',
                'licence': 'CC0 1.0', 'duration': 1.0, 'channels': 1, 'gain': 1.0, 'dry': True, 'hash': '0' * 12,
                'checks': {'pass': True, 'failed': [], 'peakDb': -3.0, 'lufs': -20.0, 'lowShare': 0.5,
                           'highShare': 0.1, 'centroidHz': 900.0, 'sourceClipped': 0},
            }
            manifest = {'version': 1, 'categories': [{'id': 'radio'}], 'sounds': [entry]}
            self.assertEqual(build.validate_manifest(manifest, out), [])
            for key in ('centroidHz', 'lufs', 'sourceClipped'):
                broken = dict(entry, checks={k: v for k, v in entry['checks'].items() if k != key})
                problems = build.validate_manifest(dict(manifest, sounds=[broken]), out)
                self.assertTrue(any(key in p for p in problems), key)
            loud = dict(entry, checks=dict(entry['checks'], peakDb=-0.2))
            self.assertTrue(build.validate_manifest(dict(manifest, sounds=[loud]), out))
            self.assertTrue(build.validate_manifest(dict(manifest, sounds=[dict(entry, duration=0)]), out))


if __name__ == '__main__':
    unittest.main()
