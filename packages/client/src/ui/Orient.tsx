/**
 * The parts of the HUD that lead the pilot to places and ships: arrows for what is off screen,
 * the compass, the panel of the chosen place, the lines that say what the system holds, and the
 * list of places that opens while the pilot steps through them.
 */
import { EntityKind, type Vec3 } from '@primacy2/shared';
import type { FrameView } from '../contracts.ts';
import { t, type StringKey } from '../i18n/index.ts';
import { PLACE_LIST_MS, findPlace, listPlaces, listWindow, type PlaceEntry } from '../state/places.ts';
import { store, type BindAction } from '../state/store.ts';
import { bindKey, fmtDistance, fmtDuration, fmtSpeed, hasBinding } from './format.ts';
import { arrival, declutter, edgeMark, type Box, type CompassDot, type RangeRate } from './orient.ts';

/** Rows of the list of places that are shown at once. */
const LIST_ROWS = 8;
/** A closing speed below this reads as standing still, m/s. */
const RATE_SHOWN = 0.5;

/** Something off screen that gets an arrow. */
export interface EdgeItem {
  key: string;
  /** Position in camera space (x right, y up, view along -z). */
  c: Vec3;
  /** Colour class: `place`, `nav`, `ship`, `hostile`, `pilot`, `loot`. */
  cls: string;
  name: string;
  dist: number;
  /** The chosen place or the locked ship: a large arrow that says when its target is behind. */
  big: boolean;
}

/** The angle each arrow had last, kept for the moment its target is dead astern. */
const heldAngle = new Map<string, number>();

/** The size of 1em of the interface in pixels, as the style sheet sets it from the width of the view. */
const emPx = (w: number): number => Math.min(17, Math.max(11, w * 0.0085)) * 1.15;

export function EdgeArrows({ items, w, h }: { items: EdgeItem[]; w: number; h: number }) {
  // Labels give way to more important ones: the chosen targets first, then the nearest.
  const order = [...items].sort((a, b) => Number(b.big) - Number(a.big) || a.dist - b.dist);
  const em = emPx(w);
  const live = new Set<string>();
  const marks = order.map((it) => {
    live.add(it.key);
    const m = edgeMark(it.c, w, h, heldAngle.get(it.key));
    heldAngle.set(it.key, m.angle);
    return m;
  });
  for (const key of heldAngle.keys()) if (!live.has(key)) heldAngle.delete(key);

  const texts = order.map((it, i) => (it.big && marks[i]!.behind ? `${fmtDistance(it.dist)} · ${t('hud.behind')}` : fmtDistance(it.dist)));
  const boxes: Box[] = order.map((it, i) => {
    const m = marks[i]!;
    const size = em * (it.big ? 0.95 : 0.85);
    const width = Math.max(it.name.length, texts[i]!.length) * size * 0.56 + 6;
    const gap = it.big ? 20 : 14;
    const left = m.x >= w / 2;
    const x0 = left ? m.x - gap - width : m.x + gap;
    return { x0, y0: m.y - size * 1.3, x1: x0 + width, y1: m.y + size * 1.3 };
  });
  const labelled = declutter(boxes);

  return (
    <>
      {order.map((it, i) => {
        const m = marks[i]!;
        return (
          <div
            key={it.key} class={`edge ${it.cls} ${it.big ? 'big' : ''} ${m.x >= w / 2 ? 'left' : 'right'} ${m.behind ? 'behind' : ''}`}
            style={{ transform: `translate(${m.x}px, ${m.y}px)` }}
          >
            <svg class="edge-glyph" viewBox="-13 -13 26 26" style={{ rotate: `${(m.angle * 180) / Math.PI}deg` }}>
              <path d="M-5 -8 L7 0 L-5 8" />
              {/* A second chevron trails the first while the target is behind the pilot. */}
              {m.behind && <path class="tail" d="M-12 -6 L-3 0 L-12 6" />}
            </svg>
            {labelled[i] && <span class="edge-text">{it.name}<em>{texts[i]}</em></span>}
          </div>
        );
      })}
    </>
  );
}

export interface CompassMark extends CompassDot {
  key: string;
  cls: string;
}

/** The compass beside the speed readout: one dot per chosen target, filled ahead and hollow behind. */
export function Compass({ marks }: { marks: CompassMark[] }) {
  if (marks.length === 0) return null;
  return (
    <div class="compass">
      {marks.map((d) => (
        <i key={d.key} class={`compass-dot ${d.cls} ${d.front ? 'front' : ''}`} style={{ left: `${50 + d.x * 40}%`, top: `${50 + d.y * 40}%` }} />
      ))}
    </div>
  );
}

