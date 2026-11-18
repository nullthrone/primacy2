"""Tests for the derived sounds and the two-channel sounds of the generated library (tools/audio/build.py).

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

A derived entry of assets/audio/generated.json has the optional object "derived": the committed parent file (name and
sha256), the parent's round, candidate and verdict, the list of operations of tools/sound/derive.py exactly as it was
made, and the numbers each operation reported. The build checks the parent file, builds the sound from the committed raw
file of the entry (never from the parent, never by running the operations again) and carries the object to the manifest.

Made-up files and lists in a temporary folder, except the class RealList, which reads the tracked files of the repository
(assets/audio/generated.json and the raw and parent files next to it) and nothing else: never assets/audio/gen,
assets/audio/render or assets/audio/ratings.json.
"""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_generated_build import Base, SR, build, burst, common, item, measure, write_raw  # noqa: E402

ROOT = Path(HERE).resolve().parents[2]


def derived_obj(parent_sha, parent_file='parent.wav', **kw):
    d = {
        'parentFile': parent_file, 'parentSha256': parent_sha, 'parentRound': 6,
        'parentCandidate': 'ev6_2_thruster_mighty_2_moss_p3s11', 'parentVerdict': 'close',
        'process': [{'op': 'room', 'rt60S': 0.9, 'wetDb': -9.0, 'channels': 1, 'seed': 7}],
        'operations': [{'op': 'room', 'wetDryDbAsked': -9.0, 'wetDryDbReached': -9.0, 'irLengthS': 1.35,
                        'channels': 1, 'outputGainDb': -2.1105}],
    }
    d.update(kw)
    return d


def stereo(seconds=1.0, edge_ms=5.0):
    """Two decorrelated channels: a different noisy tone in each."""
    a = burst(seconds, seed=1, freq=300.0, edge_ms=edge_ms)
    b = burst(seconds, seed=2, freq=450.0, edge_ms=edge_ms)
    return np.stack([a, b], axis=1)


class DerivedBase(Base):
    def make(self, **kw):
        """A raw file and its parent in the raw folder, and a list with one derived entry."""
        psha = write_raw(self.raw, 'parent.wav', burst(edge_ms=5, seed=3))
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        d = derived_obj(psha, **kw.pop('derived', {}))
        it = item('g_a', sha, 'a.wav', derived=d, **kw)
        it['origin'].update(round=7, candidate='ev7_1_thruster_room_1_derived_r6p3s11a', prompt='The prompt of the parent', seed=11)
        self.write_list([it])
        return it

    def build_main(self):
        """build.main on the temporary tree, as test_build_exit_code does it."""
        saved = (build.GENERATED_LIST, build.GENERATED_DIR, build.SELECTION, build.DOWNLOADS)
        build.GENERATED_LIST, build.GENERATED_DIR = self.listing, self.raw
        build.SELECTION, build.DOWNLOADS = self.tmp / 'no_selection.json', self.tmp / 'no_downloads'
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = build.main(['--manifest-only', '--out', str(self.out)])
            return code, buf.getvalue()
        finally:
            build.GENERATED_LIST, build.GENERATED_DIR, build.SELECTION, build.DOWNLOADS = saved


