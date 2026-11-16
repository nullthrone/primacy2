"""Tests for the generated sounds in tools/audio/build.py (_generated_sounds, process_generated).

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

Small made-up raw files and lists in a temporary folder: nothing under assets/ is read or written.
The events the made-up sounds stand for are real ones of tools/audio/sounds.json.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
_spec = importlib.util.spec_from_file_location('build_gen_under_test', os.path.join(HERE, '..', 'build.py'))
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

import common  # noqa: E402  (build.py puts tools/audio/listen on the path)
import measure  # noqa: E402

SR = 48000
LICENCE = 'generated with MOSS-SoundEffect v2.0 (code and weights Apache-2.0)'


def burst(seconds=1.0, sr=SR, amp=0.5, seed=1, freq=300.0, edge_ms=0.0):
    """A noisy tone; with edge_ms it starts and ends at zero, otherwise it is cut mid-wave."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    x = amp * (0.6 * np.sin(2 * np.pi * freq * t + 0.7) + 0.4 * rng.standard_normal(t.size) * 0.5)
    if edge_ms:
        k = int(edge_ms * sr / 1000)
        w = np.ones(t.size)
        w[:k] = np.linspace(0, 1, k)
        w[-k:] = np.linspace(1, 0, k)
        x = x * w
    return x


def write_raw(folder, name, x, sr=SR):
    sf.write(str(Path(folder) / name), x, sr, subtype='PCM_16')
    return hashlib.sha256((Path(folder) / name).read_bytes()).hexdigest()


def item(sid, sha, file=None, cut=(0.0, 0.5), lufs=-30.0, stands_for='impact_hull_light', **kw):
    d = {
        'id': sid, 'standsFor': stands_for, 'file': file or sid + '.wav', 'sha256': sha,
        'cut': {'startS': cut[0], 'endS': cut[1]}, 'lufs': lufs,
        'en': 'Hull hit, light · MOSS', 'de': 'Rumpftreffer, leicht · MOSS',
        'origin': {'model': 'MOSS-SoundEffect v2.0', 'modelRevision': 'rev', 'code': 'code', 'codeCommit': 'commit',
                   'prompt': 'A wrench on a deck plate duration: 2.0s', 'seed': 15, 'round': 5,
                   'candidate': 'ev5_1_x_moss_p2s15', 'verdict': 'fits', 'ratedAt': '2026-11-16T16:49:57.364Z'},
        'licence': LICENCE,
    }
    d.update(kw)
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.raw = self.tmp / 'raw'
        self.raw.mkdir()
        self.out = self.tmp / 'out'
        self.listing = self.tmp / 'generated.json'

    def tearDown(self):
        self._tmp.cleanup()

    def write_list(self, items):
        self.listing.write_text(json.dumps({'note': 'test', 'sounds': items}), encoding='utf-8')

    def run_build(self, out=None):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            entries = build._generated_sounds(out or self.out, measure, common, listing=self.listing, raw_dir=self.raw)
        return entries, buf.getvalue()

    def one(self, x=None, sr=SR, **kw):
        x = burst(edge_ms=5.0) if x is None else x
        sha = write_raw(self.raw, 'a.wav', x, sr)
        self.write_list([item('g_a', sha, 'a.wav', **kw)])
        entries, text = self.run_build()
        return entries, text


class Refusals(Base):
    def test_a_raw_file_that_differs_from_its_sha256_is_refused_with_a_message(self):
        """Rule 3, first sentence: never build from another file. The entry is not built, the message names it."""
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        write_raw(self.raw, 'a.wav', burst(edge_ms=5, seed=2))  # the file is replaced after the list was written
        self.write_list([item('g_a', sha, 'a.wav')])
        entries, text = self.run_build()
        self.assertEqual(entries, [])
        self.assertIn('g_a', text)
        self.assertIn('sha256', text)
        self.assertIn('refused', text)
        self.assertFalse((self.out / 'generated' / 'g_a.wav').exists())

    def test_a_missing_raw_file_is_reported_and_skipped_and_the_others_are_built(self):
        """Rule 3: a raw file missing on disk is reported and skipped, like a missing download."""
        sha = write_raw(self.raw, 'b.wav', burst(edge_ms=5))
        self.write_list([item('g_a', 'ab' * 32, 'gone.wav'), item('g_b', sha, 'b.wav')])
        entries, text = self.run_build()
        self.assertEqual([e['id'] for e in entries], ['g_b'])
        self.assertIn('gone.wav', text)
        self.assertIn('missing', text)

    def test_an_event_that_sounds_json_does_not_know_is_refused(self):
        """Rule 5: category, kind, path and place come from the event it stands for; no event, no entry."""
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        self.write_list([item('g_a', sha, 'a.wav', stands_for='no_such_event')])
        entries, text = self.run_build()
        self.assertEqual(entries, [])
        self.assertIn('no_such_event', text)

    def test_without_a_list_nothing_happens(self):
        """Rule 3: the step is optional; a tree without generated.json builds as before and makes no folder."""
        entries, _ = self.run_build()
        self.assertEqual(entries, [])
        self.assertFalse((self.out / 'generated').exists())


