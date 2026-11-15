"""Tests of tools/voice/score.py. pytest is not in the sound library's environment, so these are
plain functions: run with  .venv-audio/Scripts/python.exe tools/voice/tests/test_score.py
(pytest, where present, collects them as well)."""
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import score  # noqa: E402

SR = 16000


def tone(sec, f=440.0, amp=0.3, sr=SR):
    t = np.arange(int(sec * sr)) / sr
    return amp * np.sin(2 * np.pi * f * t)


# ------------------------------------------------------------------ words

def test_alignment_basic():
    ops = score.align(["a", "b", "c"], ["a", "x", "c"])
    assert [o[0] for o in ops] == ["eq", "sub", "eq"]
    ops = score.align(["a", "b", "c"], ["a", "c"])
    assert [o[0] for o in ops] == ["eq", "del", "eq"]
    ops = score.align(["a", "c"], ["a", "b", "c"])
    assert [o[0] for o in ops] == ["eq", "ins", "eq"]


def test_perfect_and_ordinary_errors():
    r = score.score_text("Cut your engines and stand by.", "Cut your engines and stand by.")
    assert r["ordinary_errors"] == 0 and r["wer"] == 0.0
    r = score.score_text("Cut your engines and stand by.", "Cut the engines and stand by now.")
    assert r["substitutions"] == 1 and r["insertions"] == 1 and r["deletions"] == 0
    assert r["ordinary_errors"] == 2 and abs(r["wer"] - 2 / 5) < 1e-3  # "stand by" is one word


def test_names_are_counted_apart():
    names = ["Drover", "Halvard"]
    ref = "Drover seven four niner, Halvard Control. Cleared."
    # both names wrong: not a single ordinary-word error, names hit 0 of 2
    r = score.score_text(ref, "Drove her 749, Hallward Control. Cleared.", names)
    assert r["ordinary_errors"] == 0, r
    assert r["names_in_reference"] == 2 and r["names_hit"] == 0
    assert {m["name"] for m in r["names_missed"]} == {"Drover", "Halvard"}
    # one name right, one ordinary word wrong
    r = score.score_text(ref, "Drover 749, Hallward Control. Cleared.", names)
    assert r["names_hit"] == 1 and r["ordinary_errors"] == 0
    r = score.score_text(ref, "Drover 749, Halvard Controls. Cleared.", names)
    assert r["names_hit"] == 2 and r["ordinary_errors"] == 1


def test_name_split_in_two_words_adds_no_ordinary_error():
    r = score.score_text("Destination: Ysolde Prime.", "Destination: is old Prime.", ["Ysolde"])
    assert r["names_hit"] == 0 and r["ordinary_errors"] == 0, r


def test_possessive_name():
    r = score.score_text("Stand by at Delver's gate.", "Stand by at Delver's gate.", ["Delver's"])
    assert r["names_hit"] == 1 and r["ordinary_errors"] == 0, r
    r = score.score_text("Stand by at Delver's gate.", "Stand by at Delvers gate.", ["Delver's"])
    assert r["names_hit"] == 1, r


def test_spelling_folds_are_no_errors():
    r = score.score_text("Cleared to pad four, stand by. Range twelve kilometres. Platinum ore.",
                         "Cleared to pad 4 er standby. Range 12 km. Platinum or.")
    assert r["ordinary_errors"] == 0, r
    r = score.score_text("Helium 3", "Helium III")
    assert r["ordinary_errors"] == 0, r
    r = score.score_text("Cut your engines", "Cut your engines now")
    assert r["ordinary_errors"] == 1


def test_digit_read_backs():
    same = [
        ("seven four niner", "749"), ("seven four niner", "7 4 9"), ("seven four niner", "seven four nine"),
        ("five zero", "50"), ("five zero", "5 0"),
        ("one one eight decimal three", "118.3"), ("one one eight decimal three", "118 point 3"),
        ("pad zero four", "pad 04"), ("hull at two zero percent", "hull at 20%"),
        ("hull at two zero percent", "hull at 20 percent"), ("below five zero metres per second", "below 50 m/s"),
        ("Wayfarer three one six", "Wayfarer 316"), ("sixty-two percent", "62%"),
        ("ninety-five thousand credits", "95,000 credits"),
    ]
    for a, b in same:
        r = score.score_text(a, b)
        assert r["ordinary_errors"] == 0, (a, b, r["ref_tokens"], r["hyp_tokens"])
        r = score.score_text(b, a)
        assert r["ordinary_errors"] == 0, (b, a, r["ref_tokens"], r["hyp_tokens"])


