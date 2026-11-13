import { bodySurface, generateSector, isLandable, groundAltitude, v3, type Vec3 } from '@primacy2/shared';
const sys = generateSector({ serverId: 'aaaaaaaaaaaaaaaa', seed: 'primacy', center: [10, -2, 33], radius: 18, count: 24 })[0]!;
const body = sys.bodies.find((b) => isLandable(b) && b.cls === 'rocky')!;
const surface = bodySurface(sys, body.id)!;
let samples = 0;
const p: Vec3 = [0, 0, 0];
const hAt = (o: Vec3, d: Vec3, t: number): number => { samples++; p[0] = o[0] + d[0] * t; p[1] = o[1] + d[1] * t; p[2] = o[2] + d[2] * t; return groundAltitude(surface, p); };
function march(o: Vec3, d: Vec3, max: number, steps: number, minStep: number, frac: number, grow: number): number {
  let t = 0, above = 0;
  for (let i = 0; i < steps; i++) {
    const h = hAt(o, d, t);
    if (h <= 0) {
      if (i === 0) return 0;
      let lo = above, hi = t;
      for (let k = 0; k < 6; k++) { const mid = 0.5 * (lo + hi); if (hAt(o, d, mid) > 0) lo = mid; else hi = mid; }
      return hi;
    }
    if (t >= max) return -1;
    above = t;
    const step = Math.max(h * frac, minStep, grow * t);
    t = Math.min(max, t + Math.min(step, 250));
  }
  return -1;
}
const variants: [string, number, number, number, number][] = [
  ['current: 48 steps, h/2, min 4', 48, 4, 0.5, 0],
  ['160 steps, h/2, min 16', 160, 16, 0.5, 0],
  ['160 steps, h/2, min 24', 160, 24, 0.5, 0],
  ['160 steps, h/2, min 32', 160, 32, 0.5, 0],
  ['160 steps, h, min 24', 160, 24, 1, 0],
  ['128 steps, h/2, min 24', 128, 24, 0.5, 0],
  ['256 steps, h/2, min 12', 256, 12, 0.5, 0],
];
const rays: { o: Vec3; d: Vec3; ref: number; h: number }[] = [];
for (const h of [8, 15, 40, 100, 300]) {
  for (let i = 0; i < 400; i++) {
    const a = i * 0.913, b = i * 1.7;
    const up = v3.normalize([Math.cos(b) * Math.cos(a) + 0.3, Math.sin(a), Math.cos(b) * Math.sin(a) - 0.2]);
    const pos = v3.scale(up, body.radius + 4000 + (i % 60) * 7000);
    const alt = groundAltitude(surface, pos);
    const o = v3.scale(up, v3.len(pos) - alt + h);
    const east = v3.normalize(v3.cross(up, [0, 0, 1]));
    const pitch = ((i % 9) - 4) * 0.5 * Math.PI / 180;
    const d = v3.normalize(v3.add(v3.scale(east, Math.cos(pitch)), v3.scale(up, Math.sin(pitch))));
    let ref = -1;
    for (let t = 0; t <= 3000; t += 0.5) { if (hAt(o, d, t) <= 0) { ref = t; break; } }
    rays.push({ o, d, ref, h });
  }
}
const hits = rays.filter((r) => r.ref >= 0);
console.log(`${rays.length} rays, ${hits.length} meet the ground within 3 km`);
for (const [label, steps, minStep, frac, grow] of variants) {
  let missed = 0, off = 0; samples = 0;
  for (const r of rays) {
    const got = march(r.o, r.d, 3000, steps, minStep, frac, grow);
    if (r.ref >= 0) { if (got < 0) missed++; else if (Math.abs(got - r.ref) > 10) off++; }
  }
  const per = samples / rays.length;
  console.log(`${label}: missed ${missed} of ${hits.length} (${((100 * missed) / hits.length).toFixed(1)} %), off by more than 10 m ${off}, ${per.toFixed(0)} samples per ray`);
}
