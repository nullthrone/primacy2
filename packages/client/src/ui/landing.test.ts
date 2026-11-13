import { describe, expect, it } from 'vitest';
import {
  G, LAND_MAX_SIDE, LAND_MAX_SINK, LAND_MAX_SLOPE_DEG, LAND_MAX_TILT_DEG, packPips, quat,
  type Vec3,
} from '@primacy2/shared';
import { de } from '../i18n/de.ts';
import { en } from '../i18n/en.ts';
import { store } from '../state/store.ts';
import { fmtHeight, fmtRate } from './format.ts';
import {
  BASE_DROP_RANGE, LANDING_CUE_CLIMB, LANDING_CUE_HEIGHT, LANDING_CUE_SECONDS, baseDropHere, landingCues, landingNear, liftBalance, noticeKey,
} from './landing.ts';

const UP: Vec3 = [0, 1, 0];
const LEVEL = quat.identity();
const rad = (deg: number): number => (deg * Math.PI) / 180;

describe('landing cues', () => {
  it('are all within limits for a slow, level descent onto level ground', () => {
    const c = landingCues([1, -3, 2], LEVEL, UP, rad(5));
    expect(c.sink.value).toBeCloseTo(3, 12);
    expect(c.side.value).toBeCloseTo(Math.hypot(1, 2), 12);
    expect(c.slope.value).toBeCloseTo(5, 12);
    expect(c.tilt.value).toBeCloseTo(0, 6);
    expect([c.sink.over, c.side.over, c.slope.over, c.tilt.over, c.over]).toEqual([false, false, false, false, false]);
  });

  it('carry the shared limits and trip just above them, not at them', () => {
    const at = landingCues([LAND_MAX_SIDE, -LAND_MAX_SINK, 0], LEVEL, UP, rad(LAND_MAX_SLOPE_DEG));
    expect([at.sink.limit, at.side.limit, at.slope.limit, at.tilt.limit]).toEqual([LAND_MAX_SINK, LAND_MAX_SIDE, LAND_MAX_SLOPE_DEG, LAND_MAX_TILT_DEG]);
    expect(at.sink.over).toBe(false);
    expect(at.side.over).toBe(false);
    expect(landingCues([0, -LAND_MAX_SINK - 0.01, 0], LEVEL, UP, 0).sink.over).toBe(true);
    expect(landingCues([LAND_MAX_SIDE + 0.01, 0, 0], LEVEL, UP, 0).side.over).toBe(true);
    expect(landingCues([0, 0, 0], LEVEL, UP, rad(LAND_MAX_SLOPE_DEG + 0.1)).slope.over).toBe(true);
    expect(landingCues([0, 0, 0], LEVEL, UP, rad(LAND_MAX_SLOPE_DEG - 0.1)).slope.over).toBe(false);
  });

  it('measure sink and sideways speed against the ground normal, not against straight down', () => {
    // Ground tilted by 30 degrees; a ship falling straight down slides along it as well.
    const n: Vec3 = [Math.sin(rad(30)), Math.cos(rad(30)), 0];
    const c = landingCues([0, -10, 0], LEVEL, n, rad(30));
    expect(c.sink.value).toBeCloseTo(10 * Math.cos(rad(30)), 9);
    expect(c.side.value).toBeCloseTo(10 * Math.sin(rad(30)), 9);
    // Moving away from the ground is no sink rate at all.
    expect(landingCues([0, 4, 0], LEVEL, UP, 0).sink.value).toBe(0);
  });

  it('take the tilt from the ship up axis against the normal', () => {
    const rolled = quat.fromAxisAngle([0, 0, 1], rad(40));
    const c = landingCues([0, 0, 0], rolled, UP, 0);
    expect(c.tilt.value).toBeCloseTo(40, 6);
    expect(c.tilt.over).toBe(true);
    expect(c.over).toBe(true);
    expect(landingCues([0, 0, 0], quat.fromAxisAngle([0, 0, 1], rad(25)), UP, 0).tilt.over).toBe(false);
    // Standing upright on a slope is no tilt: both are measured against the same normal.
    const n: Vec3 = [Math.sin(rad(15)), Math.cos(rad(15)), 0];
    expect(landingCues([0, 0, 0], quat.fromAxisAngle([0, 0, 1], -rad(15)), n, rad(15)).tilt.value).toBeCloseTo(0, 5);
    // A cosine a hair above one must not turn into NaN.
    expect(Number.isNaN(landingCues([0, 0, 0], LEVEL, [0, 1 + 1e-12, 0], 0).tilt.value)).toBe(false);
  });
});

