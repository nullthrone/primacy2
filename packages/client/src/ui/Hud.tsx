/**
 * The flight HUD. It re-renders every frame (it reads `store.frame`) and takes all moving
 * values from the current `FrameView`.
 */
import { useRef, useState } from 'preact/hooks';
import {
  Button, COMMODITIES, ChargeKind, DOCK_RANGE, EntityFlag, EntityKind, FlightMode, HULLS, PIP_MAX,
  cargoTonnes, detectionRange, unpackPips, v3, type ChatChannel,
} from '@primacy2/shared';
import type { EntityView, FrameView, GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store } from '../state/store.ts';
import { bindKey, fmtDistance, fmtDuration, fmtSpeed } from './format.ts';

const NOTICE_MS = 7000;
/** Heat as a fraction of capacity above which the HUD warns. */
const HEAT_WARN = 0.85;
/** A signature above this is a cruise drive, seen across the whole system. */
const SIG_SYSTEM_WIDE = 1e12;

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

/** One row of the power display: four pips, each empty, half or full. `value` is in half-pips. */
function PipRow({ label, value, hint }: { label: string; value: number; hint: string }) {
  const pips = [];
  for (let i = 0; i < PIP_MAX; i += 2) {
    pips.push(<span key={i} class={`pip ${value >= i + 2 ? 'full' : value > i ? 'half' : ''}`} />);
  }
  return (
    <div class="side-row">
      <span class="pip-label">{label}</span>
      <span class="pip-track">{pips}</span>
      <span class="pip-key">{hint}</span>
    </div>
  );
}

/** Change of the heat fraction per second, smoothed, for the time-to-limit readout. */
const heatTrend = { at: 0, heat: 0, rate: 0 };

function heatRate(clock: number, heat: number): number {
  const dt = clock - heatTrend.at;
  if (dt < 0 || dt > 2) {
    heatTrend.at = clock;
    heatTrend.heat = heat;
    heatTrend.rate = 0;
  } else if (dt >= 0.5) {
    heatTrend.rate += ((heat - heatTrend.heat) / dt - heatTrend.rate) * 0.5;
    heatTrend.at = clock;
    heatTrend.heat = heat;
  }
  return heatTrend.rate;
}

/** The selected target: a ship with shield and hull, a wreck with its salvage, or a cargo pod with its content. */
function TargetPanel({ target, dist }: { target: EntityView; dist: number }) {
  const info = target.info;
  const wreck = info.kind === EntityKind.Wreck;
  const pod = info.kind === EntityKind.Loot;
  return (
    <div class="panel-mini">
      <h4>{t('hud.target')}</h4>
      <div class="big">{info.name}</div>
      {wreck && <div><span class="tag">{t('hud.wreck')}</span> <span class="dim">{HULLS[info.model]?.name ?? info.model}</span></div>}
      {pod && <div><span class="tag">{t('hud.pod')}</span></div>}
      {!wreck && !pod && <div class="dim">{HULLS[info.model]?.name ?? info.model}{info.npc ? ` · ${info.npc}` : ''}</div>}
      <div>{fmtDistance(dist)}</div>
      {wreck && <Bar label={t('hud.salvage')} value={target.hull} cls="salvage" />}
      {wreck && <div class="dim hint">{t('hud.salvageHint', { key: bindKey('fireTool') })}</div>}
      {pod && info.c && <div>{COMMODITIES[info.c]?.name ?? info.c} · {fmt(info.n ?? 0)} t</div>}
      {!wreck && !pod && <Bar label={t('hud.shield')} value={target.shield} cls="shield" />}
      {!wreck && !pod && <Bar label={t('hud.hull')} value={target.hull} cls="hull" />}
      {(target.flags & EntityFlag.Wanted) !== 0 && <div class="wanted">{t('hud.wanted')}</div>}
    </div>
  );
}