class DerivedEntries(DerivedBase):
    def test_a_derived_entry_with_a_matching_parent_is_built_from_its_own_raw_file(self):
        it = self.make()
        entries, text = self.run_build()
        self.assertEqual([e['id'] for e in entries], ['g_a'], text)
        self.assertEqual(text, '')
        # the same entry without the object gives the same bytes: the sound is built from the raw file, not from the parent
        plain = {k: v for k, v in it.items() if k != 'derived'}
        self.write_list([plain])
        again, _ = self.run_build(self.tmp / 'o2')
        self.assertEqual((self.out / 'generated' / 'g_a.wav').read_bytes(), (self.tmp / 'o2' / 'generated' / 'g_a.wav').read_bytes())
        self.assertNotIn('derived', again[0]['generated'])
        # the parent file is not a sound of the library: nothing is built from it
        self.assertEqual(sorted(p.name for p in (self.out / 'generated').iterdir()), ['g_a.png', 'g_a.wav'])

    def test_a_parent_file_that_an_entry_names_is_not_reported(self):
        self.make()
        _, text = self.run_build()
        self.assertNotIn('parent', text)
        self.assertNotIn('stray', text)

    def test_a_parent_with_another_sha256_refuses_the_entry_and_the_build_returns_one(self):
        it = self.make()
        write_raw(self.raw, 'parent.wav', burst(edge_ms=5, seed=4))     # the parent is replaced after the list was written
        entries, text = self.run_build()
        self.assertEqual(entries, [])
        for word in ('g_a', 'refused', 'parent', 'sha256', 'parent.wav'):
            self.assertIn(word, text)
        self.assertFalse((self.out / 'generated' / 'g_a.wav').exists())
        code, text = self.build_main()
        self.assertEqual(code, 1, text)
        self.assertIn('g_a refused', text)
        self.assertEqual(it['derived']['parentFile'], 'parent.wav')

    def test_a_missing_parent_refuses_the_entry_and_the_build_returns_one(self):
        self.make()
        (self.raw / 'parent.wav').unlink()
        entries, text = self.run_build()
        self.assertEqual(entries, [])
        self.assertIn('g_a refused', text)
        self.assertIn('parent file parent.wav is missing', text)
        code, text = self.build_main()
        self.assertEqual(code, 1, text)

    def test_the_other_entries_are_still_built_when_a_parent_is_wrong(self):
        self.make()
        good = item('g_ok', write_raw(self.raw, 'ok.wav', burst(edge_ms=5, seed=5)), 'ok.wav')
        listing = json.loads(self.listing.read_text(encoding='utf-8'))
        listing['sounds'].append(good)
        self.listing.write_text(json.dumps(listing), encoding='utf-8')
        (self.raw / 'parent.wav').unlink()
        entries, _ = self.run_build()
        self.assertEqual([e['id'] for e in entries], ['g_ok'])

    def test_the_object_that_is_not_well_formed_is_a_problem(self):
        good = derived_obj('ab' * 32)
        self.assertIsNone(build._generated_entry_problem(item('g_a', 'x', derived=good)))
        self.assertIsNone(build._generated_entry_problem(item('g_a', 'x')))     # the object is optional

        def bad(**kw):
            return build._generated_entry_problem(item('g_a', 'x', derived=derived_obj('ab' * 32, **kw)))

        cases = {
            'not an object': dict(raw='nope'),
            'a path in the parent file': dict(parentFile='../raw/parent.wav'),
            'a folder in the parent file': dict(parentFile='sub/parent.wav'),
            'a backslash in the parent file': dict(parentFile='sub\\parent.wav'),
            'a parent file that is no wav': dict(parentFile='parent.txt'),
            'a parent file that is not text': dict(parentFile=5),
            'a short sha256': dict(parentSha256='abc'),
            'an upper case sha256': dict(parentSha256='AB' * 32),
            'a round that is text': dict(parentRound='6'),
            'a round that is a flag': dict(parentRound=True),
            'an empty candidate': dict(parentCandidate=''),
            'a verdict that is a number': dict(parentVerdict=3),
            'no process': dict(process=[]),
            'a process that is not a list': dict(process={'op': 'room'}),
            'an operation without a name': dict(process=[{'rt60S': 1}]),
            'operations that are not a list': dict(operations='room'),
            'operations of another number': dict(operations=[{'op': 'room'}, {'op': 'shelf'}]),
            'operations in another order': dict(operations=[{'op': 'shelf'}]),
        }
        for name, kw in cases.items():
            with self.subTest(name):
                if 'raw' in kw:
                    why = build._generated_entry_problem(item('g_a', 'x', derived=kw['raw']))
                else:
                    why = bad(**kw)
                self.assertIsInstance(why, str)
                self.assertIn('derived', why)
        for k in build.GENERATED_DERIVED_KEYS:
            with self.subTest(missing=k):
                d = derived_obj('ab' * 32)
                d.pop(k)
                self.assertIn('derived.' + k, build._generated_entry_problem(item('g_a', 'x', derived=d)))

    def test_an_entry_with_a_malformed_object_is_refused_and_not_built(self):
        it = self.make()
        it['derived']['parentFile'] = '../parent.wav'
        self.write_list([it])
        entries, text = self.run_build()
        self.assertEqual(entries, [])
        self.assertIn('g_a refused', text)
        self.assertIn('derived.parentFile', text)
        code, _ = self.build_main()
        self.assertEqual(code, 1)

    def test_the_manifest_object_carries_the_new_object_and_validate_accepts_it(self):
        it = self.make()
        entries, _ = self.run_build()
        g = entries[0]['generated']
        self.assertEqual(g['derived'], it['derived'])
        for k in ('standsFor', 'model', 'prompt', 'seed', 'round', 'candidate', 'sha256', 'rawFile'):    # what it carried before
            self.assertIn(k, g)
        self.assertEqual(g['prompt'], 'The prompt of the parent')
        good = {'version': 1, 'categories': [{'id': entries[0]['category'], 'en': 'x', 'de': 'x'}], 'sounds': entries}
        self.assertEqual(build.validate_manifest(good, self.out), [])
        m = json.loads(json.dumps(good))
        m['sounds'][0]['generated']['derived']['parentSha256'] = 'zz'
        self.assertTrue(any('generated.derived.parentSha256' in p for p in build.validate_manifest(m, self.out)))
        m = json.loads(json.dumps(good))
        del m['sounds'][0]['generated']['derived']
        self.assertEqual(build.validate_manifest(m, self.out), [])          # without it the entry is what it always was

    def test_an_entry_without_the_object_has_no_derived_in_the_manifest(self):
        entries, _ = self.one()
        self.assertNotIn('derived', entries[0]['generated'])

    def test_the_intent_says_which_parent_and_which_operations_with_their_numbers_from_the_data(self):
        it = self.make()
        entries, _ = self.run_build()
        text = entries[0]['intent']
        for part in ('ev6_2_thruster_mighty_2_moss_p3s11', 'round 6', 'close', 'parent.wav', it['derived']['parentSha256'],
                     'The prompt of the parent', 'seed 11', 'room (rt60S 0.9, wetDb -9.0, channels 1, seed 7, wetDryDbAsked -9.0, '
                     'wetDryDbReached -9.0, irLengthS 1.35, outputGainDb -2.1105)', 'ev7_1_thruster_room_1_derived_r6p3s11a',
                     'round 7', 'accepted', 'impact_hull_light', '-30.00 LUFS', 'provisional'):
            self.assertIn(part, text)
        # nothing is a literal of the code: other data, other sentence
        it['derived']['process'] = [{'op': 'pitch', 'semitones': 3.0}, {'op': 'shelf', 'hz': 300.0, 'gainDb': 8.0}]
        it['derived']['operations'] = [{'op': 'pitch', 'semitones': 3.0, 'factor': 1.189207, 'ratioUsed': '1169/983'},
                                       {'op': 'shelf', 'hz': 300.0, 'gainDb': 8.0, 'outputGainDb': -3.6909}]
        it['derived']['parentCandidate'] = 'ev6_3_shield_tight_2_moss_p2s11'
        self.write_list([it])
        other, _ = self.run_build()
        text = other[0]['intent']
        self.assertIn('pitch (semitones 3.0, factor 1.189207, ratioUsed 1169/983); shelf (hz 300.0, gainDb 8.0, outputGainDb -3.6909)', text)
        self.assertIn('ev6_3_shield_tight_2_moss_p2s11', text)
        self.assertNotIn('room (', text)
        self.assertNotIn('rt60S', text)

    def test_the_intent_of_an_entry_without_the_object_is_the_old_one_and_says_nothing_of_a_parent(self):
        entries, _ = self.one()
        text = entries[0]['intent']
        self.assertTrue(text.startswith('Generated with MOSS-SoundEffect v2.0. Prompt: "A wrench on a deck plate duration: 2.0s" (seed 15, round 5, candidate ev5_1_x_moss_p2s15). '))
        self.assertTrue(text.endswith('provisional until the mix of the game is designed. The owner heard the candidate at a lower level.'))
        self.assertNotIn('parent', text)

    def test_from_round_seven_on_the_intent_does_not_say_the_candidate_was_heard_lower(self):
        """The candidates of rounds 4 to 6 were heard at -34 or -35 LUFS; those of round 7 at about the library level."""
        for rnd, lower in ((6, True), (7, False)):
            with self.subTest(round=rnd):
                sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
                it = item('g_a', sha, 'a.wav')
                it['origin']['round'] = rnd
                self.write_list([it])
                entries, _ = self.run_build()
                self.assertEqual('heard the candidate at a lower level' in entries[0]['intent'], lower)


