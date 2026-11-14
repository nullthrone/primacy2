/**
 * The decisions the menus make for a controller, as far as they run without a page: what the pause
 * menu offers, what the binding screen does with a press while it listens, and how labels read.
 * That the screens call these, and that a pad reaches the controls, is played in a browser by
 * `scripts/pad-check.mjs`.
 */
import { sanitizeName, type StationView } from '@primacy2/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, store } from '../state/store.ts';
import { bindKey, bindKeyShort, listenHint, padWords } from '../ui/format.ts';
import { madeUpPilotName, pauseRoot, startName, stationReturn } from '../ui/Menu.tsx';

beforeEach(() => {
  store.settings.value = { ...DEFAULT_SETTINGS, lang: 'en' };
  store.phase.value = 'playing';
  store.panel.value = null;
  store.station.value = null;
  store.device.value = 'keys';
  store.padStyle.value = 'xbox';
});

describe('the way back to the station screen', () => {
  it('is offered while docked and opens the station screen', () => {
    store.station.value = { site: 1 } as unknown as StationView;
    // The pilot closed the screen; the pause menu is open.
    store.panel.value = 'menu';
    const back = stationReturn();
    expect(back).not.toBeNull();
    back!();
    expect(store.panel.value).toBe('station');
  });
  it('is not offered in space', () => {
    store.panel.value = 'menu';
    expect(stationReturn()).toBeNull();
  });
});

describe('pad labels in the language of the interface', () => {
  const german = (): void => { store.settings.value = { ...DEFAULT_SETTINGS, lang: 'de' }; };
  it('spells the D-pad out in sentences and on the binding screen', () => {
    store.device.value = 'pad';
    expect(bindKey('powerShields')).toBe('Y + D-pad left');
    german();
    // The German help text calls it "Steuerkreuz"; the rows beside it must not say "D-pad left".
    expect(bindKey('powerShields')).toBe('Y + Steuerkreuz links');
    expect(bindKey('targetAhead')).toBe('Steuerkreuz hoch');
    expect(padWords().axis).toBe('Achse');
    expect(padWords().button).toBe('Taste');
  });
  it('keeps the short key caps of the HUD as they are', () => {
    store.device.value = 'pad';
    german();
    expect(bindKeyShort('powerShields')).toBe('Y+D←');
    expect(bindKeyShort('cruise')).toBe('View');
  });
});

describe('what the binding screen says while it listens', () => {
  it('names the button that opens the pause menu as the way to cancel a button assignment', () => {
    expect(listenHint('action')).toContain('Menu or Esc cancels.');
    store.padStyle.value = 'playstation';
    expect(listenHint('action')).toContain('Options or Esc cancels.');
  });
  it('follows the menu action to another button', () => {
    const s = store.settings.value;
    store.settings.value = { ...s, bindings: { ...s.bindings, menu: ['Escape', 'Pad:std:b16'] } };
    expect(listenHint('action')).toContain('Guide or Esc cancels.');
  });
  it('names only Esc when the pause menu has no controller code', () => {
    const s = store.settings.value;
    store.settings.value = { ...s, bindings: { ...s.bindings, menu: ['Escape'] } };
    expect(listenHint('action')).toMatch(/combination\. Esc cancels\.$/);
  });
  it('says that any button cancels the wait for an axis', () => {
    expect(listenHint('axis')).toContain('Any button or Esc cancels.');
    store.settings.value = { ...DEFAULT_SETTINGS, lang: 'de' };
    expect(listenHint('axis')).toContain('Eine beliebige Taste oder Esc bricht ab.');
  });
});

describe('the pilot name the start screen begins with', () => {
  it('is the saved name when there is one', () => {
    expect(startName('Thora')).toBe('Thora');
  });
  it('is a made-up name otherwise, so that a pilot without a keyboard can launch', () => {
    const made = startName('');
    expect(made).toMatch(/^\p{L}+ \d{4}$/u);
    // The launch button asks for two characters, the field takes 24, and the server keeps the name as it is.
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(made.length).toBeLessThanOrEqual(24);
    expect(sanitizeName(made)).toBe(made);
  });
  it('is a word and four digits for every draw', () => {
    for (const r of [0, 0.0001, 0.37, 0.5, 0.9999]) {
      const made = madeUpPilotName(() => r);
      expect(made, String(r)).toMatch(/^\p{L}+ \d{4}$/u);
      expect(sanitizeName(made)).toBe(made);
    }
    expect(madeUpPilotName(() => 0)).not.toBe(madeUpPilotName(() => 0.9999));
  });
});

describe('the two screens of the pause menu', () => {
  it('have different keys, so that the binding screen is a new node and gets a focus of its own', () => {
    const menu = pauseRoot('menu', null);
    const bindings = pauseRoot('bindings', null);
    expect(menu.key).toBeTruthy();
    expect(bindings.key).toBeTruthy();
    expect(menu.key).not.toBe(bindings.key);
    // Both are the panel the controller navigation looks for.
    expect(String(menu.props.class)).toContain('panel');
    expect(String(bindings.props.class)).toContain('panel');
  });
});
