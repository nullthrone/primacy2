/**
 * Light in the lens: what a camera or an eye makes of a source far brighter than the rest of the
 * picture. A soft veil around it, a faint ring with a colour fringe, and the thin rays that the
 * edges of an aperture bend out of a point of light. None of it is in the scene: it forms in the
 * optics, so it lies over everything, the cockpit frame included, and it goes out when its source
 * is covered. The final pass draws it from a list of at most `LENS_LIGHTS` sources.
 *
 * In development builds `?lens=6|4|eye` picks the ray pattern.
 */
import { Quaternion, Vector3, Vector4 } from 'three';
import type { IUniform, PerspectiveCamera } from 'three';
import type { LensLight } from '../space/types.ts';

export const LENS_LIGHTS = 4;

/**
 * The cockpit is drawn into the front part of the depth buffer, up to this depth, and the local
 * scene into the rest. So the cockpit always covers the scene, and when the frame is done the
 * buffer still says where either of them is: 1 where neither drew. The light in the lens reads it
 * to tell whether its source is covered and where the canopy glass is.
 */
export const COCKPIT_DEPTH = 0.1;

/** Ray patterns: a six-bladed iris, the four vanes of a telescope, the many uneven needles of an eye. */
const KINDS: Record<string, number> = { '6': 0, '4': 1, eye: 2 };
const KIND = import.meta.env.DEV && typeof location !== 'undefined' ? KINDS[new URLSearchParams(location.search).get('lens') ?? ''] ?? 0 : 0;

/** Strength of the parts; 1 is the tuned look. */
const VEIL = 1;
const RING = 1;
const RAYS = 1;
export const CANOPY = 0.022;

/**
 * Vertex part: how much of each light the local scene and the cockpit leave uncovered. The depth
 * buffer is empty (1) wherever neither of them drew, so the share of empty points across the disc
 * of the light is the share of it that is seen.
 */
export const LENS_VERT = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform vec4 uLensPos[${LENS_LIGHTS}];
uniform int uLensCount;
varying vec4 vLensOpen;

float lensOpen(vec4 light) {
  float radius = max(light.z, 2.5 * uRes.y / 1080.0);
  float open = 0.0;
  for (int k = 0; k < 20; k++) {
    float fk = float(k);
    float a = fk * 2.39996323;
    vec2 p = light.xy + radius * sqrt((fk + 0.5) / 20.0) * vec2(cos(a), sin(a));
    open += step(0.99999, texture2D(tDepth, clamp(p / uRes, 0.0, 1.0)).r);
  }
  return open / 20.0;
}

void lensVertex() {
  vLensOpen = vec4(0.0);
  for (int i = 0; i < ${LENS_LIGHTS}; i++) {
    if (i >= uLensCount) break;
    vLensOpen[i] = lensOpen(uLensPos[i]);
  }
}
`;

/** Fragment part; needs `h21` from the pass that includes it. Lengths are in pixels. */
export const LENS_FRAG = /* glsl */ `
uniform vec4 uLensPos[${LENS_LIGHTS}];
uniform vec4 uLensCol[${LENS_LIGHTS}];
uniform int uLensCount;
uniform int uLensKind;
uniform vec3 uLensGain;
uniform float uLensCanopy;
varying vec4 vLensOpen;

// Red light is bent further than blue: every length in a diffraction pattern scales with the wavelength.
const vec3 LENS_WAVE = vec3(1.12, 1.0, 0.88);

// Brightness along a ray, 'e' pixels out from the edge of the disc: 1 at the disc, gone at 'len'.
vec3 lensFall(float e, float len) {
  vec3 t = e / (len * LENS_WAVE);
  return (1.0 - smoothstep(0.7, 1.0, t)) / (1.0 + 800.0 * t * t);
}

// One line of light through the source, from one pair of aperture edges: thin, and beaded with
// faint colour because the beads of each wavelength are spaced differently.
vec3 lensRay(vec2 d, float disc, float len, float px, float angle) {
  vec2 u = vec2(cos(angle), sin(angle));
  float e = max(abs(dot(d, u)) - disc, 0.0);
  float across = abs(d.x * u.y - d.y * u.x);
  float w = 0.75 * px;
  float line = exp(-across * across / (w * w)) + 0.06 * exp(-across * across / (w * w * 36.0));
  vec3 beads = 1.0 + 0.25 * cos(e * 6.2831853 / (22.0 * px * LENS_WAVE));
  return lensFall(e, len) * beads * line;
}

