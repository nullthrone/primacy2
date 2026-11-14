import { describe, expect, it } from 'vitest';
import type { BodyDef, SiteDef, SiteKind, Vec3 } from '@primacy2/shared';
import type { BodyView, SiteView } from '../contracts.ts';
import { aheadChoice, findPlace, isDock, isLandmark, listPlaces, listWindow, placeAhead, stepPlace } from './places.ts';

const site = (id: number, kind: SiteKind, rel: Vec3, name = `${kind} ${id}`): SiteView => ({
  def: { id, kind, name } as SiteDef, rel, dist: Math.hypot(...rel),
});
const body = (id: number, kind: string, radius: number, rel: Vec3): BodyView => ({
  def: { id, kind, name: `body ${id}`, radius } as BodyDef, rel, dist: Math.hypot(...rel),
});

/** A system with every group, deliberately out of order. */
const view = {
  sites: [
    site(1000, 'beacon', [0, 0, -5e9]),
    site(1001, 'station', [0, 0, -9e9]),
    site(1002, 'gate', [3e9, 0, 0]),
    site(1003, 'base', [0, 2e6, 0]),
    site(1004, 'belt', [1e8, 0, 0]),
    site(1005, 'outpost', [0, 0, 4e9]),
  ],
  bodies: [
    body(0, 'star', 7e8, [0, 0, -1.5e11]),
    body(1, 'planet', 6e6, [0, 1e7, 0]),
  ],
};

describe('the list of places', () => {
  it('puts places to dock first, then gates, other sites and bodies, each nearest first', () => {
    expect(listPlaces(view).map((p) => p.id)).toEqual([1003, 1005, 1001, 1002, 1004, 1000, 1, 0]);
    expect(listPlaces(view).map((p) => p.group)).toEqual(['dock', 'dock', 'dock', 'gate', 'site', 'site', 'body', 'body']);
  });

  it('measures a body to its surface and a site to its centre', () => {
    const list = listPlaces(view);
    expect(list.find((p) => p.id === 1)!.dist).toBeCloseTo(1e7 - 6e6, 3);
    expect(list.find((p) => p.id === 1003)!.dist).toBeCloseTo(2e6, 3);
    // Inside a body the distance does not turn negative.
    expect(listPlaces({ sites: [], bodies: [body(2, 'moon', 5e5, [0, 1e5, 0])] })[0]!.dist).toBe(0);
  });

  it('knows what can be docked at and what keeps a marker at the edge', () => {
    const kinds: SiteKind[] = ['station', 'outpost', 'base', 'gate', 'beacon', 'belt', 'ring', 'anomaly'];
    expect(kinds.filter(isDock)).toEqual(['station', 'outpost', 'base']);
    expect(kinds.filter(isLandmark)).toEqual(['station', 'outpost', 'base', 'gate']);
  });

  it('finds a site or a body by its anchor id', () => {
    expect(findPlace(view, 1002)?.kind).toBe('gate');
    expect(findPlace(view, 1)?.kind).toBe('planet');
    expect(findPlace(view, 77)).toBeNull();
    expect(findPlace(view, null)).toBeNull();
  });
});

describe('stepping through places', () => {
  const order = [1003, 1005, 1001, 1002];

  it('starts at the nearest place to dock and goes around the ends', () => {
    expect(stepPlace(order, null, 1)).toBe(1003);
    expect(stepPlace(order, 1003, 1)).toBe(1005);
    expect(stepPlace(order, 1002, 1)).toBe(1003);
    expect(stepPlace(order, 1003, -1)).toBe(1002);
  });

  it('starts backward at the last entry, and anew for a choice that is not in the order', () => {
    expect(stepPlace(order, null, -1)).toBe(1002);
    expect(stepPlace(order, 4, 1)).toBe(1003);
    expect(stepPlace(order, 4, -1)).toBe(1002);
  });

  it('has nothing to give in an empty system', () => {
    expect(stepPlace([], null, 1)).toBeNull();
    expect(stepPlace([], 1003, -1)).toBeNull();
  });
});

describe('the place ahead of the nose', () => {
  const cone = Math.cos((25 * Math.PI) / 180);

  it('is the one closest to the direction of the nose', () => {
    // Looking along -z: the beacon and the station are both dead ahead; the list order decides.
    expect(placeAhead(view, [0, 0, 0], [0, 0, -1], cone)?.id).toBe(1001);
    expect(placeAhead(view, [0, 0, 0], [1, 0, 0], cone)?.id).toBe(1002);
    expect(placeAhead(view, [0, 0, 0], [0, 0, 1], cone)?.id).toBe(1005);
  });

  it('is nothing when no place lies within the cone', () => {
    expect(placeAhead(view, [0, 0, 0], [-1, 0, 0], cone)).toBeNull();
  });

  it('looks from the ship, not from the camera', () => {
    // From far out on +x the gate lies back toward -x.
    expect(placeAhead(view, [9e9, 0, 0], [-1, 0, 0], Math.cos(0.01))?.id).toBe(1002);
  });
});

describe('what "target ahead" does', () => {
  const SHIP = 7;
  const OTHER = 8;
  const STATION = 1001;
  const HOME = 1005;

  it('locks the ship in the cone, whatever place lies there too', () => {
    expect(aheadChoice(SHIP, STATION, null, null, true)).toEqual({ do: 'lock', id: SHIP });
    expect(aheadChoice(SHIP, STATION, OTHER, HOME, true)).toEqual({ do: 'lock', id: SHIP });
  });

  it('never takes a place while a ship is in the cone: the chosen place stays', () => {
    // Pressed again on the ship that is locked already, with a station behind it.
    expect(aheadChoice(SHIP, STATION, SHIP, HOME, true)).toEqual({ do: 'nextShip' });
    expect(aheadChoice(SHIP, STATION, SHIP, null, true)).toEqual({ do: 'nextShip' });
    // A wreck is locked and no ship is in range to step on to: nothing happens.
    expect(aheadChoice(SHIP, STATION, SHIP, HOME, false)).toEqual({ do: 'nothing' });
  });

  it('takes the place the nose points at while no ship is in the cone', () => {
    expect(aheadChoice(null, STATION, null, null, false)).toEqual({ do: 'place', id: STATION });
    expect(aheadChoice(null, STATION, OTHER, HOME, true)).toEqual({ do: 'place', id: STATION });
  });

  it('steps on to the next ship when nothing new lies ahead', () => {
    expect(aheadChoice(null, STATION, null, STATION, true)).toEqual({ do: 'nextShip' });
    expect(aheadChoice(null, null, null, null, true)).toEqual({ do: 'nextShip' });
    expect(aheadChoice(null, null, OTHER, HOME, false)).toEqual({ do: 'nothing' });
  });
});

describe('the window of the list on the HUD', () => {
  it('shows everything when the list is short', () => {
    expect(listWindow(5, 3, 8)).toEqual({ start: 0, count: 5 });
  });

  it('keeps the selection in view and stops at the ends', () => {
    expect(listWindow(19, 0, 8)).toEqual({ start: 0, count: 8 });
    expect(listWindow(19, 9, 8)).toEqual({ start: 6, count: 8 });
    expect(listWindow(19, 18, 8)).toEqual({ start: 11, count: 8 });
    for (let sel = 0; sel < 19; sel++) {
      const w = listWindow(19, sel, 8);
      expect(sel >= w.start && sel < w.start + w.count).toBe(true);
    }
  });

  it('starts at the top with nothing selected', () => {
    expect(listWindow(19, -1, 8)).toEqual({ start: 0, count: 8 });
  });
});
