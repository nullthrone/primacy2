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
 * - Normal and tone from the tile's map, blended toward the parent's map by the same amount the
 *   vertices moved, and toward the far map by `uRelief`.
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
uniform float uRelief;
uniform vec3 uBase;
uniform int uKind;
uniform float uDetail;
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

// A vector with components in -1..1 for a lattice point.
vec3 latticeGradient(vec3 p) {
  uvec3 q = uvec3(ivec3(p)) * uvec3(1597334673u, 3812015801u, 2798796415u);
  uint n = (q.x ^ q.y ^ q.z) * 1597334673u;
  n ^= n >> 15;
  n *= 2246822519u;
  n ^= n >> 13;
  return vec3(float(n & 1023u), float((n >> 10) & 1023u), float((n >> 20) & 1023u)) * (2.0 / 1023.0) - 1.0;
}

// Gradient noise with its derivative (xyz) and value (w). The lattice starts over after 'wrap'
// cells along each axis, so the noise is continuous where its coordinates do.
vec4 detailNoise(vec3 x, float wrap) {
  vec3 p = floor(x);
  vec3 w = x - p;
  vec3 p0 = mod(p, wrap);
  vec3 p1 = mod(p + 1.0, wrap);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  vec3 ga = latticeGradient(p0);
  vec3 gb = latticeGradient(vec3(p1.x, p0.y, p0.z));
  vec3 gc = latticeGradient(vec3(p0.x, p1.y, p0.z));
  vec3 gd = latticeGradient(vec3(p1.x, p1.y, p0.z));
  vec3 ge = latticeGradient(vec3(p0.x, p0.y, p1.z));
  vec3 gf = latticeGradient(vec3(p1.x, p0.y, p1.z));
  vec3 gg = latticeGradient(vec3(p0.x, p1.y, p1.z));
  vec3 gh = latticeGradient(p1);
  float va = dot(ga, w);
  float vb = dot(gb, w - vec3(1.0, 0.0, 0.0));
  float vc = dot(gc, w - vec3(0.0, 1.0, 0.0));
  float vd = dot(gd, w - vec3(1.0, 1.0, 0.0));
  float ve = dot(ge, w - vec3(0.0, 0.0, 1.0));
  float vf = dot(gf, w - vec3(1.0, 0.0, 1.0));
  float vg = dot(gg, w - vec3(0.0, 1.0, 1.0));
  float vh = dot(gh, w - vec3(1.0, 1.0, 1.0));
  float kxy = va - vb - vc + vd, kyz = va - vc - ve + vg, kzx = va - vb - ve + vf;
  float kxyz = -va + vb + vc - vd + ve - vf - vg + vh;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va)
    + u.x * u.y * kxy + u.y * u.z * kyz + u.z * u.x * kzx + u.x * u.y * u.z * kxyz;
  vec3 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga)
    + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf)
    + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh)
    + du * (vec3(vb, vc, ve) - va + u.yzx * vec3(kxy, kyz, kzx) + u.zxy * vec3(kzx, kxy, kyz) + u.yzx * u.zxy * kxyz);
  return vec4(g, v);
}

void main() {
  vec4 own = texture2D(uMap, vUv * uUv.x + uUv.y);
  vec4 par = texture2D(uMapParent, vUv * uUvParent.x + uUvParent.yz);
  vec4 t = mix(own, par, vMorph);
  // Normal in the tile frame: the map holds x and z.
  vec3 nl = vec3(t.x, sqrt(max(1.0 - t.x * t.x - t.y * t.y, 0.0)), t.y);
  float tone = t.z;
  vec3 dirB = normalize(vDir);
  if (uRelief < 1.0) {
    vec4 far = textureCube(uFar, cubeWarp(dirB));
    nl = normalize(mix(normalize(dirB + far.xyz) * uToBody, nl, uRelief));
    tone = mix(far.w, tone, uRelief);
  }

  // Small relief, by the size of a pixel on the ground: an octave is shown while its bumps are
  // a few pixels wide and is gone before they could flicker.
  float px = max(length(dFdx(vDetail)), length(dFdy(vDetail)));
  if (uDetail > 0.0 && px < 2.2) {
    vec3 slope = vec3(0.0);
    float speck = 0.0;
    // Cells of 5.3 m, 1.6 m, 0.5 m and 0.16 m: none a whole multiple of the next.
    vec4 cells = vec4(${DETAIL_PERIOD}.0 / 768.0, ${DETAIL_PERIOD}.0 / 2560.0, ${DETAIL_PERIOD}.0 / 8192.0, ${DETAIL_PERIOD}.0 / 25600.0);
    vec4 counts = vec4(768.0, 2560.0, 8192.0, 25600.0);
    for (int i = 0; i < 4; i++) {
      float cell = cells[i];
      float show = 1.0 - smoothstep(cell * 0.14, cell * 0.42, px);
      if (show > 0.0) {
        vec4 nz = detailNoise(vDetail / cell + vec3(0.37, 0.11, 0.73) * float(i), counts[i]);
        slope += nz.xyz * show;
        speck += nz.w * show;
      }
    }
    vec3 sl = (slope * uToBody) * (0.085 * uDetail);
    nl = normalize(nl - (sl - nl * dot(sl, nl)));
    tone += speck * 0.02 * uDetail;
  }

  vec3 n = normalize(normalMatrix * nl);
  vec3 up = normalize(vUp);
  vec3 v = normalize(-vView);
  vec3 sun = uSunColor;
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
  vec3 albedo = groundAlbedo(clamp(tone, 0.0, 1.0), uBase, uKind);
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
  uDetail: IUniform<number>;
  /** Unit vector toward the star in view axes, and the star's and the ambient light's strength. */
  uSunView: IUniform<Vector3>;
  uSunColor: IUniform<Vector3>;
  uAmbient: IUniform<Vector3>;
}

export function groundUniforms(): GroundUniforms {
  return {
    uRadius: { value: 1 }, uRelief: { value: 1 }, uFar: { value: null }, uBase: { value: new Vector3(0.2, 0.2, 0.2) },
    uKind: { value: 0 }, uDetail: { value: 1 },
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
      uToBody: { value: new Matrix3() }, uOriginMod: { value: new Vector3() },
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