class Processing(Base):
    def test_the_cut_is_the_recorded_cut_in_seconds(self):
        """Rule 3: cut as recorded. A loud burst outside the cut must not reach the copy; the length is the cut."""
        x = np.zeros(2 * SR)
        x[int(0.5 * SR): int(0.9 * SR)] = burst(0.4, edge_ms=10.0)
        x[int(1.5 * SR): int(1.7 * SR)] = 0.9 * burst(0.2, edge_ms=10.0, seed=5)  # outside the cut
        entries, _ = self.one(x, cut=(0.4, 1.0))
        back, sr = sf.read(str(self.out / 'generated' / 'g_a.wav'))
        self.assertEqual(sr, SR)
        self.assertEqual(back.shape[0], int(1.0 * SR) - int(0.4 * SR))   # quiet ends: no lead-in, no tail
        e = np.abs(back)
        self.assertGreater(e[int(0.1 * SR): int(0.5 * SR)].max(), 0.01)  # the part inside is there
        self.assertAlmostEqual(entries[0]['duration'], 0.6, places=3)

    def test_the_cut_is_taken_at_the_nearest_sample(self):
        """Rule 3: cut as recorded. The seconds are sample positions written with four decimals: 3.8006 s at
        48 kHz is 182428.8, so the cut ends at sample 182429 (int() would drop it to 182428)."""
        x = np.zeros(4 * SR)
        x[SR: 2 * SR] = burst(1.0, edge_ms=10.0)          # silent at both ends of the cut: no repair adds samples
        y, _ = build.process_generated(x.reshape(-1, 1), SR, (0.1, 3.8006), -30.0)
        self.assertEqual(y.shape[0], 182429 - 4800)

    def test_the_copy_is_48_khz_whatever_the_raw_file_is(self):
        """Rule 3: 48 kHz. A raw file at 44.1 kHz comes out at 48 kHz with the same length in seconds."""
        x = burst(1.0, sr=44100, edge_ms=5.0)
        entries, _ = self.one(x, sr=44100, cut=(0.0, 0.5))
        info = sf.info(str(self.out / 'generated' / 'g_a.wav'))
        self.assertEqual(info.samplerate, SR)
        self.assertAlmostEqual(entries[0]['duration'], 0.5, places=2)

    def test_no_step_at_either_end(self):
        """Rule 3: no step at either end. A cut in the middle of a loud tone starts and ends at exactly zero."""
        x = burst(1.0, edge_ms=0.0)           # loud and not at zero at the cut
        entries, _ = self.one(x, cut=(0.2, 0.7))
        back, _ = sf.read(str(self.out / 'generated' / 'g_a.wav'))
        lsb = 1.0 / 32768           # the 16 bit dither may leave one step
        self.assertLessEqual(abs(back[0]), 2 * lsb)
        self.assertLessEqual(abs(back[-1]), 2 * lsb)
        y, _ = build.process_generated(x.reshape(-1, 1), SR, (0.2, 0.7), -30.0)
        self.assertEqual((y[0, 0], y[-1, 0]), (0.0, 0.0))
        c = entries[0]['checks']
        self.assertEqual(c['leadInMs'], 1.5)
        self.assertTrue(c['fadeOutMs'] > 0 or c['appendedTailMs'] > 0)

    def test_quiet_ends_are_left_alone(self):
        """Rule 3: the edge repair is the one of the download step: an end that is already silent is not touched."""
        pad = np.zeros(SR // 10)
        entries, _ = self.one(np.concatenate([pad, burst(0.8, edge_ms=20.0), pad]), cut=(0.0, 1.0))
        c = entries[0]['checks']
        self.assertEqual((c['leadInMs'], c['fadeOutMs'], c['appendedTailMs']), (0.0, 0.0, 0.0))
        self.assertEqual(entries[0]['duration'], 1.0)

    def test_the_loudness_is_the_target_measured_after_the_gain(self):
        """Rule 3: the integrated loudness of the shipped file is the entry's lufs within 0.1 LU, and the
        checks say target, reached and that the ceiling did not stop it."""
        for target in (-30.0, -24.0):
            with self.subTest(target=target):
                entries, _ = self.one(burst(0.8, edge_ms=10.0, amp=0.9), lufs=target, cut=(0.0, 0.7))
                back, sr = sf.read(str(self.out / 'generated' / 'g_a.wav'), always_2d=True)
                measured = measure.loudness_lufs(back, sr)[0]
                self.assertLessEqual(abs(measured - target), 0.1)
                lv = entries[0]['checks']['level']
                self.assertEqual(lv['target'], target)
                self.assertLessEqual(abs(lv['reached'] - target), 0.1)
                self.assertIs(lv['limited'], False)
                self.assertEqual(entries[0]['checks']['lufs'], lv['reached'])
                self.assertTrue(entries[0]['checks']['pass'])

    def test_a_quiet_sound_is_measured_again_after_the_gain(self):
        """Rule 3, 'measured again after the gain': a sound with a quiet tail loses blocks to the absolute
        gate when it is made much quieter, so one gain from the first measurement misses. The result still lands."""
        x = np.concatenate([burst(0.5, edge_ms=5.0, amp=0.9), 0.00002 * burst(2.0, seed=3)])
        entries, _ = self.one(x, lufs=-50.0, cut=(0.0, 2.5))
        lv = entries[0]['checks']['level']
        self.assertLessEqual(abs(lv['reached'] - lv['target']), 0.1)

    def test_the_ceiling_stops_the_level_and_the_checks_say_so(self):
        """Rule 3: unless the true-peak ceiling stops it. A click on a bed of faint noise cannot reach a loud
        target below the ceiling: the true peak stays at or under -1 dB, limited is true, reached is under target."""
        x = 0.002 * burst(1.0, seed=4, edge_ms=10.0)
        x[24000] = 0.9
        entries, _ = self.one(x, lufs=-12.0, cut=(0.0, 1.0))
        e = entries[0]
        lv = e['checks']['level']
        self.assertIs(lv['limited'], True)
        self.assertLess(lv['reached'], lv['target'] - 0.1)
        self.assertLessEqual(e['checks']['peakDb'], -1.0)
        self.assertIn('level-limited-by-ceiling', e['checks']['hints'])
        self.assertNotIn('level-missed', e['checks']['failed'])

    def test_two_runs_give_the_same_bytes(self):
        """Rule 3: deterministic. The processed copy and the entry are identical for two builds."""
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=0.0))
        self.write_list([item('g_a', sha, 'a.wav', cut=(0.1, 0.6))])
        e1, _ = self.run_build(self.tmp / 'o1')
        e2, _ = self.run_build(self.tmp / 'o2')
        b1 = (self.tmp / 'o1' / 'generated' / 'g_a.wav').read_bytes()
        b2 = (self.tmp / 'o2' / 'generated' / 'g_a.wav').read_bytes()
        self.assertEqual(b1, b2)
        self.assertEqual(e1, e2)

    def test_the_raw_file_is_not_changed(self):
        """Rule 1: the committed raw file is only read."""
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=0.0))
        self.write_list([item('g_a', sha, 'a.wav')])
        self.run_build()
        self.assertEqual(hashlib.sha256((self.raw / 'a.wav').read_bytes()).hexdigest(), sha)


