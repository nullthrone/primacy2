/**
 * Galaxy map (fold destinations), navigation list (in-system targets) and the contacts list.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  EntityKind, HULLS, computeShipStats, foldFuelCost, largestHullWithin, v3,
  type CargoItem, type SectorView, type SystemSummary,
} from '@primacy2/shared';
import type { GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store } from '../state/store.ts';
import { STAR_COLORS, bindKey, fmtDistance } from './format.ts';
import { TIER_COLOR, isTier, jumpForecast, tierLabel } from './trade.ts';

function PanelHeader({ title }: { title: string }) {
  return (
    <header>
      <h2>{title}</h2>
      <button onClick={() => (store.panel.value = null)}>{t('map.close')}</button>
    </header>
  );
}

/**
 * How the sector the pilot is in (`home`) treats another sector: the tier that applies, whether
 * the rules match, and for a trade partner how many trade units of its goods are still accepted.
 */
function Relation({ sector, home }: { sector: SectorView; home: string }) {
  const { tier, name } = sector;
  if (!isTier(tier)) return null;
  return (
    <div class="relation">
      <div class="row wrap">
        <span class={`chip ${tier}`}>{tierLabel(tier)}</span>
        <span class={`small ${sector.rulesMatch ? 'dim' : 'caution'}`}>{t(sector.rulesMatch ? 'map.rulesMatch' : 'map.rulesDiffer')}</span>
      </div>
      {/* A customs union needs both sides and the same rules; until then the sector is a partner. */}
      {sector.trust === 'union' && tier !== 'union' && (
        <div class="caution small">{t(sector.rulesMatch ? 'map.unionOneSided' : 'map.unionRules', { home, name })}</div>
      )}
      {tier === 'union' && <div class="dim small">{t('map.unionHere', { home, name })}</div>}
      {tier === 'partner' && typeof sector.allowance === 'number' && (
        <div class={`small ${sector.allowance > 0 ? '' : 'caution'}`}>
          {t(sector.allowance > 0 ? 'map.allowance' : 'map.allowanceNone', { home, name, tu: fmt(Math.floor(sector.allowance)) })}
        </div>
      )}
      {tier === 'visitor' && <div class="dim small">{t('map.visitorHere', { home, name })}</div>}
      {tier === 'blocked' && <div class="caution small">{t('map.blockedHere', { home, name })}</div>}
    </div>
  );
}

/**
 * What a jump into another sector does to the cargo and the ship. The galaxy view says how this
 * sector rates the destination, not how the destination rates this one, so only an effective
 * customs union (which is mutual) gives a full answer. For every other sector the lines say what
 * holds whichever way the destination rates this sector, and name what depends on that rating.
 */
