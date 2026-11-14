/**
 * The parts of the HUD that lead the pilot to places and ships: arrows for what is off screen,
 * the compass, the radar, the panel of the chosen place, the lines that say what the system
 * holds, and the list of places that opens while the pilot steps through them.
 */
import { EntityKind, type Vec3 } from '@primacy2/shared';
import type { FrameView } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { PLACE_LIST_MS, findPlace, listPlaces, listWindow, type PlaceEntry } from '../state/places.ts';
import { store, type BindAction } from '../state/store.ts';
import { bindKeyShort, fmtDistance, fmtDuration, fmtSpeed, hasBinding } from './format.ts';
import {
  RADAR_REACH, RADAR_RINGS, RADAR_SQUASH, arrival, declutter, edgeMark, pullClear, radarBlip, radarRadius, radarRim,
  type Box, type CompassDot, type EdgeMark,
} from './orient.ts';

/** Rows of the list of places that are shown at once, by the height of the view: a low view has room for fewer. */
const listRows = (h: number): number => (h >= 640 ? 8 : h >= 480 ? 5 : 3);
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

/** The blocks of the HUD that an arrow must not lie over. */
const HUD_BLOCKS = '.hud-left, .hud-power, .hud-centre, .compass, .radar, .hud-right > .panel-mini, .hud-topleft > *, .keys, .chat-line, .notice, .warnings';
/** Room an arrow keeps to a block, pixels. */
const BLOCK_MARGIN = 6;

/** Where the blocks of the HUD stand, as they were laid out in the frame before this one. */
function hudBlocks(): Box[] {
  const out: Box[] = [];
  for (const n of document.querySelectorAll(HUD_BLOCKS)) {
    const r = n.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x0: r.left - BLOCK_MARGIN, y0: r.top - BLOCK_MARGIN, x1: r.right + BLOCK_MARGIN, y1: r.bottom + BLOCK_MARGIN });
  }
  return out;
}

