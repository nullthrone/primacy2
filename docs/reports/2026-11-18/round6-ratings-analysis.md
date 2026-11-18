# Analysis of the ratings of round 6 (rated 2026-11-18)

Made by `tools/sound/compare.py --analysis`; the data is in `round6-ratings-analysis.json` (same folder). Every number below is a measurement on the raw cut of a candidate (before any gain) or a count from a script. Nobody listened; nothing here says how anything sounds. Ratings read: `assets/audio/ratings.json` as saved at 2026-11-18T14:40:34.900Z (SHA-256 28ba828550516814).

47 rated candidates: round 4 16, round 5 17, round 6 14; round 6 is 4 fits, 2 close, 8 wrong. All raw files were found with the SHA-256 of their record: True.

Columns: loud50 = loudest 50 ms, dBFS; a2k = share of energy above 2 kHz in the loud frames; a60 = share above 60 Hz; u250 = share under 250 Hz; a4k = share above 4 kHz; centroid in Hz; crest = peak over RMS, dB; peak dBFS; len = length of the cut, s; active = s until the last 4 ms frame within 40 dB of the loudest; tail = level of the last 50 ms in dB under the loudest 50 ms; LUFS = the level it was played at (family target).

## 2. The reference table

### hull

| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| src_1_hull_1_moss_p1s16 | 4 | fits |  | -7.76 | 0.026 | 0.323 | 0.780 | 0.008 | 308 | 16.65 | -0.01 | 2.500 | 2.414 | -44.52 | -34 |
| src_1_hull_2_sa3_p2s11 | 4 | fits |  | -7.79 | 0.008 | 0.909 | 0.778 | 0.002 | 244 | 19.30 | 1.17 | 2.500 | 2.499 | -39.45 | -34 |
| src_1_hull_3_oga_sfx2-metal-hit-01 | 4 | wrong |  | -14.55 | 0.290 | 0.998 | 0.465 | 0.150 | 1647 | 24.02 | -0.62 | 0.745 | 0.615 | -51.80 | -34 |
| src_1_hull_4_sa3_p1s13 | 4 | fits |  | -7.65 | 0.013 | 0.964 | 0.825 | 0.005 | 283 | 16.71 | 0.57 | 1.723 | 1.549 | -46.13 | -34 |
| ev5_1_hull_light_1_moss_p2s15 | 5 | fits |  | -6.41 | 0.254 | 0.998 | 0.043 | 0.023 | 1408 | 14.86 | -0.00 | 0.644 | 0.554 | -43.31 | -34 |
| ev5_1_hull_light_2_moss_p1s11 | 5 | close | klingt als ob es mehrere kurze Töne hintereinander wären, wie ein Echo ohne doppler effekt. Ansonsten ok | -12.48 | 0.870 | 1.000 | 0.000 | 0.262 | 3655 | 17.89 | -0.04 | 0.433 | 0.419 | -33.75 | -34 |
| ev5_2_hull_heavy_1_moss_p2s16 | 5 | fits |  | -3.44 | 0.017 | 0.634 | 0.821 | 0.003 | 227 | 10.76 | -0.00 | 3.772 | 3.532 | -48.96 | -34 |
| ev5_2_hull_heavy_2_moss_p1s14 | 5 | fits |  | -3.57 | 0.003 | 0.288 | 0.924 | 0.000 | 88 | 12.62 | -0.00 | 3.801 | 3.753 | -47.28 | -34 |
| ev6_1_hull_light_1_moss_p1s22 | 6 | fits | ist ok, schauen wir mal wie es weiterhin wird | -8.51 | 0.671 | 1.000 | 0.012 | 0.158 | 2766 | 15.21 | -0.01 | 0.467 | 0.415 | -41.53 | -34 |
| ev6_1_hull_light_2_moss_p1s21 | 6 | wrong |  | -10.98 | 0.859 | 0.949 | 0.132 | 0.106 | 2929 | 17.63 | -0.01 | 0.651 | 0.575 | -41.80 | -34 |

### thruster

| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| src_2_thruster_1_moss_p2s11 | 4 | close | Grundidee passt, es muss aber doller, knalliger klingen | -14.82 | 0.145 | 0.981 | 0.060 | 0.087 | 1508 | 24.15 | -0.01 | 0.486 | 0.403 | -38.97 | -34 |
| src_2_thruster_2_sa3_p2s12 | 4 | close | Grundidee passt, es muss aber doller, knalliger klingen. Aktuell klingt es eher "hauchig" | -9.21 | 0.208 | 0.990 | 0.254 | 0.134 | 1726 | 18.60 | 3.58 | 0.971 | 0.943 | -37.22 | -34 |
| src_2_thruster_3_oga_steam-hiss-3 | 4 | fits |  | -24.55 | 0.965 | 1.000 | 0.000 | 0.839 | 11825 | 18.18 | -12.61 | 0.920 | 0.851 | -57.39 | -34 |
| src_2_thruster_4_moss_p1s11 | 4 | fits |  | -15.21 | 0.975 | 0.993 | 0.017 | 0.917 | 10872 | 13.02 | -5.21 | 0.403 | 0.389 | -30.28 | -34 |
| ev5_3_thruster_valve_1_moss_r4p1s12 | 5 | fits |  | -25.43 | 0.969 | 0.978 | 0.023 | 0.972 | 12991 | 13.07 | -13.60 | 1.004 | 1.003 | -12.66 | -34 |
| ev5_3_thruster_valve_2_moss_r4p1s15 | 5 | fits |  | -17.54 | 0.974 | 1.000 | 0.002 | 0.936 | 9897 | 14.21 | -4.94 | 0.787 | 0.753 | -41.07 | -34 |
| ev5_4_thruster_bang_1_moss_p2s11 | 5 | wrong | klingt wie eine kleine Gaspistole, nicht wie eine mächtige Gatling Gun | -13.26 | 0.132 | 0.982 | 0.061 | 0.071 | 1380 | 22.56 | -0.01 | 0.487 | 0.403 | -39.17 | -34 |
| ev5_4_thruster_bang_2_moss_p1s11 | 5 | wrong |  | -9.61 | 0.114 | 0.728 | 0.806 | 0.151 | 1736 | 19.55 | -1.06 | 1.203 | 1.203 | -24.88 | -34 |
| ev5_5_thruster_gatling_1_moss_p2s12 | 5 | wrong | klingt wie eine kleine Plastikkanone | -12.08 | 0.234 | 0.828 | 0.474 | 0.121 | 1537 | 15.33 | -0.76 | 1.101 | 1.032 | -43.44 | -34 |
| ev5_5_thruster_gatling_2_moss_p1s11 | 5 | wrong | klingt wie eine kleine Gaspistole, nicht wie eine mächtige Gatling Gun | -11.82 | 0.183 | 0.955 | 0.148 | 0.122 | 1732 | 22.66 | -0.01 | 0.805 | 0.453 | -47.17 | -34 |
| ev6_2_thruster_mighty_1_moss_p1s12 | 6 | wrong |  | -2.65 | 0.010 | 0.486 | 0.910 | 0.003 | 158 | 6.36 | -0.01 | 1.500 | 1.498 | -31.02 | -28 |
| ev6_2_thruster_mighty_2_moss_p3s11 | 6 | close | Es waren nur zwei statt Drei Schüsse wie im Prompt gewünscht. Grundsätzlich gut. Wenn wir noch ein bisschen Raumklang reinbringen, sind wir langsam am Ziel | -4.54 | 0.057 | 0.742 | 0.651 | 0.023 | 493 | 10.67 | -0.00 | 1.503 | 1.503 | -32.92 | -28 |
| ev6_2_thruster_mighty_3_moss_p3s12 | 6 | wrong |  | -5.77 | 0.061 | 0.957 | 0.692 | 0.014 | 484 | 10.74 | -0.00 | 1.500 | 1.500 | -31.69 | -28 |

### gear

| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| src_3_gear_1_moss_p2s12 | 4 | fits |  | -7.96 | 0.096 | 0.999 | 0.477 | 0.037 | 816 | 16.65 | -0.01 | 3.803 | 3.803 | -31.01 | -35 |
| src_3_gear_2_sa3_p3s15 | 4 | fits |  | -11.52 | 0.184 | 0.788 | 0.319 | 0.211 | 2303 | 20.44 | 0.79 | 3.021 | 2.988 | -39.33 | -35 |
| src_3_gear_3_oga_sfx2-lock-open-01 | 4 | wrong |  | -22.74 | 0.960 | 1.000 | 0.005 | 0.836 | 5563 | 28.13 | -1.88 | 0.480 | 0.477 | -23.40 | -35 |
| src_3_gear_4_sa3_p2s15 | 4 | fits |  | -9.75 | 0.036 | 1.000 | 0.530 | 0.044 | 759 | 22.91 | -1.30 | 3.456 | 3.397 | -42.88 | -35 |

### shield

| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| src_4_shield_1_moss_p3s14 | 4 | close | Klingt hochwertiger als die letzten Samples, allerdings klingt es etwas zu bass-lastig. ich würde ein minimales knistern/wummern mit einbauen | -1.42 | 0.002 | 0.254 | 0.962 | 0.001 | 76 | 5.89 | -0.00 | 1.987 | 1.985 | -26.06 | -24 |
| src_4_shield_2_sa3_p3s11 | 4 | fits |  | -8.13 | 0.003 | 0.520 | 0.964 | 0.002 | 96 | 15.59 | -1.27 | 2.139 | 2.126 | -38.97 | -24 |
| src_4_shield_3_oga_tesla-spark | 4 | wrong |  | -22.69 | 0.961 | 1.000 | 0.001 | 0.860 | 6859 | 26.10 | -3.54 | 0.251 | 0.187 | -42.16 | -24 |
| src_4_shield_4_sa3_p2s16 | 4 | fits |  | -8.97 | 0.009 | 0.337 | 0.987 | 0.006 | 134 | 15.01 | -0.77 | 2.284 | 2.266 | -40.15 | -24 |
| ev5_6_shield_bright_1_moss_p1s15 | 5 | wrong | Klingt zu voll und übersteuert, auch zu lang gezogen. Es muss kürzer sein | -4.40 | 0.037 | 0.889 | 0.757 | 0.021 | 441 | 10.87 | -0.00 | 2.500 | 2.500 | -30.79 | -24 |
| ev5_6_shield_bright_2_moss_p2s11 | 5 | wrong | klingt wie ein Knistern eines kaputten Kabels | -22.07 | 0.865 | 0.990 | 0.038 | 0.727 | 7845 | 34.21 | -0.35 | 2.503 | 2.412 | -34.87 | -24 |
| ev5_6_shield_bright_3_moss_p2s14 | 5 | wrong | übersteuert, zu lang, zu viel rauschen | -8.25 | 0.101 | 0.446 | 0.814 | 0.116 | 1178 | 15.30 | -0.01 | 1.711 | 1.535 | -43.41 | -24 |
| ev6_3_shield_tight_1_moss_p1s11 | 6 | wrong |  | -10.94 | 0.042 | 0.888 | 0.771 | 0.028 | 570 | 17.31 | -0.01 | 0.260 | 0.259 | -41.64 | -24 |
| ev6_3_shield_tight_2_moss_p2s11 | 6 | close | Es wird besser, ich würde den Ton vielleicht leicht heller machen als bisher, aber die Idee, dass der Schild ein Projektil oder einen Energiestrahl "verschluckt", und so klingt es hier ein wenig, ist die richtige Richtung | -4.44 | 0.015 | 0.502 | 0.946 | 0.005 | 161 | 12.73 | -0.02 | 0.904 | 0.847 | -44.89 | -24 |
| ev6_3_shield_tight_3_moss_p1s16 | 6 | wrong |  | -12.77 | 0.759 | 0.824 | 0.291 | 0.440 | 4147 | 21.22 | -0.01 | 0.370 | 0.287 | -39.41 | -24 |

### fold jump

| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ev5_7_fold_jump_1_moss_p1s13 | 5 | wrong | zu übersteuert | -6.95 | 0.160 | 0.906 | 0.667 | 0.113 | 1434 | 11.77 | -0.00 | 3.803 | 3.802 | -36.35 | -24 |
| ev5_7_fold_jump_2_moss_p2s14 | 5 | wrong | zu übersteuert | -5.44 | 0.151 | 0.830 | 0.637 | 0.075 | 1144 | 9.53 | -0.00 | 3.803 | 3.803 | -18.68 | -24 |
| ev6_4_fold_jump_1_moss_p1s14 | 6 | fits |  | -9.86 | 0.483 | 0.851 | 0.234 | 0.271 | 3988 | 14.94 | -0.16 | 3.800 | 3.800 | -22.13 | -24 |
| ev6_4_fold_jump_2_moss_p2s15 | 6 | wrong |  | -10.50 | 0.632 | 0.999 | 0.062 | 0.404 | 4486 | 17.58 | -0.04 | 3.800 | 3.800 | -33.94 | -24 |
| ev6_4_fold_jump_3_moss_p2s12 | 6 | wrong |  | -14.71 | 0.804 | 0.999 | 0.069 | 0.669 | 7427 | 18.37 | -2.72 | 3.800 | 3.800 | -33.78 | -24 |

### fold exit

| id | rd | verdict | note | loud50 | a2k | a60 | u250 | a4k | centroid | crest | peak | len | active | tail | LUFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ev5_8_fold_exit_1_moss_p1s15 | 5 | close | zu viel hochtöniges Rauscshen | -10.71 | 0.418 | 0.962 | 0.325 | 0.226 | 3033 | 14.98 | -0.46 | 3.661 | 3.564 | -42.37 | -24 |
| ev5_8_fold_exit_2_moss_p2s15 | 5 | wrong | klingt gehaucht, nach Luft, die es im Vakuum nicht gibt.. | -11.17 | 0.796 | 1.000 | 0.002 | 0.538 | 6444 | 14.75 | -0.04 | 3.800 | 3.797 | -32.73 | -24 |
| ev6_5_fold_exit_1_moss_p3s16 | 6 | wrong |  | -9.72 | 0.131 | 0.999 | 0.348 | 0.051 | 959 | 13.90 | -0.61 | 3.800 | 3.800 | -27.21 | -24 |
| ev6_5_fold_exit_2_moss_p1s13 | 6 | fits |  | -2.92 | 0.002 | 0.430 | 0.967 | 0.001 | 93 | 8.59 | -0.00 | 3.121 | 2.927 | -52.23 | -24 |
| ev6_5_fold_exit_3_moss_p1s16 | 6 | fits |  | -4.04 | 0.002 | 0.368 | 0.913 | 0.000 | 107 | 11.56 | -0.01 | 3.738 | 3.611 | -47.28 | -24 |

## 3. The working rule notSaturatedNoise against round 6