function Forecast({ sector, self, cargo, shipBound, hull }: {
  sector: SectorView; self: string; cargo: readonly CargoItem[]; shipBound: boolean; hull: string;
}) {
  // No transfers are issued to a blocked sector; the relation block above already says so.
  if (sector.tier === 'blocked') return null;
  const name = sector.name;
  const fc = jumpForecast(cargo, self, sector.id);
  const union = sector.tier === 'union';
  // What the destination publishes about ships from this sector; null when it publishes nothing.
  const entry = isTier(sector.entryTier) ? sector.entryTier : null;
  if (entry === 'blocked') {
    return (
      <div class="forecast">
        <h4>{t('map.forecast')}</h4>
        <div class="bad">{t('map.fcBlocked', { name })}</div>
      </div>
    );
  }
  const cap = sector.entryHullCap;
  const capHull = cap === null ? null : largestHullWithin(cap);
  const tooLarge = cap !== null && (HULLS[hull]?.price ?? Infinity) > cap;
  return (
    <div class={`forecast ${union ? 'free' : ''}`}>
      <h4>{t('map.forecast')}</h4>
      {union && <div class="ok">{t('map.fcUnion')}</div>}
      {fc.sealed > 0 && <div class="caution">{t('map.fcSealedStays', { n: fmt(fc.sealed), name })}</div>}
      {fc.third > 0 && <div class={union ? '' : 'caution'}>{t(union ? 'map.fcThirdUnion' : 'map.fcThirdSealed', { n: fmt(fc.third), name })}</div>}
      {!union && fc.direct > 0 && (
        <div class="caution">
          {t(entry === 'partner' ? 'map.fcImports' : entry === 'visitor' ? 'map.fcVisitor' : 'map.fcDepends', { n: fmt(fc.direct), name })}
        </div>
      )}
      {union && shipBound && <div class="caution">{t('map.fcBoundStays')}</div>}
      {!union && (
        <>
          <div class="caution">{t('map.fcShipBound', { name })}</div>
          {/* Only a ship that is local here is recognised as local again when it comes back. */}
          {!shipBound && <div class="dim">{t('map.fcShipReturn')}</div>}
          {cap !== null && (
            <div class={tooLarge ? 'bad' : 'dim'}>
              {t(tooLarge ? 'map.fcClassOver' : 'map.fcClassWithin', {
                name, hull: capHull ? HULLS[capHull]?.name ?? capHull : '–', own: HULLS[hull]?.name ?? hull,
              })}
            </div>
          )}
          {entry === null && <div class="dim">{t('map.fcClass', { name })}</div>}
        </>
      )}
    </div>
  );
}

