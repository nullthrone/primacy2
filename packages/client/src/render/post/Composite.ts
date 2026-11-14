import { NoBlending, ShaderMaterial, Vector2 } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import type { FrameFx } from '../../contracts.ts';
import { FULLSCREEN_VERT, type FullscreenPass } from './fullscreen.ts';

// Final pass: screen-space flight effects, bloom, filmic tone mapping, sRGB encoding and dither.
// Everything here lies over the finished frame, the cockpit included. What belongs behind the
// cockpit and behind other objects (the streaks of cruise flight) is drawn earlier, see Cruise.ts.
const FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform float uDepthDebug;
uniform vec2 uRes;
uniform float uTime;
uniform float uBloom;
uniform float uCharge;
uniform float uChargeKind;
uniform float uFold;
uniform float uDilation;
uniform float uHeat;
uniform float uHit;
varying vec2 vUv;

float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float n3(vec3 p) {
  float iz = floor(p.z), fz = fract(p.z);
  fz = fz * fz * (3.0 - 2.0 * fz);
  // The slice index wraps so the offsets stay small and float32 keeps its precision.
  return mix(n2(p.xy + mod(iz, 61.0) * 37.7), n2(p.xy + mod(iz + 1.0, 61.0) * 37.7), fz);
}

// ACES filmic curve (Stephen Hill's fit).
vec3 aces(vec3 x) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = inM * (x / 0.6);
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0.0, 1.0);
}

vec3 sceneAt(vec2 uv) { return texture2D(tScene, clamp(uv, 0.0005, 0.9995)).rgb; }

