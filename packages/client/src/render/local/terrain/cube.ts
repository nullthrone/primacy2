/**
 * The cube sphere the ground is laid out on. Each of the six faces of a cube around the body is a
 * square with coordinates u, v in -1..1; a quadtree splits it into tiles. A point of a face is
 * projected onto the sphere through the angle, not the tangent (`a = tan(u * pi / 4)`), so tiles
 * of one level are nearly the same size everywhere instead of three times smaller at the corners.
 *
 * The faces and their axes follow the layout of a GPU cube map (+X, -X, +Y, -Y, +Z, -Z, with s
 * along `U` and t along `V`), so the map baked for the far view is an ordinary cube texture: a
 * shader looks a direction up after bending it the same way (`cubeWarp` in `shade.ts`).
 *
 * Everything here is used by the worker and by the main thread and must give both the same
 * numbers. None of it is part of the shared terrain: it only decides where that is sampled.
 */

export const FACES = 6;

/** Per face: the outward axis N and the axes U and V of its square, as rows of three. */
const N = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
const U = [0, 0, -1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0];
const V = [0, -1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, -1, 0, 0, -1, 0];

const QUARTER_PI = Math.PI / 4;

/** The tangent a face coordinate stands for: what `facePoint` takes. */
export const faceTangent = (u: number): number => Math.tan(u * QUARTER_PI);

/** Unit direction (body-fixed axes) of the point u, v of a face; written to `out` at `at`. */
export function faceDirection(face: number, u: number, v: number, out: { [i: number]: number }, at = 0): void {
  facePoint(face, Math.tan(u * QUARTER_PI), Math.tan(v * QUARTER_PI), out, at);
}

/** `faceDirection` for coordinates that are tangents already (`faceTangent`), for loops over a grid. */
export function facePoint(face: number, a: number, b: number, out: { [i: number]: number }, at = 0): void {
  const f = face * 3;
  const x = N[f]! + a * U[f]! + b * V[f]!;
  const y = N[f + 1]! + a * U[f + 1]! + b * V[f + 1]!;
  const z = N[f + 2]! + a * U[f + 2]! + b * V[f + 2]!;
  const l = 1 / Math.sqrt(x * x + y * y + z * z);
  out[at] = x * l;
  out[at + 1] = y * l;
  out[at + 2] = z * l;
}

/** The face a direction falls on and its coordinates there: writes face, u, v to `out`. */
export function directionToFace(x: number, y: number, z: number, out: { [i: number]: number }): void {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  if (ax >= ay && ax >= az) face = x >= 0 ? 0 : 1;
  else if (ay >= az) face = y >= 0 ? 2 : 3;
  else face = z >= 0 ? 4 : 5;
  const f = face * 3;
  const n = x * N[f]! + y * N[f + 1]! + z * N[f + 2]!;
  const a = (x * U[f]! + y * U[f + 1]! + z * U[f + 2]!) / n;
  const b = (x * V[f]! + y * V[f + 1]! + z * V[f + 2]!) / n;
  out[0] = face;
  out[1] = Math.atan(a) / QUARTER_PI;
  out[2] = Math.atan(b) / QUARTER_PI;
}

/** Edge length of a tile of `level` in face coordinates: the whole face is 2 wide. */
export const tileSpan = (level: number): number => 2 / 2 ** level;

/** Length in metres along the ground of the edge of a tile of `level` on a body of `radius`. */
export const tileSize = (radius: number, level: number): number => (radius * Math.PI * 0.5) / 2 ** level;

/**
 * The frame a tile's vertices are stored in, so that they are small numbers: the origin is the
 * point of the mean sphere under the tile centre, +Y is straight up there, +X runs along the
 * tile's u direction. Writes the origin (3, body-fixed axes, metres) and the axes X, Y, Z (3 each,
 * body-fixed, unit) to `out`: twelve numbers.
 */
export function tileFrame(face: number, level: number, ix: number, iy: number, radius: number, out: { [i: number]: number }): void {
  const span = tileSpan(level);
  const u = -1 + (ix + 0.5) * span;
  const v = -1 + (iy + 0.5) * span;
  faceDirection(face, u, v, out, 6);
  const yx = out[6]!;
  const yy = out[7]!;
  const yz = out[8]!;
  out[0] = yx * radius;
  out[1] = yy * radius;
  out[2] = yz * radius;
  // X: the face's U axis with its vertical part removed.
  const f = face * 3;
  const d = U[f]! * yx + U[f + 1]! * yy + U[f + 2]! * yz;
  let xx = U[f]! - d * yx;
  let xy = U[f + 1]! - d * yy;
  let xz = U[f + 2]! - d * yz;
  const l = 1 / Math.sqrt(xx * xx + xy * xy + xz * xz);
  xx *= l;
  xy *= l;
  xz *= l;
  out[3] = xx;
  out[4] = xy;
  out[5] = xz;
  // Z = X x Y completes a right-handed frame.
  out[9] = xy * yz - xz * yy;
  out[10] = xz * yx - xx * yz;
  out[11] = xx * yy - xy * yx;
}

/**
 * The rotation that takes a vector given in the axes of the tile frame `from` into the axes of the
 * tile frame `to` (both as `tileFrame` writes them): nine numbers row by row, entry `i, j` being
 * axis `j` of `from` along axis `i` of `to`. A tile uses it to read its parent's normal map, whose
 * normals are in the parent's frame.
 */
export function frameTurn(from: ArrayLike<number>, to: ArrayLike<number>, out: { [i: number]: number }): void {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const a = 3 + i * 3;
      const b = 3 + j * 3;
      out[i * 3 + j] = to[a]! * from[b]! + to[a + 1]! * from[b + 1]! + to[a + 2]! * from[b + 2]!;
    }
  }
}

/** The deepest quadtree level of a body: the one whose mesh cells are between `finest` and twice that, metres. */
export function deepestLevel(radius: number, cells: number, finest: number): number {
  return Math.max(0, Math.floor(Math.log2((radius * Math.PI * 0.5) / (cells * finest))));
}
