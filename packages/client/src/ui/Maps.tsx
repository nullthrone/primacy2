/**
 * Galaxy map (fold destinations), navigation list (in-system targets) and the contacts list.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { EntityKind, HULLS, computeShipStats, foldFuelCost, v3, type SystemSummary } from '@primacy2/shared';
import type { GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store } from '../state/store.ts';
import { STAR_COLORS, fmtDistance } from './format.ts';

function PanelHeader({ title }: { title: string }) {
  return (
    <header>
      <h2>{title}</h2>
      <button onClick={() => (store.panel.value = null)}>{t('map.close')}</button>
    </header>
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
  const all: { sys: SystemSummary; sector: string; online: boolean }[] =
    galaxy?.sectors.flatMap((s) => s.systems.map((sys) => ({ sys, sector: s.name, online: s.online }))) ?? [];
  const sel = all.find((a) => a.sys.id === selected) ?? null;

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
      g.fillStyle = s.online ? 'rgba(127,233,255,0.8)' : 'rgba(200,200,200,0.5)';
      g.font = '600 14px Rajdhani, sans-serif';
      g.textAlign = 'center';
      g.fillText(`${s.name}${s.online ? '' : ` (${t('map.offline')})`}`, X(s.pos[0]), Y(s.pos[2]) - s.radius * v.scale - 8);
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
    for (const { sys, online } of all) {
      const x = X(sys.pos[0]);
      const y = Y(sys.pos[2]);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      const reach = here ? v3.dist(here.pos, sys.pos) <= range : false;
      g.beginPath();
      g.arc(x, y, sys.stations > 0 ? 4.5 : 3, 0, Math.PI * 2);
      g.fillStyle = STAR_COLORS[sys.starClass] ?? '#fff';
      g.globalAlpha = online ? (reach || sys.id === here?.id ? 1 : 0.6) : 0.3;
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
      if (v.scale > 9 || sys.id === selected || sys.id === here?.id) {
        g.fillStyle = 'rgba(220,240,255,0.85)';
        g.font = '12px "Share Tech Mono", monospace';
        g.textAlign = 'left';
        g.fillText(sys.name, x + 9, y + 4);
      }
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

  const dist = sel && here ? v3.dist(here.pos, sel.sys.pos) : 0;
  const fuel = sel && stats ? foldFuelCost(dist, stats) : Infinity;
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
          {store.foldTarget.value && (
            <div>{t('map.destination')}: <b>{all.find((a) => a.sys.id === store.foldTarget.value)?.sys.name ?? '?'}</b></div>
          )}
          {sel ? (
            <div class="stack">
              <h3>{sel.sys.name}</h3>
              <div class="dim">{t('map.sector', { name: sel.sector })}</div>
              <div>{sel.sys.starClass} · {t(`map.security.${sel.sys.security}` as StringKey)} · {t('map.stations', { n: sel.sys.stations })}</div>
              {sel.sys.tags.length > 0 && <div class="dim">{sel.sys.tags.join(' · ')}</div>}
              {sel.sys.id === here?.id ? <div class="ok">{t('map.you')}</div> : (
                <>
                  <div>{t('map.distance', { ly: fmt(dist, 1) })}</div>
                  <div class={Number.isFinite(fuel) ? '' : 'bad'}>{Number.isFinite(fuel) ? t('map.fuelCost', { t: fmt(fuel, 1) }) : t('map.outOfRange')}</div>
                  <button onClick={() => { api.setFoldTarget(sel.sys.id); setSelected(sel.sys.id); draw(); }}>{t('map.setDestination')}</button>
                  <button class="primary" disabled={!Number.isFinite(fuel)} onClick={() => { api.setFoldTarget(sel.sys.id); store.panel.value = null; api.capturePointer(); api.startFold(); }}>
                    {t('map.jump')}
                  </button>
                </>
              )}
            </div>
          ) : <p class="dim">{t('map.help')}</p>}
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
      <p class="dim">{t('map.navHelp')}</p>
      <div class="scroll list">
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
      <div class="scroll list">
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