// The eye's own pattern: many fine needles of uneven length, fixed in the view.
vec3 lensNeedles(vec2 d, float r, float disc, float len, float px) {
  float ang = atan(d.y, d.x) / 6.2831853 + 0.5;
  float e = max(r - disc, 0.0);
  float w = 0.7 * px;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float count = k == 0 ? 34.0 : 78.0;
    float fa = ang * count;
    float id = floor(fa);
    float h = h21(vec2(id, 5.0 + float(k) * 9.0));
    float h2 = h21(vec2(id, 23.0 + float(k) * 3.0));
    float across = abs(fract(fa) - (0.5 + 0.6 * (h2 - 0.5))) * r * 6.2831853 / count;
    float line = exp(-across * across / (w * w));
    float reach = len * (0.22 + 0.78 * h * h) * (k == 0 ? 1.0 : 0.5);
    acc += lensFall(e, reach) * line * (0.35 + 0.65 * h2);
  }
  return acc;
}

vec3 lensLight(vec2 frag, vec4 pos, vec3 col) {
  vec2 d = frag - pos.xy;
  float r = length(d);
  float disc = pos.z, size = pos.w;
  float px = uRes.y / 1080.0;
  float e = max(r - disc, 0.0);
  float x = e / size;
  if (x > 3.4) return vec3(0.0);

  // Veil: tight and bright at the disc, with a long faint skirt.
  float veil = (0.030 / (1.0 + 120.0 * x * x) + 0.006 / (1.0 + 6.0 * x * x)) * (1.0 - smoothstep(1.2, 3.0, x));

  // Ring: a pale band, bluish on its inner edge and reddish on its outer one, made of fine radial fibres.
  float fa = (atan(d.y, d.x) / 6.2831853 + 0.5) * 240.0;
  float fibres = 0.6 + 0.4 * mix(h21(vec2(floor(fa), 71.0)), h21(vec2(floor(fa) + 1.0, 71.0)), fract(fa));
  vec3 rr = (x - 0.62 * mix(vec3(1.0), LENS_WAVE, 0.4)) / 0.075;
  vec3 ring = exp(-rr * rr) * 0.0011 * fibres;

  // Rays: they reach farther from a brighter source; a wide disc drowns them.
  vec3 rays;
  float len = 150.0 * px + 1.6 * size;
  if (uLensKind == 0) {
    rays = lensRay(d, disc, len, px, 0.72) + 0.85 * lensRay(d, disc, len, px, 1.7672) + 0.92 * lensRay(d, disc, len, px, 2.8144);
  } else if (uLensKind == 1) {
    rays = lensRay(d, disc, len * 1.15, px, 0.38) + 0.9 * lensRay(d, disc, len * 1.15, px, 1.9508);
  } else {
    rays = lensNeedles(d, r, disc, len, px);
  }
  rays /= 1.0 + disc / (40.0 * px);

  // Over the disc of a resolved star the lens only adds a thin veil, so its surface stays readable.
  float inside = mix(0.07, 1.0, smoothstep(disc * 0.85, disc, r));
  return col * inside * (uLensGain.x * veil + uLensGain.y * ring + uLensGain.z * rays);
}

// The canopy glass between the pilot and a bright source. Its fine scratches run every way, and
// each catches the light only where it lies across the line to the source: together they draw
// short arcs around it. Dust on the glass lights up as specks. Both are fixed to the glass,
// which in the cockpit is fixed to the view.
vec3 lensCanopy(vec2 frag, vec4 pos, vec3 col) {
  vec2 d = frag - pos.xy;
  float r = length(d);
  float px = uRes.y / 1080.0;
  float x = max(r - pos.z, 0.0) / (pos.w + 60.0 * px);
  if (x > 3.0) return vec3(0.0);
  float fall = (1.0 - smoothstep(1.4, 3.0, x)) / (1.0 + 3.0 * x * x);
  vec2 tangent = vec2(-d.y, d.x) / max(r, 1e-3);
  float acc = 0.0;
  for (int k = 0; k < 2; k++) {
    float cell = (k == 0 ? 96.0 : 41.0) * px;
    vec2 g = frag / cell + float(k) * 17.3;
    vec2 id = floor(g);
    if (h21(id + 29.0) < (k == 0 ? 0.3 : 0.55)) continue;
    float a = h21(id + 3.0) * 3.14159265;
    vec2 u = vec2(cos(a), sin(a));
    vec2 f = fract(g) - 0.5 - 0.4 * (vec2(h21(id + 7.0), h21(id + 13.0)) - 0.5);
    float across = abs(f.x * u.y - f.y * u.x) * cell;
    float along = abs(dot(f, u));
    float line = exp(-across * across / (0.25 * px * px)) * (1.0 - smoothstep(0.3, 0.5, along));
    float facing = abs(dot(u, tangent));
    acc += line * pow(facing, 28.0) * (0.35 + 0.65 * h21(id + 41.0));
  }
  // Dust: a speck in one cell of twelve.
  float cell = 15.0 * px;
  vec2 g = frag / cell;
  vec2 id = floor(g);
  vec2 f = (fract(g) - 0.5 - 0.6 * (vec2(h21(id + 51.0), h21(id + 57.0)) - 0.5)) * cell;
  float speck = step(0.92, h21(id + 61.0)) * exp(-dot(f, f) / (0.5 * px * px)) * 0.5;
  return col * fall * (acc + speck);
}