def test_digit_errors_still_count():
    r = score.score_text("seven four niner", "7 4 8")
    assert r["ordinary_errors"] == 1
    r = score.score_text("pad zero four", "pad 4")  # a dropped zero is a real read-back error
    assert r["ordinary_errors"] == 1


def test_call_sign_letters():
    r = score.score_text("Squawk Alpha Kilo four four seven.", "Squawk AK-447.")
    assert r["ordinary_errors"] == 0, (r["ref_tokens"], r["hyp_tokens"])
    r = score.score_text("Squawk Alpha Kilo four four seven.", "Squawk alpha kilo 447.")
    assert r["ordinary_errors"] == 0


def test_empty_hypothesis():
    r = score.score_text("one two three", "")
    assert r["deletions"] == 3 and r["wer"] == 1.0


# ------------------------------------------------------------------ level and shape

def test_clipping_and_dc():
    x = tone(0.5, amp=1.0)
    x = np.clip(x * 1.5, -1, 1)
    rep = score.level_report(x, SR)
    assert rep["clipped_samples"] > 100
    assert rep["true_peak_db"] >= rep["peak_db"] - 0.01
    y = tone(0.5, amp=0.2) + 0.05
    assert abs(score.level_report(y, SR)["dc_offset"] - 0.05) < 1e-3
    assert score.level_report(tone(0.5, amp=0.5), SR)["clipped_samples"] == 0


def test_silence_profile():
    x = np.concatenate([np.zeros(int(0.30 * SR)), tone(0.5), np.zeros(int(1.0 * SR)), tone(0.4), np.zeros(int(0.2 * SR))])
    p = score.silence_profile(x, SR)
    assert abs(p["lead_s"] - 0.30) < 0.02, p
    assert abs(p["tail_s"] - 0.20) < 0.02, p
    assert abs(p["longest_inside_s"] - 1.0) < 0.03, p
    q = score.silence_profile(tone(0.5), SR)
    assert q["lead_s"] == 0 and q["tail_s"] == 0 and q["longest_inside_s"] == 0
    z = score.silence_profile(np.zeros(SR), SR)
    assert z["all_silent"]
    # -60 dBFS tone is silence, -40 dBFS is not
    assert score.silence_profile(tone(0.5, amp=1e-3 * 1.414), SR)["all_silent"]
    assert not score.silence_profile(tone(0.5, amp=1e-2 * 1.414), SR)["all_silent"]


def test_level_report_other_rates_and_words_per_second():
    for sr in (22050, 24000, 44100, 48000):
        rep = score.level_report(tone(1.0, sr=sr, amp=0.1), sr, "one two three four")
        assert rep["sr"] == sr and abs(rep["duration_s"] - 1.0) < 1e-3
        assert abs(rep["rms_db"] - (-23.0)) < 0.2  # 0.1 amplitude sine: -20 - 3.01 dB
        assert abs(rep["words_per_s"] - 4.0) < 0.01
    tiny = score.level_report(np.zeros(10), SR)  # shorter than any window and silent: no crash
    assert tiny["lufs"] is None


# ------------------------------------------------------------------ listening copy

def _bump(sec=2.0, sr=SR, amp=0.2):
    return tone(sec, 300.0, amp, sr) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * np.arange(int(sec * sr)) / sr))


def test_fades():
    x = np.ones(48000)
    y = score.fade_edges(x, 48000)
    n = int(0.008 * 48000)
    assert y[0] == 0 and y[-1] == 0
    assert np.all(np.diff(y[:n]) > 0) and np.all(np.diff(y[-n:]) < 0)
    assert np.all(y[n:-n] == 1.0)
    assert abs(len(y) - len(x)) == 0


