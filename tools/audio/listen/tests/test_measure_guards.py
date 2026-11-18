"""Guards for the numbers of measure.py: each test has a signal whose right answer is known by
construction or by BS.1770 / the published filter, so a wrong constant or a missing step is seen.

Run: .venv-audio/Scripts/python.exe -m unittest discover -s tools/audio/listen/tests -v

The loudness reference below is a small, separate implementation of ITU-R BS.1770-4 at 48 kHz
(K-weighting with the coefficients printed in the standard, 400 ms blocks every 100 ms, absolute gate
-70 LUFS, relative gate 10 LU). It shares no code with measure.py or synth/levels.py. The signals
used with it are at least 0.4 s long and a multiple of 100 ms, where pyloudnorm and the standard
agree; the 0.04 dB offset of pyloudnorm's default filter (an open point, see the fix report) is
inside the 0.1 dB tolerances below and cancels in the differences.
"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from scipy.signal import freqz, lfilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import measure  # noqa: E402

SR = 48000

# BS.1770-4 table 1 (pre-filter) and table 2 (RLB high-pass), 48 kHz
PRE_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
PRE_A = [1.0, -1.69065929318241, 0.73248077421585]
RLB_B = [1.0, -2.0, 1.0]
RLB_A = [1.0, -1.99004745483398, 0.99007225036621]


def tone(f, amp=0.3, seconds=1.0, phase=0.0):
    t = np.arange(int(round(seconds * SR))) / SR
    return amp * np.sin(2 * np.pi * f * t + phase)


def col(x):
    return np.asarray(x, dtype=np.float64)[:, None]


def faded(x, fade_s=0.1):
    """A signal with raised-cosine ends, so that the file ends add nothing to the true peak."""
    x = np.array(x, dtype=np.float64)
    k = int(fade_s * SR)
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / k)
    x[:k] *= ramp
    x[-k:] *= ramp[::-1]
    return x


def k_gain_db(f):
    """Gain of the K-weighting at f, from the published coefficients."""
    w = [2 * np.pi * f / SR]
    h = freqz(PRE_B, PRE_A, worN=w)[1][0] * freqz(RLB_B, RLB_A, worN=w)[1][0]
    return 20 * np.log10(abs(h))


def ref_lufs(x):
    """Integrated loudness of a mono signal by BS.1770-4: gated blocks of 400 ms, 100 ms apart."""
    y = lfilter(RLB_B, RLB_A, lfilter(PRE_B, PRE_A, np.asarray(x, dtype=np.float64)))
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(y[i:i + blk] ** 2) for i in range(0, y.size - blk + 1, hop)])
    with np.errstate(divide="ignore"):
        lj = -0.691 + 10 * np.log10(z)
    z1 = z[lj > -70.0]
    gate = -0.691 + 10 * np.log10(z1.mean()) - 10.0
    z2 = z[lj > gate]
    return -0.691 + 10 * np.log10(z2.mean())


class LoudnessAgainstTheStandard(unittest.TestCase):
    def test_the_reference_gives_the_anchor_of_the_standard(self):
        # a full-scale 997 Hz sine on one channel reads -3.01 LKFS (BS.1770-4, annex)
        self.assertAlmostEqual(ref_lufs(tone(997, 1.0, 4.0)), -3.01, delta=0.02)

    def test_k_weighting_matters_100_hz_against_1_khz(self):
        low = measure.analyse(col(tone(100, 0.5, 4.0)), SR)["lufs"]
        mid = measure.analyse(col(tone(1000, 0.5, 4.0)), SR)["lufs"]
        want = k_gain_db(100) - k_gain_db(1000)  # equal amplitude: only the weighting makes the difference
        self.assertLess(want, -1.5)              # the published filter is 1.8 dB down at 100 Hz
        self.assertAlmostEqual(low - mid, want, delta=0.05)
        self.assertAlmostEqual(low, ref_lufs(tone(100, 0.5, 4.0)), delta=0.1)
        self.assertAlmostEqual(mid, ref_lufs(tone(1000, 0.5, 4.0)), delta=0.1)

    def test_k_weighting_at_50_hz(self):
        want = -0.691 + 10 * np.log10(0.5 * 10 ** (k_gain_db(50) / 10))  # amplitude 1.0: mean square 0.5
        self.assertAlmostEqual(measure.analyse(col(tone(50, 1.0, 4.0)), SR)["lufs"], want, delta=0.1)

    def test_gating_matters_two_bursts_with_silence_between_them(self):
        burst = tone(1000, 0.5, 0.5)
        silent = np.concatenate([burst, np.zeros(3 * SR), burst])
        joined = np.concatenate([burst, burst])
        with_silence = measure.analyse(col(silent), SR)["lufs"]
        without = measure.analyse(col(joined), SR)["lufs"]
        self.assertAlmostEqual(with_silence, ref_lufs(silent), delta=0.1)
        self.assertAlmostEqual(without, ref_lufs(joined), delta=0.1)
        # the gate drops the blocks of silence, so the silence between the bursts moves the reading by under 2 dB
        # (the blocks that hold part of a burst still count) ... 
        self.assertLess(abs(with_silence - without), 2.0)
        # ... where a mean over all blocks (1 s of tone in 4 s) would read about 6 dB lower
        self.assertGreater(with_silence, without - 2.0)

    def test_a_tone_in_a_long_silence_is_gated_to_the_tone(self):
        # 1 s of tone in 5 s: by the standard the blocks that hold part of the tone count, the silent ones do not
        x = np.concatenate([tone(1000, 0.5, 1.0), np.zeros(4 * SR)])
        self.assertAlmostEqual(measure.analyse(col(x), SR)["lufs"], ref_lufs(x), delta=0.1)

    def test_a_silent_file_has_no_loudness(self):
        r = measure.analyse(np.zeros((SR, 1)), SR)
        self.assertIsNone(r["lufs"])
        self.assertEqual(r["lufsNote"], "silent or fully gated")

    def test_two_channels_are_the_file_and_the_mono_sum_is_separate(self):
        left = tone(1000, 0.5, 2.0)
        r = measure.analyse(np.stack([left, left], axis=1), SR)
        # two equal channels add 3.01 dB to one channel; their mono sum is the one channel
        self.assertAlmostEqual(r["lufs"] - r["lufsMono"], 3.01, delta=0.05)
        self.assertAlmostEqual(r["lufsMono"], ref_lufs(left), delta=0.1)

    def test_stereo_file_and_a_short_clip_read_the_values_of_the_standard(self):
        # a 0.1 s clip of two tones is repeated to one 400 ms block (documented in loudness_lufs)
        x = np.stack([tone(300, 1.0, 0.1), tone(600, 1.0, 0.1)], axis=1)
        r = measure.analyse(x, SR)
        self.assertEqual(r["channels"], 2)
        self.assertEqual(r["lufsNote"], "clip shorter than 400 ms was repeated to one block")
        tiled = np.tile(x, (4, 1))  # exactly 0.4 s: one block
        y = [lfilter(RLB_B, RLB_A, lfilter(PRE_B, PRE_A, tiled[:, c])) for c in range(2)]
        want = -0.691 + 10 * np.log10(sum(np.mean(c ** 2) for c in y))
        self.assertAlmostEqual(r["lufs"], want, delta=0.1)


class TruePeak(unittest.TestCase):
    def test_true_peak_3_dB_above_the_sample_peak(self):
        # fs/4 with 45 degrees: every sample is at +-0.707 of the real crest, so the real peak is 3.01 dB higher
        x = col(faded(tone(SR / 4, 1.0, 1.0, phase=np.pi / 4)))
        r = measure.analyse(x, SR)
        self.assertAlmostEqual(r["samplePeakDb"], -3.01, delta=0.05)
        self.assertAlmostEqual(r["truePeakDb"] - r["samplePeakDb"], 3.01, delta=0.1)
        self.assertAlmostEqual(r["truePeakDb"], 0.0, delta=0.1)

    def test_true_peak_needs_four_times_oversampling(self):
        # 16 kHz, phase 0: three samples per cycle at 0 and +-0.866 of a crest that lies between them
        # (sample peak -1.25 dB). A 2x oversampling puts its points 60 degrees apart and still misses the crest.
        x = col(faded(tone(16000, 1.0, 0.5)))
        r = measure.analyse(x, SR)
        self.assertLess(r["samplePeakDb"], -1.0)
        self.assertAlmostEqual(r["truePeakDb"], 0.0, delta=0.15)

    def test_true_peak_of_a_slow_sine_is_its_amplitude(self):
        r = measure.analyse(col(faded(tone(200, 10 ** (-6 / 20), 1.0))), SR)
        self.assertAlmostEqual(r["truePeakDb"], -6.0, delta=0.05)


class BandEdges(unittest.TestCase):
    """One test per edge of BAND_EDGES: a tone a fifth below an edge belongs to the band below it, a tone a
    fifth above to the band above, and the two shares given to the rules (lowShare below 500 Hz,
    highShare above 4 kHz) follow the same edges."""

    EDGES = [(60, "<60", "60-125"), (125, "60-125", "125-250"), (250, "125-250", "250-500"),
             (500, "250-500", "500-1k"), (1000, "500-1k", "1k-2k"), (2000, "1k-2k", "2k-4k"),
             (4000, "2k-4k", "4k-8k"), (8000, "4k-8k", ">8k")]

    def _bands(self, f):
        return measure.analyse(col(tone(f, 0.3, 2.0)), SR)["bands"]

    def test_the_edges_are_as_specified(self):
        self.assertEqual(measure.BAND_EDGES, [0, 60, 125, 250, 500, 1000, 2000, 4000, 8000, None])
        self.assertEqual(measure.BAND_NAMES, ["<60", "60-125", "125-250", "250-500", "500-1k", "1k-2k", "2k-4k", "4k-8k", ">8k"])

    def test_every_edge(self):
        for edge, below, above in self.EDGES:
            under = self._bands(edge * 0.8)
            over = self._bands(edge * 1.25)
            self.assertGreater(under[below], 0.9, (edge, under))
            self.assertGreater(over[above], 0.9, (edge, over))
            self.assertAlmostEqual(sum(under.values()), 1.0, delta=0.01)

    def test_low_share_is_the_four_bands_below_500_hz(self):
        for f in (40, 100, 200, 400):
            self.assertGreater(measure.analyse(col(tone(f, 0.3, 2.0)), SR)["lowShare"], 0.98, f)
        for f in (600, 1500, 6000):
            self.assertLess(measure.analyse(col(tone(f, 0.3, 2.0)), SR)["lowShare"], 0.02, f)

    def test_high_share_is_everything_above_4_khz(self):
        for f in (3200, 1000, 100):
            self.assertLess(measure.analyse(col(tone(f, 0.3, 2.0)), SR)["highShare"], 0.02, f)
        for f in (5000, 7000, 10000):
            self.assertGreater(measure.analyse(col(tone(f, 0.3, 2.0)), SR)["highShare"], 0.98, f)

    def test_the_shares_of_a_mix_add_up(self):
        x = tone(100, 0.3, 2.0) + tone(300, 0.3, 2.0) + tone(6000, 0.3, 2.0)
        r = measure.analyse(col(x), SR)
        self.assertAlmostEqual(r["lowShare"], 2 / 3, delta=0.02)
        self.assertAlmostEqual(r["highShare"], 1 / 3, delta=0.02)
        self.assertAlmostEqual(sum(r["bands"].values()), 1.0, delta=0.01)


class Clipping(unittest.TestCase):
    def test_clipping_of_a_16_bit_file_is_found_on_the_positive_side_too(self):
        import soundfile as sf

        x = col(np.clip(tone(440, 1.5, 1.0), -0.5, 1.0))  # only the positive side is clipped: +32767 reads 0.99997
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.wav"
            sf.write(str(p), x, SR, subtype="PCM_16")
            data, sr = common.load_audio(p)
        self.assertGreater(measure.analyse(data, sr)["clippedSamples"], 100)

    def test_a_sine_just_under_full_scale_is_not_clipped(self):
        self.assertEqual(measure.analyse(col(tone(440, 0.98, 1.0)), SR)["clippedSamples"], 0)


class DcOffset(unittest.TestCase):
    def test_negative_and_positive_offsets_are_both_found(self):
        for dc in (0.02, -0.02):
            self.assertAlmostEqual(measure.analyse(col(tone(500, 0.3, 1.0) + dc), SR)["dcOffset"], 0.02, delta=1e-4)

    def test_the_worse_channel_is_reported(self):
        x = np.stack([tone(500, 0.3, 1.0) + 0.001, tone(700, 0.3, 1.0) - 0.03], axis=1)
        self.assertAlmostEqual(measure.analyse(x, SR)["dcOffset"], 0.03, delta=1e-4)


class PeakShare(unittest.TestCase):
    def test_a_tone_between_two_bins_holds_most_of_the_energy(self):
        self.assertGreater(measure.analyse(col(tone(1234.5, 0.3, 2.0)), SR)["peakShare"], 0.95)

    def test_noise_holds_a_few_per_cent(self):
        noise = np.random.default_rng(1).standard_normal(2 * SR) * 0.1
        self.assertLess(measure.analyse(col(noise), SR)["peakShare"], 0.05)


class StereoStats(unittest.TestCase):
    def test_level_difference_is_in_decibels(self):
        rng = np.random.default_rng(6)
        y = np.stack([rng.standard_normal(SR) * 0.1, rng.standard_normal(SR) * 0.05], axis=1)
        self.assertAlmostEqual(measure.stereo_stats(y, SR)["levelDiffDb"], 6.02, delta=0.15)

    def test_independent_channels_and_equal_channels(self):
        rng = np.random.default_rng(8)
        a, b = rng.standard_normal(SR) * 0.1, rng.standard_normal(SR) * 0.1
        indep = measure.stereo_stats(np.stack([a, b], axis=1), SR)
        self.assertLess(abs(indep["corr"]), 0.05)
        same = measure.stereo_stats(np.stack([a, a], axis=1), SR)
        self.assertAlmostEqual(same["corr"], 1.0, places=4)
        self.assertAlmostEqual(same["levelDiffDb"], 0.0, places=3)
        self.assertAlmostEqual(same["monoRmsDb"], 20 * np.log10(np.sqrt(np.mean(a ** 2))), delta=0.02)

    def test_a_silent_channel_is_not_equal_to_the_other(self):
        """R2: left has sound, right is exact zeros (a hard-panned file). The file read as corr 1.0 and 0.0 dB."""
        rng = np.random.default_rng(9)
        y = np.stack([rng.standard_normal(SR) * 0.1, np.zeros(SR)], axis=1)
        st = measure.stereo_stats(y, SR)
        self.assertEqual(st["corr"], 0.0)
        self.assertEqual(st["corrLow"], 0.0)
        self.assertGreater(st["levelDiffDb"], 90.0)  # the quiet channel is at the floor of -120 dB
        r = measure.stereo_stats(y[:, ::-1], SR)       # and the same the other way round
        self.assertEqual((r["corr"], r["corrLow"]), (0.0, 0.0))
        self.assertGreater(r["levelDiffDb"], 90.0)

    def test_two_silent_channels_are_not_a_stereo_pair(self):
        st = measure.stereo_stats(np.zeros((SR, 2)), SR)
        self.assertEqual((st["corr"], st["corrLow"], st["levelDiffDb"]), (0.0, 0.0, 0.0))
        self.assertEqual(st["monoRmsDb"], measure.FLOOR_DB)

    def test_one_dither_lsb_in_one_channel_is_still_a_difference(self):
        rng = np.random.default_rng(10)
        y = np.stack([rng.standard_normal(SR) * 0.1, rng.integers(-1, 2, SR) / 32768.0], axis=1)
        st = measure.stereo_stats(y, SR)
        self.assertGreater(st["levelDiffDb"], 60.0)
        self.assertLess(abs(st["corr"]), 0.05)


class LoopSwing(unittest.TestCase):
    @staticmethod
    def _noise(seconds, seed=7):
        return np.random.default_rng(seed).standard_normal(int(seconds * SR)) * 0.1

    @staticmethod
    def _tapered(x, ms=5.0):
        k = int(ms / 1000 * SR)
        w = np.ones(x.size)
        w[:k] = np.linspace(0, 1, k)
        w[-k:] = np.linspace(1, 0, k)
        return x * w

    def test_a_loop_that_falls_silent_has_a_big_swing(self):
        """R1: noise 0.5 s, digital silence 1.0 s, noise 0.5 s. The silent windows were dropped and it read 3.5 dB."""
        a = self._tapered(self._noise(0.5) )
        gap = col(np.concatenate([a, np.zeros(SR), a]))
        loop = measure.analyse(gap, SR, loop=True)["loop"]
        self.assertGreater(loop["levelSwingDb"], 90.0)  # loudest window about -20 dB, silent ones at -120 dB

    def test_a_pulse_loop_reads_the_same_wherever_its_edges_fall_on_the_window_grid(self):
        pulse = self._tapered(self._noise(0.5, seed=3), 20.0)
        swings = []
        for shift_ms in (0, 13, 25, 37):
            loop = np.concatenate([pulse, np.zeros(int(0.5 * SR))])
            swings.append(measure.analyse(col(np.roll(loop, int(shift_ms / 1000 * SR))), SR, loop=True)["loop"]["levelSwingDb"])
        self.assertGreater(min(swings), 90.0, swings)

    def test_a_steady_loop_has_a_small_swing_and_the_number_is_unchanged(self):
        n = 2 * SR
        t = np.arange(n) / SR
        swung = col(np.random.default_rng(7).standard_normal(n) * 0.1 * (0.5 + 0.45 * np.sin(2 * np.pi * 1.0 * t)))
        self.assertEqual(measure.analyse(swung, SR, loop=True)["loop"]["levelSwingDb"], 24.4)  # same as before the repair
        steady = measure.analyse(col(self._noise(2.0)), SR, loop=True)["loop"]["levelSwingDb"]
        self.assertLess(steady, 2.0)

    def test_a_quiet_bed_above_the_floor_is_still_read_as_it_is(self):
        tone_part = tone(1000, 0.3, 1.0)
        bed = tone(1000, 0.3 * 10 ** (-60 / 20), 1.0)  # 60 dB down: no window of it is silent
        x = col(np.concatenate([tone_part, bed]))
        self.assertAlmostEqual(measure.analyse(x, SR, loop=True)["loop"]["levelSwingDb"], 60.0, delta=0.5)

    def test_the_edge_level_limit_is_3_db(self):
        x = self._noise(1.0, seed=2)
        x[-int(0.05 * SR):] *= 0.3  # the last 50 ms about 10.5 dB quieter than the first
        loop = measure.analyse(col(x), SR, loop=True)["loop"]
        self.assertAlmostEqual(loop["edgeLevelDiffDb"], 10.5, delta=1.0)
        self.assertFalse(loop["edgeOk"])
        y = self._noise(1.0, seed=2)
        y[-int(0.05 * SR):] *= 0.8  # 1.9 dB: inside the limit
        self.assertTrue(measure.analyse(col(y), SR, loop=True)["loop"]["edgeOk"])

    def test_the_seam_yardstick_is_the_99th_percentile_step(self):
        x = self._noise(1.0, seed=4)
        x[-1] = x[0] + 3.0 * np.percentile(np.abs(np.diff(x)), 99)  # a step across the wrap of 3 ordinary steps
        self.assertFalse(measure.analyse(col(x), SR, loop=True)["loop"]["seamOk"])
        self.assertTrue(measure.analyse(col(self._noise(1.0, seed=4)), SR, loop=True)["loop"]["seamOk"])


class SeamYardstick(unittest.TestCase):
    def test_a_steep_run_through_the_wrap_is_a_step_even_where_the_slope_does_not_bend(self):
        # four samples on one steep line across the wrap: the second difference at the wrap is 0, the step across it is
        # 1.0 against an ordinary step (99th percentile) of 0.36, so only the step term and the percentile see it
        x = np.random.default_rng(4).standard_normal(SR) * 0.1
        x[-2], x[-1], x[0], x[1] = 2.0, 1.0, 0.0, -1.0
        loop = measure.analyse(col(x), SR, loop=True)["loop"]
        self.assertLess(loop["kinkRatio"], 0.01)
        self.assertGreater(loop["stepRatio"], 2.0)
        self.assertFalse(loop["seamOk"])
        quiet = np.random.default_rng(4).standard_normal(SR) * 0.1
        self.assertTrue(measure.analyse(col(quiet), SR, loop=True)["loop"]["seamOk"])


class ManyChannels(unittest.TestCase):
    def test_a_file_of_more_than_five_channels_is_measured_on_its_first_five(self):
        one = tone(1000, 0.5, 2.0)
        six = np.stack([one] * 5 + [one * 4.0], axis=1)      # the sixth channel is 12 dB louder and is left out
        y = lfilter(RLB_B, RLB_A, lfilter(PRE_B, PRE_A, one))
        want = -0.691 + 10 * np.log10((1.0 + 1.0 + 1.0 + 1.41 + 1.41) * np.mean(y ** 2))  # BS.1770 channel weights
        self.assertAlmostEqual(measure.loudness_lufs(six, SR)[0], want, delta=0.1)


class WholeFile(unittest.TestCase):
    """R5: the spectrum reads every sample, also the end, the start and what follows the last full segment."""

    N = 20000  # not a multiple of the 8192-sample segments

    def _impulse_power(self, pos):
        x = np.zeros((self.N, 1))
        x[pos, 0] = 1.0
        f, p = measure.mean_psd(x, SR)
        return float(p.sum())

    def test_an_impulse_counts_the_same_at_the_start_in_the_middle_and_at_the_end(self):
        first, mid, last = (self._impulse_power(i) for i in (0, self.N // 2, self.N - 1))
        self.assertGreater(first, 0.0)
        for v in (first, last):
            self.assertAlmostEqual(v / mid, 1.0, delta=0.02, msg=(first, mid, last))

    def test_a_noise_burst_at_the_end_is_read_like_one_at_the_start(self):
        rng = np.random.default_rng(11)
        x = tone(200, 0.3, 12000 / SR)
        x[8000:] += rng.standard_normal(4000) * 0.4
        a = measure.analyse(col(x), SR)
        b = measure.analyse(col(x[::-1].copy()), SR)
        spec = np.abs(np.fft.rfft(x - x.mean())) ** 2
        f = np.fft.rfftfreq(x.size, 1 / SR)
        whole_high = spec[f >= 4000].sum() / spec.sum()
        self.assertGreater(whole_high, 0.3)
        self.assertAlmostEqual(a["highShare"], whole_high, delta=0.08)
        self.assertAlmostEqual(a["highShare"], b["highShare"], delta=0.03)
        self.assertAlmostEqual(a["lowShare"], b["lowShare"], delta=0.03)
        self.assertAlmostEqual(a["spectralCentroidHz"], b["spectralCentroidHz"], delta=0.05 * b["spectralCentroidHz"])

    def test_the_tail_after_the_last_full_segment_counts(self):
        x = tone(100, 0.3, 10000 / SR)  # 8192 + 1808
        x[-1500:] = np.random.default_rng(12).standard_normal(1500) * 0.3  # noise only in the tail
        r = measure.analyse(col(x), SR)
        self.assertGreater(r["highShare"], 0.2)

    def test_a_steady_tone_is_unchanged_by_the_padding(self):
        r = measure.analyse(col(tone(100, 0.3, 2.0)), SR)
        self.assertGreater(r["bands"]["60-125"], 0.99)
        self.assertGreater(r["peakShare"], 0.9)
        self.assertAlmostEqual(r["spectralCentroidHz"], 100.0, delta=2.0)

    def test_a_slow_drift_is_not_removed_segment_by_segment(self):
        """Second review: the mean is taken off once, from the whole file. Taking it off again in every Welch
        segment (detrend="constant") treats the zero padding at both ends as signal and moved this file's
        highShare from 0.044 to 0.095 and its centroid from 636 to 1364 Hz. The whole-file FFT is the answer."""
        n = 12000
        x = 0.3 * np.sin(2 * np.pi * 4 * np.arange(n) / SR)   # 4 Hz: under the first bin of a segment
        x[-3000:] += np.random.default_rng(3).standard_normal(3000) * 0.1
        r = measure.analyse(col(x), SR)
        spec = np.abs(np.fft.rfft(x - x.mean())) ** 2
        f = np.fft.rfftfreq(n, 1 / SR)
        self.assertAlmostEqual(r["lowShare"], spec[f < 500].sum() / spec.sum(), delta=0.01)
        self.assertAlmostEqual(r["highShare"], spec[f >= 4000].sum() / spec.sum(), delta=0.01)
        self.assertAlmostEqual(r["spectralCentroidHz"], (f * spec).sum() / spec.sum(), delta=40.0)

    def test_a_short_file_is_read_whole(self):
        x = np.zeros(3000)
        x[-1] = 1.0
        x[0] = -1.0
        f, p = measure.mean_psd(col(x), SR)
        self.assertGreater(p.sum(), 0.0)


class EmptyAndTiny(unittest.TestCase):
    """R6: an empty file or one sample gives a clear error or a defined value, not an unrelated crash."""

    def test_an_empty_file_is_refused_with_a_clear_message(self):
        with self.assertRaises(ValueError) as cm:
            measure.analyse(np.zeros((0, 1)), SR)
        self.assertIn("empty", str(cm.exception))
        with self.assertRaises(ValueError) as cm:
            measure.loudness_lufs(np.zeros((0, 2)), SR)
        self.assertIn("empty", str(cm.exception))

    def test_an_empty_wav_through_the_command_line_names_the_problem(self):
        import contextlib
        import io

        import soundfile as sf

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "nothing_in_it.wav"
            sf.write(str(p), np.zeros((0, 1), np.float32), SR)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = measure.main([str(p), "--json"])
        self.assertEqual(rc, 1)
        self.assertIn("ValueError: empty file: there are no samples to measure", buf.getvalue())  # the message, not the path
        self.assertNotIn("ZeroDivisionError", buf.getvalue())

    def test_the_helpers_refuse_an_empty_array_with_the_same_clear_message(self):
        """Second review: stereo_stats and true_peak, called by themselves, gave ZeroDivisionError and numpy's
        'zero-size array to reduction operation maximum' for an empty array."""
        for fn, arg in ((measure.stereo_stats, np.zeros((0, 2))), (measure.true_peak, np.zeros((0, 1))),
                        (measure.true_peak, np.zeros((0, 2)))):
            with self.assertRaises(ValueError) as cm:
                if fn is measure.stereo_stats:
                    fn(arg, SR)
                else:
                    fn(arg)
            self.assertIn("empty file", str(cm.exception), fn.__name__)

    def test_stereo_stats_of_a_one_channel_array_is_still_empty_of_numbers(self):
        self.assertEqual(measure.stereo_stats(np.zeros((SR, 1)), SR), {})
        self.assertEqual(measure.stereo_stats(np.zeros((0, 1)), SR), {})

    def test_one_sample_gives_defined_values(self):
        for v in (0.5, 0.0):
            for loop in (False, True):
                r = measure.analyse(np.array([[v]]), SR, loop=loop)
                self.assertEqual((r["channels"], r["durationS"]), (1, round(1 / SR, 4)))
                self.assertIsNone(r["spectralCentroidHz"])
                self.assertEqual((r["lowShare"], r["highShare"], r["peakShare"]), (0.0, 0.0, 0.0))
                self.assertEqual(r["peaks"], [])
                self.assertIsNone(r["fundamentalHz"])
                self.assertAlmostEqual(r["samplePeakDb"], 20 * np.log10(v) if v else measure.FLOOR_DB, delta=0.01)
                if loop:
                    self.assertIn("error", r["loop"])

    def test_one_stereo_sample_gives_defined_values(self):
        r = measure.analyse(np.array([[0.5, 0.25]]), SR)
        self.assertEqual(r["channels"], 2)
        self.assertEqual(r["stereo"]["corr"], 0.0)

    def test_a_few_samples_work(self):
        for n in (2, 3, 4, 5, 7):
            r = measure.analyse(np.random.default_rng(n).standard_normal((n, 1)) * 0.1, SR, loop=True)
            self.assertEqual(r["channels"], 1)


class NumbersThatNoRuleReadsYet(unittest.TestCase):
    """Constants of the report (onset, attack, last 10 ms, rms, peaks, loop edge window): printed for the owner,
    each with a signal whose right answer is known."""

    def test_the_loop_edge_is_compared_over_50_ms(self):
        x = np.random.default_rng(2).standard_normal(SR) * 0.1
        x[-int(0.050 * SR):-int(0.010 * SR)] *= 0.3     # 40 of the last 50 ms are 10.5 dB down, the last 10 ms are not
        loop = measure.analyse(col(x), SR, loop=True)["loop"]
        self.assertAlmostEqual(loop["edgeLevelDiffDb"], 10 * np.log10(1.0 / ((40 * 0.09 + 10) / 50)), delta=1.0)  # 5.6 dB
        self.assertFalse(loop["edgeOk"])

    def test_the_last_ten_ms_are_the_last_ten_ms(self):
        x = tone(1000, 0.5, 0.5)
        x[-int(0.012 * SR):] = 0.0
        self.assertLess(measure.analyse(col(x), SR)["envelope"]["lastTenMsDb"], -100.0)  # a window of 100 ms would read -9 dB
        y = tone(1000, 0.5, 0.5)
        self.assertAlmostEqual(measure.analyse(col(y), SR)["envelope"]["lastTenMsDb"], -9.0, delta=0.2)  # rms of a sine of 0.5

    def test_onset_is_where_the_sound_gets_within_40_db_of_its_peak(self):
        x = np.zeros(SR // 2)
        x[int(0.010 * SR):int(0.030 * SR)] = tone(1000, 0.03, 0.020)      # -30 dB under the peak
        x[int(0.030 * SR):int(0.300 * SR)] = tone(1000, 1.0, 0.270)
        self.assertAlmostEqual(measure.analyse(col(x), SR)["envelope"]["onsetMs"], 10.0, delta=0.5)

    def test_onset_has_a_floor_of_minus_70_dbfs(self):
        x = np.zeros(SR // 2)
        x[int(0.0005 * SR):int(0.020 * SR)] = tone(1000, 10 ** (-72 / 20), 0.0195)   # -72 dBFS: under the floor
        x[int(0.020 * SR):int(0.300 * SR)] = tone(1000, 10 ** (-50 / 20), 0.280)     # the peak, -50 dBFS
        # -40 dB under the peak is -90 dBFS, the floor of -70 dBFS holds: the onset is where -50 dBFS starts
        self.assertAlmostEqual(measure.analyse(col(x), SR)["envelope"]["onsetMs"], 20.0, delta=0.5)

    def test_attack_is_the_time_from_10_to_90_per_cent_of_the_peak(self):
        x = np.zeros(SR // 2)
        x[:int(0.020 * SR)] = np.linspace(0, 1, int(0.020 * SR)) * tone(2000, 1.0, 0.020)  # a linear ramp of 20 ms
        x[int(0.020 * SR):] = tone(2000, 1.0, 0.5 - 0.020)
        self.assertAlmostEqual(measure.analyse(col(x), SR)["envelope"]["attackMs"], 16.0, delta=1.5)  # 0.8 of 20 ms

    def test_peaks_are_interpolated_between_the_bins(self):
        r = measure.analyse(col(tone(1234.5, 0.3, 2.0)), SR)
        self.assertAlmostEqual(r["peaks"][0]["hz"], 1234.5, delta=0.6)   # the bins are 5.9 Hz apart
        self.assertAlmostEqual(r["fundamentalHz"], 1234.5, delta=0.6)

    def test_rms_and_crest_of_a_sine(self):
        r = measure.analyse(col(tone(1000, 0.5, 1.0)), SR)
        self.assertAlmostEqual(r["rmsDb"], -9.03, delta=0.02)
        self.assertAlmostEqual(r["crestDb"], 3.01, delta=0.02)

    def test_the_spectrum_is_the_average_of_the_channels(self):
        both = np.stack([tone(100, 0.3, 2.0), tone(3000, 0.3, 2.0)], axis=1)
        f, p = measure.mean_psd(both, SR)
        low, high = p[f < 500].sum(), p[f >= 2000].sum()
        self.assertAlmostEqual(low / (low + high), 0.5, delta=0.02)


class OutputUnchangedWhereItWasRight(unittest.TestCase):
    def test_png_is_a_picture_of_the_documented_size(self):
        import matplotlib.image as mpimg

        x = col(tone(1000, 0.5, 0.5))
        r = measure.analyse(x, SR)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.png"
            measure.write_png(p, "x.wav", x, SR, r)
            img = mpimg.imread(str(p))
        self.assertEqual(img.shape[:2], (600, 1000))  # figsize 10 x 6 inches at 100 dpi
        text = measure.format_text("x.wav", r)
        self.assertIn("LUFS %s" % r["lufs"], text)
        self.assertIn("true peak %s dBFS" % r["truePeakDb"], text)

    def test_two_rhythms_have_the_number_of_beeps_they_have(self):
        def beeps(period_s):
            x = np.zeros(2 * SR)
            for start in np.arange(0, 2.0, period_s):
                i = int(start * SR)
                x[i:i + int(0.1 * SR)] = tone(900, 0.5, 0.1)
            return col(x)

        def runs(s):
            return len([r for r in s.replace(".", " ").split(" ") if r])

        self.assertEqual(runs(measure.analyse(beeps(0.25), SR)["envelope"]["printed"]), 8)
        self.assertEqual(runs(measure.analyse(beeps(0.5), SR)["envelope"]["printed"]), 4)


if __name__ == "__main__":
    unittest.main()