describe('landingNear', () => {
  it('is true very low for a ship that hovers or sinks, and higher up only while sinking toward the ground', () => {
    expect(landingNear(LANDING_CUE_HEIGHT - 1, 0)).toBe(true);
    expect(landingNear(LANDING_CUE_HEIGHT - 1, -2)).toBe(true);
    expect(landingNear(LANDING_CUE_HEIGHT - 1, LANDING_CUE_CLIMB / 2)).toBe(true);
    // Climbing away after lift-off is no landing, however low.
    expect(landingNear(2, 3)).toBe(false);
    expect(landingNear(LANDING_CUE_HEIGHT - 1, LANDING_CUE_CLIMB)).toBe(false);
    expect(landingNear(300, 0)).toBe(false);
    expect(landingNear(300, 12)).toBe(false);
    expect(landingNear(300, -300 / LANDING_CUE_SECONDS - 1)).toBe(true);
    expect(landingNear(300, -300 / LANDING_CUE_SECONDS + 1)).toBe(false);
    expect(landingNear(5000, -400)).toBe(true);
    expect(landingNear(5000, -100)).toBe(false);
  });
});

describe('liftBalance', () => {
  const body = { mass: (9.81 * 6.371e6 ** 2) / G, radius: 6.371e6 };

  it('compares surface gravity with the vertical thrusters at the engine power set', () => {
    const even = liftBalance(body, { accelVert: 10 }, packPips(4, 4, 4));
    expect(even.gravity).toBeCloseTo(9.81, 9);
    expect(even.lift).toBeCloseTo(10, 9);
    expect(even.short).toBe(false);
    // Power taken from the engines makes the same hull too weak; full power gives it back.
    const starved = liftBalance(body, { accelVert: 10 }, packPips(8, 0, 4));
    expect(starved.lift).toBeCloseTo(8, 9);
    expect(starved.short).toBe(true);
    expect(liftBalance(body, { accelVert: 10 }, packPips(2, 8, 2)).lift).toBeCloseTo(12, 9);
  });

  it('is not short on a light moon', () => {
    expect(liftBalance({ mass: (1.62 * 1.737e6 ** 2) / G, radius: 1.737e6 }, { accelVert: 10 }, packPips(8, 0, 4)).short).toBe(false);
  });
});

describe('baseDropHere', () => {
  const R = 1_336_000;
  const pad: Vec3 = [0, R, 0];
  const enter = R + 60_000;
  /** A point `height` above the mean radius, `angle` degrees of arc away from the pad. */
  const at = (angle: number, height: number): Vec3 => [Math.sin(rad(angle)) * (R + height), Math.cos(rad(angle)) * (R + height), 0];

  it('holds over the base below the surface-frame height', () => {
    expect(baseDropHere(at(0, 30_000), pad, enter)).toBe(true);
    expect(baseDropHere(at(1, 10_000), pad, enter)).toBe(true);
  });

  it('fails above the height where normal flight uses the surface frame', () => {
    expect(baseDropHere(at(0, 60_001), pad, enter)).toBe(false);
  });

  it('fails on the far side of the body and anywhere below the horizon of the pad', () => {
    expect(baseDropHere(at(180, 30_000), pad, enter)).toBe(false);
    expect(baseDropHere(at(90, 30_000), pad, enter)).toBe(false);
    // 3 degrees of arc are 70 km of ground: in range, but at 500 m the pad is under the horizon.
    expect(baseDropHere(at(3, 500), pad, enter)).toBe(false);
    expect(baseDropHere(at(3, 5_000), pad, enter)).toBe(true);
  });

  it('fails in sight of the base but farther than the range', () => {
    const far = at(6, 50_000);
    expect(Math.hypot(far[0] - pad[0], far[1] - pad[1])).toBeGreaterThan(BASE_DROP_RANGE);
    expect(far[1]).toBeGreaterThan(R);
    expect(baseDropHere(far, pad, enter)).toBe(false);
    expect(baseDropHere(at(3, 50_000), pad, enter)).toBe(true);
  });
});

