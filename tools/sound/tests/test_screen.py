"""Tests of tools/sound/screen.py and publish.py on synthetic files only.

    .venv-audio/Scripts/python.exe tools/sound/tests/test_screen.py

Plain asserts, run as a script. Nothing is written under assets/audio/render or assets/audio/gen:
a fake tree of synthetic raw files is built under a temporary directory and both scripts are
pointed at it with --root and --out.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SOUND = HERE.parent


def load(name: str):
    spec = importlib.util.spec_from_file_location("sound_" + name, SOUND / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


screen = load("screen")
derive = load("derive")
import soundfile as sf  # noqa: E402

SR = 48000
RNG = np.random.default_rng(7)


def noise(seconds: float, amp: float = 0.3) -> np.ndarray:
    return amp * RNG.standard_normal(int(seconds * SR)) / 3.0


def place(total_s: float, parts: list[tuple[float, np.ndarray]], sr: int = SR) -> np.ndarray:
    x = np.zeros(int(total_s * sr))
    for t, p in parts:
        a = int(t * sr)
        x[a:a + p.size] += p[: x.size - a]
    return x[:, None]


def decaying(seconds: float, db_per_s: float, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return noise(seconds, amp) * 10 ** (-db_per_s * t / 20.0)


def near(a: float, b: float, tol: float, what: str) -> None:
    assert abs(a - b) <= tol, "%s: %.4f is not within %.4f of %.4f" % (what, a, tol, b)


# ---- the cut ------------------------------------------------------------------------------

def test_cut_constant_burst():
    x = place(3.0, [(0.5, noise(0.5))])
    c = screen.cut_event(x, SR, "hull")
    near(c["start"] / SR, 0.5 - 0.003, 0.003, "start")
    near(c["end"] / SR, 1.0, 0.012, "end")
    assert not c["capped"] and c["secondOnset"] is None


def test_cut_decaying_event_ends_45_db_down():
    # 150 dB per second: 45 dB down after 0.3 s
    x = place(3.0, [(0.4, decaying(1.5, 150.0))])
    c = screen.cut_event(x, SR, "hull")
    near(c["start"] / SR, 0.4 - 0.003, 0.004, "start")
    near(c["end"] / SR, 0.4 + 45.0 / 150.0, 0.03, "end")


def test_gap_at_minus_48_db_still_separates_two_events():
    # moss thruster_3: two bursts with 0.6 s between them at 48 dB under the maximum; a 50 dB end never fired
    state = RNG.bit_generator.state  # leave the shared random stream as other tests expect it
    x = place(2.0, [(0.0, noise(0.5)), (1.2, noise(0.6)), (0.5, noise(0.7, 0.0012))])
    RNG.bit_generator.state = state
    c = screen.cut_event(x, SR, "thruster")
    assert not c["capped"], c
    near(c["end"] / SR, 0.5, 0.05, "end")


def test_cut_ignores_a_precursor_more_than_40_db_down():
    x = place(3.0, [(0.2, noise(0.1, 0.0005)), (1.0, noise(0.4))])
    c = screen.cut_event(x, SR, "hull")
    near(c["start"] / SR, 1.0 - 0.003, 0.004, "start")


def test_cut_stops_at_the_family_length():
    x = place(6.0, [(0.5, noise(5.0))])
    for fam, cap in (("hull", 2.5), ("thruster", 1.2), ("shield", 2.5), ("gear", 3.8)):
        c = screen.cut_event(x, SR, fam)
        near((c["end"] - c["onset"]) / SR, cap, 0.001, fam + " length")
        assert c["capped"]


def test_cut_gear_is_everything_from_the_first_sound_to_the_last():
    x = place(5.0, [(0.5, noise(0.3)), (2.0, noise(0.2)), (3.0, noise(0.1))])
    c = screen.cut_event(x, SR, "gear")
    near(c["start"] / SR, 0.5 - 0.003, 0.004, "start")
    near(c["end"] / SR, 3.1, 0.012, "end")
    # the same file as a hull hit is one short event followed by a second one
    h = screen.cut_event(x, SR, "hull")
    near(h["end"] / SR, 0.8, 0.012, "hull end")
    assert h["secondOnset"] is not None


# ---- what is thrown out -------------------------------------------------------------------

def good() -> np.ndarray:
    return place(3.0, [(0.3, decaying(1.0, 90.0))])


def test_a_good_file_has_no_fault():
    for fam in ("hull", "thruster", "shield", "gear"):
        r, info = screen.raw_faults(good(), SR, fam)
        assert r == [], (fam, r)


def test_silent():
    r, _ = screen.raw_faults(good() * 0.001, SR, "hull")
    assert r == ["silent"], r


def test_clipped():
    x = np.clip(good() * 8.0, -1.0, 1.0)
    r, _ = screen.raw_faults(x, SR, "hull")
    assert "clipped" in r, r
    one = good()
    one = one / np.abs(one).max()  # one sample at full scale is not a run
    r, _ = screen.raw_faults(one, SR, "hull")
    assert "clipped" not in r, r


def test_clipped_is_a_flat_top_not_a_value_at_full_scale():
    g = good().astype(np.float32)
    # float beyond full scale without a flat top (what Stable Audio returns before the makers' clamp): not clipped
    loud = g / np.abs(g).max() * 1.7
    assert np.abs(loud).max() > 1.5
    r, _ = screen.raw_faults(loud, SR, "hull")
    assert "clipped" not in r, r
    # values at 0.9995 that differ in the last digits are not a flat top either
    near_full = g / np.abs(g).max() * 0.9995
    r, _ = screen.raw_faults(near_full, SR, "hull")
    assert "clipped" not in r, r
    # a flat top of three equal samples at the extreme is, at any level and at either end
    for level in (1.0, 0.4, 1.7):
        for sign in (1.0, -1.0):
            y = g / np.abs(g).max() * level
            k = int(np.abs(y[:, 0]).argmax())
            y[k - 1:k + 2, 0] = sign * level * 1.05  # three equal samples that are the new extreme of the channel
            assert screen.has_flat_top(y), (level, sign)
            r, _ = screen.raw_faults(y, SR, "hull")
            assert "clipped" in r, (level, sign, r)
    # two equal samples are not a run, and the repeated value must be the extreme
    y = g / np.abs(g).max()
    k = int(np.abs(y[:, 0]).argmax())
    y[k - 1:k + 1, 0] = 1.2
    assert not screen.has_flat_top(y)
    y2 = np.full((1000, 1), 0.3, dtype=np.float32)
    y2[500, 0] = 0.9  # a flat stretch that is not at the extreme
    assert not screen.has_flat_top(y2)
    # one channel of two is enough, and silence (zeros are equal) is not a flat top
    st = np.concatenate([g * 0.5, g * 0.5], axis=1)
    st[100:104, 1] = st[:, 1].max() * 1.1
    assert screen.has_flat_top(st)
    assert not screen.has_flat_top(np.zeros((1000, 2), dtype=np.float32))


def test_two_events_where_one_was_asked():
    x = place(3.0, [(0.3, decaying(0.6, 120.0)), (1.6, decaying(0.6, 120.0))])
    for fam in ("hull", "thruster", "shield"):
        r, info = screen.raw_faults(x, SR, fam)
        assert r == ["several-events"], (fam, r)
        near(info["secondOnsetS"], 1.6, 0.01, "second onset")
    r, _ = screen.raw_faults(x, SR, "gear")  # the gear may have a motor and a lock
    assert r == [], r
    # a second event under half the first one's level does not count
    y = place(3.0, [(0.3, decaying(0.6, 120.0)), (1.6, decaying(0.6, 120.0) * 0.3)])
    r, _ = screen.raw_faults(y, SR, "hull")
    assert r == [], r


def test_cut_off():
    x = place(1.5, [(0.3, noise(2.0))])  # still going when the file ends
    r, _ = screen.raw_faults(x, SR, "hull")
    assert r == ["cut-off"], r
    r, _ = screen.raw_faults(x, SR, "gear")
    assert r == ["cut-off"], r


def test_cut_by_the_family_length_while_still_loud_is_cut_off_like_the_end_of_a_file():
    # a steady sound that runs past the family length of a hull hit (2.5 s) inside a file that goes on to 5 s and ends quietly
    x = place(5.0, [(0.3, noise(3.5)), (3.8, decaying(1.2, 90.0, 0.05))])
    r, info = screen.raw_faults(x, SR, "hull")
    assert r == ["cut-off"], r
    assert info["cutOffAt"] == "family-length" and info["_cut"]["capped"], info
    assert info["lastDbBelowMaxAtCap"] < 20.0, info
    # a sound that dies away by itself before the cap is not cut off
    y = place(5.0, [(0.3, decaying(4.0, 60.0))])
    r, info = screen.raw_faults(y, SR, "hull")
    assert r == [] and not info["_cut"]["capped"], (r, info)
    # a capped event that has died away 20 dB or more by the cap passes the rule and is only recorded as capped
    z = place(5.0, [(0.3, decaying(4.5, 12.0))])  # 12 dB per second: about 30 dB down at the cap, about 45 dB down only after 3.7 s
    r, info = screen.raw_faults(z, SR, "hull")
    assert info["_cut"]["capped"] and info["lastDbBelowMaxAtCap"] >= 20.0 and r == [], (r, info)
    # the end of the file is judged first and keeps its own mark
    w = place(1.5, [(0.3, noise(2.0))])
    r, info = screen.raw_faults(w, SR, "hull")
    assert r == ["cut-off"] and info["cutOffAt"] == "end-of-file", (r, info)
    # the gear, whose cut also ends at its family length (3.8 s), follows the same rule
    gx = place(5.0, [(0.0, noise(4.6))])
    r, info = screen.raw_faults(gx, SR, "gear")
    assert r == ["cut-off"], (r, info)


def test_too_short():
    x = place(3.0, [(0.3, noise(0.03))])
    r, _ = screen.raw_faults(x, SR, "hull")
    assert r == ["too-short"], r
    x = place(3.0, [(0.3, noise(0.12))])
    r, _ = screen.raw_faults(x, SR, "hull")
    assert r == [], r


def test_speech_and_music_rules():
    assert not screen.is_speech("Thank you.")
    assert not screen.is_speech("")
    assert screen.is_speech("this is not it")
    assert screen.is_speech("Well, hello there!")
    m = screen.MUSIC_TEXT
    assert screen.is_music({"a": 0.2, "b": 0.3, m: 0.31})
    assert not screen.is_music({"a": 0.2, "b": 0.32, m: 0.31})


# ---- the vector and the choice --------------------------------------------------------------

def cand(source: str, name: str, freq: float, length: float = 0.5) -> dict:
    t = np.arange(int(length * SR)) / SR
    ev = (np.sin(2 * np.pi * freq * t) * np.exp(-6 * t))[:, None] + 0.01 * RNG.standard_normal((t.size, 1))
    return {"source": source, "name": name, "raw": screen.describe(ev, SR)}


def test_describe_shape_and_difference():
    a, b = cand("moss", "a", 100.0), cand("moss", "b", 3000.0)
    assert a["raw"].shape == (3 * len(screen.BAND_CENTRES) + 2,)
    assert np.isfinite(a["raw"]).all()
    assert np.abs(a["raw"] - b["raw"]).max() > 20  # a low and a high tone differ in some band by dBs


def fake_family(skip: tuple = ()) -> list[dict]:
    out = []
    for s, base in (("moss", 80.0), ("sa3", 200.0), ("oga", 500.0)):
        if s in skip:
            continue
        for i in range(5):
            out.append(cand(s, "%s_%d" % (s, i), base * (1 + 0.3 * i), 0.3 + 0.1 * i))
    return out


def test_choice_four_per_family_and_deterministic():
    picks, notes = screen.choose(fake_family())
    assert [p["slot"] for p in picks] == [1, 2, 3, 4], picks
    assert [p["cand"]["source"] for p in picks[:3]] == ["moss", "sa3", "oga"]
    assert picks[3]["cand"]["source"] in ("moss", "sa3") and picks[3]["role"] == "farthest"
    assert len({p["cand"]["name"] for p in picks}) == 4
    assert notes == []
    again, _ = screen.choose(list(reversed(fake_family())) if False else fake_family())
    names = [p["cand"]["name"] for p in picks]
    # the same candidates in another order give the same choice
    f = fake_family()
    shuffled = [f[i] for i in RNG.permutation(len(f))]
    p2, _ = screen.choose(shuffled)
    assert [p["cand"]["name"] for p in p2] == names
    assert [p["cand"]["name"] for p in again] == [p["cand"]["name"] for p in again]


def test_typical_is_nearest_to_the_middle_of_its_source():
    f = fake_family()
    picks, _ = screen.choose(f)
    z = screen.normalise(np.array([c["raw"] for c in sorted(f, key=lambda c: (screen.SOURCES.index(c["source"]), c["name"]))]))
    ordered = sorted(f, key=lambda c: (screen.SOURCES.index(c["source"]), c["name"]))
    for p in picks[:3]:
        idx = [i for i, c in enumerate(ordered) if c["source"] == p["cand"]["source"]]
        centre = z[idx].mean(axis=0)
        best = min(idx, key=lambda i: (np.linalg.norm(z[i] - centre), i))
        assert ordered[best]["name"] == p["cand"]["name"]


def test_choice_without_candidates_of_a_source():
    picks, notes = screen.choose(fake_family(skip=("oga",)))
    assert len(picks) == 4 and [p["slot"] for p in picks] == [1, 2, 3, 4]
    assert any("oga has no remaining candidate" in n for n in notes), notes
    assert picks[2]["role"] == "second" and picks[2]["cand"]["source"] in ("moss", "sa3")
    assert len({p["cand"]["name"] for p in picks}) == 4
    picks, notes = screen.choose([c for c in fake_family() if c["source"] == "oga"])
    assert [p["slot"] for p in picks] == [3] or len(picks) >= 1
    assert all(p["slot"] != 4 for p in picks)  # the fourth pick comes from the two generative sources only
    assert any("no remaining generative candidate" in n for n in notes), notes
    assert screen.choose([]) == ([], ["no candidate in this family"])


# ---- the listening copy ---------------------------------------------------------------------

def check_copy(y, info, target, sr_in_channels):
    """target: the family's target. The page measure (BS.1770 over two channels, a one-channel file counted on
    both) of the finished copy must be the target plus 3.01 dB to within 0.05 LU, unless the ceiling stopped it."""
    from synth.levels import lufs, true_peak_db

    assert info["sr"] == 48000 and y.shape[1] == sr_in_channels
    assert true_peak_db(y) <= -1.0, true_peak_db(y)
    thr = 10 ** (-60 / 20)
    assert np.abs(y[0]).max() <= thr, "first sample %.5f" % np.abs(y[0]).max()
    assert np.abs(y[-int(0.010 * 48000):]).max() <= thr, "tail not silent"
    page = screen.page_lufs(y)
    near(info["lufsReachedPage"], page, 0.006, "recorded page loudness")
    assert info["lufsTarget"] == target and abs(info["lufsPageTarget"] - (target + 10 * np.log10(2))) < 0.001
    if not info["limitedByPeak"]:
        near(page, target + 10 * np.log10(2), 0.05, "loudness at the page")
        if sr_in_channels == 1:
            near(lufs(y), target, 0.05, "a one-channel file keeps the family target")
    else:
        assert page < target + 10 * np.log10(2) - 0.05


def test_listening_copy_mono_44k():
    sr = 44100
    t = np.arange(int(0.8 * sr)) / sr
    ev = (0.6 * np.cos(2 * np.pi * 120 * t) * np.exp(-3 * t))[:, None]  # starts loud: a step at the start
    y, info = screen.listening_copy(ev, sr, -34.0)
    check_copy(y, info, -34.0, 1)
    assert info["rampIn"] and info["fadeOut"]
    near(y.shape[0] / 48000, 0.8 + 0.0015 + 0.010, 0.002, "length")
    # the recording itself is not faded at the start: the samples after the ramp are the resampled ones
    n = int(round(0.0015 * 48000))
    assert np.abs(y[:n]).max() <= np.abs(y[n:n + 400]).max() + 1e-9
    assert np.abs(y[n]).max() > 10 ** (-60 / 20)


def test_listening_copy_removes_a_mean_the_page_would_fail():
    sr = 48000
    t = np.arange(int(1.0 * sr)) / sr
    ev = (0.3 * np.sin(2 * np.pi * 50 * t) * np.exp(-2 * t) + 0.03 * np.exp(-3 * t))[:, None]  # sub-bass plus a one-sided push
    y, info = screen.listening_copy(ev, sr, -24.0)
    assert info["dcBefore"] >= 0.001 and info["dcAfter"] < 1e-4, info
    assert abs(float(y.mean())) < 1e-4
    assert np.abs(y[0]).max() <= 10 ** (-60 / 20) and np.abs(y[-1]).max() <= 10 ** (-60 / 20)  # no step at either end
    assert info["truePeakDb"] <= -1.0


def test_listening_copy_keeps_two_channels_and_mixes_more_down():
    sr = 32000
    t = np.arange(int(0.6 * sr)) / sr
    env = np.exp(-8 * t)
    st = np.stack([np.sin(2 * np.pi * 300 * t) * env, np.sin(2 * np.pi * 450 * t) * env], axis=1)
    y, info = screen.listening_copy(st, sr, -34.0)
    check_copy(y, info, -34.0, 2)
    assert info["channels"] == 2
    four = np.concatenate([st, st * 0.5], axis=1)
    y4, info4 = screen.listening_copy(four, sr, -34.0)
    check_copy(y4, info4, -34.0, 2)
    assert y4.shape[1] == 2


def test_two_channels_and_one_channel_leave_the_page_equally_loud():
    # the page adds the energies of its two channels: the family target is met by a one-channel file over its own
    # channel (as the first run set it) and by a two-channel file 3.01 dB higher over its two
    sr = 48000
    t = np.arange(int(0.9 * sr)) / sr
    env = np.exp(-4 * t)
    one = (0.5 * np.sin(2 * np.pi * 220 * t) * env)[:, None]
    two = np.concatenate([one, one * 0.8], axis=1)
    y1, i1 = screen.listening_copy(one, sr, -34.0)
    y2, i2 = screen.listening_copy(two, sr, -34.0)
    check_copy(y1, i1, -34.0, 1)
    check_copy(y2, i2, -34.0, 2)
    near(i1["lufsReached"], -34.0, 0.05, "one channel, own loudness")
    near(i2["lufsReached"], -34.0 + 10 * np.log10(2), 0.05, "two channels, own loudness")
    # energy over both channels of what the page plays: a one-channel file on both sides against the two channels
    e1 = 2.0 * float((y1[:, 0] ** 2).sum())
    e2 = float((y2 ** 2).sum())
    near(10 * np.log10(e1 / e2), 0.0, 0.1, "energy at the page, one channel against two")
    # a one-channel copy is where the old rule put it (same gain for a plain event)
    from synth.levels import set_level

    old, _ = set_level(screen.resample(one, sr), "lufs", -34.0)
    near(20 * np.log10(np.abs(y1).max() / np.abs(old).max()), 0.0, 0.1, "gain against the old rule")


def test_level_is_measured_after_the_processing_and_corrected():
    # an event with a long quiet tail and a gain that changes what the gate of BS.1770 counts (src_1_hull_1_moss
    # reached -33.19 against -34.0 because one gain was applied and never checked)
    sr = 48000
    t = np.arange(int(2.2 * sr)) / sr
    ev = (0.5 * np.sin(2 * np.pi * 180 * t) * 10 ** (-60.0 * t / 20.0))[:, None]
    ev[:, 0] *= np.minimum(1.0, t / 0.01)
    from synth.levels import lufs

    y, info = screen.listening_copy(ev, sr, -34.0)
    near(lufs(y), -34.0, 0.05, "after correction")
    assert abs(info["levelErrorDb"]) <= 0.05, info
    near(info["lufsReached"], lufs(y), 0.006, "recorded")
    near(info["lufsReachedPage"], screen.page_lufs(y), 0.006, "recorded page")
    # an event that starts and ends loud gets its ramp and fade, and the level is measured with them
    loud = (0.7 * np.cos(2 * np.pi * 100 * t[: int(0.5 * sr)]))[:, None]
    y2, i2 = screen.listening_copy(loud, sr, -34.0)
    assert i2["rampIn"] and i2["fadeOut"]
    near(lufs(y2), -34.0, 0.05, "with fade and ramp")


def test_listening_copy_limited_by_the_peak_records_what_was_reached():
    sr = 48000
    ev = np.zeros((int(0.5 * sr), 1))
    ev[100] = 0.9  # a click and a quiet bed: a loud target needs more than the ceiling allows
    ev += 0.0005 * RNG.standard_normal(ev.shape)
    y, info = screen.listening_copy(ev, sr, -14.0)
    assert info["limitedByPeak"] and info["truePeakDb"] <= -1.0
    assert info["lufsReached"] < -14.0
    assert info["lufsReachedPage"] < info["lufsPageTarget"] - 0.05 and abs(info["levelErrorDb"]) > 0.05
    assert info["truePeakDb"] > -1.3  # it went up to the ceiling and stopped there


def test_listening_copy_of_an_event_that_died_away_is_not_faded():
    sr = 48000
    t = np.arange(int(1.0 * sr)) / sr
    ev = (0.5 * np.sin(2 * np.pi * 200 * t) * 10 ** (-120 * t / 20))[:, None]
    ev[:, 0] *= np.minimum(1.0, t / 0.02)
    y, info = screen.listening_copy(ev, sr, -34.0)
    assert not info["fadeOut"] and not info["rampIn"], info


# ---- both scripts on a fake tree --------------------------------------------------------------

def build_tree(root: Path) -> None:
    prompts = json.loads((SOUND / "prompts.json").read_text(encoding="utf-8"))
    for key, sr, nch in (("moss", 48000, 1), ("sa3", 44100, 2), ("oga", 44100, 1)):
        items = {}
        (root / key / "raw").mkdir(parents=True)
        for fi, fam in enumerate(prompts["families"]):
            if key == "oga" and fam["id"] == "hull":
                continue  # no recording of a hull hit
            for k in range(5):
                n = "%s_%d__s%d" % (fam["id"], k % 3 + 1, 11 + k) if key != "oga" else "%s__rec%d" % (fam["id"], k)
                dur = 1.0 + 0.2 * k if fam["id"] != "gear" else 2.5
                sr_ = sr
                t = np.arange(int(dur * sr_)) / sr_
                f0 = (60 + 40 * k + 25 * fi) * (1 + 0.5 * (key == "sa3"))
                x = np.sin(2 * np.pi * f0 * t) * 10 ** (-(60 + 20 * k) * t / 20) + 0.2 * RNG.standard_normal(t.size) * 10 ** (-90 * t / 20)
                x = (0.6 * x)[:, None]
                if nch == 2:
                    x = np.concatenate([x, 0.7 * x], axis=1)
                if key == "oga" and k == 4:
                    x = x * 0.0005  # a silent one
                if key == "moss" and k == 3:
                    x = np.concatenate([x, 0.4 * RNG.standard_normal(x.shape) * (np.arange(x.shape[0]) > x.shape[0] // 2)[:, None]])  # cut off
                sf.write(str(root / key / "raw" / (n + ".wav")), x.astype(np.float32), sr_, subtype="FLOAT")
                rec = {"file": "raw/%s.wav" % n, "sr": sr_, "channels": nch, "family": fam["id"], "seed": 11 + k}
                if key == "oga":
                    rec.update({"title": "Rec %d" % k, "author": "Some Author", "pageUrl": "https://opengameart.org/content/x%d" % k,
                                "licence": "CC0"})
                else:
                    rec.update({"prompt": "%s_1" % fam["id"], "text_given": fam["prompts"][0]["text"]})
                items[n] = rec
        (root / key / "gen.json").write_text(json.dumps({"source": key, "items": items}), encoding="utf-8")


def test_both_scripts_on_a_fake_tree():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "gen"
        build_tree(root)
        no_skips = str(Path(td) / "none.json")
        assert screen.main(["--no-models", "--root", str(root), "--skips", no_skips]) == 0
        first = (root / "screen.json").read_bytes()
        def samples(folder: Path) -> dict:
            # the samples, not the bytes: libsndfile writes the time of day into the PEAK chunk of a float WAV header
            return {p.name: sf.read(str(p), dtype="float32", always_2d=True)[0].tobytes() for p in folder.glob("*.wav")}

        listen = samples(root / "_listen")
        assert b"\r" not in first
        res = json.loads(first)
        assert res["settings"]["models"] is False
        for fam, n in (("hull", 4), ("thruster", 4), ("gear", 4), ("shield", 4)):
            ids = res["families"][fam]["chosen"]
            assert len(ids) == n, (fam, ids)
        assert res["families"]["hull"]["candidates"]["oga"] == 0
        assert any("oga has no remaining" in x for x in res["families"]["hull"]["notes"])
        assert len(res["chosen"]) == 16 and len(listen) == 16
        reasons = {f["reason"] for f in res["files"] if f["status"] != "kept"}
        assert "silent" in reasons and "cut-off" in reasons, reasons
        for f in res["files"]:
            assert f["status"] == "kept" or f["reason"], f
        ids = [c["id"] for c in res["chosen"]]
        assert any(i.startswith("src_1_hull_1_moss_p") for i in ids) and any(i.startswith("src_2_thruster_3_oga_rec") for i in ids)
        assert any(i.startswith("src_4_shield_4_") for i in ids)
        # deterministic: the same files give the same choice and the same copies
        assert screen.main(["--no-models", "--root", str(root), "--skips", no_skips]) == 0
        assert (root / "screen.json").read_bytes() == first
        assert samples(root / "_listen") == listen

        build = sys.modules["build"] if "build" in sys.modules else None
        pub = load("publish")
        out = Path(td) / "render"
        import build as b  # noqa: E402  (tools/audio/build.py, found by publish.py's path)

        b.SELECTION = Path(td) / "no-selection.json"  # the real downloads are not part of this test
        b.GENERATED_LIST = Path(td) / "no-generated.json"  # nor are the generated sounds of the library (the g_ ids)
        assert pub.main(["--root", str(root), "--out", str(out)]) == 0
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        sounds = [s for s in manifest["sounds"] if s["category"] == "source"]
        assert len(sounds) == 16
        assert [c["id"] for c in manifest["categories"]][0] == "source"
        assert [s["id"] for s in sounds] == sorted(s["id"] for s in sounds)
        s0 = next(s for s in sounds if s["id"].startswith("src_1_hull_1_moss_p"))
        assert s0["de"] == "Rumpftreffer · MOSS-SoundEffect" and s0["en"] == "Hull hit · MOSS-SoundEffect"
        assert s0["dry"] is False and s0["place"] == 0 and s0["source"] == "synth" and s0["kind"] == "oneshot"
        assert s0["path"] == "structure" and "Apache-2.0" in s0["licence"] and "seed" in s0["intent"]
        s2 = next(s for s in sounds if s["id"].startswith("src_2_thruster_2_sa3_p"))
        assert s2["channels"] == 2 and "place" not in s2 and "nur Test" in s2["de"] and "Community License" in s2["licence"]
        assert "last training stage" in s2["intent"]
        s3 = next(s for s in sounds if s["id"].startswith("src_2_thruster_3_oga_rec"))
        assert s3["source"] == "download" and s3["licence"].endswith("CC0") and "Some Author" in s3["licence"]
        s4 = next(s for s in sounds if s["id"].startswith("src_4_shield_4_"))
        assert s4["de"].endswith("zweite Auswahl") and s4["path"] == "energy"
        for s in sounds:
            assert s["checks"]["hints"][0] == "candidate: only the level rules apply"
            assert s["checks"]["pass"], (s["id"], s["checks"])
            assert "energyAbove60Hz" in s["checks"] and "Share of the event's energy above 60 Hz" in s["intent"], s["id"]
            lis = s["candidate"]["listen"]
            assert abs(lis["levelErrorDb"]) <= 0.05 or lis["limitedByPeak"], (s["id"], lis)
            assert {"lufsTarget", "lufsPageTarget", "lufsReached", "lufsReachedPage", "gainDb"} <= set(lis)
        # the real categories and ratings are untouched, and removing takes the category away again
        assert pub.main(["--root", str(root), "--out", str(out), "--remove"]) == 0
        assert not (out / "source").exists()
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        assert not [s for s in manifest["sounds"] if s["category"] == "source"]


def test_energy_share_above_60_hz():
    t = np.arange(SR) / SR
    low = np.sin(2 * np.pi * 30 * t)[:, None]
    high = np.sin(2 * np.pi * 200 * t)[:, None]
    assert screen.energy_share_above(low, SR) < 0.01
    assert screen.energy_share_above(high, SR) > 0.99
    near(screen.energy_share_above(low + high, SR), 0.5, 0.01, "equal energy below and above")
    two = np.concatenate([low, high], axis=1)  # the energies of the channels are added
    near(screen.energy_share_above(two, SR), 0.5, 0.01, "two channels")
    assert screen.energy_share_above(np.zeros((100, 1)), SR) == 0.0
    assert screen.LOW_HZ == 60.0


def test_candidate_tags_name_the_candidate_and_make_valid_ids():
    assert screen.candidate_tag("moss", "gear_2__s16", {}) == "p2s16"
    assert screen.candidate_tag("sa3", "hull_3__s11", {"prompt": "hull_3", "seed": 11}) == "p3s11"
    assert screen.candidate_tag("moss", "odd", {"prompt": "thruster_1", "seed": 14}) == "p1s14"
    assert screen.candidate_tag("oga", "gear__Chain Winch #2.wav", {}) == "chain-winch-2-wav"
    assert screen.candidate_tag("oga", "shield__steam-release", {}) == "steam-release"
    assert screen.candidate_tag("oga", "###", {}) == "x"
    assert len(screen.candidate_tag("oga", "hull__" + "a" * 100, {})) <= 32
    for sid in ("src_3_gear_1_moss_p2s16", "src_2_thruster_3_oga_" + screen.candidate_tag("oga", "thruster__Door Lock", {})):
        assert screen.ID_PATTERN.match(sid), sid
    # the tag belongs to the candidate: another seed or another prompt gives another id
    assert screen.candidate_tag("moss", "gear_2__s16", {}) != screen.candidate_tag("moss", "gear_2__s15", {})
    assert screen.candidate_tag("moss", "gear_2__s16", {}) != screen.candidate_tag("moss", "gear_1__s16", {})


def test_the_committed_skips_are_read_by_default_and_skip_adds():
    sk = screen.load_skips(screen.SKIPS_FILE)
    # The list changes from run to run (a skip is dropped when a rule comes to catch its file), so only its form is
    # fixed here: at least one entry, each "source/name" of a known source with a reason.
    assert sk and all(k.count("/") == 1 and k.split("/")[0] in screen.SOURCES and v.strip() for k, v in sk.items()), sk
    assert screen.load_skips(None) == {} and screen.load_skips(Path("does-not-exist.json")) == {}
    # a skipped candidate stays in the pool but is not picked: the next nearest takes its place
    picks, _ = screen.choose(fake_family())
    first = picks[0]["cand"]["name"]
    f2 = fake_family()
    for c in f2:
        if c["name"] == first:
            c["skip"] = "plain fault"
    picks2, _ = screen.choose(f2)
    assert first not in [p["cand"]["name"] for p in picks2] and len(picks2) == 4
    # a plain run reads the file, --skip adds to it, --skips names another one
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "gen"
        build_tree(root)
        assert screen.main(["--no-models", "--root", str(root), "--skip", "moss/hull_1__s11=by hand"]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        assert set(res["skippedAsPick"]) == set(sk) | {"moss/hull_1__s11"}, res["skippedAsPick"]
        assert res["skippedAsPick"]["moss/hull_1__s11"] == "by hand"
        assert not any(c["name"] == "hull_1__s11" and c["source"] == "moss" for c in res["chosen"])
        other = Path(td) / "other.json"
        other.write_text(json.dumps({"skips": [{"candidate": "sa3/gear_1__s11", "reason": "r"}]}), encoding="utf-8")
        assert screen.main(["--no-models", "--root", str(root), "--skips", str(other)]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        assert res["skippedAsPick"] == {"sa3/gear_1__s11": "r"}


def test_capped_events_and_flat_tops_are_thrown_out_in_a_run_and_the_share_is_recorded():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "gen"
        build_tree(root)
        # one more MOSS hull file that is steady for 4 s of a 5 s file and ends quietly: cut by the family length while loud
        n = int(5.0 * SR)
        x = np.concatenate([noise(4.0, 0.3), decaying(1.0, 90.0, 0.003)])[:n]
        sf.write(str(root / "moss" / "raw" / "hull_1__s99.wav"), x.astype(np.float32), SR, subtype="FLOAT")
        # a Stable Audio hull file clamped at full scale, and one that goes beyond full scale without a flat top
        t = np.arange(int(2 * 44100)) / 44100
        env = np.exp(-5 * t)
        clamped = np.clip(3.0 * np.sin(2 * np.pi * 150 * t) * env, -1.0, 1.0)
        beyond = 1.6 * np.sin(2 * np.pi * 150 * t) * env
        for nm, sig in (("hull_1__s98", clamped), ("hull_1__s97", beyond)):
            sf.write(str(root / "sa3" / "raw" / (nm + ".wav")), np.stack([sig, sig], axis=1).astype(np.float32), 44100, subtype="FLOAT")
        for key, names in (("moss", ["hull_1__s99"]), ("sa3", ["hull_1__s98", "hull_1__s97"])):
            gj = json.loads((root / key / "gen.json").read_text(encoding="utf-8"))
            for nm in names:
                gj["items"][nm] = {"file": "raw/%s.wav" % nm, "family": "hull", "prompt": "hull_1", "seed": int(nm.split("s")[-1]), "text_given": "t"}
            (root / key / "gen.json").write_text(json.dumps(gj), encoding="utf-8")
        assert screen.main(["--no-models", "--root", str(root), "--skips", str(Path(td) / "none.json")]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        rows = {(f["source"], f["name"]): f for f in res["files"]}
        capped = rows[("moss", "hull_1__s99")]
        assert capped["status"] == "thrown-out" and capped["reason"] == "cut-off" and capped["cutOffAt"] == "family-length", capped
        assert rows[("sa3", "hull_1__s98")]["reason"] == "clipped"
        assert rows[("sa3", "hull_1__s97")]["status"] == "kept", rows[("sa3", "hull_1__s97")]
        for f in res["files"]:
            if f["status"] == "kept":
                assert 0.0 <= f["energyAbove60Hz"] <= 1.0, f
        for c in res["chosen"]:
            assert c["energyAbove60Hz"] is not None and c["tag"] and c["id"].endswith("_" + c["tag"])


def test_publish_removes_what_is_not_in_the_new_set_and_leaves_the_build_order():
    import copy

    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "gen"
        out = Path(td) / "render"
        build_tree(root)
        assert screen.main(["--no-models", "--root", str(root), "--skips", str(Path(td) / "none.json")]) == 0
        import build as b  # noqa: E402

        b.SELECTION = Path(td) / "no-selection.json"
        b.GENERATED_LIST = Path(td) / "no-generated.json"  # without this the 8 g_ ids of assets/audio/generated.json are built in
        pub = load("publish")
        assert pub.main(["--root", str(root), "--out", str(out)]) == 0
        target = out / "source"
        ids = sorted(p.stem for p in target.glob("*.wav"))
        assert len(ids) == 16
        # files of an earlier pick (an old id), and a stray file
        old = "src_1_hull_1_moss"
        for ext in (".wav", ".png", ".json"):
            (target / (old + ext)).write_bytes((target / (ids[0] + ext)).read_bytes())
        rec = json.loads((target / (old + ".json")).read_text(encoding="utf-8"))
        rec["manifest"]["id"] = old
        rec["manifest"]["file"] = "source/%s.wav" % old
        rec["manifest"]["spectrogram"] = "source/%s.png" % old
        (target / (old + ".json")).write_text(json.dumps(rec), encoding="utf-8")
        (target / "notes.txt").write_text("x", encoding="utf-8")
        # a sound of a category that comes first in the order of the build (an id of sounds.json)
        (out / "engines").mkdir()
        e = copy.deepcopy(json.loads((target / (ids[0] + ".json")).read_text(encoding="utf-8")))
        e["manifest"].update({"id": "engine_main_t000", "category": "engines", "file": "engines/engine_main_t000.wav",
                              "spectrogram": "engines/engine_main_t000.png", "path": "structure", "kind": "oneshot"})
        for ext in (".wav", ".png"):
            (out / "engines" / ("engine_main_t000" + ext)).write_bytes((target / (ids[0] + ext)).read_bytes())
        (out / "engines" / "engine_main_t000.json").write_text(json.dumps(e), encoding="utf-8")
        assert pub.main(["--root", str(root), "--out", str(out)]) == 0
        assert sorted(p.stem for p in target.glob("*.wav")) == ids
        assert not (target / (old + ".json")).exists() and not (target / "notes.txt").exists()
        assert sorted({p.name.split(".")[0] for p in target.iterdir()}) == ids
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        order = [s["id"] for s in manifest["sounds"]]
        assert old not in order
        # the manifest is in the order of build.py: the id it knows first, the ids it does not know after it, none moved to the front
        assert order[0] == "engine_main_t000" and order[1:] == sorted(order[1:]) and len(order) == 17, order[:3]


# ---- round 5: another prompts file, family settings, picks, carried candidates ---------------------

def test_jobs_follow_the_prompts_file_and_the_family_seeds():
    common = load("common")
    try:
        old = common.jobs()
        spec4 = json.loads((SOUND / "prompts.json").read_text(encoding="utf-8"))
        assert len(old) == sum(len(f["prompts"]) for f in spec4["families"]) * len(spec4["seeds"])
        assert {j["seed"] for j in old} == set(spec4["seeds"])  # the defaults are round 4
        common.configure(str(SOUND / "prompts5.json"), None)
        spec5 = json.loads((SOUND / "prompts5.json").read_text(encoding="utf-8"))
        jobs = common.jobs()
        valve = [j for j in jobs if j["family"] == "thruster_valve"]
        assert [j["seed"] for j in valve] == [21, 22, 23, 24, 25, 26], valve
        others = {j["seed"] for j in jobs if j["family"] != "thruster_valve"}
        assert others == set(spec5["seeds"])
        assert len(jobs) == sum(len(f["prompts"]) * len(f.get("seeds") or spec5["seeds"]) for f in spec5["families"])
        assert all(j["seconds"] == next(f for f in spec5["families"] if f["id"] == j["family"])["seconds"] for j in jobs)
        assert [j["seed"] for j in common.jobs("thruster_valve", None, "3,4")] == [3, 4]  # --seeds wins
        assert [j["name"] for j in common.jobs("hull_light", "hull_light_2", None)][0] == "hull_light_2__s11"
    finally:
        common.configure(str(SOUND / "prompts.json"), str(common.DEFAULT_OUT))


def test_the_record_goes_under_the_output_root():
    common = load("common")
    with tempfile.TemporaryDirectory() as td:
        common.configure(str(SOUND / "prompts5.json"), str(Path(td) / "r5"))
        job = common.jobs("hull_light", "hull_light_1", "11")[0]
        rec = common.Record("moss", model="m")
        rec.item(job, np.zeros(480, dtype=np.float32) + 0.1, 48000, 1.0)
        rec.save()
        gj = json.loads((Path(td) / "r5" / "moss" / "gen.json").read_text(encoding="utf-8"))
        assert (Path(td) / "r5" / "moss" / "raw" / "hull_light_1__s11.wav").is_file()
        assert gj["promptsFile"].endswith("prompts5.json") and gj["items"]["hull_light_1__s11"]["family"] == "hull_light"
        # a second record adds to the first, and keeps items it did not make (those carried from round 4)
        gj["items"]["thruster_1__s12"] = {"fromRound4": True, "family": "thruster_valve"}
        (Path(td) / "r5" / "moss" / "gen.json").write_text(json.dumps(gj), encoding="utf-8")
        rec2 = common.Record("moss", model="m")
        assert set(rec2.data["items"]) == {"hull_light_1__s11", "thruster_1__s12"}
        # with the defaults nothing new is written to gen.json
        common.configure(str(SOUND / "prompts.json"), str(Path(td) / "r4"))
        assert "promptsFile" not in common.Record("moss").data


def test_family_settings_fall_back_to_round_4():
    for fid, cap in (("hull", 2.5), ("thruster", 1.2), ("gear", 3.8), ("shield", 2.5)):
        s = screen.family_settings({"id": fid, "lufs": -34.0})
        assert s["maxS"] == cap and s["picks"] is None and s["minAbove60Hz"] is None
        assert s["oneEvent"] == (fid != "gear") and s["lufs"] == -34.0
    s = screen.family_settings({"id": "hull_light", "lufs": -34, "maxS": 1.2, "oneEvent": False,
                                "picks": ["moss", "sa3"], "minAbove60Hz": 0.4})
    assert s == {"maxS": 1.2, "oneEvent": False, "lufs": -34.0, "picks": ["moss", "sa3"], "minAbove60Hz": 0.4}
    try:
        screen.family_settings({"id": "hull_light", "lufs": -34})
        raise AssertionError("a new family needs maxS")
    except ValueError:
        pass
    # every family of prompts5.json has all the settings it needs
    for f in json.loads((SOUND / "prompts5.json").read_text(encoding="utf-8"))["families"]:
        assert screen.family_settings(f)["picks"], f["id"]


def test_cut_and_faults_take_the_family_length_and_the_one_event_rule():
    x = place(6.0, [(0.5, noise(5.0))])
    c = screen.cut_event(x, SR, "hull_heavy", 1.2, False)
    near((c["end"] - c["onset"]) / SR, 1.2, 0.001, "maxS")
    assert screen.cut_event(x, SR, "hull") == screen.cut_event(x, SR, "hull", 2.5, False)
    two = place(3.0, [(0.3, decaying(0.3, 150.0)), (1.5, decaying(0.3, 150.0))])
    r, info = screen.raw_faults(two, SR, "hull_light", 1.2, True)
    assert "several-events" in r, r
    r2, _ = screen.raw_faults(two, SR, "hull_light", 1.2, False)
    assert "several-events" not in r2, r2
    # the settings of round 4 are what the defaults give
    for fam in ("hull", "thruster", "gear", "shield"):
        a, ia = screen.raw_faults(two, SR, fam)
        b, ib = screen.raw_faults(two, SR, fam, screen.MAX_LEN_S[fam], fam in screen.ONE_EVENT)
        assert a == b and ia["cut"] == ib["cut"], fam


def test_picks_order_the_slots_and_a_further_pick_of_a_source_is_the_farthest():
    f = fake_family()
    picks, notes = screen.choose(f, ["moss", "sa3", "moss"])
    assert [p["slot"] for p in picks] == [1, 2, 3] and notes == []
    assert [p["cand"]["source"] for p in picks] == ["moss", "sa3", "moss"]
    assert [p["role"] for p in picks] == ["typical", "typical", "farthest"]
    assert [p["sourceRank"] for p in picks] == [1, 1, 2]
    # the first pick of a source is the one of round 4 (the most typical)
    legacy, _ = screen.choose(fake_family())
    assert picks[0]["cand"]["name"] == legacy[0]["cand"]["name"] and picks[1]["cand"]["name"] == legacy[1]["cand"]["name"]
    # the third is the moss candidate farthest from the two picks already made, found the slow way
    ordered = sorted(f, key=lambda c: (screen.SOURCES.index(c["source"]), c["name"]))
    z = screen.normalise(np.array([c["raw"] for c in ordered]))
    at = {c["name"]: i for i, c in enumerate(ordered)}
    made = [at[picks[0]["cand"]["name"]], at[picks[1]["cand"]["name"]]]
    best = max((min(np.linalg.norm(z[i] - z[m]) for m in made), -i) for i, c in enumerate(ordered)
               if c["source"] == "moss" and i not in made)
    assert at[picks[2]["cand"]["name"]] == -best[1]
    # the same candidates in another order give the same choice
    shuffled = [f[i] for i in RNG.permutation(len(f))]
    again, _ = screen.choose(shuffled, ["moss", "sa3", "moss"])
    assert [p["cand"]["name"] for p in again] == [p["cand"]["name"] for p in picks]
    # three of one source, and a source nobody has
    p3, n3 = screen.choose(fake_family(), ["sa3", "sa3", "sa3", "oga"])
    assert len({p["cand"]["name"] for p in p3}) == 4 and [p["sourceRank"] for p in p3] == [1, 2, 3, 1]
    p4, n4 = screen.choose(fake_family(skip=("sa3",)), ["moss", "sa3"])
    assert [p["slot"] for p in p4] == [1] and any("slot 2 (sa3)" in n for n in n4), n4
    assert screen.choose([], ["moss"]) == ([], ["no candidate in this family"])


def test_picks_skip_what_is_skipped_or_too_low_and_keep_it_in_the_pool():
    f = fake_family()
    base, _ = screen.choose(f, ["moss", "moss"])
    first = base[0]["cand"]["name"]
    f2 = fake_family()
    for c in f2:
        if c["name"] == first:
            c["lowShare"] = True  # below minAbove60Hz: never picked, still in the pool
    p2, _ = screen.choose(f2, ["moss", "moss"])
    names = [p["cand"]["name"] for p in p2]
    assert first not in names and len(names) == 2
    # the pool still counts for the centre: the pick is the nearest to the centre of ALL of moss, not of the rest
    ordered = sorted(f2, key=lambda c: (screen.SOURCES.index(c["source"]), c["name"]))
    z = screen.normalise(np.array([c["raw"] for c in ordered]))
    idx = [i for i, c in enumerate(ordered) if c["source"] == "moss"]
    centre = z[idx].mean(axis=0)
    rest = [i for i in idx if ordered[i]["name"] != first]
    assert ordered[min(rest, key=lambda i: (np.linalg.norm(z[i] - centre), i))]["name"] == names[0]


def test_saturation_measures_on_known_signals():
    t = np.arange(SR) / SR
    sine = 0.5 * np.sin(2 * np.pi * 3000 * t)
    m = screen.saturation_measures(sine[:, None], SR)
    assert abs(m["loud50Db"] - (-9.03)) < 0.05 and m["above2kHzLoud"] > 0.99, m
    low = 0.5 * np.sin(2 * np.pi * 100 * t)
    m = screen.saturation_measures(low, SR)  # one-dimensional input is accepted
    assert abs(m["loud50Db"] - (-9.03)) < 0.05 and m["above2kHzLoud"] < 0.01, m
    # only the loudest 50 ms count for the level; only the loud frames (within 10 dB) count for the share
    x = np.zeros(SR)
    x[:2400] = 0.5 * np.sin(2 * np.pi * 100 * t[:2400])           # 50 ms, loud, low
    x[30000:32400] = 0.05 * np.sin(2 * np.pi * 5000 * t[:2400])   # 50 ms, 20 dB lower, high: not a loud frame
    m = screen.saturation_measures(x[:, None], SR)
    assert m["loud50Db"] < -8.0 and m["above2kHzLoud"] < 0.01, m
    # a quiet high part within 10 dB does count
    x[30000:32400] = 0.25 * np.sin(2 * np.pi * 5000 * t[:2400])
    assert screen.saturation_measures(x[:, None], SR)["above2kHzLoud"] > 0.1
    # two channels: the power is the mean over the channels, a file shorter than one frame still works
    st = np.stack([sine, np.zeros_like(sine)], axis=1)
    assert abs(screen.saturation_measures(st, SR)["loud50Db"] - (-12.04)) < 0.05
    assert screen.saturation_measures(sine[:500, None], SR)["above2kHzLoud"] > 0.9
    assert screen.saturation_measures(np.zeros((3000, 1)), SR) == {"loud50Db": -200.0, "above2kHzLoud": 0.0}


def test_saturated_noise_needs_both_and_the_edges_follow_the_brief():
    rule = {"loud50Db": -9.5, "above2kHz": 0.03}
    f = screen.is_saturated_noise
    assert f({"loud50Db": -8.2, "above2kHzLoud": 0.16}, rule)
    assert not f({"loud50Db": -12.0, "above2kHzLoud": 0.16}, rule)  # noise-like but not pressed
    assert not f({"loud50Db": -4.4, "above2kHzLoud": 0.009}, rule)  # pressed but tonal
    assert f({"loud50Db": -9.0, "above2kHzLoud": 0.03}, rule)       # the share counts at the threshold
    assert not f({"loud50Db": -9.5, "above2kHzLoud": 0.5}, rule)    # the level has to be above the threshold
    s = screen.family_settings({"id": "shield_tight", "lufs": -24, "maxS": 1.5, "notSaturatedNoise": rule})
    assert s["notSaturatedNoise"] == rule
    assert "notSaturatedNoise" not in screen.family_settings({"id": "shield_tight", "lufs": -24, "maxS": 1.5})


def sat_cand(name: str, loud: float, share: float, sat: bool, raw: float) -> dict:
    c = cand("moss", name, raw, 0.4)
    c.update({"loud50Db": loud, "above2kHzLoud": share})
    if sat:
        c["satNoise"] = True
    return c


def test_pressed_noise_stays_in_the_pool_and_fills_slots_last():
    def pool():
        return [sat_cand("a", -5.0, 0.2, True, 100.0), sat_cand("b", -8.0, 0.2, True, 130.0),
                sat_cand("c", -20.0, 0.01, False, 170.0), sat_cand("d", -6.0, 0.3, True, 220.0)]
    picks, notes = screen.choose(pool(), ["moss", "moss", "moss"])
    names = [p["cand"]["name"] for p in picks]
    assert names[0] == "c"
    # slots 2 and 3 are filled from the excluded ones, the lowest loud50Db first (b -8, d -6, a -5)
    assert names[1:] == ["b", "d"], names
    assert [p.get("saturatedFallback") for p in picks] == [None, True, True]
    assert len(notes) == 2 and all("filled from the excluded" in n for n in notes) and "b" in notes[0] and "d" in notes[1]
    # the pool still counts for the centre: with one clean candidate the first slot is still "c"; with two clean ones
    # the centre is that of all candidates, pressed ones included
    two = pool() + [sat_cand("e", -25.0, 0.0, False, 400.0)]
    z = screen.normalise(np.array([c["raw"] for c in sorted(two, key=lambda c: c["name"])]))
    order = sorted(two, key=lambda c: c["name"])
    centre = z.mean(axis=0)
    clean = [i for i, c in enumerate(order) if not c.get("satNoise")]
    want = order[min(clean, key=lambda i: (np.linalg.norm(z[i] - centre), i))]["name"]
    picks, notes = screen.choose(two, ["moss", "moss"])
    assert picks[0]["cand"]["name"] == want
    # enough clean candidates: no pressed one is picked and nothing is noted
    many = pool() + [sat_cand("e", -25.0, 0.0, False, 300.0), sat_cand("f", -22.0, 0.0, False, 400.0)]
    picks, notes = screen.choose(many, ["moss", "moss", "moss"])
    assert not any(p["cand"].get("satNoise") for p in picks) and notes == []
    # a hand skip is never brought back by the fallback
    sk = pool()
    sk[1]["skip"] = "plain fault"
    picks, notes = screen.choose(sk, ["moss", "moss", "moss"])
    assert [p["cand"]["name"] for p in picks] == ["c", "d", "a"] and not any("filled from the excluded b " in n for n in notes)
    # a family without the flag behaves as before
    plain = [cand("moss", "m%d" % i, 100.0 * (i + 1), 0.4) for i in range(4)]
    a, _ = screen.choose(plain, ["moss", "moss"])
    assert all("saturatedFallback" not in p for p in a)


SPEC6 = {"category": {"id": "events6", "de": "d", "en": "e", "idPrefix": "ev6"}, "seeds": [11, 12, 13, 14],
         "families": [
             {"id": "pressed", "de": "p", "en": "p", "proven": False, "seconds": 2, "maxS": 1.5, "oneEvent": False, "lufs": -24.0,
              "picks": ["moss", "moss"], "notSaturatedNoise": {"loud50Db": -16.0, "above2kHz": 0.03},
              "prompts": [{"id": "pressed_1", "text": "A bright crack"}]},
             {"id": "free", "de": "f", "en": "f", "proven": False, "seconds": 2, "maxS": 1.5, "oneEvent": False, "lufs": -24.0,
              "picks": ["moss", "moss"], "prompts": [{"id": "free_1", "text": "A thump"}]}]}


def build_round6(root: Path, noisy_count: int) -> None:
    (root / "moss" / "raw").mkdir(parents=True)
    items = {}
    for fam in ("pressed", "free"):
        for k, seed in enumerate(SPEC6["seeds"]):
            n = "%s_1__s%d" % (fam, seed)
            t = np.arange(int(0.8 * SR)) / SR
            if k < noisy_count:  # loud and noise-like
                x = (0.30 - 0.02 * k) * RNG.standard_normal(t.size) * np.exp(-6 * t)
            else:                # loud and low
                x = (0.40 - 0.02 * k) * np.sin(2 * np.pi * (90 + 30 * k) * t) * np.exp(-6 * t)
            sf.write(str(root / "moss" / "raw" / (n + ".wav")), np.clip(x, -0.9, 0.9).astype(np.float32), SR, subtype="FLOAT")
            items[n] = {"file": "raw/%s.wav" % n, "family": fam, "prompt": fam + "_1", "seed": seed, "text_given": "x"}
    (root / "moss" / "gen.json").write_text(json.dumps({"source": "moss", "items": items}), encoding="utf-8")


def test_round_6_run_records_the_measures_and_excludes_pressed_noise():
    for noisy, expect_fallback in ((2, False), (4, True)):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            root = td / "r6"
            build_round6(root, noisy)
            pf = td / "prompts6.json"
            pf.write_text(json.dumps(SPEC6), encoding="utf-8")
            assert screen.main(["--no-models", "--root", str(root), "--prompts-file", str(pf), "--skips", str(td / "none.json")]) == 0
            res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
            rows = {r["name"]: r for r in res["files"] if r["status"] == "kept"}
            assert len(rows) == 8, [r for r in res["files"] if r["status"] != "kept"]
            for n, r in rows.items():
                if n.startswith("free"):
                    assert "loud50Db" not in r and "above2kHzLoud" not in r and "notPickedSaturatedNoise" not in r
                else:
                    assert isinstance(r["loud50Db"], float) and isinstance(r["above2kHzLoud"], float)
            flagged = sorted(n for n, r in rows.items() if r.get("notPickedSaturatedNoise"))
            assert flagged == sorted("pressed_1__s%d" % s for s in SPEC6["seeds"][:noisy]), flagged
            assert all(rows[n]["loud50Db"] > -16.0 and rows[n]["above2kHzLoud"] >= 0.03 for n in flagged)
            chosen = [c for c in res["chosen"] if c["family"] == "pressed"]
            assert len(chosen) == 2 and all("loud50Db" in c and "above2kHzLoud" in c for c in chosen)
            assert not any(c["family"] == "free" and ("loud50Db" in c or "pressedNoiseFallback" in c) for c in res["chosen"])
            notes = res["families"]["pressed"]["notes"]
            if expect_fallback:  # all four are pressed noise: both slots come from them, lowest loud50Db first
                assert all(c.get("pressedNoiseFallback") for c in chosen) and len(notes) == 2
                lows = sorted(rows[n]["loud50Db"] for n in flagged)[:2]
                assert sorted(c["loud50Db"] for c in chosen) == lows
            else:
                assert not any(c["name"] in flagged for c in chosen) and notes == []
                assert not any(c.get("pressedNoiseFallback") for c in chosen)
            assert res["families"]["free"]["notes"] == []


def test_ids_of_round_5_and_carried_tags():
    assert screen.candidate_tag("moss", "thruster_1__s12", {"fromRound4": True}) == "r4p1s12"
    assert screen.candidate_tag("moss", "thruster_valve_1__s21", {}) == "p1s21"
    assert screen.candidate_tag("moss", "shield_1__s11", {"fromRound4": True}) != screen.candidate_tag("moss", "shield_bright_1__s11", {})
    for sid in ("ev5_3_thruster_valve_1_moss_r4p1s12", "ev5_5_shield_bright_3_sa3_p2s16"):
        assert screen.ID_PATTERN.match(sid), sid


def fake_round4(root: Path) -> None:
    """A round-4 folder: raw files, gen.json per source, and a screen.json that says what was kept, skipped and published."""
    items = {"moss": {}, "sa3": {}}
    files, chosen = [], []
    for source in ("moss", "sa3"):
        (root / source / "raw").mkdir(parents=True)
        for prompt, fam in (("thruster_1", "thruster"), ("thruster_2", "thruster"), ("shield_1", "shield"), ("shield_3", "shield")):
            for seed in (11, 12, 13):
                name = "%s__s%d" % (prompt, seed)
                sf.write(str(root / source / "raw" / (name + ".wav")), decaying(1.0, 90.0).astype(np.float32), SR, subtype="FLOAT")
                items[source][name] = {"file": str(root / source / "raw" / (name + ".wav")), "sr": SR, "channels": 1, "family": fam,
                                       "prompt": prompt, "seed": seed, "text_given": "t " + prompt}
                row = {"source": source, "name": name, "family": fam, "status": "kept", "reason": None, "reasons": [],
                       "file": items[source][name]["file"]}
                if seed == 13:
                    row.update({"status": "thrown-out", "reason": "cut-off", "reasons": ["cut-off"]})
                if (source, prompt, seed) == ("moss", "shield_1", 12):
                    row["skippedAsPick"] = "plain fault"
                files.append(row)
        (root / source / "gen.json").write_text(json.dumps({"source": source, "items": items[source]}), encoding="utf-8")
    chosen.append({"id": "src_x", "source": "moss", "name": "thruster_1__s12"})  # heard in round 4
    (root / "screen.json").write_text(json.dumps({"version": 1, "chosen": chosen, "files": files}), encoding="utf-8")


SPEC5 = {"category": {"id": "events5", "de": "d", "en": "e", "idPrefix": "ev5"}, "seeds": [11, 12, 13],
         "families": [
             {"id": "valve", "de": "Ventil", "en": "Valve", "proven": True, "seconds": 2, "maxS": 1.2, "oneEvent": True, "lufs": -34.0,
              "picks": ["moss", "sa3", "moss"], "seeds": [21, 22],
              "fromRound4": {"prompt": "thruster_1", "exclude": ["sa3/thruster_1__s11"]},
              "prompts": [{"id": "valve_1", "text": "Short burst of compressed gas from a valve"}]},
             {"id": "shield_zap", "de": "Funke", "en": "Zap", "proven": False, "seconds": 3, "maxS": 2.5, "oneEvent": True, "lufs": -24.0,
              "minAbove60Hz": 0.4, "picks": ["moss", "moss"],
              "fromRound4": {"prompt": ["shield_1", "shield_3"], "sources": ["moss"]},
              "prompts": [{"id": "shield_zap_1", "text": "Sharp electric zap and crackle"}]},
             {"id": "plain", "de": "Schlicht", "en": "Plain", "proven": False, "seconds": 2, "maxS": 1.2, "oneEvent": True, "lufs": -34.0,
              "picks": ["moss"], "prompts": [{"id": "plain_1", "text": "A plain click"}]}]}


def test_from_round4_brings_the_kept_unheard_candidates_and_is_safe_to_run_twice():
    r4 = load("from_round4")
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        round4, out = td / "gen", td / "r5"
        fake_round4(round4)
        pf = td / "prompts5.json"
        pf.write_text(json.dumps(SPEC5), encoding="utf-8")
        before = {p: p.read_bytes() for p in round4.rglob("*") if p.is_file()}
        assert r4.main(["--prompts-file", str(pf), "--round4", str(round4), "--out-root", str(out), "--dry-run"]) == 0
        assert not out.exists()
        assert r4.main(["--prompts-file", str(pf), "--round4", str(round4), "--out-root", str(out)]) == 0
        moss = json.loads((out / "moss" / "gen.json").read_text(encoding="utf-8"))["items"]
        sa3 = json.loads((out / "sa3" / "gen.json").read_text(encoding="utf-8"))["items"]
        # valve: kept thruster_1 of both sources (s11, s12; s13 was thrown out), without the published moss s12 and the excluded sa3 s11
        assert sorted(moss) == ["shield_1__s11", "shield_1__s12", "shield_3__s11", "shield_3__s12", "thruster_1__s11"], sorted(moss)
        assert sorted(sa3) == ["thruster_1__s12"], sorted(sa3)  # zap is restricted to moss
        assert moss["thruster_1__s11"]["family"] == "valve" and moss["shield_3__s12"]["family"] == "shield_zap"
        assert all(it["fromRound4"] is True for it in list(moss.values()) + list(sa3.values()))
        assert moss["shield_1__s12"]["round4Skip"] == "plain fault" and "round4Skip" not in moss["shield_1__s11"]
        assert moss["thruster_1__s11"]["file"] == str(round4 / "moss" / "raw" / "thruster_1__s11.wav")  # points at the raw file
        assert not list(out.rglob("*.wav"))  # nothing was copied
        assert {p: p.read_bytes() for p in round4.rglob("*") if p.is_file()} == before  # round 4 is untouched
        first = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}
        assert r4.main(["--prompts-file", str(pf), "--round4", str(round4), "--out-root", str(out)]) == 0
        assert {p: p.read_bytes() for p in out.rglob("*") if p.is_file()} == first  # twice: the same
        # an adapter's own items and facts stay, and a changed prompts file takes back what no longer matches
        g = json.loads((out / "moss" / "gen.json").read_text(encoding="utf-8"))
        g["items"]["valve_1__s21"] = {"family": "valve", "prompt": "valve_1", "seed": 21}
        g["model"] = "m"
        (out / "moss" / "gen.json").write_text(json.dumps(g), encoding="utf-8")
        spec = json.loads(json.dumps(SPEC5))
        spec["families"][1]["fromRound4"]["exclude"] = ["moss/shield_1__s11", "moss/shield_3__s11"]
        pf.write_text(json.dumps(spec), encoding="utf-8")
        assert r4.main(["--prompts-file", str(pf), "--round4", str(round4), "--out-root", str(out)]) == 0
        g = json.loads((out / "moss" / "gen.json").read_text(encoding="utf-8"))
        assert sorted(g["items"]) == ["shield_1__s12", "shield_3__s12", "thruster_1__s11", "valve_1__s21"] and g["model"] == "m"
        # a name that is taken by a file that is not from round 4 is an error, never overwritten
        g["items"]["thruster_1__s11"] = {"family": "valve"}
        (out / "moss" / "gen.json").write_text(json.dumps(g), encoding="utf-8")
        try:
            r4.main(["--prompts-file", str(pf), "--round4", str(round4), "--out-root", str(out)])
            raise AssertionError("an item of round 5 was overwritten")
        except ValueError:
            pass
        assert r4.main(["--prompts-file", str(pf), "--round4", str(round4), "--out-root", str(round4)]) == 2


def build_round5(root: Path) -> None:
    """A fake round-5 root: raw files in each source, items of the mini prompts file, and carried files from a fake round 4."""
    round4 = root.parent / "gen4"
    fake_round4(round4)
    for source, sr in (("moss", 48000), ("sa3", 44100)):
        (root / source / "raw").mkdir(parents=True)
        items = {}
        for fi, fam in enumerate(SPEC5["families"]):
            for pr in fam["prompts"]:
                for k, seed in enumerate(fam.get("seeds") or SPEC5["seeds"]):
                    n = "%s__s%d" % (pr["id"], seed)
                    t = np.arange(int((0.8 + 0.2 * k) * sr)) / sr
                    f0 = (150 + 90 * k + 40 * fi) * (1 + (source == "sa3"))
                    if fam["id"] == "shield_zap" and source == "moss" and k == 0:
                        f0 = 35.0  # almost nothing above 60 Hz
                    x = 0.5 * np.sin(2 * np.pi * f0 * t) * np.exp(-9 * t) + 0.1 * RNG.standard_normal(t.size) * np.exp(-12 * t)
                    sf.write(str(root / source / "raw" / (n + ".wav")), x.astype(np.float32), sr, subtype="FLOAT")
                    items[n] = {"file": "raw/%s.wav" % n, "family": fam["id"], "prompt": pr["id"], "seed": seed,
                                "text_given": pr["text"] + " duration: 2s"}
        (root / source / "gen.json").write_text(json.dumps({"source": source, "items": items}), encoding="utf-8")
    load("from_round4").main(["--prompts-file", str(root.parent / "prompts5.json"), "--round4", str(round4), "--out-root", str(root)])


def test_round_5_run_and_publish_on_a_fake_tree():
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        root, out = td / "r5", td / "render"
        (td / "prompts5.json").write_text(json.dumps(SPEC5), encoding="utf-8")
        build_round5(root)
        # a sound of round 4 in its own category must survive the pruning of round 5
        keep = out / "source"
        keep.mkdir(parents=True)
        (keep / "src_1_hull_1_moss_p1s11.txt").write_text("round 4", encoding="utf-8")
        pf = str(td / "prompts5.json")
        no_skips = str(td / "none.json")
        assert screen.main(["--no-models", "--root", str(root), "--prompts-file", pf, "--skips", no_skips]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        assert res["category"]["id"] == "events5" and res["skippedAsPick"] == {}
        ids = [c["id"] for c in res["chosen"]]
        assert len(ids) == len(set(ids)) and all(screen.ID_PATTERN.match(i) for i in ids)
        valve = [c for c in res["chosen"] if c["family"] == "valve"]
        assert valve[0]["id"].startswith("ev5_1_valve_1_moss_")
        assert [c["slot"] for c in valve] == [1, 2, 3] and [c["source"] for c in valve] == ["moss", "sa3", "moss"]
        assert [c.get("sourceRank") for c in valve] == [1, 1, 2]
        assert sorted(p.name for p in (root / "_listen").glob("*.wav")) == sorted(i + ".wav" for i in ids)
        assert not (root.parent / "gen4" / "_listen").exists()  # round 4's folders get nothing
        # the carried files are in the pool; the skip of round 4 is carried; the low-share ones are not picked
        rows = {(f["source"], f["name"]): f for f in res["files"]}
        assert rows[("moss", "shield_1__s12")]["skippedAsPick"] == "plain fault"
        assert rows[("moss", "thruster_1__s11")]["family"] == "valve" and rows[("moss", "thruster_1__s11")]["status"] == "kept"
        low = [r for r in res["files"] if r.get("notPickedLowShare")]
        assert low and all(r["family"] == "shield_zap" and r["energyAbove60Hz"] < 0.4 for r in low), low
        assert not any((c["source"], c["name"]) in {(r["source"], r["name"]) for r in low} for c in res["chosen"])
        zap = [c for c in res["chosen"] if c["family"] == "shield_zap"]
        assert all(c["energyAbove60Hz"] >= 0.4 and c["name"] != "shield_1__s12" for c in zap), zap
        assert not any(c["family"] == "plain" and c["slot"] > 1 for c in res["chosen"])
        # the settings of the family are used: lufs, and the cut stops at maxS
        for c in res["chosen"]:
            fam = next(f for f in SPEC5["families"] if f["id"] == c["family"])
            assert c["listen"]["lufsTarget"] == fam["lufs"] and c["cut"]["endS"] - c["cut"]["startS"] <= fam["maxS"] + 0.01
        import build as b  # noqa: E402

        b.SELECTION = td / "no-selection.json"
        b.GENERATED_LIST = td / "no-generated.json"
        pub = load("publish")
        assert pub.main(["--root", str(root), "--out", str(out)]) == 1  # the default prompts file is not the one of this screen.json
        assert pub.main(["--prompts-file", pf, "--root", str(root), "--out", str(out)]) == 0
        assert sorted(p.stem for p in (out / "events5").glob("*.wav")) == sorted(ids)
        assert (keep / "src_1_hull_1_moss_p1s11.txt").is_file()
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        sounds = {s["id"]: s for s in manifest["sounds"] if s["category"] == "events5"}
        assert set(sounds) == set(ids)
        v = [sounds[c["id"]] for c in valve]
        assert v[0]["de"] == "Ventil · MOSS-SoundEffect" and v[1]["de"] == "Ventil · Stable Audio 3 (nur Test)"
        assert v[2]["de"] == "Ventil · MOSS-SoundEffect, zweite Auswahl" and v[2]["en"] == "Valve · MOSS-SoundEffect, second pick"
        assert all("rests on a prompt the owner accepted in round 4" in s["intent"] for s in v)
        # the round is the family's 'provenRound' where it is given (round 6: the wrench prompt he accepted in round 5)
        c0 = valve[0]
        fam5 = dict(next(f for f in SPEC5["families"] if f["id"] == "valve"), provenRound=5)
        assert "rests on a prompt the owner accepted in round 5." in pub.describe_source(c0, fam5)[0]
        assert "accepted in round 4" not in pub.describe_source(c0, fam5)[0]
        assert all("first try" in sounds[c["id"]]["intent"] for c in zap)
        assert "seed" in v[0]["intent"] and "Short burst of compressed gas" in v[0]["intent"]
        carried = [sounds[c["id"]] for c in res["chosen"] if c["tag"].startswith("r4")]
        assert carried and all("made in round 4" in s["intent"] and "not heard then" in s["intent"] for s in carried)
        assert not any("made in round 4" in s["intent"] for s in sounds.values() if not s["id"].count("_r4"))
        assert all("test material" in s["licence"] for s in sounds.values() if s["candidate"]["source"] == "sa3")
        assert all(s["path"] == ("energy" if s["id"].startswith("ev5_2_shield_zap") else "structure") for s in sounds.values())
        # a third pick of a source is numbered
        assert pub.pick_suffix(2) == (", zweite Auswahl", ", second pick") and pub.pick_suffix(3) == (", dritte Auswahl", ", third pick")
        assert pub.pick_suffix(1) == ("", "")
        # removing takes only the new category away
        assert pub.main(["--prompts-file", pf, "--root", str(root), "--out", str(out), "--remove"]) == 0
        assert not (out / "events5").exists() and (keep / "src_1_hull_1_moss_p1s11.txt").is_file()


def test_round_4_files_have_none_of_the_new_keys():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "gen"
        build_tree(root)
        assert screen.main(["--no-models", "--root", str(root), "--skips", str(Path(td) / "none.json")]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        assert "category" not in res and "promptsFile" not in res
        assert all("sourceRank" not in c for c in res["chosen"])
        assert all("notPickedLowShare" not in f for f in res["files"])
        assert all(c["id"].startswith("src_") for c in res["chosen"])


def test_the_new_category_comes_first_in_sounds_json():
    spec = json.loads((SOUND.parent / "audio" / "sounds.json").read_text(encoding="utf-8"))
    cats = [c["id"] for c in spec["categories"]]
    if cats[0] == "events7":  # the select step of round 7 puts its category in front of the others
        cats = cats[1:]
    assert cats[:3] == ["events6", "events5", "source"], cats[:3]
    c0 = next(c for c in spec["categories"] if c["id"] == "events6")
    assert c0["de"] == "Ereignisklänge (Runde 6)" and c0["en"] == "Event sounds (round 6)"
    assert next(c for c in spec["categories"] if c["id"] == "events5")["de"] == "Ereignisklänge (Runde 5)"
    assert json.loads((SOUND / "prompts6.json").read_text(encoding="utf-8"))["category"]["id"] == "events6"
    sk6 = json.loads((SOUND / "skips6.json").read_text(encoding="utf-8"))["skips"]
    assert isinstance(sk6, list) and all(s["candidate"].count("/") == 1 and s["reason"].strip() for s in sk6), sk6
    assert json.loads((SOUND / "prompts5.json").read_text(encoding="utf-8"))["category"]["id"] == "events5"
    # The list grows with every spectrogram review of the round, so only its form is fixed here.
    sk5 = json.loads((SOUND / "skips5.json").read_text(encoding="utf-8"))["skips"]
    assert isinstance(sk5, list) and all(s["candidate"].count("/") == 1 and s["reason"].strip() for s in sk5), sk5


# ---- round 7: derive.py, the shot counter, fixed families, the shots rule -------------------------

def sine(freq: float, seconds: float, amp: float = 0.3, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return amp * np.sin(2 * np.pi * freq * t)


def peak_freq(x: np.ndarray, sr: int = SR) -> float:
    spec = np.abs(np.fft.rfft(np.asarray(x, dtype=np.float64).reshape(-1) * np.hanning(np.asarray(x).reshape(-1).size)))
    return float(np.fft.rfftfreq(np.asarray(x).reshape(-1).size, 1.0 / sr)[int(spec.argmax())])


def db_between(a: np.ndarray, b: np.ndarray) -> float:
    return 10.0 * np.log10(float((np.asarray(a, dtype=np.float64) ** 2).sum()) / float((np.asarray(b, dtype=np.float64) ** 2).sum()))


def test_derive_identities():
    x = sine(440, 0.5)
    n = x.size
    cases = {"empty process": [], "pitch 0": [{"op": "pitch", "semitones": 0.0}], "shelf 0 dB": [{"op": "shelf", "hz": 300.0, "gainDb": 0.0}]}
    for what, proc in cases.items():
        y, _ = derive.apply_process(x, SR, proc)
        assert y.shape == (n, 1) and np.abs(y[:, 0] - x).max() < 1e-6, what
    y, ops = derive.apply_process(x, SR, [{"op": "room", "rt60S": 0.5, "wetDb": -200.0, "channels": 1, "seed": 3}])
    assert np.abs(y[:n, 0] - x).max() < 1e-6 and np.abs(y[n:]).max() < 1e-6 and y.shape[0] == n + int(round(1.5 * 0.5 * SR)) - 1
    assert ops[0]["outputGainDb"] == 0.0
    y2, _ = derive.apply_process(x, SR, [{"op": "room", "rt60S": 0.5, "wetDb": -200.0, "channels": 2, "seed": 3}])
    assert y2.shape[1] == 2 and np.abs(y2[:n, 0] - x).max() < 1e-6 and np.abs(y2[:n, 1] - x).max() < 1e-6


def test_derive_room_has_the_asked_wet_level_and_a_tail_that_decays_as_asked():
    rng = np.random.default_rng(5)
    t = np.arange(int(0.3 * SR)) / SR
    x = 0.15 * rng.standard_normal(t.size) * np.exp(-12 * t)
    for nch in (1, 2):
        y, ops = derive.apply_process(x, SR, [{"op": "room", "rt60S": 0.9, "wetDb": -9.0, "channels": nch, "seed": 7}])
        assert ops[0]["outputGainDb"] == 0.0 and y.shape[1] == nch
        wet = y.copy()
        wet[:x.size, :] -= x[:, None]
        e_wet = float((wet ** 2).sum(axis=0).mean())  # for two channels the mean energy of the two wet channels
        near(10.0 * np.log10(e_wet / float((x ** 2).sum())), -9.0, 0.02, "wet/dry %d ch" % nch)
        near(ops[0]["wetDryDbReached"], -9.0, 0.02, "recorded wet/dry")
        assert y.shape[0] == x.size + int(round(1.5 * 0.9 * SR)) - 1
        near(ops[0]["irLengthS"], 1.35, 1e-3, "ir length")
        if nch == 2:
            assert np.abs(y[:, 0] - y[:, 1]).max() > 1e-3  # two rooms, not a copy
    # the response: early reflections as single samples with alternating sign, a tail in three bands
    ir = derive.room_ir(SR, 0.9, 7, 0)
    for k, (ms, db) in enumerate(zip(derive.EARLY_MS[0], derive.EARLY_DB)):
        i = int(round(ms * SR / 1000))
        if ms < 30.0:  # before the tail starts the sample is the reflection alone; later the noise of the tail is added to it
            near(float(ir[i]) / (-1.0) ** k, 10 ** (db / 20), 1e-9, "early reflection %d" % k)
    ir2 = derive.room_ir(SR, 0.9, 7, 1)  # the second channel: other delays, another noise
    assert [int(i) for i in np.flatnonzero(ir2[:int(0.030 * SR)])] == [int(round(ms * SR / 1000)) for ms in derive.EARLY_MS[1][:2]]
    assert float(np.abs(ir[:int(0.018 * SR)]).max()) == 0.0 and ir.size == int(round(1.5 * 0.9 * SR))
    from scipy import signal

    def level(sos, t0):  # the level of one band of the response in a 50 ms window, dB
        b = signal.sosfilt(sos, ir)
        i = int(t0 * SR)
        return 10 * np.log10(float((b[i:i + int(0.05 * SR)] ** 2).mean()))

    # measured well inside each band (the filters of the bands overlap at their edges)
    bands = {"low": (signal.butter(4, 150, "lowpass", fs=SR, output="sos"), 0.9 * 1.2),
             "mid": (signal.butter(4, [700, 1400], "bandpass", fs=SR, output="sos"), 0.9),
             "high": (signal.butter(4, 6000, "highpass", fs=SR, output="sos"), 0.9 * 0.5)}
    for name, (sos, rt) in bands.items():
        fall = level(sos, 0.10) - level(sos, 0.30)
        near(fall, 60.0 * 0.20 / rt, 3.0, "decay of the %s band between 0.10 s and 0.30 s" % name)
    # the same seed gives the same response, another seed another one
    assert np.array_equal(ir, derive.room_ir(SR, 0.9, 7, 0)) and not np.array_equal(ir, derive.room_ir(SR, 0.9, 8, 0))
    # a loud result is scaled down to 0.999 and says by how much
    loud = sine(300, 0.3, 1.0)
    y, ops = derive.apply_process(loud, SR, [{"op": "room", "rt60S": 0.4, "wetDb": -3.0, "channels": 1, "seed": 1}])
    near(float(np.abs(y).max()), 0.999, 1e-9, "scaled peak")
    assert ops[0]["outputGainDb"] < 0


def test_derive_pitch_moves_a_sine_by_the_asked_interval_and_shortens_the_file():
    x = sine(1000, 1.0)
    for semi in (12.0, 3.0, -5.0):
        y, ops = derive.apply_process(x, SR, [{"op": "pitch", "semitones": semi}])
        f = 2.0 ** (semi / 12.0)
        near(peak_freq(y[:, 0]), 1000 * f, 2.0, "pitch %g" % semi)
        near(y.shape[0] / x.size, 1.0 / f, 0.002, "length at %g" % semi)
    y, _ = derive.apply_process(x, SR, [{"op": "pitch", "semitones": 12.0}])
    assert y.shape[0] == x.size // 2


def test_derive_shelf_lifts_a_high_sine_by_the_asked_gain_and_leaves_a_low_one():
    for hz, expect in ((100.0, 0.0), (8000.0, 8.0)):
        x = sine(hz, 1.0, 0.1)
        y, ops = derive.apply_process(x, SR, [{"op": "shelf", "hz": 2000.0, "gainDb": 8.0}])
        a, b = x[SR // 2:], y[SR // 2:, 0]  # past the start-up
        near(10 * np.log10(float((b ** 2).sum() / (a ** 2).sum())), expect, 0.3, "gain at %g Hz" % hz)
        assert ops[0]["outputGainDb"] == 0.0
    y, ops = derive.apply_process(sine(8000, 0.5, 0.9), SR, [{"op": "shelf", "hz": 2000.0, "gainDb": 8.0}])
    near(float(np.abs(y).max()), 0.999, 1e-9, "scaled peak")
    assert ops[0]["outputGainDb"] < 0


def burst(ms: float = 150.0, amp: float = 0.15) -> np.ndarray:
    n = int(ms / 1000 * SR)
    return amp * RNG.standard_normal(n) * np.exp(-np.arange(n) / SR * 25.0)


def test_the_shots_counter_gives_1_2_and_3_also_with_a_room_between_the_shots():
    for k in (1, 2, 3):
        x = place(0.2 + 1.0 * k + 0.5, [(0.1 + 1.0 * i, burst()) for i in range(k)])
        assert screen.count_shots(x, SR) == k, k
        y, _ = derive.apply_process(x[:, 0], SR, [{"op": "room", "rt60S": 0.9, "wetDb": -9.0, "channels": 1, "seed": 7}])
        assert screen.count_shots(y, SR) == k, ("room", k)
        y2, _ = derive.apply_process(x[:, 0], SR, [{"op": "room", "rt60S": 1.2, "wetDb": -6.0, "channels": 2, "seed": 7}])
        assert screen.count_shots(y2, SR) == k, ("two-channel room", k)
    # the rule: two bursts 50 ms apart (the level has not stayed under -20 dB for 80 ms) are one shot, 200 ms apart two
    assert screen.count_shots(place(1.0, [(0.1, burst(100)), (0.25, burst(100))]), SR) == 1
    assert screen.count_shots(place(1.0, [(0.1, burst(100)), (0.50, burst(100))]), SR) == 2
    # a level between -20 and -12 dB is not quiet: a bed at about -16 dB holds the counter, a burst on it is no new shot
    x = place(1.2, [(0.1, burst(100)), (0.2, 0.024 * RNG.standard_normal(int(0.6 * SR))), (0.6, burst(100, 0.09))])
    assert screen.count_shots(x, SR) == 1
    assert screen.count_shots(np.zeros((SR, 1)), SR) == 0


SPEC7 = {"category": {"id": "events5", "de": "d", "en": "e", "idPrefix": "ev7"}, "sources": ["moss", "derived"], "seeds": [21, 22, 23, 24],
         "families": [
             {"id": "thruster_fix", "de": "Duese fix", "en": "Thruster fixed", "what": "w", "history": "Made from a candidate that the owner called close.",
              "fixed": True, "maxS": 3.6, "oneEvent": False, "lufs": -28.0, "picks": [], "prompts": [], "derived": [
                  {"id": "thruster_fix_1", "tag": "r6p3s11a", "de": "Raum leicht", "en": "light room",
                   "from": {"round": 6, "candidate": "ev6_2_thruster_mighty_2_moss_p3s11", "verdict": "close", "raw": "RAW", "sha256": "SHA"},
                   "process": [{"op": "room", "rt60S": 0.5, "wetDb": -9.0, "channels": 1, "seed": 7}]},
                  {"id": "thruster_fix_2", "tag": "r6p3s11b", "de": "Raum breit", "en": "wide room",
                   "from": {"round": 6, "candidate": "ev6_2_thruster_mighty_2_moss_p3s11", "verdict": "close", "raw": "RAW", "sha256": "SHA"},
                   "process": [{"op": "room", "rt60S": 0.7, "wetDb": -6.0, "channels": 2, "seed": 7}]},
                  {"id": "thruster_fix_3", "tag": "r6p3s11c", "de": "hoeher", "en": "higher",
                   "from": {"round": 6, "candidate": "ev6_2_thruster_mighty_2_moss_p3s11", "verdict": "close", "raw": "RAW", "sha256": "SHA"},
                   "process": [{"op": "pitch", "semitones": 3.0}]}]},
             {"id": "thruster_gen", "de": "Duese drei", "en": "Thruster three", "what": "w", "history": "The owner heard this prompt in round 6.",
              "proven": False, "seconds": 4, "maxS": 3.8, "oneEvent": False, "shots": 2, "lufs": -28.0, "picks": ["moss", "moss"],
              "prompts": [{"id": "thruster_gen_1", "text": "A cannon fires two shots"}]},
             {"id": "shield_fix", "de": "Schild fix", "en": "Shield fixed", "what": "w", "history": "Made from a candidate that the owner called close.",
              "fixed": True, "maxS": 1.5, "oneEvent": True, "lufs": -24.0, "picks": [], "prompts": [], "derived": [
                  {"id": "shield_fix_1", "tag": "r6p2s11b", "de": "mehr Hoehen", "en": "more highs",
                   "from": {"round": 6, "candidate": "ev6_3_shield_tight_2_moss_p2s11", "verdict": "close", "raw": "RAW2", "sha256": "SHA2"},
                   "process": [{"op": "shelf", "hz": 300.0, "gainDb": 8.0}]}]},
             {"id": "hull_gen", "de": "Rumpf", "en": "Hull", "what": "w", "proven": True, "seconds": 2, "maxS": 1.5, "oneEvent": True, "lufs": -30.0,
              "picks": ["moss"], "prompts": [{"id": "hull_gen_1", "text": "A knock"}]}]}


def build_round7(td: Path, shots_by_seed: dict, fixed_raw: dict | None = None) -> tuple[Path, Path, Path]:
    """A fake round-7 tree: the raw files of the derived items (two shots 1 s apart, one burst for the shield), a prompts file
    with their real sha256, the derived files made by derive.py, and moss files with the given number of shots."""
    import hashlib

    rawd = td / "raw6"
    rawd.mkdir()
    sets = {}
    thr = place(2.2, [(0.1, burst(200)), (1.1, burst(200))])[:, 0]
    sh = place(0.8, [(0.05, burst(120, 0.15))])[:, 0]
    for key, data in (("RAW", thr), ("RAW2", sh)):
        p = rawd / (key + ".wav")
        sf.write(str(p), (fixed_raw or {}).get(key, data).astype(np.float32), SR, subtype="FLOAT")
        sets[key] = (str(p), hashlib.sha256(p.read_bytes()).hexdigest())
    spec = json.loads(json.dumps(SPEC7))
    for f in spec["families"]:
        for it in f.get("derived", []):
            it["from"]["raw"], it["from"]["sha256"] = sets[it["from"]["raw"]]
    pf = td / "prompts7.json"
    pf.write_text(json.dumps(spec), encoding="utf-8")
    root = td / "r7"
    assert derive.main(["--prompts-file", str(pf), "--out-root", str(root)]) == 0
    (root / "moss" / "raw").mkdir(parents=True)
    items = {}
    for fam, pr in (("thruster_gen", "thruster_gen_1"), ("hull_gen", "hull_gen_1")):
        for k, seed in enumerate(spec["seeds"]):
            n = "%s__s%d" % (pr, seed)
            if fam == "thruster_gen":
                shots = shots_by_seed[seed]
                x = place(0.4 + 1.0 * shots, [(0.1 + 1.0 * i, burst(200 + 20 * k)) for i in range(shots)])[:, 0]
            else:
                x = place(1.0, [(0.05, burst(150 + 30 * k))])[:, 0]
            sf.write(str(root / "moss" / "raw" / (n + ".wav")), x.astype(np.float32), SR, subtype="FLOAT")
            items[n] = {"file": "raw/%s.wav" % n, "family": fam, "prompt": pr, "seed": seed, "text_given": "x"}
    (root / "moss" / "gen.json").write_text(json.dumps({"source": "moss", "items": items}), encoding="utf-8")
    return td, root, pf


def test_a_fixed_family_is_chosen_whole_and_in_order_and_the_shots_rule_picks_the_right_count():
    with tempfile.TemporaryDirectory() as td:
        td, root, pf = build_round7(Path(td), {21: 1, 22: 2, 23: 2, 24: 3})
        # derive.py: the files are in the form of a MOSS gen.json and say what was done
        rec = json.loads((root / "derived" / "gen.json").read_text(encoding="utf-8"))
        assert rec["source"] == "derived" and list(rec["items"]) == ["thruster_fix_1", "thruster_fix_2", "thruster_fix_3", "shield_fix_1"]
        it = rec["items"]["thruster_fix_2"]
        assert it["channels"] == 2 and it["seed"] is None and it["prompt"] == "thruster_fix_2" and it["family"] == "thruster_fix"
        assert {"file", "sr", "channels", "audio_s", "peak", "family", "prompt", "seed", "text_given", "derived"} <= set(it)
        assert it["derived"]["tag"] == "r6p3s11b" and it["derived"]["process"][0]["op"] == "room" and "two channels" in it["text_given"]
        for k in ("peak", "lengthS", "shareUnder250Hz", "shareAbove2kHz", "centroidHz"):
            assert k in it["derived"]["numbers"]["raw"] and k in it["derived"]["numbers"]["result"]
        assert "wetDryDb" in it["derived"]["numbers"] and "irLengthS" in it["derived"]["numbers"]
        assert screen.main(["--no-models", "--root", str(root), "--prompts-file", str(pf), "--skips", str(td / "none.json")]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        fix = [c for c in res["chosen"] if c["family"] == "thruster_fix"]
        assert [c["id"] for c in fix] == ["ev7_1_thruster_fix_%d_derived_%s" % (i, t) for i, t in ((1, "r6p3s11a"), (2, "r6p3s11b"), (3, "r6p3s11c"))]
        assert [c["slot"] for c in fix] == [1, 2, 3] and all(c["role"] == "fixed" and c["fixed"] and c["faults"] == [] for c in fix)
        assert [c["listen"]["channels"] for c in fix] == [1, 2, 1] and all(abs(c["listen"]["levelErrorDb"]) <= 0.05 for c in fix)
        assert (root / "_listen" / (fix[1]["id"] + ".wav")).is_file()
        assert [c["id"] for c in res["chosen"] if c["family"] == "shield_fix"] == ["ev7_3_shield_fix_1_derived_r6p2s11b"]
        # the measures of round 7 on every chosen candidate; the shot count where the family id starts with "thruster"
        assert all(isinstance(c["loud50Db"], float) and isinstance(c["above2kHzLoud"], float) for c in res["chosen"])
        assert all(c.get("shots") == 2 for c in fix if c["family"] == "thruster_fix") and all(c.get("shots") == 2 for c in fix)
        assert not any("shots" in c for c in res["chosen"] if not c["family"].startswith("thruster"))
        # the shots rule: only the two candidates with exactly two shots, the others stay in the pool and say so
        gen = [c for c in res["chosen"] if c["family"] == "thruster_gen"]
        assert sorted(c["name"] for c in gen) == ["thruster_gen_1__s22", "thruster_gen_1__s23"] and all(c["shots"] == 2 for c in gen)
        rows = {r["name"]: r for r in res["files"]}
        assert {n: r["shots"] for n, r in rows.items() if n.startswith("thruster_gen")} == {
            "thruster_gen_1__s21": 1, "thruster_gen_1__s22": 2, "thruster_gen_1__s23": 2, "thruster_gen_1__s24": 3}
        assert "notPickedShots" in rows["thruster_gen_1__s21"] and "notPickedShots" in rows["thruster_gen_1__s24"]
        assert "notPickedShots" not in rows["thruster_gen_1__s22"] and rows["thruster_gen_1__s21"]["status"] == "kept"
        assert res["families"]["thruster_gen"]["notes"] == []
        # a fixed family does not enter the statistics of another: its files are not in the pool of the generated family
        assert res["families"]["thruster_gen"]["candidates"]["moss"] == 4 and res["families"]["thruster_gen"]["candidates"]["derived"] == 0
        assert res["families"]["thruster_fix"]["candidates"]["derived"] == 3 and res["families"]["thruster_fix"]["candidates"]["moss"] == 0
        assert "shots" not in rows["hull_gen_1__s21"] and rows["hull_gen_1__s21"]["loud50Db"] is not None
        # fewer candidates with the right count than slots: the slot stays empty and a note says so (nothing else fills it)
        td2 = td / "again"
        td2.mkdir()
        _, root2, pf2 = build_round7(td2, {21: 1, 22: 2, 23: 3, 24: 3})
        assert screen.main(["--no-models", "--root", str(root2), "--prompts-file", str(pf2), "--skips", str(td / "none.json")]) == 0
        res2 = json.loads((root2 / "screen.json").read_text(encoding="utf-8"))
        gen2 = [c["name"] for c in res2["chosen"] if c["family"] == "thruster_gen"]
        assert gen2 == ["thruster_gen_1__s22"], gen2
        notes = res2["families"]["thruster_gen"]["notes"]
        assert any("1 of 2 slots stay empty" in n and "exactly 2 separate shots" in n for n in notes), notes
        # no candidate at all in a generated family is no error (the round starts with only the fixed ones)
        td3 = td / "third"
        td3.mkdir()
        _, root3, pf3 = build_round7(td3, {21: 1, 22: 1, 23: 1, 24: 1})
        assert screen.main(["--no-models", "--root", str(root3), "--prompts-file", str(pf3), "--skips", str(td / "none.json")]) == 0
        assert not [c for c in json.loads((root3 / "screen.json").read_text(encoding="utf-8"))["chosen"] if c["family"] == "thruster_gen"]
        # the derived file is read from a root that holds nothing else
        import shutil
        shutil.rmtree(root3 / "moss")
        assert screen.main(["--no-models", "--root", str(root3), "--prompts-file", str(pf3), "--skips", str(td / "none.json")]) == 0
        assert len(json.loads((root3 / "screen.json").read_text(encoding="utf-8"))["chosen"]) == 4


def test_a_missing_or_stale_fixed_item_stops_screen_with_a_message():
    import contextlib
    import io

    with tempfile.TemporaryDirectory() as td:
        td, root, pf = build_round7(Path(td), {21: 2, 22: 2, 23: 2, 24: 2})
        gj = root / "derived" / "gen.json"
        full = json.loads(gj.read_text(encoding="utf-8"))
        no_skips = str(td / "none.json")

        def run_with(rec: dict) -> tuple[int, str]:
            gj.write_text(json.dumps(rec), encoding="utf-8")
            (root / "screen.json").unlink(missing_ok=True)
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = screen.main(["--no-models", "--root", str(root), "--prompts-file", str(pf), "--skips", no_skips])
            return code, err.getvalue()

        gone = json.loads(json.dumps(full))
        del gone["items"]["thruster_fix_2"]
        code, msg = run_with(gone)
        assert code == 1 and "thruster_fix_2" in msg and "missing" in msg and not (root / "screen.json").exists(), (code, msg)
        stale = json.loads(json.dumps(full))
        stale["items"]["thruster_fix_1"]["derived"]["process"][0]["wetDb"] = -3.0  # made from another plan
        code, msg = run_with(stale)
        assert code == 1 and "thruster_fix_1" in msg and "derive.py" in msg, (code, msg)
        silent = json.loads(json.dumps(full))
        sf.write(str(root / "derived" / "raw" / "shield_fix_1.wav"), np.zeros(SR // 2, dtype=np.float32), SR, subtype="FLOAT")
        code, msg = run_with(silent)
        assert code == 1 and "shield_fix_1" in msg and "silent" in msg, (code, msg)
        # the faults of a fixed item are recorded, and the item is chosen all the same (a flat top: clipped)
        raw = np.clip(sine(300, 0.6, 1.5), -0.5, 0.5)
        td2 = td / "two"
        td2.mkdir()
        _, root2, pf2 = build_round7(td2, {21: 2, 22: 2, 23: 2, 24: 2}, {"RAW2": np.concatenate([raw, np.zeros(SR // 2)])})
        # pitch 0 keeps the flat top: replace the shelf by an identity for this item
        spec = json.loads(pf2.read_text(encoding="utf-8"))
        spec["families"][2]["derived"][0]["process"] = [{"op": "pitch", "semitones": 0.0}]
        pf2.write_text(json.dumps(spec), encoding="utf-8")
        assert derive.main(["--prompts-file", str(pf2), "--out-root", str(root2)]) == 0
        assert screen.main(["--no-models", "--root", str(root2), "--prompts-file", str(pf2), "--skips", no_skips]) == 0
        res = json.loads((root2 / "screen.json").read_text(encoding="utf-8"))
        sh = next(c for c in res["chosen"] if c["family"] == "shield_fix")
        assert "clipped" in sh["faults"] and sh["id"].endswith("derived_r6p2s11b")
        row = next(r for r in res["files"] if r["name"] == "shield_fix_1")
        assert row["status"] == "kept" and row["faults"] == sh["faults"] and row["reasons"] == []


def test_derive_refuses_an_item_whose_raw_file_differs_and_a_second_run_gives_the_same_samples():
    import contextlib
    import io

    with tempfile.TemporaryDirectory() as td:
        td, root, pf = build_round7(Path(td), {21: 2, 22: 2, 23: 2, 24: 2})
        first = {p.name: sf.read(str(p), dtype="float32", always_2d=True)[0].tobytes() for p in (root / "derived" / "raw").glob("*.wav")}
        gen1 = (root / "derived" / "gen.json").read_bytes()
        assert derive.main(["--prompts-file", str(pf), "--out-root", str(root)]) == 0
        assert {p.name: sf.read(str(p), dtype="float32", always_2d=True)[0].tobytes() for p in (root / "derived" / "raw").glob("*.wav")} == first
        assert (root / "derived" / "gen.json").read_bytes() == gen1 and b"\r" not in gen1
        spec = json.loads(pf.read_text(encoding="utf-8"))
        spec["families"][0]["derived"][1]["from"]["sha256"] = "0" * 64
        pf.write_text(json.dumps(spec), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = derive.main(["--prompts-file", str(pf), "--out-root", str(root)])
        assert code == 1 and "REFUSED thruster_fix_2" in out.getvalue()
        assert sorted(json.loads((root / "derived" / "gen.json").read_text(encoding="utf-8"))["items"]) == ["shield_fix_1", "thruster_fix_1", "thruster_fix_3"]


def test_publish_writes_the_page_entries_of_derived_candidates_from_the_plan_and_the_run():
    import build as b  # noqa: E402

    with tempfile.TemporaryDirectory() as td:
        td, root, pf = build_round7(Path(td), {21: 1, 22: 2, 23: 2, 24: 3})
        no_skips = str(td / "none.json")
        assert screen.main(["--no-models", "--root", str(root), "--prompts-file", str(pf), "--skips", no_skips]) == 0
        res = json.loads((root / "screen.json").read_text(encoding="utf-8"))
        b.SELECTION = td / "no-selection.json"
        b.GENERATED_LIST = td / "no-generated.json"
        pub = load("publish")
        out = td / "render"
        assert pub.main(["--prompts-file", str(pf), "--root", str(root), "--out", str(out)]) == 0
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        sounds = {s["id"]: s for s in manifest["sounds"] if s["category"] == "events5"}
        assert set(sounds) == {c["id"] for c in res["chosen"]}
        s1, s2, s3 = (sounds["ev7_1_thruster_fix_%d_derived_%s" % (i, t)] for i, t in ((1, "r6p3s11a"), (2, "r6p3s11b"), (3, "r6p3s11c")))
        assert s1["en"] == "Thruster fixed · light room" and s1["de"] == "Duese fix · Raum leicht"
        assert s2["channels"] == 2 and "place" not in s2 and s1["channels"] == 1 and s1["place"] == 0
        assert all(s["kind"] == "oneshot" and s["path"] == "structure" and s["source"] == "synth" and s["dry"] is False for s in (s1, s2, s3))
        assert s1["licence"] == "generated with MOSS-SoundEffect v2.0 (code and weights Apache-2.0), processed with tools/sound/derive.py"
        assert "Made from the raw file of the candidate ev6_2_thruster_mighty_2_moss_p3s11 of round 6, which the owner called close." in s1["intent"]
        assert "decay time (60 dB) 0.5 s, wet level -9 dB" in s1["intent"] and "one channel" in s1["intent"]
        assert "two channels" in s2["intent"] and "decay time (60 dB) 0.7 s, wet level -6 dB" in s2["intent"]
        assert "Tuned 3 semitones higher by resampling, so the sound is shorter: " in s3["intent"] and " s instead of 2.2 s." in s3["intent"]
        assert "Cut out of the processed file" in s1["intent"] and "LUFS" in s1["intent"] and "Share of the event's energy above 60 Hz" in s1["intent"]
        assert "Made from a candidate that the owner called close." in s1["intent"] and "first try" not in s1["intent"]
        assert all(s["intent"].endswith("Measured in the file: 2 separate shots.") for s in (s1, s2, s3))
        sh = sounds["ev7_3_shield_fix_1_derived_r6p2s11b"]
        assert sh["path"] == "energy" and "a high shelf with its corner at 300 Hz and +8 dB" in sh["intent"] and "changed everything above" not in sh["intent"] and "Measured" not in sh["intent"]
        assert sh["en"] == "Shield fixed · more highs"
        g = [sounds[c["id"]] for c in res["chosen"] if c["family"] == "thruster_gen"]
        assert len(g) == 2 and all(s["intent"].endswith("Measured in the file: 2 separate shots.") for s in g)
        assert all("The owner heard this prompt in round 6." in s["intent"] and "first try" not in s["intent"] for s in g)
        assert g[0]["en"] == "Thruster three · MOSS-SoundEffect" and g[1]["en"].endswith("second pick")
        h = next(s for s in sounds.values() if s["id"].startswith("ev7_4_hull_gen"))
        assert "Measured" not in h["intent"] and "rests on a prompt the owner accepted" in h["intent"]
        assert pub.main(["--prompts-file", str(pf), "--root", str(root), "--out", str(out), "--remove"]) == 0
        assert not (out / "events5").exists()


def test_the_default_prompts_files_know_no_source_derived():
    for name in ("prompts.json", "prompts5.json", "prompts6.json"):
        spec = json.loads((SOUND / name).read_text(encoding="utf-8"))
        assert "derived" not in (spec.get("sources") or []) and not any(f.get("fixed") or f.get("derived") or f.get("shots") for f in spec["families"]), name
    p7 = json.loads((SOUND / "prompts7.json").read_text(encoding="utf-8"))
    assert p7["sources"] == ["moss", "derived"] and p7["category"]["id"] == "events7" and p7["category"]["idPrefix"] == "ev7"
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "gen"
        build_tree(root)
        no_skips = str(Path(td) / "none.json")
        assert screen.main(["--no-models", "--root", str(root), "--skips", no_skips]) == 0
        first = (root / "screen.json").read_bytes()
        # a derived folder in the root of a round that does not list the source is not read: the same screen.json
        (root / "derived" / "raw").mkdir(parents=True)
        sf.write(str(root / "derived" / "raw" / "hull_1.wav"), (0.5 * sine(200, 1.0)).astype(np.float32), SR, subtype="FLOAT")
        (root / "derived" / "gen.json").write_text(json.dumps({"source": "derived", "items": {"hull_1": {
            "file": "raw/hull_1.wav", "family": "hull", "prompt": "hull_1", "seed": None, "text_given": "x"}}}), encoding="utf-8")
        assert screen.main(["--no-models", "--root", str(root), "--skips", no_skips]) == 0
        assert (root / "screen.json").read_bytes() == first
        res = json.loads(first)
        assert "derived" not in res["sources"] and not any("shots" in f or "loud50Db" in f for f in res["files"])
        assert not any(c["source"] == "derived" or "fixed" in c or "shots" in c for c in res["chosen"])
        # a prompts file with a fixed family but without the source is a plain error
        spec = json.loads(json.dumps(SPEC7))
        spec["sources"] = ["moss"]
        pf = Path(td) / "p.json"
        pf.write_text(json.dumps(spec), encoding="utf-8")
        assert screen.main(["--no-models", "--root", str(root), "--prompts-file", str(pf), "--skips", no_skips]) == 1
    # round 7's adapter jobs: five prompts, eight seeds, nothing for the fixed families
    common = importlib.util.spec_from_file_location("sound_common_t", SOUND / "common.py")
    cm = importlib.util.module_from_spec(common)
    common.loader.exec_module(cm)
    cm.configure(str(SOUND / "prompts7.json"))
    jobs = cm.jobs()
    assert len(jobs) == 40 and not [j for j in jobs if j["family"] in ("thruster_room", "shield_brighter")]
    assert sorted({j["seed"] for j in jobs}) == list(range(21, 29)) and len({j["prompt"] for j in jobs}) == 5


def test_a_category_events7_in_sounds_json_is_first_with_the_names_of_the_plan():
    spec = json.loads((SOUND.parent / "audio" / "sounds.json").read_text(encoding="utf-8"))
    cats = [c for c in spec["categories"] if c["id"]]
    ids = [c["id"] for c in cats]
    p7 = json.loads((SOUND / "prompts7.json").read_text(encoding="utf-8"))["category"]
    if "events7" in ids:
        assert ids[0] == "events7"
        assert cats[0]["de"] == p7["de"] and cats[0]["en"] == p7["en"]
    sk7 = json.loads((SOUND / "skips7.json").read_text(encoding="utf-8"))
    assert sk7["note"].strip() and all(k["candidate"].count("/") == 1 and k["reason"].strip() for k in sk7["skips"])
    assert "moss/shield_snap_1__s22" in {k["candidate"] for k in sk7["skips"]}


def two_shots(shot_s: float = 1.0, total_s: float = 2.2) -> np.ndarray:
    """A one-channel signal of two decaying bursts 1.0 s apart (onsets 0.1 and 1.1 s); each is under -50 dB again before the next one and the end."""
    t = np.arange(int(0.6 * SR)) / SR
    b = 0.8 * np.sin(2 * np.pi * 150 * t) * 10 ** (-120.0 * t / 20.0)  # 120 dB per second: gone (under -60 dB) after 0.5 s
    return place(total_s, [(0.1, b), (0.1 + shot_s, b)])[:, 0]


def test_derive_append_copies_the_part_to_the_end_and_records_the_splice():
    x = two_shots()
    y, ops = derive.apply_process(x, SR, [{"op": "append", "fromS": 0.0, "toS": 1.0}])
    n = x.size
    assert y.shape == (n + SR, 1) and np.array_equal(y[:n, 0], x) and np.array_equal(y[n:, 0], x[:SR])
    o = ops[0]
    assert o["op"] == "append" and o["spliceS"] == 2.2 and o["copiedS"] == 1.0 and o["lengthBeforeS"] == 2.2 and o["lengthAfterS"] == 3.2
    lv = o["levelsDbUnderPeak"]
    assert set(lv) == {"beforeSpliceDb", "copyFirstDb", "copyLastDb"} and all(v >= 50.0 for v in lv.values())
    assert 0.0 <= o["maxStepWithin1ms"] < 0.01 and o["peakBefore"] > 0.7
    want = float(np.abs(np.diff(y[n - 49:n + 49, 0])).max())
    assert abs(o["maxStepWithin1ms"] - want) < 1e-5
    # no gain, no fade: the signal at that point of the list is what is copied (a pitch first shortens it)
    y2, ops2 = derive.apply_process(x, SR, [{"op": "pitch", "semitones": 12.0}, {"op": "append", "fromS": 0.0, "toS": 0.5}])
    k = y2.shape[0] - int(round(0.5 * SR))
    assert np.array_equal(y2[k:, 0], y2[:int(round(0.5 * SR)), 0]) and abs(ops2[1]["lengthBeforeS"] - 1.1) < 0.001
    # then a room works on the lengthened signal
    y3, _ = derive.apply_process(x, SR, [{"op": "append", "fromS": 0.0, "toS": 1.0}, {"op": "room", "rt60S": 0.5, "wetDb": -6.0, "channels": 1, "seed": 7}])
    assert y3.shape[0] > n + SR
    txt = derive.say([{"op": "append", "fromS": 0.0, "toS": 1.0}, {"op": "room", "rt60S": 1.4, "wetDb": -4.0, "channels": 1, "seed": 7}])
    assert "a copy of the samples from 0 s to 1 s of the raw file was appended to its end" in txt and "the appended part is a copy" in txt


def test_derive_append_refuses_a_splice_that_would_have_a_step():
    import contextlib
    import io

    x = two_shots()
    for what, p in (("copy ends inside a shot", {"fromS": 0.0, "toS": 1.15}),
                    ("copy starts inside a shot", {"fromS": 0.15, "toS": 1.0}),
                    ("not a part of the signal", {"fromS": 0.0, "toS": 2.5}), ("empty part", {"fromS": 0.5, "toS": 0.5})):
        try:
            derive.apply_process(x, SR, [dict(p, op="append")])
        except ValueError as e:
            assert "append" in str(e), what
        else:
            raise AssertionError(what)
    loud_end = x.copy()
    loud_end[-SR // 100:] = 0.5
    try:
        derive.apply_process(loud_end, SR, [{"op": "append", "fromS": 0.0, "toS": 1.0}])
    except ValueError as e:
        assert "beforeSpliceDb" in str(e) and "refused" in str(e)
    else:
        raise AssertionError("a loud end before the splice must be refused")
    # at the edge: 51 dB under the peak passes, 49 dB does not
    for db, ok in ((-51.0, True), (-49.0, False)):
        z = x.copy()
        z[-SR // 100:] = 0.0
        z[-SR // 100] = np.abs(x).max() * 10 ** (db / 20.0)
        try:
            derive.apply_process(z, SR, [{"op": "append", "fromS": 0.0, "toS": 1.0}])
            assert ok, db
        except ValueError:
            assert not ok, db
    # in a run the item is refused with its id, the others go on and the exit code is 1
    with tempfile.TemporaryDirectory() as td:
        td, root, pf = build_round7(Path(td), {21: 2, 22: 2, 23: 2, 24: 2})
        spec = json.loads(pf.read_text(encoding="utf-8"))
        spec["families"][0]["derived"][2]["process"] = [{"op": "append", "fromS": 0.0, "toS": 1.15}]
        pf.write_text(json.dumps(spec), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = derive.main(["--prompts-file", str(pf), "--out-root", str(root)])
        assert code == 1 and "REFUSED thruster_fix_3: append" in out.getvalue()
        assert sorted(json.loads((root / "derived" / "gen.json").read_text(encoding="utf-8"))["items"]) == ["shield_fix_1", "thruster_fix_1", "thruster_fix_2"]


def test_a_family_without_a_fallback_leaves_a_slot_of_pressed_noise_empty_and_says_why():
    def pool():
        return [sat_cand("a", -5.0, 0.2, True, 100.0), sat_cand("b", -8.0, 0.2, True, 130.0)]
    rule = {"loud50Db": -9.5, "above2kHz": 0.03}
    picks, notes = screen.choose(pool(), ["moss"], False, rule)
    assert picks == [] and len(notes) == 1
    assert "2 kept candidates" in notes[0] and "all 2 are over both numbers" in notes[0] and "above -9.5 dBFS" in notes[0] and "0.03" in notes[0]
    assert "stays empty" in notes[0] and "filled from" not in notes[0]
    # the default is the fallback of rounds 5 and 6
    picks, notes = screen.choose(pool(), ["moss"])
    assert [p["cand"]["name"] for p in picks] == ["b"] and picks[0]["saturatedFallback"] is True
    # a clean candidate is picked as before, and only the slot behind it stays empty
    mixed = pool() + [sat_cand("c", -20.0, 0.01, False, 300.0)]
    picks, notes = screen.choose(mixed, ["moss", "moss"], False, rule)
    assert [p["cand"]["name"] for p in picks] == ["c"] and "2 are over both numbers" in notes[0] and "3 kept candidates" in notes[0] and "all 2 are" not in notes[0]
    # the plan key
    assert "pressedNoiseFallback" not in screen.family_settings({"id": "x", "lufs": -24, "maxS": 1.5})
    assert screen.family_settings({"id": "x", "lufs": -24, "maxS": 1.5, "pressedNoiseFallback": False})["pressedNoiseFallback"] is False
    p7 = {f["id"]: f for f in json.loads((SOUND / "prompts7.json").read_text(encoding="utf-8"))["families"]}
    assert p7["shield_absorb"]["pressedNoiseFallback"] is False
    assert not any("pressedNoiseFallback" in f for n in ("prompts.json", "prompts5.json", "prompts6.json")
                   for f in json.loads((SOUND / n).read_text(encoding="utf-8"))["families"])


def test_publish_never_calls_a_fallback_the_most_typical_candidate():
    pub = load("publish")
    fam = {"id": "shield_absorb", "en": "e", "de": "d", "picks": ["moss"], "proven": False, "notSaturatedNoise": {"loud50Db": -9.5, "above2kHz": 0.03}}
    c = {"id": "ev7_6_shield_absorb_1_moss_p1s27", "family": "shield_absorb", "slot": 1, "role": "typical", "source": "moss", "sourceRank": 1,
         "cut": {"startS": 0.07, "endS": 1.23, "cappedAtFamilyLength": False}, "energyAbove60Hz": 0.84,
         "listen": {"lufsTarget": -24.0, "lufsPageTarget": -21.0, "lufsReachedPage": -20.99, "lufsReached": -24.0},
         "record": {"text_given": "x", "seed": 27}, "loud50Db": -9.36, "above2kHzLoud": 0.5933}
    plain, _ = pub.describe_source(dict(c), fam)
    assert "Chosen as the most typical candidate of its source in this family." in plain
    fb, _ = pub.describe_source(dict(c, pressedNoiseFallback=True), fam)
    assert "most typical" not in fb and "A fallback, not a typical pick" in fb
    assert "-9.36 dBFS" in fb and "0.5933" in fb and "above -9.5 dBFS and 0.03 or more" in fb and "over both" in fb
    fb2, _ = pub.describe_source(dict(c, pressedNoiseFallback=True, sourceRank=2, role="farthest"), fam)
    assert "most typical" not in fb2 and "A fallback" in fb2
    # the sentence about the level as the page plays it is inherited and stays as it was
    assert "as the page plays it in the Stereo stage, over two channels with a one-channel file counted on both, -21.0 LUFS" in fb
    # an append in a derived entry says that the appended part is a copy, with the numbers of the splice
    d = {"op": "append", "fromS": 0.0, "toS": 1.0}
    num = {"operations": [{"op": "append", "fromS": 0.0, "toS": 1.0, "spliceS": 2.0, "copiedS": 1.0,
                           "levelsDbUnderPeak": {"beforeSpliceDb": 61.5, "copyFirstDb": 70.25, "copyLastDb": 55.0}, "maxStepWithin1ms": 0.0012}]}
    t = pub.describe_process([d], num)
    assert "A copy of the samples from 0 s to 1 s of the raw file was appended" in t and "is a copy, not new material" in t
    assert "it starts at 2 s" in t and "61.5 dB" in t and "0.0012" in t


def main() -> int:
    tests = [(k, v) for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    bad = 0
    for name, fn in tests:
        try:
            fn()
            print("ok    " + name)
        except Exception:
            bad += 1
            print("FAIL  " + name)
            traceback.print_exc()
    print("%d tests, %d failed" % (len(tests), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