// Everything one frame's lights leave in the lens. 'canopy' is 1 behind canopy glass (see uLensCanopy).
vec3 lensGlare(vec2 frag, float canopy) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${LENS_LIGHTS}; i++) {
    if (i >= uLensCount) break;
    if (vLensOpen[i] <= 0.0) continue;
    vec3 light = lensLight(frag, uLensPos[i], uLensCol[i].rgb);
    if (canopy > 0.0) light += lensCanopy(frag, uLensPos[i], uLensCol[i].rgb) * (canopy * uLensCanopy);
    sum += light * vLensOpen[i];
  }
  return sum;
}
`;

export function lensUniforms(): Record<string, IUniform> {
  return {
    uLensPos: { value: Array.from({ length: LENS_LIGHTS }, () => new Vector4()) },
    uLensCol: { value: Array.from({ length: LENS_LIGHTS }, () => new Vector4()) },
    uLensCount: { value: 0 },
    uLensKind: { value: KIND },
    uLensGain: { value: new Vector3(VEIL, RING, RAYS) },
    // Strength of the scatter in the canopy glass; 0 outside the cockpit.
    uLensCanopy: { value: 0 },
  };
}

interface Seen { x: number; y: number; disc: number; size: number; r: number; g: number; b: number; power: number }

const seen: Seen[] = [];
const inverse = new Quaternion();
const v = new Vector3();

/**
 * Places the lights on the screen for this frame and keeps the strongest. `cam` is the camera of the
 * celestial pass; `width` and `height` are the size of the frame in pixels.
 */
export function aimLens(uniforms: Record<string, IUniform>, lights: readonly LensLight[], cam: PerspectiveCamera, width: number, height: number): void {
  inverse.copy(cam.quaternion).invert();
  const px = cam.projectionMatrix.elements[0]!, py = cam.projectionMatrix.elements[5]!;
  let n = 0;
  for (const light of lights) {
    const shown = Math.max(light.vis[0], light.vis[1], light.vis[2]);
    if (!(light.gain * shown > 0.01)) continue;
    v.set(light.dir[0], light.dir[1], light.dir[2]).applyQuaternion(inverse);
    if (v.z > -0.05) continue;
    const x = (0.5 - (0.5 * v.x * px) / v.z) * width, y = (0.5 - (0.5 * v.y * py) / v.z) * height;
    // A source just outside the frame still reaches into the lens; farther out it fades.
    const out = Math.hypot(Math.max(0, Math.abs(x - width / 2) - width / 2), Math.max(0, Math.abs(y - height / 2) - height / 2));
    const t = Math.min(1, out / (0.15 * height));
    const fade = 1 - t * t * (3 - 2 * t);
    if (fade <= 0) continue;
    const gain = light.gain * fade;
    const s = (seen[n] ??= { x: 0, y: 0, disc: 0, size: 1, r: 0, g: 0, b: 0, power: 0 });
    n++;
    s.x = x; s.y = y; s.disc = light.discPx; s.size = Math.max(1, light.sizePx);
    s.r = light.color[0] * light.vis[0] * gain; s.g = light.color[1] * light.vis[1] * gain; s.b = light.color[2] * light.vis[2] * gain;
    s.power = gain * shown;
  }
  const count = Math.min(n, LENS_LIGHTS);
  const pos = uniforms.uLensPos!.value as Vector4[], col = uniforms.uLensCol!.value as Vector4[];
  for (let i = 0; i < count; i++) {
    // The strongest of those left goes into slot i.
    let best = i;
    for (let j = i + 1; j < n; j++) if (seen[j]!.power > seen[best]!.power) best = j;
    const s = seen[best]!;
    seen[best] = seen[i]!;
    seen[i] = s;
    pos[i]!.set(s.x, s.y, s.disc, s.size);
    col[i]!.set(s.r, s.g, s.b, 1);
  }
  uniforms.uLensCount!.value = count;
}
