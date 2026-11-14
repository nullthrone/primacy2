/**
 * Surface detail of the lit materials of this part, made in the shader from the position on the
 * model: the models carry no texture coordinates and no images.
 *
 *   hull   plating for everything built (ships, stations, gates, bases, pods, the cockpit): the
 *          surface is cut into plates of varied size with thin dark joints, every plate differs a
 *          little in tone, gloss and tilt, and stains and a fine relief lie over all of it
 *   rock   asteroids: mottled tone, rough relief over several scales, small pits
 *
 * The pattern is a function of the position in the model's own axes, so it stays on the model
 * while that moves and turns. Everything is filtered against the size of a pixel on the surface:
 * a joint thinner than a pixel is drawn as the share of the pixel it covers, a plate or a grain
 * smaller than about two pixels dissolves into the mean, so nothing flickers far away or in motion.
 *
 * A material is given its surface by `assignSurface`, which notes it in `userData.surface`. A
 * clone of the material carries that note along (three copies `userData`, not the shader hook),
 * and `installSurface` puts the hook back; the material registry calls it for every material.
 * `patchShader` lets several changes to one material's shader live side by side.
 */
import {
  Data3DTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
  Vector4,
  type Material,
  type MeshStandardMaterial,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { seeded } from '../util.ts';

type Shader = WebGLProgramParametersWithUniforms;

interface Patch {
  key: string;
  apply: (shader: Shader) => void;
}

const patches = new WeakMap<Material, Patch[]>();

/**
 * Adds a change to a material's shader. Changes are applied in the order they were added and the
 * material's program key names all of them. A change must keep the `#include` line it hooks onto
 * (replace it by itself plus more), so the next change still finds it.
 */
export function patchShader(m: Material, key: string, apply: (shader: Shader) => void): void {
  let list = patches.get(m);
  if (!list) {
    const own: Patch[] = [];
    list = own;
    patches.set(m, own);
    m.onBeforeCompile = (shader) => {
      for (const p of own) p.apply(shader);
    };
    m.customProgramCacheKey = () => own.map((p) => p.key).join('+');
  }
  if (list.some((p) => p.key === key)) return;
  list.push({ key, apply });
  m.needsUpdate = true;
}

/** What a material's surface is made of; plain data, so it survives `Material.clone()`. */
export interface SurfaceSpec {
  kind: 'hull' | 'rock';
  /** Edge of the largest plates, metres. */
  block: number;
  /** 1 lays the plates in rings around the model's Y axis (stations, gates), 0 along its axes. */
  polar: number;
  seed: number;
  /** Half the width of a joint between the largest plates, metres. */
  joint: number;
  /** How far plates differ in tone (share of the colour) and in roughness. */
  tone: number;
  rough: number;
  /** Stains and grime, 0..2. */
  wear: number;
  /** Strength of the relief: plate tilt, joint edges, grain. */
  relief: number;
  /** How often a plate is cut again at most. */
  levels: number;
  /** How dark a joint is, 0..1. */
  dark: number;
}

/** The quality level (0..2) every surface shader reads; one object, shared by all materials. */
const quality = { value: 2 };

export function setSurfaceQuality(level: number): void {
  quality.value = level;
}

// ---------------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------------

const NOISE_SIZE = 64;
let noise: Data3DTexture | null = null;
const noiseUniform: { value: Data3DTexture | null } = { value: null };

/**
 * A block of smooth noise that repeats in all three directions, with mipmaps: the value in alpha
 * (mean one half) and its gradient in the colour channels. Three octaves are folded into it, and
 * a shader reads it at scales a factor of eight apart to get relief over many scales. Reading a
 * texture that has mipmaps is what makes fine grain fade into its mean with distance.
 */
function noiseTexture(): Data3DTexture {
  if (noise) return noise;
  const n = NOISE_SIZE;
  const field = new Float32Array(n * n * n);
  const rand = seeded(0x51f15eed);
  for (let octave = 0; octave < 3; octave++) {
    const cells = 8 << octave;
    const amp = 1 / (1 << octave);
    const lattice = new Float32Array(cells * cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1;
    const step = cells / n;
    // Weights and lattice indices along one axis are the same for all three.
    const i0 = new Int32Array(n), i1 = new Int32Array(n);
    const w = new Float32Array(n);
    for (let x = 0; x < n; x++) {
      const p = (x + 0.5) * step;
      const c = Math.floor(p);
      const t = p - c;
      i0[x] = c % cells;
      i1[x] = (c + 1) % cells;
      w[x] = t * t * t * (t * (t * 6 - 15) + 10);
    }
    for (let z = 0; z < n; z++) {
      const z0 = i0[z]! * cells * cells, z1 = i1[z]! * cells * cells, wz = w[z]!;
      for (let y = 0; y < n; y++) {
        const y0 = i0[y]! * cells, y1 = i1[y]! * cells, wy = w[y]!;
        for (let x = 0; x < n; x++) {
          const x0 = i0[x]!, x1 = i1[x]!, wx = w[x]!;
          const a = lattice[z0 + y0 + x0]! + (lattice[z0 + y0 + x1]! - lattice[z0 + y0 + x0]!) * wx;
          const b = lattice[z0 + y1 + x0]! + (lattice[z0 + y1 + x1]! - lattice[z0 + y1 + x0]!) * wx;
          const c = lattice[z1 + y0 + x0]! + (lattice[z1 + y0 + x1]! - lattice[z1 + y0 + x0]!) * wx;
          const d = lattice[z1 + y1 + x0]! + (lattice[z1 + y1 + x1]! - lattice[z1 + y1 + x0]!) * wx;
          const lo = a + (b - a) * wy, hi = c + (d - c) * wy;
          field[(z * n + y) * n + x]! += amp * (lo + (hi - lo) * wz);
        }
      }
    }
  }
  let mean = 0, peak = 0;
  for (let i = 0; i < field.length; i++) mean += field[i]!;
  mean /= field.length;
  for (let i = 0; i < field.length; i++) {
    field[i]! -= mean;
    peak = Math.max(peak, Math.abs(field[i]!));
  }
  const at = (x: number, y: number, z: number): number => field[(((z + n) % n) * n + ((y + n) % n)) * n + ((x + n) % n)]!;
  const grad = new Float32Array(n * n * n * 3);
  let steep = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = ((z * n + y) * n + x) * 3;
        grad[i] = at(x + 1, y, z) - at(x - 1, y, z);
        grad[i + 1] = at(x, y + 1, z) - at(x, y - 1, z);
        grad[i + 2] = at(x, y, z + 1) - at(x, y, z - 1);
        steep = Math.max(steep, Math.abs(grad[i]!), Math.abs(grad[i + 1]!), Math.abs(grad[i + 2]!));
      }
    }
  }
  const data = new Uint8Array(n * n * n * 4);
  for (let i = 0; i < field.length; i++) {
    data[i * 4] = Math.round(127.5 + 127.5 * (grad[i * 3]! / steep));
    data[i * 4 + 1] = Math.round(127.5 + 127.5 * (grad[i * 3 + 1]! / steep));
    data[i * 4 + 2] = Math.round(127.5 + 127.5 * (grad[i * 3 + 2]! / steep));
    data[i * 4 + 3] = Math.round(127.5 + 127.5 * (field[i]! / peak));
  }
  const tex = new Data3DTexture(data, n, n, n);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  noise = tex;
  noiseUniform.value = tex;
  return tex;
}