export function GalaxyMap({ api }: { api: GameApi }) {
  const galaxy = store.galaxy.value;
  const here = store.system.value;
  const pilot = store.pilot.value;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<string | null>(store.foldTarget.value);
  // View state lives in a ref so dragging does not re-render the component tree.
  const cam = useRef({ x: here?.pos[0] ?? 0, z: here?.pos[2] ?? 0, scale: 14, drag: null as null | { x: number; y: number; moved: boolean } });
  const stats = pilot ? computeShipStats(pilot.passport.ship.loadout) : null;
  const range = stats?.jumpRange ?? 0;
  const all: { sys: SystemSummary; sector: SectorView }[] =
    galaxy?.sectors.flatMap((s) => s.systems.map((sys) => ({ sys, sector: s }))) ?? [];
  const sel = all.find((a) => a.sys.id === selected) ?? null;
  // The view is made by the sector the pilot is in; every relation on this map is seen from there.
  const self = galaxy?.self ?? '';
  const homeName = galaxy?.sectors.find((s) => s.id === self)?.name ?? store.serverName.value;
  const others = galaxy?.sectors.filter((s) => s.id !== self) ?? [];

  const draw = (): void => {
    const c = canvas.current;
    if (!c || !galaxy) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const v = cam.current;
    const X = (x: number): number => w / 2 + (x - v.x) * v.scale;
    const Y = (z: number): number => h / 2 + (z - v.z) * v.scale;

    for (const s of galaxy.sectors) {
      g.beginPath();
      g.arc(X(s.pos[0]), Y(s.pos[2]), s.radius * v.scale, 0, Math.PI * 2);
      g.strokeStyle = s.online ? 'rgba(127,233,255,0.22)' : 'rgba(255,255,255,0.1)';
      g.setLineDash(s.linked ? [] : [4, 6]);
      g.stroke();
      g.setLineDash([]);
      // Every other sector carries a second line under its name: its relation to this sector,
      // in the colour of that relation, and a note when its rules differ.
      const relation = s.id !== galaxy.self && isTier(s.tier) ? s.tier : null;
      const top = Y(s.pos[2]) - s.radius * v.scale;
      g.fillStyle = s.online ? 'rgba(127,233,255,0.8)' : 'rgba(200,200,200,0.5)';
      g.font = '600 14px Rajdhani, sans-serif';
      g.textAlign = 'center';
      g.fillText(`${s.name}${s.online ? '' : ` (${t('map.offline')})`}`, X(s.pos[0]), top - (relation ? 23 : 8));
      if (relation) {
        const rules = s.rulesMatch ? '' : ` · ${t('map.rulesDiffer')}`;
        g.fillStyle = TIER_COLOR[relation];
        g.globalAlpha = s.online ? 0.95 : 0.5;
        g.font = '11px "Share Tech Mono", monospace';
        g.fillText(`${tierLabel(relation)}${rules}`.toLocaleUpperCase(), X(s.pos[0]), top - 8);
        g.globalAlpha = 1;
      }
    }
    for (const s of galaxy.sectors) {
      for (const gate of s.gates) {
        const a = s.systems.find((x) => x.id === gate.system);
        const b = all.find((x) => x.sys.id === gate.remoteSystem)?.sys;
        if (!a || !b) continue;
        g.beginPath();
        g.moveTo(X(a.pos[0]), Y(a.pos[2]));
        g.lineTo(X(b.pos[0]), Y(b.pos[2]));
        g.strokeStyle = gate.state === 'active' ? 'rgba(125,255,168,0.7)' : 'rgba(255,179,71,0.45)';
        g.setLineDash(gate.state === 'active' ? [] : [3, 5]);
        g.lineWidth = 2;
        g.stroke();
        g.setLineDash([]);
        g.lineWidth = 1;
      }
    }
    if (here && range > 0) {
      g.beginPath();
      g.arc(X(here.pos[0]), Y(here.pos[2]), range * v.scale, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(125,255,168,0.5)';
      g.stroke();
    }
    const labels: { name: string; x: number; y: number; rank: number }[] = [];
    for (const { sys, sector } of all) {
      const x = X(sys.pos[0]);
      const y = Y(sys.pos[2]);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      const reach = here ? v3.dist(here.pos, sys.pos) <= range : false;
      g.beginPath();
      g.arc(x, y, sys.stations > 0 ? 4.5 : 3, 0, Math.PI * 2);
      g.fillStyle = STAR_COLORS[sys.starClass] ?? '#fff';
      g.globalAlpha = sector.online ? (reach || sys.id === here?.id ? 1 : 0.6) : 0.3;
      g.fill();
      g.globalAlpha = 1;
      if (sys.id === here?.id || sys.id === selected || sys.id === store.foldTarget.value) {
        g.beginPath();
        g.arc(x, y, 9, 0, Math.PI * 2);
        g.strokeStyle = sys.id === here?.id ? '#7dffa8' : sys.id === store.foldTarget.value ? '#ffb347' : '#7fe9ff';
        g.lineWidth = 2;
        g.stroke();
        g.lineWidth = 1;
      }
      const marked = sys.id === selected || sys.id === here?.id || sys.id === store.foldTarget.value;
      if (v.scale > 9 || marked) labels.push({ name: sys.name, x, y, rank: marked ? 0 : sys.stations > 0 ? 1 : 2 });
    }
    // Names are placed in order of importance; one that would run into a name already placed is
    // left out, so a dense cluster stays readable. Zooming in brings the rest back.
    labels.sort((a, b) => a.rank - b.rank);
    g.fillStyle = 'rgba(220,240,255,0.85)';
    g.font = '12px "Share Tech Mono", monospace';
    g.textAlign = 'left';
    const placed: { x0: number; x1: number; y: number }[] = [];
    for (const l of labels) {
      const x0 = l.x + 9;
      const x1 = x0 + g.measureText(l.name).width;
      if (l.rank > 0 && placed.some((p) => Math.abs(p.y - l.y) < 13 && x0 < p.x1 + 6 && x1 > p.x0 - 6)) continue;
      placed.push({ x0, x1, y: l.y });
      g.fillText(l.name, x0, l.y + 4);
    }
  };

  useEffect(draw);
  useEffect(() => {
    const onResize = (): void => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const pick = (e: MouseEvent): void => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const v = cam.current;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let best: string | null = null;
    let bestD = 16;
    for (const { sys } of all) {
      const d = Math.hypot(r.width / 2 + (sys.pos[0] - v.x) * v.scale - mx, r.height / 2 + (sys.pos[2] - v.z) * v.scale - my);
      if (d < bestD) {
        bestD = d;
        best = sys.id;
      }
    }
    if (best) setSelected(best);
  };

  // Systems in reach first, nearest first; the list is capped so it stays a short list.
  const nearby = here
    ? [...all].sort((a, b) => v3.dist(here.pos, a.sys.pos) - v3.dist(here.pos, b.sys.pos)).slice(0, 40)
    : [];
  const dist = sel && here ? v3.dist(here.pos, sel.sys.pos) : 0;
  const fuel = sel && stats ? foldFuelCost(dist, stats) : Infinity;
  const abroad = sel !== null && sel.sector.id !== self;
  return (
    <div class="panel wide map">
      <PanelHeader title={t('map.galaxy')} />
      <div class="map-body">
        <canvas
          ref={canvas}
          onMouseDown={(e) => (cam.current.drag = { x: e.clientX, y: e.clientY, moved: false })}
          onMouseMove={(e) => {
            const d = cam.current.drag;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            cam.current.x -= dx / cam.current.scale;
            cam.current.z -= dy / cam.current.scale;
            d.x = e.clientX;
            d.y = e.clientY;
            draw();
          }}
          onMouseUp={(e) => {
            const d = cam.current.drag;
            cam.current.drag = null;
            if (d && !d.moved) pick(e);
          }}
          onMouseLeave={() => (cam.current.drag = null)}
          onWheel={(e) => {
            cam.current.scale = Math.min(120, Math.max(0.4, cam.current.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
            draw();
          }}
        />
        <aside>
          <div class="dim">{t('map.range', { ly: fmt(range, 1) })}</div>
          {/* The same choice as clicking a star on the canvas, for a controller or the keyboard. */}
          {nearby.length > 0 && (
            <div class="sys-pick" data-padstart>
              <h4>{t('map.systems')}</h4>
              <div class="scroll list sys-list">
                {nearby.map((a) => (
                  <button key={a.sys.id} type="button" class={a.sys.id === selected ? 'on' : ''} onClick={() => setSelected(a.sys.id)}>
                    <span>{a.sys.name}</span>
                    <span class="dim">{a.sys.starClass}</span>
                    <span class="num">{here ? `${fmt(v3.dist(here.pos, a.sys.pos), 1)} ${t('map.ly')}` : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {store.foldTarget.value && (
            <div>{t('map.destination')}: <b>{all.find((a) => a.sys.id === store.foldTarget.value)?.sys.name ?? '?'}</b></div>
          )}
          {sel ? (
            <div class="stack">
              <h3>{sel.sys.name}</h3>
              <div class="dim">{t('map.sector', { name: sel.sector.name })}</div>
              {abroad && <Relation sector={sel.sector} home={homeName} />}
              <div>{sel.sys.starClass} · {t(`map.security.${sel.sys.security}` as StringKey)} · {t('map.stations', { n: sel.sys.stations })}</div>
              {sel.sys.tags.length > 0 && <div class="dim">{sel.sys.tags.join(' · ')}</div>}
              {sel.sys.id === here?.id ? <div class="ok">{t('map.you')}</div> : (
                <>
                  <div>{t('map.distance', { ly: fmt(dist, 1) })}</div>
                  <div class={Number.isFinite(fuel) ? '' : 'bad'}>{Number.isFinite(fuel) ? t('map.fuelCost', { t: fmt(fuel, 1) }) : t('map.outOfRange')}</div>
                  {abroad && pilot && isTier(sel.sector.tier) && (
                    <Forecast
                      sector={sel.sector} self={self} cargo={pilot.passport.ship.cargo} shipBound={pilot.shipBound !== null}
                      hull={pilot.passport.ship.loadout.hull}
                    />
                  )}
                  <button onClick={() => { api.setFoldTarget(sel.sys.id); setSelected(sel.sys.id); draw(); }}>{t('map.setDestination')}</button>
                  <button class="primary" disabled={!Number.isFinite(fuel)} onClick={() => { api.setFoldTarget(sel.sys.id); store.panel.value = null; api.capturePointer(); api.startFold(); }}>
                    {t('map.jump')}
                  </button>
                </>
              )}
            </div>
          ) : <p class="dim">{t(store.device.value === 'pad' ? 'map.helpPad' : 'map.help')}</p>}
          {galaxy && (
            <div class="sectors">
              <h4>{t('map.sectors')}</h4>
              {others.length === 0 && <div class="dim small">{t('map.noSectors')}</div>}
              {others.map((s) => (
                <div class="sector-row" key={s.id}>
                  <div class="row wrap">
                    <span>{s.name}</span>
                    {isTier(s.tier) && <span class={`chip ${s.tier}`}>{tierLabel(s.tier)}</span>}
                  </div>
                  <div class="dim small">
                    {[
                      s.online ? null : t('map.offline'),
                      isTier(s.tier) ? t(s.rulesMatch ? 'map.rulesMatch' : 'map.rulesDiffer') : null,
                      s.tier === 'partner' && typeof s.allowance === 'number' ? t('map.accepts', { tu: fmt(Math.floor(s.allowance)) }) : null,
                    ].filter((x) => x !== null).join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export function NavPanel({ api }: { api: GameApi }) {
  void store.frame.value;
  const view = api.view;
  const nav = store.navAnchor.value;
  if (!view) return null;
  const sites = [...view.sites].sort((a, b) => a.dist - b.dist);
  const bodies = [...view.bodies].sort((a, b) => a.dist - b.dist);
  const choose = (id: number): void => {
    api.setNav(id);
    store.panel.value = null;
    api.capturePointer();
  };
  return (
    <div class="panel narrow">
      <PanelHeader title={`${t('map.system')}: ${view.system.name}`} />
      <p class="dim">{t('map.navHelp', { key: bindKey('cruise') })}</p>
      <div class="scroll list" data-padstart>
        {nav !== null && <button onClick={() => api.setNav(null)}>{t('map.clearNav')}</button>}
        {sites.map((s) => (
          <button key={s.def.id} class={s.def.id === nav ? 'on' : ''} onClick={() => choose(s.def.id)}>
            <span>{s.def.name}</span>
            <span class="dim">{t(`kind.${s.def.kind}` as StringKey)}</span>
            <span class="num">{fmtDistance(s.dist)}</span>
          </button>
        ))}
        {bodies.map((b) => (
          <button key={`b${b.def.id}`} class={b.def.id === nav ? 'on' : ''} onClick={() => choose(b.def.id)}>
            <span>{b.def.name}</span>
            <span class="dim">{t(`kind.${b.def.kind}` as StringKey)} · {b.def.cls}</span>
            <span class="num">{fmtDistance(b.dist)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ContactsPanel({ api }: { api: GameApi }) {
  const contacts = store.contacts.value;
  return (
    <div class="panel narrow">
      <PanelHeader title={t('map.contacts')} />
      {contacts.length === 0 && <p class="dim">{t('map.noContacts')}</p>}
      <div class="scroll list" data-padstart>
        {contacts.map((c) => (
          <button
            key={c.id} class={c.id === store.targetId.value ? 'on' : ''} disabled={c.info.kind !== EntityKind.Ship}
            onClick={() => { api.setTarget(c.id); store.panel.value = null; api.capturePointer(); }}
          >
            <span>{c.info.name}</span>
            <span class="dim">{c.info.kind === EntityKind.Ship ? HULLS[c.info.model]?.name ?? c.info.model : c.info.model}{c.info.npc ? ` · ${c.info.npc}` : ''}</span>
            <span class="num">{fmtDistance(c.dist)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
