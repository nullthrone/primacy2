import { HalfFloatType, NearestFilter, NoBlending, ShaderMaterial, Vector2, WebGLRenderTarget } from 'three';
import type { IUniform, Texture, WebGLRenderer } from 'three';
import type { FullscreenPass } from './fullscreen.ts';
import { LENS_LIGHTS, LENS_VERT } from './lens.ts';

/**
 * Exposure of the dark-adapted eye, with nothing bright in view, and with the view full of light.
 * The range is narrow on purpose: space stays black and a sunlit hull stays bright, but the faint
 * stars come out when the pilot looks into the dark and step back when a sun enters the view.
 */
const EXPOSURE_DARK = 1.25;
const EXPOSURE_BRIGHT = 0.62;
/** Seconds to adapt to more light, and to less: the eye closes fast and opens slowly. */
const TIME_TO_BRIGHT = 0.45;
const TIME_TO_DARK = 1.6;
/** Mean scene brightness that counts as one unit of load, as one sun at 1 AU in view does. */
const MEAN_UNIT = 0.06;

const VERT = /* glsl */ `
varying vec2 vUv;
${LENS_VERT}
void main() {
  vUv = uv;
  lensVertex();
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// One texel: the exposure of this frame, eased from the one before toward what the light in view asks for.
const FRAG = /* glsl */ `
uniform sampler2D tMeter;
uniform sampler2D tPrev;
uniform vec4 uLensCol[${LENS_LIGHTS}];
uniform int uLensCount;
uniform vec2 uEase;
varying vec4 vLensOpen;
void main() {
  // The mean brightness of the frame, weighted toward its centre.
  float mean = 0.4 * texture2D(tMeter, vec2(0.5)).a
    + 0.15 * (texture2D(tMeter, vec2(0.25, 0.3)).a + texture2D(tMeter, vec2(0.75, 0.3)).a
            + texture2D(tMeter, vec2(0.25, 0.7)).a + texture2D(tMeter, vec2(0.75, 0.7)).a);
  float load = mean / ${MEAN_UNIT.toFixed(3)};
  // What dazzles is not in the scene but in the lens; it counts by how much of it is uncovered.
  for (int i = 0; i < ${LENS_LIGHTS}; i++) {
    if (i >= uLensCount) break;
    load += vLensOpen[i] * max(uLensCol[i].r, max(uLensCol[i].g, uLensCol[i].b)) / 20.0;
  }
  float want = ${EXPOSURE_BRIGHT.toFixed(3)} + ${(EXPOSURE_DARK - EXPOSURE_BRIGHT).toFixed(3)} / (1.0 + load);
  float prev = texture2D(tPrev, vec2(0.5)).r;
  // The first frame has nothing to ease from.
  float next = prev < 0.01 ? want : mix(prev, want, want < prev ? uEase.x : uEase.y);
  gl_FragColor = vec4(next, 0.0, 0.0, 1.0);
}
`;

/** Keeps the exposure of the picture: a single value that follows the light in view with the delay of an eye. */
export class Exposure {
  private readonly targets = [0, 1].map(() => new WebGLRenderTarget(1, 1, {
    type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false,
  }));
  private readonly material: ShaderMaterial;
  private current = 0;

  /** `lens` are the uniforms of the final pass that place the lights and hold the depth (see `lens.ts`); they are shared, not copied. */
  constructor(lens: Record<string, IUniform>) {
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tDepth: lens.tDepth!, uRes: lens.uRes!, uLensPos: lens.uLensPos!, uLensCol: lens.uLensCol!, uLensCount: lens.uLensCount!,
        tMeter: { value: null }, tPrev: { value: null }, uEase: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
  }

  /** The exposure as a 1x1 texture (red channel). */
  get texture(): Texture {
    return this.targets[this.current]!.texture;
  }

  /** Advances by `dt` seconds. `meter` carries the mean brightness of the scene in its alpha (see `Bloom`). */
  update(renderer: WebGLRenderer, pass: FullscreenPass, meter: Texture | null, dt: number): void {
    if (!meter) return;
    const u = this.material.uniforms;
    const prev = this.targets[this.current]!;
    this.current = 1 - this.current;
    u.tMeter!.value = meter;
    u.tPrev!.value = prev.texture;
    (u.uEase!.value as Vector2).set(1 - Math.exp(-dt / TIME_TO_BRIGHT), 1 - Math.exp(-dt / TIME_TO_DARK));
    pass.render(renderer, this.material, this.targets[this.current]!);
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.material.dispose();
  }
}
