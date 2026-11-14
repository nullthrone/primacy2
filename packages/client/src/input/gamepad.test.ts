import { describe, expect, it } from 'vitest';
import {
  AXIS_ONLY_ACTIONS, DEFAULT_PAD_BINDINGS, DEFAULT_PAD_SETTINGS, captureNext, captureProgress, capturedCode, deviceKey,
  emptyPadState, formatPadCode, joystickPreset, padButtonName, padCodeLabel, padName, padStyle, parsePadCode, readPads,
  shapeAxis, type PadSettings, type PadSnapshot,
} from './gamepad.ts';
import { DEFAULT_BINDINGS, type BindAction } from '../state/store.ts';

const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const DUALSHOCK = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
const DUALSENSE = '054c-0ce6-DualSense Wireless Controller';
const STICK = 'T.16000M (Vendor: 044f Product: b10a)';
const THROTTLE = 'TWCS Throttle (Vendor: 044f Product: b687)';

function pad(over: Partial<PadSnapshot> & { down?: number[]; axes?: number[] } = {}): PadSnapshot {
  const { down: d = [], axes = [0, 0, 0, 0], ...rest } = over;
  return {
    id: XBOX, index: 0, mapping: 'standard', axes,
    buttons: Array.from({ length: 17 }, (_, n) => ({ pressed: d.includes(n), value: d.includes(n) ? 1 : 0 })),
    ...rest,
  };
}
const noPad: PadSettings = { turnRate: 1, axes: {} };
const B = { ...DEFAULT_BINDINGS };

describe('binding codes', () => {
  it('parses and formats every kind', () => {
    for (const code of ['Pad:std:b3', 'Pad:std:b3+b0', 'Pad:044f-b10a:a2+', 'Pad:044f-b10a:a2-']) {
      const c = parsePadCode(code);
      expect(c).not.toBeNull();
      expect(formatPadCode(c!)).toBe(code);
    }
    expect(parsePadCode('Pad:std:b3+b0')).toEqual({ dev: 'std', kind: 'chord', m: 3, n: 0 });
    expect(parsePadCode('Pad:x:a1-')).toEqual({ dev: 'x', kind: 'axis', axis: 1, dir: -1 });
  });
  it('rejects keyboard codes and malformed ones', () => {
    for (const code of ['KeyW', 'Mouse0', 'Pad:std', 'Pad::b1', 'Pad:std:x1', 'Pad:std:b1+', 'Pad:std:a1']) expect(parsePadCode(code)).toBeNull();
  });
  it('labels chords with the names of the pad style', () => {
    expect(padCodeLabel('Pad:std:b3+b0', 'xbox')).toBe('Y + A');
    expect(padCodeLabel('Pad:std:b3+b0', 'playstation')).toBe('Triangle + Cross');
    expect(padCodeLabel('Pad:std:b7', 'generic')).toBe('Button 8');
    expect(padButtonName(6, 'playstation')).toBe('L2');
  });
});

