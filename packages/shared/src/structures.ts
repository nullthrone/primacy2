/**
 * Shapes of the built structures at sites. The server collides ships against these and the
 * models in `assets/blender` are built to the same dimensions, so what a pilot sees is what
 * the ship hits. Structures sit at the origin of their site anchor with their axis along +Y;
 * every shape here is rotationally symmetric about that axis, so a spinning ring needs no
 * special handling.
 *
 * A ground base stands at the centre of its pad with +Y up along the pad normal (the site's own
 * axes, see `groundSitePose`), y = 0 at the ground. Ships near it fly in the surface frame of the
 * body, so its colliders have to be moved into that frame before they are tested.
 */
import type { Vec3 } from './math.ts';

export type Collider =
  /** Solid ball of radius `r` centred at height `y` on the axis. */
  | { kind: 'sphere'; y: number; r: number }
  /** Ring around the axis at height `y`: centre-line radius `major`, tube radius `minor`. */
  | { kind: 'torus'; y: number; major: number; minor: number }
  /** Solid cylinder around the axis from `y0` to `y1` with radius `r`. */
  | { kind: 'cylinder'; y0: number; y1: number; r: number };

export interface StructureDef {
  /** Model key; the client loads `models/<model>.glb`. */
  model: string;
  /** Radius of the bounding sphere, metres. */
  bound: number;
  colliders: Collider[];
  /** Spin about +Y in radians per second (visual only). */
  spin: number;
}

export const STRUCTURES: Record<string, StructureDef> = {
  /** Large wheel station: a habitat ring joined to a central hub by four spokes. */
  station_ring: {
    model: 'station_ring',
    bound: 800,
    spin: 0.035,
    colliders: [
      { kind: 'torus', y: 0, major: 700, minor: 75 },
      { kind: 'cylinder', y0: -260, y1: 260, r: 150 },
    ],
  },
  /** Small modular platform. */
  station_outpost: {
    model: 'station_outpost',
    bound: 240,
    spin: 0,
    colliders: [{ kind: 'cylinder', y0: -90, y1: 90, r: 110 }],
  },
  /** Warp gate: a ring ships fly through along the axis. */
  gate: {
    model: 'gate',
    bound: 520,
    spin: 0,
    colliders: [{ kind: 'torus', y: 0, major: 450, minor: 45 }],
  },
  /** Navigation beacon. */
  beacon: {
    model: 'beacon',
    bound: 20,
    spin: 0.2,
    colliders: [{ kind: 'sphere', y: 0, r: 12 }],
  },
  /**
   * Ground base: a low central block with a control tower, in the middle of the flattened pad.
   * The model does not exist yet; these are the dimensions it is to be built to. The open pad
   * around the block is where ships set down.
   */
  base_ground: {
    model: 'base_ground',
    bound: 250,
    spin: 0,
    colliders: [
      { kind: 'cylinder', y0: 0, y1: 40, r: 90 },
      { kind: 'cylinder', y0: 40, y1: 110, r: 14 },
    ],
  },
};

export interface Contact {
  /** Unit vector pointing out of the structure at the contact. */
  normal: Vec3;
  /** How far the ship's sphere is inside the surface, metres (> 0). */
  depth: number;
}

/**
 * Tests a sphere (a ship) at `pos` (relative to the structure origin) against a structure.
 * Returns the deepest contact, or null when the sphere is clear of every collider.
 */
export function collideStructure(def: StructureDef, pos: Readonly<Vec3>, radius: number): Contact | null {
  const [x, y, z] = pos;
  const rho = Math.hypot(x, z);
  // Unit radial direction in the XZ plane; arbitrary on the axis itself.
  const rx = rho > 1e-9 ? x / rho : 1;
  const rz = rho > 1e-9 ? z / rho : 0;
  let best: Contact | null = null;
  const consider = (depth: number, nx: number, ny: number, nz: number): void => {
    if (depth > 0 && (!best || depth > best.depth)) best = { normal: [nx, ny, nz], depth };
  };

  for (const c of def.colliders) {
    if (c.kind === 'sphere') {
      const dy = y - c.y;
      const d = Math.hypot(rho, dy);
      const depth = c.r + radius - d;
      if (depth > 0) {
        if (d > 1e-9) consider(depth, (rx * rho) / d, dy / d, (rz * rho) / d);
        else consider(depth, 0, 1, 0);
      }
    } else if (c.kind === 'torus') {
      // Distance to the centre line of the tube, measured in the (rho, y) half-plane.
      const a = rho - c.major;
      const dy = y - c.y;
      const d = Math.hypot(a, dy);
      const depth = c.minor + radius - d;
      if (depth > 0) {
        if (d > 1e-9) consider(depth, (rx * a) / d, dy / d, (rz * a) / d);
        else consider(depth, 0, 1, 0);
      }
    } else {
      // Cylinder: push out through the nearer of the curved side and the end caps.
      const side = c.r + radius - rho;
      const top = c.y1 + radius - y;
      const bottom = y - (c.y0 - radius);
      if (side > 0 && top > 0 && bottom > 0) {
        if (side <= top && side <= bottom) consider(side, rx, 0, rz);
        else if (top <= bottom) consider(top, 0, 1, 0);
        else consider(bottom, 0, -1, 0);
      }
    }
  }
  return best;
}
