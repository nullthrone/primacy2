"""Tests of the listening tools on synthetic signals.

Run: .venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/listen/tests -v
Tests that need a model are skipped with a message when the model cannot be loaded.
"""
import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import measure  # noqa: E402
import transcribe  # noqa: E402

SR = 48000


def sine(freq, seconds=2.0, amp=1.0, sr=SR, phase=0.0):
    t = np.arange(int(round(seconds * sr))) / sr
    return (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)[:, None]


def noise(seconds=2.0, seed=1, sr=SR):
    return np.random.default_rng(seed).standard_normal(int(seconds * sr)).astype(np.float32)[:, None] * 0.1


class MeasureTests(unittest.TestCase):
    def test_sine_peak_minus_20(self):
        r = measure.analyse(sine(1000, amp=10 ** (-20 / 20)), SR)
        self.assertAlmostEqual(r["samplePeakDb"], -20.0, delta=0.1)
        self.assertAlmostEqual(r["truePeakDb"], -20.0, delta=0.1)

    def test_full_scale_sine_lufs(self):
        # The BS.1770 reference case: a full-scale 1 kHz mono sine reads -3.01 LUFS.
        r = measure.analyse(sine(1000, seconds=3.0), SR)
        self.assertAlmostEqual(r["lufs"], -3.01, delta=0.2)

    def test_clipped_sine_is_counted(self):
        x = np.clip(sine(440, amp=1.5), -1.0, 1.0)
        r = measure.analyse(x, SR)
        self.assertGreater(r["clippedSamples"], 100)
        self.assertEqual(measure.analyse(sine(440, amp=0.5), SR)["clippedSamples"], 0)

    def test_true_peak_exceeds_sample_peak_between_samples(self):
        # A sine at fs/4 with a 45 degree phase has all samples at 0.707 of the real peak.
        x = sine(SR / 4, amp=1.0, phase=np.pi / 4)
        r = measure.analyse(x, SR)
        self.assertAlmostEqual(r["samplePeakDb"], -3.01, delta=0.05)
        self.assertGreater(r["truePeakDb"], -0.3)

    def test_band_shares_low_and_high_sine(self):
        low = measure.analyse(sine(100), SR)
        self.assertGreater(low["bands"]["60-125"], 0.95)
        self.assertGreater(low["lowShare"], 0.99)
        self.assertLess(low["highShare"], 0.001)
        high = measure.analyse(sine(6000), SR)
        self.assertGreater(high["bands"]["4k-8k"], 0.95)
        self.assertGreater(high["highShare"], 0.95)
        self.assertLess(high["lowShare"], 0.01)

    def test_fundamental_and_peaks(self):
        r = measure.analyse(sine(440) + 0.3 * sine(880) + 0.1 * sine(1320), SR)
        self.assertAlmostEqual(r["fundamentalHz"], 440.0, delta=3)
        self.assertAlmostEqual(r["peaks"][0]["hz"], 440.0, delta=3)

    def test_noise_has_no_fundamental(self):
        self.assertIsNone(measure.analyse(noise(), SR)["fundamentalHz"])

    def test_white_noise_centroid(self):
        r = measure.analyse(noise(4.0), SR)
        self.assertAlmostEqual(r["spectralCentroidHz"], SR / 4, delta=SR / 4 * 0.05)

    def test_burst_onset_and_decay(self):
        tau = 0.040
        t = np.arange(int(1.5 * SR)) / SR
        x = noise(1.5, seed=3)[:, 0] * np.exp(-t / tau)
        x = np.concatenate([np.zeros(int(0.1 * SR), np.float32), x]).astype(np.float32)[:, None]
        e = measure.analyse(x, SR)["envelope"]
        self.assertAlmostEqual(e["onsetMs"], 100.0, delta=3.0)
        self.assertLess(e["attackMs"], 5.0)
        # 60 dB of amplitude takes tau * ln(1000) = 276 ms, counted from the loudest 10 ms frame.
        self.assertAlmostEqual(e["fall60Ms"], 276.0, delta=40.0)
        self.assertLess(e["lastTenMsDb"], -60.0)
        self.assertEqual(len(e["printed"]), 80 if len(e["frameDb"]) >= 80 else len(e["frameDb"]))

    def test_envelope_tells_two_rhythms_apart(self):
        def beeps(period_s):
            x = np.zeros(2 * SR, np.float32)
            for start in np.arange(0, 2.0, period_s):
                i = int(start * SR)
                x[i : i + int(0.1 * SR)] = 0.5 * sine(900, 0.1)[:, 0]
            return x[:, None]

        a = measure.analyse(beeps(0.25), SR)["envelope"]["printed"]
        b = measure.analyse(beeps(0.5), SR)["envelope"]["printed"]
        self.assertNotEqual(a, b)

    def test_seam_sine_whole_periods_passes(self):
        x = sine(1000, seconds=0.25)  # 250 whole periods
        l = measure.analyse(x, SR, loop=True)["loop"]
        self.assertTrue(l["pass"], l)

    def test_seam_sine_cut_mid_period_fails(self):
        x = sine(1000, seconds=0.2503)  # ends a quarter period too late: a step across the wrap
        self.assertFalse(measure.analyse(x, SR, loop=True)["loop"]["seamOk"])
        y = sine(1000, seconds=0.2505)  # half a period too late: values match, slope flips
        self.assertFalse(measure.analyse(y, SR, loop=True)["loop"]["seamOk"])

    def test_seam_noise_passes_and_swing_is_found(self):
        self.assertTrue(measure.analyse(noise(2.0), SR, loop=True)["loop"]["seamOk"])
        t = np.arange(2 * SR) / SR
        swung = (noise(2.0)[:, 0] * (0.5 + 0.45 * np.sin(2 * np.pi * 1.0 * t))).astype(np.float32)[:, None]
        self.assertGreater(measure.analyse(swung, SR, loop=True)["loop"]["levelSwingDb"], 10.0)

    def test_dc_offset_is_found(self):
        r = measure.analyse(sine(500, amp=0.3) + 0.02, SR)
        self.assertAlmostEqual(r["dcOffset"], 0.02, delta=1e-4)
        # ... and does not leak into the spectral numbers
        self.assertLess(r["bands"]["<60"], 0.001)

    def test_stereo_keeps_channels_and_short_clip_works(self):
        x = np.concatenate([sine(300, 0.1), sine(600, 0.1)], axis=1)
        r = measure.analyse(x, SR)
        self.assertEqual(r["channels"], 2)
        self.assertIsNotNone(r["lufs"])

    def test_png_and_text_output(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.png"
            r = measure.analyse(sine(1000, 0.5), SR)
            measure.write_png(p, "x.wav", sine(1000, 0.5), SR, r)
            self.assertGreater(p.stat().st_size, 5000)
        self.assertIn("LUFS", measure.format_text("x.wav", r))


class CommonTests(unittest.TestCase):
    def test_resample_length(self):
        self.assertEqual(common.resample(np.zeros((48000, 1), np.float32), 48000, 16000).shape[0], 16000)

    def test_load_keeps_channels(self):
        import soundfile as sf

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.wav"
            sf.write(str(p), np.zeros((1000, 2), np.float32), 22050)
            x, sr = common.load_audio(p)
            self.assertEqual((x.shape, sr, x.dtype), ((1000, 2), 22050, np.float32))


class WerTests(unittest.TestCase):
    def test_wer(self):
        self.assertEqual(transcribe.wer("a b c d", "a b c d"), 0.0)
        self.assertAlmostEqual(transcribe.wer("a b c d", "a x c d"), 0.25)
        self.assertAlmostEqual(transcribe.wer("a b c d", "a c d"), 0.25)
        self.assertAlmostEqual(transcribe.wer("a b", "a b c d"), 1.0)
        self.assertEqual(transcribe.wer("Hello, World!", "hello world"), 0.0)
        self.assertEqual(transcribe.wer("it's", "its"), 0.0)


@contextlib.contextmanager
def _locked(label):
    with common.gpu_lock(label):
        yield


class ClapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._stack = contextlib.ExitStack()
        try:
            cls._stack.enter_context(_locked("tests: CLAP"))
            import compare

            cls.clap = compare.Clap()
        except BaseException as exc:  # SystemExit from the lock counts too
            cls._stack.close()
            raise unittest.SkipTest("CLAP cannot be loaded: %r" % (exc,))

    @classmethod
    def tearDownClass(cls):
        cls._stack.close()

    def test_tone_noise_and_rumble_score_on_their_own_description(self):
        descs = ["a pure sine wave tone", "white noise hiss", "a deep low rumble"]
        t = np.arange(4 * SR) / SR
        # A rumble is band-limited noise around 50 Hz with a slow swell, not a clean sine.
        from scipy.signal import butter, sosfilt

        sos = butter(4, [30, 80], btype="bandpass", fs=SR, output="sos")
        rumble = sosfilt(sos, noise(4.0, seed=5)[:, 0]) * (1 + 0.3 * np.sin(2 * np.pi * 0.7 * t))
        rumble = rumble / np.abs(rumble).max() * 0.5
        cases = {0: sine(440, 4.0, 0.5)[:, 0], 1: noise(4.0, seed=2)[:, 0], 2: rumble.astype(np.float32)}
        for want, x in cases.items():
            scores = self.clap.score(x, SR, descs)
            self.assertEqual(int(np.argmax(scores)), want, "%s scored %s" % (descs[want], scores))

    def test_short_and_long_clips_are_handled(self):
        for seconds in (0.2, 25.0):
            s = self.clap.score(noise(seconds, seed=4)[:, 0], SR, ["white noise hiss", "a pure sine wave tone"])
            self.assertEqual(len(s), 2)
            self.assertTrue(all(np.isfinite(s)))


TTS = r"""
param([string]$Out, [string]$Text)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
# The default voice may be a German one; an English sentence needs an English voice.
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
if (-not $v) { exit 4 }
$s.SelectVoice($v.VoiceInfo.Name)
$s.SetOutputToWaveFile($Out)
$s.Speak($Text)
$s.Dispose()
"""
SENTENCE = "The docking clearance is granted. Proceed to the landing bay."


class WhisperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp()
        cls._stack = contextlib.ExitStack()
        try:
            if os.name != "nt" or not shutil.which("powershell"):
                raise RuntimeError("no Windows speech synthesiser (System.Speech) here")
            ps1 = Path(cls._tmp) / "tts.ps1"
            ps1.write_text(TTS, encoding="utf-8")
            cls.wav = Path(cls._tmp) / "speech.wav"
            run = subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1), "-Out", str(cls.wav), "-Text", SENTENCE],
                capture_output=True, timeout=120,
            )
            if run.returncode == 4:
                raise RuntimeError("no English voice installed for System.Speech")
            if run.returncode != 0:
                raise RuntimeError("synthesiser failed: %r" % run.stderr[:200])
            if not cls.wav.exists() or cls.wav.stat().st_size < 10000:
                raise RuntimeError("synthesiser wrote no audio")
            cls._stack.enter_context(_locked("tests: Whisper"))
            cls.whisper = transcribe.Whisper()
        except BaseException as exc:
            cls._stack.close()
            shutil.rmtree(cls._tmp, ignore_errors=True)
            raise unittest.SkipTest("Whisper test not possible: %r" % (exc,))

    @classmethod
    def tearDownClass(cls):
        cls._stack.close()
        shutil.rmtree(cls._tmp, ignore_errors=True)  # the speech file is never kept

    def test_synthesised_speech_is_transcribed(self):
        data, sr = common.load_audio(self.wav)
        text = self.whisper.transcribe(common.to_mono(data), sr, "en")
        self.assertLessEqual(transcribe.wer(SENTENCE, text), 0.2, text)


if __name__ == "__main__":
    unittest.main()