class TwoChannels(Base):
    def test_a_two_channel_raw_file_builds_as_a_two_channel_copy_at_its_level(self):
        for target in (-25.24, -30.0):
            with self.subTest(target=target):
                entries, text = self.one(stereo(), lufs=target, cut=(0.0, 0.9))
                self.assertEqual(len(entries), 1, text)
                e = entries[0]
                path = self.out / 'generated' / 'g_a.wav'
                self.assertEqual(sf.info(str(path)).channels, 2)
                self.assertEqual(e['channels'], 2)
                back, sr = sf.read(str(path), always_2d=True)
                self.assertEqual(back.shape[1], 2)
                self.assertFalse(np.allclose(back[:, 0], back[:, 1]))        # the two channels were not mixed into one
                self.assertLessEqual(abs(measure.loudness_lufs(back, sr)[0] - target), 0.1)
                lv = e['checks']['level']
                self.assertEqual(lv['target'], target)
                self.assertLessEqual(abs(lv['reached'] - target), 0.1)
                self.assertIs(lv['limited'], False)
                self.assertTrue(e['checks']['pass'], e['checks'])
                self.assertTrue((self.out / e['spectrogram']).is_file())

    def test_a_two_channel_file_keeps_its_ends_repaired_in_both_channels(self):
        x = stereo(edge_ms=0.0)
        y, info = build.process_generated(x, SR, (0.1, 0.8), -30.0)
        self.assertEqual(y.shape[1], 2)
        self.assertEqual(tuple(y[0]), (0.0, 0.0))
        self.assertEqual(tuple(y[-1]), (0.0, 0.0))

    def test_the_manifest_entry_of_a_two_channel_sound_is_valid(self):
        entries, _ = self.one(stereo(), lufs=-25.24, cut=(0.0, 0.9))
        good = {'version': 1, 'categories': [{'id': entries[0]['category'], 'en': 'x', 'de': 'x'}], 'sounds': entries}
        self.assertEqual(build.validate_manifest(good, self.out), [])
        self.assertEqual(entries[0]['channels'], 2)


