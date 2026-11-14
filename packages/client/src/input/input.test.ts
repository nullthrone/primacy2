import { FlightMode } from '@primacy2/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, addPadDefaults, handOver, loadSettings, store, type BindAction } from '../state/store.ts';
import { assignPad, clearPad, presetJoystick, resetPad } from './binds.ts';
import { Input } from './Input.ts';
import type { PadSnapshot } from './gamepad.ts';

function pad(down: number[] = [], axes: number[] = [0, 0, 0, 0]): PadSnapshot {
  return {
    id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, mapping: 'standard', axes,
    buttons: Array.from({ length: 17 }, (_, n) => ({ pressed: down.includes(n), value: down.includes(n) ? 1 : 0 })),
  };
}

let pads: (PadSnapshot | null)[] = [];

function makeInput(): { input: Input; actions: BindAction[] } {
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('document', { addEventListener: () => {}, activeElement: null, pointerLockElement: null });
  vi.stubGlobal('navigator', { getGamepads: () => pads, language: 'en' });
  const input = new Input({} as HTMLCanvasElement);
  const actions: BindAction[] = [];
  input.onAction = (a) => actions.push(a);
  return { input, actions };
}

beforeEach(() => {
  pads = [];
  store.settings.value = DEFAULT_SETTINGS;
  store.phase.value = 'playing';
  store.panel.value = null;
  store.device.value = 'keys';
  store.padCapturing.value = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('Input with a pad', () => {
  it('turns a pad press into the same action as a key', () => {
    const { input, actions } = makeInput();
    pads = [pad([9])];
    input.pollPads();
    expect(actions).toEqual(['menu']);
    expect(store.device.value).toBe('pad');
    input.pollPads();
    expect(actions).toEqual(['menu']);
  });

  it('runs throttle and power presses through the shared path, not onAction', () => {
    const { input, actions } = makeInput();
    input.setMode(FlightMode.Normal);
    pads = [pad([3])];
    input.pollPads();
    pads = [pad([3, 7])];
    input.pollPads();
    expect(input.throttle).toBeCloseTo(0.1);
    pads = [pad([3, 6])];
    input.pollPads();
    pads = [pad([3, 12])];
    input.pollPads();
    expect(actions).toEqual([]);
    expect(input.pips).not.toBe(new Input({} as HTMLCanvasElement).pips);
  });

  it('is live without pointer lock while a pad was used last', () => {
    const { input } = makeInput();
    store.pointerLocked.value = false;
    expect(input.active()).toBe(false);
    pads = [pad([12])];
    input.pollPads();
    expect(input.active()).toBe(true);
  });

  it('asks for deflection * turn rate * dt from the stick, and nothing once it is let go', () => {
    const { input } = makeInput();
    input.turnRates = [0.8, 0.5];
    pads = [pad([], [0, 0, 1, -1])];
    input.pollPads();
    const dt = 1 / 30;
    const on = input.sample(FlightMode.Normal, dt);
    expect(on.aim[0]).toBeCloseTo(0.8 * dt);
    expect(on.aim[1]).toBeCloseTo(0.5 * dt);
    pads = [pad()];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, dt).aim).toEqual([0, 0]);
  });

  it('adds the strafe and forward axes to thrust, clamped, and moves the throttle in cruise', () => {
    const { input } = makeInput();
    pads = [pad([], [1, -1, 0, 0])];
    input.pollPads();
    const n = input.sample(FlightMode.Normal, 0.05);
    expect(n.thrust[0]).toBeCloseTo(1);
    expect(n.thrust[2]).toBeCloseTo(1);
    const c = input.sample(FlightMode.Cruise, 0.1);
    expect(c.thrust[2]).toBe(0);
    expect(c.throttle).toBeCloseTo(0.07);
  });

  it('holds buttons for the tick input and drops them when the pad vanishes', () => {
    const { input } = makeInput();
    pads = [pad([7])];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).buttons & 1).toBe(1);
    pads = [];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).buttons & 1).toBe(0);
  });

  it('keeps presses silent while the binding screen listens, and in panels except toggles', () => {
    const { input, actions } = makeInput();
    store.padCapturing.value = true;
    pads = [pad([9])];
    input.pollPads();
    expect(actions).toEqual([]);
    store.padCapturing.value = false;
    store.panel.value = 'station';
    pads = [pad([13])];
    input.pollPads();
    expect(actions).toEqual([]);
    pads = [pad([13, 3])];
    input.pollPads();
    pads = [pad([3, 8])];
    input.pollPads();
    expect(actions).toEqual(['galaxyMap']);
  });

  it('does not fire when the modifier of a chord is let go before its target', () => {
    const { input } = makeInput();
    input.setMode(FlightMode.Normal);
    // Y + RT is throttle up; RT alone fires.
    for (const d of [[3], [3, 7], [7]]) {
      pads = [pad(d)];
      input.pollPads();
    }
    expect(input.throttle).toBeCloseTo(0.1);
    expect(input.sample(FlightMode.Normal, 0.05).buttons & 1).toBe(0);
    pads = [pad()];
    input.pollPads();
    pads = [pad([7])];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).buttons & 1).toBe(1);
  });

  it('keeps a button that closed a panel silent until it is let go', () => {
    const { input } = makeInput();
    // A on "Resume": the panel closes while A, which is thrust up in flight, is still down.
    store.device.value = 'pad';
    store.panel.value = 'menu';
    pads = [pad([0])];
    input.pollPads();
    store.panel.value = null;
    input.pollPads();
    expect(input.active()).toBe(true);
    expect(input.sample(FlightMode.Normal, 0.05).thrust[1]).toBe(0);
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).thrust[1]).toBe(0);
    // Let go and press again: now it is thrust.
    pads = [pad()];
    input.pollPads();
    pads = [pad([0])];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).thrust[1]).toBe(1);
  });

  it('also when the panel closes in the very frame the button goes down', () => {
    const { input } = makeInput();
    store.device.value = 'pad';
    store.panel.value = 'menu';
    pads = [pad()];
    input.pollPads();
    // The menu loop saw B first and closed the panel before this loop reads the pad.
    store.panel.value = null;
    pads = [pad([1])];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).thrust[1]).toBe(0);
    pads = [pad()];
    input.pollPads();
    pads = [pad([1])];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).thrust[1]).toBe(-1);
  });

  it('keeps a button from the start screen silent, but not one held through a fold', () => {
    const { input } = makeInput();
    store.device.value = 'pad';
    // A on "Launch" is still down when the game starts.
    store.phase.value = 'connecting';
    pads = [pad([0])];
    input.pollPads();
    store.phase.value = 'playing';
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).thrust[1]).toBe(0);
    pads = [pad()];
    input.pollPads();
    // No menu takes the pad between two servers, so fire held through the jump keeps firing.
    pads = [pad([7])];
    input.pollPads();
    store.phase.value = 'handoff';
    input.pollPads();
    store.phase.value = 'playing';
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).buttons & 1).toBe(1);
  });

  it('fires at once with the press that takes the device over from the mouse', () => {
    const { input } = makeInput();
    store.pointerLocked.value = false;
    expect(input.active()).toBe(false);
    pads = [pad([7])];
    input.pollPads();
    expect(input.sample(FlightMode.Normal, 0.05).buttons & 1).toBe(1);
  });

  it('lets the lever take over the setpoint only when it moves', () => {
    const { input } = makeInput();
    store.settings.value = {
      ...DEFAULT_SETTINGS,
      pad: { turnRate: 1, axes: { throttle: [{ dev: 'std', axis: 2, invert: false, deadzone: 0, curve: 1, lever: true }] } },
    };
    input.setMode(FlightMode.Normal);
    store.device.value = 'pad';
    pads = [pad([], [0, 0, 0.5, 0])];
    input.pollPads();
    expect(input.throttle).toBe(0);
    pads = [pad([], [0, 0, 0.51, 0])];
    input.pollPads();
    expect(input.throttle).toBe(0);
    pads = [pad([], [0, 0, 1, 0])];
    input.pollPads();
    expect(input.throttle).toBeCloseTo(1);
    input.throttle = 0.4;
    input.pollPads();
    expect(input.throttle).toBeCloseTo(0.4);
  });

  it('works on a page without the Gamepad API', () => {
    vi.stubGlobal('window', { addEventListener: () => {} });
    vi.stubGlobal('document', { addEventListener: () => {}, activeElement: null, pointerLockElement: null });
    vi.stubGlobal('navigator', { language: 'en' });
    const input = new Input({} as HTMLCanvasElement);
    expect(() => input.pollPads()).not.toThrow();
    expect(input.snapshot()).toEqual([]);
    input.testMode = true;
    expect(input.sample(FlightMode.Normal, 0.05).thrust).toEqual([0, 0, 0]);
  });
});

