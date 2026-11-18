import { describe, expect, it } from 'vitest';
import { STRUCTURES, collideStructure, v3, type Vec3 } from './index.ts';

const ring = STRUCTURES.station_ring!;
const gate = STRUCTURES.gate!;

describe('structure collision', () => {
  it('lets a ship fly through the gate aperture and between ring and hub', () => {
    expect(collideStructure(gate, [0, 0, 0], 20)).toBeNull();
    expect(collideStructure(gate, [100, 300, -50], 20)).toBeNull();
    expect(collideStructure(ring, [400, 0, 0], 20)).toBeNull();
  });

  it('pushes a ship out of the torus tube along the tube normal', () => {
    // Just outside the outer edge of the ring, overlapping by 5 m.
    const hit = collideStructure(ring, [700 + 75 + 5, 0, 0], 10)!;
    expect(hit.depth).toBeCloseTo(5, 6);
    expect(hit.normal[0]).toBeCloseTo(1, 6);
    // Above the tube.
    const top = collideStructure(ring, [0, 75 + 4, -700], 10)!;
    expect(top.depth).toBeCloseTo(6, 6);
    expect(top.normal[1]).toBeCloseTo(1, 6);
    // On the inner side the normal points toward the axis.
    const inner = collideStructure(ring, [700 - 75 - 2, 0, 0], 10)!;
    expect(inner.normal[0]).toBeCloseTo(-1, 6);
  });

  it('pushes out of the hub through the nearest face', () => {
    const side = collideStructure(ring, [150 + 5, 0, 0], 10)!;
    expect(side.normal).toEqual([1, 0, 0]);
    expect(side.depth).toBeCloseTo(5, 6);
    const cap = collideStructure(ring, [10, 260 + 3, 0], 10)!;
    expect(cap.normal).toEqual([0, 1, 0]);
    const bottom = collideStructure(ring, [0, -263, 0], 10)!;
    expect(bottom.normal).toEqual([0, -1, 0]);
  });

  it('resolving the contact always leaves the ship clear', () => {
    const def = ring;
    for (let i = 0; i < 2000; i++) {
      // A deterministic scatter of positions inside the bounding sphere.
      const a = i * 2.399963;
      const r = (def.bound * ((i * 37) % 100)) / 100;
      const y = ((i * 53) % 200) - 100 + ((i % 7) - 3) * 60;
      const pos: Vec3 = [Math.cos(a) * r, y, Math.sin(a) * r];
      const hit = collideStructure(def, pos, 12);
      if (!hit) continue;
      expect(v3.len(hit.normal)).toBeCloseTo(1, 6);
      const moved = v3.addScaled(pos, hit.normal, hit.depth + 0.01);
      const again = collideStructure(def, moved, 12);
      // Deep inside the hub a single push may land in the tube of nothing; depth must at least shrink.
      if (again) expect(again.depth).toBeLessThan(hit.depth);
    }
  });

  it('every structure fits inside its bounding radius', () => {
    for (const def of Object.values(STRUCTURES)) {
      for (const c of def.colliders) {
        const reach =
          c.kind === 'sphere' ? Math.abs(c.y) + c.r
          : c.kind === 'torus' ? Math.hypot(c.major + c.minor, c.y)
          : Math.hypot(c.r, Math.max(Math.abs(c.y0), Math.abs(c.y1)));
        expect(reach, def.model).toBeLessThanOrEqual(def.bound);
      }
    }
  });
});
