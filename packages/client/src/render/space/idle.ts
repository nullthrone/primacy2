import type { BodyDef, SystemDef, Vec3 } from '@primacy2/shared';
import type { BodyView, FrameFx, GraphicsSettings } from '../../contracts.ts';
import type { SpaceFrame } from './types.ts';

const star: BodyDef = {
  id: 0, name: 'Idle Star', kind: 'star', cls: 'K', mass: 1.6e30, radius: 5.6e8, orbit: null,
  rotPeriod: 2.2e6, tilt: 0.1, seed: 4211, color: 0xffd2a1, temp: 4900, lum: 1.5e26,
};
const giant: BodyDef = {
  id: 1, name: 'Idle Giant', kind: 'planet', cls: 'gas', mass: 5.7e26, radius: 5.8e7, orbit: null,
  rotPeriod: 38000, tilt: 0.42, seed: 9127, color: 0xc9a878, temp: 130,
  atmo: { height: 4.0e5, color: 0xd8c8a8, density: 0.6 },
  rings: { inner: 7.4e7, outer: 1.38e8, color: 0xcdbfa6, seed: 77 },
};
const moon: BodyDef = {
  id: 2, name: 'Idle Moon', kind: 'moon', cls: 'ice', mass: 4.8e22, radius: 1.5e6, orbit: null,
  rotPeriod: 3.0e5, tilt: 0.02, seed: 318, color: 0xcfe0ee, temp: 90,
};

const system: SystemDef = {
  id: 'idle', name: 'Idle', pos: [0, 0, 0], starClass: 'K', security: 'secure', stations: 0, tags: [],
  seed: 1, bodies: [star, giant, moon], belts: [], sites: [],
};

const placed: [BodyDef, Vec3][] = [
  [star, [-1.05e11, 0.42e11, -1.55e11]],
  [giant, [1.9e8, -0.75e8, -3.9e8]],
  [moon, [-1.25e8, 0.2e8, -3.1e8]],
];
const bodies: BodyView[] = placed.map(([def, rel]) => ({ def, rel, dist: Math.hypot(rel[0], rel[1], rel[2]) }));

const fx: FrameFx = { cruise: 0, charge: 0, chargeKind: 0, fold: 0, dilation: 1, heat: 0, boosting: false, hitFlash: 0 };

/** The frame shown while there is no game to render: a ringed giant and its star, with a slowly swaying camera. */
export function idleFrame(clock: number, graphics: GraphicsSettings): SpaceFrame {
  const yaw = Math.sin(clock * 0.021) * 0.05, pitch = Math.sin(clock * 0.013 + 1) * 0.025;
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2);
  return {
    time: clock * 40,
    dt: 1 / 60,
    clock,
    system,
    // Yaw about +Y, then pitch about the camera's X axis.
    camera: { rot: [cy * sp, sy * cp, -sy * sp, cy * cp], fov: 50, mode: 'cockpit', abs: [0, 0, 0] },
    bodies,
    fx,
    galaxy: null,
    graphics,
  };
}
