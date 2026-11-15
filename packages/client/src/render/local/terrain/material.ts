/**
 * The material of a ground tile. The ground is shaded by `shade.ts`, the same code the far view
 * of the body uses, and takes its light from the local layer:
 *
 * - The star and the ambient level are the frame's `Lighting`, the numbers the `objects` part
 *   gives its sun and ambient light. The ground does not read them back from three's sun light,
 *   because that light is dimmed as a whole when the camera is in the body's shadow, while the
 *   ground needs its own day and night for every point: a pilot on the night side still sees the
 *   sunlit ground beyond the terminator.
 * - The shadow of ships and structures comes from the sun light's shadow map, through three's
 *   own shadow code. The shadow box around a ship ends a little behind it, so ground farther
 *   along the light is tested at the box's end; the shadow weakens with the distance behind the
 *   box, as a real one does when the caster no longer covers the sun's disc, and that is how a
 *   pilot reads height from it.
 * - Lamps (the landing light, the floodlights of a base) are three's spot and point lights of
 *   the scene, added as plain diffuse light. The camera's own fill light (a point light without
 *   falloff) is left out: it is there for hulls against black space, not for the ground.
 *
 * What the vertex shader does
 * - Level of detail without a jump: a vertex moves from its own place to its place on the parent
 *   tile's surface as it nears the distance at which the parent takes over (`uMorph`), and a tile
 *   that has just been loaded starts on the parent's surface and settles over half a second.
 * - Relief by height: high above the body (`uRelief` 0) the ground is the smooth sphere of the far
 *   view; the relief grows in as the camera comes down.
 * - Ground beyond the far plane of the local scene is kept at the far plane's depth, so it is
 *   drawn and not cut off; the part draws such tiles far to near.
 *
 * What the fragment shader does
 * - Normal and tone from the tile's map, blended toward the parent's map (its normals turned
 *   from the parent's frame into the tile's) by the same amount the vertices moved, and toward
 *   the far map by `uRelief`.
 * - What the terrain function does not have (below its 10 m): rolling ground and patches of tone
 *   from a noise texture, small craters, and stones that stand up and cast shadows, each size of
 *   thing only while it is larger than a few pixels. All of it bends the shading normal and
 *   changes reflectance and the star's light, nothing else; the ground a ship stands on is the mesh.
 */
import {
  ClampToEdgeWrapping, DataTexture, FrontSide, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix3, RepeatWrapping, RGBAFormat,
  ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3,
} from 'three';
import type { CubeTexture, IUniform } from 'three';
import { GROUND_GLSL } from './shade.ts';

/**
 * The small detail of the ground repeats after this many metres along each body-fixed axis, so
 * that it can be computed from small numbers (a tile's origin is reduced by it) and still meets
 * itself across tile edges. Every lattice's cell and every layout of the grain texture divides it.
 */
export const DETAIL_PERIOD = 4096;

/** Texels along the edge of the grain texture, and lattice cells of its noise along it. */
const GRAIN_SIZE = 512;
const GRAIN_CELLS = 64;

/**
 * The grain texture: noise that repeats at its edges, made here once, for the rolling of the
 * ground and its patches of tone below what the terrain function has. Red and green are the
 * slope of a height, blue the height, alpha a second noise that has nothing to do with the
 * first; all centred on one half. The shader lays it out at six sizes (see there); its mip
 * levels and the anisotropic filter are what keeps slanted and distant ground from flickering.
 */
