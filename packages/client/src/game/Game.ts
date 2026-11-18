/**
 * The game core: owns the connection, predicts the pilot's own ship, interpolates everything else
 * and produces one `FrameView` per rendered frame. It is the only writer of the store and the
 * only part that talks to the network.
 */
import {
  CRUISE_MIN_SPEED,
  ChargeKind,
  DT,
  EntityKind,
  FOLD_TUNNEL_TIME,
  CRUISE_TURN_FACTOR,
  FlightMode,
  SITE_ID_BASE,
  allBodyStates,
  computeShipStats,
  findSite,
  forwardOf,
  generateAsteroids,
  idFromPublicKey,
  quat,
  simulateShip,
  v3,
  type AsteroidDef,
  type ChatChannel,
  type Command,
  type EntityInfo,
  type GameEvent,
  type KeyPair,
  type Quat,
  type S2C,
  type ShipInput,
  type ShipState,
  type ShipStats,
  type Snapshot,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import type { GameAudio } from '../audio/index.ts';
import type { CameraMode, CmdReply, EntityView, FrameView, GameApi, GameRenderer, ScreenPoint } from '../contracts.ts';
import { Input } from '../input/Input.ts';
import { ConnectError, Connection, normalizeServerUrl, type Welcome } from '../net/Connection.ts';
import { importIdentity, loadIdentity } from '../net/identity.ts';
import { AHEAD_COS, PLACE_LIST_MS, aheadChoice, listPlaces, placeAhead, stepPlace } from '../state/places.ts';
import { store, updateSettings, type BindAction, type Contact, type Panel } from '../state/store.ts';
import { chaseCamera, frameUp, liftAboveGround, rotToSystem, sceneryView, surfaceView, toSystem, viewFrame, type ViewFrame } from './surface.ts';

export interface GameDeps {
  canvas: HTMLCanvasElement;
  renderer: GameRenderer;
  audio: GameAudio;
}

export interface Game extends GameApi {
  /** Starts the frame loop. */
  start(): void;
  /** Exposed for automated tests. */
  readonly input: Input;
}

interface Sample {
  t: number;
  pos: Vec3;
  vel: Vec3;
  rot: Quat;
  flags: number;
  hull: number;
  shield: number;
}

/** Other entities are drawn this far in the past so there are always two snapshots to blend. */
const INTERP_DELAY = 0.12;
const MAX_EXTRAPOLATION = 0.25;
/** Pilot eye position per hull in ship axes, metres. */
const EYE: Record<string, Vec3> = {
  wisp: [0, 0.9, -2.2],
  lancet: [0, 0.8, -2.6],
  drover: [0, 4.6, -14],
  delver: [0, 2.6, -8],
  wayfarer: [0, 1.6, -7],
  bulwark: [0, 4.0, -10],
};

const cloneState = (s: ShipState): ShipState => ({
  ...s,
  pos: [s.pos[0], s.pos[1], s.pos[2]],
  vel: [s.vel[0], s.vel[1], s.vel[2]],
  rot: [s.rot[0], s.rot[1], s.rot[2], s.rot[3]],
  angVel: [s.angVel[0], s.angVel[1], s.angVel[2]],
  aim: [s.aim[0], s.aim[1]],
});
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/**
 * Modes in which the pilot's ship is simulated here tick by tick and drawn: in flight, and
 * standing on the ground, where the next input may lift it off again.
 */
const isFlying = (m: FlightMode): boolean => m === FlightMode.Normal || m === FlightMode.Cruise || m === FlightMode.Landed;
/**
 * Normal flight and standing on the ground are one and the same zone: touching down or lifting
 * off changes nothing about who is around or which frame their positions are in.
 */
const zoneClass = (m: FlightMode): FlightMode => (m === FlightMode.Landed ? FlightMode.Normal : m);
/** The docked camera circles a ground base at least this far above the terrain, metres. */
const DOCK_CAMERA_CLEARANCE = 60;
const NO_FRAME: ViewFrame = { anchor: -1, pos: [0, 0, 0], rot: null };

class GameImpl implements Game {
  view: FrameView | null = null;
  readonly input: Input;
  readonly identity: GameApi['identity'];

  private keys: KeyPair = loadIdentity();
  private conn: Connection | null = null;
  private system: SystemDef | null = null;
  private selfId = 0;
  private stats: ShipStats | null = null;
  private hull = 'wisp';
  /** Predicted state at the latest simulated tick, and the tick before it for interpolation. */
  private pred: ShipState | null = null;
  private prev: ShipState | null = null;
  /** Inputs sent but not yet acknowledged by a snapshot. */
  private pending: ShipInput[] = [];
  private lastInput: ShipInput = { seq: 0, thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0 };
  private seq = 0;
  private acc = 0;
  private last = 0;
  private lastTick = -1;
  /** Visual offset that hides reconciliation corrections; decays to zero. */
  private err: Vec3 = [0, 0, 0];
  /** Universe seconds minus local seconds. */
  private timeOffset = 0;
  private readonly tracks = new Map<number, Sample[]>();
  private readonly infos = new Map<number, EntityInfo>();
  private trackAnchor = -9;
  /** `zoneClass` of the mode the entity samples belong to. */
  private trackMode: FlightMode = FlightMode.Docked;
  private events: GameEvent[] = [];
  private readonly rocks = new Map<number, readonly AsteroidDef[]>();
  private readonly rockLeft = new Map<number, Float32Array>();
  /** Orientation the chase camera has reached, in system axes. */
  private chaseRot: Quat = [0, 0, 0, 1];
  private lastCamRot: Quat = [0, 0, 0, 1];
  private hitFlash = 0;
  private foldStart = 0;
  /** Counts handoffs and disconnects, so a handoff that waits in the tunnel knows when it was overtaken. */
  private handoffs = 0;
  private noticeId = 0;
  private nextContacts = 0;
  private nextPing = 0;
  private frames = 0;
  private fpsSince = 0;
  private reconnects = 0;
  private pilotName = '';

  constructor(private readonly deps: GameDeps) {
    this.input = new Input(deps.canvas);
    this.input.onAction = (a) => this.onAction(a);
    const self = this;
    this.identity = {
      get id() {
        return idFromPublicKey(self.keys.publicKey);
      },
      exportKey: () => this.keys.secretKey,
      importKey: (text) => {
        const k = importIdentity(text);
        if (!k) return false;
        this.keys = k;
        return true;
      },
    };
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('beforeunload', (e) => {
      // Leaving mid-flight is usually an accident (Ctrl+W while thrusting down). A ship standing
      // on the ground is found again where it stands, so leaving then needs no warning.
      if (store.phase.value === 'playing' && this.pred && (this.pred.mode === FlightMode.Normal || this.pred.mode === FlightMode.Cruise)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  start(): void {
    this.resize();
    this.last = performance.now() / 1000;
    this.fpsSince = this.last;
    requestAnimationFrame(this.frame);
  }

  // -------------------------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------------------------

  async connect(serverUrl: string, pilotName: string): Promise<void> {
    const url = normalizeServerUrl(serverUrl);
    this.pilotName = pilotName.trim() || 'Pilot';
    updateSettings({ pilotName: this.pilotName, lastServer: url });
    store.phase.value = 'connecting';
    store.error.value = null;
    store.status.value = url;
    this.deps.audio.unlock();
    try {
      await this.open(url, undefined, 0);
      this.reconnects = 0;
    } catch (err) {
      store.phase.value = 'menu';
      store.error.value = err instanceof Error ? err.message : String(err);
    }
  }

  disconnect(): void {
    this.handoffs++;
    this.conn?.close();
    this.conn = null;
    this.reset();
    this.input.release();
    store.phase.value = 'menu';
    store.panel.value = null;
    store.station.value = null;
  }

  /** Opens a connection and makes it the current one. Follows "your ship is elsewhere" redirects. */
  private async open(url: string, ticket: Extract<S2C, { t: 'handoff' }>['ticket'] | undefined, hops: number): Promise<void> {
    const conn: Connection = new Connection(url, this.keys, this.pilotName, ticket, {
      onMessage: (m) => {
        if (this.conn === conn) this.onMessage(m);
      },
      onSnapshot: (s) => {
        if (this.conn === conn) this.onSnapshot(s);
      },
      onClose: (reason) => {
        if (this.conn === conn) void this.onLost(reason);
      },
    });
    let welcome: Welcome;
    try {
      welcome = await conn.open();
    } catch (err) {
      const redirect = err instanceof ConnectError ? err.fail?.redirect : undefined;
      if (redirect && err instanceof ConnectError && err.fail?.code === 'elsewhere' && hops < 3) {
        store.status.value = redirect.url;
        return this.open(redirect.url, undefined, hops + 1);
      }
      throw err;
    }
    this.conn?.close();
    this.conn = conn;
    this.reset();
    store.serverId.value = welcome.server.id;
    store.serverName.value = welcome.server.name;
    store.serverUrl.value = url;
    store.pilot.value = welcome.pilot;
    store.station.value = null;
    this.setLoadout();
    this.timeOffset = welcome.universeTime - performance.now() / 1000;
    store.phase.value = 'playing';
    store.status.value = '';
    updateSettings({ lastServer: url });
    void conn.cmd({ k: 'galaxy' });
  }

  private async onLost(reason: string): Promise<void> {
    const url = this.conn?.url;
    this.conn = null;
    if (!url || this.reconnects >= 3) {
      this.reset();
      store.phase.value = 'menu';
      store.error.value = reason;
      return;
    }
    this.reconnects++;
    store.phase.value = 'connecting';
    store.status.value = url;
    await new Promise((r) => setTimeout(r, 1000 * this.reconnects));
    try {
      await this.open(url, undefined, 0);
      this.reconnects = 0;
    } catch (err) {
      this.reset();
      store.phase.value = 'menu';
      store.error.value = err instanceof Error ? err.message : reason;
    }
  }

  /** The server sent the pilot to another server: connect there with the ticket, or go back. */
  private async handoff(m: Extract<S2C, { t: 'handoff' }>): Promise<void> {
    const old = this.conn;
    const back = old?.url;
    this.conn = null;
    old?.close();
    store.phase.value = 'handoff';
    store.status.value = store.galaxy.value?.sectors.find((s) => s.id === m.server)?.name ?? m.url;
    this.foldStart = performance.now() / 1000;
    if (this.pred) this.pred.mode = FlightMode.Fold;
    // The ship spends the tunnel time under way, as in a jump inside one sector. Connecting takes
    // a few hundredths of a second and the other server places the ship straight into its
    // system, so without this wait there may be no frame at all in which the tunnel is seen.
    const jump = ++this.handoffs;
    await new Promise((r) => setTimeout(r, FOLD_TUNNEL_TIME * 1000));
    // The pilot went back to the menu or connected elsewhere while the ship was in the tunnel.
    if (jump !== this.handoffs || store.phase.value !== 'handoff') return;
    try {
      await this.open(m.url, m.ticket, 0);
    } catch (err) {
      const why = err instanceof Error ? err.message : 'no answer';
      // Reconnecting to the origin voids the ticket there and puts the ship back.
      try {
        if (!back) throw err;
        await this.open(back, undefined, 0);
        this.notice('warn', 'handoff_failed', `The jump failed: ${why}`);
      } catch {
        this.reset();
        store.phase.value = 'menu';
        store.error.value = why;
      }
    }
  }

  private reset(): void {
    this.system = null;
    this.pred = null;
    this.prev = null;
    this.pending = [];
    this.tracks.clear();
    this.infos.clear();
    this.events = [];
    this.rocks.clear();
    this.rockLeft.clear();
    this.err = [0, 0, 0];
    this.lastTick = -1;
    this.acc = 0;
    this.view = null;
    store.system.value = null;
    store.contacts.value = [];
    store.targetId.value = null;
    store.navAnchor.value = null;
    store.navList.value = null;
  }

  private setLoadout(): void {
    const p = store.pilot.value;
    if (!p) return;
    this.stats = computeShipStats(p.passport.ship.loadout);
    this.hull = this.stats.hull;
  }

  // -------------------------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------------------------

  private onMessage(m: S2C): void {
    switch (m.t) {
      case 'system':
        this.system = m.def;
        this.selfId = m.self;
        this.pred = null;
        this.prev = null;
        this.pending = [];
        this.tracks.clear();
        this.infos.clear();
        this.rocks.clear();
        this.rockLeft.clear();
        this.err = [0, 0, 0];
        store.system.value = m.def;
        store.contacts.value = [];
        store.targetId.value = null;
        store.navAnchor.value = null;
        store.navList.value = null;
        break;
      case 'site': {
        const sys = this.system;
        if (!sys || sys.id !== m.system) break;
        const i = sys.sites.findIndex((s) => s.id === m.site.id);
        if (i >= 0) sys.sites[i] = m.site;
        else sys.sites.push(m.site);
        store.system.value = { ...sys };
        this.system = store.system.value;
        break;
      }
      case 'ent+':
        for (const e of m.e) this.infos.set(e.id, e);
        break;
      case 'ent-':
        for (const id of m.ids) {
          this.infos.delete(id);
          this.tracks.delete(id);
          if (store.targetId.value === id) store.targetId.value = null;
        }
        break;
      case 'ev':
        for (const e of m.e) {
          if (e.e === 'hit' && e.id === this.selfId) this.hitFlash = 1;
          if (e.e === 'ast' && this.pred) this.setRockLeft(this.pred.anchor, e.ast, e.left);
          this.events.push(e);
        }
        if (this.events.length > 600) this.events.splice(0, this.events.length - 600);
        break;
      case 'pilot':
        store.pilot.value = { ...(store.pilot.value as NonNullable<typeof store.pilot.value>), ...m.p };
        this.setLoadout();
        break;
      case 'station':
        store.station.value = m.s;
        break;
      case 'galaxy':
        store.galaxy.value = m.g;
        break;
      case 'chat':
        store.chat.value = [...store.chat.value.slice(-199), m.m];
        break;
      case 'notice':
        this.notice(m.level, m.code, m.text);
        break;
      case 'pong': {
        const now = performance.now();
        const rtt = Math.max(0, now - m.c);
        store.ping.value = Math.round(rtt);
        const est = m.u + rtt / 2000 - now / 1000;
        this.timeOffset = Math.abs(est - this.timeOffset) > 1 ? est : this.timeOffset + (est - this.timeOffset) * 0.2;
        break;
      }
      case 'handoff':
        void this.handoff(m);
        break;
      case 'kick':
        store.error.value = m.reason;
        break;
      default:
        break;
    }
  }

  private notice(level: 'info' | 'warn' | 'danger', code: string, text: string): void {
    store.notices.value = [...store.notices.value.slice(-7), { id: ++this.noticeId, level, code, text, at: performance.now() }];
    this.deps.audio.ui(level === 'info' ? 'notice' : 'warning');
  }

  private setRockLeft(siteId: number, index: number, left: number): void {
    let arr = this.rockLeft.get(siteId);
    if (!arr) {
      const n = this.rocksOf(siteId).length;
      arr = new Float32Array(n).fill(1);
      this.rockLeft.set(siteId, arr);
    }
    if (index >= 0 && index < arr.length) arr[index] = left;
  }

  private rocksOf(siteId: number): readonly AsteroidDef[] {
    let list = this.rocks.get(siteId);
    if (!list) {
      const site = this.system ? findSite(this.system, siteId) : undefined;
      list = site && this.system ? generateAsteroids(this.system, site) : [];
      this.rocks.set(siteId, list);
    }
    return list;
  }

  // -------------------------------------------------------------------------------------------
  // Prediction and reconciliation
  // -------------------------------------------------------------------------------------------

  private universeTime(): number {
    return performance.now() / 1000 + this.timeOffset;
  }

  private onSnapshot(s: Snapshot): void {
    if (s.tick <= this.lastTick) return;
    this.lastTick = s.tick;
    const me = s.self;
    const sys = this.system;
    const stats = this.stats;
    if (!me || !sys || !stats) return;

    // Entity samples live in the frame of the server's own-ship anchor at that tick.
    if (me.anchor !== this.trackAnchor || zoneClass(me.mode) !== this.trackMode) {
      this.tracks.clear();
      this.trackAnchor = me.anchor;
      this.trackMode = zoneClass(me.mode);
    }
    for (const e of s.ents) {
      let list = this.tracks.get(e.id);
      if (!list) this.tracks.set(e.id, (list = []));
      list.push({ t: s.time, pos: v3.add(me.pos, e.pos), vel: e.vel, rot: e.rot, flags: e.flags, hull: e.hull, shield: e.shield });
      if (list.length > 8) list.shift();
    }

    const before = this.pred;
    if (before && before.mode !== me.mode) {
      this.input.setMode(me.mode);
      if (me.mode === FlightMode.Fold) this.foldStart = performance.now() / 1000;
      if (me.mode === FlightMode.Docked || me.mode === FlightMode.Dead) this.input.release();
    }

    if (!isFlying(me.mode)) {
      this.pred = cloneState(me);
      this.prev = cloneState(me);
      this.pending = [];
      this.err = [0, 0, 0];
      return;
    }

    const next = cloneState(me);
    this.pending = this.pending.filter((i) => i.seq > s.ackSeq);
    let k = 0;
    for (const i of this.pending) simulateShip(next, i, stats, sys, s.time + k++ * DT, DT);

    const prev = this.prev;
    if (before && prev && before.mode === next.mode && before.anchor === next.anchor && prev.anchor === next.anchor) {
      const delta = v3.sub(next.pos, before.pos);
      const limit = next.mode === FlightMode.Cruise ? Math.max(200, next.cruiseSpeed * 0.5) : 60;
      if (v3.len(delta) > limit) {
        this.err = [0, 0, 0];
        this.prev = cloneState(next);
      } else {
        // Shift the interpolation start by the same correction and absorb it in the visual
        // offset, so the drawn position does not jump; the offset then fades out.
        v3.addScaledIn(prev.pos, delta, 1);
        v3.addScaledIn(this.err, delta, -1);
      }
    } else {
      this.prev = cloneState(next);
      this.err = [0, 0, 0];
    }
    this.pred = next;
  }

  private tick(): void {
    const st = this.pred;
    const sys = this.system;
    const stats = this.stats;
    const conn = this.conn;
    if (!st || !sys || !stats || !conn || !isFlying(st.mode)) return;
    // Stick deflection is a share of the hull's turn rate, which cruise reduces.
    const turn = st.mode === FlightMode.Cruise ? CRUISE_TURN_FACTOR : 1;
    this.input.turnRates = [stats.turnYaw * turn, stats.turnPitch * turn];
    const input: ShipInput = { seq: ++this.seq, ...this.input.sample(st.mode, DT) };
    conn.send({ t: 'in', i: input });
    this.lastInput = input;
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift();
    this.prev = cloneState(st);
    const anchor = st.anchor;
    const mode = st.mode;
    simulateShip(st, input, stats, sys, this.universeTime(), DT);
    if (st.anchor !== anchor) {
      // Crossed into another sphere of influence or frame: positions are now in different axes.
      this.prev = cloneState(st);
      this.err = [0, 0, 0];
    }
    // Touching down and lifting off are predicted here before the server confirms them.
    if (st.mode !== mode) this.input.setMode(st.mode);
  }

  // -------------------------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------------------------

  private readonly frame = (nowMs: number): void => {
    requestAnimationFrame(this.frame);
    const now = nowMs / 1000;
    const dt = clamp(now - this.last, 0, 0.1);
    this.last = now;

    if (store.phase.value === 'playing' && this.pred && isFlying(this.pred.mode)) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 4) {
        this.tick();
        this.acc -= DT;
        steps++;
      }
      if (this.acc > DT) this.acc = 0;
    } else {
      this.acc = 0;
    }
    const fade = Math.exp(-dt / 0.1);
    this.err = [this.err[0] * fade, this.err[1] * fade, this.err[2] * fade];
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.5);

    this.view = store.phase.value === 'playing' || store.phase.value === 'handoff' ? this.buildView(now, dt) : null;
    this.deps.renderer.render(this.view);
    this.deps.audio.update(this.view);
    store.frame.value++;

    this.frames++;
    if (now - this.fpsSince >= 1) {
      store.fps.value = Math.round(this.frames / (now - this.fpsSince));
      this.frames = 0;
      this.fpsSince = now;
    }
    if (now >= this.nextContacts) {
      this.nextContacts = now + 0.25;
      this.updateContacts();
    }
    if (now >= this.nextPing && this.conn?.ready) {
      this.nextPing = now + 2;
      this.conn.send({ t: 'ping', c: performance.now() });
    }
  };

  private resize(): void {
    const c = this.deps.canvas;
    const ratio = Math.min(2, window.devicePixelRatio || 1) * clamp(store.settings.value.graphics.resolution, 0.5, 1);
    this.deps.renderer.resize(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight, ratio);
  }

  private buildView(now: number, dt: number): FrameView | null {
    const sys = this.system;
    const st = this.pred;
    const stats = this.stats;
    if (!sys || !st || !stats) return null;
    const t = this.universeTime();
    const settings = store.settings.value;
    const flying = isFlying(st.mode);

    // Own ship pose in its anchor frame, between the last two predicted ticks.
    let shipPos: Vec3 = v3.clone(st.pos);
    let shipRot: Quat = st.rot;
    const prev = this.prev;
    if (flying && prev && prev.anchor === st.anchor) {
      const a = clamp(this.acc / DT, 0, 1);
      shipPos = v3.add(v3.lerp(prev.pos, st.pos, a), this.err);
      shipRot = quat.slerp(prev.rot, st.rot, a);
    }

    // The frame all of that is in. Near the ground of a landable body its axes turn with the
    // body: everything that leaves this function is turned into system axes here.
    const bodyStates = allBodyStates(sys, t);
    const placed = st.mode !== FlightMode.Fold && st.anchor >= 0;
    const frame = placed ? viewFrame(sys, st.anchor, t, bodyStates) : NO_FRAME;
    const anchorAbs = frame.pos;
    const shipRotSys = rotToSystem(frame, shipRot);

    // Camera: its position in the frame of the anchor (exact near the ship), its orientation in
    // system axes. A camera outside the ship is kept above the terrain.
    let camLocal: Vec3;
    let camRot: Quat;
    const mode: CameraMode = settings.camera;
    if (!placed) {
      camLocal = [3e10, 1e10, 3e10];
      camRot = this.lastCamRot;
    } else if (st.mode === FlightMode.Docked) {
      // Docked: a slow orbit around the station. The axes of a ground base have +Y along the pad
      // normal, so there the orbit runs level around the base.
      const site = findSite(sys, st.anchor);
      const d = (site?.radius ?? 300) * 2.6 + 400;
      const a = now * 0.03;
      camLocal = liftAboveGround(sys, frame, [Math.cos(a) * d, d * 0.22, Math.sin(a) * d], DOCK_CAMERA_CLEARANCE);
      camRot = rotToSystem(frame, quat.lookRotation(v3.neg(camLocal)));
    } else if (st.mode === FlightMode.Dead) {
      // Destroyed: a look back at the place from above and behind ("above" is away from the ground).
      const up = frameUp(frame, shipPos);
      const back = v3.normalize(v3.cross(Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1], up));
      camLocal = liftAboveGround(sys, frame, v3.add(shipPos, v3.add(v3.scale(up, 40), v3.scale(back, 120))));
      camRot = rotToSystem(frame, quat.lookRotation(v3.sub(shipPos, camLocal), up));
    } else {
      const look = quat.mul(quat.fromAxisAngle([0, 1, 0], this.input.look[0]), quat.fromAxisAngle([1, 0, 0], this.input.look[1]));
      if (mode === 'chase') {
        // The camera follows in system axes, so a change of frame does not disturb it. Over a
        // landed ship it comes to rest: the ship's orientation then only turns with the body.
        this.chaseRot = quat.slerp(this.chaseRot, shipRotSys, 1 - Math.exp(-dt * 9));
        camRot = quat.mul(this.chaseRot, look);
        camLocal = chaseCamera(sys, frame, shipPos, camRot, stats.radius);
      } else {
        this.chaseRot = shipRotSys;
        camRot = quat.mul(shipRotSys, look);
        camLocal = v3.add(shipPos, quat.rotate(shipRot, EYE[this.hull] ?? [0, 1, -2]));
      }
    }
    this.lastCamRot = camRot;
    // `camSys` is the camera relative to the origin of the anchor frame, in system axes.
    const { camSys, bodies, sites } = sceneryView(sys, t, frame, camLocal, bodyStates);

    const ents: EntityView[] = [];
    if (flying && st.anchor === this.trackAnchor && zoneClass(st.mode) === this.trackMode) {
      const at = t - INTERP_DELAY - store.ping.value / 2000;
      for (const [id, samples] of this.tracks) {
        const info = this.infos.get(id);
        if (!info || samples.length === 0) continue;
        const e = interpolate(samples, at);
        ents.push({
          id, info, rel: toSystem(frame, v3.sub(e.pos, camLocal)), vel: toSystem(frame, e.vel), rot: rotToSystem(frame, e.rot),
          flags: e.flags, hull: e.hull, shield: e.shield,
        });
      }
    }

    const site = st.mode === FlightMode.Normal && st.anchor >= SITE_ID_BASE ? findSite(sys, st.anchor) : undefined;
    const rocks = site && (site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly') ? this.rocksOf(site.id) : null;
    let left = site ? this.rockLeft.get(site.id) : undefined;
    if (site && rocks && !left) {
      left = new Float32Array(rocks.length).fill(1);
      this.rockLeft.set(site.id, left);
    }

    const handoff = store.phase.value === 'handoff';
    const foldT = (now - this.foldStart) / FOLD_TUNNEL_TIME;
    const cruiseSpan = Math.log(stats.cruiseMax / CRUISE_MIN_SPEED);
    const events = this.events;
    this.events = [];
    // In normal space, flying or landed, the ship is in a zone: effects and events live there.
    const inZone = placed && zoneClass(st.mode) === FlightMode.Normal;

    return {
      time: t,
      dt,
      clock: now,
      system: sys,
      camera: { rot: camRot, fov: settings.fov + (st.boost > 0 ? 6 : 0), mode, abs: v3.add(anchorAbs, camSys) },
      bodies,
      sites,
      self: flying
        ? {
          id: this.selfId, hull: this.hull, state: st, stats, rel: toSystem(frame, v3.sub(shipPos, camLocal)),
          vel: toSystem(frame, st.vel), rot: shipRotSys, input: this.lastInput,
        }
        : null,
      mode: st.mode,
      ents,
      field: site && rocks && left ? { site, rel: v3.neg(camSys), rocks, left } : null,
      zone: inZone ? v3.neg(camSys) : null,
      zoneRot: inZone ? (frame.rot ?? [0, 0, 0, 1]) : null,
      // The ship's ground data is taken at the position it is drawn at, between two ticks.
      surface: placed ? surfaceView(sys, t, frame, camLocal, bodyStates, flying ? { state: { ...st, pos: shipPos }, stats } : null) : null,
      events,
      fx: {
        // Never zero in cruise: close above a landable body the speed falls below the bottom of the scale.
        cruise: st.mode === FlightMode.Cruise ? clamp(Math.log(Math.max(st.cruiseSpeed, CRUISE_MIN_SPEED) / CRUISE_MIN_SPEED) / cruiseSpan, 0.02, 1) : 0,
        charge: st.chargeKind !== ChargeKind.None ? st.charge : 0,
        chargeKind: st.chargeKind,
        // A handoff shows the same progress as a jump inside the sector, and pulses for as long
        // as the other server takes to answer after that.
        fold: st.mode === FlightMode.Fold ? (handoff && foldT >= 1 ? 0.5 + 0.4 * Math.sin(now * 2) : clamp(foldT, 0.02, 1)) : 0,
        dilation: st.dilation,
        heat: st.heat / stats.heatCap,
        boosting: st.boost > 0,
        hitFlash: this.hitFlash,
      },
      galaxy: store.galaxy.value,
      targetId: store.targetId.value,
      navAnchor: store.navAnchor.value,
      graphics: settings.graphics,
    };
  }

  private updateContacts(): void {
    const v = this.view;
    if (!v || !v.self) {
      if (store.contacts.value.length) store.contacts.value = [];
      return;
    }
    const list: Contact[] = v.ents.map((e) => ({
      id: e.id, info: e.info, dist: v3.dist(e.rel, v.self!.rel), hull: e.hull, shield: e.shield, flags: e.flags,
    }));
    list.sort((a, b) => a.dist - b.dist);
    store.contacts.value = list;
  }

  // -------------------------------------------------------------------------------------------
  // GameApi
  // -------------------------------------------------------------------------------------------

  cmd(command: Command): Promise<CmdReply> {
    return this.conn ? this.conn.cmd(command) : Promise.resolve({ ok: false, err: 'Not connected.' });
  }

  /** Sends a command and shows a refusal as a notice. */
  private async act(command: Command): Promise<void> {
    const res = await this.cmd(command);
    if (!res.ok) this.notice('warn', 'refused', res.err);
  }

  chat(channel: ChatChannel, text: string): void {
    void this.act({ k: 'chat', ch: channel, text });
  }

  setTarget(entityId: number | null): void {
    store.targetId.value = entityId;
    void this.cmd({ k: 'target', id: entityId });
  }

  cycleTarget(dir: 1 | -1): void {
    const ships = store.contacts.value.filter((c) => c.info.kind === EntityKind.Ship);
    if (!ships.length) return this.setTarget(null);
    const i = ships.findIndex((c) => c.id === store.targetId.value);
    this.setTarget(ships[(i + dir + ships.length) % ships.length]!.id);
  }

  /**
   * Takes whatever is closest to the nose: a ship, or a wreck or cargo pod to work on (missiles
   * are skipped), or else a place. What a press does with them is the rule in `aheadChoice`.
   */
  private targetAhead(): void {
    const v = this.view;
    if (!v || !v.self) return;
    const fwd = forwardOf(v.self.rot);
    let best: number | null = null;
    let bestCos = AHEAD_COS;
    for (const e of v.ents) {
      const kind = e.info.kind;
      if (kind !== EntityKind.Ship && kind !== EntityKind.Wreck && kind !== EntityKind.Loot) continue;
      const d = v3.normalize(v3.sub(e.rel, v.self.rel));
      const c = v3.dot(d, fwd);
      if (c > bestCos) {
        bestCos = c;
        best = e.id;
      }
    }
    const place = placeAhead(v, v.self.rel, fwd, AHEAD_COS);
    const shipsInRange = store.contacts.value.some((c) => c.info.kind === EntityKind.Ship);
    const choice = aheadChoice(best, place?.id ?? null, store.targetId.value, store.navAnchor.value, shipsInRange);
    if (choice.do === 'lock') this.setTarget(choice.id);
    else if (choice.do === 'place') this.setNav(choice.id);
    else if (choice.do === 'nextShip') this.cycleTarget(1);
  }

  setNav(anchorId: number | null): void {
    store.navAnchor.value = anchorId;
  }

  cycleNav(dir: 1 | -1): void {
    const v = this.view;
    if (!v) return;
    const now = performance.now();
    const open = store.navList.value;
    // While the HUD shows its list the order stays as it is; after that it is taken afresh.
    const ids = open && now - open.at < PLACE_LIST_MS ? open.ids : listPlaces(v).map((p) => p.id);
    const next = stepPlace(ids, store.navAnchor.value, dir);
    store.navList.value = { ids, at: now };
    if (next !== null) this.setNav(next);
  }

  /** Lets go of the ship lock; with no ship locked, of the chosen place. */
  private clearTarget(): void {
    if (store.targetId.value !== null) this.setTarget(null);
    else this.setNav(null);
  }

  setFoldTarget(systemId: string | null): void {
    store.foldTarget.value = systemId;
  }

  toggleCruise(): void {
    const st = this.pred;
    if (!st) return;
    if (st.mode === FlightMode.Cruise) {
      const nav = store.navAnchor.value;
      void this.act(nav !== null && nav >= SITE_ID_BASE ? { k: 'cruise', on: false, site: nav } : { k: 'cruise', on: false });
    } else if (st.mode === FlightMode.Normal || st.mode === FlightMode.Landed) {
      // From the ground the server answers with the reason (lift off first).
      void this.act({ k: 'cruise', on: st.chargeKind !== ChargeKind.Cruise });
    }
  }

  startFold(): void {
    const st = this.pred;
    if (!st) return;
    if (st.chargeKind === ChargeKind.Fold) {
      void this.act({ k: 'foldCancel' });
      return;
    }
    const target = store.foldTarget.value;
    if (!target) {
      this.notice('info', 'no_fold_target', 'Select a destination on the galaxy map first.');
      return;
    }
    void this.act({ k: 'fold', system: target });
  }

  toggleFlightAssist(): void {
    this.input.faOff = !this.input.faOff;
  }

  setCameraMode(mode: CameraMode): void {
    updateSettings({ camera: mode });
  }

  project(rel: Readonly<Vec3>): ScreenPoint {
    const v = this.view;
    const w = this.deps.canvas.clientWidth || window.innerWidth;
    const h = this.deps.canvas.clientHeight || window.innerHeight;
    if (!v) return { x: w / 2, y: h / 2, visible: false, behind: true };
    const c = quat.unrotate(v.camera.rot, rel as Vec3);
    const tan = Math.tan((v.camera.fov * Math.PI) / 360);
    const depth = -c[2];
    const behind = depth <= 1e-6;
    // Behind the camera the projection flips; mirror it so edge arrows point the right way.
    const d = behind ? Math.max(1e-6, -depth) : depth;
    let nx = c[0] / d / (tan * (w / h));
    let ny = c[1] / d / tan;
    if (behind) {
      const len = Math.hypot(nx, ny) || 1;
      nx = (nx / len) * 2;
      ny = (ny / len) * 2;
    }
    return { x: (nx * 0.5 + 0.5) * w, y: (-ny * 0.5 + 0.5) * h, visible: !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1, behind };
  }

  capturePointer(): void {
    this.deps.audio.unlock();
    this.input.capture();
  }

  releasePointer(): void {
    this.input.release();
  }

  private togglePanel(p: Exclude<Panel, null>): void {
    const open = store.panel.value === p;
    store.panel.value = open ? null : p;
    if (!open) {
      this.input.release();
      if (p === 'galaxy') void this.cmd({ k: 'galaxy' });
    }
  }

  private onAction(a: BindAction): void {
    const st = this.pred;
    const live = this.input.active();
    switch (a) {
      case 'menu':
        if (store.panel.value) store.panel.value = null;
        else this.togglePanel('menu');
        return;
      case 'galaxyMap':
        return this.togglePanel('galaxy');
      case 'systemMap':
        return this.togglePanel('system');
      case 'contacts':
        return this.togglePanel('contacts');
      case 'chat':
        return this.togglePanel('chat');
      default:
        break;
    }
    if (!st || store.panel.value !== null) return;
    switch (a) {
      case 'dock':
        void this.act(st.mode === FlightMode.Docked ? { k: 'undock' } : { k: 'dock' });
        return;
      case 'camera':
        return this.setCameraMode(store.settings.value.camera === 'cockpit' ? 'chase' : 'cockpit');
      default:
        break;
    }
    if (!live) return;
    switch (a) {
      case 'cruise':
        return this.toggleCruise();
      case 'fold':
        return this.startFold();
      case 'targetNext':
        return this.cycleTarget(1);
      case 'targetPrev':
        return this.cycleTarget(-1);
      case 'targetAhead':
        return this.targetAhead();
      case 'targetClear':
        return this.clearTarget();
      case 'navNext':
        return this.cycleNav(1);
      case 'navPrev':
        return this.cycleNav(-1);
      default:
        break;
    }
  }
}

/** State of an entity at time `at`, blended between the two surrounding samples. */
function interpolate(samples: Sample[], at: number): Sample {
  const lastS = samples[samples.length - 1]!;
  if (at >= lastS.t) {
    // Starved: continue along the last known velocity for a short while.
    const ext = Math.min(at - lastS.t, MAX_EXTRAPOLATION);
    return { ...lastS, pos: v3.addScaled(lastS.pos, lastS.vel, ext) };
  }
  for (let i = samples.length - 2; i >= 0; i--) {
    const a = samples[i]!;
    if (a.t <= at) {
      const b = samples[i + 1]!;
      const f = (at - a.t) / Math.max(1e-6, b.t - a.t);
      return { ...b, pos: v3.lerp(a.pos, b.pos, f), rot: quat.slerp(a.rot, b.rot, f) };
    }
  }
  return samples[0]!;
}

export function createGame(deps: GameDeps): Game {
  return new GameImpl(deps);
}