/** The ship-destroyed screen: what the insurance charges and what the pilot gets back. */
function Destroyed({ api }: { api: GameApi }) {
  const pilot = store.pilot.value;
  const credits = pilot?.credits ?? 0;
  const rebuy = pilot?.rebuy;
  return (
    <div class="overlay-text dead">
      <h2>{t('hud.dead')}</h2>
      {rebuy !== undefined && (
        <div class="insurance">
          <div class="ins-row"><span>{t('hud.insDeductible')}</span><b>{fmt(rebuy)} {t('hud.credits')}</b></div>
          <div class="ins-row"><span>{t('hud.insCredits')}</span><b>{fmt(credits)} {t('hud.credits')}</b></div>
          {rebuy <= 0 && <p>{t('hud.insFree')}</p>}
          {rebuy > 0 && credits >= rebuy && <p>{t('hud.insPay', { price: fmt(rebuy) })}</p>}
          {rebuy > 0 && credits < rebuy && <p class="short">{t('hud.insStarter')}</p>}
          <p class="dim">{t('hud.insCargo')}</p>
        </div>
      )}
      <button onClick={() => void api.cmd({ k: 'respawn' })}>{t('hud.respawn')}</button>
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
    const kind = e.info.kind;
    if (kind !== EntityKind.Ship && kind !== EntityKind.Loot && kind !== EntityKind.Wreck && !isTarget) continue;
    const p = api.project(e.rel);
    if (isTarget) target = e;
    if (!p.visible && !isTarget) continue;
    const pos = p.visible ? p : clampToEdge(p, w, h);
    const hostile = (e.flags & EntityFlag.Wanted) !== 0 || e.info.npc === 'pirate';
    markers.push(
      <Marker
        key={`e${e.id}`} x={pos.x} y={pos.y}
        cls={`ent ${kind === EntityKind.Loot ? 'loot' : kind === EntityKind.Wreck ? 'wreck' : hostile ? 'hostile' : e.info.player ? 'pilot' : 'npc'} ${isTarget ? 'target' : ''}`}
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

  const silent = (self.input.buttons & Button.Silent) !== 0;
  const pips = unpackPips(st.pips);
  const heat = view.fx.heat;
  const hot = heat > HEAT_WARN;
  const rate = heatRate(view.clock, heat);
  // Seconds until the heat capacity is reached at the current rate, while running silent.
  const heatLeft = silent && heat < 1 && rate > 0.002 ? (1 - heat) / rate : null;

  const warnings: string[] = [];
  if (hot) warnings.push(silent ? t('hud.warnHeatSilent', { key: bindKey('silentRunning') }) : t('hud.warnHeat'));
  if (st.fuel < stats.fuelCap * 0.15) warnings.push(t('hud.warnFuel'));
  if (st.hull < stats.hullMax * 0.25) warnings.push(t('hud.warnHull'));
  if (st.dilation < 0.98) warnings.push(t('hud.warnDilation', { factor: fmt(st.dilation, 2) }));

  return (
    <>
      <div class="reticle" />
      {vel && <div class="velocity" style={{ transform: `translate(${vel.x}px, ${vel.y}px)` }} />}
      {markers}

      <div class="hud-block hud-left">
        <Bar label={t('hud.shield')} value={stats.shieldMax > 0 ? st.shield / stats.shieldMax : 0} cls={silent ? 'shield offline' : 'shield'} />
        <Bar label={t('hud.hull')} value={st.hull / stats.hullMax} cls="hull" warn={st.hull < stats.hullMax * 0.25} />
        <Bar label={t('hud.energy')} value={st.energy / stats.energyMax} cls="energy" />
        <Bar label={t('hud.heat')} value={heat} cls={silent ? 'heat rising' : 'heat'} warn={hot} />
        <Bar label={t('hud.fuel')} value={st.fuel / stats.fuelCap} cls="fuel" warn={st.fuel < stats.fuelCap * 0.15} />
      </div>

      {/* Five rows that line up with the five bars: power beside shield, hull and energy, the heat readout beside heat. */}
      <div class="hud-block hud-power">
        <PipRow label={t('hud.pipSys')} value={pips.sys} hint={bindKey('powerShields')} />
        <PipRow label={t('hud.pipEng')} value={pips.eng} hint={bindKey('powerEngines')} />
        <PipRow label={t('hud.pipWep')} value={pips.wep} hint={bindKey('powerWeapons')} />
        <div class={`side-row heat-row ${hot ? 'hot' : silent ? 'rising' : ''}`}>
          <span class="num">{fmt(Math.min(heat, 9.99) * 100)} %</span>
          {silent && <span class="silent-tag">{t('hud.silent')}</span>}
          {silent && heat >= 1 && <span>{t('hud.heatDamage')}</span>}
          {heatLeft !== null && <span>{t('hud.heatLimit', { time: fmtDuration(heatLeft) })}</span>}
        </div>
        <div class={`side-row sig-row ${silent ? 'low' : ''}`}>
          {st.sig > SIG_SYSTEM_WIDE ? t('hud.visibleSystem') : t('hud.visible', { dist: fmtDistance(detectionRange(stats, st.sig)) })}
        </div>
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
        {target ? <TargetPanel target={target} dist={v3.dist(target.rel, self.rel)} /> : null}
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
      {view && view.mode === FlightMode.Dead && <Destroyed api={api} />}
      <div class="notices">
        {notices.map((n) => <div class={`notice ${n.level}`} key={n.id}>{n.text}</div>)}
      </div>
      <Chat api={api} />
    </div>
  );
}
