"""The exit code of tools/audio/build.py: a generated entry that is refused, missing or fails makes main
return a non-zero code, the other entries are still built, and the messages stay.

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

Small made-up raw files and lists in a temporary folder; main runs with --manifest-only, so no sound is
rendered, and nothing under assets/ is read or written (the paths of build.py are replaced for the test).
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_generated_build import SR, build, burst, common, item, measure, write_raw  # noqa: E402,F401


class ExitCode(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.raw = self.tmp / 'raw'
        self.raw.mkdir()
        self.out = self.tmp / 'out'
        self.listing = self.tmp / 'generated.json'
        saved = (build.GENERATED_LIST, build.GENERATED_DIR, build.SELECTION, build.DOWNLOADS)
        build.GENERATED_LIST, build.GENERATED_DIR = self.listing, self.raw
        build.SELECTION, build.DOWNLOADS = self.tmp / 'no_selection.json', self.tmp / 'no_downloads'
        self.addCleanup(lambda: (setattr(build, 'GENERATED_LIST', saved[0]), setattr(build, 'GENERATED_DIR', saved[1]),
                                 setattr(build, 'SELECTION', saved[2]), setattr(build, 'DOWNLOADS', saved[3])))
        self.addCleanup(self._tmp.cleanup)

    def write_list(self, items):
        self.listing.write_text(json.dumps({'note': 'test', 'sounds': items}), encoding='utf-8')

    def main(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = build.main(['--manifest-only', '--out', str(self.out)])
        return code, buf.getvalue()

    def manifest_ids(self):
        m = json.loads((self.out / 'manifest.json').read_text(encoding='utf-8'))
        return [s['id'] for s in m['sounds']]

    def good(self, sid='g_ok', name='ok.wav'):
        return item(sid, write_raw(self.raw, name, burst(edge_ms=5)), name)

    def test_a_good_list_exits_with_zero(self):
        self.write_list([self.good()])
        code, text = self.main()
        self.assertEqual(code, 0, text)
        self.assertEqual(self.manifest_ids(), ['g_ok'])
        self.assertNotIn('not built', text)

    def test_no_list_exits_with_zero(self):
        code, text = self.main()
        self.assertEqual(code, 0, text)

    def test_a_sha256_mismatch_is_refused_and_the_exit_code_is_not_zero(self):
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        write_raw(self.raw, 'a.wav', burst(edge_ms=5, seed=2))  # replaced after the list was written
        self.write_list([item('g_a', sha, 'a.wav'), self.good()])
        code, text = self.main()
        self.assertNotEqual(code, 0)
        self.assertIn('g_a refused', text)           # the message stays
        self.assertIn('sha256', text)
        self.assertEqual(self.manifest_ids(), ['g_ok'])  # the other entry is still built
        self.assertTrue((self.out / 'generated' / 'g_ok.wav').is_file())
        self.assertFalse((self.out / 'generated' / 'g_a.wav').exists())

    def test_a_missing_raw_file_gives_a_non_zero_exit_code_and_the_rest_is_built(self):
        self.write_list([item('g_a', 'ab' * 32, 'gone.wav'), self.good()])
        code, text = self.main()
        self.assertNotEqual(code, 0)
        self.assertIn('missing on disk: gone.wav', text)
        self.assertEqual(self.manifest_ids(), ['g_ok'])

    def test_an_entry_that_fails_with_an_exception_gives_a_non_zero_exit_code_and_the_rest_is_built(self):
        (self.raw / 'junk.wav').write_bytes(b'this is not audio')
        sha = hashlib.sha256(b'this is not audio').hexdigest()  # the sha256 matches, the decoder fails
        self.write_list([item('g_bad', sha, 'junk.wav'), self.good()])
        code, text = self.main()
        self.assertNotEqual(code, 0)
        self.assertIn('g_bad skipped', text)
        self.assertEqual(self.manifest_ids(), ['g_ok'])

    def test_the_other_refusals_count_as_well(self):
        good = self.good()
        self.write_list([good, dict(good, id='g_ok'), item('g_x', good['sha256'], 'ok.wav', stands_for='no_such_event')])
        code, text = self.main()
        self.assertNotEqual(code, 0)
        self.assertIn('listed twice', text)
        self.assertIn('which sounds.json does not know', text)
        self.assertEqual(self.manifest_ids(), ['g_ok'])

    def test_the_problem_lines_are_handed_to_the_caller_without_changing_the_return_type(self):
        sha = write_raw(self.raw, 'a.wav', burst(edge_ms=5))
        write_raw(self.raw, 'a.wav', burst(edge_ms=5, seed=2))
        self.write_list([item('g_a', sha, 'a.wav'), item('g_b', 'cd' * 32, 'gone.wav'), self.good()])
        problems = []
        with contextlib.redirect_stdout(io.StringIO()):
            entries = build._generated_sounds(self.out, measure, common, listing=self.listing, raw_dir=self.raw, problems=problems)
            again = build._generated_sounds(self.out, measure, common, listing=self.listing, raw_dir=self.raw)
        self.assertEqual([e['id'] for e in entries], ['g_ok'])
        self.assertEqual([e['id'] for e in again], ['g_ok'])
        self.assertEqual(len(problems), 2)
        self.assertTrue(any('g_a' in p and 'sha256' in p for p in problems), problems)
        self.assertTrue(any('gone.wav' in p for p in problems), problems)


class DownloadsAreNotChanged(unittest.TestCase):
    def test_a_missing_download_does_not_change_the_exit_code(self):
        """The download step keeps its behaviour: a download missing on disk is reported and skipped, exit code 0."""
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            sel = tmp / 'selection.json'
            sel.write_text(json.dumps([{'id': 'd_gone', 'category': 'switches', 'file': 'gone.wav', 'licence': 'CC0',
                                        'en': 'D', 'de': 'D', 'intent': 'x', 'kind': 'oneshot'}]), encoding='utf-8')
            saved = (build.GENERATED_LIST, build.SELECTION, build.DOWNLOADS)
            build.GENERATED_LIST, build.SELECTION, build.DOWNLOADS = tmp / 'none.json', sel, tmp / 'dl'
            try:
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    code = build.main(['--manifest-only', '--out', str(tmp / 'out')])
            finally:
                build.GENERATED_LIST, build.SELECTION, build.DOWNLOADS = saved
        self.assertEqual(code, 0, buf.getvalue())
        self.assertIn('download missing on disk', buf.getvalue())


if __name__ == '__main__':
    unittest.main()
