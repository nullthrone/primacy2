import {
  AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CubeCamera, DoubleSide, Group, HalfFloatType,
  LinearFilter, LinearMipmapLinearFilter, Mesh, PMREMGenerator, Points, Scene, ShaderMaterial, Vector2, Vector3, Vector4,
  WebGLCubeRenderTarget,
} from 'three';
import type { CubeTexture, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { GalaxyView, StarClass, SystemDef } from '@primacy2/shared';
import { GLSL_NOISE } from './glsl.ts';
import { kelvinToLinear } from './lighting.ts';
import { seededRandom, type ViewParams } from './types.ts';

const NEBULAE = 4;

const DIR_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}
`;

// The diffuse part of the sky, evaluated once into a cube map: the glow of the galactic band with
// its dust lanes and a few pale nebulae. Alpha starts empty; the stars, which are drawn as points
// of their own, add their luminance to it for the black hole's lensing.
const BAKE_FRAG = /* glsl */ `
uniform vec3 uGalN;
uniform vec3 uGalC;
uniform vec3 uNebDir[${NEBULAE}];
uniform vec3 uNebCol[${NEBULAE}];
uniform vec3 uNebCol2[${NEBULAE}];
uniform vec4 uNebPar[${NEBULAE}];
varying vec3 vDir;
${GLSL_NOISE}