class Housekeeping(Base):
    def test_copies_no_longer_in_the_list_are_removed_like_downloads(self):
        """Rule 3: processed copies no longer in the list are removed (wav, png, json); downloads are not touched."""
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        folder = self.out / 'generated'
        folder.mkdir(parents=True)
        for ext in ('.wav', '.png', '.json'):
            (folder / ('g_old' + ext)).write_bytes(b'x')
        (self.out / 'downloads').mkdir()
        (self.out / 'downloads' / 'keep.wav').write_bytes(b'x')
        self.write_list([item('g_a', sha, 'a.wav')])
        self.run_build()
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ['g_a.png', 'g_a.wav'])
        self.assertTrue((self.out / 'downloads' / 'keep.wav').exists())


class Entry(Base):
    def test_the_manifest_entry_follows_decision_5(self):
        """Rule 5: source generated; category, kind, path, place of the event; en and de from the list; intent says
        prompt, seed, round, accepted, when, which event, the level rule; dry false; the generated object."""
        entries, _ = self.one()
        e = entries[0]
        spec = build.synth.load_spec()['sounds']['impact_hull_light']
        self.assertEqual(e['source'], 'generated')
        self.assertEqual((e['category'], e['kind'], e['path'], e['place']), (spec['category'], spec['kind'], spec['path'], spec['place']))
        self.assertEqual(e['id'], 'g_a')
        self.assertEqual(e['file'], 'generated/g_a.wav')
        self.assertEqual(e['spectrogram'], 'generated/g_a.png')
        self.assertTrue((self.out / e['spectrogram']).is_file())
        self.assertEqual(e['en'], 'Hull hit, light · MOSS')
        self.assertEqual(e['de'], 'Rumpftreffer, leicht · MOSS')
        self.assertIs(e['dry'], False)
        self.assertEqual(e['licence'], LICENCE)
        self.assertEqual(e['hash'], build.file_hash(self.out / e['file']))
        for text in ('A wrench on a deck plate', 'seed 15', 'round 5', 'accepted', '2026-11-16T16:49:57.364Z',
                     'impact_hull_light', '-30.00 LUFS', 'provisional'):
            self.assertIn(text, e['intent'])
        g = e['generated']
        self.assertEqual((g['standsFor'], g['model'], g['seed'], g['round'], g['candidate']),
                         ('impact_hull_light', 'MOSS-SoundEffect v2.0', 15, 5, 'ev5_1_x_moss_p2s15'))
        self.assertEqual(g['prompt'], 'A wrench on a deck plate duration: 2.0s')
        self.assertEqual(g['sha256'], hashlib.sha256((self.raw / 'a.wav').read_bytes()).hexdigest())

    def test_validate_accepts_it_and_demands_what_decision_5_lists(self):
        """Rule 5: validate_manifest accepts a generated entry and refuses one without spectrogram, licence,
        duration, a true peak at or under -1 dB, or the generated object with its seven fields."""
        entries, _ = self.one()
        good = {'version': 1, 'categories': [{'id': entries[0]['category'], 'en': 'x', 'de': 'x'}], 'sounds': entries}
        self.assertEqual(build.validate_manifest(good, self.out), [])

        def broken(mutate):
            m = json.loads(json.dumps(good))
            mutate(m['sounds'][0])
            return build.validate_manifest(m, self.out)

        self.assertTrue(any('spectrogram' in p for p in broken(lambda s: s.pop('spectrogram'))))
        self.assertTrue(any('spectrogram' in p for p in broken(lambda s: s.update(spectrogram='generated/none.png'))))
        self.assertTrue(any('licence' in p for p in broken(lambda s: s.update(licence=''))))
        self.assertTrue(any('duration' in p for p in broken(lambda s: s.update(duration=0))))
        self.assertTrue(any('true peak' in p for p in broken(lambda s: s['checks'].update(peakDb=-0.5))))
        self.assertTrue(any('generated' in p for p in broken(lambda s: s.pop('generated'))))
        for k in ('standsFor', 'model', 'prompt', 'seed', 'round', 'candidate', 'sha256'):
            with self.subTest(missing=k):
                self.assertTrue(any('generated.' + k in p for p in broken(lambda s: s['generated'].pop(k))))