/** Frees the noise block; the next surface that is compiled makes it again. */
export function disposeSurfaces(): void {
  noise?.dispose();
  noise = null;
  noiseUniform.value = null;
}

// ---------------------------------------------------------------------------------------------
// Shader text
// ---------------------------------------------------------------------------------------------

const VERTEX_PARS = /* glsl */ `
varying vec3 vSurfP;
varying vec3 vSurfN;`;

const VERTEX_MAIN = /* glsl */ `
vSurfP = position;
vSurfN = normal;`;

/** Shared by both kinds: the noise block, a hash and the turn of a normal by a height gradient. */
const COMMON_PARS = /* glsl */ `
uniform highp sampler3D uSurfNoise;
uniform float uSurfQ;
varying vec3 vSurfP;
varying vec3 vSurfN;

// The noise block is read in axes turned against the model's, so its grid never lines up with a flat face.
const mat3 SURF_TURN = mat3(0.36, 0.48, -0.8, -0.8, 0.6, 0.0, 0.48, 0.64, 0.6);

uint surfMix(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

// Tilts the shading normal by the slope of a height field given as its gradient in model axes
// (height and position in the same unit, so the slope has none). "scale" is view units per model unit.
vec3 surfBump(vec3 n, vec3 grad, float scale, float facing) {
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  vec2 dh = vec2(dot(grad, dFdx(vSurfP)), dot(grad, dFdy(vSurfP))) * scale;
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * facing;
  vec3 g = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - g + n * 1e-20);
}`;