void main() {
  vec3 d = normalize(vDir);
  float lat = dot(d, uGalN);
  float toCore = dot(d, uGalC) * 0.5 + 0.5;
  float band = exp(-lat * lat / 0.030);
  float wide = exp(-lat * lat / 0.20);
  float core = exp(-(1.0 - toCore) / 0.07) * exp(-lat * lat / 0.035);

  float n1 = fbm(d * 2.3 + 4.0, 6);
  float n2 = fbm(d * 5.5 + n1 * 1.5 + 9.0, 7);
  float lanes = smoothstep(-0.08, 0.28, fbm(d * 4.2 + 21.0 + n1 * 0.8, 8)) * exp(-lat * lat / 0.012);
  float clumps = clamp(0.55 + 1.5 * n1 + 0.8 * n2, 0.0, 2.0);
  vec3 bandCol = mix(vec3(0.42, 0.52, 0.88), vec3(1.0, 0.80, 0.56), clamp(core * 1.5 + toCore * 0.4, 0.0, 1.0));
  // The light of stars too many and too faint to tell apart: a soft glow, never a speck.
  vec3 col = bandCol * (band * clumps * (0.6 + 0.4 * clumps) * 0.034 * (0.30 + 0.70 * toCore) + core * 0.15);
  col += vec3(0.22, 0.27, 0.42) * wide * 0.005;
  col *= 1.0 - 0.90 * lanes;

  for (int i = 0; i < ${NEBULAE}; i++) {
    float m = smoothstep(uNebPar[i].x, 1.0, dot(d, uNebDir[i]));
    if (m <= 0.0) continue;
    vec3 np = d * uNebPar[i].z + uNebPar[i].w;
    float w = fbm(np * 0.5 + 3.0, 5);
    float f = fbm(np + vec3(w * 2.2, -w * 1.3, w), 8);
    float body = smoothstep(-0.12, 0.55, f);
    float fil = pow(ridged(np * 1.3 + w * 1.5, 7), 5.0);
    float dark = smoothstep(0.08, 0.45, fbm(np * 1.7 + 11.0 - w, 7));
    vec3 nc = mix(uNebCol[i], uNebCol2[i], smoothstep(-0.25, 0.35, w + f * 0.5));
    col *= 1.0 - 0.6 * dark * m;
    col += nc * (body * body * 0.55 + fil * 0.75) * m * (1.0 - 0.85 * dark) * uNebPar[i].y;
  }
  gl_FragColor = vec4(col, 0.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform samplerCube uSky;
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(textureCube(uSky, normalize(vDir)).rgb, 1.0);
}
`;

// The stars: every one a point of light of its own, so they are sharp at any resolution and as
// bright as they are, from the faintest speck to the few that bloom. Each is drawn as the small
// soft disc a lens makes of a point; the brightest also get the thin rays of the aperture, in the
// same pattern as the glare of a sun (see post/lens.ts). With uLum they add their luminance to the
// alpha channel of the bake instead of drawing colour.
const STAR_VERT = /* glsl */ `
attribute vec3 color;
uniform float uPx;
uniform float uHot;
varying vec3 vColor;
varying float vSize;
varying float vRays;
void main() {
  vColor = color;
  float peak = max(color.r, max(color.g, color.b));
  // Stars above uHot are bright enough for rays and get the room to draw them.
  vRays = smoothstep(uHot, uHot * 3.0, peak);
  vSize = (vRays > 0.0 ? 9.0 + 34.0 * vRays : 5.0) * uPx;
  gl_PointSize = vSize;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}
`;
const STAR_FRAG = /* glsl */ `
uniform float uPx;
uniform float uLum;
varying vec3 vColor;
varying float vSize;
varying float vRays;
float ray(vec2 p, float angle, float reach) {
  vec2 u = vec2(cos(angle), sin(angle));
  float along = abs(dot(p, u)) / reach;
  float across = abs(p.x * u.y - p.y * u.x) / (0.6 * uPx);
  return exp(-across * across) * (1.0 - smoothstep(0.6, 1.0, along)) / (1.0 + 90.0 * along * along);
}
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize;
  float s = 0.78 * uPx;
  vec3 c = vColor * exp(-dot(p, p) / (2.0 * s * s));
  if (vRays > 0.0) {
    float reach = 0.5 * vSize;
    c += vColor * vRays * 0.5 * (ray(p, 0.72, reach) + 0.85 * ray(p, 1.7672, reach) + 0.92 * ray(p, 2.8144, reach));
  }
  gl_FragColor = uLum > 0.5 ? vec4(0.0, 0.0, 0.0, dot(c, vec3(0.3333))) : vec4(c, 1.0);
}
`;

// Stars of other systems: quads of a fixed pixel size around their direction. With uLum they add
// their luminance to the alpha channel of the bake instead of drawing colour.
const NEIGHBOUR_VERT = /* glsl */ `
attribute vec3 color;
uniform vec2 uHalf;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vColor = color;
  vUv = uv;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  p.xy += uv * uHalf * p.w;
  gl_Position = p;
}
`;
const NEIGHBOUR_FRAG = /* glsl */ `
uniform float uLum;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  float r2 = dot(vUv, vUv);
  vec3 c = vColor * (exp(-r2 * 14.0) + 0.05 * exp(-r2 * 3.0)) * (1.0 - smoothstep(0.7, 1.0, r2));
  gl_FragColor = uLum > 0.5 ? vec4(0.0, 0.0, 0.0, dot(c, vec3(0.3333))) : vec4(c, 1.0);
}
`;

// Typical luminosity (solar units) and tint per spectral class, for stars of other systems.
const CLASS_LUM: Record<StarClass, number> = { O: 30000, B: 800, A: 40, F: 4, G: 1, K: 0.4, M: 0.05, WD: 0.01, NS: 0.01, BH: 0.005 };
const CLASS_TINT: Record<StarClass, [number, number, number]> = {
  O: [0.60, 0.72, 1.0], B: [0.70, 0.80, 1.0], A: [0.85, 0.90, 1.0], F: [1.0, 1.0, 0.94], G: [1.0, 0.93, 0.78],
  K: [1.0, 0.78, 0.55], M: [1.0, 0.58, 0.38], WD: [0.82, 0.90, 1.0], NS: [0.70, 0.85, 1.0], BH: [1.0, 0.55, 0.30],
};
// Colour pairs of nebulae, pale as the eye sees them: emission rose to violet, oxygen teal to blue,
// reflection blue to violet, amber to rose.
const NEBULA_PALETTE: [number, number, number][][] = [
  [[0.80, 0.30, 0.34], [0.50, 0.32, 0.70]],
  [[0.25, 0.55, 0.60], [0.30, 0.40, 0.80]],
  [[0.34, 0.45, 0.85], [0.55, 0.42, 0.80]],
  [[0.85, 0.55, 0.35], [0.80, 0.32, 0.34]],
];

/** Stars drawn per quality level. The catalogue is sorted, so a lower level drops the faintest. */
const STAR_COUNTS = [14000, 28000, 48000] as const;
/** A star whose peak brightness (scene-referred) passes this shows the rays of the aperture. */
const STAR_RAYS_FROM = 3;
// The galactic plane is the same from every system, tilted against the systems' reference plane.
const GAL_N = new Vector3(0.42, 0.84, 0.34).normalize();
const GAL_C = new Vector3(0.84, -0.42, 0).normalize();

/**
 * The star catalogue: direction and colour times brightness of every star, sorted from the
 * brightest. It is the same from every system, because even the nearest of these stars is far away
 * compared with a jump between systems; only the stars of the game's own systems move (see
 * `setNeighbours`). Four stars in ten are anywhere, the rest crowd the galactic band and its core.
 * For every star there are about three of the next fainter magnitude, as in a real sky.
 */
function starCatalogue(count: number): { position: Float32Array; color: Float32Array } {
  const rnd = seededRandom(0x5ca1ab1e);
  const e2 = new Vector3().crossVectors(GAL_N, GAL_C);
  const dir = new Vector3();
  const stars: { x: number; y: number; z: number; r: number; g: number; b: number; peak: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.42) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      dir.set(r * Math.cos(a), z, r * Math.sin(a));
    } else {
      let phi = 0, toCore = 0;
      do {
        phi = (rnd() * 2 - 1) * Math.PI;
        toCore = Math.exp(-(phi * phi) / 1.44);
      } while (rnd() > 0.3 + 0.7 * toCore);
      const beta = (rnd() + rnd() + rnd() - 1.5) * 0.19 * (0.7 + 0.6 * toCore);
      const cb = Math.cos(beta);
      dir.set(0, 0, 0).addScaledVector(GAL_C, cb * Math.cos(phi)).addScaledVector(e2, cb * Math.sin(phi)).addScaledVector(GAL_N, Math.sin(beta));
    }
    const flux = Math.min(1800, Math.pow(1 - rnd(), -1 / 1.2));
    const peak = 0.05 * Math.pow(flux, 0.72);
    const t = rnd();
    const kelvin = (t < 0.10 ? 3300 : t < 0.30 ? 4400 : t < 0.58 ? 5900 : t < 0.86 ? 8200 : 14000) * (0.88 + 0.24 * rnd());
    const k = kelvinToLinear(kelvin);
    // The colours of stars are faint to the eye: tinted white, not red and blue.
    stars.push({ x: dir.x, y: dir.y, z: dir.z, r: (0.45 + 0.55 * k[0]) * peak, g: (0.45 + 0.55 * k[1]) * peak, b: (0.45 + 0.55 * k[2]) * peak, peak });
  }
  stars.sort((a, b) => b.peak - a.peak);
  const position = new Float32Array(count * 3), color = new Float32Array(count * 3);
  stars.forEach((st, i) => {
    position[i * 3] = st.x; position[i * 3 + 1] = st.y; position[i * 3 + 2] = st.z;
    color[i * 3] = st.r; color[i * 3 + 1] = st.g; color[i * 3 + 2] = st.b;
  });
  return { position, color };
}

/**
 * The background of space: the diffuse glow of the galaxy, baked into a cube map once, and over it
 * the stars as points of light and the stars of the other known systems. The same cube map feeds
 * reflections (prefiltered) and the black hole's lensing.
 */
export class Sky {
  /** Sky box, stars and neighbour stars; lives in the celestial scene, centred on the camera. */
  readonly group = new Group();
  /** Prefiltered environment map of the current sky. */
  envMap: Texture | null = null;
  private readonly box = new BoxGeometry(2, 2, 2);
  private readonly skyMat: ShaderMaterial;
  private readonly bakeMat: ShaderMaterial;
  private readonly bakeScene = new Scene();
  private readonly starGeo = new BufferGeometry();
  private readonly starMat: ShaderMaterial;
  private readonly starBakeMat: ShaderMaterial;
  private readonly neighbourMat: ShaderMaterial;
  private readonly neighbourBakeMat: ShaderMaterial;
  private neighbourGeo: BufferGeometry | null = null;
  private readonly neighbours: Mesh[] = [];
  private cubeRT: WebGLCubeRenderTarget | null = null;
  private cubeCam: CubeCamera | null = null;
  private pmrem: PMREMGenerator | null = null;
  private envRT: WebGLRenderTarget | null = null;
  private key = '';

  constructor() {
    this.skyMat = new ShaderMaterial({
      vertexShader: DIR_VERT, fragmentShader: SKY_FRAG,
      uniforms: { uSky: { value: null } },
      side: BackSide, depthTest: false, depthWrite: false,
    });
    const sky = new Mesh(this.box, this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.group.add(sky);

    const vecs = (): Vector3[] => Array.from({ length: NEBULAE }, () => new Vector3(0, 1, 0));
    this.bakeMat = new ShaderMaterial({
      vertexShader: DIR_VERT, fragmentShader: BAKE_FRAG,
      uniforms: {
        uGalN: { value: GAL_N },
        uGalC: { value: GAL_C },
        uNebDir: { value: vecs() },
        uNebCol: { value: vecs() },
        uNebCol2: { value: vecs() },
        uNebPar: { value: Array.from({ length: NEBULAE }, () => new Vector4()) },
      },
      side: BackSide, depthTest: false, depthWrite: false,
    });
    const bakeBox = new Mesh(this.box, this.bakeMat);
    bakeBox.frustumCulled = false;
    this.bakeScene.add(bakeBox);
    this.setNebulae();

    const catalogue = starCatalogue(STAR_COUNTS[2]);
    this.starGeo.setAttribute('position', new BufferAttribute(catalogue.position, 3));
    this.starGeo.setAttribute('color', new BufferAttribute(catalogue.color, 3));
    const star = (lum: number): ShaderMaterial => new ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      // In the bake the stars are plain discs a texel wide, without rays.
      uniforms: { uPx: { value: 1 }, uHot: { value: lum ? 1e9 : STAR_RAYS_FROM }, uLum: { value: lum } },
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    });
    this.starMat = star(0);
    this.starBakeMat = star(1);
    for (const [parent, mat] of [[this.group, this.starMat], [this.bakeScene, this.starBakeMat]] as const) {
      const points = new Points(this.starGeo, mat);
      points.frustumCulled = false;
      points.renderOrder = -999;
      parent.add(points);
    }

    const neighbour = (lum: number): ShaderMaterial => new ShaderMaterial({
      vertexShader: NEIGHBOUR_VERT, fragmentShader: NEIGHBOUR_FRAG,
      uniforms: { uHalf: { value: new Vector2(0.01, 0.01) }, uLum: { value: lum } },
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
    });
    this.neighbourMat = neighbour(0);
    this.neighbourBakeMat = neighbour(1);
  }

  /** The baked sky, or null before the first bake. */
  get cube(): CubeTexture | null {
    return this.cubeRT ? this.cubeRT.texture : null;
  }

  /** Bakes the sky again when the system, the quality or the set of known neighbour systems changed. */
  update(renderer: WebGLRenderer, system: SystemDef, galaxy: GalaxyView | null, quality: number): void {
    const size = quality === 0 ? 768 : 1024;
    let count = 0, sum = 0;
    if (galaxy) {
      for (const sector of galaxy.sectors) {
        for (const s of sector.systems) {
          count++;
          sum += s.pos[0] * 3.1 + s.pos[1] * 1.7 + s.pos[2] * 0.9;
        }
      }
    }
    const stars = STAR_COUNTS[quality as 0 | 1 | 2] ?? STAR_COUNTS[2];
    const key = `${system.id}|${size}|${stars}|${count}|${sum.toFixed(3)}`;
    if (key === this.key) return;
    this.key = key;

    if (!this.cubeRT || this.cubeRT.width !== size) {
      this.cubeRT?.dispose();
      this.cubeRT = new WebGLCubeRenderTarget(size, {
        type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter,
      });
      this.cubeCam = new CubeCamera(0.1, 10, this.cubeRT);
    }
    // The bake holds the stars that are drawn, so the black hole bends the same sky.
    this.starGeo.setDrawRange(0, stars);
    this.setNeighbours(system, galaxy);
    // In the bake a neighbour star covers a few texels of a 90 degree face.
    (this.neighbourBakeMat.uniforms.uHalf!.value as Vector2).set(10 / size, 10 / size);

    this.cubeCam!.update(renderer, this.bakeScene);
    this.skyMat.uniforms.uSky!.value = this.cubeRT.texture;

    this.pmrem ??= new PMREMGenerator(renderer);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture);
    this.envMap = this.envRT.texture;
  }

  /** Per-frame values: the pixel size of the stars follows the view. */
  frame(params: ViewParams): void {
    // A larger picture shows finer stars, but not in full proportion: they must stay wider than a pixel.
    this.starMat.uniforms.uPx!.value = Math.max(0.85, Math.sqrt(params.height / 1080));
    (this.neighbourMat.uniforms.uHalf!.value as Vector2).set(14 / params.width, 14 / params.height);
  }

  /** Places the nebulae: few, small and pale, and like the stars the same from every system. */
  private setNebulae(): void {
    const rnd = seededRandom(0x0eb01a);
    const u = this.bakeMat.uniforms;
    const dirs = u.uNebDir!.value as Vector3[];
    const cols = u.uNebCol!.value as Vector3[];
    const cols2 = u.uNebCol2!.value as Vector3[];
    const pars = u.uNebPar!.value as Vector4[];
    for (let i = 0; i < NEBULAE; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      dirs[i]!.set(r * Math.cos(a), z, r * Math.sin(a));
      const pair = NEBULA_PALETTE[Math.floor(rnd() * NEBULA_PALETTE.length)]!;
      cols[i]!.set(pair[0]![0], pair[0]![1], pair[0]![2]);
      cols2[i]!.set(pair[1]![0], pair[1]![1], pair[1]![2]);
      const size = 0.09 + rnd() * 0.17;
      // The first is a landmark one can find again; the others are barely there.
      const strength = i === 0 ? 0.07 + rnd() * 0.04 : 0.012 + rnd() * rnd() * 0.04;
      // x: cosine of the angular radius, y: strength, z: noise frequency (finer for a smaller patch), w: noise offset.
      pars[i]!.set(Math.cos(size), strength, (2.0 + rnd() * 2.2) * (0.55 / size), rnd() * 40);
    }
  }

  /** Stars of the other known systems as small quads in their true direction, on screen and in the bake. */
  private setNeighbours(system: SystemDef, galaxy: GalaxyView | null): void {
    for (const mesh of this.neighbours) mesh.removeFromParent();
    this.neighbours.length = 0;
    this.neighbourGeo?.dispose();
    this.neighbourGeo = null;
    if (!galaxy) return;
    const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
    for (const sector of galaxy.sectors) {
      for (const s of sector.systems) {
        if (s.id === system.id) continue;
        const x = s.pos[0] - system.pos[0], y = s.pos[1] - system.pos[1], z = s.pos[2] - system.pos[2];
        const ly = Math.hypot(x, y, z);
        if (!(ly > 1e-6)) continue;
        const apparent = CLASS_LUM[s.starClass] / (ly * ly);
        const gain = Math.min(9, Math.max(1.6, 5.0 + 1.3 * Math.log10(apparent)));
        const tint = CLASS_TINT[s.starClass];
        const base = pos.length / 3;
        for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          pos.push(x / ly, y / ly, z / ly);
          uv.push(cx, cy);
          col.push(tint[0] * gain, tint[1] * gain, tint[2] * gain);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    if (idx.length === 0) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(idx);
    this.neighbourGeo = geo;
    for (const [parent, mat] of [[this.group, this.neighbourMat], [this.bakeScene, this.neighbourBakeMat]] as const) {
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -999;
      parent.add(mesh);
      this.neighbours.push(mesh);
    }
  }

  dispose(): void {
    this.cubeRT?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.neighbourGeo?.dispose();
    this.starGeo.dispose();
    this.starMat.dispose();
    this.starBakeMat.dispose();
    this.box.dispose();
    this.skyMat.dispose();
    this.bakeMat.dispose();
    this.neighbourMat.dispose();
    this.neighbourBakeMat.dispose();
  }
}
