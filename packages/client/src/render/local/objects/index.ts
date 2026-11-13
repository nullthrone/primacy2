/**
 * Solid things near the camera: ships, stations, gates, beacons, asteroids, cargo pods, missiles,
 * wrecks and the cockpit, plus the lights of both local scenes.
 *
 *   models.ts      model cache, stand-ins, nozzle and lamp positions
 *   lights.ts      the star and the ambient term, with the shadow box
 *   craft.ts       ships, wrecks, pods and missiles, pooled by entity id
 *   structures.ts  stations, outposts, beacons and gates with their portal
 *   asteroids.ts   the asteroid field, instanced
 *   exhaust.ts     engine plumes and attitude jets
 *   glints.ts      lamps and far-away objects as points of light
 */
import { HULLS, STRUCTURES } from '@primacy2/shared';
import { Group, Vector2, type Object3D, type WebGLRenderer } from 'three';
import type { FrameView, Lighting } from '../../../contracts.ts';
import type { Part } from '../part.ts';
import { sunVisibility, wrap } from '../util.ts';
import { Rocks } from './asteroids.ts';
import { Fleet } from './craft.ts';
import { Exhaust } from './exhaust.ts';
import { Glints } from './glints.ts';
import { SunRig } from './lights.ts';
import { ModelLibrary } from './models.ts';
import { Structures } from './structures.ts';

/** Shadow map edge by quality level; 0 means no shadows. */
const SHADOW_MAP = [0, 1024, 2048] as const;
/** The cockpit model reaches about two metres from the pilot's eye. */
const COCKPIT_REACH = 2.2;

export function createObjects(): Part {
  const root = new Group();
  const cockpitRoot = new Group();
  const lib = new ModelLibrary();
  const sun = new SunRig(root);
  const cabinSun = new SunRig(cockpitRoot, 0.06);
  const exhaust = new Exhaust();
  const glints = new Glints();
  const fleet = new Fleet(lib, exhaust, glints);
  const structures = new Structures(lib, glints);
  const rocks = new Rocks(lib);
  // The cockpit is fixed to the view: it turns with the camera while its light stays in system axes.
  const cabin = new Group();
  let cabinModel: Object3D | null = null;
  cabin.visible = false;
  root.add(structures.group, rocks.group, fleet.group, exhaust.mesh, glints.points);
  cockpitRoot.add(cabin);

  let renderer: WebGLRenderer | null = null;
  /** What the shadow box is locked to: 0 nothing, 1 a structure, 2 a ship. */
  let focus = 0;
  const buffer = new Vector2(1280, 720);
  /** The lighting as it reaches the camera; refilled every frame. */
  const lit: Lighting = { sunDir: [0, 1, 0], sunColor: [1, 1, 1], sunIntensity: 0, ambient: 0, envMap: null };

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
      jobs.push(lib.load('cargo_pod', 2), lib.load('missile', 1.5));
      jobs.push(lib.load('cockpit_generic', 0).then((model) => {
        cabinModel = lib.instantiate(model);
        cabin.add(cabinModel);
      }));
      await Promise.all(jobs);
    },

    update(view: FrameView, light: Lighting): void {
      if (renderer) renderer.getDrawingBufferSize(buffer);
      // Pixels per radian at the centre of the view: turns an angular size into a size on screen.
      const pxPerRad = buffer.y / (2 * Math.tan((view.camera.fov * Math.PI) / 360));
      const quality = view.graphics.quality;
      const map = SHADOW_MAP[quality];

      // Near the ground of a landable body the sun sets: on its night side nothing here is sunlit.
      // The star light the renderer hands out knows no horizon, so it is dimmed here for this part.
      const shade = sunVisibility(view, light.sunDir);
      lit.sunDir = light.sunDir;
      lit.sunColor = light.sunColor;
      lit.sunIntensity = light.sunIntensity * shade;
      lit.ambient = light.ambient;
      lit.envMap = light.envMap;
      light = lit;

      lib.materials.setEnv(light.envMap);
      exhaust.begin(wrap(view.clock, 600), quality);
      glints.begin(light);
      structures.update(view, light, light.sunDir, pxPerRad);
      rocks.update(view, pxPerRad);
      fleet.update(view, pxPerRad);
      exhaust.end();
      glints.end();

      // One shadow box, given to whatever is largest on screen: a structure the pilot is close
      // to, the pilot's own ship, or else the nearest other ship.
      const structAngle = structures.focusBound > 0 ? structures.focusBound / structures.focusDist : 0;
      const ownAngle = fleet.ownRadius > 0 ? fleet.ownRadius / Math.max(fleet.ownPos.length(), 1) : 0;
      const nearAngle = fleet.nearRadius > 0 ? fleet.nearRadius / Math.max(fleet.nearPos.length(), 1) : 0;
      // The current holder keeps the box until the other is clearly larger, so the shadows do not
      // flicker while the pilot hovers at the distance where the two are the same size.
      const structWins = structAngle > (focus === 1 ? 0.1 : 0.12) && structAngle >= ownAngle * (focus === 1 ? 0.8 : 1.25);
      if (structWins) {
        focus = 1;
        const p = structures.focusPos;
        const b = structures.focusBound;
        sun.update(light, p.x, p.y, p.z, b * 1.05, b * 2.5, map * 2, view.dt);
      } else if (ownAngle > 0 || nearAngle > 0.012) {
        focus = 2;
        const p = ownAngle > 0 ? fleet.ownPos : fleet.nearPos;
        const radius = ownAngle > 0 ? fleet.ownRadius : fleet.nearRadius;
        // The box is ship-sized but reaches far toward the sun, so a station in between still shades the ship.
        const reach = structures.focusBound > 0 && structures.focusDist < 6000 ? structures.focusDist + structures.focusBound * 2 : radius * 6;
        sun.update(light, p.x, p.y, p.z, radius * 1.5, reach, map, view.dt);
      } else {
        focus = 0;
        sun.update(light, 0, 0, 0, 0, 100, 0, view.dt);
      }

      const inCockpit = view.camera.mode === 'cockpit' && view.self !== null && cabinModel !== null;
      cabin.visible = inCockpit;
      if (inCockpit) {
        const q = view.camera.rot;
        cabin.quaternion.set(q[0], q[1], q[2], q[3]);
      }
      cabinSun.update(light, 0, 0, 0, inCockpit ? COCKPIT_REACH : 0, COCKPIT_REACH * 3, Math.min(map, 1024), view.dt);
    },

    dispose(): void {
      fleet.dispose();
      structures.dispose();
      rocks.dispose();
      exhaust.dispose();
      glints.dispose();
      lib.dispose();
      root.clear();
      cockpitRoot.clear();
    },
  };
}