describe('noticeKey', () => {
  it('translates the ground notices by their code', () => {
    expect(noticeKey('cruise_ceiling', 'x')).toBe('notice.cruiseCeiling');
    expect(noticeKey('cruise_ground', 'x')).toBe('notice.cruiseGround');
    expect(noticeKey('cruise_masslock', 'x')).toBe('notice.cruiseMasslock');
    expect(noticeKey('charge_landed', 'x')).toBe('notice.chargeLanded');
    expect(noticeKey('crash', 'x')).toBe('notice.crash');
  });

  it('translates refused commands by the sentence the server sends, and nothing else', () => {
    expect(noticeKey('refused', 'Lift off first.')).toBe('notice.liftOffFirst');
    expect(noticeKey('refused', 'Too close to the ground: climb above the cruise ceiling.')).toBe('notice.cruiseGround');
    expect(noticeKey('refused', 'Mass-locked: move away from the structure.')).toBe('notice.cruiseMasslock');
    expect(noticeKey('refused', 'No base here.')).toBe('notice.noBase');
    expect(noticeKey('refused', 'Too far from the base.')).toBe('notice.baseTooFar');
    expect(noticeKey('refused', 'Not enough fuel.')).toBeNull();
    expect(noticeKey('info', 'Lift off first.')).toBeNull();
    expect(noticeKey('toString', 'x')).toBeNull();
  });
});

describe('height and rate readouts', () => {
  it('switch from kilometres to metres at one kilometre and to tenths near the ground', () => {
    store.settings.value = { ...store.settings.value, lang: 'en' };
    expect(fmtHeight(250_000)).toBe('250.0 km');
    expect(fmtHeight(5_000)).toBe('5.00 km');
    expect(fmtHeight(1_004)).toBe('1.00 km');
    expect(fmtHeight(999.6)).toBe('1.00 km');
    expect(fmtHeight(999.4)).toBe('999 m');
    expect(fmtHeight(300)).toBe('300 m');
    expect(fmtHeight(19.96)).toBe('20 m');
    expect(fmtHeight(19.94)).toBe('19.9 m');
    expect(fmtHeight(0)).toBe('0.0 m');
    expect(fmtRate(4.25)).toMatch(/^4\.[23] m\/s$/);
    expect(fmtRate(240)).toBe('240 m/s');
    store.settings.value = { ...store.settings.value, lang: 'de' };
    expect(fmtHeight(5_000)).toBe('5,00 km');
    expect(fmtHeight(12.3)).toBe('12,3 m');
    store.settings.value = { ...store.settings.value, lang: 'en' };
  });
});

describe('translations', () => {
  // The set of names: a sentence may use one placeholder twice in one language and once in the other.
  const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

  it('German defines every English key with the same placeholders', () => {
    const german = de as Record<string, string | undefined>;
    for (const [key, text] of Object.entries(en)) {
      expect(german[key], `German string for ${key}`).toBeTypeOf('string');
      expect(placeholders(german[key]!), `placeholders of ${key}`).toEqual(placeholders(text));
    }
    expect(Object.keys(german).filter((k) => !(k in en))).toEqual([]);
  });
});