const HULL_PARS = /* glsl */ `
uniform vec4 uSurfA; // edge of a block (m), rings around Y (0 or 1), seed, half width of a joint (m)
uniform vec4 uSurfB; // plate tone, plate roughness, wear, relief
uniform vec4 uSurfC; // cuts at most, darkness of a joint

// Share of a pixel ("pix" metres wide) that a joint of half width "hw" covers, "d" metres from its middle.
float surfLine(float d, float hw, float pix) {
  return clamp((min(d + 0.5 * pix, hw) - max(d - 0.5 * pix, -hw)) / pix, 0.0, 1.0);
}

// The edge of a plate is rounded off toward its joint over the width "wide"; flat once that is finer than a pixel.
float surfEdge(float d, float wide, float pix) {
  return (1.0 - smoothstep(0.0, wide, d)) * smoothstep(0.6, 2.0, wide / pix);
}

// A wall of blocks, one per unit of q, each row of blocks shifted against the next. A block is cut
// again and again across its longer side at a random place, and some plates are left large.
// Out: metres to the four joints of the plate (toward -u, -v, +u, +v), how far each joint is shown
// (it fades as the plates on its level shrink to a few pixels), how thin it is, and four random
// values of the plate, summed over the levels so that they fade with them too.
void surfPlates(vec2 q, vec2 size, vec2 pix, float wrap, uint seed, int cuts,
                out vec4 dist, out vec4 show, out vec4 thin, out vec4 look) {
  float row = floor(q.y);
  uint hr = surfMix(uint(int(row)) * 0x9e3779b1u + seed);
  q.x += float(hr >> 16) / 65536.0;
  float col = floor(q.x);
  vec2 f = q - vec2(col, row);
  if (wrap > 0.5) col = mod(col, wrap);
  uint h = surfMix((uint(int(col)) * 0x85ebca6bu) ^ hr);
  vec2 lo = vec2(0.0);
  vec2 hi = vec2(1.0);
  float w = smoothstep(3.0, 8.0, min(size.x / pix.x, size.y / pix.y));
  show = vec4(w);
  thin = vec4(1.0);
  look = (vec4(float(h & 255u), float((h >> 8) & 255u), float((h >> 16) & 255u), float(h >> 24)) / 255.0 - 0.5) * w;
  float amp = 1.0;
  float slim = 1.0;
  for (int i = 0; i < cuts; i++) {
    if (w <= 0.0) break;
    vec2 span = (hi - lo) * size;
    uint hc = surfMix(h ^ 0x68bc21ebu);
    float ra = float(hc & 0xffffu) / 65536.0;
    float rb = float(hc >> 16) / 65536.0;
    if (i > 0 && rb > 0.66) break;
    bool alongU = span.x * (0.75 + 0.5 * fract(rb * 7.0)) > span.y;
    float t = 0.32 + 0.36 * ra;
    float child = min(t, 1.0 - t) * (alongU ? span.x / pix.x : span.y / pix.y);
    w = min(w, smoothstep(3.0, 8.0, child));
    if (w <= 0.0) break;
    slim *= 0.82;
    amp *= 0.66;
    uint side;
    if (alongU) {
      float c = mix(lo.x, hi.x, t);
      if (f.x < c) { hi.x = c; show.z = w; thin.z = slim; side = 1u; }
      else { lo.x = c; show.x = w; thin.x = slim; side = 2u; }
    } else {
      float c = mix(lo.y, hi.y, t);
      if (f.y < c) { hi.y = c; show.w = w; thin.w = slim; side = 1u; }
      else { lo.y = c; show.y = w; thin.y = slim; side = 2u; }
    }
    h = surfMix(hc + side);
    look += (vec4(float(h & 255u), float((h >> 8) & 255u), float((h >> 16) & 255u), float(h >> 24)) / 255.0 - 0.5) * (amp * w);
  }
  dist = vec4(f - lo, hi - f) * size.xyxy;
}`;

