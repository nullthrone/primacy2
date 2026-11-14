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
 * - Small relief the terrain function does not have (below its 10 m): gradient noise on the
 *   body-fixed position, each octave only while its bumps are larger than a few pixels. It bends
 *   the shading normal and nothing else; the ground a ship stands on is the mesh.
 */
import {
  ClampToEdgeWrapping, DataTexture, FrontSide, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix3, RGBAFormat,
  ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3,
} from 'three';
import type { CubeTexture, IUniform } from 'three';
import { GROUND_GLSL } from './shade.ts';

/**
 * The detail noise repeats after this many metres along each body-fixed axis, so that it can be
 * computed from small numbers (a tile's origin is reduced by it) and still meets itself across
 * tile edges. Every octave's cell divides it.
 */
export const DETAIL_PERIOD = 4096;

const VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
attribute vec3 aCoarse;
attribute vec2 aH;
uniform vec3 uMorph;
uniform float uRadius;
uniform float uRelief;
uniform mat3 uToBody;
uniform vec3 uOriginMod;
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
  vDetail = uOriginMod + uToBody * transformed;
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
// Small ground detail. All of it lives on square lattices in the plane of the cube face the
// place belongs to (two of the three body-fixed coordinates), so a lattice point is four numbers
// to look up instead of eight; every lattice repeats after DETAIL_PERIOD metres.
// ---------------------------------------------------------------------------------------------

const float PERIOD = ${DETAIL_PERIOD}.0;

// How an offset in the plane of the lattice (metres) becomes an offset along the ground: the
// plane leans against the ground by up to 55 degrees, and what is round on the ground must be
// measured there. Set in main for the place being shaded.
vec2 gLean;
float gStretch;
vec2 alongGround(vec2 d) { return d + gLean * (dot(gLean, d) * gStretch); }

// Random bits for a lattice cell of one layer.
uint cellHash(vec2 cell, uint seed) {
  uvec2 q = uvec2(ivec2(cell)) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y ^ (seed * 2798796415u)) * 1597334673u;
  n ^= n >> 15;
  n *= 2246822519u;
  n ^= n >> 13;
  n *= 3266489917u;
  n ^= n >> 16;
  return n;
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