Rule: loudest 50 ms above -9.5 dBFS and share above 2 kHz at least 0.03. Listed: every round-6 candidate over both numbers or within 1.5 dB of the level threshold. 'rule family' says whether the family had the setting in `prompts6.json` (fold_exit, fold_jump, shield_tight).

| id | verdict | loud50 | dB from threshold | a2k | over level | over share | over both | LUFS | rule family |
|---|---|---|---|---|---|---|---|---|---|
| ev6_1_hull_light_1_moss_p1s22 | fits | -8.51 | +0.99 | 0.671 | True | True | True | -34 | False |
| ev6_1_hull_light_2_moss_p1s21 | wrong | -10.98 | -1.48 | 0.859 | False | True | False | -34 | False |
| ev6_2_thruster_mighty_2_moss_p3s11 | close | -4.54 | +4.96 | 0.057 | True | True | True | -28 | False |
| ev6_2_thruster_mighty_3_moss_p3s12 | wrong | -5.77 | +3.73 | 0.061 | True | True | True | -28 | False |
| ev6_3_shield_tight_1_moss_p1s11 | wrong | -10.94 | -1.44 | 0.042 | False | True | False | -24 | True |
| ev6_4_fold_jump_1_moss_p1s14 | fits | -9.86 | -0.36 | 0.483 | False | True | False | -24 | True |
| ev6_4_fold_jump_2_moss_p2s15 | wrong | -10.50 | -1.00 | 0.632 | False | True | False | -24 | True |
| ev6_5_fold_exit_1_moss_p3s16 | wrong | -9.72 | -0.22 | 0.131 | False | True | False | -24 | True |

Counts (script): of 14 round-6 candidates, 3 are over both numbers (fits 1, close 1, wrong 1) and 6 are within 1.5 dB of the level threshold (fits 2, close 0, wrong 4). In the three rule families (9 candidates: fits 3, close 1, wrong 5), 0 are over both numbers.

Rounds 4 to 6 together, over both numbers: 10 candidates (fits 3, close 2, wrong 5): ev5_1_hull_light_1_moss_p2s15 fits (-6.41, 0.254); ev6_1_hull_light_1_moss_p1s22 fits (-8.51, 0.671); src_2_thruster_2_sa3_p2s12 close (-9.21, 0.208); ev6_2_thruster_mighty_2_moss_p3s11 close (-4.54, 0.057); ev6_2_thruster_mighty_3_moss_p3s12 wrong (-5.77, 0.061); src_3_gear_1_moss_p2s12 fits (-7.96, 0.096); ev5_6_shield_bright_1_moss_p1s15 wrong (-4.40, 0.037); ev5_6_shield_bright_3_moss_p2s14 wrong (-8.25, 0.101); ev5_7_fold_jump_1_moss_p1s13 wrong (-6.95, 0.160); ev5_7_fold_jump_2_moss_p2s14 wrong (-5.44, 0.151).

Best the family of rules 'reject when loud50 above t1 and a2k at least t2' can do on these rows, with t1 and t2 fitted to the rows themselves (so optimistic); 'accepted rejected' counts accepted candidates the rule would reject, 'wrong kept' counts wrong candidates it would let through:

| rows | accepted = | n (accepted/rejected) | current rule: accepted rejected / wrong kept | best t1, t2: accepted rejected / wrong kept |
|---|---|---|---|---|
| round6All_fitsVsWrong | fits | 12 (4/8) | 1 / 7 | -15.71, 0.006: 2 / 0 |
| round6All_notWrongVsWrong | fits+close | 14 (6/8) | 2 / 7 | -15.71, 0.006: 4 / 0 |
| round6RuleFamilies_fitsVsWrong | fits | 8 (3/5) | 0 / 5 | -15.71, 0.022: 1 / 0 |
| rounds456All_fitsVsWrong | fits | 40 (19/21) | 3 / 16 | -23.64, 0.036: 7 / 1 |
| rounds456All_notWrongVsWrong | fits+close | 47 (26/21) | 5 / 16 | -23.64, 0.036: 12 / 1 |

Single measure, fits against wrong, per event (does one threshold separate them?): hull: loud50Db fits all over wrong; thruster: loud50Db fits all under wrong, above2kHzLoud fits all over wrong, under250Hz fits all under wrong, above4kHz fits all over wrong, centroidHz fits all over wrong, peakDb fits all under wrong; gear: loud50Db fits all over wrong, above2kHzLoud fits all under wrong, above60Hz fits all under wrong, under250Hz fits all over wrong, above4kHz fits all under wrong, centroidHz fits all under wrong, crestDb fits all under wrong, peakDb fits all over wrong, lengthS fits all over wrong, activeS fits all over wrong, tailDb fits all under wrong; shield: above2kHzLoud fits all under wrong, under250Hz fits all over wrong, above4kHz fits all under wrong, centroidHz fits all under wrong; fold jump: no measure separates; fold exit: loud50Db fits all over wrong, above2kHzLoud fits all under wrong, above60Hz fits all under wrong, under250Hz fits all over wrong, above4kHz fits all under wrong, centroidHz fits all under wrong, crestDb fits all under wrong, peakDb fits all over wrong, lengthS fits all under wrong, activeS fits all under wrong, tailDb fits all under wrong.


