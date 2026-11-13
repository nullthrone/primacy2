/**
 * Landing lights. Below `LANDING_LIGHT_HEIGHT` above the ground of a landable body a ship switches
 * on the lamp under its nose. On every ship that lamp is a point of light (drawn by `craft.ts`);
 * for the pilot's own ship it is also a real spot light, so the ground, a pad and whatever stands
 * near are lit by it and a landing at night can be flown by eye.
 *
 * The lamp is a working light, not a searchlight. It is regulated: its output follows the square
 * of the height, so the pool of light under the ship keeps the same modest brightness (about a
 * sixth of sunlit ground) from `REGULATED_TO` metres down to the ground, and thins out above that
 * until it is switched off. In daylight it is turned far down, where the sun drowns it anyway.
 *
 * The light is in the scene from the start and only changes strength: a light that comes or goes
 * makes the renderer rebuild every lit shader.
 */
import { FlightMode, bodySurface, terrainHeight, type BodySurface } from '@primacy2/shared';
import { SpotLight, type Object3D } from 'three';
import type { FrameView } from '../../../contracts.ts';
import { clamp, clamp01, damp } from '../util.ts';

/** Height of a ship's lowest point above the ground, metres, below which its landing light burns. */
export const LANDING_LIGHT_HEIGHT = 500;
/** The lamp comes up to full strength over this many metres of descent. */
const SWITCH_ON = 60;
/** Illuminance of the ground in the middle of the pool; direct sunlight is about 3. */
const POOL = 0.5;
/** Up to this distance from the ground the lamp holds the pool at `POOL`; above, the pool thins with the square. */
const REGULATED_TO = 250;
/** Share of its night strength the lamp keeps in daylight. */
const DAY_LEVEL = 0.15;
/** Half angle of the cone and the share of it over which the edge fades. */
const HALF_ANGLE = 0.58;
const PENUMBRA = 0.75;
/** The beam leaves the ship's underside leaning this far toward the nose, radians. */
const FORWARD = 0.38;

/** Height above the ground of points given relative to the camera, by the shared terrain. */
export class GroundProbe {
  private surface: BodySurface | null = null;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private qx = 0;
  private qy = 0;
  private qz = 0;
  private qw = 1;

  /** Takes the ground of the landable body the camera is near, if any. */
  begin(view: FrameView): void {
    const s = view.surface;
    this.surface = s ? bodySurface(view.system, s.body) : null;
    if (!s) return;
    this.cx = s.cam[0];
    this.cy = s.cam[1];
    this.cz = s.cam[2];
    // The conjugate of the body's rotation turns system axes into its body-fixed axes.
    this.qx = -s.rot[0];
    this.qy = -s.rot[1];
    this.qz = -s.rot[2];
    this.qw = s.rot[3];
  }

  /**
   * Height in metres of the camera-relative point (x, y, z), system axes, above the ground beneath
   * it; `Infinity` away from any landable body, and for points higher than `limit` above the
   * highest ground of the body, which are answered without asking the terrain.
   */
  height(x: number, y: number, z: number, limit: number): number {
    const surface = this.surface;
    if (!surface) return Infinity;
    const qx = this.qx, qy = this.qy, qz = this.qz, qw = this.qw;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    const bx = this.cx + x + qw * tx + (qy * tz - qz * ty);
    const by = this.cy + y + qw * ty + (qz * tx - qx * tz);
    const bz = this.cz + z + qw * tz + (qx * ty - qy * tx);
    const r = Math.sqrt(bx * bx + by * by + bz * bz);
    if (!(r > 0) || r > surface.top + limit) return Infinity;
    return r - surface.radius - terrainHeight(surface.terrain, bx / r, by / r, bz / r);
  }
}

/** How brightly a ship's landing lamp burns, 0..1, at `height` metres above the ground. */
export const landingLampLevel = (height: number): number => clamp01((LANDING_LIGHT_HEIGHT - height) / SWITCH_ON);

/** The landing light of the pilot's own ship. */
export class LandingLight {
  readonly light = new SpotLight(0xfff3df, 0, 0, HALF_ANGLE, PENUMBRA, 2);
  /** 0..1: how far the lamp is switched on, for the point of light on the hull. */
  level = 0;

  constructor(parent: Object3D) {
    parent.add(this.light, this.light.target);
  }

  /** `sunlight` is how much of the sun reaches the camera, 0..1 (`sunVisibility`). */
  update(view: FrameView, sunlight: number): void {
    const self = view.self;
    const ship = view.surface?.ship;
    const flying = view.mode === FlightMode.Normal || view.mode === FlightMode.Landed;
    const want = self && ship && flying ? landingLampLevel(ship.height) : 0;
    this.level = damp(this.level, want, 6, view.dt);
    if (!self || !ship || this.level < 0.002) {
      this.light.intensity = 0;
      return;
    }
    // Up and forward of the ship in system axes.
    const q = self.rot;
    const ux = 2 * (q[0] * q[1] - q[3] * q[2]), uy = 1 - 2 * (q[0] * q[0] + q[2] * q[2]), uz = 2 * (q[1] * q[2] + q[3] * q[0]);
    const fx = -2 * (q[0] * q[2] + q[3] * q[1]), fy = -2 * (q[1] * q[2] - q[3] * q[0]), fz = -(1 - 2 * (q[0] * q[0] + q[1] * q[1]));
    // The light is put half a hull radius above the ship's origin and shines through the hull,
    // which casts no shadow in it: a lamp at its true place under the nose would be so close to
    // the ground of a landed ship that it lit a dazzling spot and nothing else.
    const lift = 0.5 * self.stats.radius;
    const px = self.rel[0] + ux * lift, py = self.rel[1] + uy * lift, pz = self.rel[2] + uz * lift;
    const down = Math.cos(FORWARD), ahead = Math.sin(FORWARD);
    const light = this.light;
    light.position.set(px, py, pz);
    light.target.position.set(px + (fx * ahead - ux * down) * 100, py + (fy * ahead - uy * down) * 100, pz + (fz * ahead - uz * down) * 100);
    // Distance from the light to the ground along the beam, for a level ship.
    const reach = clamp((ship.height + self.stats.belly + lift) / down, 1, REGULATED_TO);
    light.intensity = POOL * reach * reach * this.level * (DAY_LEVEL + (1 - DAY_LEVEL) * (1 - sunlight));
  }
}
