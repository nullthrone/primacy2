/**
 * The flight HUD. It re-renders every frame (it reads `store.frame`) and takes all moving
 * values from the current `FrameView`.
 */
import { useRef, useState } from 'preact/hooks';
import {
  Button, COMMODITIES, ChargeKind, DOCK_RANGE, EntityFlag, EntityKind, FlightMode, HULLS, PIP_MAX,
  anchorBody, bodySurface, cargoTonnes, detectionRange, isSurfaceAnchor, nearestGroundSite, quat, unpackPips, v3, type ChatChannel, type Vec3,
} from '@primacy2/shared';
import type { EntityView, FrameView, GameApi } from '../contracts.ts';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { findPlace, isLandmark } from '../state/places.ts';
import { store, type Notice } from '../state/store.ts';
import { bindKey, fmtDistance, fmtDuration, fmtHeight, fmtRate, fmtSpeed, keyParams } from './format.ts';
import { baseDropHere, landingCues, landingNear, liftBalance, noticeKey, type LandingCue } from './landing.ts';
import { Compass, EdgeArrows, PlaceList, PlacePanel, RateLines, SystemLines, type CompassMark, type EdgeItem } from './Orient.tsx';
import { compassDot, trackRate, type RangeRate } from './orient.ts';
import { holdInFlight } from './trade.ts';

/** Shortest and longest time a notice stays on screen. */
const NOTICE_MIN_MS = 7000;
const NOTICE_MAX_MS = 24000;
/**
 * Notices about a refused jump or a sale cut short carry a reason the pilot has to read and act
 * on. They get a heading in the pilot's language above the server's text, and stay at least this long.
 */
const NOTICE_HEAD = new Map<string, StringKey>([
  ['fold_refused', 'notice.foldRefused'],
  ['handoff_failed', 'notice.handoffFailed'],
  ['sale_limited', 'notice.saleLimited'],
  ['gate_refused', 'notice.gateRefused'],
]);
const NOTICE_HEADED_MS = 12000;
/** How long the customs report stays up after arriving in another sector. */
const ARRIVAL_MS = 25000;

/** Time a notice stays: three seconds to notice it plus reading time for its length. */
function noticeMs(n: Notice): number {
  const reading = 3000 + n.text.length * 80;
  return Math.min(NOTICE_MAX_MS, Math.max(NOTICE_HEAD.has(n.code) ? NOTICE_HEADED_MS : NOTICE_MIN_MS, reading));
}

/**
 * The sector the HUD last saw the pilot in and when that changed. Kept outside the component so
 * that it survives the HUD being taken down between two sectors.
 */
const arrival = { server: '', at: -Infinity };
/** Heat as a fraction of capacity above which the HUD warns. */
const HEAT_WARN = 0.85;
/** A signature above this is a cruise drive, seen across the whole system. */
const SIG_SYSTEM_WIDE = 1e12;
/** Below this height above the ground the key line explains landing instead of the drives, metres. */
const LANDING_HINT_HEIGHT = 2000;
/** A rate of climb below this reads as zero and is shown as a sink rate, m/s. */
const CLIMB_SHOWN = 0.05;

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

/**
 * One instrument of the ground row: a label over a number. Near a landing the number is followed
 * by the most a landing allows, and the cell turns red while that is exceeded.
 */
function GroundCell({ label, value, limit, over }: { label: string; value: string; limit?: string; over?: boolean }) {
  return (
    <div class={`ground-cell ${over ? 'over' : ''}`}>
      <span class="label">{label}</span>
      <span class="num">{value}{limit && <span class="limit"> / {limit}</span>}</span>
    </div>
  );
}

