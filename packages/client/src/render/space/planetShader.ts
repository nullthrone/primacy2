/** Shaders for planets and moons, their atmospheres and rings. All work in camera-relative system axes. */
import { GLSL_NOISE } from './glsl.ts';

/** Passes the world position; the camera is at the origin, so it is also the view ray. */
export const WORLD_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * Exact ray-sphere intersection for a ray from the origin. The mesh only provides coverage; the
 * silhouette, its anti-aliasing and the normal come from here, so no depth buffer is needed.
 */
export const SPHERE_GLSL = /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
uniform float uPix;
// Returns the pixel coverage 0..1 and the unit normal at the visible surface point.
float sphereHit(vec3 d, out vec3 n) {
  float b = dot(d, uCenter);
  if (b <= 0.0) return 0.0;
  vec3 perp = uCenter - d * b;
  float h = length(perp);
  float cov = clamp((uRadius - h) / (uPix * b) + 0.5, 0.0, 1.0);
  float hc = min(h, uRadius * 0.9995);
  float th = sqrt(uRadius * uRadius - hc * hc);
  n = normalize(-perp * (hc / max(h, 1e-9)) - d * th);
  return cov;
}
`;

/** Radial structure of a ring system; `r` is in planet radii. Shared by the ring and its shadow on the planet. */
export const RING_GLSL = /* glsl */ `
uniform vec4 uRing;   // x inner, y outer (planet radii), z seed, w opacity (0 = no rings)
uniform vec3 uRingN;
float n1(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
}
float ringDensity(float r, float blur) {
  if (r <= uRing.x || r >= uRing.y) return 0.0;
  float x = (r - uRing.x) / (uRing.y - uRing.x);
  float s = uRing.z;
  float broad = 0.12 + 0.88 * smoothstep(0.2, 0.8, n1(x * 4.0 + s) * 0.65 + n1(x * 9.0 + s * 1.3) * 0.35);
  float mid = 0.45 + 0.55 * n1(x * 23.0 + s * 2.0);
  // Fine ringlets fade out when they get thinner than a pixel.
  float fine = mix(0.60 + 0.40 * n1(x * 95.0 + s * 3.0), 0.8, clamp(blur * 95.0, 0.0, 1.0));
  float hair = mix(0.75 + 0.25 * n1(x * 380.0 + s * 5.0), 0.875, clamp(blur * 380.0, 0.0, 1.0));
  float d = broad * mid * fine * hair * 1.9;
  float g1 = 0.50 + 0.25 * hash11(s + 1.0);
  float g2 = 0.15 + 0.20 * hash11(s + 2.0);
  d *= smoothstep(0.012, 0.022, abs(x - g1)) * (0.25 + 0.75 * smoothstep(0.004, 0.010, abs(x - g2)));
  d *= mix(0.35, 1.0, smoothstep(0.0, 0.28, x));
  d *= smoothstep(0.0, 0.02, x) * (1.0 - smoothstep(0.96, 1.0, x));
  return clamp(d, 0.0, 1.0);
}
`;

const PLANET_HEAD = /* glsl */ `
uniform float uFade;
uniform mat3 uRot;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uBase;
uniform float uSeed;
uniform int uOct;
uniform float uTime;
uniform float uCloudPhase;
uniform vec3 uAtmoColor;
uniform float uAtmo;
uniform vec4 uPar;
varying vec3 vWorld;
${GLSL_NOISE}
${SPHERE_GLSL}
${RING_GLSL}

