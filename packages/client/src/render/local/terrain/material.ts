/**
 * The material of a ground tile. It is lit by the local scene's own lights (the sun and ambient
 * light the `objects` part adds; their uniforms and shadow map come from three's light system)
 * through the ground's shading in `shade.ts`, not through three's standard surface model.
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
 * - Small relief the terrain function does not have (below its 10 m): lattice noise on the
 *   body-fixed position, each octave only while it is larger than a few pixels.
 * - The shadow of ships and structures: the shadow box around the ship ends a little behind it,
 *   so the ground takes its depth in the box as no farther than the box's end.
 */
import {
  ClampToEdgeWrapping, DataTexture, FrontSide, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix3, RGBAFormat,
  ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3,
} from 'three';
import type { CubeTexture, IUniform } from 'three';
import { GROUND_GLSL } from './shade.ts';

/** The detail noise repeats after this many metres along each body-fixed axis; a power of two. */
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
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  #include <shadowmap_vertex>
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
${GROUND_GLSL}

float latticeHash(ivec3 p) {
  uvec3 q = uvec3(p) * uvec3(1597334673u, 3812015801u, 2798796415u);
  uint n = (q.x ^ q.y ^ q.z) * 1597334673u;
  n ^= n >> 15;
  n *= 2246822519u;
  n ^= n >> 13;
  return float(n >> 8) * (1.0 / 16777216.0);
}

// Value noise in -1..1 with its gradient (xyz gradient, w value). The lattice repeats after
// 'wrap' cells (a power of two), so the noise is continuous where its coordinates start over.
vec4 latticeNoise(vec3 x, int wrap) {
  vec3 pf = floor(x);
  vec3 w = x - pf;
  ivec3 p0 = ivec3(pf) & (wrap - 1);
  ivec3 p1 = (p0 + 1) & (wrap - 1);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = latticeHash(p0);
  float b = latticeHash(ivec3(p1.x, p0.y, p0.z));
  float c = latticeHash(ivec3(p0.x, p1.y, p0.z));
  float d = latticeHash(ivec3(p1.x, p1.y, p0.z));
  float e = latticeHash(ivec3(p0.x, p0.y, p1.z));
  float f = latticeHash(ivec3(p1.x, p0.y, p1.z));
  float g = latticeHash(ivec3(p0.x, p1.y, p1.z));
  float h = latticeHash(p1);
  float k1 = b - a, k2 = c - a, k3 = e - a;
  float k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f;
  float k7 = -a + b + c - d + e - f - g + h;
  float v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 grad = du * vec3(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(grad * 2.0, v * 2.0 - 1.0);
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

  // Small relief, by the size of a pixel on the ground: an octave is shown while its cells are
  // a few pixels wide and is gone before they could flicker.
  float px = max(length(dFdx(vDetail)), length(dFdy(vDetail)));
  if (uDetail > 0.0 && px < 3.2) {
    vec3 slope = vec3(0.0);
    float speck = 0.0;
    float cell = 8.0;
    for (int i = 0; i < 4; i++) {
      float show = 1.0 - smoothstep(cell * 0.12, cell * 0.4, px);
      if (show > 0.0) {
        vec4 nz = latticeNoise(vDetail / cell, int(${DETAIL_PERIOD}.0 / cell));
        slope += nz.xyz * show;
        speck += nz.w * show;
      }
      cell *= 0.25;
    }
    vec3 sl = (slope * uToBody) * (0.055 * uDetail);
    nl = normalize(nl - (sl - nl * dot(sl, nl)));
    tone += speck * 0.012 * uDetail;
  }

  vec3 n = normalize(normalMatrix * nl);
  vec3 up = normalize(vUp);
  vec3 v = normalize(-vView);
  #if NUM_DIR_LIGHTS > 0
    vec3 l = directionalLights[0].direction;
    vec3 sun = directionalLights[0].color;
    vec3 ambient = ambientLightColor;
  #else
    vec3 l = uSunView;
    vec3 sun = uSunColor;
    vec3 ambient = uAmbient;
  #endif
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      vec4 sc = vDirectionalShadowCoord[0];
      sc.z = min(sc.z, sc.w * 0.9995);
      DirectionalLightShadow ds = directionalLightShadows[0];
      sun *= getShadow(directionalShadowMap[0], ds.shadowMapSize, ds.shadowIntensity, ds.shadowBias, ds.shadowRadius, sc);
    }
  #endif
  gl_FragColor = vec4(groundLit(groundAlbedo(clamp(tone, 0.0, 1.0), uBase, uKind), n, up, l, v, sun, ambient, uKind), 1.0);
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
  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
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
  return material;
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
