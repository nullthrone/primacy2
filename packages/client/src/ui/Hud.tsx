/**
 * The flight HUD. It re-renders every frame (it reads `store.frame`) and takes all moving
 * values from the current `FrameView`.
 */
import { useRef, useState } from 'preact/hooks';
import { ChargeKind, DOCK_RANGE, EntityFlag, EntityKind, FlightMode, HULLS, cargoTonnes, v3, type ChatChannel } from '@primacy2/shared';
import type { FrameView, GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store } from '../state/store.ts';
import { fmtDistance, fmtDuration, fmtSpeed } from './format.ts';

const NOTICE_MS = 7000;

function Bar({ label, value, warn, cls }: { label: string; value: number; warn?: boolean; cls: string }) {
  return (
    <div class={`bar ${cls} ${warn ? 'warn' : ''}`}>
      <span class="bar-label">{label}</span>
      <span class="bar-track"><span class="bar-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></span>
    </div>
  );
}

function Marker({ x, y, label, sub, cls }: { x: number; y: number; label?: string; sub?: string; cls: string }) {
  return (
    <div class={`marker ${cls}`} style={{ transform: `translate(${x}px, ${y}px)` }}>
      <span class="marker-glyph" />
      {label && <span class="marker-text">{label}{sub && <em>{sub}</em>}</span>}
    </div>
  );
}

/** Keeps an off-screen or behind-camera point on a margin inside the view. */
function clampToEdge(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  const m = 40;
  const cx = w / 2;
  const cy = h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const k = Math.min((cx - m) / Math.max(1e-6, Math.abs(dx)), (cy - m) / Math.max(1e-6, Math.abs(dy)), 1);
  return { x: cx + dx * k, y: cy + dy * k };
}

function Chat({ api }: { api: GameApi }) {
  const [channel, setChannel] = useState<ChatChannel>('system');
  const open = store.panel.value === 'chat';
  const input = useRef<HTMLInputElement>(null);
  const messages = store.chat.value.slice(open ? -12 : -4);
  if (open) queueMicrotask(() => input.current?.focus());
  const channels: ChatChannel[] = ['local', 'system', 'sector', 'lattice'];
  return (
    <div class={`chat ${open ? 'open' : ''}`}>
      {messages.map((m) => (
        <div class="chat-line" key={m.at + m.from.id}>
          <span class={`chat-ch ch-${m.ch}`}>{t(`chat.${m.ch === 'wing' || m.ch === 'direct' ? 'local' : m.ch}` as StringKey)}</span>
          <b>{m.from.name}</b> {m.text}
        </div>
      ))}
      {open && (
        <form
          class="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            const text = input.current?.value.trim();
            if (text) api.chat(channel, text);
            if (input.current) input.current.value = '';
            store.panel.value = null;
          }}
        >
          <select value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value as ChatChannel)}>
            {channels.map((c) => <option value={c} key={c}>{t(`chat.${c}` as StringKey)}</option>)}
          </select>
          <input
            ref={input} maxLength={240} placeholder={t('chat.placeholder')}
            onKeyDown={(e) => { if (e.key === 'Escape') store.panel.value = null; }}
          />
        </form>
      )}
    </div>
  );
}

