/**
 * Where the hull of a ship roughly is. The effects know a ship only as a sphere, and the server
 * reports a hit where the shot met that sphere, which for a flat ship is well off the plating. So
 * whatever has to sit on the hull (a scar, the root of a jet of gas) is put on a stand-in: an
 * ellipsoid in the ship's own axes, flatter and narrower than any hull, so that the place is in
 * the plating rather than beside it. What is drawn there is pulled toward the camera by the
 * shader that draws it and faded by the way the place faces.
 */
import type { Vec3 } from '@primacy2/shared';
import { TAU, hash01 } from '../util.ts';
import type { Track } from './core.ts';

/** Half width, half height and half length of the stand-in, in ship radii (the nose is along -z). */
const A = 0.4, B = 0.12, C = 0.76;

/** Brings a vector in zone axes into the ship's own axes; the inverse of `rotate` in `core.ts`. */
export function toLocal(t: Track, vx: number, vy: number, vz: number, out: Vec3): void {
  const qx = -t.qx, qy = -t.qy, qz = -t.qz, qw = t.qw;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}

/**
 * Where a shot that passes through the point p along the direction d meets the hull of a ship of
 * `radius`; all in the ship's axes, metres from its centre. Writes the place into `P` and the way
 * the plating faces there into `N`. A shot that would pass the stand-in lands where it comes
 * nearest: the server has counted it as a hit.
 */
export function strike(radius: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number, P: Vec3, N: Vec3): void {
  const a = A * radius, b = B * radius, c = C * radius;
  // In the space in which the stand-in is the unit sphere.
  const ox = px / a, oy = py / b, oz = pz / c;
  const ex = dx / a, ey = dy / b, ez = dz / c;
  const aa = ex * ex + ey * ey + ez * ez;
  let qx = ox, qy = oy, qz = oz;
  if (aa > 1e-12) {
    const bb = ox * ex + oy * ey + oz * ez;
    const disc = bb * bb - aa * (ox * ox + oy * oy + oz * oz - 1);
    const s = disc >= 0 ? (-bb - Math.sqrt(disc)) / aa : -bb / aa;
    qx += ex * s; qy += ey * s; qz += ez * s;
  }
  place(a, b, c, qx, qy, qz, P, N);
}

/**
 * One of the places at which a damaged ship leaks: always the same for the same ship and the same
 * `k`, so that nothing has to be remembered about it.
 */
export function wound(id: number, k: number, radius: number, P: Vec3, N: Vec3): void {
  const az = hash01(id * 7 + k * 131 + 3) * TAU;
  // Off the flat sides rather than off the nose or the tail, and above as often as below.
  const y = (0.25 + 0.6 * hash01(id * 13 + k * 57 + 11)) * (hash01(id * 5 + k * 17 + 2) < 0.5 ? -1 : 1);
  const s = Math.sqrt(1 - y * y);
  place(A * radius, B * radius, C * radius, Math.cos(az) * s, y, Math.sin(az) * s * 0.7, P, N);
}

/** The point of the stand-in in the direction q (in the space where it is the unit sphere), and its normal. */
function place(a: number, b: number, c: number, qx: number, qy: number, qz: number, P: Vec3, N: Vec3): void {
  const l = Math.hypot(qx, qy, qz);
  if (l < 1e-6) { qx = 0; qy = 1; qz = 0; } else { qx /= l; qy /= l; qz /= l; }
  P[0] = qx * a; P[1] = qy * b; P[2] = qz * c;
  const nx = qx / a, ny = qy / b, nz = qz / c;
  const n = Math.hypot(nx, ny, nz);
  N[0] = nx / n; N[1] = ny / n; N[2] = nz / n;
}