describe('settings with pad codes', () => {
  const store0 = (raw: unknown): void => {
    const mem = new Map<string, string>([['primacy2.settings', JSON.stringify(raw)]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
  };
  it('adds the pad defaults to settings saved by an older version', () => {
    store0({ lang: 'de', bindings: { dock: ['KeyF'], firePrimary: ['Mouse0'] } });
    loadSettings();
    const b = store.settings.value.bindings;
    expect(b.dock).toEqual(['KeyF', 'Pad:std:b3+b0']);
    expect(b.firePrimary).toContain('Pad:std:b7');
    expect(b.cruise).toContain('Pad:std:b8');
    expect(store.settings.value.pad.axes.yaw?.[0]?.axis).toBe(2);
  });
  it('keeps a cleared pad binding cleared', () => {
    store0({ bindings: { dock: ['KeyF'] }, padCleared: ['dock'] });
    loadSettings();
    expect(store.settings.value.bindings.dock).toEqual(['KeyF']);
  });
  it('leaves a customised pad list alone', () => {
    store0({ bindings: { dock: ['KeyF', 'Pad:std:b5'] } });
    loadSettings();
    expect(store.settings.value.bindings.dock).toEqual(['KeyF', 'Pad:std:b5']);
  });
  it('moves a pad button whose default went to a new action over to it', () => {
    // Saved while D-pad left and right still stepped through ships, before places had actions.
    store0({ bindings: { targetNext: ['KeyT', 'Pad:std:b15'], targetPrev: ['KeyG', 'Pad:std:b14'], dock: ['KeyF', 'Pad:std:b3+b0'] } });
    loadSettings();
    const b = store.settings.value.bindings;
    expect(b.navNext).toEqual(['KeyO', 'Mouse4', 'Pad:std:b15']);
    expect(b.navPrev).toEqual(['KeyL', 'Pad:std:b14']);
    expect(b.targetNext).toEqual(['KeyT']);
    expect(b.targetPrev).toEqual(['KeyG']);
    expect(b.dock).toEqual(['KeyF', 'Pad:std:b3+b0']);
    // No pad button does two things.
    const pad = Object.values(b).flat().filter((c) => c.startsWith('Pad:'));
    expect(new Set(pad).size).toBe(pad.length);
  });
  it('leaves the buttons alone once the save knows the new actions', () => {
    // The pilot put ship stepping back on the D-pad and places elsewhere.
    store0({ bindings: { targetNext: ['KeyT', 'Pad:std:b15'], navNext: ['KeyO', 'Pad:std:b5'], navPrev: ['KeyL'] }, padCleared: ['navPrev'] });
    loadSettings();
    const b = store.settings.value.bindings;
    expect(b.targetNext).toEqual(['KeyT', 'Pad:std:b15']);
    expect(b.navNext).toEqual(['KeyO', 'Pad:std:b5']);
    expect(b.navPrev).toEqual(['KeyL']);
  });
  it('hands over only the button that moved, from the action that had it', () => {
    expect(handOver({ dock: ['KeyF'] })).toEqual({ dock: ['KeyF'] });
    expect(handOver({ targetNext: ['Pad:std:b15'], camera: ['KeyV', 'Pad:std:b14'] })).toEqual({ targetNext: [], camera: ['KeyV', 'Pad:std:b14'] });
  });
  it('does not add a default whose button the pilot gave to another action', () => {
    store0({ bindings: { camera: ['KeyV', 'Pad:std:b14'] } });
    loadSettings();
    const b = store.settings.value.bindings;
    expect(b.camera).toEqual(['KeyV', 'Pad:std:b14']);
    expect(b.navPrev).toEqual(['KeyL']);
    expect(b.navNext).toContain('Pad:std:b15');
  });
  it('loads settings without any pad fields', () => {
    store0({ volume: 0.2 });
    loadSettings();
    expect(store.settings.value.pad.turnRate).toBe(1);
    expect(store.settings.value.padCleared).toEqual([]);
  });
});

describe('binding edits', () => {
  const base = (): { bindings: typeof DEFAULT_SETTINGS.bindings; padCleared: BindAction[]; pad: typeof DEFAULT_SETTINGS.pad } =>
    ({ bindings: DEFAULT_SETTINGS.bindings, padCleared: [], pad: DEFAULT_SETTINGS.pad });
  it('assign replaces the pad code, keeps the keyboard code and takes the code from its old owner', () => {
    const r = assignPad(base(), 'dock', 'Pad:std:b2');
    expect(r.bindings.dock).toEqual(['KeyF', 'Pad:std:b2']);
    expect(r.bindings.fireTool).toEqual(['Mouse1', 'KeyR']);
    expect(r.padCleared).toContain('fireTool');
  });
  it('clear records the action so that it stays cleared after a reload', () => {
    const r = clearPad(base(), 'dock');
    expect(r.bindings.dock).toEqual(['KeyF']);
    expect(addPadDefaults(r.bindings, r.padCleared).dock).toEqual(['KeyF']);
    expect(assignPad(r, 'dock', 'Pad:std:b4').padCleared).not.toContain('dock');
  });
  it('reset brings the defaults back and the joystick preset adds its device', () => {
    const cleared = clearPad(base(), 'dock');
    expect(resetPad(cleared).bindings.dock).toEqual(['KeyF', 'Pad:std:b3+b0']);
    const j = presetJoystick(base(), '044f-b10a');
    expect(j.bindings.firePrimary).toContain('Pad:044f-b10a:b0');
    expect(j.bindings.firePrimary).toContain('Pad:std:b7');
    expect(j.pad.axes.yaw?.length).toBe(2);
  });
});