def test_listen_copy_loudness_and_peak():
    levels = []
    for amp in (0.02, 0.1, 0.4):
        for sr in (16000, 24000, 44100):
            res = score.make_listen_copy(_bump(2.0, sr, amp), sr, radio=False)
            lu = score.integrated_lufs(res["dry"], score.LISTEN_SR)
            levels.append(lu)
            assert score.true_peak_db(res["dry"], score.LISTEN_SR) <= score.LISTEN_TP_DB + 0.05
            assert abs(res["dry"].size / score.LISTEN_SR - 2.0) < 0.01
            assert res["dry"][0] == 0 and res["dry"][-1] == 0
            assert res["wet"] is None
    assert max(levels) - min(levels) < 0.3 and abs(np.mean(levels) - (-23.0)) < 0.3, levels


def test_listen_copy_peaky_signal_is_limited_by_true_peak():
    x = _bump(2.0, 24000, 0.05)
    x[24000] = 0.9  # a click: loudness gain would put it far above -3 dBFS
    res = score.make_listen_copy(x, 24000, radio=False)
    assert res["info"]["limited"]
    assert score.true_peak_db(res["dry"], score.LISTEN_SR) <= score.LISTEN_TP_DB + 0.05


def test_listen_copy_radio():
    sys.path.insert(0, str(score.AUDIO_TOOLS / "synth"))
    from radio import radio_filter

    res = score.make_listen_copy(_bump(2.0, 24000, 0.2), 24000, radio=True, radio_filter=radio_filter)
    assert res["wet"] is not None and res["wet"].shape == res["dry"].shape
    assert not np.allclose(res["wet"], res["dry"])
    assert score.true_peak_db(res["wet"], score.LISTEN_SR) <= score.LISTEN_TP_DB + 0.05
    assert res["wet"][0] == 0 and res["wet"][-1] == 0


# ------------------------------------------------------------------ end to end without Whisper

def test_end_to_end_fake_model():
    import json

    import soundfile as sf

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        d = root / "fakemodel" / "cpu"
        d.mkdir(parents=True)
        (root / "_hidden").mkdir()
        (root / ".bench.lock").mkdir()
        sf.write(str(d / "radio_clearance.wav"), _bump(1.5, 22050).astype(np.float32), 22050, subtype="FLOAT")
        sf.write(str(d / "computer_fold.wav"), _bump(1.0, 24000).astype(np.float32), 24000, subtype="FLOAT")
        before = (d / "computer_fold.wav").read_bytes()
        (d / "timing.json").write_text(json.dumps({"model": "fakemodel", "device": "cpu", "load_s": 1.5, "rtf_median": 0.4,
                                                   "lines": {"radio_clearance": {"rtf": 0.4, "first_audio_s": 0.3}}}))
        res = score.run(None, False, root)
        assert list(res["models"]) == ["fakemodel"]
        rec = res["models"]["fakemodel"]["cpu"]
        assert len(rec["lines"]) == 2 and len(rec["missing_lines"]) == 13
        assert rec["summary"]["timing"]["rtf_median"] == 0.4
        assert rec["summary"]["timing"]["first_audio_s_median"] == 0.3
        lines = json.loads((score.HERE / "lines.json").read_text(encoding="utf-8"))["lines"]
        rep = score.write_listen(["fakemodel"], lines, root / "_listen", root)
        names = sorted(p.name for p in (root / "_listen").iterdir())
        assert names == ["fakemodel__computer_fold.wav", "fakemodel__radio_clearance.wav",
                         "fakemodel__radio_clearance__dry.wav"], names
        info = sf.info(str(root / "_listen" / names[0]))
        assert info.samplerate == 48000 and info.channels == 1 and info.subtype == "PCM_24"
        assert len(rep) == 2
        assert (d / "computer_fold.wav").read_bytes() == before  # the WAV is untouched


# ------------------------------------------------------------------ alignment ties between names and ordinary words

CONVOY_NAMES = ["Tsiolkov", "Xanthe", "Ngozi", "Cael", "Morrow", "Zhenya's", "Brakkenridge"]
CONVOY_REF = ("Convoy Tsiolkov Gap to Xanthe Drift: escorts Ngozi, Cael Morrow and Zhenya's Rest report ready. "
              "Pilot Brakkenridge, you have the lead.")


