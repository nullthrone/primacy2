"""What tools/audio/ship.py lets into the game: the rule, on made-up manifests and ratings.

    .venv-audio/Scripts/python.exe -I -m unittest discover -s tools/audio/tests

Only `decide` and the functions it is made of are tested here; they touch no file. The last test
reads the committed assets/audio/game.json and the shipped manifest and checks that they agree.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import ship  # noqa: E402

ROOT = ship.ROOT


def synth(sid, h='aaaaaaaaaaaa', **more):
    return dict({'id': sid, 'category': 'engines', 'source': 'synth', 'licence': 'AGPL-3.0-or-later', 'hash': h}, **more)


def generated(sid, stands_for, verdict='fits', model='MOSS-SoundEffect v2.0', **more):
    lic = 'generated with %s (code and weights Apache-2.0)' % model
    return dict({'id': sid, 'category': 'impacts', 'source': 'generated', 'licence': lic, 'hash': 'bbbbbbbbbbbb',
                 'generated': {'standsFor': stands_for, 'verdict': verdict, 'model': model, 'round': 7, 'candidate': 'ev7_x'}}, **more)


def download(sid, licence='CC0 1.0', **more):
    return dict({'id': sid, 'category': 'switches', 'source': 'download', 'licence': licence, 'hash': 'cccccccccccc'}, **more)


def rating(verdict='fits', stars=0, h='aaaaaaaaaaaa', note=''):
    r = {'stars': stars, 'verdict': verdict, 'note': note, 'at': '2026-11-18T19:00:00.000Z'}
    if h:
        r['hash'] = h
    return r


def run(sounds, ratings, plan):
    return ship.decide({'sounds': sounds}, {'ratings': ratings}, plan)


def row(result, sid):
    return next(r for r in result['sounds'] if r['id'] == sid)


class Approval(unittest.TestCase):
    def test_fits_on_the_current_file(self):
        self.assertEqual(ship.approval(synth('a'), rating())[:2], (True, 'fits'))

    def test_a_positive_rating_on_an_older_file_still_counts_and_is_marked(self):
        self.assertEqual(ship.approval(synth('a'), rating(h='000000000000'))[:2], (True, 'fits-older'))
        self.assertEqual(ship.approval(synth('a'), rating(h=None))[:2], (True, 'fits-older'))

    def test_stars_without_a_verdict(self):
        self.assertEqual(ship.approval(synth('a'), rating(verdict='', stars=5, h=None))[:2], (True, 'stars-older'))
        self.assertEqual(ship.approval(synth('a'), rating(verdict='', stars=4))[:2], (True, 'stars'))
        self.assertEqual(ship.approval(synth('a'), rating(verdict='', stars=3))[:2], (False, 'unrated'))

    def test_a_negative_rating_keeps_a_sound_out_on_any_file(self):
        for h in ('aaaaaaaaaaaa', '000000000000', None):
            self.assertEqual(ship.approval(synth('a'), rating(verdict='wrong', h=h))[:2], (False, 'wrong'))
            self.assertEqual(ship.approval(synth('a'), rating(verdict='close', h=h))[:2], (False, 'close'))

    def test_a_negative_verdict_beats_stars(self):
        self.assertEqual(ship.approval(synth('a'), rating(verdict='wrong', stars=5))[:2], (False, 'wrong'))

    def test_no_rating_is_out_for_a_render_and_in_for_an_accepted_candidate(self):
        self.assertEqual(ship.approval(synth('a'), None)[:2], (False, 'unrated'))
        self.assertEqual(ship.approval(synth('a'), {'stars': 0, 'verdict': '', 'note': ''})[:2], (False, 'unrated'))
        self.assertEqual(ship.approval(generated('g', 'a'), None)[:2], (True, 'candidate'))
        self.assertEqual(ship.approval(generated('g', 'a', verdict='close'), None)[:2], (False, 'unrated'))

    def test_a_rating_of_the_built_sound_beats_the_candidate(self):
        self.assertEqual(ship.approval(generated('g', 'a'), rating(verdict='wrong', h='bbbbbbbbbbbb'))[:2], (False, 'wrong'))

    def test_the_note_is_in_the_reason(self):
        self.assertIn('Klingt übersteuert', ship.approval(synth('a'), rating(verdict='close', note='Klingt übersteuert'))[2])


class Licence(unittest.TestCase):
    def test_what_may_ship(self):
        self.assertTrue(ship.licence_rule(synth('a'))[0])
        self.assertTrue(ship.licence_rule(generated('g', 'a'))[0])
        self.assertTrue(ship.licence_rule(download('k'))[0])

    def test_nasa_waits_for_the_owner(self):
        ok, why = ship.licence_rule(download('n', licence='Public domain (NASA)'))
        self.assertFalse(ok)
        self.assertIn('owner', why)

    def test_stable_audio_never(self):
        self.assertFalse(ship.licence_rule(generated('g', 'a', model='Stable Audio 3 Small-SFX Base'))[0])
        self.assertFalse(ship.licence_rule(download('src_1_hull_2_sa3_p2s11'))[0])

    def test_an_unknown_licence_is_out(self):
        self.assertFalse(ship.licence_rule(download('x', licence='CC BY-NC 4.0'))[0])
        self.assertFalse(ship.licence_rule(download('x', licence=''))[0])


class Decide(unittest.TestCase):
    PLAN = {
        'events': {'a': '', 'b': '', 'c': '', 'd': ''},
        'standIn': {'c': 'a', 'd': 'b'},
        'adopt': {'ui_click': {'sounds': ['k_ok']}, 'ui_other': {'sounds': ['k_wrong']}},
        'never': {'relay': 'his word'},
    }

    def test_an_event_takes_its_own_sound_and_those_that_stand_for_it(self):
        r = run([synth('a'), generated('g1', 'a'), generated('g2', 'a')], {'a': rating()}, self.PLAN)
        self.assertEqual(r['events']['a'], ['a', 'g1', 'g2'])

    def test_a_rejected_render_is_replaced_by_what_stands_for_it(self):
        r = run([synth('a'), generated('g1', 'a')], {'a': rating(verdict='wrong')}, self.PLAN)
        self.assertEqual(r['events']['a'], ['g1'])
        self.assertEqual(row(r, 'a')['code'], 'wrong')

    def test_an_event_with_nothing_approved_is_silent_and_says_why(self):
        r = run([synth('b')], {'b': rating(verdict='wrong', note='dumpf')}, self.PLAN)
        self.assertNotIn('b', r['events'])
        self.assertIn('dumpf', r['silent']['b'])

    def test_an_event_the_library_does_not_have_is_silent(self):
        r = run([], {}, self.PLAN)
        self.assertEqual(set(r['silent']), {'a', 'b', 'c', 'd', 'ui_click', 'ui_other'})

    def test_a_stand_in_needs_a_target_that_has_a_sound(self):
        r = run([synth('a')], {'a': rating()}, self.PLAN)
        self.assertEqual(r['standIn'], {'c': 'a'})
        self.assertIn('d', r['silent'])
        self.assertNotIn('c', r['silent'])

    def test_an_event_with_its_own_sound_does_not_use_its_stand_in(self):
        r = run([synth('a'), synth('c')], {'a': rating(), 'c': rating()}, self.PLAN)
        self.assertEqual(r['standIn'], {})
        self.assertEqual(r['events']['c'], ['c'])

    def test_never_wins_over_a_rating(self):
        r = run([synth('relay')], {'relay': rating()}, dict(self.PLAN, events={'relay': ''}))
        self.assertFalse(row(r, 'relay')['ship'])
        self.assertEqual(row(r, 'relay')['code'], 'never')

    def test_an_approved_sound_without_an_event_stays_out(self):
        r = run([download('k_raw')], {'k_raw': rating(h='cccccccccccc')}, self.PLAN)
        self.assertEqual(row(r, 'k_raw')['code'], 'no-use')

    def test_an_adopted_download_ships_only_when_approved(self):
        r = run([download('k_ok'), download('k_wrong')],
                {'k_ok': rating(h='cccccccccccc'), 'k_wrong': rating(verdict='wrong', h='cccccccccccc')}, self.PLAN)
        self.assertEqual(r['roles'], {'ui_click': ['k_ok']})
        self.assertIn('ui_other', r['silent'])

    def test_a_nasa_file_is_out_by_licence_even_when_adopted_and_approved(self):
        plan = dict(self.PLAN, adopt={'ui_click': {'sounds': ['n_x']}})
        r = run([download('n_x', licence='Public domain (NASA)')], {'n_x': rating(h='cccccccccccc')}, plan)
        self.assertEqual(row(r, 'n_x')['code'], 'licence')

    def test_round_candidates_and_voices_are_not_library_sounds(self):
        cands = [dict(synth('ev7_x'), category='events7'), dict(synth('src_x'), category='source'), dict(synth('v'), category='voice')]
        r = run(cands + [synth('a')], {'ev7_x': rating(), 'a': rating()}, self.PLAN)
        self.assertEqual(r['candidates'], 3)
        self.assertEqual([s['id'] for s in r['sounds']], ['a'])

    def test_a_withdrawn_sound_stays_out(self):
        r = ship.decide({'sounds': [generated('g1', 'a')]}, {'ratings': {}}, self.PLAN, withdrawn=['g1'])
        self.assertEqual(row(r, 'g1')['code'], 'withdrawn')


class Committed(unittest.TestCase):
    """The committed plan and the shipped manifest, as they are in the repository."""

    def setUp(self):
        with open(ship.PLAN, encoding='utf-8') as f:
            self.plan = json.load(f)
        with open(os.path.join(ship.OUT, 'manifest.json'), encoding='utf-8') as f:
            self.manifest = json.load(f)

    def test_the_eight_relay_sounds_are_named_and_not_shipped(self):
        eight = {'relay_click_a', 'relay_click_b', 'switch_toggle', 'switch_rotary', 'breaker_thunk', 'button_press',
                 'systems_power_up', 'systems_power_down'}
        self.assertEqual(set(self.plan['never']), eight)
        shipped = {s['id'] for s in self.manifest['sounds']} | {s.get('event') for s in self.manifest['sounds']}
        self.assertFalse(shipped & eight)

    def test_every_event_asked_for_is_answered_exactly_once(self):
        m = self.manifest
        for ev in self.plan['events']:
            where = [k for k in ('events', 'standIn', 'silent') if ev in m[k]]
            self.assertEqual(len(where), 1, ev)

    def test_every_shipped_file_is_there_and_nothing_else(self):
        files = {s['file'] for s in self.manifest['sounds']}
        on_disk = {n for n in os.listdir(ship.OUT) if n.endswith('.flac')}
        self.assertEqual(files, on_disk)
        for s in self.manifest['sounds']:
            self.assertEqual(os.path.getsize(os.path.join(ship.OUT, s['file'])), s['bytes'], s['id'])

    def test_every_shipped_file_is_in_the_credits(self):
        with open(os.path.join(ship.OUT, 'CREDITS.md'), encoding='utf-8') as f:
            text = f.read()
        for s in self.manifest['sounds']:
            self.assertIn('| %s |' % s['file'], text)

    def test_no_shipped_sound_is_from_nasa_or_stable_audio(self):
        for s in self.manifest['sounds']:
            self.assertTrue(ship.licence_rule(dict(s, source='synth' if s['licence'] == 'AGPL-3.0-or-later' else
                                                   'download' if s['licence'] == 'CC0 1.0' else 'generated'))[0], s['id'])


if __name__ == '__main__':
    unittest.main()