export function grainTexture(): DataTexture {
  const size = GRAIN_SIZE;
  // A generator with a fixed start: the texture is the same on every run.
  let state = 0x2f6e2b1;
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  // Adds gradient noise of `cells` lattice cells along the edge, sampled at the texel centres.
  const add = (out: Float32Array, cells: number, gain: number): void => {
    const gx = new Float32Array(cells * cells);
    const gy = new Float32Array(cells * cells);
    for (let k = 0; k < cells * cells; k++) {
      const a = random() * 2 * Math.PI;
      gx[k] = Math.cos(a);
      gy[k] = Math.sin(a);
    }
    for (let y = 0; y < size; y++) {
      const v = ((y + 0.5) / size) * cells;
      const j0 = Math.floor(v), fv = v - j0, j1 = (j0 + 1) % cells, sv = fade(fv);
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * cells;
        const i0 = Math.floor(u), fu = u - i0, i1 = (i0 + 1) % cells, su = fade(fu);
        const a = gx[j0 * cells + i0]! * fu + gy[j0 * cells + i0]! * fv;
        const b = gx[j0 * cells + i1]! * (fu - 1) + gy[j0 * cells + i1]! * fv;
        const c = gx[j1 * cells + i0]! * fu + gy[j1 * cells + i0]! * (fv - 1);
        const d = gx[j1 * cells + i1]! * (fu - 1) + gy[j1 * cells + i1]! * (fv - 1);
        out[y * size + x] += gain * (a + su * (b - a) + sv * (c - a) + su * sv * (a - b - c + d));
      }
    }
  };
  const height = new Float32Array(size * size);
  const other = new Float32Array(size * size);
  add(height, GRAIN_CELLS, 1);
  add(height, GRAIN_CELLS * 2, 0.4);
  add(other, GRAIN_CELLS, 1);
  add(other, GRAIN_CELLS * 2, 0.4);
  // The slope from the neighbouring texels, around the edges; then everything scaled to fill a byte.
  const sx = new Float32Array(size * size);
  const sy = new Float32Array(size * size);
  let top = 0, steep = 0, topOther = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      sx[k] = height[y * size + ((x + 1) % size)]! - height[y * size + ((x + size - 1) % size)]!;
      sy[k] = height[((y + 1) % size) * size + x]! - height[((y + size - 1) % size) * size + x]!;
      top = Math.max(top, Math.abs(height[k]!));
      topOther = Math.max(topOther, Math.abs(other[k]!));
      steep = Math.max(steep, Math.abs(sx[k]!), Math.abs(sy[k]!));
    }
  }
  const data = new Uint8Array(size * size * 4);
  const byte = (v: number): number => Math.round(127.5 + 127.5 * v);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = byte(sx[k]! / steep);
    data[k * 4 + 1] = byte(sy[k]! / steep);
    data[k * 4 + 2] = byte(height[k]! / top);
    data[k * 4 + 3] = byte(other[k]! / topOther);
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
attribute vec3 aCoarse;
attribute vec2 aH;
uniform vec3 uMorph;
uniform float uRadius;
uniform float uRelief;
uniform mat3 uToBody;
varying vec2 vUv;
varying float vMorph;
varying vec3 vDir;
varying vec3 vDetail;
varying vec3 vView;
varying vec3 vUp;
varying vec2 vShadowBox;
void main() {
  // The distance of the vertex where it would be without any of this decides how far it has moved.
  float d = length((modelViewMatrix * vec4(position, 1.0)).xyz);
  float m = max(clamp((d - uMorph.y) * uMorph.x, 0.0, 1.0), uMorph.z);
  vec3 transformed = mix(position, aCoarse, m);
  // The body centre is uRadius below the origin of the tile frame.
  vec3 up = normalize(transformed + vec3(0.0, uRadius, 0.0));
  transformed -= up * ((1.0 - uRelief) * mix(aH.x, aH.y, m));
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = min(gl_Position.z, gl_Position.w * 0.9999995);
  vUv = uv;
  vMorph = m;
  vDir = uToBody * up;
  vDetail = uToBody * transformed;
  vView = mvPosition.xyz;
  vUp = normalMatrix * up;
  vShadowBox = vec2(0.0);
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  #include <shadowmap_vertex>
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    // The size of the shadow box, from the matrix that maps into it: its length along the light
    // and half its width, metres.
    mat4 sm = directionalShadowMatrix[0];
    vShadowBox = vec2(1.0 / length(vec3(sm[0].z, sm[1].z, sm[2].z)), 0.5 / length(vec3(sm[0].x, sm[1].x, sm[2].x)));
  #endif
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
uniform mat3 normalMatrix;
uniform sampler2D uMap;
uniform sampler2D uMapParent;
uniform samplerCube uFar;
uniform vec2 uUv;
uniform vec3 uUvParent;
uniform mat3 uFromParent;
uniform float uRelief;
uniform vec3 uBase;
uniform int uKind;
uniform float uDetail;
uniform float uLow;
uniform float uRadius;
uniform sampler2D uGrain;
uniform float uDbg;
uniform vec3 uOriginMod;
uniform mat3 uToBody;
uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
varying vec2 vUv;
varying float vMorph;
varying vec3 vDir;
varying vec3 vDetail;
varying vec3 vView;
varying vec3 vUp;
varying vec2 vShadowBox;
${GROUND_GLSL}

// ---------------------------------------------------------------------------------------------
// Small ground detail. All of it lives in the plane of the cube face the place belongs to (two of
// the three body-fixed coordinates) and repeats after DETAIL_PERIOD metres: stones and craters on
// square lattices, one to a cell, rolling ground and tone from the grain texture.
// ---------------------------------------------------------------------------------------------

const float PERIOD = ${DETAIL_PERIOD}.0;

// A body-fixed vector with the two axes of the lattice plane first, and back.
vec3 toPlane(vec3 v, uint face) { return face == 0u ? v.yzx : face == 1u ? v.zxy : v; }
vec3 fromPlane(vec3 v, uint face) { return face == 0u ? v.zxy : face == 1u ? v.yzx : v; }

// How an offset in the plane of the lattice (metres) becomes an offset along the ground: the
// plane leans against the ground by up to 55 degrees, and what is round on the ground must be
// measured there. Set in main for the place being shaded.
vec2 gLean;
float gStretch;
vec2 alongGround(vec2 d) { return d + gLean * (dot(gLean, d) * gStretch); }

// Random bits for a lattice cell of one layer.
uint cellHash(vec2 cell, uint seed) {
  uvec2 q = uvec2(ivec2(cell));
  uint n = (q.x * 1597334673u) ^ (q.y * 3812015801u) ^ (seed * 2798796415u);
  n = (n ^ (n >> 15)) * 2246822519u;
  n = (n ^ (n >> 13)) * 3266489917u;
  return n ^ (n >> 16);
}
// More bits from the same cell.
uint hashAgain(uint n) {
  n = (n ^ 2654435769u) * 2246822519u;
  n ^= n >> 15;
  n *= 3266489917u;
  n ^= n >> 13;
  return n;
}
// Four numbers 0..1.
vec4 hashBytes(uint n) {
  return vec4(float(n & 255u), float((n >> 8) & 255u), float((n >> 16) & 255u), float(n >> 24)) * (1.0 / 255.0);
}

// The outline of a stone: an ellipse with two pieces cut off straight, so no two look alike and
// each has a few flat faces. 'e' is the place in the stone's own axes, in radii. Returns 1 on the
// outline, less inside; 'og' points outward across it.
float stoneOutline(vec2 e, vec2 cuts, out vec2 og) {
  float m = length(e);
  og = e / max(m, 1e-4);
  float m1 = dot(e, vec2(0.5, 0.866)) / cuts.x;
  float m2 = dot(e, vec2(0.6, -0.8)) / cuts.y;
  if (m1 > m) { m = m1; og = vec2(0.5, 0.866) / cuts.x; }
  if (m2 > m) { m = m2; og = vec2(0.6, -0.8) / cuts.y; }
  return m;
}

// Stones of one size class: one to a lattice cell (in 'share' of the cells), anywhere in it,
// 0.03 to 0.12 cells in radius, a shade off the ground they lie on.
//
// A stone stands up. The mesh has no stones, so the ground behind one, as far as the stone would
// hide it from this camera, is drawn as the stone: its top where the outline lifted to the
// stone's height is seen (half the size: a stone narrows upward), its flank below that. Seen from
// above that is the outline alone; from the cockpit of a landed ship it is a stone some pixels
// high where a flat mark would be a line. 'eye' and 'sun' are the camera and the star as seen
// from the place (xy: along the ground toward it, z: cotangent of its height; with z 0 for the
// camera the stones lie flat). A stone casts its shadow away from the star. 'q' is the place on
// the lattice plane (m), 'px' the size of a pixel on the ground (m), along the view and across.
// Adds to the slope of the ground and multiplies its reflectance and the star's light.
//
// Stone and shadow reach half a cell at most, so the four cells nearest the place hold every
// stone that matters. Of those one is picked, roughly, and worked out: the one whose body covers
// the place, else the one whose body or shadow comes nearest.
void stoneLayer(vec2 q, float count, uint seed, float share, vec2 shade, vec3 sun, vec3 eye, vec2 px, float strength,
    inout vec2 slope, inout float tint, inout float light) {
  float cell = PERIOD / count;
  float reach = 0.5 * cell;
  vec2 p = q / cell;
  vec2 first = floor(p - 0.5);
  float nearest = 1e9;
  vec2 d = vec2(0.0);
  // Radius of the stone and the number 0..1 that is its own.
  vec2 what = vec2(0.0);
  uint bits = 0u;
  for (int j = 0; j < 4; j++) {
    vec2 c = first + vec2(float(j & 1), float(j >> 1));
    uint n = cellHash(mod(c, count), seed);
    vec4 a = hashBytes(n);
    float own = a.z / share;
    float r = own < 1.0 ? 0.03 * exp2(2.0 * a.w) * cell : 1e-6;
    vec2 dj = alongGround((p - c - a.xy) * cell);
    float tall = (0.45 + 0.65 * own) * r;
    // Metres of ground the stone hides behind itself, and how near the place is to that.
    float rise = min(tall * eye.z, reach - r);
    float lift = clamp(-dot(dj, eye.xy), 0.0, rise);
    float mb = length(dj + eye.xy * lift) / (r * (1.0 - 0.5 * lift / max(rise, 1e-4)));
    float len = min(max(tall * sun.z, 0.3 * r), reach - r);
    float along = clamp(-dot(dj, sun.xy), 0.0, len);
    float ms = length(dj + sun.xy * along) / (r * mix(0.85, 0.47, along / len));
    float key = mb < 1.0 ? mb - 4.0 : min(mb, ms);
    if (key < nearest) { nearest = key; d = dj; what = vec2(r, own); bits = n; }
  }
  if (nearest < 1.5) {
    float r = what.x;
    vec4 b = hashBytes(hashAgain(bits));
    float tall = (0.45 + 0.65 * what.y) * r;
    float rise = min(tall * eye.z, reach - r);
    float w = smoothstep(0.8, 2.5, r / px.y) * smoothstep(0.8, 2.5, (r + 0.5 * rise) / px.x) * strength;
    // The stone's own axes; it is up to 1.7 times as long as wide.
    vec2 ax = normalize(b.xy - 0.5 + 0.001);
    vec2 ay = vec2(-ax.y, ax.x);
    float narrow = 1.0 + 0.7 * b.z;
    vec2 cuts = 0.45 + 0.5 * vec2(b.w, fract((b.x + b.y) * 5.7));
    // 'up' is how high on the stone the view meets it.
    float lift = clamp(-dot(d, eye.xy), 0.0, rise);
    float up = lift / max(rise, 1e-4);
    vec2 dTop = d + eye.xy * rise;
    vec2 dSide = d + eye.xy * lift;
    vec2 og;
    float mTop = 2.0 * stoneOutline(vec2(dot(dTop, ax), dot(dTop, ay) * narrow) / r, cuts, og);
    vec2 lid = ax * og.x + ay * (og.y * narrow);
    // An edge is softened by a pixel, which along the view is more ground than across it.
    float soft = clamp(3.0 * mix(px.y, px.x, abs(dot(normalize(lid), eye.xy))) / r, 0.08, 0.6);
    float top = 1.0 - smoothstep(1.0 - soft, 1.0, mTop);
    vec2 og2;
    float mSide = stoneOutline(vec2(dot(dSide, ax), dot(dSide, ay) * narrow) / r, cuts, og2) / (1.0 - 0.5 * up);
    vec2 rim = normalize(ax * og2.x + ay * (og2.y * narrow));
    soft = clamp(1.5 * mix(px.y, px.x, abs(dot(rim, eye.xy))) / r, 0.08, 0.6);
    float body = 1.0 - smoothstep(1.0 - soft, 1.0, mSide);
    float side = body * (1.0 - top);
    // The top is a few faces leaning outward; the flank leans outward more, and where the view
    // meets it head on it faces the camera.
    slope -= lid * (0.4 * top * w);
    slope -= normalize(mix(eye.xy, rim, clamp(mSide, 0.0, 1.0)) + 1e-4) * (0.9 * side * w);
    tint *= mix(1.0, mix(shade.x, shade.y, what.y), w * body);
    // Darker toward the foot of the stone, and the ground darker around it: little light gets in there.
    tint *= 1.0 - 0.25 * w * side * (1.0 - smoothstep(0.0, 0.6, up)) * smoothstep(0.0, 0.3 * r, rise);
    float ring = length(d) / r;
    tint *= 1.0 - 0.22 * w * (1.0 - body) * smoothstep(0.75, 1.0, ring) * (1.0 - smoothstep(1.0, 1.45, ring));
    // The shadow: under a high star still a sliver, which is what sets a stone on the ground.
    float len = min(max(tall * sun.z, 0.3 * r), reach - r);
    float along = clamp(-dot(d, sun.xy), 0.0, len);
    float ms = length(d + sun.xy * along) / (r * mix(0.85, 0.47, along / len));
    float blur = max(1.1 * px.y / r, 0.09);
    light *= 1.0 - 0.92 * (1.0 - smoothstep(1.0 - blur, 1.0 + blur, ms)) * w * (1.0 - body);
  }
}

// Small craters of one size class: one to a lattice cell (in 'share' of the cells), rim radius
// 0.06 to 0.3 cells; a soft bowl with a low rounded rim, old ones shallow.
// Only the slope and the tone of the ground change: where the ground is does not. Of the four
// cells nearest the place only the crater the place lies deepest in is worked out, so where two
// overlap, a crease runs between them.
void craterLayer(vec2 q, float count, uint seed, float share, float deep, float px, float strength, inout vec2 slope, inout float tint) {
  float cell = PERIOD / count;
  vec2 p = q / cell;
  vec2 first = floor(p - 0.5);
  float nearest = 1e9;
  vec2 d = vec2(0.0);
  // Radius of the rim and the number 0..1 that is the crater's own.
  vec2 what = vec2(1.0, 0.0);
  for (int j = 0; j < 4; j++) {
    vec2 c = first + vec2(float(j & 1), float(j >> 1));
    vec4 a = hashBytes(cellHash(mod(c, count), seed));
    float own = a.z / share;
    float r = own < 1.0 ? 0.06 * exp2(2.32 * a.w) * cell : 1e-6;
    vec2 dj = alongGround((p - c - a.xy) * cell);
    float key = dot(dj, dj) / (r * r);
    if (key < nearest) { nearest = key; d = dj; what = vec2(r, own); }
  }
  // Beyond 1.6 radii nothing is left of a crater.
  if (nearest < 2.56) {
    float r = what.x;
    float own = what.y;
    float rho = sqrt(nearest);
    float w = smoothstep(1.0, 3.0, r / px) * strength;
    // The steepest slope of the wall: a fresh bowl a fifth as deep as wide, most far shallower.
    float wall = (0.22 + 0.63 * own * own) * deep;
    float inside = max(1.0 - rho * rho, 0.0);
    float t = clamp((rho - 1.0) / 0.6, 0.0, 1.0);
    float rise = rho < 1.0 ? rho * inside * 2.6 : -1.2 * t * (1.0 - t) * (1.0 - t);
    slope += d * (rise * wall * w / max(rho * r, 1e-5));
    // A fresh crater has thrown out brighter ground; dust darkens the floor of any.
    float fresh = smoothstep(0.55, 1.0, fract(own * 7.3)) * own;
    tint *= 1.0 + w * (0.16 * fresh * smoothstep(0.4, 1.0, rho) * (1.0 - t) - 0.07 * inside * inside * (0.4 + wall));
  }
}

void main() {
  vec4 own = texture2D(uMap, vUv * uUv.x + uUv.y);
  vec4 par = texture2D(uMapParent, vUv * uUvParent.x + uUvParent.yz);
  // Normals in the tile frame: a map holds x and z in the frame of its own tile, so the parent's
  // is turned into this tile's first. Between the largest tiles the two frames are degrees apart.
  vec3 nOwn = vec3(own.x, sqrt(max(1.0 - own.x * own.x - own.y * own.y, 0.0)), own.y);
  vec3 nPar = uFromParent * vec3(par.x, sqrt(max(1.0 - par.x * par.x - par.y * par.y, 0.0)), par.y);
  vec3 nl = normalize(mix(nOwn, nPar, vMorph));
  float tone = mix(own.z, par.z, vMorph);
  vec3 dirB = normalize(vDir);
  if (uRelief < 1.0) {
    vec4 far = textureCube(uFar, cubeWarp(dirB));
    nl = normalize(mix(normalize(dirB + far.xyz) * uToBody, nl, uRelief));
    tone = mix(far.w, tone, uRelief);
  }

  // What the terrain function does not have, by the size of a pixel on the ground: every size of
  // thing is shown while it is a few pixels and is gone before it could flicker. A pixel covers
  // more ground along the view than across it; 'px' is the longer side.
  vec3 stepX = dFdx(vDetail);
  vec3 stepY = dFdy(vDetail);
  vec2 pixel = vec2(length(stepX), length(stepY));
  float px = max(pixel.x, pixel.y);
  float tint = 1.0;
  float starlight = 1.0;
  if (uDetail > 0.0 && px < 27.0) {
    bool full = uDetail > 0.75;
    // The lattice plane of the cube face and the ground's lean against it.
    vec3 ab = abs(dirB);
    uint face = ab.x >= ab.y && ab.x >= ab.z ? 0u : ab.y >= ab.z ? 1u : 2u;
    vec3 upP = toPlane(dirB, face);
    vec2 lean = upP.xy / upP.z;
    // Metres to where the next face's lattice takes over: everything fades out toward that line.
    float edge = (abs(upP.z) - max(abs(upP.x), abs(upP.y))) * 0.7071 * uRadius;
    float lean2 = dot(lean, lean);
    float stretch = sqrt(1.0 + lean2);
    gLean = lean;
    gStretch = (stretch - 1.0) / max(lean2, 1e-8);
    vec2 home = toPlane(uOriginMod, face).xy;
    vec2 there = toPlane(vDetail, face).xy;
    vec2 q = home + there;

    vec2 slope = vec2(0.0);
    float mottle = 0.0;
    // Rolling ground and patches of tone: the grain texture laid out six times, its cells 6 cm,
    // 26 cm, 1 m, 4 m, 16 m and 64 m, every other one turned a quarter. The fine ones are rough,
    // the coarse ones no rougher than the terrain itself, and the two coarsest change the tone
    // alone. The texture's own smaller copies blur each as it shrinks; on top of that each is
    // gone when a cell is under a few pixels, counted by the mean of a pixel's two sides.
    vec2 turnX = toPlane(stepX, face).xy;
    vec2 turnY = toPlane(stepY, face).xy;
    float pxMean = sqrt(pixel.x * pixel.y);
    float coarser = 0.0;
    for (int i = (uDbg == 1.0 || uDbg == 4.0 ? -1 : 5); i >= (full ? 0 : 1); i--) {
      float count = i == 0 ? 1000.0 : i == 1 ? 250.0 : i == 2 ? 64.0 : i == 3 ? 16.0 : i == 4 ? 4.0 : 1.0;
      float scale = count / PERIOD;
      float cell = PERIOD / (count * ${GRAIN_CELLS}.0);
      float show = (1.0 - smoothstep(cell * 0.14, cell * 0.42, pxMean)) * clamp(edge / cell, 0.0, 1.0) * (i > 3 ? uLow : 1.0);
      float here = 0.0;
      if (show > 0.0) {
        vec2 uv = fract(home * scale) + there * scale;
        vec2 ux = turnX * scale;
        vec2 uy = turnY * scale;
        bool turned = (i & 1) == 1;
        if (turned) {
          uv = vec2(uv.y, -uv.x);
          ux = vec2(ux.y, -ux.x);
          uy = vec2(uy.y, -uy.x);
        }
        vec4 g = textureGrad(uGrain, uv + vec2(0.37, 0.61) * float(i), ux, uy) * 2.0 - 1.0;
        float rough = i == 0 ? 0.30 : i == 1 ? 0.17 : i == 2 ? 0.085 : i == 3 ? 0.04 : 0.0;
        float patchy = i == 0 ? 0.10 : i == 1 ? 0.08 : i == 2 ? 0.07 : i == 3 ? 0.06 : 0.05;
        slope += (turned ? vec2(-g.y, g.x) : g.xy) * (rough * show);
        mottle += g.z * (patchy * show);
        // Clods and the shadows between them: dark flecks while they are a few pixels, which is
        // what loose ground looks like at any distance. Nearer, the next finer cells have them.
        float fleck = smoothstep(0.25, 0.8, g.w + 0.5 * coarser) - 0.08;
        if (i < 4) mottle -= fleck * (0.2 * show * smoothstep(cell * 0.02, cell * 0.07, pxMean));
        here = g.z;
      }
      coarser = here;
    }

    // How much there is of what, by the kind of ground: ice has few blocks, brighter than the
    // dusty plain, and few pits; a desert is gravel with hardly a crater.
    float stones = uKind == 1 ? 0.4 : uKind == 2 ? 1.0 : 0.85;
    float craters = uKind == 1 ? 0.25 : uKind == 2 ? 0.2 : 0.5;
    vec2 shade = uKind == 1 ? vec2(1.0, 1.5) : uKind == 2 ? vec2(0.8, 1.35) : vec2(0.82, 1.55);
    // Craters of 2 to 10 m and of 0.5 to 2.4 m across.
    if (px < 4.8 && uDbg != 2.0 && uDbg != 4.0) {
      craterLayer(q, 256.0, face + 256u, craters, 0.6, px, uLow * clamp(edge / 16.0, 0.0, 1.0), slope, tint);
      if (px < 1.2) craterLayer(q, 1024.0, face + 272u, craters, 0.9, px, clamp(edge / 4.0, 0.0, 1.0), slope, tint);
    }
    vec2 px2 = vec2(px, min(pixel.x, pixel.y));
    if (px2.y < 0.64 && px < 1.97 && uDbg != 3.0 && uDbg != 4.0) {
      // The star and the camera as the place sees them, over the ground as it lies there.
      vec3 nlB = uToBody * nl;
      vec3 sunB = uToBody * (uSunView * normalMatrix);
      vec2 sunGround = alongGround(toPlane(sunB - dirB * dot(sunB, dirB), face).xy);
      float sunUp = dot(sunB, nlB);
      vec3 sun3 = vec3(sunGround / max(length(sunGround), 1e-5), sqrt(max(1.0 - sunUp * sunUp, 0.0)) / max(sunUp, 0.05));
      vec3 eyeB = uToBody * (normalize(-vView) * normalMatrix);
      vec2 eyeGround = alongGround(toPlane(eyeB - dirB * dot(eyeB, dirB), face).xy);
      float eyeUp = dot(eyeB, nlB);
      vec3 eye3 = vec3(eyeGround / max(length(eyeGround), 1e-5), sqrt(max(1.0 - eyeUp * eyeUp, 0.0)) / max(eyeUp, 0.02));
      float e4 = clamp(edge / 4.3, 0.0, 1.0);
      // Rocks of 13 to 50 cm, stones of 5 to 20 cm, and gravel of 1 to 5 cm, which lies flat.
      if (full) stoneLayer(q, 960.0, face + 352u, stones * 0.6, shade, sun3, eye3, px2, e4, slope, tint, starlight);
      if (px2.y < 0.256 && px < 0.79) {
        stoneLayer(q, 2400.0, face + 304u, stones, shade, sun3, eye3, px2, e4, slope, tint, starlight);
        if (full && px < 0.0615) stoneLayer(q, 10000.0, face + 320u, stones, shade, sun3, vec3(eye3.xy, 0.0), px2, e4, slope, tint, starlight);
      }
    }

    tint *= 1.0 + mottle * (uKind == 1 ? 0.7 : 1.0);
    // The slope along the ground, back in the lattice plane, then in body-fixed axes.
    vec2 sp = slope + lean * (dot(lean, slope) * (1.0 / stretch - 1.0) / max(lean2, 1e-8));
    vec3 sl = fromPlane(vec3(sp, -dot(lean, sp)), face) * uToBody;
    nl = normalize(nl - (sl - nl * dot(sl, nl)));
  }

  vec3 n = normalize(normalMatrix * nl);
  vec3 up = normalize(vUp);
  vec3 v = normalize(-vView);
  vec3 sun = uSunColor * starlight;
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      vec4 sc = vDirectionalShadowCoord[0];
      // Metres the point lies behind the far end of the shadow box, along the light.
      float behind = max(sc.z / sc.w - 1.0, 0.0) * vShadowBox.x;
      sc.z = min(sc.z, sc.w * 0.9995);
      DirectionalLightShadow ds = directionalLightShadows[0];
      float lit = getShadow(directionalShadowMap[0], ds.shadowMapSize, ds.shadowIntensity, ds.shadowBias, ds.shadowRadius, sc);
      // A caster the size of the box stops covering the sun's disc some seventy box widths on.
      float k = clamp(1.0 - behind / (70.0 * vShadowBox.y), 0.0, 1.0);
      sun *= mix(1.0, lit, k * k);
    }
  #endif
  vec3 albedo = groundAlbedo(clamp(tone, 0.0, 1.0), uBase, uKind) * tint;
  vec3 col = groundLit(albedo, n, up, uSunView, v, sun, uAmbient, uKind);

  // Lamps: plain diffuse light, wherever they stand.
  #if NUM_SPOT_LIGHTS > 0 || NUM_POINT_LIGHTS > 0
    IncidentLight lamp;
    vec3 lamps = vec3(0.0);
  #endif
  #if NUM_SPOT_LIGHTS > 0
    for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
      getSpotLightInfo(spotLights[i], vView, lamp);
      if (lamp.visible) lamps += lamp.color * max(dot(n, lamp.direction), 0.0);
    }
  #endif
  #if NUM_POINT_LIGHTS > 0
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
      // A light without falloff is the camera's fill light, which is not for the ground.
      if (pointLights[i].decay > 0.0) {
        getPointLightInfo(pointLights[i], vView, lamp);
        if (lamp.visible) lamps += lamp.color * max(dot(n, lamp.direction), 0.0);
      }
    }
  #endif
  #if NUM_SPOT_LIGHTS > 0 || NUM_POINT_LIGHTS > 0
    col += albedo * 0.3183098861837907 * lamps;
  #endif
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Uniforms every tile of a body shares: one object each, referenced by all tile materials. */
export interface GroundUniforms {
  uRadius: IUniform<number>;
  uRelief: IUniform<number>;
  uFar: IUniform<CubeTexture | null>;
  /** The grain texture (`grainTexture`); whoever made the uniforms disposes of it. */
  uGrain: IUniform<DataTexture>;
  uBase: IUniform<Vector3>;
  uKind: IUniform<number>;
  /** How much small detail the ground shows: 0 none, 0.5 the cheaper half of it, 1 all. */
  uDetail: IUniform<number>;
  /** 1 while the camera is low over the ground, 0 from 2 km up: for detail the view from high up does not have. */
  uLow: IUniform<number>;
  uDbg: IUniform<number>;
  /** Unit vector toward the star in view axes, and the star's and the ambient light's strength. */
  uSunView: IUniform<Vector3>;
  uSunColor: IUniform<Vector3>;
  uAmbient: IUniform<Vector3>;
}

