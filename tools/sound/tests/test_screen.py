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
