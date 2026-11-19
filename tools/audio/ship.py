"""Ships the sounds the owner has approved from the sound library to the game.

    <python with numpy and soundfile> -B tools/audio/ship.py --library <assets/audio of the tree that holds the rendered sounds>
    ... --check      writes nothing; returns 1 when a run would change a file

The rendered sounds are not in git: they lie in one worktree only (docs/ROADMAP.md, section 5). This
script reads there and writes here.

Reads, and never writes, under --library:
    render/manifest.json and the WAV files it lists    what exists, with the hash of every file
    ratings.json                                       the owner's ratings
    selection.json, generated.json                     credits of the downloads, withdrawn sounds
Reads in this tree:
    assets/audio/game.json                             what the game asks for
Writes in this tree:
    packages/client/public/audio/<id>.<hash>.flac      the shipped sounds, lossless
    packages/client/public/audio/manifest.json         what the game loads
    packages/client/public/audio/CREDITS.md            the licence of every shipped file
    assets/audio/shipped.json                          the decision for every library sound and every event

What goes in is derived, not picked by hand (`decide`):
  - only a sound the owner approved: his latest rating is "fits", or four stars and more without a
    verdict. A rating given on an earlier version of the file still counts while it is positive, and
    the sound is marked (`approval` ends in "-older"); a negative rating keeps a sound out whatever
    file it was given on. A generated library sound he has not rated as built goes in when he
    accepted the candidate it was built from (`approval` "candidate").
  - only where the licence allows shipping: the repository's own renders, output of MOSS-SoundEffect
    (Apache-2.0) and CC0 files. NASA recordings stay out until the owner decides (CREDITS.md of the
    downloads says why); output of Stable Audio never goes in (his decision of 2026-11-16).
  - only what the game plays: the events of game.json, and the downloads it adopts for a role.
  - never what game.json lists under `never`.

The files are FLAC because it is lossless: every sample the game plays is the sample he rated, a
loop keeps its seam, and all browsers decode it. Each file is decoded again after encoding and
compared with its WAV, and each WAV is checked against the hash in the manifest first, so a tree
that is being rebuilt while this runs is noticed.
"""
import argparse
import hashlib
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLAN = os.path.join(ROOT, 'assets', 'audio', 'game.json')
OUT = os.path.join(ROOT, 'packages', 'client', 'public', 'audio')
REPORT = os.path.join(ROOT, 'assets', 'audio', 'shipped.json')
SAMPLE_RATE = 48000

# Fields of a manifest entry that the game's stage reads; carried over as they are.
CARRIED = ('kind', 'path', 'dry', 'channels', 'gain', 'place', 'cue', 'family', 'params', 'en', 'de', 'licence')


def is_round_candidate(sound):
    """Candidates of the listening rounds and voice samples are on the page to be judged; they are not library sounds."""
    cat = sound.get('category', '')
    return cat in ('source', 'voice') or cat.startswith('events')


def is_rated(rating):
    """The audition page's rule: a sound is rated when it has stars, a verdict or a note."""
    return bool(rating) and bool(rating.get('stars') or rating.get('verdict') or rating.get('note'))


def approval(sound, rating):
    """(approved, code, why) for one library sound and the owner's latest rating of it (or None)."""
    if not is_rated(rating):
        gen = sound.get('generated') or {}
        if sound.get('source') == 'generated' and gen.get('verdict') == 'fits':
            return True, 'candidate', 'accepted as candidate %s of round %s; not yet rated as built' % (gen.get('candidate'), gen.get('round'))
        return False, 'unrated', 'no rating'
    verdict = rating.get('verdict') or ''
    stars = rating.get('stars') or 0
    note = (rating.get('note') or '').strip()
    if not rating.get('hash'):
        older = 'rated on %s, before file hashes were recorded' % (rating.get('at') or '?')[:10]
    elif rating.get('hash') != sound.get('hash'):
        older = 'rated on %s on an earlier version of the file' % (rating.get('at') or '?')[:10]
    else:
        older = None
    if verdict == 'fits':
        return True, 'fits-older' if older else 'fits', older or 'rated fits on this file'
    if verdict == '' and stars >= 4:
        why = '%d stars, no verdict' % stars
        return True, 'stars-older' if older else 'stars', why + ('; ' + older if older else '')
    if verdict in ('close', 'wrong'):
        return False, verdict, 'rated %s%s' % (verdict, ': "%s"' % note if note else ', no note')
    return False, 'unrated', 'no verdict and fewer than four stars'