export function groundUniforms(): GroundUniforms {
  return {
    uRadius: { value: 1 }, uRelief: { value: 1 }, uFar: { value: null }, uGrain: { value: grainTexture() }, uBase: { value: new Vector3(0.2, 0.2, 0.2) },
    uKind: { value: 0 }, uDetail: { value: 1 }, uLow: { value: 1 }, uDbg: { value: 0 },
    uSunView: { value: new Vector3(0, 1, 0) }, uSunColor: { value: new Vector3() }, uAmbient: { value: new Vector3() },
  };
}

/** A material for one tile. All of them compile to one program; only the uniforms differ. */
export function tileMaterial(shared: GroundUniforms): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      // Three fills these in from the lights of the scene: the shadow map, the lamps.
      ...UniformsUtils.clone(UniformsLib.lights),
      ...shared,
      uMap: { value: null }, uMapParent: { value: null },
      uUv: { value: new Vector2() }, uUvParent: { value: new Vector3() },
      uMorph: { value: new Vector3(0, 0, 0) },
      uToBody: { value: new Matrix3() }, uFromParent: { value: new Matrix3() }, uOriginMod: { value: new Vector3() },
    },
    lights: true,
    side: FrontSide,
  });
}

/** The texture of a baked tile map: half floats, with mip levels so that slanted ground does not flicker. */
export function mapTexture(data: Uint16Array, size: number, anisotropy: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, HalfFloatType);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
