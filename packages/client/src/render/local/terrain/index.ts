/**
 * The ground of the landable body the camera is near, drawn from the shared terrain function so
 * that what is seen is what ships land on.
 *
 *   cube.ts      the cube sphere and its tiles
 *   bake.ts      mesh, normal and tone map of a tile, and the far map, from the shared terrain
 *   worker.ts    runs the bakes off the main thread
 *   pool.ts      the workers and the queue of jobs
 *   tiles.ts     the quadtree of one body: which tiles, how fine, where
 *   material.ts  the tile shader: level-of-detail slide, lighting, shadow, small relief
 *   shade.ts     colour and lighting of the ground, shared with the far view
 *   farmap.ts    the far maps the space layer draws landable bodies from
 *   relief.ts    the hand-over between far view and tiles by height
 *
 * The part reads `view.surface`: which body, how it is turned, and the camera position in the
 * body's own axes in float64. Its root is turned like the body, so everything below it lives in
 * body-fixed axes with the camera at the origin.
 */
import { Color, Group, Vector2, type WebGLRenderer } from 'three';
import { bodyTerrain, type TerrainParams } from '@primacy2/shared';
import type { FrameView, Lighting } from '../../../contracts.ts';
import type { Part } from '../part.ts';
import { disposeFarMaps, enableFarMaps, farMap } from './farmap.ts';
import { groundUniforms } from './material.ts';
import { terrainPool } from './pool.ts';
import { handoverAltitude, reliefAt } from './relief.ts';
import { groundKind } from './shade.ts';
import { Ground, type GroundStats } from './tiles.ts';

/** Seconds the tiles of a body are kept after the camera has left it. */
const LINGER = 15;

/** What the part is doing, for the development page and for measurements. Not used by the game. */
export const terrainDebug: {
  /** The tiles of the body near the camera, or null. */
  ground: Ground | null;
  stats: GroundStats | null;
  /** Relief factor 0..1 and whether the tiles are drawn this frame. */
  relief: number;
  shown: boolean;
  /** Milliseconds the part's update took this frame. */
  updateMs: number;
} = { ground: null, stats: null, relief: 0, shown: false, updateMs: 0 };

/** Rotates `v` by the quaternion `q` (or by its inverse) into `out`, without allocating. */
function rotate(q: ArrayLike<number>, x: number, y: number, z: number, inverse: boolean, out: Float64Array): void {
  const s = inverse ? -1 : 1;
  const qx = q[0]! * s, qy = q[1]! * s, qz = q[2]! * s, qw = q[3]!;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

export function createTerrain(): Part {
  const root = new Group();
  const uniforms = groundUniforms();
  const buffer = new Vector2(1280, 720);
  const colour = new Color();
  const right = new Float64Array(3);
  const up = new Float64Array(3);
  const forward = new Float64Array(3);
  const tmp = new Float64Array(3);
  let renderer: WebGLRenderer | null = null;
  let ground: Ground | null = null;
  let params: TerrainParams | null = null;
  let quality = -1;
  let serial = 0;
  let leftAt = 0;

  const drop = (): void => {
    if (!ground) return;
    root.remove(ground.group);
    ground.dispose();
    ground = null;
    params = null;
    terrainDebug.ground = null;
    terrainDebug.stats = null;
  };
  // After a lost context every texture and buffer is gone: start over.
  const restored = (): void => {
    drop();
    disposeFarMaps();
  };

  return {
    root,

    async init(r: WebGLRenderer): Promise<void> {
      renderer = r;
      r.domElement.addEventListener('webglcontextrestored', restored);
      // Starts the workers, so the first tiles do not wait for them.
      if (terrainPool().available) enableFarMaps();
    },

    update(view: FrameView, light: Lighting): void {
      const t0 = performance.now();
      const s = view.surface;
      const terrain = s ? bodyTerrain(view.system, s.body) : null;
      if (!s || !terrain) {
        // Away from any ground: the tiles are hidden at once and freed a little later.
        if (ground) {
          ground.group.visible = false;
          if (view.clock - leftAt > LINGER) drop();
        }
        terrainDebug.shown = false;
        terrainDebug.updateMs = performance.now() - t0;
        return;
      }
      leftAt = view.clock;
      const def = view.system.bodies[s.body]!;
      if (terrain !== params || view.graphics.quality !== quality || !ground) {
        drop();
        params = terrain;
        quality = view.graphics.quality;
        const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
        ground = new Ground(`ground${++serial}`, terrain, terrainPool(), uniforms, quality === 2 ? 4 : 2, Math.min(maxAniso, quality === 0 ? 2 : 8));
        root.add(ground.group);
        colour.setHex(def.color);
        uniforms.uBase.value.set(colour.r, colour.g, colour.b);
        uniforms.uKind.value = groundKind(def.cls);
        uniforms.uRadius.value = def.radius;
        uniforms.uDetail.value = quality === 0 ? 0 : 1;
        terrainDebug.ground = ground;
        terrainDebug.stats = ground.stats;
      }

      // The root turns like the body; the camera's axes are needed in the body's own.
      root.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      const cq = view.camera.rot;
      rotate(cq, 1, 0, 0, false, tmp);
      rotate(s.rot, tmp[0]!, tmp[1]!, tmp[2]!, true, right);
      rotate(cq, 0, 1, 0, false, tmp);
      rotate(s.rot, tmp[0]!, tmp[1]!, tmp[2]!, true, up);
      rotate(cq, 0, 0, -1, false, tmp);
      rotate(s.rot, tmp[0]!, tmp[1]!, tmp[2]!, true, forward);

      const dist = Math.hypot(s.cam[0], s.cam[1], s.cam[2]);
      const relief = reliefAt(def.radius, dist);
      // High up the tiles lean on the far map; without it they wait until the relief is full.
      const far = relief < 1 ? farMap(view.system, s.body, view.clock) : null;
      const below = dist - def.radius < handoverAltitude(def.radius);
      const show = below && ground.covered && (relief >= 1 || (far !== null && far.texture !== null));
      uniforms.uRelief.value = relief;
      uniforms.uFar.value = far ? far.texture : null;

      // The same light the objects part gives three's lights, for a scene that has none of its own.
      rotate(cq, light.sunDir[0], light.sunDir[1], light.sunDir[2], true, tmp);
      uniforms.uSunView.value.set(tmp[0]!, tmp[1]!, tmp[2]!);
      uniforms.uSunColor.value.set(light.sunColor[0], light.sunColor[1], light.sunColor[2]).multiplyScalar(light.sunIntensity);
      uniforms.uAmbient.value.setScalar(light.ambient);

      if (renderer) renderer.getDrawingBufferSize(buffer);
      ground.group.visible = show;
      ground.update(s.cam, right, up, forward, Math.tan((view.camera.fov * Math.PI) / 360), buffer.x / buffer.y, view.clock, show);
      terrainDebug.relief = relief;
      terrainDebug.shown = show;
      terrainDebug.updateMs = performance.now() - t0;
    },

    dispose(): void {
      renderer?.domElement.removeEventListener('webglcontextrestored', restored);
      drop();
      disposeFarMaps();
    },
  };
}