// Fold tunnel: streaked walls flowing past the viewer toward a bright exit point.
vec3 tunnel(vec2 pc, float rad, float t) {
  float a = atan(pc.y, pc.x);
  // Depth along the tunnel: the centre of the screen is far ahead.
  float z = 0.5 / (rad + 0.06);
  float tw = a + z * 0.35 + t * 0.10;
  vec2 cs = vec2(cos(tw), sin(tw));
  float flow = z + t * 2.2;
  // Cloudy walls, stretched along the tunnel, with thin bright filaments.
  float c1 = n3(vec3(cs * 1.6, flow * 0.8));
  float c2 = n3(vec3(cs * 4.5 + 5.0, flow * 1.9));
  float clouds = c1 * 0.65 + c2 * 0.35;
  float f1 = n3(vec3(cs * 13.0 - 3.0, flow * 0.5));
  float f2 = n3(vec3(cs * 37.0 + 9.0, flow * 0.3));
  float fil = smoothstep(0.72, 0.95, f1) * 0.8 + smoothstep(0.80, 0.97, f2) * 1.2;
  vec3 deep = vec3(0.012, 0.02, 0.10);
  vec3 blue = vec3(0.08, 0.20, 0.85);
  vec3 violet = vec3(0.42, 0.12, 0.85);
  vec3 col = mix(deep, mix(blue, violet, c2), smoothstep(0.35, 0.8, clouds)) * (0.25 + 0.9 * clouds);
  col += vec3(0.55, 0.75, 1.5) * fil * (0.4 + 0.6 * clouds);
  // Rings of light rushing past.
  float ring = pow(0.5 + 0.5 * sin(z * 7.0 + t * 9.0), 24.0);
  col += vec3(0.35, 0.5, 1.3) * ring * 0.6 * smoothstep(0.05, 0.4, rad);
  // Fog toward the far end, then the light of the exit.
  float wall = smoothstep(0.0, 0.45, rad);
  col *= 0.08 + 0.92 * wall * wall;
  col += vec3(0.75, 0.88, 1.4) * 0.006 / (rad * rad + 0.002);
  return col;
}

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  vec2 pc = vec2(c.x * uRes.x / uRes.y, c.y);
  float rad = length(pc);

  // Heat haze: the image shimmers once heat passes about 80 percent of capacity.
  float haze = smoothstep(0.8, 1.2, uHeat);
  if (haze > 0.0) {
    vec2 q = pc * 9.0 + vec2(0.0, -uTime * 1.7);
    vec2 w = vec2(n2(q), n2(q + 31.7)) - 0.5;
    uv += w * 0.012 * haze * (0.35 + rad);
  }
  // Fold charge pulls the image toward the centre.
  float foldCharge = uChargeKind > 1.5 ? uCharge : 0.0;
  uv -= c * 0.10 * foldCharge * foldCharge * exp(-rad * 2.5);

  vec3 col = sceneAt(uv);
  if (uHit > 0.01) {
    // Chromatic split on impact.
    col.r = mix(col.r, sceneAt(uv + c * 0.02 * uHit).r, 0.8);
    col.b = mix(col.b, sceneAt(uv - c * 0.02 * uHit).b, 0.8);
  }
  col += texture2D(tBloom, uv).rgb * uBloom;

  if (uCharge > 0.002) {
    float pulse = 0.85 + 0.15 * sin(uTime * (6.0 + 10.0 * uCharge));
    float edge = smoothstep(0.25, 1.0, rad);
    vec3 tint = uChargeKind > 1.5 ? vec3(0.55, 0.35, 1.3) : vec3(0.25, 0.75, 1.25);
    col += tint * edge * edge * uCharge * uCharge * 0.22 * pulse;
    col += tint * uCharge * 0.16 * exp(-rad * rad / (0.001 + 0.008 * uCharge * uCharge)) * pulse;
    if (uChargeKind > 1.5) col += vec3(1.0, 0.9, 1.3) * pow(uCharge, 4.0) * 0.004 / (rad * rad + 0.0008);
  }

  if (uFold > 0.0) {
    float env = smoothstep(0.0, 0.06, uFold) * (1.0 - smoothstep(0.94, 1.0, uFold));
    col = mix(col, tunnel(pc, rad, uTime), env);
    // White flash on entry and exit.
    float flash = (1.0 - smoothstep(0.0, 0.10, uFold)) + smoothstep(0.90, 1.0, uFold);
    col += vec3(0.8, 0.9, 1.2) * flash * 1.5;
  }

  // Time dilation: the periphery darkens and shifts to red.
  float dil = clamp(1.0 - uDilation, 0.0, 1.0);
  if (dil > 0.001) {
    float v = smoothstep(0.15, 0.95, rad) * min(1.0, dil * 1.6);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(l * 1.25, l * 0.30, l * 0.12) * (1.0 - 0.75 * v), v);
    col *= 1.0 - 0.25 * dil;
  }

  if (haze > 0.0) {
    float flick = 0.8 + 0.2 * sin(uTime * 9.0);
    col += vec3(1.0, 0.32, 0.05) * haze * smoothstep(0.35, 1.05, rad) * 0.22 * flick;
  }
  if (uHit > 0.0) {
    col += vec3(1.0, 0.22, 0.08) * uHit * (0.06 + 0.5 * smoothstep(0.3, 1.0, rad));
  }

  col *= 1.0 - 0.16 * rad * rad;
  if (uDepthDebug > 0.5) {
    float z = texture2D(tDepth, vUv).r;
    col = mix(col * 0.3, z < 0.1 ? vec3(1.0, 0.1, 0.1) : z < 1.0 ? vec3(0.1, 1.0, 0.1) : vec3(0.0, 0.0, 0.3), 0.7);
  }
  col = aces(max(col, 0.0));
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  // Triangular dither hides banding in dark gradients.
  float d = h21(gl_FragCoord.xy + 0.37) + h21(gl_FragCoord.xy + 17.13) - 1.0;
  gl_FragColor = vec4(col + d / 255.0, 1.0);
}
`;

/** The last pass of the frame; draws to the canvas. */
export class Composite {
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: FRAG,
    uniforms: {
      tScene: { value: null },
      tBloom: { value: null },
      tDepth: { value: null },
      uDepthDebug: { value: import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('depth') === '1' ? 1 : 0 },
      uRes: { value: new Vector2(1, 1) },
      uTime: { value: 0 },
      uBloom: { value: 0 },
      uCharge: { value: 0 },
      uChargeKind: { value: 0 },
      uFold: { value: 0 },
      uDilation: { value: 1 },
      uHeat: { value: 0 },
      uHit: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });

  render(
    renderer: WebGLRenderer, pass: FullscreenPass, scene: Texture, depth: Texture | null, bloom: Texture | null,
    fx: FrameFx, clock: number, width: number, height: number,
  ): void {
    const u = this.material.uniforms;
    u.tScene!.value = scene;
    u.tDepth!.value = depth;
    u.tBloom!.value = bloom ?? scene;
    u.uBloom!.value = bloom ? 0.22 : 0;
    (u.uRes!.value as Vector2).set(width, height);
    u.uTime!.value = clock % 3600;
    u.uCharge!.value = Math.min(1, Math.max(0, fx.charge));
    u.uChargeKind!.value = fx.chargeKind;
    u.uFold!.value = Math.min(1, Math.max(0, fx.fold));
    u.uDilation!.value = fx.dilation;
    u.uHeat!.value = fx.heat;
    u.uHit!.value = Math.min(1, Math.max(0, fx.hitFlash));
    pass.render(renderer, this.material, null);
  }

  dispose(): void {
    this.material.dispose();
  }
}
