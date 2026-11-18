"""Tests for the generated sounds that the owner rated from a page copy (round 7 on): the library file is that page copy
times one gain, and its cut is the sample the page copy was cut at (tools/audio/build.py page_finish, process_generated).

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

What the page copy went through is tools/sound/screen.py _finish (the end fade and the silence after it, the ramp in, the mean
removal). Made-up signals in a temporary folder, except the class RealList, which reads the tracked files of the repository
(assets/audio/generated.json and the raw files next to it) and nothing else: never assets/audio/gen, assets/audio/render or
assets/audio/ratings.json. The two-channel text of the intent is held here too.
"""
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_generated_build import Base, SR, build, burst, item, write_raw  # noqa: E402

ROOT = Path(HERE).resolve().parents[2]


def _load_screen():
    spec = importlib.util.spec_from_file_location('screen_under_test', ROOT / 'tools' / 'sound' / 'screen.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


screen = _load_screen()


def signal(seconds=1.0, channels=1, dc=0.0, start_step=True, end_step=True, amp=0.2):
    """A noisy tone (n, channels) with a mean of dc, starting and ending mid-wave (a step) or at zero (a start from zero, an end of
    digital silence for more than the 10 ms the page looks at)."""
    cols = [burst(seconds, seed=1 + c, freq=300.0 + 150.0 * c, amp=amp, edge_ms=0.0) for c in range(channels)]
    x = np.stack(cols, axis=1) + dc
    k = int(0.002 * SR)
    if not start_step:
        x[:k] *= np.linspace(0.0, 1.0, k)[:, None]
        x[0] = 0.0
    if not end_step:
        x[-int(0.012 * SR):] = 0.0
    return x


CASES = {
    'steps at both ends and a mean (the three steps)': dict(dc=0.003),
    'steps at both ends, no mean': dict(dc=0.0),
    'step at the start only': dict(dc=0.0, end_step=False),
    'step at the end only': dict(dc=0.0, start_step=False),
    'no step, a mean': dict(dc=0.003, start_step=False, end_step=False),
    'no step, no mean': dict(dc=0.0, start_step=False, end_step=False),
    'two channels, all three steps': dict(dc=0.002, channels=2),
    'two channels, no step': dict(dc=0.0, channels=2, start_step=False, end_step=False),
}


class PageFinishIsTheStepsOfTheScreen(unittest.TestCase):
    def test_the_constants_are_those_of_the_page_copy(self):
        self.assertEqual(build.PAGE_STEP_DB, screen.STEP_DB)
        self.assertEqual(build.PAGE_FADE_S, screen.FADE_S)
        self.assertEqual(build.PAGE_TAIL_S, screen.TAIL_CHECK_S)
        self.assertEqual(build.PAGE_RAMP_S, screen.RAMP_S)
        self.assertEqual(build.PAGE_DC_LIMIT, screen.DC_LIMIT)
        self.assertEqual(build.DOWNLOAD_SR, screen.OUT_SR)

    def test_page_finish_is_screen_finish_without_the_gain_for_every_branch(self):
        branches = set()
        for name, kw in CASES.items():
            with self.subTest(name):
                x = signal(**kw)
                want, fl = screen._finish(x.copy(), 0.0)
                got, mine = build.page_finish(x)
                self.assertEqual(got.shape, want.shape)
                self.assertTrue(np.array_equal(got, want))
                self.assertEqual((mine['fade'], mine['ramp']), (fl['fade'], fl['ramp']))
                self.assertEqual(mine['dcBefore'], fl['dcBefore'])
                self.assertEqual(mine['dcAfter'], fl['dcAfter'])
                branches.add((mine['fade'], mine['ramp'], mine['dcBefore'] >= build.PAGE_DC_LIMIT / 2))
        self.assertEqual(len(branches), 6)          # the cases reach fade, ramp and mean in more than one combination

    def test_page_finish_does_not_change_its_input(self):
        x = signal(dc=0.003)
        before = x.copy()
        build.page_finish(x)
        self.assertTrue(np.array_equal(x, before))

    def test_after_the_steps_the_end_is_silent_and_the_mean_is_under_the_limit(self):
        for name, kw in CASES.items():
            with self.subTest(name):
                y, _ = build.page_finish(signal(**kw))
                self.assertLess(np.abs(y.mean(axis=0)).max(), build.PAGE_DC_LIMIT / 2)
                tail = int(round(build.PAGE_TAIL_S * SR))
                self.assertLessEqual(np.abs(y[-tail:]).max(), 10.0 ** (build.PAGE_STEP_DB / 20.0))

    def test_every_step_is_linear_in_the_signal(self):
        x = signal(dc=0.003, amp=0.1)
        a, fa = build.page_finish(x)
        b, fb = build.page_finish(x * 0.9)
        self.assertEqual((fa['fade'], fa['ramp']), (fb['fade'], fb['ramp']))
        self.assertTrue(np.allclose(0.9 * a, b, rtol=0.0, atol=1e-12))


class ProcessGenerated(unittest.TestCase):
    def test_the_page_copy_path_gives_the_page_copy_times_one_gain(self):
        """The steps are decided on the level of the cut (the gain that set_loudness finds on it), then the loudness is set again:
        the result is screen._finish of the cut at that gain, times one more gain."""
        for name in CASES:
            with self.subTest(name):
                x = signal(seconds=1.2, **CASES[name])
                cut = (0.1, 1.1)
                y, info = build.process_generated(x, SR, cut, -20.0, page_copy=True)
                first, last = int(round(cut[0] * SR)), int(round(cut[1] * SR))
                prepared, _ = build.prepare_download(x[first:last], SR)
                _, lv = build.set_loudness(prepared, -20.0)
                want, fl = screen._finish(prepared, lv['gainDb'])
                self.assertEqual(y.shape, want.shape)
                self.assertEqual((info['pageFinish']['fade'], info['pageFinish']['ramp']), (fl['fade'], fl['ramp']))
                g = float((y * want).sum() / (want * want).sum())
                resid = y - g * want
                self.assertLess(10 * np.log10((resid ** 2).sum() / (y ** 2).sum()), -120.0)
                self.assertLess(abs(20 * np.log10(g)), 0.05)                      # the second gain only corrects the fade
                self.assertLessEqual(abs(info['level']['reached'] - (-20.0)), 0.02)

    def test_the_old_path_is_still_the_default_and_does_not_append_the_silence(self):
        x = signal(seconds=1.2, dc=0.003)
        old, _ = build.process_generated(x, SR, (0.1, 1.1), -30.0)
        new, _ = build.process_generated(x, SR, (0.1, 1.1), -30.0, page_copy=True)
        self.assertEqual(new.shape[0] - old.shape[0], int(round(build.PAGE_TAIL_S * SR)))
        self.assertGreater(np.abs(old.mean(axis=0)).max(), build.PAGE_DC_LIMIT / 2)        # the old path never took a mean out
        self.assertLess(np.abs(new.mean(axis=0)).max(), build.PAGE_DC_LIMIT / 2)

    def test_the_cut_is_the_nearest_sample_of_the_recorded_seconds(self):
        x = signal(seconds=1.0, dc=0.0)
        for start in (3128 / SR, round(3128 / SR, 9), 0.065166667):
            with self.subTest(start=start):
                y, _ = build.process_generated(x, SR, (start, 0.9), -30.0, page_copy=True)
                n = int(round(0.9 * SR)) - 3128
                self.assertEqual(y.shape[0], n + int(round(build.PAGE_RAMP_S * SR)) + int(round(build.PAGE_TAIL_S * SR)))
        # four decimals do not name that sample: 0.0652 s is sample 3129.6, which is the sample 3130
        y, _ = build.process_generated(x, SR, (0.0652, 0.9), -30.0, page_copy=True)
        self.assertEqual(y.shape[0], int(round(0.9 * SR)) - 3130 + int(round(build.PAGE_RAMP_S * SR)) + int(round(build.PAGE_TAIL_S * SR)))


class RoundSelectsThePath(Base):
    def one_round(self, rnd, x=None):
        x = signal(seconds=1.0, dc=0.003)[:, 0] if x is None else x
        sha = write_raw(self.raw, 'a.wav', x)
        it = item('g_a', sha, 'a.wav', cut=(0.0, 0.9))
        it['origin']['round'] = rnd
        self.write_list([it])
        entries, text = self.run_build()
        self.assertEqual(len(entries), 1, text)
        back, _ = sf.read(str(self.out / 'generated' / 'g_a.wav'), always_2d=True)
        return entries[0], back

    def test_a_sound_of_round_six_is_built_as_before_and_one_of_round_seven_as_its_page_copy(self):
        e6, b6 = self.one_round(6)
        e7, b7 = self.one_round(7)
        tail = int(round(build.PAGE_TAIL_S * SR))
        self.assertEqual(b7.shape[0] - b6.shape[0], tail)
        step = 10.0 ** (build.PAGE_STEP_DB / 20.0)
        self.assertLessEqual(float(np.abs(b7[-tail:]).max()), step)                  # silence; the 16 bit dither is at -90 dB
        self.assertGreater(float(np.abs(b6[-tail:]).max()), step)                    # the old path ends in the fade
        self.assertLess(abs(float(b7.mean())), build.PAGE_DC_LIMIT / 2)
        self.assertEqual(e6['checks']['leadInMs'], 1.5)
        self.assertEqual(e7['checks']['fadeOutMs'], 30.0)
        self.assertTrue(e6['checks']['pass'] and e7['checks']['pass'])

    def test_rated_from_page_copy_is_the_round_rule(self):
        for rnd, want in ((4, False), (6, False), (7, True), (8, True), ('7', False), (True, False), (None, False)):
            with self.subTest(round=rnd):
                self.assertIs(build.rated_from_page_copy({'round': rnd}), want)
        self.assertIs(build.rated_from_page_copy({}), False)


class IntentOfTwoChannels(Base):
    def test_the_intent_does_not_say_a_two_channel_level_is_the_loudness_of_the_event(self):
        from test_generated_derived import stereo
        entries, _ = self.one(stereo(), lufs=-25.24, cut=(0.0, 0.9))
        text = entries[0]['intent']
        self.assertEqual(entries[0]['channels'], 2)
        self.assertIn('set to -25.24 LUFS', text)
        self.assertNotIn('the loudness of that rendered event today', text)
        for word in ('one channel', 'two channels', 'about 3 dB'):
            self.assertIn(word, text)

    def test_the_intent_of_one_channel_is_the_old_one(self):
        entries, _ = self.one(lufs=-28.26)
        text = entries[0]['intent']
        self.assertIn('Level: the integrated loudness is set to -28.26 LUFS, the loudness of that rendered event today; provisional until the mix '
                      'of the game is designed. ', text)
        self.assertNotIn('two channels', text)

    def test_generated_intent_takes_the_channels_as_an_optional_argument(self):
        it = item('g_a', 'x')
        event = {'en': 'Hull hit, light'}
        self.assertEqual(build.generated_intent(it, event), build.generated_intent(it, event, 1))
        self.assertNotEqual(build.generated_intent(it, event, 2), build.generated_intent(it, event, 1))

    def test_a_two_channel_sound_of_a_two_channel_event_does_not_say_the_event_has_one_channel(self):
        it = item('g_a', 'x')
        text = build.generated_intent(it, {'en': 'Shield hit, light', 'channels': 2}, 2)
        self.assertIn('the loudness of that rendered event today', text)
        self.assertNotIn('The rendered event has one channel', text)
        self.assertIn('The rendered event has one channel', build.generated_intent(it, {'en': 'Thruster pulse C', 'channels': 1}, 2))


class RealList(unittest.TestCase):
    """The tracked list and the tracked raw files next to it."""

    @classmethod
    def setUpClass(cls):
        cls.raw_dir = ROOT / 'assets' / 'audio' / 'generated'
        cls.listing = json.loads((ROOT / 'assets' / 'audio' / 'generated.json').read_text(encoding='utf-8'))
        cls.page = [s for s in cls.listing['sounds'] if build.rated_from_page_copy(s['origin'])]

    def test_there_are_sounds_rated_from_a_page_copy(self):
        self.assertTrue(self.page)

    def test_the_cut_of_such_a_sound_lies_on_a_whole_sample_of_its_raw_file(self):
        """The page copy was cut at a sample; four decimals of a second name it only to within 2.4 samples at 48 kHz, so the list
        keeps enough decimals for the sample. Seen failing with the starts as the page recorded them (0.0652 for sample 3128)."""
        for s in self.page:
            sr = sf.info(str(self.raw_dir / s['file'])).samplerate
            for k in ('startS', 'endS'):
                with self.subTest(s['id'], key=k):
                    pos = float(s['cut'][k]) * sr
                    self.assertLess(abs(pos - round(pos)), 0.01)

    def test_the_built_copy_ends_in_silence_and_has_no_mean_that_the_page_would_refuse(self):
        """Built in memory from the tracked raw file, as _generated_sounds does it."""
        for s in self.page:
            with self.subTest(s['id']):
                data, sr = sf.read(str(self.raw_dir / s['file']), dtype='float32', always_2d=True)
                y, info = build.process_generated(data, sr, (float(s['cut']['startS']), float(s['cut']['endS'])), float(s['lufs']), page_copy=True)
                tail = int(round(build.PAGE_TAIL_S * sr))
                self.assertLessEqual(float(np.abs(y[-tail:]).max()), 10.0 ** (build.PAGE_STEP_DB / 20.0))
                self.assertLess(float(np.abs(y.mean(axis=0)).max()), build.PAGE_DC_LIMIT / 2)
                self.assertLessEqual(abs(info['level']['reached'] - float(s['lufs'])), 0.02)
                first, last = int(round(float(s['cut']['startS']) * sr)), int(round(float(s['cut']['endS']) * sr))
                self.assertEqual(y.shape[0], last - first + int(round(build.PAGE_TAIL_S * sr)) * int(info['pageFinish']['fade'])
                                 + int(round(build.PAGE_RAMP_S * sr)) * int(info['pageFinish']['ramp']))


if __name__ == '__main__':
    unittest.main()