struct Surf {
  vec3 albedo;
  vec3 emission;
  float height;
  float bump;
  float spec;
  float gloss;
  float cloud;
  float cloudShadow;
  float night;
  float limb;
};
// Low-frequency warp of the current pixel, shared between the surface and its height field.
vec3 gWarp;
Surf blank() { return Surf(vec3(0.5), vec3(0.0), 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0); }
vec3 seedOff() { return vec3(uSeed * 1.37, uSeed * 0.71 + 3.0, uSeed * 2.11 + 7.0); }
vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
// One impact crater per grid cell: a bowl with a raised rim. Returns a height offset.
float craters(vec3 p, float scale, float seed) {
  vec3 q = p * scale;
  vec3 cell = floor(q);
  vec3 h = hash33(cell + seed);
  if (h.x > 0.6) return 0.0;
  vec3 c = cell + 0.3 + 0.4 * hash33(cell * 1.7 + seed + 3.3);
  float rad = 0.10 + 0.18 * h.y * h.y;
  float x = length(q - c) / rad;
  if (x > 1.6) return 0.0;
  float bowl = (smoothstep(0.0, 1.0, x) - 1.0) * 0.7;
  float rim = exp(-(x - 1.0) * (x - 1.0) * 14.0) * 0.45;
  return (bowl + rim) * rad / scale * 6.0;
}
float ringShadow(vec3 n) {
  if (uRing.w <= 0.0) return 1.0;
  float dn = dot(uSunDir, uRingN);
  if (abs(dn) < 1e-4) return 1.0;
  float tt = -dot(n, uRingN) / dn;
  if (tt <= 0.0) return 1.0;
  return 1.0 - 0.85 * uRing.w * ringDensity(length(n + uSunDir * tt), 0.004);
}
`;

const SURFACES = /* glsl */ `
#if TYPE == 0
// Rocky: cratered regolith with darker plains.
float craterField(vec3 nb) {
  float cr = craters(nb, 4.0, uSeed);
  if (uOct >= 5) cr += craters(nb, 9.0, uSeed + 5.0);
  if (uOct >= 6) cr += craters(nb, 21.0, uSeed + 9.0);
  if (uOct >= 7) cr += craters(nb, 47.0, uSeed + 13.0);
  return cr;
}
float hfield(vec3 nb) {
  return fbm((nb * 2.0 + seedOff()) * 1.6 + gWarp.x * 0.7, uOct) * 0.40 + craterField(nb) * 1.5;
}
Surf surface(vec3 nb, vec3 sunB) {
  Surf s = blank();
  vec3 p = nb * 2.0 + seedOff();
  int lo = min(uOct, 4);
  float w = fbm(p * 0.8, lo);
  gWarp = vec3(w);
  float h = fbm(p * 1.6 + w * 0.7, uOct);
  float mare = smoothstep(0.02, -0.22, fbm(p * 0.7 + 11.0, lo));
  float cr = craterField(nb);
  s.height = h * 0.40 + cr * 1.5;
  float tone = clamp(0.55 + h * 0.9 + cr * 3.0, 0.0, 1.0);
  s.albedo = mix(uBase * 0.42, uBase * 1.25, tone) * mix(1.0, 0.55, mare);
  s.albedo *= 0.9 + 0.25 * fbm(p * 9.0, lo);
  s.bump = 1.3;
  return s;
}
#elif TYPE == 1
// Desert: dune fields, dark rock outcrops and canyons.
float hfield(vec3 nb) {
  vec3 p = nb * 1.8 + seedOff();
  float w = gWarp.x;
  float h = fbm(p * 2.1 + w * 1.3, uOct);
  float dunes = ridged(vec3(p.x * 3.0, p.y * 8.0, p.z * 3.0) + w * 2.2, uOct);
  float canyon = smoothstep(0.80, 0.95, ridged(p * 1.05 + w * 0.7 + 5.0, uOct));
  return h * 0.4 + dunes * 0.10 - canyon * 0.35;
}
Surf surface(vec3 nb, vec3 sunB) {
  Surf s = blank();
  vec3 p = nb * 1.8 + seedOff();
  int lo = min(uOct, 4);
  float w = fbm(p, lo);
  gWarp = vec3(w);
  float h = fbm(p * 2.1 + w * 1.3, uOct);
  float dunes = ridged(vec3(p.x * 3.0, p.y * 8.0, p.z * 3.0) + w * 2.2, uOct);
  float rock = smoothstep(0.05, 0.38, fbm(p * 1.2 + 21.0, lo) + h * 0.3);
  float canyon = smoothstep(0.80, 0.95, ridged(p * 1.05 + w * 0.7 + 5.0, uOct));
  vec3 col = mix(uBase * 0.70, uBase * 1.28, clamp(0.5 + h * 0.9 + (dunes - 0.5) * 0.35, 0.0, 1.0));
  col = mix(col, uBase * vec3(0.42, 0.36, 0.36), rock * 0.75);
  col *= 1.0 - 0.55 * canyon;
  float cap = smoothstep(0.86, 0.92, abs(nb.y) + h * 0.07) * uPar.x;
  s.albedo = mix(col, vec3(0.88, 0.87, 0.84), cap);
  s.height = h * 0.4 + dunes * 0.10 - canyon * 0.35;
  s.bump = 1.0;
  return s;
}
#elif TYPE == 2
// Lava: dark crust split by glowing cracks, with molten seas.
float hfield(vec3 nb) {
  vec3 p = nb * 2.1 + seedOff();
  float w = gWarp.x;
  float plates = ridged(p * 1.25 + w * 0.9, uOct);
  float fine = smoothstep(0.68, 0.93, ridged(p * 4.3 + w * 1.3 + 3.0, uOct));
  return fbm(p * 6.0, uOct) * 0.25 + plates * 0.15 - (smoothstep(0.62, 0.90, plates) * 0.9 + fine * 0.45) * 0.4;
}
Surf surface(vec3 nb, vec3 sunB) {
  Surf s = blank();
  vec3 p = nb * 2.1 + seedOff();
  int lo = min(uOct, 4);
  float w = fbm(p * 0.9, lo);
  gWarp = vec3(w);
  float plates = ridged(p * 1.25 + w * 0.9, uOct);
  float crack = smoothstep(0.62, 0.90, plates);
  float fine = smoothstep(0.68, 0.93, ridged(p * 4.3 + w * 1.3 + 3.0, uOct));
  float seas = smoothstep(0.10, 0.30, fbm(p * 0.65 + 31.0, lo));
  float churn = clamp(0.5 + 0.9 * fbm(p * 4.0 + vec3(0.0, uTime * 0.03, 0.0) + w, lo), 0.0, 1.0);
  float heat = clamp(crack * 0.9 + fine * 0.45 + seas * (0.30 + 0.70 * churn), 0.0, 1.0);
  float crust = fbm(p * 6.0, uOct);
  s.albedo = mix(vec3(0.035, 0.032, 0.03), uBase * 0.55 + 0.02, clamp(0.5 + crust, 0.0, 1.0)) * (1.0 - 0.7 * heat);
  float flick = 0.88 + 0.12 * gnoise(p * 5.0 + vec3(uTime * 0.2));
  vec3 glow = mix(vec3(0.9, 0.06, 0.0), vec3(2.2, 0.55, 0.04), smoothstep(0.15, 0.6, heat));
  glow = mix(glow, vec3(5.0, 2.6, 0.7), smoothstep(0.6, 1.0, heat));
  s.emission = glow * heat * heat * flick * 1.4;
  s.height = crust * 0.25 + plates * 0.15 - (crack * 0.9 + fine * 0.45) * 0.4;
  s.bump = 1.2;
  return s;
}
#elif TYPE == 3
// Ice: bright plains crossed by stained fracture lines.
float hfield(vec3 nb) {
  vec3 p = nb * 1.9 + seedOff();
  float w = gWarp.x;
  float l1 = smoothstep(0.80, 0.96, ridged(p * 1.5 + w * 1.6, uOct));
  float l2 = smoothstep(0.84, 0.97, ridged(p.zxy * 2.9 + w * 0.9 + 7.0, uOct));
  float cr = uOct >= 5 ? craters(nb, 9.0, uSeed + 2.0) : 0.0;
  return fbm(p * 2.0 + w, uOct) * 0.12 - l1 * 0.12 - l2 * 0.07 + cr * 1.2;
}
Surf surface(vec3 nb, vec3 sunB) {
  Surf s = blank();
  vec3 p = nb * 1.9 + seedOff();
  int lo = min(uOct, 4);
  float w = fbm(p * 0.8, lo);
  gWarp = vec3(w);
  float h = fbm(p * 2.0 + w, uOct);
  float l1 = smoothstep(0.80, 0.96, ridged(p * 1.5 + w * 1.6, uOct));
  float l2 = smoothstep(0.84, 0.97, ridged(p.zxy * 2.9 + w * 0.9 + 7.0, uOct));
  float l3 = smoothstep(0.86, 0.97, ridged(p.yzx * 6.1 + 13.0, uOct));
  vec3 ice = mix(uBase * 0.80, vec3(0.94, 0.97, 1.0), clamp(0.5 + h * 1.3, 0.0, 1.0));
  ice = mix(ice, uBase * vec3(0.55, 0.72, 0.92), smoothstep(0.08, 0.38, fbm(p * 0.9 + 13.0, lo)) * 0.45);
  s.albedo = mix(ice, vec3(0.50, 0.33, 0.24), clamp(l1 * 0.7 + l2 * 0.45 + l3 * 0.25, 0.0, 0.85));
  float cr = uOct >= 5 ? craters(nb, 9.0, uSeed + 2.0) : 0.0;
  s.albedo *= 1.0 + cr * 2.0;
  s.height = h * 0.12 - l1 * 0.12 - l2 * 0.07 + cr * 1.2;
  s.bump = 0.9;
  s.spec = 0.22;
  s.gloss = 22.0;
  return s;
}
#elif TYPE == 4
// Terran and ocean worlds: continents, seas, ice caps, clouds and settlement lights.
float cloudAt(vec3 nb) {
  vec3 cp = rotY(nb, uCloudPhase) * 2.1 + seedOff() * 1.7;
  float cw = fbm(cp * 0.8 + 2.0, min(uOct, 4));
  float cl = fbm(cp * 1.3 + vec3(cw * 1.8, cw * 0.6, -cw * 1.4), uOct) + 0.22 * fbm(cp * 5.5 + cw, uOct);
  float lat = abs(nb.y);
  float zonal = 0.10 * cos(lat * 9.0) - 0.08 * smoothstep(0.15, 0.35, lat) * smoothstep(0.55, 0.35, lat);
  return smoothstep(uPar.y, uPar.y + 0.32, cl + zonal);
}
float hfield(vec3 nb) {
  vec3 p = nb * 1.45 + seedOff();
  float cont = fbm(p + gWarp * 0.8, uOct) + 0.30 * fbm(p * 3.3 + 4.0, uOct);
  float elev = max(cont - uPar.x, 0.0);
  float mount = ridged(p * 3.2 + gWarp * 1.5, uOct) * smoothstep(0.04, 0.28, elev);
  return smoothstep(uPar.x - 0.004, uPar.x + 0.012, cont) * (elev * 0.5 + mount * 0.35);
}
Surf surface(vec3 nb, vec3 sunB) {
  Surf s = blank();
  vec3 p = nb * 1.45 + seedOff();
  int lo = min(uOct, 4);
  vec3 warp = vec3(fbm(p + 1.7, lo), fbm(p + 5.2, lo), fbm(p + 9.1, lo));
  gWarp = warp;
  float cont = fbm(p + warp * 0.8, uOct) + 0.30 * fbm(p * 3.3 + 4.0, uOct);
  float sea = uPar.x;
  float land = smoothstep(sea - 0.004, sea + 0.012, cont);
  float elev = max(cont - sea, 0.0);
  float lat = abs(nb.y);
  float mount = ridged(p * 3.2 + warp * 1.5, uOct) * smoothstep(0.04, 0.28, elev);
  float temp = 1.0 - lat * 1.05 - elev * 0.5 - mount * 0.25 + fbm(p * 2.1 + 17.0, lo) * 0.14;
  float dry = smoothstep(0.12, 0.3, lat) * smoothstep(0.5, 0.3, lat);
  float moist = clamp(0.5 + fbm(p * 1.9 + 23.0, lo) * 1.4 - 0.35 * dry, 0.0, 1.0);
  vec3 forest = vec3(0.035, 0.105, 0.03), grass = vec3(0.13, 0.19, 0.055), sand = vec3(0.46, 0.36, 0.20);
  vec3 rock = vec3(0.22, 0.19, 0.16), snow = vec3(0.86, 0.89, 0.93), tundra = vec3(0.20, 0.19, 0.13);
  vec3 lc = mix(sand, mix(grass, forest, smoothstep(0.45, 0.8, moist)), smoothstep(0.22, 0.48, moist));
  lc = mix(lc, tundra, smoothstep(0.42, 0.26, temp));
  lc = mix(lc, rock, smoothstep(0.45, 0.85, mount));
  lc = mix(lc, snow, smoothstep(0.24, 0.15, temp));
  lc = mix(sand * 1.1, lc, smoothstep(0.0, 0.02, elev));
  vec3 deep = vec3(0.006, 0.028, 0.095), shallow = vec3(0.02, 0.16, 0.24);
  float depth = clamp((sea - cont) * 5.0, 0.0, 1.0);
  vec3 sc = mix(shallow, deep, smoothstep(0.0, 0.35, depth));
  float seaIce = smoothstep(0.80, 0.86, lat + fbm(p * 5.0, lo) * 0.07);
  sc = mix(sc, snow * 0.92, seaIce);
  s.albedo = mix(sc, lc, land);
  s.spec = (1.0 - land) * (1.0 - seaIce);
  s.gloss = 420.0;
  s.height = land * (elev * 0.5 + mount * 0.35);
  s.bump = 0.9;
  float pop = smoothstep(0.42, 0.62, 0.5 + fbm(p * 5.0 + 40.0, lo)) * smoothstep(0.25, 0.5, temp) * (1.0 - smoothstep(0.3, 0.6, mount));
  float grain = uOct >= 6 ? smoothstep(0.55, 0.9, 0.5 + 0.9 * gnoise(p * 150.0)) * 1.4 : 0.3;
  s.night = land * pop * grain * uPar.w;
  s.cloud = cloudAt(nb) * 0.95;
  s.cloudShadow = uOct >= 5 ? cloudAt(normalize(nb + sunB * 0.02)) : s.cloud;
  return s;
}
#else
// Gas and ice giants: turbulent latitude bands, a storm oval and polar haze.
float hfield(vec3 nb) { return 0.0; }
Surf surface(vec3 nb, vec3 sunB) {
  Surf s = blank();
  vec3 so = seedOff();
  float lat = nb.y;
  float bands = uPar.x, contrast = uPar.y;
  vec3 nr = rotY(nb, uTime * 0.004 * sin(lat * 11.0 + uSeed));
  int lo = min(uOct, 5);
  float t1 = fbm(vec3(nr.x * 1.6, lat * 5.0, nr.z * 1.6) + so, lo);
  float t2 = fbm(vec3(nr.x * 5.0, lat * 16.0, nr.z * 5.0) + so * 1.7 + t1 * 1.5, uOct);
  float t3 = fbm(vec3(nr.x * 14.0, lat * 34.0, nr.z * 14.0) + so * 2.3 + t2 * 2.0, uOct);
  float t4 = uOct >= 6 ? fbm(vec3(nr.x * 40.0, lat * 70.0, nr.z * 40.0) + so * 3.1 + t3 * 3.0, uOct) : 0.0;
  float v = lat * bands + (t1 * 0.9 + t2 * 0.35) * contrast;
  float b1 = sin(v * 3.14159);
  float b2 = sin(v * 1.37 + uSeed * 2.0);
  float b3 = sin(v * 5.2 + 1.0 + uSeed);
  float zone = clamp(0.5 + 0.42 * b1 + 0.2 * b3 + (t3 * 0.6 + t4 * 0.45) * contrast, 0.0, 1.0);
  zone = mix(zone, smoothstep(0.15, 0.85, zone), 0.6);
  float luma = dot(uBase, vec3(0.3333));
  float warm = clamp((uBase.r - uBase.b) * 3.0 + 0.5, 0.0, 1.0);
  vec3 cLight = mix(uBase, vec3(1.0, 0.96, 0.88), 0.45);
  vec3 cDark = uBase * mix(vec3(0.85), mix(vec3(0.42, 0.50, 0.62), vec3(0.50, 0.36, 0.30), warm), contrast);
  vec3 cAlt = mix(uBase * 0.75, luma * vec3(1.20, 0.72, 0.48), warm * 0.8);
  vec3 col = mix(cDark, cLight, zone);
  col = mix(col, cAlt, smoothstep(0.2, 0.9, 0.5 + 0.5 * b2) * 0.55 * contrast);
  vec3 sc = normalize(vec3(cos(uSeed * 5.1), 0.32 * sin(uSeed * 3.7), sin(uSeed * 5.1)));
  vec3 dv = nr - sc;
  float sd = length(vec3(dv.x, dv.y * 2.3, dv.z));
  float spot = smoothstep(0.26, 0.12, sd) * uPar.z;
  float swirl = fbm(rotY(nr, (0.3 - sd) * 9.0) * 9.0 + so, lo);
  col = mix(col, mix(mix(cAlt, uBase * vec3(1.25, 0.55, 0.35), warm), cLight, clamp(0.5 + swirl, 0.0, 1.0)), spot * 0.85);
  col = mix(col, uBase * vec3(0.55, 0.62, 0.75), smoothstep(0.72, 0.98, abs(lat)) * 0.6);
  s.albedo = col;
  s.limb = 0.9;
  return s;
}
#endif
`;

const PLANET_MAIN = /* glsl */ `
void main() {
  vec3 d = normalize(vWorld);
  vec3 n;
  float cov = sphereHit(d, n);
  if (cov <= 0.0) discard;
  vec3 nb = uRot * n;
  Surf s = surface(nb, uRot * uSunDir);
  float ndv = max(dot(n, -d), 0.0);
  vec3 nn = n;
  if (s.bump > 0.0 && uOct >= 4) {
    // Relief: the gradient of the height field from two more samples about a pixel away.
    float eps = max(2.0 * uPix * dot(d, uCenter) / uRadius, 0.0012);
    vec3 t1 = normalize(cross(nb, abs(nb.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(nb, t1);
    float h1 = hfield(normalize(nb + t1 * eps)), h2 = hfield(normalize(nb + t2 * eps));
    vec3 grad = ((h1 - s.height) * t1 + (h2 - s.height) * t2) / eps;
    vec3 bent = normalize(nb - grad * s.bump * 0.07) * uRot;
    nn = normalize(mix(n, bent, smoothstep(0.0, 0.25, ndv)));
  }
  float ndl = dot(nn, uSunDir);
  // The unperturbed normal decides the terminator and shadows.
  float geo = dot(n, uSunDir);
  float lambert = max(ndl, 0.0) * smoothstep(-0.05, 0.12, geo);
  float wrap = max(mix(ndl, geo, 0.5) + 0.08, 0.0) / 1.08;
  float light = mix(lambert, wrap, uAtmo * 0.6);
  vec3 sun = uSun * ringShadow(n);
  vec3 col = s.albedo * sun * light;
  col *= mix(1.0, pow(ndv, 0.45), s.limb);
  if (s.spec > 0.0) {
    vec3 hv = normalize(uSunDir - d);
    float nh = max(dot(mix(n, nn, 0.5), hv), 0.0);
    float sp = pow(nh, s.gloss) * min(s.gloss / 180.0, 1.6) + 0.06 * pow(nh, 18.0);
    col += sun * s.spec * sp * (1.0 - s.cloud) * step(0.0, geo);
  }
  if (s.cloud > 0.0 || s.cloudShadow > 0.0) {
    col *= 1.0 - 0.55 * s.cloudShadow * (1.0 - s.cloud);
    float cl = max((geo + 0.12) / 1.12, 0.0);
    vec3 cc = mix(vec3(1.0, 0.50, 0.28), vec3(0.96), smoothstep(-0.02, 0.28, geo));
    col = mix(col, cc * sun * cl, s.cloud);
  }
  col += s.night * vec3(1.0, 0.58, 0.22) * 1.6 * (1.0 - s.cloud) * smoothstep(0.02, -0.14, geo);
  if (uAtmo > 0.0) {
    // Haze over the disc: thicker toward the limb, tinted orange along the terminator.
    float rim = pow(1.0 - ndv, 3.0);
    float day = smoothstep(-0.22, 0.30, geo);
    col = col * (1.0 - uAtmo * 0.35 * rim) + uAtmoColor * sun * uAtmo * day * (0.06 + 0.75 * rim);
    col += vec3(1.0, 0.36, 0.12) * sun * uAtmo * 0.10 * exp(-geo * geo / 0.008) * (0.25 + rim);
  }
  col += s.emission;
  gl_FragColor = vec4(col, cov * uFade);
}
`;

/** Surface classes; the value selects the shader variant through the TYPE define. */
export const PLANET_TYPE = { rocky: 0, desert: 1, lava: 2, ice: 3, ocean: 4, terran: 4, gas: 5, icegiant: 5 } as const;

export const PLANET_FRAG = PLANET_HEAD + SURFACES + PLANET_MAIN;

/** Glow of the atmosphere beyond the limb, drawn on a shell around the planet before the planet itself. */
export const ATMO_FRAG = /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
uniform float uAtmoR;
uniform vec3 uAtmoColor;
uniform float uAtmo;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform float uFade;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld);
  float b = dot(d, uCenter);
  if (b <= 0.0) discard;
  vec3 perp = uCenter - d * b;
  float h = length(perp);
  // Height of the ray's closest approach above the surface, 0..1 across the shell.
  float a = (h - uRadius) / (uAtmoR - uRadius);
  if (a >= 1.0) discard;
  float dens = exp(-max(a, 0.0) * 5.5) * (1.0 - smoothstep(0.55, 1.0, a));
  vec3 nc = -perp / max(h, 1e-9);
  float sun = dot(nc, uSunDir);
  float lit = smoothstep(-0.30, 0.25, sun);
  float fwd = pow(max(dot(d, uSunDir), 0.0), 5.0);
  vec3 col = uAtmoColor * (0.9 + 2.2 * fwd);
  col = mix(vec3(1.0, 0.42, 0.18) * (0.8 + 2.0 * fwd), col, smoothstep(-0.15, 0.25, sun));
  gl_FragColor = vec4(col * uSun * dens * lit * uAtmo * uFade, 1.0);
}
`;

/** Rings: a flat annulus whose bands, lighting, planet shadow and occlusion by the planet are computed per pixel. */
export const RING_FRAG = /* glsl */ `
uniform vec3 uRingColor;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform float uFade;
varying vec3 vWorld;
${GLSL_NOISE}
${SPHERE_GLSL}
${RING_GLSL}
void main() {
  vec3 d = normalize(vWorld);
  float dn = dot(d, uRingN);
  if (abs(dn) < 1e-5) discard;
  float tr = dot(uCenter, uRingN) / dn;
  if (tr <= 0.0) discard;
  vec3 rel = d * tr - uCenter;
  float r = length(rel) / uRadius;
  float dens = ringDensity(r, fwidth(r) / (uRing.y - uRing.x));
  if (dens <= 0.0) discard;
  // The planet hides the part of the ring behind it.
  vec3 n;
  float cov = sphereHit(d, n);
  float b = dot(d, uCenter);
  float occl = tr > b ? cov : 0.0;
  // Shadow of the planet on the ring, with a penumbra that widens with distance.
  float bs = dot(rel, uSunDir);
  float hs = length(rel - uSunDir * bs) / uRadius;
  float pen = 0.015 + 0.02 * max(-bs / uRadius, 0.0);
  float shadow = bs < 0.0 ? smoothstep(1.0 - pen, 1.0 + pen, hs) : 1.0;
  float sunSide = dot(uSunDir, uRingN);
  bool lit = sunSide * -dn > 0.0;
  // Seen from the unlit side, thin parts glow with transmitted light and dense parts stay dark.
  float amount = lit ? 0.50 + 0.50 * dens : 0.10 + 2.0 * dens * (1.0 - dens) * (1.0 - dens);
  float fwd = pow(max(dot(d, uSunDir), 0.0), 6.0);
  float x = (r - uRing.x) / (uRing.y - uRing.x);
  vec3 tone = mix(vec3(0.95, 0.80, 0.66), vec3(1.5, 1.45, 1.4), n1(x * 9.0 + uRing.z * 4.0));
  vec3 col = uRingColor * tone * uSun * amount * (1.0 + (lit ? 0.4 : 1.6) * fwd) * (0.30 + 0.70 * smoothstep(0.0, 0.3, abs(sunSide)));
  col = col * (0.03 + 0.97 * shadow);
  // A slanted view passes through more ring material.
  float alpha = 1.0 - pow(1.0 - dens * 0.92, 1.0 / max(abs(dn), 0.2));
  gl_FragColor = vec4(col, alpha * uRing.w * (1.0 - occl) * uFade);
}
`;