Held out: thresholds fitted on rounds 4 and 5 (fits against wrong; t1 -23.64, t2 0.036, which reject 5 of 15 accepted and keep 0 of 13 wrong there) and tried on the round-6 fits and wrongs: 2 of 4 accepted rejected, 1 of 8 wrong kept. The current rule on the same round-6 rows: 1 of 4 accepted rejected, 7 of 8 wrong kept.

The events the rule was made for (shield, fold jump, fold exit), rounds 4 to 6: over both numbers 4 candidates (fits 0, close 0, wrong 4); not over both 16 (fits 5, close 3, wrong 8).

Notes that name overdrive (the words übersteuert, overdriven, verzerrt, clip, sättig) by round: round 4: none; round 5: ev5_6_shield_bright_1_moss_p1s15, ev5_6_shield_bright_3_moss_p2s14, ev5_7_fold_jump_1_moss_p1s13, ev5_7_fold_jump_2_moss_p2s14; round 6: none.

## 4. The library thruster pulses against the candidates they were cut from

### g_thruster_pulse_a: library wrong (2026-11-18T14:36); candidate src_2_thruster_4_moss_p1s11, round 4, fits

| measure | library file | candidate, raw cut |
|---|---|---|
| level | -25.75 LUFS (recorded), -25.75 measured, true peak -15.91 dBFS | -34 LUFS target; listening copy measured -34.00, true peak -24.16 dBFS |
| same signal | library over listening copy +8.25 dB (lag 1 samples, residual 0.0000 of the library file) | |
| length, ending | 0.403 s; last 50 ms -30.45 dB under loudest; active 0.382 s; last sample 0.00000 | 0.403 s; last 50 ms -30.28 dB; active 0.389 s |
| spectrum | centroid 10872 Hz, a60 0.993, u250 0.017, a4k 0.917, a2k 0.975 | centroid 10872 Hz, a60 0.993, u250 0.017, a4k 0.917, a2k 0.975 |
| peak, crest | peak -15.98 dBFS, crest 13.02 dB, loud50 -25.98 | raw peak -5.21 dBFS, crest 13.02 dB, loud50 -15.21 |
| plateau | 5 windows of 50 ms within 3 dB of the loudest (0.25 s) | |
| 50 ms levels, dB under loudest | -11.2 -2.8 -0.6 -0.1 -0.5 -2.8 -8 -28.4 -83 | -11.2 -2.8 -0.6 -0.1 -0.5 -2.8 -8 -28.3 -45.4 |

### g_thruster_pulse_b: library wrong (2026-11-18T14:36); candidate ev5_3_thruster_valve_1_moss_r4p1s12, round 5, fits

| measure | library file | candidate, raw cut |
|---|---|---|
| level | -27.23 LUFS (recorded), -27.23 measured, true peak -17.37 dBFS | -34 LUFS target; listening copy measured -34.00, true peak -24.14 dBFS |
| same signal | library over listening copy +6.77 dB (lag 0 samples, residual 0.0059 of the library file) | |
| length, ending | 1.004 s; last 50 ms -12.65 dB under loudest; active 1.003 s; last sample 0.00003 | 1.004 s; last 50 ms -12.66 dB; active 1.003 s |
| spectrum | centroid 12991 Hz, a60 0.978, u250 0.023, a4k 0.972, a2k 0.969 | centroid 12991 Hz, a60 0.978, u250 0.023, a4k 0.972, a2k 0.969 |
| peak, crest | peak -17.90 dBFS, crest 13.07 dB, loud50 -29.73 | raw peak -13.60 dBFS, crest 13.07 dB, loud50 -25.43 |
| plateau | 17 windows of 50 ms within 3 dB of the loudest (0.85 s) | |
| 50 ms levels, dB under loudest | -5.7 -1.1 -0.6 -0.9 -0.5 -0.7 -0.8 -0.5 -0.3 -0.2 -0.2 -0.5 -0.5 -0.5 -0.3 -0.7 -0.4 -3 -9.3 -12 -46 | -5.7 -1.1 -0.6 -0.9 -0.5 -0.7 -0.8 -0.5 -0.3 -0.2 -0.2 -0.5 -0.5 -0.5 -0.3 -0.7 -0.4 -3 -9.3 -12 -46 |

### g_thruster_pulse_c: library fits (2026-11-18T14:36); candidate ev5_3_thruster_valve_2_moss_r4p1s15, round 5, fits

