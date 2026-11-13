// Looks for a generated station whose orbit comes inside the surface-frame shell of its landable planet.
import { bodySurface, generateSector, isLandable } from '@primacy2/shared';
let systems = 0, pairs = 0, worst = Infinity, where = '', minRot = Infinity, minRotWhere = '';
for (let k = 0; k < 800; k++) {
  for (const sys of generateSector({ serverId: `search${k}abcdefghijk`, seed: `s-${k}`, center: [k, 1, 2], radius: 18, count: 48 })) {
    systems++;
    for (const body of sys.bodies) {
      if (!isLandable(body)) continue;
      if (Math.abs(body.rotPeriod) < minRot) { minRot = Math.abs(body.rotPeriod); minRotWhere = sys.id; }
      const surface = bodySurface(sys, body.id)!;
      for (const site of sys.sites) {
        if (site.ground || site.orbit.parent !== body.id) continue;
        pairs++;
        const margin = site.orbit.a * (1 - site.orbit.e) - surface.exit;
        if (margin < worst) { worst = margin; where = `${sys.id} site ${site.id} ${site.kind} around body ${body.id} (${body.kind} radius ${(body.radius / 1000).toFixed(0)} km)`; }
      }
    }
  }
}
console.log(`${systems} systems, ${pairs} orbital sites around landable bodies; smallest periapsis margin over the end of the surface frame ${(worst / 1000).toFixed(1)} km: ${where}`);
console.log(`shortest day of a landable body (moons turn once per orbit): ${(minRot / 3600).toFixed(2)} h (${minRotWhere})`);