export function EdgeArrows({ items, w, h }: { items: EdgeItem[]; w: number; h: number }) {
  // Labels give way to more important ones: the chosen targets first, then the nearest.
  const order = [...items].sort((a, b) => Number(b.big) - Number(a.big) || a.dist - b.dist);
  const em = emPx(w);
  const blocks = hudBlocks();
  const texts = order.map((it) => (it.big && it.c[2] > 0 ? `${fmtDistance(it.dist)} · ${t('hud.behind')}` : fmtDistance(it.dist)));
  // The room the label of an arrow takes: it stands on the side toward the middle of the view.
  const labelBox = (it: EdgeItem, text: string, m: EdgeMark): Box => {
    const size = em * (it.big ? 1 : 0.85);
    const width = Math.max(it.name.length, text.length) * size * 0.56 + 6;
    const gap = it.big ? 20 : 14;
    const x0 = m.x >= w / 2 ? m.x - gap - width : m.x + gap;
    return { x0, y0: m.y - size * 1.3, x1: x0 + width, y1: m.y + size * 1.3 };
  };
  const live = new Set<string>();
  const marks = order.map((it, i) => {
    live.add(it.key);
    const on = edgeMark(it.c, w, h, heldAngle.get(it.key));
    heldAngle.set(it.key, on.angle);
    const half = it.big ? 14 : 9;
    return pullClear(on, w, h, (m) => {
      const label = labelBox(it, texts[i]!, m);
      return { x0: Math.min(label.x0, m.x - half), y0: Math.min(label.y0, m.y - half), x1: Math.max(label.x1, m.x + half), y1: Math.max(label.y1, m.y + half) };
    }, blocks);
  });
  for (const key of heldAngle.keys()) if (!live.has(key)) heldAngle.delete(key);
  const labelled = declutter(order.map((it, i) => labelBox(it, texts[i]!, marks[i]!)));

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

/** Something in sensor range that the radar shows as a point on a stalk. */
export interface RadarContact {
  key: string;
  /** Where it is in the ship's own axes (x right, y up, nose along -z), metres. */
  c: Vec3;
  /** Colour and shape class: `npc`, `hostile`, `pilot`, `wreck`, `loot`. */
  cls: string;
  /** The locked ship: drawn larger, with a ring, over the others. */
  locked: boolean;
}

/** A place that has a mark on the rim of the radar. */
export interface RadarPlace {
  key: string;
  /** Where it is in the ship's own axes, metres. */
  c: Vec3;
  /** A gate has a square mark, a place to dock a diamond, as in the list of places. */
  gate: boolean;
  /** The chosen place: amber, larger, over the others. */
  chosen: boolean;
}

/** Units of the radar's drawing per radius of its disc. */
const RADAR_UNIT = 100;
/** Half the side of the drawing: what a mark can reach, and room for the mark itself. */
const RADAR_HALF = Math.ceil(RADAR_REACH * RADAR_UNIT) + 10;
/** The bearing each mark on the rim had last, kept for the moment its place is straight above or below. */
const heldBearing = new Map<string, number>();

/** The ring distances as the scale under the radar names them: "0.1 · 1 · 10 · 100 km". */
const RADAR_SCALE = RADAR_RINGS.map((m) => m / 1000);

/**
 * The radar beside the speed readout, in the ship's own axes: its plane as a disc seen from
 * behind and above, ahead being up. Ships, wrecks and cargo pods in sensor range are points on
 * stalks that stand on the plane, the distance on a logarithmic scale; every place to dock, every
 * gate and the chosen place are marks on the rim, at their bearing. It only shows.
 */
export function Radar({ contacts, places }: { contacts: RadarContact[]; places: RadarPlace[] }) {
  const u = RADAR_UNIT;
  // Drawn back to front, so that what is nearer to the eye lies on top; the chosen ones last.
  const blips = contacts.map((it) => ({ it, p: radarBlip(it.c) })).sort((a, b) => Number(a.it.locked) - Number(b.it.locked) || a.p.foot - b.p.foot);
  const live = new Set<string>();
  const marks = places.map((it) => {
    live.add(it.key);
    const p = radarRim(it.c, heldBearing.get(it.key));
    heldBearing.set(it.key, p.bearing);
    return { it, p };
  }).sort((a, b) => Number(a.it.chosen) - Number(b.it.chosen) || a.p.foot - b.p.foot);
  for (const key of heldBearing.keys()) if (!live.has(key)) heldBearing.delete(key);

  return (
    <div class="radar">
      <svg class="radar-plate" viewBox={`${-RADAR_HALF} ${-RADAR_HALF} ${RADAR_HALF * 2} ${RADAR_HALF * 2}`}>
        <circle class="radar-sphere" r={RADAR_HALF - 1} />
        <ellipse class="radar-disc" rx={u} ry={u * RADAR_SQUASH} />
        {RADAR_RINGS.slice(0, -1).map((m) => {
          const r = radarRadius(m) * u;
          return <ellipse key={m} class="radar-ring" rx={r} ry={r * RADAR_SQUASH} />;
        })}
        <line class="radar-axis" x1={-u} y1={0} x2={u} y2={0} />
        <line class="radar-axis" x1={0} y1={0} x2={0} y2={u * RADAR_SQUASH} />
        <line class="radar-axis ahead" x1={0} y1={0} x2={0} y2={-u * RADAR_SQUASH} />
        <path class="radar-own" d="M0 -7 L5 4 L0 1.5 L-5 4 Z" />
        {marks.map(({ it, p }) => {
          const x = p.x * u;
          const y = p.y * u;
          const half = it.chosen ? 6.5 : 4.5;
          return (
            <g key={it.key} data-key={it.key} class={`radar-mark ${it.chosen ? 'chosen' : ''} ${it.gate ? 'gate' : ''}`}>
              <line class="radar-stalk" x1={x} y1={p.foot * u} x2={x} y2={y} />
              <circle class="radar-foot" cx={x} cy={p.foot * u} r={2} />
              <rect class="radar-head" x={x - half} y={y - half} width={half * 2} height={half * 2} transform={it.gate ? undefined : `rotate(45 ${x} ${y})`} />
            </g>
          );
        })}
        {blips.map(({ it, p }) => {
          const x = p.x * u;
          const y = p.y * u;
          const foot = p.foot * u;
          const half = it.locked ? 6 : 4.5;
          return (
            <g key={it.key} data-key={it.key} class={`radar-blip ${it.cls} ${it.locked ? 'locked' : ''} ${p.beyond ? 'beyond' : ''} ${y > foot ? 'below' : ''}`}>
              <line class="radar-stalk" x1={x} y1={foot} x2={x} y2={y} />
              <line class="radar-foot" x1={x - 3.5} y1={foot} x2={x + 3.5} y2={foot} />
              {it.cls === 'loot'
                ? <circle class="radar-head" cx={x} cy={y} r={3.2} />
                : <rect class="radar-head" x={x - half} y={y - half} width={half * 2} height={half * 2} />}
              {it.locked && <circle class="radar-lock" cx={x} cy={y} r={11.5} />}
            </g>
          );
        })}
      </svg>
      <div class="radar-scale">{t('hud.radarRings', { km: RADAR_SCALE.map((n) => fmt(n, n < 1 ? 1 : 0)).join(' · ') })}</div>
    </div>
  );
}

/** The lines of a target panel that say how the distance changes: closing speed and, for a place, the time of arrival. */
export function RateLines({ dist, closing, eta: withEta = true }: { dist: number; closing: number; eta?: boolean }) {
  const eta = arrival(dist, closing);
  return (
    <>
      <div class="pair">
        <span class="dim">{t(closing > -RATE_SHOWN ? 'hud.closing' : 'hud.receding')}</span>
        <span class="num">{fmtSpeed(Math.abs(closing) < RATE_SHOWN ? 0 : Math.abs(closing))}</span>
      </div>
      {withEta && (
        <div class="pair">
          <span class="dim">{t('hud.arrival')}</span>
          <span class="num">{eta === null ? '--' : fmtDuration(eta)}</span>
        </div>
      )}
    </>
  );
}

/** The chosen place: what it is, how far, whether it lies behind, and how fast the ship closes on it. */
export function PlacePanel({ place, behind, closing }: { place: PlaceEntry; behind: boolean; closing: number }) {
  return (
    <div class="panel-mini place">
      <h4>{t('hud.nav')} · {t(`kind.${place.kind}` as StringKey)}</h4>
      <div class="big">{place.name}</div>
      <div class="pair">
        <span class="num">{fmtDistance(place.dist)}</span>
        {behind && <span class="dim">{t('hud.behind')}</span>}
      </div>
      <RateLines dist={place.dist} closing={closing} />
    </div>
  );
}

function Keycap({ action }: { action: BindAction }) {
  return <span class="keycap">{bindKeyShort(action)}</span>;
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
  const { start, count } = listWindow(rows.length, selected, listRows(window.innerHeight));
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