/** A landing limit in a ground cell: the present value to one decimal, the limit as it is defined. */
function cueCell(label: string, cue: LandingCue, unit: string, glue = ' ') {
  return <GroundCell label={label} value={unit === '°' ? `${fmt(cue.value, 1)}°` : fmt(cue.value, 1)} limit={`${fmt(cue.limit)}${glue}${unit}`} over={cue.over} />;
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

/** How fast the distance to the chosen place and to the locked ship changes; kept from frame to frame. */
const rates: { place: RangeRate | null; ship: RangeRate | null } = { place: null, ship: null };

/** The selected target: a ship with shield and hull, a wreck with its salvage, or a cargo pod with its content. */
function TargetPanel({ target, dist, rate }: { target: EntityView; dist: number; rate: RangeRate | null }) {
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
      <div class="num">{fmtDistance(dist)}</div>
      <RateLines dist={dist} rate={rate} eta={false} />
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
  // The home can be a ground base. Its kind is known when it lies in the system the pilot died in.
  const system = api.view?.system;
  const home = pilot && system && pilot.homeSystem === system.id ? system.sites.find((s) => s.id === pilot.homeSite) : undefined;
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
      <button onClick={() => void api.cmd({ k: 'respawn' })}>{t(home?.kind === 'base' ? 'hud.respawnBase' : 'hud.respawn')}</button>
    </div>
  );
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
  const landed = view.mode === FlightMode.Landed;
  const speed = cruise ? st.cruiseSpeed : v3.len(st.vel);
  const pilot = store.pilot.value;
  const cargo = pilot ? cargoTonnes(pilot.passport.ship.cargo) : 0;
  const sealed = pilot ? holdInFlight(pilot.passport.ship.cargo, store.serverId.value, store.galaxy.value).sealed : 0;

  // Velocity vector marker: where the ship is actually going. `self.vel` is the velocity in
  // system axes, as the projection needs it; near the ground `st.vel` is in axes that turn with the body.
  let vel: { x: number; y: number } | null = null;
  if (!cruise && speed > 3) {
    const p = api.project(v3.addScaled(self.rel, self.vel, 1000 / speed));
    if (!p.behind) vel = p;
  }

  // What is on screen gets a marker where it is; what is off screen and matters gets an arrow
  // that leads to it: the chosen place, the locked ship, and every place to dock and every gate.
  const camOf = (rel: Readonly<Vec3>): Vec3 => quat.unrotate(view.camera.rot, rel as Vec3);
  const markers = [];
  const edges: EdgeItem[] = [];
  const nav = view.navAnchor;
  for (const s of view.sites) {
    const isNav = s.def.id === nav;
    // Places to dock and gates are marked from anywhere in the system, everything else from nearby.
    const always = isLandmark(s.def.kind);
    if (!isNav && !always && s.dist > 5e9) continue;
    const p = api.project(s.rel);
    if (!p.visible) {
      if (isNav || always) edges.push({ key: `s${s.def.id}`, c: camOf(s.rel), cls: isNav ? 'nav' : 'place', name: s.def.name, dist: s.dist, big: isNav });
      continue;
    }
    const near = Math.hypot(p.x - w / 2, p.y - h / 2) < 90;
    markers.push(
      <Marker
        key={`s${s.def.id}`} x={p.x} y={p.y} cls={`site k-${s.def.kind} ${isNav ? 'nav' : ''}`}
        label={isNav || near ? s.def.name : undefined} sub={isNav || near ? fmtDistance(s.dist) : undefined}
      />,
    );
  }
  for (const b of view.bodies) {
    const isNav = b.def.id === nav;
    if (!isNav && !cruise) continue;
    const p = api.project(b.rel);
    const toSurface = Math.max(0, b.dist - b.def.radius);
    if (!p.visible) {
      if (isNav) edges.push({ key: `b${b.def.id}`, c: camOf(b.rel), cls: 'nav', name: b.def.name, dist: toSurface, big: true });
      continue;
    }
    const near = Math.hypot(p.x - w / 2, p.y - h / 2) < 70;
    if (!isNav && !near) continue;
    markers.push(
      <Marker key={`b${b.def.id}`} x={p.x} y={p.y} cls={`body ${isNav ? 'nav' : ''}`} label={b.def.name} sub={fmtDistance(toSurface)} />,
    );
  }
  let target = null;
  let targetCls = 'npc';
  for (const e of view.ents) {
    const isTarget = e.id === view.targetId;
    const kind = e.info.kind;
    if (kind !== EntityKind.Ship && kind !== EntityKind.Loot && kind !== EntityKind.Wreck && !isTarget) continue;
    const p = api.project(e.rel);
    const hostile = (e.flags & EntityFlag.Wanted) !== 0 || e.info.npc === 'pirate';
    const cls = kind === EntityKind.Loot ? 'loot' : kind === EntityKind.Wreck ? 'wreck' : hostile ? 'hostile' : e.info.player ? 'pilot' : 'npc';
    if (isTarget) {
      target = e;
      targetCls = cls;
    }
    if (!p.visible) {
      if (isTarget) edges.push({ key: `e${e.id}`, c: camOf(e.rel), cls, name: e.info.name, dist: v3.dist(e.rel, self.rel), big: true });
      continue;
    }
    markers.push(
      <Marker
        key={`e${e.id}`} x={p.x} y={p.y} cls={`ent ${cls} ${isTarget ? 'target' : ''}`}
        label={isTarget ? e.info.name : undefined} sub={isTarget ? fmtDistance(v3.dist(e.rel, self.rel)) : undefined}
      />,
    );
  }

  // The chosen place and the locked ship: how fast the distance closes, and where each lies as
  // seen from the ship's own axes, for the compass.
  const place = findPlace(view, nav);
  const targetDist = target ? v3.dist(target.rel, self.rel) : 0;
  rates.place = place ? trackRate(rates.place, `p${place.id}`, view.time, place.dist) : null;
  rates.ship = target ? trackRate(rates.ship, `e${target.id}`, view.time, targetDist) : null;
  const shipAxes = (rel: Readonly<Vec3>): Vec3 => quat.unrotate(self.rot, v3.sub(rel, self.rel));
  const compass: CompassMark[] = [];
  if (place) compass.push({ key: 'place', cls: 'nav', ...compassDot(shipAxes(place.rel)) });
  if (target) compass.push({ key: 'ship', cls: targetCls, ...compassDot(shipAxes(target.rel)) });

  const navSite = nav !== null ? view.sites.find((s) => s.def.id === nav) : undefined;
  const here = view.sites.find((s) => s.def.id === st.anchor);
  // Near the ground the ship is in the surface frame of the body, flying or landed, and the base
  // it can dock at is the nearest one on that body.
  const base = isSurfaceAnchor(st.anchor) && (view.mode === FlightMode.Normal || landed)
    ? nearestGroundSite(view.system, anchorBody(st.anchor), st.pos) : null;
  const canDock = (view.mode === FlightMode.Normal && here && (here.def.kind === 'station' || here.def.kind === 'outpost') &&
    v3.len(st.pos) < (here.def.radius ?? 300) + DOCK_RANGE) ||
    (base !== null && base.dist < (base.site.radius ?? 300) + DOCK_RANGE);

  // The ground under the ship, while the view has it: the landable body the camera is near.
  const surface = view.surface;
  const ground = surface?.ship ?? null;
  const shell = surface && ground ? bodySurface(view.system, surface.body) : null;
  // The landing cues belong to the last seconds before a touchdown; a ship that passes high over
  // the ground or climbs away is not judged by them.
  const cues = ground && view.mode === FlightMode.Normal && landingNear(ground.height, ground.verticalSpeed)
    ? landingCues(self.vel, self.rot, ground.normal, ground.slope) : null;
  const climbing = ground !== null && ground.verticalSpeed >= CLIMB_SHOWN;
  // Gravity the vertical thrusters cannot hold is told from where normal flight is in the surface
  // frame of the body, tens of kilometres up, in cruise as well: early enough to turn the main drive down.
  const lift = surface && ground && shell && v3.len(ground.pos) < shell.enter
    ? liftBalance(view.system.bodies[surface.body]!, stats, st.pips) : null;
  const heavy = lift !== null && lift.short;

  // A ground base has no frame of its own to drop into. The place to leave cruise for it is in
  // the surface frame of its body, in sight of the base and near enough to fly there.
  const navPad = navSite?.def.ground;
  const canDrop = cruise && navSite && (navPad
    ? surface?.body === navPad.body && shell !== null && baseDropHere(ground?.pos ?? surface.cam, navPad.pos, shell.enter)
    : navSite.dist < navSite.def.frameRadius);

  const silent = (self.input.buttons & Button.Silent) !== 0;
  const pips = unpackPips(st.pips);
  const heat = view.fx.heat;
  const hot = heat > HEAT_WARN;
  const rate = heatRate(view.clock, heat);
  // Seconds until the heat capacity is reached at the current rate, while running silent.
  const heatLeft = silent && heat < 1 && rate > 0.002 ? (1 - heat) / rate : null;

  const gravityText = heavy ? t('hud.warnGravity', { g: fmt(lift.gravity, 1), lift: fmt(lift.lift, 1) }) : '';
  const warnings: string[] = [];
  if (hot) warnings.push(silent ? t('hud.warnHeatSilent', { key: bindKey('silentRunning') }) : t('hud.warnHeat'));
  if (st.fuel < stats.fuelCap * 0.15) warnings.push(t('hud.warnFuel'));
  if (st.hull < stats.hullMax * 0.25) warnings.push(t('hud.warnHull'));
  if (st.dilation < 0.98) warnings.push(t('hud.warnDilation', { factor: fmt(st.dilation, 2) }));
  // A ship that stands on the ground is in no danger from it; there the same words stand calmly under the state.
  if (heavy && !landed) warnings.push(gravityText);

  const keys: StringKey = landed ? 'hud.keysLanded'
    : ground && view.mode === FlightMode.Normal && ground.height < LANDING_HINT_HEIGHT ? 'hud.keysLanding' : 'hud.keys';

  return (
    <>
      <div class="reticle" />
      {vel && <div class="velocity" style={{ transform: `translate(${vel.x}px, ${vel.y}px)` }} />}
      {markers}
      <EdgeArrows items={edges} w={w} h={h} />

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
        </div>
        <div class={`side-row sig-row ${silent ? 'low' : ''}`}>
          <span>{st.sig > SIG_SYSTEM_WIDE ? t('hud.visibleSystem') : t('hud.visible', { dist: fmtDistance(detectionRange(stats, st.sig)) })}</span>
          {silent && heat >= 1 && <span class="heat-note hot">{t('hud.heatDamage')}</span>}
          {heatLeft !== null && <span class={`heat-note ${hot ? 'hot' : ''}`}>{t('hud.heatLimit', { time: fmtDuration(heatLeft) })}</span>}
        </div>
      </div>

      <div class={`hud-block hud-centre ${ground ? 'over-ground' : ''}`}>
        {/* Which landing limits a touchdown would break right now, in words. */}
        {cues?.sink.over && <div class="landing-over">{t('hud.cueSinkOver')}</div>}
        {cues?.side.over && <div class="landing-over">{t('hud.cueSideOver')}</div>}
        {cues?.slope.over && <div class="landing-over">{t('hud.cueSlopeOver')}</div>}
        {cues?.tilt.over && <div class="landing-over">{t('hud.cueTiltOver')}</div>}
        {/* Ground instruments. With a landing near, sink rate and ground speed are the two the
            landing check measures (against the ground, not against straight down) and stand
            before their limits; slope and tilt join them on either side of the speed. */}
        {ground && !landed && (
          <div class="ground">
            <GroundCell label={t('hud.height')} value={fmtHeight(Math.max(0, ground.height))} />
            {cues
              ? cueCell(t('hud.sinkRate'), cues.sink, 'm/s')
              : <GroundCell label={t(climbing ? 'hud.climbRate' : 'hud.sinkRate')} value={fmtRate(Math.abs(ground.verticalSpeed))} />}
            {cues
              ? cueCell(t('hud.groundSpeed'), cues.side, 'm/s')
              : <GroundCell label={t('hud.groundSpeed')} value={fmtSpeed(ground.groundSpeed)} />}
          </div>
        )}
        <div class="speed-row">
          <Compass marks={compass} />
          {cues ? cueCell(t('hud.slope'), cues.slope, '°', '') : <span />}
          <div class="speed">{fmtSpeed(speed)}</div>
          {cues ? cueCell(t('hud.tilt'), cues.tilt, '°', '') : <span />}
        </div>
        <div class="throttle"><span style={{ width: `${Math.abs(st.throttle) * 100}%` }} class={st.throttle < 0 ? 'rev' : ''} /></div>
        <div class="mode">
          {landed
            ? <span class="landed">{t('hud.modeLanded')}</span>
            : <span>{t(cruise ? 'hud.modeCruise' : 'hud.modeNormal')}</span>}
          <span class={st.fa ? 'on' : 'off'}>{t(st.fa ? 'hud.assistOn' : 'hud.assistOff')}</span>
        </div>
        {landed && heavy && <div class="gravity-note">{gravityText}</div>}
        {st.chargeKind !== ChargeKind.None && (
          <div class="charge">
            <span>{t(st.chargeKind === ChargeKind.Fold ? 'hud.chargeFold' : 'hud.chargeCruise')}</span>
            <span class="bar-track"><span class="bar-fill" style={{ width: `${st.charge * 100}%` }} /></span>
          </div>
        )}
        {landed && <div class="prompt">{t('hud.liftoffPrompt', { key: bindKey('thrustUp') })}</div>}
        {canDock && <div class="prompt">{t('hud.dockPrompt', { key: bindKey('dock') })}</div>}
        {canDrop && <div class="prompt">{t('hud.dropPrompt', { key: bindKey('cruise') })}</div>}
      </div>

      <div class="hud-block hud-right">
        {target ? <TargetPanel target={target} dist={targetDist} rate={rates.ship} /> : null}
        {place && <PlacePanel place={place} behind={camOf(place.rel)[2] > 0} rate={rates.place} />}
      </div>

      <div class="hud-block hud-topleft">
        <div class="big">{view.system.name}</div>
        <div class="dim">{t(`map.security.${view.system.security}` as StringKey)} · {store.serverName.value}</div>
        <div>{fmt(pilot?.credits ?? 0)} {t('hud.credits')} · {t('hud.cargo')} {cargo}/{Math.floor(stats.cargoCap)} t</div>
        {/* Standing customs status: cargo that is worth nothing here, and a ship that refunds nothing here. */}
        {(sealed > 0 || pilot?.shipBound) && (
          <div class="customs-line">
            {sealed > 0 && <span>{t('hud.sealed', { n: fmt(sealed) })}</span>}
            {pilot?.shipBound && <span>{t('hud.shipBound')}</span>}
          </div>
        )}
        <SystemLines view={view} />
        <PlaceList view={view} now={performance.now()} />
      </div>

      {warnings.length > 0 && <div class="warnings">{warnings.map((x) => <div key={x}>{x}</div>)}</div>}
      {!store.pointerLocked.value && store.device.value !== 'pad' && store.panel.value === null && (
        <button class="capture" onClick={() => api.capturePointer()}>{t('hud.capture')}</button>
      )}
      <div class="keys">{t(keys, keyParams())}</div>
    </>
  );
}