/** The two lines of a target panel that say how the distance changes: closing speed and time of arrival. */
export function RateLines({ dist, rate }: { dist: number; rate: RangeRate | null }) {
  const closing = rate?.ready ? rate.closing : 0;
  const eta = arrival(dist, rate);
  return (
    <>
      <div class="pair">
        <span class="dim">{t(closing > -RATE_SHOWN ? 'hud.closing' : 'hud.receding')}</span>
        <span class="num">{fmtSpeed(Math.abs(closing) < RATE_SHOWN ? 0 : Math.abs(closing))}</span>
      </div>
      <div class="pair">
        <span class="dim">{t('hud.arrival')}</span>
        <span class="num">{eta === null ? '--' : fmtDuration(eta)}</span>
      </div>
    </>
  );
}

/** The chosen place: what it is, how far, whether it lies behind, and how fast the ship closes on it. */
export function PlacePanel({ place, behind, rate }: { place: PlaceEntry; behind: boolean; rate: RangeRate | null }) {
  return (
    <div class="panel-mini place">
      <h4>{t('hud.nav')}</h4>
      <div class="big">{place.name}</div>
      <div class="dim">{t(`kind.${place.kind}` as StringKey)}</div>
      <div class="pair">
        <span class="num">{fmtDistance(place.dist)}</span>
        {behind && <span class="dim">{t('hud.behind')}</span>}
      </div>
      <RateLines dist={place.dist} rate={rate} />
    </div>
  );
}

function Keycap({ action }: { action: BindAction }) {
  return <span class="keycap">{bindKey(action)}</span>;
}

/** "Docks 4 · Gates 1": the kinds that occur, each with its count. */
function counts(parts: [StringKey, number][]): string {
  return parts.filter(([, n]) => n > 0).map(([key, n]) => `${t(key)} ${n}`).join(' · ');
}

/**
 * What the system holds, always in view: how many places of each kind and what is in sensor
 * range, each with the controls that choose among them and open the full list.
 */
export function SystemLines({ view }: { view: FrameView }) {
  const places = listPlaces(view);
  const of = (group: PlaceEntry['group']): number => places.filter((p) => p.group === group).length;
  const contacts = store.contacts.value;
  const kind = (k: EntityKind): number => contacts.filter((c) => c.info.kind === k).length;
  const inRange = counts([['hud.ships', kind(EntityKind.Ship)], ['hud.wrecks', kind(EntityKind.Wreck)], ['hud.pods', kind(EntityKind.Loot)]]);
  return (
    <div class="sys-lines">
      <div class="sys-line">
        <span class="sys-label">{t('hud.places')}</span>
        <span>{counts([['hud.docks', of('dock')], ['hud.gates', of('gate')], ['hud.otherSites', of('site')], ['hud.bodies', of('body')]])}</span>
        <span class="sys-keys">
          <Keycap action="navPrev" /><Keycap action="navNext" /> {t('hud.choose')} · <Keycap action="systemMap" /> {t('hud.list')}
        </span>
      </div>
      <div class="sys-line">
        <span class="sys-label">{t('hud.contacts')}</span>
        <span class={inRange ? '' : 'dim'}>{inRange || t('hud.noneInRange')}</span>
        <span class="sys-keys">
          {/* A standard pad steps through ships with the control that takes what is ahead. */}
          {hasBinding('targetNext') && hasBinding('targetPrev')
            ? <><Keycap action="targetPrev" /><Keycap action="targetNext" /></>
            : <Keycap action="targetAhead" />}
          {' '}{t('hud.lock')} · <Keycap action="contacts" /> {t('hud.list')}
        </span>
      </div>
    </div>
  );
}

/**
 * The list of places, open while the pilot steps through it: a window of rows around the chosen
 * one, in the order the stepping follows.
 */
export function PlaceList({ view, now }: { view: FrameView; now: number }) {
  const open = store.navList.value;
  if (!open || now - open.at >= PLACE_LIST_MS) return null;
  const rows = open.ids.map((id) => findPlace(view, id)).filter((p): p is PlaceEntry => p !== null);
  if (rows.length === 0) return null;
  const selected = rows.findIndex((p) => p.id === view.navAnchor);
  const { start, count } = listWindow(rows.length, selected, LIST_ROWS);
  const below = rows.length - start - count;
  return (
    <div class="place-list">
      {start > 0 && <div class="place-more">▴ {t('hud.more', { n: start })}</div>}
      {rows.slice(start, start + count).map((p) => (
        <div key={p.id} class={`place-row g-${p.group} ${p.id === view.navAnchor ? 'on' : ''}`}>
          <span class="place-glyph" />
          <span class="place-name">{p.name} <span class="place-kind">{t(`kind.${p.kind}` as StringKey)}</span></span>
          <span class="num">{fmtDistance(p.dist)}</span>
        </div>
      ))}
      {below > 0 && <div class="place-more">▾ {t('hud.more', { n: below })}</div>}
    </div>
  );
}