| measure | library file | candidate, raw cut |
|---|---|---|
| level | -28.26 LUFS (recorded), -28.26 measured, true peak -17.85 dBFS | -34 LUFS target; listening copy measured -33.99, true peak -23.58 dBFS |
| same signal | library over listening copy +5.73 dB (lag 0 samples, residual 0.0000 of the library file) | |
| length, ending | 0.788 s; last 50 ms -42.24 dB under loudest; active 0.755 s; last sample 0.00000 | 0.787 s; last 50 ms -41.07 dB; active 0.753 s |
| spectrum | centroid 9898 Hz, a60 1.000, u250 0.002, a4k 0.936, a2k 0.974 | centroid 9897 Hz, a60 1.000, u250 0.002, a4k 0.936, a2k 0.974 |
| peak, crest | peak -17.85 dBFS, crest 14.22 dB, loud50 -30.45 | raw peak -4.94 dBFS, crest 14.21 dB, loud50 -17.54 |
| plateau | 11 windows of 50 ms within 3 dB of the loudest (0.55 s) | |
| 50 ms levels, dB under loudest | -3.7 -0.8 -0.1 -0.1 -0.2 -0.3 -0.4 -0.1 -0.2 -0.8 -0.5 -0.8 -4.8 -24.8 -33.6 -44.6 | -3.5 -0.8 -0.1 -0.1 -0.2 -0.3 -0.3 -0.2 -0.1 -0.8 -0.5 -0.9 -5 -25.6 -33.9 -42.6 |

## 5. Ranges for the thruster and the shield

### thruster, all rounds, all sources (13 rows: fits 4, close 3, wrong 6)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | (4) -25.43..-15.21 | (3) -14.82..-4.54 | (6) -13.26..-2.65 |
| above2kHzLoud | (4) 0.965..0.975 | (3) 0.057..0.208 | (6) 0.010..0.234 |
| above60Hz | (4) 0.978..1.000 | (3) 0.742..0.990 | (6) 0.486..0.982 |
| under250Hz | (4) 0.000..0.023 | (3) 0.060..0.651 | (6) 0.061..0.910 |
| above4kHz | (4) 0.839..0.972 | (3) 0.023..0.134 | (6) 0.003..0.151 |
| centroidHz | (4) 9897..12991 | (3) 493..1726 | (6) 158..1736 |
| crestDb | (4) 13.02..18.18 | (3) 10.67..24.15 | (6) 6.36..22.66 |
| peakDb | (4) -13.60..-4.94 | (3) -0.01..3.58 | (6) -1.06..-0.00 |
| lengthS | (4) 0.403..1.004 | (3) 0.486..1.503 | (6) 0.487..1.500 |
| activeS | (4) 0.389..1.003 | (3) 0.403..1.503 | (6) 0.403..1.500 |
| tailDb | (4) -57.39..-12.66 | (3) -38.97..-32.92 | (6) -47.17..-24.88 |
| lufs | (4) -34..-34 | (3) -34..-28 | (6) -34..-28 |

### thruster, MOSS only (11 rows: fits 3, close 2, wrong 6)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | (3) -25.43..-15.21 | (2) -14.82..-4.54 | (6) -13.26..-2.65 |
| above2kHzLoud | (3) 0.969..0.975 | (2) 0.057..0.145 | (6) 0.010..0.234 |
| above60Hz | (3) 0.978..1.000 | (2) 0.742..0.981 | (6) 0.486..0.982 |
| under250Hz | (3) 0.002..0.023 | (2) 0.060..0.651 | (6) 0.061..0.910 |
| above4kHz | (3) 0.917..0.972 | (2) 0.023..0.087 | (6) 0.003..0.151 |
| centroidHz | (3) 9897..12991 | (2) 493..1508 | (6) 158..1736 |
| crestDb | (3) 13.02..14.21 | (2) 10.67..24.15 | (6) 6.36..22.66 |
| peakDb | (3) -13.60..-4.94 | (2) -0.01..-0.00 | (6) -1.06..-0.00 |
| lengthS | (3) 0.403..1.004 | (2) 0.486..1.503 | (6) 0.487..1.500 |
| activeS | (3) 0.389..1.003 | (2) 0.403..1.503 | (6) 0.403..1.500 |
| tailDb | (3) -41.07..-12.66 | (2) -38.97..-32.92 | (6) -47.17..-24.88 |
| lufs | (3) -34..-34 | (2) -34..-28 | (6) -34..-28 |

### thruster, round 6 only (3 rows: fits 0, close 1, wrong 2)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | - | (1) -4.54..-4.54 | (2) -5.77..-2.65 |
| above2kHzLoud | - | (1) 0.057..0.057 | (2) 0.010..0.061 |
| above60Hz | - | (1) 0.742..0.742 | (2) 0.486..0.957 |
| under250Hz | - | (1) 0.651..0.651 | (2) 0.692..0.910 |
| above4kHz | - | (1) 0.023..0.023 | (2) 0.003..0.014 |
| centroidHz | - | (1) 493..493 | (2) 158..484 |
| crestDb | - | (1) 10.67..10.67 | (2) 6.36..10.74 |
| peakDb | - | (1) -0.00..-0.00 | (2) -0.01..-0.00 |
| lengthS | - | (1) 1.503..1.503 | (2) 1.500..1.500 |
| activeS | - | (1) 1.503..1.503 | (2) 1.498..1.500 |
| tailDb | - | (1) -32.92..-32.92 | (2) -31.69..-31.02 |
| lufs | - | (1) -28..-28 | (2) -28..-28 |