def test_tie_keeps_the_errors_on_the_names_qwen3_convoy():
    # qwen3 on the card, procedural_convoy: Whisper's text. Hand count: 2 ordinary errors (drift is lost
    # inside xanthodrift, escorts heard as escort); the spoken "and" is right. The plain edit distance has a
    # second, equally cheap alignment that pairs "and" with "genya" and counted 3.
    hyp = "Convoy Tsiolkov Gap to Xanthodrift, Escort Snowzie, Kail Maro and Genya's Rest Report ready. Pilot Brackenridge, you have the lead."
    r = score.score_text(CONVOY_REF, hyp, CONVOY_NAMES)
    assert r["ordinary_errors"] == 2, r
    assert r["names_in_reference"] == 7 and r["names_hit"] == 1, r
    ref, hy = r["ref_tokens"].split(), r["hyp_tokens"].split()
    npos = score.name_positions(ref, CONVOY_NAMES)
    ops = score.align(ref, hy, npos)
    pairs = {(ref[o[1]], hy[o[2]]) for o in ops if o[0] == "eq"}
    assert ("and", "and") in pairs, ops  # the right word stays on the right word
    assert not any(o[0] == "sub" and ref[o[1]] == "and" for o in ops), ops


def test_tie_other_convoy_lines_by_hand():
    # hand counts from Whisper's text: kitten-blend 2 (drift lost in zanddrift, escorts as iskorts; the extra
    # "and" is an insertion inside a name run), phonon 1 (drift lost in santadrift), phonon-blend 1 (pilot as pella)
    cases = [
        ("Convoy Tsiolkov Gap to Zanddrift, Iskorts and Gosi, Kiel Moro and Jeaniez Rest Report ready. Pilot Brackenridge you have the lead.", 2),
        ("Convoy T.S. Ilkov Gap to Santadrift, Escorts Ngozi, KL Moro and Zenya's Rest Report ready. Pilot Brockenridge, you have the lead.", 1),
        ("Convoy T. Silkov Gap to Zanti Drift, Escorts Ngozi, K. L. Moro and Zina's Rest Report ready. Pella Brockenridge, you have the lead.", 1),
    ]
    for hyp, want in cases:
        r = score.score_text(CONVOY_REF, hyp, CONVOY_NAMES)
        assert r["ordinary_errors"] == want, (want, r["ordinary_errors"], r["ref_tokens"], r["hyp_tokens"])


def test_align_cost_is_never_traded_for_names():
    # same edit distance as without names, only the choice among equal-cost alignments moves
    ref = "a b c d e".split()
    hyp = "a x c y e".split()
    ops = score.align(ref, hyp, {1: 0})
    assert [o[0] for o in ops] == ["eq", "sub", "eq", "sub", "eq"]
    assert sum(o[0] != "eq" for o in score.align(ref, hyp[:3], {1: 0})) == 3  # b to x, d and e gone


def test_words_per_second_counts_the_spoken_words_of_a_raw_line():
    import json

    import soundfile as sf

    raw = {"id": "cargo_raw", "role": "computer", "voice": "computer", "raw": True,
           "text": "Cargo: 24 t Helium-3", "spoken": "Cargo: twenty-four tons of helium three", "names": []}
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        (td / "lines.json").write_text(json.dumps({"lines": [raw]}), encoding="utf-8")
        d = td / "m" / "cpu"
        d.mkdir(parents=True)
        (d / "timing.json").write_text(json.dumps({"lines": {}}), encoding="utf-8")
        sf.write(str(d / "cargo_raw.wav"), tone(2.0, sr=24000), 24000)
        res = score.run(None, False, td, td / "lines.json")
    wps = res["models"]["m"]["cpu"]["lines"]["cargo_raw"]["level"]["words_per_s"]
    assert abs(wps - 6 / 2.0) < 0.01, wps  # six spoken words (not the four written tokens, which would give 2.0) in 2 s


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except Exception:
                failed += 1
                import traceback

                print("FAIL", name)
                traceback.print_exc()
    sys.exit(1 if failed else 0)
