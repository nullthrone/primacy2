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


class Fades(unittest.TestCase):
    def test_loud_edges_get_fades_of_the_right_length(self):
        x = sine(1000, 1.0)  # 1 kHz is exactly one period per millisecond; starts at 0, ends near 0
        x = np.concatenate([[0.9], x[1:]])  # but this one starts at 0.9, not silent
        x[-1] = 0.9
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        self.assertEqual((info['fadeInMs'], info['fadeOutMs']), (8.0, 30.0))
        self.assertEqual(y.shape, (SR, 1))
        self.assertEqual(y[0, 0], 0.0)
        self.assertEqual(y[-1, 0], 0.0)
        e = ms_envelope(y)
        top = e[200]
        self.assertLess(e[0], 0.1 * top)
        self.assertLess(e[6], 0.95 * top)        # still inside the 8 ms fade
        self.assertAlmostEqual(e[8] / top, 1.0, places=2)  # 8 ms later the fade is over
        self.assertAlmostEqual(e[-31] / top, 1.0, places=3)  # 30 ms before the end it starts
        self.assertTrue(0.6 * top < e[-21] < 0.9 * top)      # half way, about 0.75
        self.assertLess(e[-1], 0.01 * top)

    def test_silent_edges_are_left_alone(self):
        x = np.concatenate([np.zeros(4800), sine(440, 0.5), np.zeros(4800)])
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual((info['fadeInMs'], info['fadeOutMs']), (0.0, 0.0))
        # same shape as the input, only scaled
        k = np.abs(y).max() / np.abs(x).max()
        np.testing.assert_allclose(y[:, 0], x * k, atol=1e-9)

    def test_only_the_loud_end_is_faded(self):
        x = np.concatenate([np.zeros(4800), sine(440, 0.5)])
        x[-1] = 0.5  # not silent at the end
        y, info = build.process_download(x, SR, 'oneshot', 'sensors')
        self.assertEqual((info['fadeInMs'], info['fadeOutMs']), (0.0, 30.0))
        xs, ys = x[100:-1500], y[100:-1500, 0]
        k = ys[np.abs(xs) > 0.1] / xs[np.abs(xs) > 0.1]
        np.testing.assert_allclose(k, k[0], rtol=1e-6)  # unfaded part is only scaled

    def test_a_loop_gets_no_fade(self):
        x = sine(500, 2.0, amp=0.9)
        x = x + 0.05  # starts and ends loud
        y, info = build.process_download(x, SR, 'loop', 'engines')
        self.assertEqual((info['fadeInMs'], info['fadeOutMs']), (0.0, 0.0))
        self.assertGreater(abs(y[0, 0]), 0.0)
        k = y[:, 0] / x
        m = np.abs(x) > 0.2
        np.testing.assert_allclose(k[m], k[m][0], rtol=1e-6)

    def test_a_very_short_clip_gets_fades_that_fit(self):
        x = np.full(240, 0.5)  # 5 ms: the 8 and 30 ms fades are cut to half the clip each
        x[::2] = -0.5
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        self.assertEqual(y.shape[0], 240)
        self.assertEqual(y[0, 0], 0.0)
        self.assertEqual(y[-1, 0], 0.0)


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
            self.assertEqual(y.shape[0], SR, sr)
            spec = np.abs(np.fft.rfft(y[:, 0] * np.hanning(SR)))
            self.assertAlmostEqual(np.argmax(spec) * SR / SR, 1000, delta=2, msg=str(sr))

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