function flightHud(view: FrameView, api: GameApi) {
  const self = view.self!;
  const st = self.state;
  const stats = self.stats;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cruise = view.mode === FlightMode.Cruise;
  const speed = cruise ? st.cruiseSpeed : v3.len(st.vel);
  const pilot = store.pilot.value;
  const cargo = pilot ? cargoTonnes(pilot.passport.ship.cargo) : 0;

  // Velocity vector marker: where the ship is actually going.
  let vel: { x: number; y: number } | null = null;
  if (!cruise && speed > 3) {
    const p = api.project(v3.addScaled(self.rel, st.vel, 1000 / speed));
    if (!p.behind) vel = p;
  }

  const markers = [];
  const nav = view.navAnchor;
  for (const s of view.sites) {
    const isNav = s.def.id === nav;
    if (!isNav && s.def.kind !== 'station' && s.def.kind !== 'outpost' && s.def.kind !== 'gate' && s.dist > 5e9) continue;
    const p = api.project(s.rel);
    if (!p.visible && !isNav) continue;
    const pos = p.visible ? p : clampToEdge(p, w, h);
    const near = Math.hypot(pos.x - w / 2, pos.y - h / 2) < 90;
    markers.push(
      <Marker
        key={`s${s.def.id}`} x={pos.x} y={pos.y} cls={`site k-${s.def.kind} ${isNav ? 'nav' : ''}`}
        label={isNav || near ? s.def.name : undefined} sub={isNav || near ? fmtDistance(s.dist) : undefined}
      />,
    );
  }
  for (const b of view.bodies) {
    const isNav = b.def.id === nav;
    if (!isNav && !cruise) continue;
    const p = api.project(b.rel);
    if (!p.visible && !isNav) continue;
    const pos = p.visible ? p : clampToEdge(p, w, h);
    const near = Math.hypot(pos.x - w / 2, pos.y - h / 2) < 70;
    if (!isNav && !near) continue;
    markers.push(
      <Marker key={`b${b.def.id}`} x={pos.x} y={pos.y} cls={`body ${isNav ? 'nav' : ''}`} label={b.def.name} sub={fmtDistance(Math.max(0, b.dist - b.def.radius))} />,
    );
  }
  let target = null;
  for (const e of view.ents) {
    const isTarget = e.id === view.targetId;
    if (e.info.kind !== EntityKind.Ship && !isTarget && e.info.kind !== EntityKind.Loot) continue;
    const p = api.project(e.rel);
    if (isTarget) target = e;
    if (!p.visible && !isTarget) continue;
    const pos = p.visible ? p : clampToEdge(p, w, h);
    const hostile = (e.flags & EntityFlag.Wanted) !== 0 || e.info.npc === 'pirate';
    markers.push(
      <Marker
        key={`e${e.id}`} x={pos.x} y={pos.y}
        cls={`ent ${e.info.kind === EntityKind.Loot ? 'loot' : hostile ? 'hostile' : e.info.player ? 'pilot' : 'npc'} ${isTarget ? 'target' : ''}`}
        label={isTarget ? e.info.name : undefined} sub={isTarget ? fmtDistance(v3.dist(e.rel, self.rel)) : undefined}
      />,
    );
  }

  const navSite = nav !== null ? view.sites.find((s) => s.def.id === nav) : undefined;
  const navBody = nav !== null && !navSite ? view.bodies.find((b) => b.def.id === nav) : undefined;
  const navDist = navSite ? navSite.dist : navBody ? Math.max(0, navBody.dist - navBody.def.radius) : null;
  const here = view.sites.find((s) => s.def.id === st.anchor);
  const canDock = view.mode === FlightMode.Normal && here && (here.def.kind === 'station' || here.def.kind === 'outpost') &&
    v3.len(st.pos) < (here.def.radius ?? 300) + DOCK_RANGE;
  const canDrop = cruise && navSite && navSite.dist < navSite.def.frameRadius;

  const warnings: string[] = [];
  if (view.fx.heat > 0.8) warnings.push(t('hud.warnHeat'));
  if (st.fuel < stats.fuelCap * 0.15) warnings.push(t('hud.warnFuel'));
  if (st.hull < stats.hullMax * 0.25) warnings.push(t('hud.warnHull'));
  if (st.dilation < 0.98) warnings.push(t('hud.warnDilation', { factor: fmt(st.dilation, 2) }));

  return (
    <>
      <div class="reticle" />
      {vel && <div class="velocity" style={{ transform: `translate(${vel.x}px, ${vel.y}px)` }} />}
      {markers}

      <div class="hud-block hud-left">
        <Bar label={t('hud.shield')} value={stats.shieldMax > 0 ? st.shield / stats.shieldMax : 0} cls="shield" />
        <Bar label={t('hud.hull')} value={st.hull / stats.hullMax} cls="hull" warn={st.hull < stats.hullMax * 0.25} />
        <Bar label={t('hud.energy')} value={st.energy / stats.energyMax} cls="energy" />
        <Bar label={t('hud.heat')} value={view.fx.heat} cls="heat" warn={view.fx.heat > 0.8} />
        <Bar label={t('hud.fuel')} value={st.fuel / stats.fuelCap} cls="fuel" warn={st.fuel < stats.fuelCap * 0.15} />
      </div>

      <div class="hud-block hud-centre">
        <div class="speed">{fmtSpeed(speed)}</div>
        <div class="throttle"><span style={{ width: `${Math.abs(st.throttle) * 100}%` }} class={st.throttle < 0 ? 'rev' : ''} /></div>
        <div class="mode">
          <span>{t(cruise ? 'hud.modeCruise' : 'hud.modeNormal')}</span>
          <span class={st.fa ? 'on' : 'off'}>{t(st.fa ? 'hud.assistOn' : 'hud.assistOff')}</span>
        </div>
        {st.chargeKind !== ChargeKind.None && (
          <div class="charge">
            <span>{t(st.chargeKind === ChargeKind.Fold ? 'hud.chargeFold' : 'hud.chargeCruise')}</span>
            <span class="bar-track"><span class="bar-fill" style={{ width: `${st.charge * 100}%` }} /></span>
          </div>
        )}
        {canDock && <div class="prompt">{t('hud.dockPrompt')}</div>}
        {canDrop && <div class="prompt">{t('hud.dropPrompt')}</div>}
      </div>

      <div class="hud-block hud-right">
        {target ? (
          <div class="panel-mini">
            <h4>{t('hud.target')}</h4>
            <div class="big">{target.info.name}</div>
            <div class="dim">{HULLS[target.info.model]?.name ?? target.info.model}{target.info.npc ? ` · ${target.info.npc}` : ''}</div>
            <div>{fmtDistance(v3.dist(target.rel, self.rel))}</div>
            <Bar label={t('hud.shield')} value={target.shield} cls="shield" />
            <Bar label={t('hud.hull')} value={target.hull} cls="hull" />
            {(target.flags & EntityFlag.Wanted) !== 0 && <div class="wanted">{t('hud.wanted')}</div>}
          </div>
        ) : null}
        {navDist !== null && (
          <div class="panel-mini">
            <h4>{t('hud.nav')}</h4>
            <div class="big">{navSite?.def.name ?? navBody?.def.name}</div>
            <div>{fmtDistance(navDist)}</div>
            {speed > 1 && <div class="dim">{t('hud.eta', { time: fmtDuration(navDist / speed) })}</div>}
          </div>
        )}
      </div>

      <div class="hud-block hud-topleft">
        <div class="big">{view.system.name}</div>
        <div class="dim">{t(`map.security.${view.system.security}` as StringKey)} · {store.serverName.value}</div>
        <div>{fmt(pilot?.credits ?? 0)} {t('hud.credits')} · {t('hud.cargo')} {cargo}/{Math.floor(stats.cargoCap)} t</div>
      </div>

      {warnings.length > 0 && <div class="warnings">{warnings.map((x) => <div key={x}>{x}</div>)}</div>}
      {!store.pointerLocked.value && store.panel.value === null && (
        <button class="capture" onClick={() => api.capturePointer()}>{t('hud.capture')}</button>
      )}
      <div class="keys">{t('hud.keys')}</div>
    </>
  );
}

