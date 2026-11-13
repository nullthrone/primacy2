/**
 * The local layer is assembled from parts with one owner each. A part owns a subtree of the local
 * scene (and optionally of the cockpit scene) and reads the frame view. Parts do not know each
 * other; whatever they need about the world is in the `FrameView`.
 *
 * Conventions every part follows:
 *
 * - **Camera at the origin.** Both scenes are drawn with the camera at the origin. Objects are
 *   placed at their camera-relative position (`rel` in the frame view, metres, system axes).
 *   Absolute coordinates never reach float32.
 * - **Scene-referred linear colour.** The space renderer draws into a half-float target and
 *   tone-maps and encodes once, in its final pass. Materials must leave tone mapping off and write
 *   linear radiance; values above about 1 bloom.
 * - **Depth ranges.** The local scene is drawn from 0.5 m to 400 km, the cockpit scene from 5 cm
 *   to 100 m, each with a freshly cleared depth buffer. Celestial bodies are already in the colour
 *   buffer behind both.
 * - **Lights belong to `objects`.** The `objects` part adds the sun and ambient lights to both
 *   scenes. Effects are self-lit and need none.
 * - **No allocation per frame** in `update`; reuse vectors, matrices and buffers.
 */
import type { Object3D, WebGLRenderer } from 'three';
import type { FrameView, Lighting } from '../../contracts.ts';

export type PartName = 'objects' | 'fx' | 'terrain';

export interface Part {
  /** Added to the local scene. */
  readonly root: Object3D;
  /** Added to the cockpit scene, when the part draws there. */
  readonly cockpitRoot?: Object3D;
  /** Loads assets and compiles what it can ahead of the first frame. */
  init(renderer: WebGLRenderer): Promise<void>;
  update(view: FrameView, light: Lighting): void;
  dispose(): void;
}