/** Runs after the base colour is known; leaves `surfRough` and `surfGrad` for the later hooks. */
const HULL_COLOR = /* glsl */ `
float surfRough = 0.0;
vec3 surfGrad = vec3(0.0);
{
  vec3 sP = vSurfP;
  vec3 sN = normalize(vSurfN);
  vec3 sDx = dFdx(sP);
  vec3 sDy = dFdy(sP);
  float sB = uSurfA.x;
  uint sSeed = uint(uSurfA.z);

  // Which way the surface faces decides the two directions the plates are laid along.
  vec2 sQ;
  vec2 sSize = vec2(sB);
  vec3 sU;
  vec3 sV;
  float sWrap = 0.0;
  if (uSurfA.y > 0.5) {
    // Rings around the Y axis: walls that face outward or inward, decks that face along the axis,
    // and faces that look along the ring.
    float r = length(sP.xz);
    vec2 out2 = r > 1e-4 ? sP.xz / r : vec2(1.0, 0.0);
    vec3 er = vec3(out2.x, 0.0, out2.y);
    vec3 et = vec3(-out2.y, 0.0, out2.x);
    vec3 an = abs(vec3(dot(sN, er), sN.y, dot(sN, et))) * vec3(1.0, 1.03, 0.97);
    float around = atan(sP.z, sP.x) * 0.15915494 + 0.5;
    if (an.x >= an.y && an.x >= an.z) {
      // The number of blocks around follows the radius in steps of the square root of two, so one
      // wall has one number although its radius wavers from facet to facet.
      float ring = exp2(floor(log2(max(r, 0.01) / sB) * 2.0 + 0.5) * 0.5);
      sWrap = max(3.0, floor(6.2831853 * ring + 0.5));
      sQ = vec2(around * sWrap, sP.y / sB);
      sSize.x = 6.2831853 * r / sWrap;
      sU = et;
      sV = vec3(0.0, 1.0, 0.0);
      sSeed += 11u;
    } else if (an.y >= an.z) {
      float band = floor(r / sB);
      sWrap = max(3.0, floor(6.2831853 * (band + 0.5) + 0.5));
      sQ = vec2(around * sWrap, r / sB);
      sSize.x = 6.2831853 * r / sWrap;
      sU = et;
      sV = er;
      sSeed += sN.y > 0.0 ? 23u : 37u;
    } else {
      sQ = vec2(r, sP.y) / sB;
      sU = er;
      sV = vec3(0.0, 1.0, 0.0);
      sSeed += 41u;
    }
  } else {
    // Along the model's axes, mirrored left to right like the hull itself; the long joints run fore and aft.
    vec3 an = abs(sN) * vec3(1.0, 1.03, 0.97);
    float ax = abs(sP.x) + 0.5 * sB;
    if (an.x >= an.y && an.x >= an.z) {
      sQ = sP.zy / sB;
      sU = vec3(0.0, 0.0, 1.0);
      sV = vec3(0.0, 1.0, 0.0);
      sSeed += 11u;
    } else if (an.y >= an.z) {
      sQ = vec2(sP.z, ax) / sB;
      sU = vec3(0.0, 0.0, 1.0);
      sV = vec3(sP.x < 0.0 ? -1.0 : 1.0, 0.0, 0.0);
      sSeed += sN.y > 0.0 ? 23u : 37u;
    } else {
      sQ = vec2(ax, sP.y) / sB;
      sU = vec3(sP.x < 0.0 ? -1.0 : 1.0, 0.0, 0.0);
      sV = vec3(0.0, 1.0, 0.0);
      sSeed += sN.z > 0.0 ? 41u : 53u;
    }
  }
  // Metres one pixel spans along each of the two directions.
  vec2 sPix = max(vec2(abs(dot(sU, sDx)) + abs(dot(sU, sDy)), abs(dot(sV, sDx)) + abs(dot(sV, sDy))), vec2(1e-6));

  vec4 sDist;
  vec4 sShow;
  vec4 sThin;
  vec4 sLook;
  int sCuts = int(uSurfQ > 0.5 ? uSurfC.x : min(uSurfC.x, 3.0));
  surfPlates(sQ, sSize, sPix, sWrap, sSeed, sCuts, sDist, sShow, sThin, sLook);

  float sHw = uSurfA.w;
  vec4 sCover = vec4(
    surfLine(sDist.x, sHw * sThin.x, sPix.x), surfLine(sDist.y, sHw * sThin.y, sPix.y),
    surfLine(sDist.z, sHw * sThin.z, sPix.x), surfLine(sDist.w, sHw * sThin.w, sPix.y)) * sShow;
  float sJoint = max(max(sCover.x, sCover.y), max(sCover.z, sCover.w));
  // Dirt gathers along the joints.
  vec4 sNear = exp(-sDist / (sHw * 7.0)) * sShow;
  float sDirt = max(max(sNear.x, sNear.y), max(sNear.z, sNear.w));
  // Each plate is rounded off toward its joints and lies a little out of true.
  float sWide = sHw * 5.0;
  vec4 sRound = vec4(surfEdge(sDist.x, sWide, sPix.x), surfEdge(sDist.y, sWide, sPix.y),
                     surfEdge(sDist.z, sWide, sPix.x), surfEdge(sDist.w, sWide, sPix.y)) * sShow;
  float sRelief = uSurfB.w;
  surfGrad = (sU * (sRound.x - sRound.z + sLook.z * 0.1) + sV * (sRound.y - sRound.w + sLook.w * 0.1)) * sRelief;

  // Stains wider than a plate, mottling within one, and grain.
  vec3 sC = SURF_TURN * sP / sB;
  vec4 sStain = texture(uSurfNoise, sC * 0.09 + fract(uSurfA.z * 0.137));
  vec4 sMottle = texture(uSurfNoise, sC * 0.72 + 0.37);
  float sWear = uSurfB.z;
  // Most plates are nearly alike; a few stand out, as replaced ones do.
  float sOdd = clamp(sLook.x, -1.0, 1.0);
  float sTone = (sOdd * 0.4 + sOdd * abs(sOdd) * 2.2) * uSurfB.x
    + ((sStain.a - 0.5) * 0.4 + (sMottle.a - 0.5) * 0.18) * sWear;
  surfRough = sLook.y * uSurfB.y * 2.0 + ((sStain.a - 0.5) * 0.55 + (sMottle.a - 0.5) * 0.25) * sWear + sJoint * 0.2;
  surfGrad += ((sMottle.rgb - 0.5) * SURF_TURN) * (0.22 * sRelief);
  if (uSurfQ > 0.5) {
    vec4 sGrain = texture(uSurfNoise, sC * 5.76 + 0.71);
    surfGrad += ((sGrain.rgb - 0.5) * SURF_TURN) * (0.4 * sRelief);
    surfRough += (sGrain.a - 0.5) * 0.2;
    sTone += (sGrain.a - 0.5) * 0.07 * sWear;
  }
  float sGrime = sDirt * clamp(0.5 + (sMottle.a - 0.5) * 3.0, 0.0, 1.0) * 0.16 * sWear;
  // Far away the joints are gone; what they took from the mean stays.
  float sFar = 1.0 - smoothstep(3.0, 8.0, min(sSize.x / sPix.x, sSize.y / sPix.y));
  diffuseColor.rgb *= max(0.0, 1.0 + sTone) * (1.0 - uSurfC.y * sJoint) * (1.0 - sGrime) * (1.0 - 0.02 * sFar);
}`;

