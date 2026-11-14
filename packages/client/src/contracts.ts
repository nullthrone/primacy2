/**
 * Contracts between the parts of the client. The game core builds one `FrameView` per rendered
 * frame; the renderers, HUD and audio only read it. Nothing outside the game core talks to the
 * network or mutates game state directly: the UI goes through `GameApi`.
 *
 * All positions in a `FrameView` are **relative to the camera**, in metres, in system axes
 * (non-rotating, +Y north), computed in float64. Renderers put the camera at the origin and
 * never see absolute coordinates. Velocities and orientations are in system axes too. The
 * simulation keeps ships near the ground of a landable body in a frame that turns with the body;
 * the game core turns all of that into system axes when it builds the view. Two things are
 * deliberately not in system axes and say so: the raw `SelfView.state`, and event coordinates
 * (see `zone` and `zoneRot`).
 */
import type {
  AsteroidDef,
  BodyDef,
  ChatChannel,
  Command,
  EntityInfo,
  FlightMode,
  GalaxyView,
  GameEvent,
  Quat,
  ShipInput,
  ShipState,
  ShipStats,
  SiteDef,
  SystemDef,
  Vec3,
} from '@primacy2/shared';
import type { Scene, Texture, WebGLRenderer } from 'three';

// ---------------------------------------------------------------------------------------------
// Frame view
// ---------------------------------------------------------------------------------------------

export type CameraMode = 'cockpit' | 'chase';

export interface CameraView {
  /** Camera orientation (looks along its local -Z). */
  rot: Quat;
  /** Vertical field of view in degrees. */
  fov: number;
  mode: CameraMode;
  /** Barycentric camera position in metres (float64). Only for code that needs absolute context. */
  abs: Vec3;
}

export interface BodyView {
  def: BodyDef;
  /** Centre of the body relative to the camera. */
  rel: Vec3;
  /** Distance from the camera to the centre, metres. */
  dist: number;
}

export interface SiteView {
  def: SiteDef;
  rel: Vec3;
  dist: number;
}

export interface SelfView {
  id: number;
  /** Hull id, e.g. `wisp`; the model is `models/ship_<hull>.glb`. */
  hull: string;
  /**
   * Predicted state as of this frame, as the simulation keeps it: `pos`, `vel` and `rot` are in
   * the axes of the frame of `state.anchor`, which near the ground of a landable body turn with
   * the body. Use `rel`, `vel` and `rot` below for anything that is drawn; the scalar fields
   * (hull, shield, fuel, mode, `|vel|` as the speed readout) can be read from here.
   */
  state: ShipState;
  stats: ShipStats;
  /** Ship origin relative to the camera. */
  rel: Vec3;
  /**
   * Velocity relative to the ship's anchor frame, in system axes, m/s: zero for a ship at rest
   * over the ground or at a station. In cruise it is `forward * cruiseSpeed`.
   */
  vel: Vec3;
  /** Smoothed render orientation. */
  rot: Quat;
  /** Latest input, for thruster effects. */
  input: ShipInput;
}

export interface EntityView {
  id: number;
  info: EntityInfo;
  rel: Vec3;
  /** Velocity relative to the zone's frame, in system axes: zero for a ship standing on the ground. */
  vel: Vec3;
  rot: Quat;
  /** `EntityFlag` bits. */
  flags: number;
  /** Fractions 0..1. */
  hull: number;
  shield: number;
}

/** The asteroid field of the mining site the pilot is at. */
export interface FieldView {
  site: SiteDef;
  /** Site anchor relative to the camera. Rock positions are `rel + rock.pos`. */
  rel: Vec3;
  rocks: readonly AsteroidDef[];
  /** Remaining ore fraction per rock, 0..1, index-aligned with `rocks`. */
  left: Float32Array;
}

