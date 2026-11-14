/**
 * The places of a system as a pilot chooses among them: places to dock first, then gates, the
 * other sites and last the celestial bodies, each group nearest first. The game core steps
 * through this order and picks from it what lies ahead of the nose; the interface lists it.
 * Pure functions over a frame view, so that both sides agree and the rules are testable.
 */
import { v3, type Quat, type SiteKind, type Vec3, quat } from '@primacy2/shared';
import type { BodyView, FrameView, SiteView } from '../contracts.ts';

/** Where a place stands in the order of the list. */
export type PlaceGroup = 'dock' | 'gate' | 'site' | 'body';

export interface PlaceEntry {
  /** Anchor id: a site id or a body id, as `store.navAnchor` holds it. */
  id: number;
  group: PlaceGroup;
  /** Key of the word for its kind: a site kind, or the kind of a body (`star`, `planet`, `moon`). */
  kind: string;
  name: string;
  /** Metres from the camera: to the site, or to the surface of a body. */
  dist: number;
  /** Position relative to the camera, system axes. */
  rel: Vec3;
}

const GROUP_ORDER: Record<PlaceGroup, number> = { dock: 0, gate: 1, site: 2, body: 3 };

/** How long the HUD keeps its list of places open after the last step, milliseconds. */
export const PLACE_LIST_MS = 6000;
/** Cosine of the half angle of the cone in which "target ahead" looks: about 26 degrees. */
export const AHEAD_COS = 0.9;

/** A place a ship can dock at. */
export function isDock(kind: SiteKind): boolean {
  return kind === 'station' || kind === 'outpost' || kind === 'base';
}

/** Places that keep a marker of their own at the screen edge: everything to dock at, and gates. */
export function isLandmark(kind: SiteKind): boolean {
  return isDock(kind) || kind === 'gate';
}

function siteEntry(s: SiteView): PlaceEntry {
  const group: PlaceGroup = isDock(s.def.kind) ? 'dock' : s.def.kind === 'gate' ? 'gate' : 'site';
  return { id: s.def.id, group, kind: s.def.kind, name: s.def.name, dist: s.dist, rel: s.rel };
}

function bodyEntry(b: BodyView): PlaceEntry {
  return { id: b.def.id, group: 'body', kind: b.def.kind, name: b.def.name, dist: Math.max(0, b.dist - b.def.radius), rel: b.rel };
}

/** Every place of the system in list order. */
export function listPlaces(view: Pick<FrameView, 'sites' | 'bodies'>): PlaceEntry[] {
  const out = [...view.sites.map(siteEntry), ...view.bodies.map(bodyEntry)];
  // Ties keep the order of the system definition, so that the list does not flicker.
  return out.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.dist - b.dist || a.id - b.id);
}

/** One place by its anchor id, or null when the system has none with that id. */
export function findPlace(view: Pick<FrameView, 'sites' | 'bodies'>, id: number | null): PlaceEntry | null {
  if (id === null) return null;
  const site = view.sites.find((s) => s.def.id === id);
  if (site) return siteEntry(site);
  const body = view.bodies.find((b) => b.def.id === id);
  return body ? bodyEntry(body) : null;
}

/**
 * The next place after `current` in `order` (`dir` 1) or the one before it (`dir` -1), around the
 * ends. With nothing chosen, or something that is not in the order, forward starts at the first
 * entry and backward at the last. Null only for an empty order.
 */
export function stepPlace(order: readonly number[], current: number | null, dir: 1 | -1): number | null {
  if (order.length === 0) return null;
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return order[dir > 0 ? 0 : order.length - 1]!;
  return order[(i + dir + order.length) % order.length]!;
}

/**
 * The place nearest to the direction `fwd` (a unit vector in system axes), if it lies within the
 * cone whose half angle has the cosine `minCos`. `from` is where the looking is done from,
 * relative to the camera: the pilot's ship.
 */
export function placeAhead(
  view: Pick<FrameView, 'sites' | 'bodies'>, from: Readonly<Vec3>, fwd: Readonly<Vec3>, minCos: number,
): PlaceEntry | null {
  let best: PlaceEntry | null = null;
  let bestCos = minCos;
  for (const p of listPlaces(view)) {
    const d = v3.sub(p.rel, from);
    const len = v3.len(d);
    if (len < 1) continue;
    const c = v3.dot(d, fwd) / len;
    if (c > bestCos) {
      bestCos = c;
      best = p;
    }
  }
  return best;
}

/** What a press of "target ahead" does. */
export type AheadChoice = { do: 'lock'; id: number } | { do: 'place'; id: number } | { do: 'nextShip' } | { do: 'nothing' };

/**
 * The rule of "target ahead". `ship` is the ship, wreck or pod nearest to the nose within the
 * cone ahead and `place` the place nearest to it there (null for none); `locked` and `chosen` are
 * the ship lock and the chosen place as they stand.
 *
 * - A ship in the cone is locked, unless it is locked already.
 * - A place is taken only while no ship is in the cone, and only if it is not chosen already. The
 *   owner decided this on 2026-11-14: a press in a fight must never replace the destination.
 * - With nothing new ahead the lock steps on to the next ship in range, if there is one, so that
 *   this one control reaches every ship.
 */
export function aheadChoice(ship: number | null, place: number | null, locked: number | null, chosen: number | null, shipsInRange: boolean): AheadChoice {
  if (ship !== null && ship !== locked) return { do: 'lock', id: ship };
  if (ship === null && place !== null && place !== chosen) return { do: 'place', id: place };
  return shipsInRange ? { do: 'nextShip' } : { do: 'nothing' };
}

/** The direction a ship with orientation `rot` points in, system axes. */
export function noseOf(rot: Readonly<Quat>): Vec3 {
  return quat.rotate(rot as Quat, [0, 0, -1]);
}

/**
 * The rows of a list of `total` entries that fit a window of `size` rows with the entry `selected`
 * in it: the first row shown and the count. The selection stands in the middle of the window
 * wherever the ends of the list allow it.
 */
export function listWindow(total: number, selected: number, size: number): { start: number; count: number } {
  const count = Math.min(total, Math.max(1, size));
  if (selected < 0) return { start: 0, count };
  const start = Math.min(Math.max(0, selected - Math.floor((count - 1) / 2)), total - count);
  return { start, count };
}
