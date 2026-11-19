/**
 * Missiles that went off in this frame. The server sends no event of its own for that, only a
 * plain hit: the missile part notices that a missile is gone beside something it can have gone
 * off at, and the blasts part, which has the splinters and the light of a blast, draws it. The
 * effects part makes the two side by side and neither knows the other; this list is what passes
 * between them, filled and emptied within one frame.
 */
const MAX = 8;

export const detonations = {
  count: 0,
  /** Six numbers each: where the missile was, relative to the zone anchor, and its velocity, zone axes. */
  data: new Float64Array(MAX * 6),

  push(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    if (this.count >= MAX) return;
    const o = this.count++ * 6, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
  },
};