/** The pilot's ship in relation to the ground of the landable body in `SurfaceView`. */
export interface SurfaceShipView {
  /** Ship origin in the body-fixed axes of the body, metres from its centre (float64). */
  pos: Vec3;
  /** Height of the ship's lowest point above the ground beneath it, metres; 0 when it stands on it. */
  height: number;
  /** Speed away from the body centre, m/s: positive climbing, negative sinking. */
  verticalSpeed: number;
  /** Speed along the ground, m/s, relative to the turning ground. */
  groundSpeed: number;
  /** Slope of the ground under the ship in radians, measured over the ship's footprint as the landing check does. */
  slope: number;
  /** Standing on the ground (`FlightMode.Landed`). */
  landed: boolean;
  /** Unit vector straight up at the ship (away from the body centre), system axes. */
  up: Vec3;
  /** Unit normal of the ground under the ship, system axes. */
  normal: Vec3;
}

/**
 * The landable body the camera is near, for drawing its ground and for landing readouts. Its
 * terrain is `bodyTerrain(view.system, body)` from the shared package, sampled in body-fixed axes.
 */
export interface SurfaceView {
  /** Body id (index into `system.bodies` and `FrameView.bodies`). */
  body: number;
  /** Turns the body-fixed axes of the body into system axes at `FrameView.time` (the shared `bodyRotation`). */
  rot: Quat;
  /** Camera position in body-fixed axes, metres from the body centre, float64. */
  cam: Vec3;
  /** Height of the camera above the ground beneath it, metres. */
  camHeight: number;
  /** The pilot's ship over this ground; null whenever `FrameView.self` is null. */
  ship: SurfaceShipView | null;
}

export interface FrameFx {
  /**
   * 0..1: cruise speed as a fraction of the log range between minimum and maximum cruise speed;
   * 0 outside cruise. In cruise it is never below 0.02, also at the low speeds close above a
   * landable body, so `cruise > 0` says the ship is in cruise.
   */
  cruise: number;
  /** 0..1 progress of a cruise or fold charge; 0 when nothing charges. */
  charge: number;
  /** 0 none, 1 cruise, 2 fold. */
  chargeKind: number;
  /** 0..1 progress through a fold tunnel (also while handing over to another server); 0 outside. */
  fold: number;
  /** Time dilation factor, 1 = none. */
  dilation: number;
  /** Heat as a fraction of capacity (may exceed 1). */
  heat: number;
  boosting: boolean;
  /** 1 right after taking a hit, decaying to 0. */
  hitFlash: number;
}

export interface GraphicsSettings {
  /** 0 low, 1 medium, 2 high. Renderers scale shader cost, particle counts and resolution with it. */
  quality: 0 | 1 | 2;
  bloom: boolean;
  /** Render scale relative to device pixels, 0.5..1. */
  resolution: number;
}