const ROCK_PARS = /* glsl */ `
// Pits: a grid in space, and in less than half of its cells a ball that stays inside its cell.
// Where a ball cuts the surface there is a bowl, its outline bent by "warp". Returns the gradient
// of the bowl (xyz) and how deep inside it the point lies (w).
vec4 surfPit(vec3 p, float cell, float pix, float warp) {
  vec3 c = p / cell;
  vec3 ic = floor(c);
  uint h = surfMix(uint(int(ic.x)) * 0x9e3779b1u ^ surfMix(uint(int(ic.y)) * 0x85ebca6bu ^ surfMix(uint(int(ic.z)))));
  if ((h >> 28) > 6u) return vec4(0.0);
  vec3 mid = 0.32 + 0.36 * vec3(float(h & 511u), float((h >> 9) & 511u), float((h >> 18) & 511u)) / 511.0;
  float size = float((h >> 27) & 1u) * 0.5 + float(h & 127u) / 254.0;
  float rad = 0.08 + 0.2 * size * size;
  vec3 d = c - ic - mid;
  float dd = dot(d, d) / (rad * rad) * (1.0 + warp);
  float fade = smoothstep(2.0, 5.0, rad * cell / pix);
  if (dd >= 1.0 || fade <= 0.0) return vec4(0.0);
  // A shallow bowl with a soft rim: the slope is steepest half way out.
  float wall = dd * (1.0 - dd) * 4.0;
  return vec4(d / (rad * sqrt(max(dd, 1e-4))) * (0.8 * wall * fade), (1.0 - dd) * fade);
}`;

