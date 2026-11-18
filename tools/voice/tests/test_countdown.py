"""Tests of tools/voice/countdown.py (the detector of the vowel onset, the grid, the level matching).
pytest is not in the sound library's environment, so these are plain functions: run with
.venv-audio/Scripts/python.exe tools/voice/tests/test_countdown.py   (pytest, where present, collects them as well)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import countdown as cd  # noqa: E402

SR = cd.SR


def word(burst_ms: float, f0: float = 150.0, tone_ms: float = 300.0, lead_ms: float = 40.0, amp: float = 0.3,
         seed: int = 1, sr: int = SR):
    """Silence, a noise burst, then a harmonic tone (a vowel). Returns (samples, true onset of the tone in samples)."""
    rng = np.random.default_rng(seed)
    lead = int(lead_ms * sr / 1000)
    nb = int(burst_ms * sr / 1000)
    nt = int(tone_ms * sr / 1000)
    t = np.arange(nt) / sr
    tone = sum(np.sin(2 * np.pi * f0 * k * t + 0.3 * k) / k for k in range(1, 13) if f0 * k < 3500)
    tone = tone / np.abs(tone).max()
    ramp = np.minimum(1.0, t / 0.004)           # 4 ms attack
    tone = tone * ramp * np.exp(-t / 0.25)
    burst = rng.normal(0, 1, nb)
    if nb:
        burst = burst / (np.sqrt(np.mean(burst ** 2)) + 1e-12) * np.sqrt(np.mean(tone ** 2))
    x = np.concatenate([np.zeros(lead), burst, tone, np.zeros(int(0.05 * sr))]) * amp
    return x, lead + nb


# ------------------------------------------------------------------ the detector

def test_onset_after_noise_bursts_of_varying_length():
    for burst in (0.0, 30.0, 80.0, 150.0, 250.0):
        for f0 in (110.0, 180.0, 240.0):
            x, true = word(burst, f0)
            o = cd.vowel_onset(x)
            assert o is not None, (burst, f0)
            err_ms = (o["sample"] - true) * 1000.0 / SR
            assert -6.0 <= err_ms <= 12.0, (burst, f0, err_ms)


def test_onset_ignores_a_loud_noise_burst():
    # the burst is as loud as the tone: a level criterion alone would fire at its start
    x, true = word(200.0, 140.0)
    o = cd.vowel_onset(x)
    assert o["sample"] > true - int(0.006 * SR), (o["sample"], true)


def test_onset_moves_with_the_signal_to_the_sample():
    x, true = word(60.0, 160.0)
    o = cd.vowel_onset(x)["sample"]
    for shift in (1, 7, 480, 4800):
        y = np.concatenate([np.zeros(shift), x])
        assert cd.vowel_onset(y)["sample"] == o + shift, shift
    # a gain does not change where the vowel starts
    assert cd.vowel_onset(x * 0.05)["sample"] == o


def test_onset_none_without_a_vowel():
    rng = np.random.default_rng(3)
    assert cd.vowel_onset(rng.normal(0, 0.1, SR // 2)) is None     # noise only
    assert cd.vowel_onset(np.zeros(SR // 2)) is None                # silence
    assert cd.vowel_onset(np.zeros(10)) is None                     # too short


def test_onset_works_at_other_rates():
    x, true = word(80.0, 150.0, sr=24000)
    o = cd.vowel_onset(x, sr=24000)
    assert o is not None and abs(o["sample"] - true) / 24000 < 0.012


# ------------------------------------------------------------------ pieces

def test_fade_and_extent():
    x = np.ones(SR // 10)
    y = cd.fade(x)
    assert y[0] == 0.0 and y[-1] == 0.0 and abs(y[len(y) // 2] - 1.0) < 1e-12
    n = int(0.005 * SR)
    assert np.all(np.diff(y[:n]) >= 0)
    z = np.zeros(SR)
    z[SR // 4: SR // 2] = 0.1
    a, b = cd.sound_extent(z)
    assert abs(a - SR // 4) <= 0.006 * SR and abs(b - SR // 2) <= 0.006 * SR


def test_trim_word_keeps_the_sound():
    x, true = word(50.0, 150.0)
    t, off = cd.trim_word(x)
    assert t.size < x.size and off > 0
    assert off <= true < off + t.size
    # the onset found in the trimmed piece is the same place
    assert abs((off + cd.vowel_onset(t)["sample"]) - cd.vowel_onset(x)["sample"]) <= 2


def test_refine_boundary_finds_the_gap():
    a, _ = word(0.0, 150.0, tone_ms=250.0, lead_ms=0.0)
    b, _ = word(0.0, 200.0, tone_ms=250.0, lead_ms=0.0)
    gap = np.zeros(int(0.06 * SR))
    x = np.concatenate([a, gap, b])
    gap_mid = a.size + gap.size // 2
    k = cd.refine_boundary(x, t_end=(a.size - 0.05 * SR) / SR, t_start=(a.size + gap.size + 0.04 * SR) / SR)
    assert a.size - 0.01 * SR <= k <= a.size + gap.size + 0.01 * SR, (k, gap_mid)


# ------------------------------------------------------------------ levels

def test_level_matching_is_by_gain_and_within_1_5_db():
    words = []
    for i, (amp, burst, f0) in enumerate([(0.4, 60, 150), (0.05, 120, 180), (0.2, 30, 130), (0.01, 90, 200), (0.3, 10, 160)]):
        words.append(word(burst, f0, amp=amp, seed=i)[0])
    before = [cd.sounding_level_db(w) for w in words]
    assert max(before) - min(before) > 10
    gains, common = cd.match_levels(words)
    after = [cd.sounding_level_db(w * 10 ** (g / 20)) for w, g in zip(words, gains)]
    assert max(after) - min(after) < 0.01 < 1.5
    assert abs(np.mean(after) - common) < 1e-6
    gains2, c2 = cd.match_levels(words, ref_db=-30.0)
    after2 = [cd.sounding_level_db(w * 10 ** (g / 20)) for w, g in zip(words, gains2)]
    assert all(abs(v + 30.0) < 0.01 for v in after2) and c2 == -30.0


# ------------------------------------------------------------------ the grid

def _five_words():
    ws, os_ = [], []
    for i, (burst, f0, tone) in enumerate([(120, 150, 350), (90, 130, 300), (60, 170, 400), (30, 200, 250), (150, 140, 320)]):
        w, o = word(burst, f0, tone_ms=tone, lead_ms=0.0, seed=10 + i)
        w, off = cd.trim_word(w)
        ws.append(w)
        os_.append(cd.vowel_onset(w)["sample"])
    return ws, os_


def test_grid_is_exact_to_the_sample():
    intro, _ = word(40.0, 150.0, tone_ms=800.0)
    ws, os_ = _five_words()
    a5 = intro.size + int(0.45 * SR) + 123  # not a round number
    mix, recs = cd.place_words(intro, ws, os_, a5)
    assert [r["anchor"] for r in recs] == [a5 + k * 48000 for k in range(5)]
    assert all(recs[k + 1]["anchor"] - recs[k]["anchor"] == 48000 for k in range(4))
    assert mix.size == a5 + 5 * 48000                       # ends exactly at the fifth grid point
    for k, r in enumerate(recs):
        assert r["start"] + r["vowel_onset_in_word"] == r["anchor"]
    assert all(r["ends_before_next_anchor_minus_guard"] for r in recs)
    # measured again from the finished file, blind (found by the silence between the words)
    ons, runs = cd.vowel_onsets_blind(mix)
    assert len(runs) == 6, runs
    found = [o["sample_in_file"] for o in ons[-5:]]
    for f, r in zip(found, recs):
        assert abs(f - r["anchor"]) <= int(0.002 * SR), (f, r["anchor"])
    iv = np.diff(found) * 1000.0 / SR
    assert np.all(np.abs(iv - 1000.0) < 2.0), iv


def test_words_get_fades_and_are_not_moved_by_their_length():
    ws, os_ = _five_words()
    mix, recs = cd.place_words(np.zeros(100), ws, os_, 24000)
    for k, r in enumerate(recs):
        seg = mix[r["start"]: r["start"] + ws[k].size]
        assert seg[0] == 0.0 and seg[-1] == 0.0
        assert np.array_equal(seg, cd.fade(ws[k]))


def test_a_word_that_is_too_long_is_reported_and_not_cut():
    ws, os_ = _five_words()
    long_w, _ = word(60.0, 150.0, tone_ms=1500.0, lead_ms=0.0, seed=99)
    long_w, _ = cd.trim_word(long_w)
    ws[1] = long_w
    os_[1] = cd.vowel_onset(long_w)["sample"]
    mix, recs = cd.place_words(np.zeros(100), ws, os_, 24000)
    assert recs[1]["ends_before_next_anchor_minus_guard"] is False
    assert all(recs[k]["ends_before_next_anchor_minus_guard"] for k in (0, 2, 3, 4))
    # every sample of the long word is there: the mix equals the sum of the faded words, untouched
    expect = np.zeros(mix.size)
    for r, w in zip(recs, ws):
        expect[r["start"]: r["start"] + w.size] += cd.fade(w)
    expect[:100] += 0.0
    assert np.array_equal(mix, expect)
    assert recs[1]["end_after_anchor_s"] > 0.95


def test_a_last_word_running_past_the_jump_makes_the_file_longer_and_is_reported():
    ws, os_ = _five_words()
    long_w, _ = word(60.0, 150.0, tone_ms=1700.0, lead_ms=0.0, seed=98)
    long_w, _ = cd.trim_word(long_w)
    ws[4], os_[4] = long_w, cd.vowel_onset(long_w)["sample"]
    mix, recs = cd.place_words(np.zeros(100), ws, os_, 24000)
    assert recs[4]["runs_past_the_jump"] is True and mix.size > 24000 + 5 * 48000
    assert recs[4]["ends_before_next_anchor_minus_guard"] is False


def test_a_word_cannot_start_before_the_file():
    ws, os_ = _five_words()
    try:
        cd.place_words(np.zeros(100), ws, os_, os_[0] - 1)
    except ValueError:
        return
    raise AssertionError("a word that would start before sample 0 must be refused")


# ------------------------------------------------------------------ the recogniser's reading, the choices

def test_reading_is_strict():
    assert cd.read_number("Five.", "five") and cd.read_number("5.", "five") and cd.read_number(" 4, ", "four")
    assert not cd.read_number("For.", "four") and not cd.read_number("To.", "two") and not cd.read_number("Won.", "one")
    assert not cd.read_number("Five four", "five") and not cd.read_number("", "five")


def test_find_count_words_takes_the_last_five_in_order():
    toks = ["Jump", "in", "5,", "4,", "3,", "2,", "1."]
    words = [{"word": t} for t in toks]
    assert cd.find_count_words(words) == [2, 3, 4, 5, 6]
    words = [{"word": t} for t in ["jump", "in", "five", "four", "three", "one"]]
    assert cd.find_count_words(words) is None


def test_choice_of_single_takes_by_measurement():
    rng = np.random.default_rng(0)
    base = rng.normal(size=16)
    base /= np.linalg.norm(base)

    def vec(sim):  # a unit vector with the given cosine to base
        o = rng.normal(size=16)
        o -= o.dot(base) * base
        o /= np.linalg.norm(o)
        return sim * base + np.sqrt(1 - sim ** 2) * o

    singles, emb = {}, {"x/intro.wav": base}
    for w in cd.NUMS:
        for k in range(cd.N_WORD_TAKES):
            tid = "%s_s%d" % (w, k + 1)
            singles[tid] = {"seed": k, "reading": cd.DIGIT[w] + "." if k % 2 == 0 else "Hmm.", "reads_as_number": k % 2 == 0,
                            "span_s": 0.4 if k != 2 else 1.1, "level_db": -30.0, "vowel_onset_in_piece": 1000}
            emb["single/%s.wav" % tid] = vec(0.2 + 0.1 * k)
    # for "four" no take reads right: the nearest is taken and the word says so
    for k in range(cd.N_WORD_TAKES):
        singles["four_s%d" % (k + 1)]["reads_as_number"] = False
    ch = cd.choose_single_takes({"singles": singles}, emb, "x/intro.wav")
    # five: takes 1,3,5 read right, take 3 is too long; the most similar of the rest is take 5 (index 4)
    assert ch["five"]["take"] == "five_s5" and ch["five"]["passes"]
    assert ch["four"]["passes"] is False and ch["four"]["note"]
    assert ch["four"]["take"] in ["four_s%d" % (k + 1) for k in range(6)]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok   ", name)
            except Exception as e:  # noqa: BLE001
                fails += 1
                import traceback

                print("FAIL ", name, repr(e))
                traceback.print_exc()
    print("%d failed" % fails if fails else "all passed")
    sys.exit(1 if fails else 0)
