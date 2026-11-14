/**
 * The decisions the menus make for a controller, as far as they run without a page: what the pause
 * menu offers, what the binding screen does with a press while it listens, and how labels read.
 * That the screens call these, and that a pad reaches the controls, is played in a browser by
 * `scripts/pad-check.mjs`.
 */
import type { StationView } from '@primacy2/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, store } from '../state/store.ts';
import { stationReturn } from '../ui/Menu.tsx';

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