const ROCK_COLOR = /* glsl */ `
float surfRough = 0.0;
vec3 surfGrad = vec3(0.0);
float surfScale = 1.0;
{
  vec3 sP = vSurfP;
  vec3 sDx = dFdx(sP);
  vec3 sDy = dFdy(sP);
  // The rock model has a radius of one; its size in the world comes from the instance.
  float sPix = max(max(length(sDx), length(sDy)), 1e-9);
  surfScale = length(dFdx(vViewPosition)) / max(length(sDx), 1e-9);
  vec3 sC = SURF_TURN * sP;
  float sTone = 0.0;
  float sWarp = 0.0;
  int sReads = uSurfQ > 1.5 ? 4 : uSurfQ > 0.5 ? 3 : 2;
  float sFreq = 0.3;
  float sAmp = 1.0;
  float sSlope = 2.2;
  for (int i = 0; i < sReads; i++) {
    // Once the coarsest grain of a reading is smaller than a pixel there is nothing left in it.
    if (sFreq * sPix > 0.12) break;
    vec4 n = texture(uSurfNoise, sC * sFreq + float(i) * 0.37);
    sTone += (n.a - 0.5) * sAmp;
    surfGrad += ((n.rgb - 0.5) * SURF_TURN) * sSlope;
    if (i == 1) sWarp = (n.a - 0.5) * 2.4;
    sFreq *= 8.0;
    sAmp *= 0.6;
    sSlope *= 1.15;
  }
  vec4 sPit = surfPit(sP, 0.26, sPix, sWarp);
  vec4 sSmall = surfPit(sP + 3.7, 0.085, sPix, sWarp);
  sPit = vec4(sPit.xyz + sSmall.xyz, max(sPit.w, sSmall.w));
  if (uSurfQ > 0.5) {
    sSmall = surfPit(sP + 9.1, 0.027, sPix, sWarp);
    sPit = vec4(sPit.xyz + sSmall.xyz, max(sPit.w, sSmall.w));
  }
  surfGrad += sPit.xyz;
  // Dust lies in the pits.
  diffuseColor.rgb *= max(0.0, 1.0 + sTone * 1.3) * (1.0 - 0.3 * sPit.w);
  surfRough = sTone * 0.15;
}`;

const ROUGH_MAIN = /* glsl */ `
roughnessFactor = clamp(roughnessFactor + surfRough, 0.06, 1.0);`;

