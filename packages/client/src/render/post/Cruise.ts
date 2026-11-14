import { NoBlending, ShaderMaterial, Vector2 } from 'three';
import type { Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import { FULLSCREEN_VERT, type FullscreenPass } from './fullscreen.ts';

// The look of cruise flight: the stars smear into streaks along lines through the centre of the
// view, shift toward blue, and thin lines of passing dust rush outward. It is applied to the sky
// alone and written into the frame before anything else is drawn, so celestial bodies, ships,
// stations, the ground and the cockpit all cover it.
const FRAG = /* glsl */ `
uniform sampler2D tSky;
uniform vec2 uRes;
uniform float uTime;
uniform float uCruise;
uniform int uTaps;
varying vec2 vUv;

float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 skyAt(vec2 uv) { return texture2D(tSky, clamp(uv, 0.0005, 0.9995)).rgb; }

// Thin radial lines rushing outward from the centre: dust passing at cruise speed.
float speedLines(vec2 pc, float rad, float t) {
  float ang = atan(pc.y, pc.x) / 6.2831853 + 0.5;
  float acc = 0.0;
  for (int k = 0; k < 2; k++) {
    float count = k == 0 ? 110.0 : 190.0;
    float fa = ang * count;
    float id = floor(fa);
    float h = h21(vec2(id, 3.0 + float(k) * 7.0));
    float h2 = h21(vec2(id, 19.0 + float(k) * 5.0));
    if (h2 < 0.6) continue;
    float life = fract(h + t * (0.35 + h2 * 0.9));
    float head = 0.14 + life * life * 1.2;
    float len = (0.02 + 0.22 * life) * (0.3 + uCruise);
    float along = smoothstep(head - len, head, rad) * (1.0 - smoothstep(head, head + 0.01, rad));
    float across = abs(fract(fa) - 0.5) * rad * 6.2831853 / count;
    float line = 1.0 - smoothstep(0.0, 0.0007 + 0.0009 * life, across);
    acc += along * line * (0.15 + life) * 0.6;
  }
  return acc;
}

void main() {
  vec2 c = vUv - 0.5;
  vec2 pc = vec2(c.x * uRes.x / uRes.y, c.y);
  float rad = length(pc);

  // Radial blur: the sky smears along lines through the centre, more toward the edge.
  float len = uCruise * 0.20 * smoothstep(0.03, 0.8, rad);
  float jitter = h21(gl_FragCoord.xy + fract(uTime) * 61.0);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uTaps) break;
    float f = (float(i) + jitter) / float(uTaps);
    float w = 1.0 - 0.75 * f;
    acc += skyAt(vUv - c * len * f) * w;
    wsum += w;
  }
  vec3 col = acc / wsum;

  col *= mix(vec3(1.0), vec3(0.86, 0.96, 1.22), uCruise * 0.6);
  col += vec3(0.55, 0.75, 1.3) * speedLines(pc, rad, uTime) * uCruise;
  col += vec3(0.25, 0.45, 1.0) * uCruise * 0.05 * exp(-rad * rad * 14.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Below this the ship is not in cruise and the sky is drawn straight into the frame. */
export const CRUISE_MIN = 0.002;

/** Writes the sky as it looks in cruise flight over a whole target. */
export class Cruise {
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: FRAG,
    uniforms: {
      tSky: { value: null },
      uRes: { value: new Vector2(1, 1) },
      uTime: { value: 0 },
      uCruise: { value: 0 },
      uTaps: { value: 12 },
    },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });

  /**
   * @param sky the sky alone, as large as `target`
   * @param cruise `FrameFx.cruise`, 0..1
   */
  render(
    renderer: WebGLRenderer, pass: FullscreenPass, sky: Texture, target: WebGLRenderTarget,
    cruise: number, clock: number, width: number, height: number, quality: number,
  ): void {
    const u = this.material.uniforms;
    u.tSky!.value = sky;
    (u.uRes!.value as Vector2).set(width, height);
    u.uTime!.value = clock % 3600;
    u.uCruise!.value = Math.min(1, Math.max(0, cruise));
    u.uTaps!.value = quality === 0 ? 6 : quality === 1 ? 10 : 16;
    pass.render(renderer, this.material, target);
  }

  dispose(): void {
    this.material.dispose();
  }
}