def _load_derive():
    spec = importlib.util.spec_from_file_location('derive_under_test', ROOT / 'tools' / 'sound' / 'derive.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class RealList(unittest.TestCase):
    """The tracked list and the tracked raw and parent files next to it."""

    @classmethod
    def setUpClass(cls):
        cls.raw_dir = ROOT / 'assets' / 'audio' / 'generated'
        cls.listing = json.loads((ROOT / 'assets' / 'audio' / 'generated.json').read_text(encoding='utf-8'))
        cls.entries = list(cls.listing['sounds']) + list(cls.listing['withdrawn'])
        cls.derived = [s for s in cls.listing['sounds'] if 'derived' in s]

    def test_every_entry_is_well_formed_and_its_files_are_what_the_list_says(self):
        spec = build.synth.load_spec()['sounds']
        ids = [s['id'] for s in self.entries]
        self.assertEqual(len(ids), len(set(ids)))
        for s in self.entries:
            with self.subTest(s['id']):
                self.assertIsNone(build._generated_entry_problem(s))
                self.assertIn(s['standsFor'], spec)
                self.assertEqual(hashlib.sha256((self.raw_dir / s['file']).read_bytes()).hexdigest(), s['sha256'])

    def test_there_are_derived_entries_and_each_names_a_parent_that_is_there_unchanged(self):
        self.assertTrue(self.derived)
        for s in self.derived:
            d = s['derived']
            with self.subTest(s['id']):
                self.assertEqual(hashlib.sha256((self.raw_dir / d['parentFile']).read_bytes()).hexdigest(), d['parentSha256'])
                self.assertNotEqual(d['parentFile'], s['file'])
                self.assertLess(d['parentRound'], s['origin']['round'])

    def test_the_prompt_and_seed_of_a_derived_entry_are_those_of_its_parent_and_the_same_for_one_parent(self):
        by_parent = {}
        for s in self.derived:
            by_parent.setdefault(s['derived']['parentFile'], set()).add((s['origin']['prompt'], s['origin']['seed'], s['derived']['parentCandidate']))
        for parent, kinds in by_parent.items():
            with self.subTest(parent):
                self.assertEqual(len(kinds), 1)

    def test_every_file_next_to_the_raw_files_is_an_entry_or_the_parent_of_one(self):
        """No stray file: a parent file that an entry names belongs there. (The build reports no stray files; this keeps the
        folder in step with the list.)"""
        named = {s['file'] for s in self.entries} | {s['derived']['parentFile'] for s in self.entries if 'derived' in s}
        have = {p.name for p in self.raw_dir.iterdir()}
        self.assertEqual(have - named, set())
        self.assertEqual(named - have, set())

    def test_every_derived_entry_is_reproduced_sample_for_sample_from_its_parent(self):
        """derive.apply_process on the committed parent (float64, first channel) gives, as float32, the float32 samples of the
        committed raw file exactly. Samples, not file hashes: the writer puts a time stamp in the header."""
        derive = _load_derive()
        for s in self.derived:
            d = s['derived']
            with self.subTest(s['id']):
                x, sr = sf.read(str(self.raw_dir / d['parentFile']), dtype='float64', always_2d=True)
                y, done = derive.apply_process(x[:, 0], int(sr), d['process'])
                want, sr_raw = sf.read(str(self.raw_dir / s['file']), dtype='float32', always_2d=True)
                self.assertEqual(sr_raw, sr)
                got = np.asarray(y, dtype=np.float32)
                self.assertEqual(got.shape, want.shape)
                self.assertTrue(np.array_equal(got, want))
                self.assertEqual(json.loads(json.dumps(done)), d['operations'])

    def test_a_derived_sound_of_two_channels_is_listed_with_two_channels_in_its_process(self):
        for s in self.derived:
            channels = sf.info(str(self.raw_dir / s['file'])).channels
            asked = [p['channels'] for p in s['derived']['process'] if p['op'] == 'room']
            with self.subTest(s['id']):
                self.assertEqual(channels, asked[-1] if asked else 1)


if __name__ == '__main__':
    unittest.main()