const hullNormal = (scale: string): string => /* glsl */ `
normal = surfBump(normal, surfGrad, ${scale}, faceDirection);`;

function apply(shader: Shader, pars: string, color: string, scale: string): void {
  shader.uniforms.uSurfNoise = noiseUniform;
  shader.uniforms.uSurfQ = quality;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${VERTEX_PARS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>${VERTEX_MAIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${COMMON_PARS}${pars}`)
    .replace('#include <color_fragment>', `#include <color_fragment>${color}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${ROUGH_MAIN}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${hullNormal(scale)}`);
}

/** Puts the shader hook of the surface noted in `userData.surface` on a material; does nothing without one. */
export function installSurface(m: MeshStandardMaterial): void {
  const spec = (m.userData as { surface?: SurfaceSpec }).surface;
  if (!spec) return;
  noiseTexture();
  if (spec.kind === 'rock') {
    patchShader(m, 'rock', (shader) => apply(shader, ROCK_PARS, ROCK_COLOR, 'surfScale'));
    return;
  }
  // One program for every hull material; what differs between them is in these uniforms.
  const a = { value: new Vector4(spec.block, spec.polar, spec.seed, spec.joint) };
  const b = { value: new Vector4(spec.tone, spec.rough, spec.wear, spec.relief) };
  const c = { value: new Vector4(spec.levels, spec.dark, 0, 0) };
  patchShader(m, 'hull', (shader) => {
    shader.uniforms.uSurfA = a;
    shader.uniforms.uSurfB = b;
    shader.uniforms.uSurfC = c;
    apply(shader, HULL_PARS, HULL_COLOR, '1.0');
  });
}

const hashKey = (key: string): number => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 4096;
};

/**
 * The surface a material of the model `key` gets, by the material's name, or null for one that is
 * left as it is (lamps, glass, the portal, regolith). `radius` is the model's bounding radius in
 * metres: plates grow with the object, though far more slowly than it does.
 */
export function surfaceFor(name: string, key: string, radius: number): SurfaceSpec | null {
  if (name === 'rock') return key.startsWith('asteroid') ? { kind: 'rock', block: 1, polar: 0, seed: 0, joint: 0, tone: 0, rough: 0, wear: 0, relief: 0, levels: 0, dark: 0 } : null;
  const seed = hashKey(key);
  if (name.startsWith('cockpit_')) {
    // Close to the eye: small satin panels with seams a couple of millimetres wide.
    return { kind: 'hull', block: 0.6, polar: 0, seed, joint: 0.0013, tone: 0.05, rough: 0.05, wear: 0.12, relief: 0.5, levels: 4, dark: 0.55 };
  }
  if (!name.startsWith('hull_')) return null;
  // Rings around the axis for what is built around one; plates of a station are larger for its size than a ship's.
  const polar = key.startsWith('station_') || key === 'gate';
  const large = polar || radius > 100;
  const block = (large ? 1.6 : 1.05) * Math.pow(Math.max(radius, 1), 0.4);
  const base: SurfaceSpec = {
    kind: 'hull', block, polar: polar ? 1 : 0, seed,
    joint: block * 0.0035, tone: 0.07, rough: 0.12, wear: 1, relief: 1, levels: large ? 7 : 4, dark: 0.45,
  };
  // Paint in the signal colours keeps its colour; dark plating shows its plates in the gloss.
  if (name.startsWith('hull_accent')) return { ...base, tone: 0.025, rough: 0.08, wear: 0.4 };
  if (name.startsWith('hull_dark')) return { ...base, tone: 0.16, rough: 0.16 };
  if (name.startsWith('hull_secondary')) return { ...base, tone: 0.1, rough: 0.14 };
  return base;
}

/** Gives a material the surface that goes with its name and installs it. */
export function assignSurface(m: MeshStandardMaterial, key: string, radius: number): void {
  const spec = surfaceFor(m.name, key, radius);
  if (!spec) return;
  (m.userData as { surface?: SurfaceSpec }).surface = spec;
  installSurface(m);
}
