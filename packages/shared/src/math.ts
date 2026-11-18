/**
 * Minimal float64 vector and quaternion maths.
 *
 * Vectors and quaternions are plain tuples so they serialise as JSON arrays.
 * Functions return new tuples unless the name ends in `To`/`In` (which mutate the first argument).
 */
export type Vec3 = [number, number, number];
/** `[x, y, z, w]`; rotates local vectors into the parent frame. */
export type Quat = [number, number, number, number];

export const v3 = {
  zero: (): Vec3 => [0, 0, 0],
  of: (x: number, y: number, z: number): Vec3 => [x, y, z],
  clone: (a: Readonly<Vec3>): Vec3 => [a[0], a[1], a[2]],
  set(out: Vec3, x: number, y: number, z: number): Vec3 {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
  },
  copy(out: Vec3, a: Readonly<Vec3>): Vec3 {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
  },
  add: (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  neg: (a: Readonly<Vec3>): Vec3 => [-a[0], -a[1], -a[2]],
  /** a + b * s */
  addScaled: (a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 => [
    a[0] + b[0] * s,
    a[1] + b[1] * s,
    a[2] + b[2] * s,
  ],
  /** a += b * s (mutates a) */
  addScaledIn(a: Vec3, b: Readonly<Vec3>, s: number): Vec3 {
    a[0] += b[0] * s;
    a[1] += b[1] * s;
    a[2] += b[2] * s;
    return a;
  },
  mul: (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]],
  dot: (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  lenSq: (a: Readonly<Vec3>): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  len: (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  distSq(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
    const x = a[0] - b[0];
    const y = a[1] - b[1];
    const z = a[2] - b[2];
    return x * x + y * y + z * z;
  },
  /** Unit vector, or `[0, 0, 0]` for a zero-length input. */
  normalize(a: Readonly<Vec3>): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  lerp: (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  isFinite: (a: Readonly<Vec3>): boolean =>
    Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]),
};

export const quat = {
  identity: (): Quat => [0, 0, 0, 1],
  clone: (a: Readonly<Quat>): Quat => [a[0], a[1], a[2], a[3]],
  /** Hamilton product a * b: apply b first, then a. */
  mul(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  conj: (a: Readonly<Quat>): Quat => [-a[0], -a[1], -a[2], a[3]],
  normalize(a: Readonly<Quat>): Quat {
    const l = Math.hypot(a[0], a[1], a[2], a[3]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l, a[3] / l] : [0, 0, 0, 1];
  },
  /** Rotate vector v by quaternion a (local -> parent). */
  rotate(a: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
    const [x, y, z, w] = a;
    const [vx, vy, vz] = v;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  },
  /** Rotate vector v by the inverse of a (parent -> local). */
  unrotate(a: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
    return quat.rotate([-a[0], -a[1], -a[2], a[3]], v);
  },
  fromAxisAngle(axis: Readonly<Vec3>, angle: number): Quat {
    const h = angle / 2;
    const s = Math.sin(h);
    const n = v3.normalize(axis);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
  },
  /**
   * Integrate a local-frame angular velocity (rad/s) over dt.
   * Returns normalize(a * exp(w * dt / 2)).
   */
  integrate(a: Readonly<Quat>, wLocal: Readonly<Vec3>, dt: number): Quat {
    const angle = Math.hypot(wLocal[0], wLocal[1], wLocal[2]) * dt;
    if (angle < 1e-12) return quat.clone(a);
    const d = quat.fromAxisAngle(wLocal, angle);
    return quat.normalize(quat.mul(a, d));
  },
  /** Orientation whose -Z axis points along `forward` and whose +Y is as close to `up` as possible. */
  lookRotation(forward: Readonly<Vec3>, up: Readonly<Vec3> = [0, 1, 0]): Quat {
    const f = v3.normalize(forward);
    if (v3.lenSq(f) === 0) return [0, 0, 0, 1];
    const z = v3.neg(f); // local +Z
    let x = v3.cross(up, z);
    if (v3.lenSq(x) < 1e-12) x = v3.cross(Math.abs(z[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0], z);
    x = v3.normalize(x);
    const y = v3.cross(z, x);
    // rotation matrix columns x, y, z -> quaternion
    const m00 = x[0], m01 = y[0], m02 = z[0];
    const m10 = x[1], m11 = y[1], m12 = z[1];
    const m20 = x[2], m21 = y[2], m22 = z[2];
    const tr = m00 + m11 + m22;
    let q: Quat;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
    }
    return quat.normalize(q);
  },
  slerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    if (cos < 0) {
      cos = -cos;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    if (cos > 0.9995) {
      return quat.normalize([
        a[0] + (bx - a[0]) * t,
        a[1] + (by - a[1]) * t,
        a[2] + (bz - a[2]) * t,
        a[3] + (bw - a[3]) * t,
      ]);
    }
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
  },
  isFinite: (a: Readonly<Quat>): boolean =>
    Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]) && Number.isFinite(a[3]),
};

/** Ship-local forward axis (-Z) in frame axes. */
export const forwardOf = (rot: Readonly<Quat>): Vec3 => quat.rotate(rot, [0, 0, -1]);
export const upOf = (rot: Readonly<Quat>): Vec3 => quat.rotate(rot, [0, 1, 0]);
export const rightOf = (rot: Readonly<Quat>): Vec3 => quat.rotate(rot, [1, 0, 0]);

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Move `current` toward `target` by at most `maxDelta`. */
export const approach = (current: number, target: number, maxDelta: number): number =>
  Math.abs(target - current) <= maxDelta ? target : current + Math.sign(target - current) * maxDelta;
