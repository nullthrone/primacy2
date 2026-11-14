#!/usr/bin/env python
"""Fetch the free sound material listed in assets/audio/downloads.json.

    .venv-audio/Scripts/python.exe tools/audio/fetch.py            download what is missing, verify, unpack
    .venv-audio/Scripts/python.exe tools/audio/fetch.py --check    verify what is on disk, download nothing
    .venv-audio/Scripts/python.exe tools/audio/fetch.py --credits  rewrite assets/audio/CREDITS.md

Standard library only. Nothing that is downloaded is ever executed or imported: archives are
unpacked with a conservative filter (regular files, relative paths, audio and text extensions)
and everything is verified against the size and SHA-256 recorded in downloads.json.
"""
import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import zipfile
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
AUDIO = os.path.join(ROOT, 'assets', 'audio')
LIST = os.path.join(AUDIO, 'downloads.json')
DEST = os.path.join(AUDIO, 'downloads')
CREDITS = os.path.join(AUDIO, 'CREDITS.md')

USER_AGENT = 'primacy2-audio-fetch'  # nothing that identifies a person or a project
ALLOWED_EXT = {'.ogg', '.wav', '.mp3', '.flac', '.m4a', '.txt', '.md', '.pdf'}
# .url files are internet shortcuts. The brief allows them, but they are of no use to us and
# Windows would open a browser on a double click, so they are not extracted.
SKIPPED_EXT = {'.url'}
AUDIO_EXT = {'.ogg', '.wav', '.mp3', '.flac', '.m4a'}
MIN_FREE_SHARE = 0.10                # at least this share of the disk stays free
TOTAL_LIMIT = 1_500_000_000          # all downloads together stay below this
ARCHIVE_UNPACK_LIMIT = 400_000_000   # uncompressed size of one archive (zip bomb guard)
PAUSE = 0.5                          # seconds between two downloads, one at a time
ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9_-]{0,80}$')  # an id becomes a folder name, nothing else


def load():
    with open(LIST, encoding='utf8') as f:
        return json.load(f)


def crc32_of(path):
    crc = 0
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            crc = zlib.crc32(block, crc)
    return crc & 0xFFFFFFFF


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def check_id(entry):
    """An entry id is used as a folder name, so it must not be able to name a path."""
    if not isinstance(entry.get('id'), str) or not ID_PATTERN.match(entry['id']):
        raise ValueError('bad entry id: %r' % (entry.get('id'),))
    return entry['id']


def stored_name(entry):
    """File name under downloads/<id>/ for the downloaded file itself."""
    check_id(entry)
    if entry['archive']:
        return entry['id'] + '.zip'
    # Decode first and take the last segment afterwards: an encoded slash (%2F) must not
    # survive as a path separator.
    name = posixpath.basename(urllib.parse.unquote(urllib.parse.urlparse(entry['url']).path))
    if not name:
        return entry['id']
    bad_char = any(c in name for c in ('\\', ':', '\0')) or any(ord(c) < 32 for c in name)
    if name in ('.', '..') or bad_char:
        raise ValueError('unsafe file name in url of %s: %r' % (entry['id'], name))
    return name


def entry_dir(entry):
    return os.path.join(DEST, check_id(entry))


def disk_ok(extra):
    usage = shutil.disk_usage(AUDIO if os.path.isdir(AUDIO) else ROOT)
    free_after = usage.free - extra
    return free_after >= MIN_FREE_SHARE * usage.total, free_after, usage.total


def dir_size(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(base, name))
    return total


def request(url, referer=None):
    headers = {'User-Agent': USER_AGENT}
    if referer:
        headers['Referer'] = referer
    return urllib.request.Request(url, headers=headers)