describe('devices', () => {
  it('derives a stable key from real ids', () => {
    expect(deviceKey(STICK)).toBe('044f-b10a');
    expect(deviceKey(DUALSHOCK)).toBe('054c-09cc');
    expect(deviceKey(DUALSENSE)).toBe('054c-0ce6');
    expect(deviceKey(XBOX)).toBe('xbox-360-controller-xinput-stand');
    expect(deviceKey(STICK)).not.toBe(deviceKey(THROTTLE));
    expect(deviceKey('')).toBe('device');
    expect(deviceKey(XBOX)).not.toMatch(/[:+]/);
  });
  it('tells the style apart', () => {
    expect(padStyle(XBOX)).toBe('xbox');
    expect(padStyle(DUALSHOCK)).toBe('playstation');
    expect(padStyle(DUALSENSE)).toBe('playstation');
    expect(padStyle(STICK)).toBe('generic');
    expect(padStyle('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
  });
  it('cleans the name for display', () => {
    expect(padName(STICK)).toBe('T.16000M');
    expect(padName(DUALSENSE)).toBe('DualSense Wireless Controller');
  });
});

describe('axis shaping', () => {
  const b = { invert: false, deadzone: 0.2, curve: 2 };
  it('is zero inside the dead zone', () => {
    expect(shapeAxis(0.19, b)).toBe(0);
    expect(shapeAxis(-0.2, b)).toBe(0);
    expect(shapeAxis(0.05, { ...b, deadzone: 0.9 })).toBe(0);
  });
  it('rescales outside the dead zone and applies the curve', () => {
    expect(shapeAxis(1, b)).toBeCloseTo(1);
    expect(shapeAxis(0.6, b)).toBeCloseTo(0.25); // ((0.6 - 0.2) / 0.8) ^ 2
    expect(shapeAxis(-0.6, b)).toBeCloseTo(-0.25);
    expect(shapeAxis(0.6, { ...b, curve: 1 })).toBeCloseTo(0.5);
  });
  it('inverts', () => {
    expect(shapeAxis(0.6, { ...b, invert: true })).toBeCloseTo(-0.25);
  });
  it('clamps out-of-range input and survives NaN', () => {
    expect(shapeAxis(3, b)).toBeCloseTo(1);
    expect(shapeAxis(NaN, b)).toBe(0);
  });
});

describe('buttons', () => {
  it('holds a button and fires a single press once', () => {
    const a = readPads([pad({ down: [7] })], B, noPad, null);
    expect(a.held.has('firePrimary')).toBe(true);
    expect(a.pressed).toContain('firePrimary');
    const b2 = readPads([pad({ down: [7] })], B, noPad, a.state);
    expect(b2.held.has('firePrimary')).toBe(true);
    expect(b2.pressed).toEqual([]);
    const c = readPads([pad()], B, noPad, b2.state);
    expect(c.held.size).toBe(0);
    expect(c.released).toContain('firePrimary');
    const d = readPads([pad({ down: [9] })], B, noPad, c.state);
    expect(d.pressed).toEqual(['menu']);
  });
  it('reports raw edges for menu navigation, bound or not', () => {
    const a = readPads([pad({ down: [16] })], B, noPad, null);
    expect(a.edges).toEqual([{ index: 0, button: 16, standard: true }]);
    expect(readPads([pad({ down: [16] })], B, noPad, a.state).edges).toEqual([]);
  });
});

describe('chords', () => {
  it('fires the chord action and silences the plain bindings while the modifier is held', () => {
    let r = readPads([pad({ down: [3] })], B, noPad, null);
    expect(r.held.size).toBe(0);
    r = readPads([pad({ down: [3, 0] })], B, noPad, r.state);
    expect(r.pressed).toEqual(['dock']);
    expect(r.held.has('thrustUp')).toBe(false);
    r = readPads([pad({ down: [3, 0] })], B, noPad, r.state);
    expect(r.pressed).toEqual([]);
    expect(r.held.has('dock')).toBe(true);
  });
  /** Feeds one reading after another and returns them all. */
  const run = (...frames: number[][]): ReturnType<typeof readPads>[] => {
    const out: ReturnType<typeof readPads>[] = [];
    let state = null as ReturnType<typeof readPads>['state'] | null;
    for (const d of frames) {
      const r = readPads([pad({ down: d })], B, noPad, state);
      state = r.state;
      out.push(r);
    }
    return out;
  };
  it('keeps the target of a chord silent until it is let go, whichever button is released first', () => {
    // Y + A docks. Letting go of Y first must not turn A into thrust up.
    const r = run([3, 0], [0], [], [0]);
    expect(r[1]!.held.has('thrustUp')).toBe(false);
    expect(r[1]!.held.has('dock')).toBe(false);
    expect(r[1]!.pressed).toEqual([]);
    // A new press of A alone works again.
    expect(r[3]!.held.has('thrustUp')).toBe(true);
  });
  it('does not run the plain action of a single-press button after its chord', () => {
    // Y + View opens the galaxy map; View alone is the cruise drive.
    const r = run([3], [3, 8], [8], [8], []);
    expect(r[1]!.pressed).toEqual(['galaxyMap']);
    expect(r[2]!.pressed).toEqual([]);
    expect(r[2]!.held.has('cruise')).toBe(false);
    expect(r[3]!.pressed).toEqual([]);
    // The next lone press fires.
    expect(run([3], [3, 8], [8], [], [8])[4]!.pressed).toEqual(['cruise']);
  });
  it('does not press a held button a second time when the modifier is tapped', () => {
    const r = run([8], [8, 3], [8]);
    expect(r[0]!.pressed).toEqual(['cruise']);
    expect(r[1]!.pressed).toEqual([]);
    expect(r[2]!.pressed).toEqual([]);
  });
  it('gives a button held from before the modifier its action back after the chord', () => {
    // Thrust held, Y tapped: thrust pauses and comes back.
    const a = run([0], [0, 3], [0]);
    expect(a[1]!.held.has('thrustUp')).toBe(false);
    expect(a[2]!.held.has('thrustUp')).toBe(true);
    expect(a[2]!.pressed).toEqual([]);
    // Fire held through Y + D-pad right (power to weapons) fires again afterwards.
    const f = run([7], [7, 3], [7, 3, 15], [7, 3], [7]);
    expect(f[2]!.pressed).toEqual(['powerWeapons']);
    expect(f[3]!.held.has('firePrimary')).toBe(false);
    expect(f[4]!.held.has('firePrimary')).toBe(true);
  });
  it('reports a press on a second device of an action another device already holds', () => {
    const two = (a: number[], b: number[]): PadSnapshot[] => [pad({ down: a }), pad({ index: 1, down: b })];
    let r = readPads(two([8], []), B, noPad, null);
    expect(r.pressed).toEqual(['cruise']);
    r = readPads(two([8], [8]), B, noPad, r.state);
    expect(r.pressed).toEqual(['cruise']);
    r = readPads(two([], [8]), B, noPad, r.state);
    expect(r.pressed).toEqual([]);
    expect(r.released).toEqual([]);
  });
  it('does not fire a chord when the target was held before the modifier', () => {
    let r = readPads([pad({ down: [0] })], B, noPad, null);
    expect(r.held.has('thrustUp')).toBe(true);
    r = readPads([pad({ down: [0, 3] })], B, noPad, r.state);
    expect(r.held.has('dock')).toBe(false);
    expect(r.held.has('thrustUp')).toBe(false);
  });
  it('gives the modifier no action of its own', () => {
    const b = { ...B, fireTool: ['Pad:std:b2', 'Pad:std:b3'] };
    expect(readPads([pad({ down: [3] })], b, noPad, null).held.has('fireTool')).toBe(false);
  });
});

describe('device match', () => {
  const b = { ...B, firePrimary: ['Pad:044f-b10a:b0'], fireSecondary: ['Pad:std:b0'] };
  const stick = pad({ id: STICK, index: 1, mapping: '', down: [0] });
  it('std matches only standard devices', () => {
    const r = readPads([stick], b, noPad, null);
    expect(r.held.has('fireSecondary')).toBe(false);
    expect(readPads([pad({ down: [0] })], b, noPad, null).held.has('fireSecondary')).toBe(true);
  });
  it('a device key matches only its device', () => {
    expect(readPads([pad({ down: [0] })], b, noPad, null).held.has('firePrimary')).toBe(false);
    expect(readPads([stick], b, noPad, null).held.has('firePrimary')).toBe(true);
  });
  it('serves two devices at once', () => {
    const thr = pad({ id: THROTTLE, index: 2, mapping: '', down: [4] });
    const b2 = { ...b, boost: ['Pad:044f-b687:b4'] };
    const r = readPads([stick, thr], b2, noPad, null);
    expect(r.held.has('firePrimary') && r.held.has('boost')).toBe(true);
    expect(r.activeIndex).toBe(1);
  });
});

describe('disconnect', () => {
  it('releases what a vanished device held', () => {
    let r = readPads([pad({ down: [7] }), pad({ id: STICK, index: 1, mapping: '', down: [1] })], { ...B, boost: ['Pad:044f-b10a:b1'] }, noPad, null);
    expect(r.held.has('firePrimary') && r.held.has('boost')).toBe(true);
    r = readPads([pad({ id: STICK, index: 1, mapping: '', down: [1] })], { ...B, boost: ['Pad:044f-b10a:b1'] }, noPad, r.state);
    expect(r.released).toEqual(['firePrimary']);
    r = readPads([], B, noPad, r.state);
    expect(r.held.size).toBe(0);
    expect(r.released).toContain('boost');
  });
});

describe('axis halves as buttons', () => {
  const b = { ...B, boost: ['Pad:std:a4+'], brake: ['Pad:std:a4-'] };
  const at = (v: number): PadSnapshot => pad({ axes: [0, 0, 0, 0, v] });
  it('turns on above 0.5 and off below 0.4', () => {
    let r = readPads([at(0.45)], b, noPad, null);
    expect(r.held.has('boost')).toBe(false);
    r = readPads([at(0.55)], b, noPad, r.state);
    expect(r.held.has('boost')).toBe(true);
    expect(r.pressed).toEqual(['boost']);
    r = readPads([at(0.45)], b, noPad, r.state);
    expect(r.held.has('boost')).toBe(true);
    expect(r.pressed).toEqual([]);
    r = readPads([at(0.35)], b, noPad, r.state);
    expect(r.held.has('boost')).toBe(false);
  });
  it('uses the other half for the other direction', () => {
    expect(readPads([at(-0.7)], b, noPad, null).held.has('brake')).toBe(true);
  });
});

describe('analog axes and the lever', () => {
  it('reads the default sticks with the up-is-forward and up-is-nose-up signs', () => {
    const r = readPads([pad({ axes: [0.5, -1, 1, -1] })], B, DEFAULT_PAD_SETTINGS, null);
    expect(r.axes.thrustZ).toBeCloseTo(1);
    expect(r.axes.pitch).toBeCloseTo(1);
    expect(r.axes.yaw).toBeCloseTo(1);
    expect(r.axes.thrustX).toBeGreaterThan(0.1);
    expect(r.axes.thrustX).toBeLessThan(0.5);
  });
  it('keeps the strongest of several bindings', () => {
    const s: PadSettings = { turnRate: 1, axes: { roll: [{ dev: 'std', axis: 0, invert: false, deadzone: 0, curve: 1 }, { dev: 'std', axis: 1, invert: false, deadzone: 0, curve: 1 }] } };
    expect(readPads([pad({ axes: [0.3, -0.8] })], B, s, null).axes.roll).toBeCloseTo(-0.8);
  });
  it('maps the lever travel to 0..1 and honours invert', () => {
    const mk = (invert: boolean): PadSettings => ({ turnRate: 1, axes: { throttle: [{ dev: 'x', axis: 2, invert, deadzone: 0, curve: 1, lever: true }] } });
    const dev = (v: number): PadSnapshot => pad({ id: 'x', mapping: '', axes: [0, 0, v] });
    expect(readPads([dev(-1)], B, mk(false), null).lever).toBeCloseTo(0);
    expect(readPads([dev(1)], B, mk(false), null).lever).toBeCloseTo(1);
    expect(readPads([dev(0)], B, mk(false), null).lever).toBeCloseTo(0.5);
    expect(readPads([dev(-1)], B, mk(true), null).lever).toBeCloseTo(1);
    expect(readPads([], B, mk(false), null).lever).toBeNull();
    expect(readPads([dev(1)], B, mk(false), null).axes.throttle).toBe(0);
  });
});

describe('active', () => {
  const lever: PadSettings = { turnRate: 1, axes: { throttle: [{ dev: 'std', axis: 2, invert: false, deadzone: 0, curve: 1, lever: true }] } };
  it('is true for a button and false for none', () => {
    expect(readPads([pad()], B, noPad, null).active).toBe(false);
    expect(readPads([pad({ down: [12] })], B, noPad, null).active).toBe(true);
  });
  it('is true for a bound axis outside its dead zone only', () => {
    expect(readPads([pad({ axes: [0.1, 0, 0, 0] })], B, DEFAULT_PAD_SETTINGS, null).active).toBe(false);
    expect(readPads([pad({ axes: [0.4, 0, 0, 0] })], B, DEFAULT_PAD_SETTINGS, null).active).toBe(true);
    // An axis nobody uses does not count.
    expect(readPads([pad({ axes: [0, 0, 0, 0, 1] })], B, DEFAULT_PAD_SETTINGS, null).active).toBe(false);
  });
  it('treats a resting lever as idle and a moved one as active', () => {
    let r = readPads([pad({ axes: [0, 0, 0.7, 0] })], B, lever, null);
    expect(r.active).toBe(false);
    r = readPads([pad({ axes: [0, 0, 0.7, 0] })], B, lever, r.state);
    expect(r.active).toBe(false);
    r = readPads([pad({ axes: [0, 0, 0.3, 0] })], B, lever, r.state);
    expect(r.active).toBe(true);
  });
});

describe('capture', () => {
  it('takes the first button newly pressed', () => {
    expect(captureNext([pad()], [pad({ down: [5] })])).toEqual({ kind: 'button', dev: 'std', n: 5 });
    expect(captureNext([pad({ down: [5] })], [pad({ down: [5] })])).toBeNull();
  });
  it('names a non-standard device by its key', () => {
    const s = (d: number[]): PadSnapshot => pad({ id: STICK, index: 3, mapping: '', down: d });
    expect(captureNext([s([])], [s([1])])).toEqual({ kind: 'button', dev: '044f-b10a', n: 1 });
  });
  it('takes the axis that moved furthest, in both directions', () => {
    expect(captureNext([pad()], [pad({ axes: [0.2, 0.9, 0.6, 0] })])).toEqual({ kind: 'axis', dev: 'std', axis: 1, dir: 1 });
    expect(captureNext([pad()], [pad({ axes: [0, 0, -0.7, 0.55] })])).toEqual({ kind: 'axis', dev: 'std', axis: 2, dir: -1 });
    expect(captureNext([pad()], [pad({ axes: [0.4, -0.3, 0, 0] })])).toBeNull();
  });
  it('judges an axis against its resting value', () => {
    const rest = pad({ axes: [0, 0, 0, 0, -1] });
    expect(captureNext([rest], [rest])).toBeNull();
    expect(captureNext([rest], [pad({ axes: [0, 0, 0, 0, -0.9] })])).toBeNull();
    expect(captureNext([rest], [pad({ axes: [0, 0, 0, 0, 0.2] })])).toEqual({ kind: 'axis', dev: 'std', axis: 4, dir: 1 });
    const lever = pad({ axes: [0, 0, 0.8, 0] });
    expect(captureNext([lever], [lever])).toBeNull();
    expect(captureNext([lever], [pad({ axes: [0, 0, 0.1, 0] })])).toEqual({ kind: 'axis', dev: 'std', axis: 2, dir: -1 });
  });
  it('builds a chord from a held modifier and a second button, and a plain button on release', () => {
    const before = [pad()];
    let p = captureProgress(before, [pad({ down: [3] })], null);
    expect(p.pending).toEqual({ dev: 'std', n: 3 });
    p = captureProgress(before, [pad({ down: [3, 1] })], p.pending);
    expect(p.done).toEqual({ kind: 'chord', dev: 'std', m: 3, n: 1 });
    expect(capturedCode(p.done!)).toBe('Pad:std:b3+b1');
    let q = captureProgress(before, [pad({ down: [4] })], null);
    q = captureProgress(before, [pad()], q.pending);
    expect(q.done).toEqual({ kind: 'button', dev: 'std', n: 4 });
  });
  it('takes a modifier that was already held when the assignment began', () => {
    const before = [pad({ down: [3] })];
    const p = captureProgress(before, [pad({ down: [3, 2] })], captureProgress(before, before, null).pending);
    expect(p.done).toEqual({ kind: 'chord', dev: 'std', m: 3, n: 2 });
  });
  it('is not blocked by a button that reads as held on another device', () => {
    // A latched switch of a HOTAS, or a stuck button, is down from the start.
    const stick = (d: number[]): PadSnapshot => pad({ id: STICK, index: 1, mapping: '', down: d });
    const before = [pad(), stick([5])];
    let p = captureProgress(before, before, null);
    expect(p.pending).toEqual({ dev: '044f-b10a', n: 5 });
    // A on the standard pad: that is the button the pilot means.
    p = captureProgress(before, [pad({ down: [0] }), stick([5])], p.pending);
    expect(p.pending).toEqual({ dev: 'std', n: 0 });
    expect(p.done).toBeNull();
    p = captureProgress(before, [pad(), stick([5])], p.pending);
    expect(p.done).toEqual({ kind: 'button', dev: 'std', n: 0 });
    // A chord on the device with the held button still works.
    const q = captureProgress(before, [pad(), stick([5, 2])], captureProgress(before, before, null).pending);
    expect(q.done).toEqual({ kind: 'chord', dev: '044f-b10a', m: 5, n: 2 });
  });
  it('takes an axis at once', () => {
    expect(captureProgress([pad()], [pad({ axes: [0, 0, 0, -0.9] })], null).done).toEqual({ kind: 'axis', dev: 'std', axis: 3, dir: -1 });
  });
});

describe('the default table', () => {
  const std = readPads([pad()], B, noPad, null);
  void std;
  it('reaches every action on a standard pad', () => {
    // Stepping through ships has no button of its own on a standard pad: the D-pad steps through
    // places, and "target ahead" steps on to the next ship when nothing new lies ahead.
    const covered = new Set<string>([...AXIS_ONLY_ACTIONS, 'chat', 'freeLook', 'targetNext', 'targetPrev']);
    for (const a of Object.keys(DEFAULT_BINDINGS) as BindAction[]) {
      const has = (DEFAULT_BINDINGS[a] ?? []).some((c) => c.startsWith('Pad:'));
      expect(has || covered.has(a), a).toBe(true);
    }
    expect(DEFAULT_PAD_SETTINGS.axes.thrustX && DEFAULT_PAD_SETTINGS.axes.thrustZ && DEFAULT_PAD_SETTINGS.axes.yaw && DEFAULT_PAD_SETTINGS.axes.pitch).toBeTruthy();
  });
  it('fires each pad action from the buttons it names', () => {
    for (const [a, codes] of Object.entries(DEFAULT_PAD_BINDINGS) as [BindAction, string[]][]) {
      for (const code of codes) {
        const c = parsePadCode(code)!;
        let state = readPads([pad()], B, noPad, null).state;
        if (c.kind === 'chord') state = readPads([pad({ down: [c.m] })], B, noPad, state).state;
        const down = c.kind === 'chord' ? [c.m, c.n] : [(c as { n: number }).n];
        const r = readPads([pad({ down })], B, noPad, state);
        expect(r.held.has(a), code).toBe(true);
      }
    }
  });
  it('gives the D-pad to targets: places left and right, ahead up, clear down', () => {
    expect(DEFAULT_PAD_BINDINGS.navPrev).toEqual(['Pad:std:b14']);
    expect(DEFAULT_PAD_BINDINGS.navNext).toEqual(['Pad:std:b15']);
    expect(DEFAULT_PAD_BINDINGS.targetAhead).toEqual(['Pad:std:b12']);
    expect(DEFAULT_PAD_BINDINGS.targetClear).toEqual(['Pad:std:b13']);
    expect(DEFAULT_BINDINGS.navNext).toEqual(['KeyO', 'Mouse4', 'Pad:std:b15']);
    expect(DEFAULT_BINDINGS.navPrev).toEqual(['KeyL', 'Pad:std:b14']);
    // Ships keep their keys on the keyboard.
    expect(DEFAULT_BINDINGS.targetNext).toEqual(['KeyT']);
    expect(DEFAULT_BINDINGS.targetPrev).toEqual(['KeyG']);
  });
  it('binds no pad code twice', () => {
    const seen = new Set<string>();
    for (const codes of Object.values(DEFAULT_BINDINGS)) {
      for (const c of codes) {
        if (!c.startsWith('Pad:')) continue;
        expect(seen.has(c), c).toBe(false);
        seen.add(c);
      }
    }
    expect(seen.size).toBeGreaterThan(25);
  });
  it('offers a joystick preset on the device key', () => {
    const j = joystickPreset('044f-b10a');
    expect(j.bindings.firePrimary).toEqual(['Pad:044f-b10a:b0']);
    expect(j.pad.axes.yaw?.[0]?.axis).toBe(0);
    expect(j.pad.axes.pitch?.[0]?.axis).toBe(1);
  });
  it('starts from an empty state', () => {
    expect(emptyPadState().held.size).toBe(0);
  });
});