def licence_rule(sound):
    """(may ship, why) by licence and origin."""
    lic = sound.get('licence') or ''
    source = sound.get('source')
    gen = sound.get('generated') or {}
    text = ' '.join([sound.get('id', ''), lic, str(gen.get('model', ''))]).lower()
    if '_sa3_' in text or 'stable audio' in text or 'stability' in text:
        return False, 'output of Stable Audio: not in the game (his decision of 2026-11-16)'
    if source == 'synth' and lic == 'AGPL-3.0-or-later':
        return True, "rendered by the repository's own scripts"
    if source == 'generated' and 'MOSS-SoundEffect' in lic and 'Apache-2.0' in lic:
        return True, 'output of MOSS-SoundEffect v2.0 (Apache-2.0)'
    if source == 'download' and lic == 'CC0 1.0':
        return True, 'CC0 1.0'
    if 'NASA' in lic:
        return False, 'NASA recording: whether it may ship with the game is the owner\'s decision (assets/audio/CREDITS.md)'
    return False, 'licence not on the list of what may ship: %s' % (lic or 'none')


def event_of(sound):
    """The event of tools/audio/sounds.json a library sound is, or stands for; None for a download."""
    if sound.get('source') == 'generated':
        return (sound.get('generated') or {}).get('standsFor')
    if sound.get('source') == 'synth':
        return sound.get('id')
    return None


def decide(manifest, ratings, plan, withdrawn=()):
    """The decision for every library sound and every event the game asks for. Pure: no file is touched.

    Returns {'sounds': [{id, ship, code, why, event, roles, approval}], 'events': {event: [ids]},
    'standIn': {event: event}, 'roles': {role: [ids]}, 'silent': {event: why}, 'candidates': n}.
    """
    wanted = plan.get('events', {})
    never = plan.get('never', {})
    adopted = {}
    for role, spec in plan.get('adopt', {}).items():
        for sid in spec.get('sounds', []):
            adopted.setdefault(sid, []).append(role)
    rated = ratings.get('ratings', {})
    out = []
    candidates = 0
    for s in manifest.get('sounds', []):
        if is_round_candidate(s):
            candidates += 1
            continue
        sid = s['id']
        ev = event_of(s)
        roles = adopted.get(sid, [])
        row = {'id': sid, 'ship': False, 'code': '', 'why': '', 'event': ev, 'roles': roles, 'approval': None}
        ok, code, why = approval(s, rated.get(sid))
        may, lic_why = licence_rule(s)
        if sid in never or (ev and ev in never):
            row.update(code='never', why=never.get(sid) or never.get(ev))
        elif sid in withdrawn:
            row.update(code='withdrawn', why='withdrawn from the library')
        elif not may and 'Stable Audio' in lic_why:
            row.update(code='never', why=lic_why)
        elif not ok:
            row.update(code=code, why=why)
        elif not may:
            row.update(code='licence', why=lic_why, approval=code)
        elif not ((ev and ev in wanted) or roles):
            row.update(code='no-use', why='approved (%s), but no event of the game plays it' % why, approval=code)
        else:
            row.update(ship=True, code=code, why=why, approval=code)
        out.append(row)

    shipped = [r for r in out if r['ship']]
    events = {}
    for ev in wanted:
        ids = [r['id'] for r in shipped if r['event'] == ev]
        if ids:
            events[ev] = ids
    stand_in = {}
    silent = {}
    for ev in wanted:
        if ev in events:
            continue
        target = plan.get('standIn', {}).get(ev)
        own = [r for r in out if r['event'] == ev]
        reason = '; '.join('%s %s' % (r['id'], r['why']) for r in own) or 'the library has no sound for it'
        if target and target in events:
            stand_in[ev] = target
        else:
            silent[ev] = reason
    roles = {}
    for role, spec in plan.get('adopt', {}).items():
        ids = [sid for sid in spec.get('sounds', []) if any(r['id'] == sid for r in shipped)]
        if ids:
            roles[role] = ids
        else:
            silent[role] = 'none of %s may ship' % ', '.join(spec.get('sounds', []))
    return {'sounds': out, 'events': events, 'standIn': stand_in, 'roles': roles, 'silent': silent, 'candidates': candidates}


# ----------------------------------------------------------------------------------------------
# Files
# ----------------------------------------------------------------------------------------------

def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dump_json(obj):
    return json.dumps(obj, indent=1, ensure_ascii=False) + '\n'


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def encode_flac(wav_path):
    """(flac bytes, frames, channels) of a 16-bit WAV, with the decoded FLAC compared sample by sample."""
    import numpy as np
    import soundfile as sf
    info = sf.info(wav_path)
    if info.subtype != 'PCM_16' or info.samplerate != SAMPLE_RATE:
        raise ValueError('%s is %s at %d Hz, expected PCM_16 at %d' % (wav_path, info.subtype, info.samplerate, SAMPLE_RATE))
    data, _ = sf.read(wav_path, dtype='int16', always_2d=True)
    buf = io.BytesIO()
    sf.write(buf, data, SAMPLE_RATE, format='FLAC', subtype='PCM_16')
    raw = buf.getvalue()
    back, rate = sf.read(io.BytesIO(raw), dtype='int16', always_2d=True)
    if rate != SAMPLE_RATE or back.shape != data.shape or not np.array_equal(back, data):
        raise ValueError('%s does not decode to the samples of its WAV' % wav_path)
    return raw, int(data.shape[0]), int(data.shape[1])


