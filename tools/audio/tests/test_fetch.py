"""Tests for tools/audio/fetch.py: safe extraction, checksum before unpacking, free-space rule.

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

Everything happens in temporary folders; nothing is downloaded and nothing under assets/ is touched.
"""
import collections
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
import unittest.mock
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('fetch_under_test', os.path.join(HERE, '..', 'fetch.py'))
fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch)

REAL_AUDIO = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'assets', 'audio'))
Usage = collections.namedtuple('Usage', 'total used free')


def make_zip(path, members):
    """members: list of (name, bytes, unix mode or None). Mode None keeps zipfile's default."""
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, data, mode in members:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.external_attr = mode << 16
            zf.writestr(info, data)


def entry_for(zip_path, entry_id='pack'):
    with open(zip_path, 'rb') as f:
        data = f.read()
    return {'id': entry_id, 'archive': True, 'url': 'https://kenney.nl/x', 'pageUrl': 'https://kenney.nl/p',
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class TempTree(unittest.TestCase):
    """A fake assets/audio tree; fetch.py is pointed at it for the length of one test."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = os.path.realpath(self._tmp.name)
        self.audio = os.path.join(self.root, 'assets', 'audio')
        self.dest = os.path.join(self.audio, 'downloads')
        os.makedirs(self.dest)
        for name, value in (('ROOT', self.root), ('AUDIO', self.audio), ('DEST', self.dest)):
            patcher = unittest.mock.patch.object(fetch, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def put_zip(self, members, entry_id='pack'):
        d = os.path.join(self.dest, entry_id)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, entry_id + '.zip')
        make_zip(path, members)
        return entry_for(path, entry_id)

    def tree(self):
        found = []
        for base, _dirs, files in os.walk(self.root):
            for name in files:
                found.append(os.path.relpath(os.path.join(base, name), self.root).replace(os.sep, '/'))
        return sorted(found)


class SafeExtraction(TempTree):
    def test_normal_archive_unpacks_and_verifies(self):
        e = self.put_zip([('Audio/a.ogg', b'aaaa', None), ('License.txt', b'CC0', None)])
        self.assertEqual(fetch.unpack(e), 2)
        self.assertEqual(fetch.verify(e), [])
        self.assertEqual(fetch.files_of(e), ['pack/Audio/a.ogg'])

    def test_path_escapes_are_refused_and_nothing_is_written(self):
        for bad in ('../evil.ogg', 'a/../../evil.ogg', '/abs.ogg', '\\abs.ogg', 'C:/x.ogg', '..\\evil.ogg', 'a//b.ogg'):
            with self.subTest(name=bad):
                e = self.put_zip([('ok.ogg', b'ok', None), (bad, b'evil', None)], entry_id='bad')
                with self.assertRaises(RuntimeError):
                    fetch.unpack(e)
                self.assertFalse(any('evil' in t or 'abs.ogg' in t or t.endswith('x.ogg') for t in self.tree()), self.tree())

    def test_links_devices_other_extensions_and_url_files_are_skipped(self):
        e = self.put_zip([('link.ogg', b'target', 0o120777), ('dev.ogg', b'', 0o060644), ('run.exe', b'MZ', None),
                          ('Shortcut.url', b'[InternetShortcut]', None), ('good.ogg', b'good', 0o100644)])
        self.assertEqual(fetch.unpack(e), 1)
        self.assertEqual(self.tree().count('assets/audio/downloads/pack/good.ogg'), 1)
        self.assertFalse(any(t.endswith(('link.ogg', 'dev.ogg', 'run.exe', 'Shortcut.url')) for t in self.tree()))

    def test_member_with_permission_bits_only_is_an_ordinary_file(self):
        # Python's zipfile records mode 0o600 without type bits; those members must not vanish.
        e = self.put_zip([('a.ogg', b'data', 0o600)])
        self.assertEqual(fetch.unpack(e), 1)
        self.assertEqual(fetch.verify(e), [])

    def test_archive_without_extractable_files_is_an_error(self):
        e = self.put_zip([('only.exe', b'MZ', None), ('link.ogg', b'x', 0o120777)])
        with self.assertRaises(RuntimeError):
            fetch.unpack(e)
        self.assertTrue(any('no file' in p for p in fetch.verify(e)))

    def test_unpack_size_limit(self):
        e = self.put_zip([('big.ogg', b'\0' * 5000, None)])
        with unittest.mock.patch.object(fetch, 'ARCHIVE_UNPACK_LIMIT', 1000):
            with self.assertRaises(RuntimeError):
                fetch.unpack(e)
        self.assertNotIn('assets/audio/downloads/pack/big.ogg', self.tree())

    def test_same_size_replacement_is_found(self):
        e = self.put_zip([('a.ogg', b'abcd', None)])
        fetch.unpack(e)
        with open(os.path.join(self.dest, 'pack', 'a.ogg'), 'wb') as f:
            f.write(b'abce')
        self.assertTrue(any('content differs' in p for p in fetch.verify(e)))

    def test_extra_audio_file_is_found_and_gets_no_credit_row(self):
        e = self.put_zip([('a.ogg', b'abcd', None)])
        fetch.unpack(e)
        with open(os.path.join(self.dest, 'pack', 'stray.ogg'), 'wb') as f:
            f.write(b'x')
        self.assertTrue(any('not in the archive' in p for p in fetch.verify(e)))
        self.assertEqual(fetch.files_of(e), ['pack/a.ogg'])


class ChecksumBeforeUnpacking(TempTree):
    def evil_entry(self, wrong_hash):
        e = self.put_zip([('ok.ogg', b'ok', None), ('../evil.ogg', b'evil', None)], entry_id='evil')
        if wrong_hash:
            e['sha256'] = '0' * 64
        return e

    def test_verify_reports_hash_mismatch_without_opening_the_archive(self):
        e = self.evil_entry(wrong_hash=True)
        with unittest.mock.patch.object(fetch.zipfile, 'ZipFile', side_effect=AssertionError('archive opened')):
            self.assertEqual(fetch.verify(e), ['SHA-256 differs: evil.zip'])

    def test_unpack_itself_refuses_a_wrong_hash(self):
        e = self.evil_entry(wrong_hash=True)
        with self.assertRaises(RuntimeError):
            fetch.unpack(e)
        self.assertFalse(any(t.endswith('ok.ogg') for t in self.tree()))

    def test_run_fetch_does_not_unpack_when_the_download_leaves_a_wrong_file(self):
        e = self.evil_entry(wrong_hash=True)
        with unittest.mock.patch.object(fetch, 'download', return_value=None), \
                unittest.mock.patch.object(fetch, 'PAUSE', 0), \
                unittest.mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            code = fetch.run_fetch([e])
        self.assertEqual(code, 1)
        self.assertIn('FAILED', out.getvalue())
        self.assertFalse(any(t.endswith(('ok.ogg', 'evil.ogg')) for t in self.tree()))

    def test_run_fetch_with_a_right_hash_still_refuses_an_escaping_member(self):
        e = self.evil_entry(wrong_hash=False)
        with unittest.mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            code = fetch.run_fetch([e])
        self.assertEqual(code, 1)
        self.assertIn('FAILED', out.getvalue())
        self.assertFalse(any(t.endswith('evil.ogg') for t in self.tree()))


class FreeSpaceRule(TempTree):
    def test_disk_ok_flips_exactly_at_ten_percent(self):
        total = 1_000_000
        with unittest.mock.patch.object(fetch.shutil, 'disk_usage', return_value=Usage(total, 0, 100_500)):
            self.assertTrue(fetch.disk_ok(500)[0])    # exactly 10 % stays free
            self.assertFalse(fetch.disk_ok(501)[0])   # one byte more does not

    def test_unpacked_size_is_checked_not_only_the_archive_size(self):
        e = self.put_zip([('big.ogg', b'\0' * 5000, None)])
        # Room for twice the archive, but not for the 5000 bytes it unpacks to.
        usage = Usage(1_000_000, 0, 100_000 + 2 * e['bytes'] + 2000)
        with unittest.mock.patch.object(fetch.shutil, 'disk_usage', return_value=usage), \
                unittest.mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            code = fetch.run_fetch([e])
        self.assertEqual(code, 1)
        self.assertIn('REFUSED', out.getvalue())
        self.assertIn('unpacking', out.getvalue())
        self.assertFalse(any(t.endswith('big.ogg') for t in self.tree()))

    def test_enough_room_unpacks(self):
        e = self.put_zip([('big.ogg', b'\0' * 5000, None)])
        usage = Usage(1_000_000, 0, 900_000)
        with unittest.mock.patch.object(fetch.shutil, 'disk_usage', return_value=usage), \
                unittest.mock.patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(fetch.run_fetch([e]), 0)
        self.assertEqual(fetch.verify(e), [])

    def test_archive_download_is_refused_before_any_request_when_the_disk_is_full(self):
        e = {'id': 'nasa-x', 'archive': False, 'url': 'https://www.nasa.gov/a.mp3', 'pageUrl': 'https://www.nasa.gov/',
             'bytes': 1000, 'sha256': '0' * 64}
        usage = Usage(1_000_000, 0, 100_000)
        with unittest.mock.patch.object(fetch.shutil, 'disk_usage', return_value=usage), \
                unittest.mock.patch.object(fetch, 'open_url', side_effect=AssertionError('requested')), \
                unittest.mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(fetch.run_fetch([e]), 1)
        self.assertIn('REFUSED', out.getvalue())


class FakeResponse:
    def __init__(self, chunks, fail_after=None):
        self.chunks = list(chunks)
        self.fail_after = fail_after

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, _n):
        if self.fail_after is not None and not self.chunks:
            raise OSError('No space left on device')
        return self.chunks.pop(0) if self.chunks else b''


class DownloadCleanup(TempTree):
    def entry(self, data):
        return {'id': 'nasa-x', 'archive': False, 'url': 'https://www.nasa.gov/wp-content/a.mp3',
                'pageUrl': 'https://www.nasa.gov/', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def test_good_download_is_stored(self):
        data = b'0123456789'
        e = self.entry(data)
        with unittest.mock.patch.object(fetch, 'open_url', return_value=FakeResponse([data[:4], data[4:]])):
            final = fetch.download(e)
        self.assertTrue(os.path.isfile(final))
        self.assertFalse(any(t.endswith('.part') for t in self.tree()))

    def test_wrong_content_and_a_failing_disk_leave_no_part_file(self):
        data = b'0123456789'
        e = self.entry(data)
        d = os.path.join(self.dest, 'nasa-x')
        os.makedirs(d)
        with open(os.path.join(d, 'a.mp3.part'), 'wb') as f:
            f.write(b'left over')
        with unittest.mock.patch.object(fetch, 'open_url', return_value=FakeResponse([b'wrong-size'[:5]])):
            with self.assertRaises(RuntimeError):
                fetch.download(e)
        self.assertFalse(any(t.endswith('.part') for t in self.tree()))
        with unittest.mock.patch.object(fetch, 'open_url', return_value=FakeResponse([data[:4]], fail_after=True)):
            with self.assertRaises(OSError):
                fetch.download(e)
        self.assertFalse(any(t.endswith('.part') for t in self.tree()))


class NamesAndUrls(unittest.TestCase):
    def test_encoded_separators_cannot_make_a_path(self):
        for url in ('https://www.nasa.gov/x%2F..%2F..%2Fescape.mp3', 'https://www.nasa.gov/x%5C..%5Cescape.mp3',
                    'https://www.nasa.gov/x%2f%2e%2e%2fescape.mp3', 'https://www.nasa.gov/%2E%2E', 'https://www.nasa.gov/c%3Aevil.mp3'):
            with self.subTest(url=url):
                e = {'id': 'x', 'archive': False, 'url': url}
                try:
                    name = fetch.stored_name(e)
                except ValueError:
                    continue
                self.assertEqual(os.path.basename(name), name)
                self.assertNotIn('..', name.replace('escape', ''))
                self.assertNotIn('\\', name)

    def test_plain_names_still_work(self):
        self.assertEqual(fetch.stored_name({'id': 'x', 'archive': False, 'url': 'https://www.nasa.gov/a/b%20c.mp3'}), 'b c.mp3')
        self.assertEqual(fetch.stored_name({'id': 'x', 'archive': True, 'url': 'https://kenney.nl/d'}), 'x.zip')

    def test_entry_ids_are_validated(self):
        for bad in ('', '..', 'a/b', 'a\\b', '../x', 'A', '.hidden', 'x' * 200, None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    fetch.entry_dir({'id': bad, 'archive': True, 'url': 'https://kenney.nl/'})

    def test_urls_are_checked(self):
        good = ('https://kenney.nl/download/abc?expires=1', 'https://www.nasa.gov/x.mp3', 'https://images-assets.nasa.gov/a.mp3',
                'https://nasa.gov/a')
        bad = ('http://www.nasa.gov/x', 'ftp://www.nasa.gov/x', 'file:///etc/passwd', 'https://evil.com\\@a.nasa.gov/x',
               'https://nasa.gov.evil.com/x', 'https://nasa.gov@evil.com/x', 'https://www.nasa.gov:8080/x',
               'https://evilnasa.gov/x', 'https://notkenney.nl/x', 'https://www.nasa.gov/a b', '//www.nasa.gov/x')
        for url in good:
            with self.subTest(url=url):
                self.assertEqual(fetch.check_url(url), url)
        for url in bad:
            with self.subTest(url=url):
                with self.assertRaises(RuntimeError):
                    fetch.check_url(url)

    def test_every_redirect_hop_is_checked(self):
        handler = fetch.CheckedRedirects()
        req = urllib.request.Request('https://www.nasa.gov/a')
        for target in ('https://evil.example/x', 'http://www.nasa.gov/x', '//evil.example/x'):
            with self.subTest(target=target):
                with self.assertRaises(RuntimeError):
                    handler.redirect_request(req, None, 302, 'Found', {}, target)
        new = handler.redirect_request(req, None, 302, 'Found', {}, 'https://images-assets.nasa.gov/b.mp3')
        self.assertEqual(new.full_url, 'https://images-assets.nasa.gov/b.mp3')
        self.assertTrue(any(isinstance(h, fetch.CheckedRedirects) for h in fetch.OPENER.handlers))


class ListsAgree(unittest.TestCase):
    """downloads.json, selection.json and the files on disk say the same things."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(REAL_AUDIO, 'downloads.json'), encoding='utf8') as f:
            cls.downloads = json.load(f)
        with open(os.path.join(REAL_AUDIO, 'selection.json'), encoding='utf8') as f:
            cls.selection = json.load(f)

    def test_every_entry_id_is_a_valid_folder_name(self):
        for e in self.downloads['entries']:
            fetch.check_id(e)
            fetch.stored_name(e)
            fetch.check_url(e['url'])

    def test_selection_credit_licence_and_speech_follow_downloads(self):
        by_id = {e['id']: e for e in self.downloads['entries']}
        for x in self.selection:
            e = by_id[x['file'].split('/')[0]]
            self.assertEqual(x['credit'], e['credit'], x['id'])
            self.assertEqual(x['licence'], e['licence'], x['id'])
            if e['speech'] != 'none':
                self.assertTrue(x['speech'], x['id'])

    def test_every_nasa_entry_has_a_speech_mark(self):
        for e in self.downloads['entries']:
            self.assertIn(e.get('speech'), ('speech', 'probable', 'none'), e['id'])

    def test_nasa_evidence_does_not_present_the_guidelines_as_a_commercial_permission(self):
        for e in self.downloads['entries']:
            if e['id'].startswith('nasa-'):
                self.assertIn('COMMERCIAL USE', e['licenceEvidence'], e['id'])


if __name__ == '__main__':
    unittest.main()