class Assembly(Base):
    def patch(self):
        self._saved = (build.GENERATED_LIST, build.GENERATED_DIR, build.SELECTION, build.DOWNLOADS)
        build.GENERATED_LIST, build.GENERATED_DIR = self.listing, self.raw
        self.addCleanup(lambda: (setattr(build, 'GENERATED_LIST', self._saved[0]), setattr(build, 'GENERATED_DIR', self._saved[1]),
                                 setattr(build, 'SELECTION', self._saved[2]), setattr(build, 'DOWNLOADS', self._saved[3])))

    def make_download(self):
        dl = self.tmp / 'dl'
        dl.mkdir()
        sf.write(str(dl / 'd.wav'), burst(1.0, edge_ms=0.0, seed=9), SR, subtype='PCM_16')
        sel = self.tmp / 'selection.json'
        sel.write_text(json.dumps([{'id': 'd_one', 'category': 'switches', 'file': 'd.wav', 'licence': 'CC0',
                                    'en': 'D', 'de': 'D', 'intent': 'x', 'kind': 'oneshot', 'excerpt': [0.0, 0.8]}]), encoding='utf-8')
        build.SELECTION, build.DOWNLOADS = sel, dl

    def fake_synth(self, out):
        """A rendered sound as an earlier build leaves it: wav plus the small json."""
        (out / 'impacts').mkdir(parents=True)
        sf.write(str(out / 'impacts' / 'impact_hull_light.wav'), burst(0.5, edge_ms=5), SR, subtype='PCM_16')
        m = {'id': 'impact_hull_light', 'file': 'impacts/impact_hull_light.wav', 'spectrogram': 'impacts/impact_hull_light.png',
             'category': 'impacts', 'kind': 'oneshot', 'path': 'structure', 'en': 'e', 'de': 'd', 'intent': 'i', 'source': 'synth',
             'licence': 'x', 'duration': 0.5, 'channels': 1, 'gain': 1.0, 'dry': False, 'hash': 'abcdef123456',
             'checks': {'pass': True, 'failed': [], 'peakDb': -9, 'lufs': -30, 'lowShare': 0, 'highShare': 0}}
        (out / 'impacts' / 'impact_hull_light.json').write_text(json.dumps({'manifest': m}), encoding='utf-8')
        (out / 'impacts' / 'impact_hull_light.png').write_bytes(b'png')

    def test_the_generated_sounds_sit_after_the_rendered_ones_and_before_the_downloads(self):
        """Rule 5: placed after the rendered sounds and before the downloads; the others keep id, place and hash."""
        self.patch()
        self.make_download()
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        self.write_list([item('g_a', sha, 'a.wav')])
        self.fake_synth(self.out)
        m = build.assemble_manifest(self.out, measure, common)
        self.assertEqual([(s['id'], s['source']) for s in m['sounds']],
                         [('impact_hull_light', 'synth'), ('g_a', 'generated'), ('d_one', 'download')])
        self.assertEqual(m['sounds'][0]['hash'], 'abcdef123456')
        self.assertEqual(build.validate_manifest(m, self.out), [])

    def test_the_processed_downloads_are_the_same_bytes_with_and_without_a_generated_list(self):
        """Rule 3, last sentence of the download step: adding the generated step changes nothing a download gives."""
        self.patch()
        self.make_download()
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        self.write_list([item('g_a', sha, 'a.wav')])
        with_list = self.tmp / 'with'
        without = self.tmp / 'without'
        build.assemble_manifest(with_list, measure, common)
        build.GENERATED_LIST = self.tmp / 'no_such_list.json'
        build.assemble_manifest(without, measure, common)
        a = (with_list / 'downloads' / 'd_one.wav').read_bytes()
        b = (without / 'downloads' / 'd_one.wav').read_bytes()
        self.assertEqual(a, b)
        self.assertTrue((with_list / 'generated' / 'g_a.wav').is_file())
        self.assertFalse((without / 'generated').exists())
        ids = lambda o: [s['id'] for s in json.loads((o / 'manifest.json').read_text(encoding='utf-8'))['sounds']]  # noqa: E731
        self.assertEqual(ids(with_list), ['g_a', 'd_one'])
        self.assertEqual(ids(without), ['d_one'])

    def test_repair_of_the_ends_gives_a_download_what_it_always_gave(self):
        """Rule 3, 'without changing what the download step gives': process_download of a one-shot with a
        step at both ends still gets the 1.5 ms lead-in and the 30 ms fade-out."""
        x = burst(1.0, edge_ms=0.0, amp=0.8)
        y, info = build.process_download(x, SR, 'oneshot', 'switches')
        self.assertEqual((info['leadInMs'], info['fadeOutMs'], info['appendedTailMs']), (1.5, 30.0, 0.0))
        self.assertEqual(y.shape[0], x.shape[0] + 72)
        self.assertEqual((y[0, 0], y[-1, 0]), (0.0, 0.0))


if __name__ == '__main__':
    unittest.main()