### thruster, the valve prompt (round 4 thruster_1, MOSS) (3 rows: fits 3, close 0, wrong 0)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | (3) -25.43..-15.21 | - | - |
| above2kHzLoud | (3) 0.969..0.975 | - | - |
| above60Hz | (3) 0.978..1.000 | - | - |
| under250Hz | (3) 0.002..0.023 | - | - |
| above4kHz | (3) 0.917..0.972 | - | - |
| centroidHz | (3) 9897..12991 | - | - |
| crestDb | (3) 13.02..14.21 | - | - |
| peakDb | (3) -13.60..-4.94 | - | - |
| lengthS | (3) 0.403..1.004 | - | - |
| activeS | (3) 0.389..1.003 | - | - |
| tailDb | (3) -41.07..-12.66 | - | - |
| lufs | (3) -34..-34 | - | - |

### thruster, gun and cannon prompts (round 4 thruster_2, bang, gatling, mighty; MOSS and Stable Audio) (9 rows: fits 0, close 3, wrong 6)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | - | (3) -14.82..-4.54 | (6) -13.26..-2.65 |
| above2kHzLoud | - | (3) 0.057..0.208 | (6) 0.010..0.234 |
| above60Hz | - | (3) 0.742..0.990 | (6) 0.486..0.982 |
| under250Hz | - | (3) 0.060..0.651 | (6) 0.061..0.910 |
| above4kHz | - | (3) 0.023..0.134 | (6) 0.003..0.151 |
| centroidHz | - | (3) 493..1726 | (6) 158..1736 |
| crestDb | - | (3) 10.67..24.15 | (6) 6.36..22.66 |
| peakDb | - | (3) -0.01..3.58 | (6) -1.06..-0.00 |
| lengthS | - | (3) 0.486..1.503 | (6) 0.487..1.500 |
| activeS | - | (3) 0.403..1.503 | (6) 0.403..1.500 |
| tailDb | - | (3) -38.97..-32.92 | (6) -47.17..-24.88 |
| lufs | - | (3) -34..-28 | (6) -34..-28 |

### shield, all rounds, all sources (10 rows: fits 2, close 2, wrong 6)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | (2) -8.97..-8.13 | (2) -4.44..-1.42 | (6) -22.69..-4.40 |
| above2kHzLoud | (2) 0.003..0.009 | (2) 0.002..0.015 | (6) 0.037..0.961 |
| above60Hz | (2) 0.337..0.520 | (2) 0.254..0.502 | (6) 0.446..1.000 |
| under250Hz | (2) 0.964..0.987 | (2) 0.946..0.962 | (6) 0.001..0.814 |
| above4kHz | (2) 0.002..0.006 | (2) 0.001..0.005 | (6) 0.021..0.860 |
| centroidHz | (2) 96..134 | (2) 76..161 | (6) 441..7845 |
| crestDb | (2) 15.01..15.59 | (2) 5.89..12.73 | (6) 10.87..34.21 |
| peakDb | (2) -1.27..-0.77 | (2) -0.02..-0.00 | (6) -3.54..-0.00 |
| lengthS | (2) 2.139..2.284 | (2) 0.904..1.987 | (6) 0.251..2.503 |
| activeS | (2) 2.126..2.266 | (2) 0.847..1.985 | (6) 0.187..2.500 |
| tailDb | (2) -40.15..-38.97 | (2) -44.89..-26.06 | (6) -43.41..-30.79 |
| lufs | (2) -24..-24 | (2) -24..-24 | (6) -24..-24 |

### shield, MOSS only (7 rows: fits 0, close 2, wrong 5)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | - | (2) -4.44..-1.42 | (5) -22.07..-4.40 |
| above2kHzLoud | - | (2) 0.002..0.015 | (5) 0.037..0.865 |
| above60Hz | - | (2) 0.254..0.502 | (5) 0.446..0.990 |
| under250Hz | - | (2) 0.946..0.962 | (5) 0.038..0.814 |
| above4kHz | - | (2) 0.001..0.005 | (5) 0.021..0.727 |
| centroidHz | - | (2) 76..161 | (5) 441..7845 |
| crestDb | - | (2) 5.89..12.73 | (5) 10.87..34.21 |
| peakDb | - | (2) -0.02..-0.00 | (5) -0.35..-0.00 |
| lengthS | - | (2) 0.904..1.987 | (5) 0.260..2.503 |
| activeS | - | (2) 0.847..1.985 | (5) 0.259..2.500 |
| tailDb | - | (2) -44.89..-26.06 | (5) -43.41..-30.79 |
| lufs | - | (2) -24..-24 | (5) -24..-24 |

### shield, round 6 only (3 rows: fits 0, close 1, wrong 2)

