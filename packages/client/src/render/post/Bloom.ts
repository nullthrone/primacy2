import { HalfFloatType, LinearFilter, NoBlending, ShaderMaterial, Vector2, WebGLRenderTarget } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { FULLSCREEN_VERT, type FullscreenPass } from './fullscreen.ts';

const LEVELS = 8;
/**
 * Share of the light each level spreads, from the tightest to the widest. The first levels are the
 * narrow gleam around a lamp or an engine; the long tail is a wide, faint veil, as a real lens
 * leaves it. The shares add up to 1, so the bloom texture holds exactly the light it took; how
 * much of that is laid over the picture is the final pass's choice.
 */
const WEIGHTS = normalized([1.0, 0.8, 0.6, 0.45, 0.35, 0.3, 0.25, 0.22]);
/** Light above this (scene-referred) blooms in full ... */
const THRESHOLD = 1.1;
/** ... and of everything below it this share does, which veils the dark around a sunlit planet. */
const FLOOR = 0.03;

function normalized(w: number[]): number[] {
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

// 13-tap downsample. The first level takes what blooms from the scene: all of the highlights
// (stars, engines, lava, the accretion disk) behind a soft threshold and a small share of the rest.
// Its alpha carries the plain brightness of the scene down the chain, so the smallest level ends
// up holding the mean brightness of the frame, which the exposure reads.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
varying vec2 vUv;
vec4 tap(vec2 o) {
  vec4 s = texture2D(tSrc, vUv + o * uTexel);
  if (uFirst < 0.5) return s;
  vec3 c = clamp(s.rgb, 0.0, 64.0);
  float l = max(c.r, max(c.g, c.b));
  float knee = ${(THRESHOLD * 0.6).toFixed(3)};
  float soft = clamp(l - ${THRESHOLD.toFixed(3)} + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float keep = max(soft, l - ${THRESHOLD.toFixed(3)}) / max(l, 1e-4);
  // One hot pixel must not own the mean: the brightness is capped.
  return vec4(c * (${FLOOR.toFixed(3)} + ${(1 - FLOOR).toFixed(3)} * keep), min(dot(c, vec3(0.2126, 0.7152, 0.0722)), 4.0));
}
void main() {
  vec4 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec4 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec4 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec4 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  gl_FragColor = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}
`;

// Tent upsample of everything wider, added to this level's share.
const UP_FRAG = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;
uniform float uWeight;
uniform float uLow;
varying vec2 vUv;
void main() {
  vec2 t = uTexel;
  vec3 s = texture2D(tLow, vUv).rgb * 4.0;
  s += (texture2D(tLow, vUv + vec2(t.x, 0)).rgb + texture2D(tLow, vUv - vec2(t.x, 0)).rgb
      + texture2D(tLow, vUv + vec2(0, t.y)).rgb + texture2D(tLow, vUv - vec2(0, t.y)).rgb) * 2.0;
  s += texture2D(tLow, vUv + t).rgb + texture2D(tLow, vUv - t).rgb
     + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb + texture2D(tLow, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(texture2D(tHigh, vUv).rgb * uWeight + s * (uLow / 16.0), 1.0);
}
`;

/** Bloom as a chain of half-float targets: progressive downsample, then upsample and a weighted sum. */
export class Bloom {
  private down: WebGLRenderTarget[] = [];
  private up: WebGLRenderTarget[] = [];
  private readonly downMat = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: DOWN_FRAG,
    uniforms: { tSrc: { value: null }, uTexel: { value: new Vector2() }, uFirst: { value: 0 } },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
  private readonly upMat = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: UP_FRAG,
    uniforms: { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new Vector2() }, uWeight: { value: 1 }, uLow: { value: 1 } },
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

  /** The smallest level of the last frame rendered: its alpha is the mean brightness of the scene. */
  get meter(): Texture | null {
    return this.down.length ? this.down[this.down.length - 1]!.texture : null;
  }

  /**
   * Runs the chain on `source`. The way down is always taken, because the exposure meters from
   * it; the way up only when `bloom` is on. Returns the bloom texture (half the source
   * resolution, to be added to the scene as it is), or null without bloom.
   */
  render(renderer: WebGLRenderer, pass: FullscreenPass, source: Texture, srcWidth: number, srcHeight: number, bloom: boolean): Texture | null {
    const dm = this.downMat.uniforms, um = this.upMat.uniforms;
    let src = source, sw = srcWidth, sh = srcHeight;
    for (let i = 0; i < this.down.length; i++) {
      const rt = this.down[i]!;
      dm.tSrc!.value = src;
      (dm.uTexel!.value as Vector2).set(1 / sw, 1 / sh);
      dm.uFirst!.value = i === 0 ? 1 : 0;
      pass.render(renderer, this.downMat, rt);
      src = rt.texture; sw = rt.width; sh = rt.height;
    }
    if (!bloom) return null;
    const last = this.down.length - 1;
    let low = this.down[last]!;
    for (let i = this.up.length - 1; i >= 0; i--) {
      const rt = this.up[i]!;
      um.tLow!.value = low.texture;
      um.tHigh!.value = this.down[i]!.texture;
      um.uWeight!.value = WEIGHTS[i]!;
      // The widest level comes in raw and gets its share here; everything above it is already weighted.
      um.uLow!.value = i === last - 1 ? WEIGHTS[last]! : 1;
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