export function Hud({ api }: { api: GameApi }) {
  // Reading the frame counter subscribes this component to every rendered frame.
  void store.frame.value;
  const view = api.view;
  const now = performance.now();
  // The market shows the outcome of a sale itself, in the pilot's language.
  const atMarket = store.panel.value === 'station';
  const notices = store.notices.value.filter((n) => now - n.at < noticeMs(n) && !(atMarket && n.code === 'sale_limited'));
  // Coming from another sector starts the customs report; the first sector of a session does not.
  const serverId = store.serverId.value;
  if (serverId && serverId !== arrival.server) {
    arrival.at = arrival.server ? now : -Infinity;
    arrival.server = serverId;
  }
  const handoff = store.phase.value === 'handoff';
  const folding = handoff || view?.mode === FlightMode.Fold;
  const foldName = handoff
    ? store.status.value
    : store.galaxy.value?.sectors.flatMap((s) => s.systems).find((s) => s.id === view?.system.id)?.name ?? view?.system.name ?? '';
  // Where the ship is docked, to tell a ground base from a station.
  const dockedAt = store.station.value;
  const dockedSite = view && dockedAt ? view.system.sites.find((s) => s.id === dockedAt.site) : undefined;

  return (
    <div class="hud">
      {view && view.self && !folding && flightHud(view, api)}
      {view && view.mode === FlightMode.Docked && store.panel.value === null && (
        <div class="hud-block hud-centre"><div class="mode"><span>{t(dockedSite?.kind === 'base' ? 'hud.modeDockedBase' : 'hud.modeDocked')}</span></div></div>
      )}
      {folding && <div class="overlay-text"><h2>{t('hud.folding', { dest: foldName })}</h2></div>}
      {view && view.mode === FlightMode.Dead && <Destroyed api={api} />}
      <div class="notices">
        {!handoff && now - arrival.at < ARRIVAL_MS && <CustomsReport />}
        {notices.map((n) => {
          const head = NOTICE_HEAD.get(n.code);
          // Notices about the ground and about cruise near it have a translation; all others are the server's text.
          const known = noticeKey(n.code, n.text);
          return (
            <div class={`notice ${n.level}`} key={n.id}>
              {head && <b class="notice-head">{t(head)}</b>}
              {known ? t(known) : n.text}
            </div>
          );
        })}
      </div>
      <Chat api={api} />
    </div>
  );
}

/**
 * What the customs of the sector just entered made of cargo and ship: tonnes sealed, tonnes that
 * count as imports, and whether the ship is bound. Shows nothing when there is nothing to report.
 */
function CustomsReport() {
  const pilot = store.pilot.value;
  if (!pilot) return null;
  const hold = holdInFlight(pilot.passport.ship.cargo, store.serverId.value, store.galaxy.value);
  const bound = pilot.shipBound;
  if (hold.sealed <= 0 && hold.imports <= 0 && !bound) return null;
  const licence = Math.max(0, pilot.licence.cap - pilot.licence.used);
  return (
    <div class="notice customs-report">
      <b class="notice-head">{t('hud.customs', { name: store.serverName.value })}</b>
      {hold.sealed > 0 && <div>{t('hud.customsSealed', { n: fmt(hold.sealed) })}</div>}
      {hold.imports > 0 && <div>{t('hud.customsImport', { n: fmt(hold.imports), tu: fmt(Math.floor(licence)) })}</div>}
      {bound && <div>{t(bound.hull && bound.slots.every(Boolean) ? 'hud.customsBound' : 'hud.customsBoundPart')}</div>}
    </div>
  );
}