| measure | fits (n) min..max | close (n) min..max | wrong (n) min..max |
|---|---|---|---|
| loud50Db | - | (1) -4.44..-4.44 | (2) -12.77..-10.94 |
| above2kHzLoud | - | (1) 0.015..0.015 | (2) 0.042..0.759 |
| above60Hz | - | (1) 0.502..0.502 | (2) 0.824..0.888 |
| under250Hz | - | (1) 0.946..0.946 | (2) 0.291..0.771 |
| above4kHz | - | (1) 0.005..0.005 | (2) 0.028..0.440 |
| centroidHz | - | (1) 161..161 | (2) 570..4147 |
| crestDb | - | (1) 12.73..12.73 | (2) 17.31..21.22 |
| peakDb | - | (1) -0.02..-0.02 | (2) -0.01..-0.01 |
| lengthS | - | (1) 0.904..0.904 | (2) 0.260..0.370 |
| activeS | - | (1) 0.847..0.847 | (2) 0.259..0.287 |
| tailDb | - | (1) -44.89..-44.89 | (2) -41.64..-39.41 |
| lufs | - | (1) -24..-24 | (2) -24..-24 |

## 6. Voices

| line | slot | model | variant | verdict | rated | note |
|---|---|---|---|---|---|---|
| 1 clearance | 1 | qwen3 |  | fits | 2026-11-18 |  |
| 1 clearance | 2 | chatterbox |  | fits | 2026-11-18 |  |
| 1 clearance | 3 | kokoro |  | fits | 2026-11-18 |  |
| 1 clearance | 4 | kitten |  | fits | 2026-11-18 | Klingt sehr gut und sie sagt "Niner," statt "Nine", was sehr gut ist für Funksprache |
| 1 clearance | 5 | phonon |  | close | 2026-11-18 | zu langsam gesprochen |
| 2 computer | 1 | qwen3 |  | close | 2026-11-15 | Countdown wird nicht wirklich in Sekunden gezählt, die Abstände sind unregelmäßig und kürzer |
| 2 computer | 2 | chatterbox |  | close | 2026-11-15 | Countdown wird nicht wirklich in Sekunden gezählt, die Abstände sind unregelmäßig und kürzer |
| 2 computer | 3 | kokoro |  | close | 2026-11-15 | Countdown wird nicht wirklich in Sekunden gezählt, die Abstände sind unregelmäßig und kürzer |
| 2 computer | 4 | kitten |  | close | 2026-11-15 | Countdown wird nicht wirklich in Sekunden gezählt, die Abstände sind unregelmäßig und kürzer |
| 2 computer | 5 | phonon |  | close | 2026-11-15 | Countdown wird nicht wirklich in Sekunden gezählt, die Abstände sind unregelmäßig und kürzer |
| 3 dock | 1 | qwen3 |  | fits | 2026-11-18 | Klingt natürlich |
| 3 dock | 2 | chatterbox |  | close | 2026-11-18 | Klingt wie vorgelesen |
| 3 dock | 3 | kokoro |  | close | 2026-11-18 | Klingt wie vorgelesen |
| 3 dock | 4 | kitten |  | close | 2026-11-18 | Klingt wie vorgelesen |
| 3 dock | 5 | phonon |  | fits | 2026-11-18 | Klingt natürlich |
| 4 convoy | 1 | qwen3 |  | fits | 2026-11-18 |  |
| 4 convoy | 2 | chatterbox |  | fits | 2026-11-18 |  |
| 4 convoy | 3 | kokoro |  | fits | 2026-11-18 |  |
| 4 convoy | 4 | kitten |  | fits | 2026-11-18 |  |
| 4 convoy | 5 | phonon |  | fits | 2026-11-18 |  |
| 5 countdown | 1 | qwen3 | single | fits | 2026-11-18 |  |
| 5 countdown | 2 | qwen3 | list | fits | 2026-11-18 |  |
| 5 countdown | 3 | chatterbox | single | fits | 2026-11-18 |  |
| 5 countdown | 4 | chatterbox | list | fits | 2026-11-18 |  |

Counts by model, all 24 voice ratings now in the file:

| model | fits | close | wrong | n |
|---|---|---|---|---|
| chatterbox | 4 | 2 | 0 | 6 |
| kitten | 2 | 2 | 0 | 4 |
| kokoro | 2 | 2 | 0 | 4 |
| phonon | 2 | 2 | 0 | 4 |
| qwen3 | 5 | 1 | 0 | 6 |

Counts by model, only those rated on 2026-11-18:

| model | fits | close | wrong | n |
|---|---|---|---|---|
| chatterbox | 4 | 1 | 0 | 5 |
| kitten | 2 | 1 | 0 | 3 |
| kokoro | 2 | 1 | 0 | 3 |
| phonon | 2 | 1 | 0 | 3 |
| qwen3 | 5 | 0 | 0 | 5 |

Voice ratings dated before 2026-11-18: voice_2_computer_1_qwen3, voice_2_computer_2_chatterbox, voice_2_computer_3_kokoro, voice_2_computer_4_kitten, voice_2_computer_5_phonon.

