/**
 * Solid things near the camera: ships, stations, gates, beacons, asteroids, cargo pods, missiles,
 * wrecks and the cockpit, plus the lights of both local scenes.
 *
 *   models.ts      model cache, stand-ins, nozzle and lamp positions
 *   lights.ts      the star and the ambient term, with the shadow box
 *   craft.ts       ships, wrecks, pods and missiles, pooled by entity id
 *   exhaust.ts     engine plumes and attitude jets
 *   glints.ts      lamps and far-away objects as points of light
 */
import { HULLS, STRUCTURES } from '@primacy2/shared';
import { Group, Vector2, type WebGLRenderer } from 'three';
import type { FrameView, Lighting } from '../../../contracts.ts';
import type { Part } from '../part.ts';
import { wrap } from '../util.ts';
import { Fleet } from './craft.ts';
import { Exhaust } from './exhaust.ts';
import { Glints } from './glints.ts';
import { SunRig } from './lights.ts';
import { ModelLibrary } from './models.ts';

/** Shadow map edge by quality level; 0 means no shadows. */
const SHADOW_MAP = [0, 1024, 2048] as const;

export function createObjects(): Part {
  const root = new Group();
  const cockpitRoot = new Group();
  const lib = new ModelLibrary();
  const sun = new SunRig(root);
  const exhaust = new Exhaust();
  const glints = new Glints();
  const fleet = new Fleet(lib, exhaust, glints);
  root.add(fleet.group, exhaust.mesh, glints.points);

  let renderer: WebGLRenderer | null = null;
  const buffer = new Vector2(1280, 720);

  return {
    root,
    cockpitRoot,

    async init(r: WebGLRenderer): Promise<void> {
      renderer = r;
      SunRig.prepare(r);
      // Everything the game can show is loaded up front, so nothing pops in during flight.
      const jobs: Promise<unknown>[] = [];
      for (const [id, hull] of Object.entries(HULLS)) jobs.push(lib.load(`ship_${id}`, hull.radius));
      for (const def of Object.values(STRUCTURES)) jobs.push(lib.load(def.model, def.bound));
      for (let i = 0; i < 4; i++) jobs.push(lib.load(`asteroid_${i}`, 1));
      jobs.push(lib.load('cargo_pod', 2), lib.load('missile', 1.5), lib.load('cockpit_generic', 0));
      await Promise.all(jobs);
    },

    update(view: FrameView, light: Lighting): void {
      if (renderer) renderer.getDrawingBufferSize(buffer);
      // Pixels per radian at the centre of the view: turns an angular size into a size on screen.
      const pxPerRad = buffer.y / (2 * Math.tan((view.camera.fov * Math.PI) / 360));
      const quality = view.graphics.quality;

      lib.materials.setEnv(light.envMap);
      exhaust.begin(wrap(view.clock, 600), quality);
      glints.begin(light);
      fleet.update(view, pxPerRad);
      exhaust.end();
      glints.end();

      // The shadow box follows the pilot's ship, or else the nearest ship worth a shadow.
      sun.setLight(light);
      const map = SHADOW_MAP[quality];
      if (fleet.ownRadius > 0) {
        const p = fleet.ownPos;
        sun.aim(light, p.x, p.y, p.z, fleet.ownRadius * 1.5, fleet.ownRadius * 6, map, view.dt);
      } else if (fleet.nearRadius > 0 && fleet.nearPos.length() < fleet.nearRadius * 80) {
        const p = fleet.nearPos;
        sun.aim(light, p.x, p.y, p.z, fleet.nearRadius * 1.5, fleet.nearRadius * 6, map, view.dt);
      } else {
        sun.aim(light, 0, 0, 0, 0, 100, 0, view.dt);
      }
    },

    dispose(): void {
      fleet.dispose();
      exhaust.dispose();
      glints.dispose();
      lib.dispose();
      root.clear();
      cockpitRoot.clear();
    },
  };
}