def check_url(url):
    """Only https on the approved hosts, with no user info, no odd port and no backslash."""
    if not isinstance(url, str) or '\\' in url or any(ord(c) <= 32 for c in url):
        raise RuntimeError('refusing url with a backslash, space or control character')
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != 'https':
        raise RuntimeError('refusing %s: only https is approved' % (parts.scheme or 'a url without scheme'))
    if parts.username is not None or parts.password is not None or parts.port not in (None, 443):
        raise RuntimeError('refusing url with user info or a port')
    host = parts.hostname or ''
    allowed = host == 'kenney.nl' or host == 'nasa.gov' or host.endswith('.nasa.gov')
    if not allowed:
        raise RuntimeError('refusing host %s: only kenney.nl and nasa.gov are approved' % host)
    return url


class CheckedRedirects(urllib.request.HTTPRedirectHandler):
    """The approved-host rule holds for every hop, not just for the first url."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(CheckedRedirects)


def open_url(req, timeout):
    check_url(req.full_url)
    return OPENER.open(req, timeout=timeout)


def resolve_url(entry):
    """kenney.nl hands out short-lived signed links through a small JSON endpoint."""
    url = check_url(entry['url'])
    if urllib.parse.urlsplit(url).hostname == 'kenney.nl' and '/download-link/' in url:
        with open_url(request(url, referer=entry['pageUrl']), timeout=60) as r:
            url = json.load(r)['url']
    return check_url(url)


def download(entry):
    d = entry_dir(entry)
    os.makedirs(d, exist_ok=True)
    final = os.path.join(d, stored_name(entry))
    part = final + '.part'
    if os.path.exists(part):
        os.remove(part)  # left over from an earlier run that died
    url = resolve_url(entry)
    h = hashlib.sha256()
    size = 0
    done = False
    try:
        with open_url(request(url), timeout=300) as r, open(part, 'wb') as f:
            while True:
                block = r.read(1 << 20)
                if not block:
                    break
                size += len(block)
                if size > entry['bytes']:
                    break  # more than promised: stop at once, the check below fails
                h.update(block)
                f.write(block)
        if size != entry['bytes'] or h.hexdigest() != entry['sha256']:
            raise RuntimeError('%s: size or SHA-256 differs from downloads.json (got %d bytes)' % (entry['id'], size))
        os.replace(part, final)
        done = True
    finally:
        # Any failure (wrong content, full disk, dropped connection) leaves no .part behind.
        if not done and os.path.exists(part):
            os.remove(part)
    return final


def safe_members(zf):
    """Yield (info, relative posix path) for members that may be extracted."""
    total = 0
    for info in zf.infolist():
        name = info.filename
        if info.is_dir():
            continue
        if name.startswith('/') or name.startswith('\\') or (len(name) > 1 and name[1] == ':'):
            raise RuntimeError('absolute path in archive: ' + name)
        parts = name.replace('\\', '/').split('/')
        if '..' in parts or '' in parts[:-1]:
            raise RuntimeError('unsafe path in archive: ' + name)
        # The type bits only count when set: zip writers that record no unix mode, or only
        # permission bits (Python's zipfile does that), mean an ordinary file.
        kind = (info.external_attr >> 16) & 0o170000
        if kind and kind != 0o100000:  # symlinks, devices and the like
            continue
        ext = posixpath.splitext(parts[-1])[1].lower()
        if ext in SKIPPED_EXT or ext not in ALLOWED_EXT:
            continue
        total += info.file_size
        if total > ARCHIVE_UNPACK_LIMIT:
            raise RuntimeError('archive unpacks to more than the limit')
        yield info, '/'.join(parts)


def check_archive_file(entry):
    """The archive is only opened after its size and SHA-256 match downloads.json."""
    path = os.path.join(entry_dir(entry), stored_name(entry))
    if not os.path.isfile(path) or os.path.getsize(path) != entry['bytes'] or sha256_of(path) != entry['sha256']:
        raise RuntimeError('%s: archive does not match the size and SHA-256 in downloads.json, not unpacking' % entry['id'])
    return path


def unpacked_size(entry):
    """Bytes that unpack() will write."""
    with zipfile.ZipFile(check_archive_file(entry)) as zf:
        return sum(info.file_size for info, _rel in safe_members(zf))


def unpack(entry):
    d = entry_dir(entry)
    with zipfile.ZipFile(check_archive_file(entry)) as zf:
        count = 0
        for info, rel in safe_members(zf):
            target = os.path.join(d, *rel.split('/'))
            if os.path.commonpath([os.path.abspath(target), os.path.abspath(d)]) != os.path.abspath(d):
                raise RuntimeError('path escapes target: ' + rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, 'wb') as out:
                shutil.copyfileobj(src, out)
            count += 1
    if count == 0:
        raise RuntimeError('%s: the archive has no file that may be extracted' % entry['id'])
    return count


def verify(entry):
    """Return a list of problems (empty when the entry is complete and intact)."""
    d = entry_dir(entry)
    path = os.path.join(d, stored_name(entry))
    if not os.path.isfile(path):
        return ['missing ' + os.path.relpath(path, ROOT)]
    if os.path.getsize(path) != entry['bytes']:
        return ['size differs: ' + stored_name(entry)]
    if sha256_of(path) != entry['sha256']:
        return ['SHA-256 differs: ' + stored_name(entry)]
    problems = []
    if entry['archive']:
        known = set()
        with zipfile.ZipFile(path) as zf:
            for info, rel in safe_members(zf):
                known.add(rel)
                target = os.path.join(d, *rel.split('/'))
                if not os.path.isfile(target):
                    problems.append('not unpacked: ' + rel)
                elif os.path.getsize(target) != info.file_size:
                    problems.append('unpacked size differs: ' + rel)
                elif crc32_of(target) != info.CRC:  # a same-size replacement is caught here
                    problems.append('unpacked content differs: ' + rel)
        if not known:
            problems.append('the archive has no file that may be extracted')
        # An audio file that is not in the archive would otherwise get a licence row in CREDITS.md.
        for base, _dirs, names in os.walk(d):
            for name in names:
                if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                    rel = os.path.relpath(os.path.join(base, name), d).replace(os.sep, '/')
                    if rel not in known:
                        problems.append('not in the archive: ' + rel)
    return problems


def files_of(entry):
    """Audio files of an entry as paths relative to the downloads directory (posix).

    For an archive the list comes from the archive itself, not from the folder, so a stray
    file dropped there never gets a licence row."""
    d = entry_dir(entry)
    found = []
    if entry['archive']:
        zpath = os.path.join(d, stored_name(entry))
        if os.path.isfile(zpath):
            with zipfile.ZipFile(zpath) as zf:
                for _info, rel in safe_members(zf):
                    if os.path.splitext(rel)[1].lower() in AUDIO_EXT and os.path.isfile(os.path.join(d, *rel.split('/'))):
                        found.append(posixpath.join(entry['id'], rel))
    else:
        name = stored_name(entry)
        if os.path.splitext(name)[1].lower() in AUDIO_EXT and os.path.isfile(os.path.join(d, name)):
            found.append(posixpath.join(entry['id'], name))
    return sorted(found)


def fmt_size(n):
    if n >= 1_000_000:
        return '%.1f MB' % (n / 1e6)
    return '%.0f kB' % (n / 1e3) if n >= 1000 else '%d B' % n


def run_fetch(entries):
    failures = 0
    planned = sum(e['bytes'] for e in entries)
    if planned > TOTAL_LIMIT:
        print('the list asks for %d bytes, the limit is %d' % (planned, TOTAL_LIMIT))
        return 1
    for e in entries:
        if not verify(e):
            print('ok       ' + e['id'])
            continue
        ok, free_after, total = disk_ok(e['bytes'] * 2)
        if not ok:
            print('REFUSED  %s: less than %d %% of the disk would stay free (%.0f GB of %.0f GB)'
                  % (e['id'], MIN_FREE_SHARE * 100, free_after / 1e9, total / 1e9))
            return 1
        try:
            if not os.path.isfile(os.path.join(entry_dir(e), stored_name(e))) or sha256_of(os.path.join(entry_dir(e), stored_name(e))) != e['sha256']:
                download(e)
                time.sleep(PAUSE)
            if e['archive']:
                # The compressed size says little about the unpacked size: check that as well.
                need = unpacked_size(e)
                ok, free_after, total = disk_ok(need)
                if not ok:
                    print('REFUSED  %s: unpacking %s would leave less than %d %% of the disk free (%.0f GB of %.0f GB)'
                          % (e['id'], fmt_size(need), MIN_FREE_SHARE * 100, free_after / 1e9, total / 1e9))
                    return 1
                unpack(e)
            problems = verify(e)
            if problems:
                raise RuntimeError('; '.join(problems[:3]))
            print('fetched  ' + e['id'])
        except Exception as exc:  # report and go on with the next entry
            failures += 1
            print('FAILED   %s: %s' % (e['id'], exc))
    return 1 if failures else 0


def run_check(entries):
    bad = 0
    for e in entries:
        problems = verify(e)
        print(('ok       ' if not problems else 'PROBLEM  ') + e['id'] + ('' if not problems else ': ' + '; '.join(problems[:3])))
        bad += bool(problems)
    on_disk = dir_size(DEST) if os.path.isdir(DEST) else 0
    print('%d entries, %d with problems, %s on disk' % (len(entries), bad, fmt_size(on_disk)))
    return 1 if bad else 0


def cell(text):
    return str(text).replace('|', '/').replace('\n', ' ')


def run_credits(data):
    entries = data['entries']
    out = ['# Credits and licences of the downloaded sound material', '',
           'Generated by `tools/audio/fetch.py --credits` from `assets/audio/downloads.json` and the files on disk.',
           'Do not edit by hand. The files themselves are not in git; `fetch.py` downloads them again and checks',
           'size and SHA-256.', '', '## Sources and their terms', '']
    for s in data.get('sources', []):
        out += ['### ' + s['name'], '']
        out += [s['terms'], '']
    out += ['## Files', '', '| File | Source | Licence | Size | Credit |', '|---|---|---|---|---|']
    rows = 0
    for e in entries:
        for rel in files_of(e):
            path = os.path.join(DEST, *rel.split('/'))
            src = e['pageUrl'] if e['archive'] else e['url']
            out.append('| %s | %s | %s | %s | %s |' % (cell(rel), cell(src), cell(e['licence']), fmt_size(os.path.getsize(path)), cell(e['credit'])))
            rows += 1
    out += ['', '%d files from %d downloads.' % (rows, len(entries)), '', '## Licence evidence per download', '']
    for e in entries:
        out += ['- `%s` (%s): %s' % (e['id'], e['licence'], e['licenceEvidence']), '']
    out += ['## Considered and not taken', '']
    for n in data.get('notTaken', []):
        out.append('- %s: %s' % (n['what'], n['why']))
    out.append('')
    with open(CREDITS, 'w', encoding='utf8', newline='\n') as f:
        f.write('\n'.join(out))
    print('wrote %s (%d file rows)' % (os.path.relpath(CREDITS, ROOT), rows))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='verify what is on disk, download nothing')
    ap.add_argument('--credits', action='store_true', help='rewrite assets/audio/CREDITS.md')
    ap.add_argument('--only', help='comma separated entry ids (fetch and check only)')
    args = ap.parse_args()
    data = load()
    entries = data['entries']
    if args.only:
        wanted = set(args.only.split(','))
        entries = [e for e in entries if e['id'] in wanted]
    if args.credits:
        return run_credits(data)
    if args.check:
        return run_check(entries)
    return run_fetch(entries)


if __name__ == '__main__':
    sys.exit(main())
