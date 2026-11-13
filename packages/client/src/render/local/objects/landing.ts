/**
 * Landing lights. Below `LANDING_LIGHT_HEIGHT` above the ground of a landable body a ship switches
 * on the lamp under its nose. On every ship that lamp is a point of light (drawn by `craft.ts`);
 * for the pilot's own ship it is also a real spot light, so the ground, a pad and whatever stands
 * near are lit by it and a landing at night can be flown by eye.
 *
 * The beam leans forward, halfway between straight down and the nose, and is wide: it lights the
 * ground from under the ship to a few ship heights ahead, which is the ground a pilot looks at
 * over the nose from the cockpit and from the chase camera. The lit patch shrinks and sharpens as
 * the ship comes down, and that is how a pilot reads the last metres.
 *
 * The lamp is a working light, not a searchlight. It is regulated: its output follows the square
 * of the distance its beam travels to the ground, so where the middle of the beam meets the
 * ground it gives the same modest light (a fifth of direct sunlight; nearer the ship up to twice
 * that) from far up down to the ground. Its power ends at 250 m of beam, about 160 m of height:
 * above that the patch thins out, and at 500 m, where the lamp is switched on, it is a glimmer.
 * The numbers are in `util.ts`, shared with the dust the lamp shines on. In daylight the lamp is
 * turned far down, where the sun drowns it anyway.
 *
 * The light is in the scene from the start and only changes strength: a light that comes or goes
 * makes the renderer rebuild every lit shader.
 */
import { FlightMode, bodySurface, terrainHeight, type BodySurface } from '@primacy2/shared';
import { SpotLight, type Object3D } from 'three';
import type { FrameView } from '../../../contracts.ts';
import { LAMP_DROP, LAMP_FORE, LAMP_FORWARD, LAMP_HALF_ANGLE, LAMP_PENUMBRA, damp, landingLampIntensity, landingLampLevel } from '../util.ts';

export { LAMP_DROP, LAMP_FORE, LANDING_LIGHT_HEIGHT, landingLampLevel } from '../util.ts';

/** Nothing farther from the lamp than this is lit by it, metres. */
const LAMP_RANGE = 1200;

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

/** The landing light of the pilot's own ship. */
export class LandingLight {
  readonly light = new SpotLight(0xfff3df, 0, LAMP_RANGE, LAMP_HALF_ANGLE, LAMP_PENUMBRA, 1);
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
    // The lamp hangs just under the hull, below the nose, so nothing of the ship is inside its
    // cone: a light without a shadow would shine on the inside of every wing and nacelle.
    const below = self.stats.belly + LAMP_DROP;
    const fore = LAMP_FORE * self.stats.radius;
    const px = self.rel[0] + fx * fore - ux * below, py = self.rel[1] + fy * fore - uy * below, pz = self.rel[2] + fz * fore - uz * below;
    const down = Math.cos(LAMP_FORWARD), ahead = Math.sin(LAMP_FORWARD);
    const light = this.light;
    light.position.set(px, py, pz);
    light.target.position.set(px + (fx * ahead - ux * down) * 100, py + (fy * ahead - uy * down) * 100, pz + (fz * ahead - uz * down) * 100);
    light.intensity = landingLampIntensity(ship.height, this.level, sunlight);
  }
}