def credits_text(entries):
    lines = [
        '# Sounds shipped with the game and their licences',
        '',
        'Written by `tools/audio/ship.py`. Do not edit by hand. Every file in this folder is listed here.',
        'The files are lossless copies of sounds of the sound library (`tools/audio`, `assets/audio`).',
        '',
        '- **Rendered**: made by the scripts in `tools/audio/synth` of this repository; AGPL-3.0-or-later like the repository.',
        '- **Generated**: output of the model MOSS-SoundEffect v2.0 (OpenMOSS; code and weights Apache-2.0), cut, levelled and in',
        '  part processed by the scripts of this repository. The prompt and seed of each are in `assets/audio/generated.json`.',
        '- **Kenney**: from the audio packs of Kenney (www.kenney.nl), CC0 1.0, levelled and trimmed by the build. Credit is not',
        '  required by the licence and is given anyway.',
        '',
        '| File | Sound | Origin | Licence | Credit |',
        '|---|---|---|---|---|',
    ]
    for e in entries:
        lines.append('| %s | %s | %s | %s | %s |' % (e['file'], e['en'].replace('|', '/'), e['origin'], e['licence'].replace('|', '/'), e['credit']))
    return '\n'.join(lines) + '\n'


def write_if_changed(path, data, check, changed):
    """Writes bytes (or LF text) when the file differs; in check mode only records that it would."""
    if isinstance(data, str):
        data = data.encode('utf-8')
    old = None
    if os.path.exists(path):
        with open(path, 'rb') as f:
            old = f.read()
    if old == data:
        return
    changed.append(os.path.relpath(path, ROOT).replace(os.sep, '/'))
    if not check:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--library', required=True, help='assets/audio of the tree that holds render/manifest.json and the rendered WAV files (read only)')
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--report', default=REPORT)
    ap.add_argument('--plan', default=PLAN)
    ap.add_argument('--check', action='store_true', help='write nothing; return 1 when a run would change a file')
    args = ap.parse_args(argv)

    lib = os.path.abspath(args.library)
    render = os.path.join(lib, 'render')
    manifest = read_json(os.path.join(render, 'manifest.json'))
    ratings_path = os.path.join(lib, 'ratings.json')
    ratings = read_json(ratings_path)
    plan = read_json(args.plan)
    selection = {}
    if os.path.exists(os.path.join(lib, 'selection.json')):
        selection = {s['id']: s for s in read_json(os.path.join(lib, 'selection.json'))}
    withdrawn = []
    if os.path.exists(os.path.join(lib, 'generated.json')):
        withdrawn = [w['id'] for w in read_json(os.path.join(lib, 'generated.json')).get('withdrawn', [])]

    result = decide(manifest, ratings, plan, withdrawn)
    by_id = {s['id']: s for s in manifest['sounds']}
    changed = []
    problems = []
    sounds = []
    credits = []
    keep = {'manifest.json', 'CREDITS.md'}
    total_wav = total_flac = 0
    seconds = 0.0
    for row in result['sounds']:
        if not row['ship']:
            continue
        s = by_id[row['id']]
        wav = os.path.join(render, s['file'].replace('/', os.sep))
        try:
            digest = sha256_of(wav)
            if not s.get('hash') or digest[:12] != s['hash']:
                raise ValueError('%s has the hash %s, the manifest says %s: is the tree being rebuilt?' % (s['file'], digest[:12], s.get('hash')))
            raw, frames, channels = encode_flac(wav)
            if channels != s.get('channels'):
                raise ValueError('%s has %d channels, the manifest says %s' % (s['file'], channels, s.get('channels')))
        except Exception as e:  # noqa: BLE001 - every problem of one file is reported, the others are still looked at
            problems.append('%s: %s' % (row['id'], e))
            continue
        name = '%s.%s.flac' % (s['id'], s['hash'])
        keep.add(name)
        write_if_changed(os.path.join(args.out, name), raw, args.check, changed)
        total_wav += os.path.getsize(wav)
        total_flac += len(raw)
        seconds += frames / SAMPLE_RATE
        entry = {'id': s['id'], 'file': name, 'event': row['event'], 'roles': row['roles']}
        for key in CARRIED:
            if key in s and s[key] is not None:
                entry[key] = s[key]
        checks = s.get('checks') or {}
        entry.update(frames=frames, duration=round(frames / SAMPLE_RATE, 6), hash=s['hash'], bytes=len(raw), approval=row['approval'])
        for key in ('lufs', 'peakDb'):
            if isinstance(checks.get(key), (int, float)):
                entry[key] = checks[key]
        sounds.append(entry)
        if s.get('source') == 'synth':
            origin, credit = 'Rendered', 'PRIMACY2 contributors'
        elif s.get('source') == 'generated':
            origin, credit = 'Generated', 'MOSS-SoundEffect v2.0 (OpenMOSS)'
        else:
            sel = selection.get(s['id'], {})
            origin, credit = 'Kenney: %s' % sel.get('file', '?'), sel.get('credit', '?')
        credits.append({'file': name, 'en': s.get('en', s['id']), 'origin': origin, 'licence': s['licence'], 'credit': credit})

    if problems:
        for p in problems:
            print('PROBLEM', p)
        print('nothing written beyond the files above; fix the problems and run again')
        return 1

    game_manifest = {
        'version': 1,
        'note': 'Written by tools/audio/ship.py from the sound library. Do not edit by hand.',
        'ratings': {'savedAt': ratings.get('savedAt'), 'sha256': sha256_of(ratings_path)},
        'sounds': sounds,
        'events': result['events'],
        'standIn': result['standIn'],
        'roles': result['roles'],
        'silent': result['silent'],
    }
    write_if_changed(os.path.join(args.out, 'manifest.json'), dump_json(game_manifest), args.check, changed)
    write_if_changed(os.path.join(args.out, 'CREDITS.md'), credits_text(credits), args.check, changed)
    report = {
        'note': 'Written by tools/audio/ship.py: the decision for every library sound and every event the game asks for. '
                'code: fits, stars (approved on the file the manifest lists), fits-older, stars-older (approved on an earlier '
                'version of the file), candidate (generated; the candidate it was built from was accepted, the built sound is '
                'not rated yet); and for what stays out: wrong, close, unrated, never, withdrawn, licence, no-use.',
        'ratings': game_manifest['ratings'],
        'counts': {
            'manifestEntries': len(manifest['sounds']),
            'roundCandidatesAndVoices': result['candidates'],
            'librarySounds': len(result['sounds']),
            'shipped': len(sounds),
            'byCode': {},
            'eventsAsked': len(plan.get('events', {})),
            'eventsWithOwnSound': len(result['events']),
            'eventsWithStandIn': len(result['standIn']),
            'eventsSilent': len([e for e in result['silent'] if e in plan.get('events', {})]),
            'seconds': round(seconds, 1),
            'wavBytes': total_wav,
            'flacBytes': total_flac,
        },
        'events': result['events'],
        'standIn': result['standIn'],
        'roles': result['roles'],
        'silent': result['silent'],
        'sounds': result['sounds'],
    }
    for row in result['sounds']:
        key = ('in:' if row['ship'] else 'out:') + row['code']
        report['counts']['byCode'][key] = report['counts']['byCode'].get(key, 0) + 1
    write_if_changed(args.report, dump_json(report), args.check, changed)

    # A file of a sound that is no longer shipped, or of an older version of one, goes.
    if os.path.isdir(args.out):
        for name in sorted(os.listdir(args.out)):
            if name not in keep and name.endswith('.flac'):
                changed.append('%s (removed)' % os.path.relpath(os.path.join(args.out, name), ROOT).replace(os.sep, '/'))
                if not args.check:
                    os.remove(os.path.join(args.out, name))

    c = report['counts']
    print('manifest entries %d: %d round candidates and voice samples, %d library sounds' % (c['manifestEntries'], c['roundCandidatesAndVoices'], c['librarySounds']))
    print('shipped %d sounds, %.1f s, %.2f MB as FLAC (%.2f MB as WAV)' % (c['shipped'], c['seconds'], c['flacBytes'] / 1e6, c['wavBytes'] / 1e6))
    print('by code: ' + ', '.join('%s %d' % kv for kv in sorted(c['byCode'].items())))
    print('events asked %d: %d with a sound of their own, %d with a stand-in, %d silent' % (c['eventsAsked'], c['eventsWithOwnSound'], c['eventsWithStandIn'], c['eventsSilent']))
    for ev, why in result['silent'].items():
        print('  silent  %-22s %s' % (ev, why))
    for ev, target in result['standIn'].items():
        print('  stand-in %-21s plays %s' % (ev, target))
    if changed:
        print(('would change' if args.check else 'changed') + ' %d files:' % len(changed))
        for name in changed:
            print('  ' + name)
        return 1 if args.check else 0
    print('nothing changed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