export function Hud({ api }: { api: GameApi }) {
  // Reading the frame counter subscribes this component to every rendered frame.
  void store.frame.value;
  const view = api.view;
  const now = performance.now();
  const notices = store.notices.value.filter((n) => now - n.at < NOTICE_MS);
  const handoff = store.phase.value === 'handoff';
  const folding = handoff || view?.mode === FlightMode.Fold;
  const foldName = handoff
    ? store.status.value
    : store.galaxy.value?.sectors.flatMap((s) => s.systems).find((s) => s.id === view?.system.id)?.name ?? view?.system.name ?? '';

  return (
    <div class="hud">
      {view && view.self && !folding && flightHud(view, api)}
      {view && view.mode === FlightMode.Docked && store.panel.value === null && (
        <div class="hud-block hud-centre"><div class="mode"><span>{t('hud.modeDocked')}</span></div></div>
      )}
      {folding && <div class="overlay-text"><h2>{t('hud.folding', { dest: foldName })}</h2></div>}
      {view && view.mode === FlightMode.Dead && (
        <div class="overlay-text dead">
          <h2>{t('hud.dead')}</h2>
          <button onClick={() => void api.cmd({ k: 'respawn' })}>{t('hud.respawn')}</button>
        </div>
      )}
      <div class="notices">
        {notices.map((n) => <div class={`notice ${n.level}`} key={n.id}>{n.text}</div>)}
      </div>
      <Chat api={api} />
    </div>
  );
}
