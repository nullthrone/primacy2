/**
 * Contracts between the parts of the client. The game core builds one `FrameView` per rendered
 * frame; the renderers, HUD and audio only read it. Nothing outside the game core talks to the
 * network or mutates game state directly: the UI goes through `GameApi`.
 *
 * All positions in a `FrameView` are **relative to the camera**, in metres, in system axes
 * (non-rotating, +Y north), computed in float64. Renderers put the camera at the origin and
 * never see absolute coordinates.
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
  /** Predicted state as of this frame. */
  state: ShipState;
  stats: ShipStats;
  /** Ship origin relative to the camera. */
  rel: Vec3;
  /** Smoothed render orientation. */
  rot: Quat;
  /** Latest input, for thruster effects. */
  input: ShipInput;
}

export interface EntityView {
  id: number;
  info: EntityInfo;
  rel: Vec3;
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

export interface FrameFx {
  /** 0..1: cruise speed as a fraction of the log range between minimum and maximum cruise speed; 0 outside cruise. */
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
  /** The pilot's own ship, or null while it has no position (fold tunnel, handoff, not yet spawned). */
  self: SelfView | null;
  mode: FlightMode;
  /** Other ships, cargo pods and missiles, interpolated. */
  ents: EntityView[];
  field: FieldView | null;
  /** Position of the current zone anchor relative to the camera; null outside normal space. Event coordinates are relative to this anchor. */
  zone: Vec3 | null;
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

export type CmdReply = { ok: true; data?: unknown } | { ok: false; err: string };

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
