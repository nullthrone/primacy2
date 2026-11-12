import { HalfFloatType, LinearFilter, NoBlending, ShaderMaterial, Vector2, WebGLRenderTarget } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { FULLSCREEN_VERT, type FullscreenPass } from './fullscreen.ts';

const LEVELS = 6;

// 13-tap downsample. The first level also applies a soft brightness threshold so only
// scene-referred highlights (stars, engines, lava, the accretion disk) feed the bloom.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 tap(vec2 o) {
  vec3 c = clamp(texture2D(tSrc, vUv + o * uTexel).rgb, 0.0, 64.0);
  if (uThreshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    float knee = uThreshold * 0.6;
    float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    c *= max(soft, l - uThreshold) / max(l, 1e-4);
  }
  return c;
}
void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}
`;

// Tent upsample of the next smaller level, added to the current level.
const UP_FRAG = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;
uniform float uSpread;
varying vec2 vUv;
void main() {
  vec2 t = uTexel;
  vec3 s = texture2D(tLow, vUv).rgb * 4.0;
  s += (texture2D(tLow, vUv + vec2(t.x, 0)).rgb + texture2D(tLow, vUv - vec2(t.x, 0)).rgb
      + texture2D(tLow, vUv + vec2(0, t.y)).rgb + texture2D(tLow, vUv - vec2(0, t.y)).rgb) * 2.0;
  s += texture2D(tLow, vUv + t).rgb + texture2D(tLow, vUv - t).rgb
     + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb + texture2D(tLow, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(texture2D(tHigh, vUv).rgb + s * (uSpread / 16.0), 1.0);
}
`;

/** Bloom as a chain of half-float targets: progressive downsample, then upsample and sum. */
export class Bloom {
  private down: WebGLRenderTarget[] = [];
  private up: WebGLRenderTarget[] = [];
  private readonly downMat = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: DOWN_FRAG,
    uniforms: { tSrc: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: 0 } },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
  private readonly upMat = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: UP_FRAG,
    uniforms: { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new Vector2() }, uSpread: { value: 0.8 } },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });

  setSize(width: number, height: number): void {
    this.disposeTargets();
    let w = width, h = height;
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(2, Math.floor(w / 2));
      h = Math.max(2, Math.floor(h / 2));
      const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false };
      this.down.push(new WebGLRenderTarget(w, h, opts));
      if (i < LEVELS - 1) this.up.push(new WebGLRenderTarget(w, h, opts));
    }
  }

  /** Runs the chain on `source` and returns the bloom texture (half the source resolution). */
  render(renderer: WebGLRenderer, pass: FullscreenPass, source: Texture, srcWidth: number, srcHeight: number): Texture {
    const dm = this.downMat.uniforms, um = this.upMat.uniforms;
    let src = source, sw = srcWidth, sh = srcHeight;
    for (let i = 0; i < this.down.length; i++) {
      const rt = this.down[i]!;
      dm.tSrc!.value = src;
      (dm.uTexel!.value as Vector2).set(1 / sw, 1 / sh);
      dm.uThreshold!.value = i === 0 ? 1.1 : 0;
      pass.render(renderer, this.downMat, rt);
      src = rt.texture; sw = rt.width; sh = rt.height;
    }
    let low = this.down[this.down.length - 1]!;
    for (let i = this.up.length - 1; i >= 0; i--) {
      const rt = this.up[i]!;
      um.tLow!.value = low.texture;
      um.tHigh!.value = this.down[i]!.texture;
      (um.uTexel!.value as Vector2).set(1 / low.width, 1 / low.height);
      pass.render(renderer, this.upMat, rt);
      low = rt;
    }
    return low.texture;
  }

  private disposeTargets(): void {
    for (const rt of this.down) rt.dispose();
    for (const rt of this.up) rt.dispose();
    this.down = [];
    this.up = [];
  }

  dispose(): void {
    this.disposeTargets();
    this.downMat.dispose();
    this.upMat.dispose();
  }
}