export interface FrameView {
  /** Universe time being rendered, seconds. */
  time: number;
  /** Seconds since the previous frame, clamped to 0.1. */
  dt: number;
  /** Seconds since the page loaded; for animations that must not follow universe time. */
  clock: number;
  system: SystemDef;
  camera: CameraView;
  /** Index-aligned with `system.bodies`. */
  bodies: BodyView[];
  /** Index-aligned with `system.sites`. */
  sites: SiteView[];
  /**
   * The pilot's own ship, or null while it has no position or is not flown (fold tunnel, handoff,
   * docked, destroyed, not yet spawned). A ship standing on the ground (`FlightMode.Landed`) is
   * here like a flying one.
   */
  self: SelfView | null;
  mode: FlightMode;
  /** Other ships, cargo pods and missiles, interpolated. */
  ents: EntityView[];
  field: FieldView | null;
  /**
   * Position of the origin of the current zone's frame relative to the camera, in system axes;
   * null outside normal space. In a surface frame the origin is the centre of the body.
   */
  zone: Vec3 | null;
  /**
   * Orientation of the zone's frame: turns its axes into system axes. The identity except in a
   * surface frame, where the axes turn with the body. Null exactly when `zone` is null.
   * Event coordinates (`GameEvent.at`) are in this frame: an event is seen at
   * `zone + rotate(zoneRot, at)` relative to the camera. Whatever must stay in place relative to
   * the zone over several frames (an effect on the ground) has to be kept in the frame's own
   * coordinates and turned each frame.
   */
  zoneRot: Quat | null;
  /** The landable body the camera is near (its centre within three radii), or null. */
  surface: SurfaceView | null;
  /** Game events that arrived since the previous frame. */
  events: GameEvent[];
  fx: FrameFx;
  galaxy: GalaxyView | null;
  targetId: number | null;
  /** Anchor id of the navigation target (a body or site), or null. */
  navAnchor: number | null;
  graphics: GraphicsSettings;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Lighting of the local scene, derived by the space renderer from the stars of the system. */
export interface Lighting {
  /** Unit vector from the camera toward the dominant light, system axes. */
  sunDir: Vec3;
  /** Linear RGB, 0..1. */
  sunColor: [number, number, number];
  /** Scene-referred intensity for a directional light (about 3 near a sun-like star at 1 AU). */
  sunIntensity: number;
  /** Ambient level 0..1 (starlight, planet shine). */
  ambient: number;
  /** Prefiltered environment map of the sky for reflections, when available. */
  envMap: Texture | null;
}

/**
 * Everything near the camera: ships, stations, gates, asteroids, cargo, effects and the cockpit.
 * The space renderer owns the WebGL renderer and the frame; it calls `update` once per frame and
 * then draws `scene` and afterwards `cockpit` (with a cleared depth buffer) using its own camera.
 * Objects are placed at their camera-relative position; the camera sits at the origin of both scenes.
 */
export interface LocalLayer {
  readonly scene: Scene;
  /** Geometry attached to the camera in cockpit view; rendered last with its own depth range. */
  readonly cockpit: Scene;
  init(renderer: WebGLRenderer): Promise<void>;
  update(view: FrameView, light: Lighting): void;
  dispose(): void;
}

/** The top-level renderer. Owns the canvas, the passes and post-processing. */
export interface GameRenderer {
  init(local: LocalLayer): Promise<void>;
  /** Draws one frame. Called with null while there is nothing to show (menu): renders an idle backdrop. */
  render(view: FrameView | null): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Game API used by the UI
// ---------------------------------------------------------------------------------------------

/** `data` on a refusal is machine-readable detail, when the server gives any (for a sale: the trade limit that stopped it). */
export type CmdReply = { ok: true; data?: unknown } | { ok: false; err: string; data?: unknown };

export interface ScreenPoint {
  /** CSS pixels from the top-left of the view. */
  x: number;
  y: number;
  /** True when the point is in front of the camera and inside the view. */
  visible: boolean;
  /** True when the point is behind the camera (x, y then point toward the nearest screen edge). */
  behind: boolean;
}

export interface GameApi {
  /** The most recent frame view, or null before the first frame in a system. */
  readonly view: FrameView | null;
  /** Connects to a server (base URL, e.g. `https://example.org`) and logs in with the stored identity. */
  connect(serverUrl: string, pilotName: string): Promise<void>;
  disconnect(): void;
  /** Sends a command and resolves with the server's reply. */
  cmd(command: Command): Promise<CmdReply>;
  chat(channel: ChatChannel, text: string): void;
  setTarget(entityId: number | null): void;
  /** Selects the next (+1) or previous (-1) contact as target. */
  cycleTarget(dir: 1 | -1): void;
  setNav(anchorId: number | null): void;
  /**
   * Chooses the next (+1) or previous (-1) place of the system as the navigation target, in the
   * order of `listPlaces` (places to dock first), and opens the list of places on the HUD.
   */
  cycleNav(dir: 1 | -1): void;
  /** Selects the destination system for the next fold jump (does not start it). */
  setFoldTarget(systemId: string | null): void;
  toggleCruise(): void;
  /** Starts charging a fold jump to the selected destination. */
  startFold(): void;
  toggleFlightAssist(): void;
  setCameraMode(mode: CameraMode): void;
  /** Projects a camera-relative point to the screen. */
  project(rel: Readonly<Vec3>): ScreenPoint;
  /** Captures the mouse for flight (pointer lock). */
  capturePointer(): void;
  releasePointer(): void;
  /** The pilot's identity: a key pair kept in this browser. */
  readonly identity: {
    readonly id: string;
    /** Secret key as text, for the pilot to back up. */
    exportKey(): string;
    /** Replaces the identity. Returns false when the text is not a valid key. */
    importKey(text: string): boolean;
  };
}