// Gradient noise in the plane with its derivative (xy) and value (z). The lattice starts over
// after 'wrap' cells along each axis, so the noise is continuous where its coordinates are.
vec3 planeNoise(vec2 x, float wrap, uint seed) {
  vec2 p = floor(x);
  vec2 w = x - p;
  vec2 p0 = mod(p, wrap);
  vec2 p1 = mod(p + 1.0, wrap);
  vec2 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  vec2 ga = hashBytes(cellHash(p0, seed)).xy * 2.0 - 1.0;
  vec2 gb = hashBytes(cellHash(vec2(p1.x, p0.y), seed)).xy * 2.0 - 1.0;
  vec2 gc = hashBytes(cellHash(vec2(p0.x, p1.y), seed)).xy * 2.0 - 1.0;
  vec2 gd = hashBytes(cellHash(p1, seed)).xy * 2.0 - 1.0;
  float va = dot(ga, w);
  float vb = dot(gb, w - vec2(1.0, 0.0));
  float vc = dot(gc, w - vec2(0.0, 1.0));
  float vd = dot(gd, w - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
    + du * (vec2(vb, vc) - va + u.yx * k);
  return vec3(g, v);
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
// 0.05 to 0.2 cells in radius, most of them small, a shade off the ground they lie on.
//
// A stone stands up. The mesh has no stones, so the ground behind one, as far as the stone would
// hide it from this camera, is drawn as the stone: its top where the outline lifted to the
// stone's height is seen, its side below that. Seen from above that is the outline alone; from
// the cockpit of a landed ship it is a stone a few pixels high where a flat mark would be a line.
// 'eye' and 'sun' are the camera and the star as seen from the place (xy: along the ground toward
// it, z: cotangent of its height); a stone casts its shadow away from the star. 'q' is the place
// on the lattice plane (m), 'px' the size of a pixel on the ground (m), along the view and across.
// Adds to the slope of the ground and multiplies its reflectance and the star's light.
void stoneLayer(vec2 q, float count, uint seed, float share, vec2 shade, vec3 sun, vec3 eye, vec2 px, float strength,
    inout vec2 slope, inout float tint, inout float light) {
  float cell = PERIOD / count;
  if (strength <= 0.0 || 0.2 * cell < 0.8 * px.y || 0.7 * cell < 0.8 * px.x) return;
  vec2 p = q / cell;
  vec2 first = floor(p) - 1.0;
  // Stone and shadow reach one cell at most, so the nine cells around the place hold all of them.
  for (int j = 0; j < 9; j++) {
    vec2 c = first + vec2(float(j % 3), float(j / 3));
    uint n = cellHash(mod(c, count), seed);
    vec4 a = hashBytes(n);
    if (a.z >= share) continue;
    vec2 d = alongGround((p - c - a.xy) * cell);
    if (dot(d, d) > cell * cell) continue;
    float r = (0.05 + 0.15 * a.w * a.w * a.w) * cell;
    vec4 b = hashBytes(hashAgain(n));
    float tall = (0.45 + 0.65 * b.w) * r;
    // Metres of ground the stone hides behind itself.
    float rise = min(tall * eye.z, cell - r);
    float w = smoothstep(0.8, 2.5, r / px.y) * smoothstep(0.8, 2.5, (r + 0.5 * rise) / px.x) * strength;
    if (w <= 0.0) continue;
    // The stone's own axes; it is up to 1.7 times as long as wide.
    vec2 ax = normalize(b.xy - 0.5 + 0.001);
    vec2 ay = vec2(-ax.y, ax.x);
    float narrow = 1.0 + 0.7 * b.z;
    vec2 cuts = 0.45 + 0.5 * vec2(b.w, fract((b.x + b.y) * 5.7));
    // The stone narrows to half its outline at the top. 'up' is how high on it the view meets it.
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
    slope -= normalize(mix(eye.xy, rim, clamp(mSide, 0.0, 1.0)) + 1e-4) * (1.15 * side * w);
    tint *= mix(1.0, mix(shade.x, shade.y, a.z / share), w * body);
    // Darker toward the foot of the stone, and the ground darker around it: little light gets in there.
    tint *= 1.0 - 0.25 * w * side * (1.0 - smoothstep(0.0, 0.6, up)) * smoothstep(0.0, 0.3 * r, rise);
    float ring = length(d) / r;
    tint *= 1.0 - 0.22 * w * (1.0 - body) * smoothstep(0.75, 1.0, ring) * (1.0 - smoothstep(1.0, 1.45, ring));
    // Under a high star still a sliver of shadow, which is what sets a stone on the ground.
    float len = min(max(tall * sun.z, 0.3 * r), cell - r);
    float along = clamp(-dot(d, sun.xy), 0.0, len);
    float wide = r * (0.5 + 0.42 / narrow) * mix(1.0, 0.55, along / len);
    float blur = max(0.75 * px.y, 0.06 * r);
    float dark = (1.0 - smoothstep(wide - blur, wide + blur, length(d + sun.xy * along))) * (1.0 - body);
    light *= 1.0 - dark * w;
  }
}

// Gravel: the same stones where they are too small to stand up on screen, or where the full
// stones would cost too much: flat marks, four cells looked at instead of nine. With 'shadows'
// they cast short ones (0.6 cells at most), and the four cells lie toward the star.
void gravelLayer(vec2 q, float count, uint seed, float share, vec2 shade, vec3 sun, vec2 sunPlane, float px, float strength, bool shadows,
    inout vec2 slope, inout float tint, inout float light) {
  float cell = PERIOD / count;
  if (strength <= 0.0 || 0.2 * cell < 0.8 * px) return;
  vec2 p = q / cell;
  vec2 first = floor(p - 0.5 + (shadows ? sunPlane * 0.3 : vec2(0.0)));
  for (int j = 0; j < 4; j++) {
    vec2 c = first + vec2(float(j & 1), float(j >> 1));
    uint n = cellHash(mod(c, count), seed);
    vec4 a = hashBytes(n);
    if (a.z >= share) continue;
    float r = (0.05 + 0.15 * a.w * a.w * a.w) * cell;
    float w = smoothstep(0.8, 2.5, r / px) * strength;
    if (w <= 0.0) continue;
    vec2 d = alongGround((p - c - a.xy) * cell);
    float reach = shadows ? 0.6 * cell + r : 1.5 * r;
    if (dot(d, d) > reach * reach) continue;
    vec4 b = hashBytes(hashAgain(n));
    vec2 ax = normalize(b.xy - 0.5 + 0.001);
    vec2 ay = vec2(-ax.y, ax.x);
    float narrow = 1.0 + 0.7 * b.z;
    vec2 og;
    float m = stoneOutline(vec2(dot(d, ax), dot(d, ay) * narrow) / r, 0.45 + 0.5 * vec2(b.w, fract((b.x + b.y) * 5.7)), og);
    float body = 1.0 - smoothstep(1.0 - clamp(1.5 * px / r, 0.08, 0.6), 1.0, m);
    slope -= (ax * og.x + ay * (og.y * narrow)) * (0.6 * body * w);
    tint *= mix(1.0, mix(shade.x, shade.y, a.z / share), w * body);
    tint *= 1.0 - 0.22 * w * (1.0 - body) * smoothstep(0.75, 1.0, m) * (1.0 - smoothstep(1.0, 1.45, m));
    if (shadows) {
      float len = min(max((0.7 + 0.8 * b.w) * r * sun.z, 0.3 * r), 0.6 * cell);
      float along = clamp(-dot(d, sun.xy), 0.0, len);
      float wide = r * (0.5 + 0.42 / narrow) * mix(1.0, 0.55, along / len);
      float blur = max(0.75 * px, 0.06 * r);
      light *= 1.0 - (1.0 - smoothstep(wide - blur, wide + blur, length(d + sun.xy * along))) * (1.0 - body) * w;
    }
  }
}

// Small craters of one size class: one to a lattice cell (in 'share' of the cells), rim radius
// 0.09 to 0.3 cells, most of them small; a soft bowl with a low rounded rim, old ones shallow.
// Only the slope and the tone of the ground change: where the ground is does not.
void craterLayer(vec2 q, float count, uint seed, float share, float deep, float px, float strength, inout vec2 slope, inout float tint) {
  float cell = PERIOD / count;
  if (strength <= 0.0 || 0.3 * cell < px) return;
  vec2 p = q / cell;
  vec2 first = floor(p - 0.5);
  for (int j = 0; j < 4; j++) {
    vec2 c = first + vec2(float(j & 1), float(j >> 1));
    uint n = cellHash(mod(c, count), seed);
    vec4 a = hashBytes(n);
    if (a.z >= share) continue;
    float r = (0.09 + 0.21 * a.w * a.w) * cell;
    float w = smoothstep(1.0, 3.0, r / px) * strength;
    if (w <= 0.0) continue;
    vec2 d = alongGround((p - c - a.xy) * cell);
    float rho = length(d) / r;
    if (rho >= 1.6) continue;
    vec4 b = hashBytes(hashAgain(n));
    // The steepest slope of the wall: a fresh bowl a fifth as deep as wide, most far shallower.
    float wall = (0.22 + 0.63 * b.x * b.x) * deep;
    float inside = max(1.0 - rho * rho, 0.0);
    float t = clamp((rho - 1.0) / 0.6, 0.0, 1.0);
    float rise = rho < 1.0 ? rho * inside * 2.6 : -1.2 * t * (1.0 - t) * (1.0 - t);
    slope += d * (rise * wall * w / max(rho * r, 1e-5));
    // A fresh crater has thrown out brighter ground; dust darkens the floor of any.
    float fresh = smoothstep(0.55, 1.0, b.y) * b.x;
    tint *= 1.0 + w * (0.16 * fresh * smoothstep(0.4, 1.0, rho) * (1.0 - t) - 0.10 * inside * inside * (0.4 + wall));
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

  // What the terrain function does not have, by the size of a pixel on the ground (its longer
  // side: slanted ground is squeezed on screen): every size of thing is shown while it is a few
  // pixels and is gone before it could flicker.
  vec2 pixel = vec2(length(dFdx(vView)), length(dFdy(vView)));
  float px = max(pixel.x, pixel.y);
  float tint = 1.0;
  float starlight = 1.0;
  if (uDetail > 0.0 && px < 21.0) {
    bool full = uDetail > 0.75;
    // The lattice plane of the cube face, the ground's lean against it, and the star along the ground.
    vec3 ab = abs(dirB);
    vec3 sunB = uToBody * (uSunView * normalMatrix);
    vec3 sunFlat = sunB - dirB * dot(sunB, dirB);
    vec3 eyeB = uToBody * (normalize(-vView) * normalMatrix);
    vec3 eyeFlat = eyeB - dirB * dot(eyeB, dirB);
    vec2 q;
    vec2 lean;
    vec2 sunPlane;
    vec2 eyePlane;
    float edge;
    uint face;
    if (ab.x >= ab.y && ab.x >= ab.z) {
      q = vDetail.yz; lean = dirB.yz / dirB.x; sunPlane = sunFlat.yz; eyePlane = eyeFlat.yz; edge = ab.x - max(ab.y, ab.z); face = 0u;
    } else if (ab.y >= ab.z) {
      q = vDetail.zx; lean = dirB.zx / dirB.y; sunPlane = sunFlat.zx; eyePlane = eyeFlat.zx; edge = ab.y - max(ab.z, ab.x); face = 1u;
    } else {
      q = vDetail.xy; lean = dirB.xy / dirB.z; sunPlane = sunFlat.xy; eyePlane = eyeFlat.xy; edge = ab.z - max(ab.x, ab.y); face = 2u;
    }
    // Metres to where the next face's lattice takes over: everything fades out toward that line.
    edge *= 0.7071 * uRadius;
    float lean2 = dot(lean, lean);
    float stretch = sqrt(1.0 + lean2);
    gLean = lean;
    gStretch = (stretch - 1.0) / max(lean2, 1e-8);
    vec2 sunGround = alongGround(sunPlane);
    float sunLength = max(length(sunGround), 1e-5);
    vec3 nlB = uToBody * nl;
    float sunUp = dot(sunB, nlB);
    vec3 sun3 = vec3(sunGround / sunLength, sqrt(max(1.0 - sunUp * sunUp, 0.0)) / max(sunUp, 0.05));
    sunPlane /= sunLength;
    vec2 eyeGround = alongGround(eyePlane);
    float eyeLength = max(length(eyeGround), 1e-5);
    float eyeUp = dot(eyeB, nlB);
    vec3 eye3 = vec3(eyeGround / eyeLength, sqrt(max(1.0 - eyeUp * eyeUp, 0.0)) / max(eyeUp, 0.02));
    vec2 px2 = vec2(px, min(pixel.x, pixel.y));

    vec2 slope = vec2(0.0);
    float mottle = 0.0;
    // Rolling ground and patches of tone: cells of 5 cm, 16 cm, 0.5 m, 1.6 m, 5.3 m, 16 m and
    // 51 m, none a whole multiple of the next. The fine ones are rough, the coarse ones no rougher
    // than the terrain itself, and the two coarsest change the tone alone.
    for (int i = full ? 0 : 1; i < 7; i++) {
      float count = i == 0 ? 81920.0 : i == 1 ? 25600.0 : i == 2 ? 8192.0 : i == 3 ? 2560.0 : i == 4 ? 768.0 : i == 5 ? 256.0 : 80.0;
      float cell = PERIOD / count;
      float show = (1.0 - smoothstep(cell * 0.14, cell * 0.42, px)) * clamp(edge / cell, 0.0, 1.0);
      if (i > 4) show *= uLow;
      if (show > 0.0) {
        vec3 nz = planeNoise(q / cell + vec2(0.37, 0.73) * float(i), count, face + 16u * uint(i + 1));
        float rough = i == 0 ? 0.14 : i == 1 ? 0.085 : i == 2 ? 0.042 : i == 3 ? 0.026 : i == 4 ? 0.016 : 0.0;
        float patchy = i == 0 ? 0.11 : i == 1 ? 0.07 : i == 2 ? 0.055 : i == 3 ? 0.05 : 0.045;
        slope += nz.xy * (rough * show);
        mottle += nz.z * (patchy * show);
        // Clods and the shadows between them: dark flecks while they are a few pixels, which is
        // what loose ground looks like at any distance. Nearer, the next finer cells have them.
        float fleck = smoothstep(0.2, 0.4, nz.z) - 0.11;
        if (i < 5) mottle -= fleck * (0.2 * show * smoothstep(cell * 0.02, cell * 0.07, px));
      }
    }

    // How much there is of what, by the kind of ground: ice has few blocks, brighter than the
    // dusty plain, and few pits; a desert is gravel with hardly a crater.
    float stones = uKind == 1 ? 0.22 : uKind == 2 ? 0.6 : 0.42;
    float craters = uKind == 1 ? 0.3 : uKind == 2 ? 0.22 : 0.62;
    vec2 shade = uKind == 1 ? vec2(0.95, 1.45) : uKind == 2 ? vec2(0.72, 1.25) : vec2(0.68, 1.42);
    float e16 = clamp(edge / 16.0, 0.0, 1.0);
    float e5 = clamp(edge / 5.12, 0.0, 1.0);
    float e1 = clamp(edge / 1.6, 0.0, 1.0);
    craterLayer(q, 256.0, face + 256u, craters, 0.6, px, uLow * e16, slope, tint);
    craterLayer(q, 800.0, face + 272u, craters, 0.85, px, e5, slope, tint);
    craterLayer(q, 2560.0, face + 288u, craters, 1.0, px, e1, slope, tint);
    if (full) {
      stoneLayer(q, 4000.0, face + 304u, stones, shade, sun3, eye3, px2, e1, slope, tint, starlight);
      stoneLayer(q, 12800.0, face + 320u, stones, shade, sun3, eye3, px2, e1, slope, tint, starlight);
      gravelLayer(q, 40000.0, face + 336u, stones, shade, sun3, sunPlane, px, e1, true, slope, tint, starlight);
    } else {
      gravelLayer(q, 4000.0, face + 304u, stones, shade, sun3, sunPlane, px, e1, false, slope, tint, starlight);
      gravelLayer(q, 12800.0, face + 320u, stones, shade, sun3, sunPlane, px, e1, false, slope, tint, starlight);
    }

    tint *= 1.0 + mottle * (uKind == 1 ? 0.7 : 1.0);
    // The slope along the ground, back in the lattice plane, then in body-fixed axes.
    vec2 sp = slope + lean * (dot(lean, slope) * (1.0 / stretch - 1.0) / max(lean2, 1e-8));
    vec3 s3 = vec3(sp, -dot(lean, sp));
    vec3 sl = (face == 0u ? s3.zxy : face == 1u ? s3.yzx : s3) * uToBody;
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
  uBase: IUniform<Vector3>;
  uKind: IUniform<number>;
  /** How much small detail the ground shows: 0 none, 0.5 the cheaper half of it, 1 all. */
  uDetail: IUniform<number>;
  /** 1 while the camera is low over the ground, 0 from 2 km up: for detail the view from high up does not have. */
  uLow: IUniform<number>;
  /** Unit vector toward the star in view axes, and the star's and the ambient light's strength. */
  uSunView: IUniform<Vector3>;
  uSunColor: IUniform<Vector3>;
  uAmbient: IUniform<Vector3>;
}

export function groundUniforms(): GroundUniforms {
  return {
    uRadius: { value: 1 }, uRelief: { value: 1 }, uFar: { value: null }, uBase: { value: new Vector3(0.2, 0.2, 0.2) },
    uKind: { value: 0 }, uDetail: { value: 1 }, uLow: { value: 1 },
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
