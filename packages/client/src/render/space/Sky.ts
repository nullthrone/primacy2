import {
  AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CubeCamera, DoubleSide, Group, HalfFloatType,
  LinearFilter, LinearMipmapLinearFilter, Mesh, PMREMGenerator, Scene, ShaderMaterial, Vector2, Vector3, Vector4,
  WebGLCubeRenderTarget,
} from 'three';
import type { CubeTexture, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { GalaxyView, StarClass, SystemDef } from '@primacy2/shared';
import { GLSL_NOISE } from './glsl.ts';
import { hashString, seededRandom, type ViewParams } from './types.ts';

const NEBULAE = 4;

const DIR_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}
`;

// Stars that are drawn individually. The same function runs in the bake (as a luminance in the
// alpha channel, for lensing) and every frame on screen, where it stays sharp at any resolution.
const STAR_GLSL = /* glsl */ `
vec3 starTint(float h) {
  vec3 c = mix(vec3(1.0, 0.50, 0.30), vec3(1.0, 0.82, 0.60), smoothstep(0.0, 0.3, h));
  c = mix(c, vec3(1.0), smoothstep(0.3, 0.6, h));
  return mix(c, vec3(0.62, 0.76, 1.0), smoothstep(0.6, 1.0, h));
}
// One star per cell of a 3D grid cut by the unit sphere. A star is kept only when its projection
// onto the sphere stays well inside its own cell, so no star is clipped at a cell border.
vec3 starLayer(vec3 d, float n, float density, float sigma, float base, float gain, float power, float seed) {
  vec3 cell = floor(d * n);
  vec3 h = hash33(cell + seed);
  if (h.x > density) return vec3(0.0);
  vec3 sd = normalize(cell + 0.2 + 0.6 * hash33(cell * 1.31 + seed + 7.7));
  vec3 pr = sd * n - cell;
  if (any(lessThan(pr, vec3(0.15))) || any(greaterThan(pr, vec3(0.85)))) return vec3(0.0);
  float ang = length(d - sd);
  return starTint(h.z) * exp(-ang * ang / (sigma * sigma)) * (base + gain * pow(h.y, power));
}
vec3 brightStars(vec3 d, vec3 seed, float sigma, vec3 galN) {
  float lat = dot(d, galN);
  float dens = 0.35 + 0.65 * exp(-lat * lat / 0.16);
  return starLayer(d, 36.0, 0.22, min(sigma * 1.3, 0.0020), 0.25, 9.0, 7.0, seed.x * 91.0)
       + starLayer(d, 80.0, 0.60 * dens, min(sigma, 0.0011), 0.035, 1.6, 4.0, seed.y * 57.0);
}
`;

// Procedural sky, evaluated once per system into a cube map. RGB holds the galactic band, unresolved
// star dust and nebulae; alpha holds the luminance of the individually drawn stars.
const BAKE_FRAG = /* glsl */ `
uniform vec3 uSeed;
uniform vec3 uGalN;
uniform vec3 uGalC;
uniform float uSigma;
uniform vec3 uNebDir[${NEBULAE}];
uniform vec3 uNebCol[${NEBULAE}];
uniform vec3 uNebCol2[${NEBULAE}];
uniform vec4 uNebPar[${NEBULAE}];
varying vec3 vDir;
${GLSL_NOISE}
${STAR_GLSL}

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
  vec3 col = bandCol * (band * clumps * clumps * 0.045 * (0.30 + 0.70 * toCore) + core * 0.20);
  col += vec3(0.22, 0.27, 0.42) * wide * 0.006;

  // Unresolved star dust, denser toward the galactic plane.
  float dens = 0.20 + 0.50 * wide + 0.55 * band * clumps;
  vec3 dust = starLayer(d, 220.0, 0.30 * dens, uSigma, 0.02, 0.5, 3.0, uSeed.z * 33.0);
  dust += starLayer(d, 390.0, 0.34 * dens, uSigma * 0.9, 0.012, 0.22, 3.0, uSeed.x * 13.0 + 5.0);
  col = (col + dust) * (1.0 - 0.90 * lanes);

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
  vec3 stars = brightStars(d, uSeed, uSigma, uGalN);
  gl_FragColor = vec4(col, dot(stars, vec3(0.3333)));
}
`;

const SKY_FRAG = /* glsl */ `
uniform samplerCube uSky;
uniform vec3 uSeed;
uniform vec3 uGalN;
uniform float uSigma;
varying vec3 vDir;
${GLSL_NOISE}
${STAR_GLSL}
void main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(textureCube(uSky, d).rgb + brightStars(d, uSeed, uSigma, uGalN), 1.0);
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
// Colour pairs of nebulae: emission red to violet, oxygen teal to blue, reflection blue to violet, amber to red.
const NEBULA_PALETTE: [number, number, number][][] = [
  [[1.0, 0.16, 0.22], [0.50, 0.18, 0.95]],
  [[0.08, 0.65, 0.72], [0.18, 0.32, 1.0]],
  [[0.22, 0.38, 1.0], [0.62, 0.28, 1.0]],
  [[1.0, 0.48, 0.16], [1.0, 0.14, 0.20]],
];

/**
 * The background of space. The sky of a system is baked into a cube map once; each frame a textured
 * box is drawn with the individually visible stars evaluated on top. The same cube map feeds
 * reflections (prefiltered) and the black hole's lensing.
 */
export class Sky {
  /** Sky box and neighbour stars; lives in the celestial scene, centred on the camera. */
  readonly group = new Group();
  /** Prefiltered environment map of the current sky. */
  envMap: Texture | null = null;
  private readonly box = new BoxGeometry(2, 2, 2);
  private readonly skyMat: ShaderMaterial;
  private readonly bakeMat: ShaderMaterial;
  private readonly bakeScene = new Scene();
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
    const galN = new Vector3(0.42, 0.84, 0.34).normalize();
    const seed = new Vector3();
    this.skyMat = new ShaderMaterial({
      vertexShader: DIR_VERT, fragmentShader: SKY_FRAG,
      uniforms: { uSky: { value: null }, uSeed: { value: seed }, uGalN: { value: galN }, uSigma: { value: 0.001 } },
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
        uSeed: { value: seed },
        // The galactic plane is the same from every system, tilted against the systems' reference plane.
        uGalN: { value: galN },
        uGalC: { value: new Vector3(0.84, -0.42, 0).normalize() },
        uSigma: { value: 0.001 },
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
    const size = quality === 0 ? 512 : 1024;
    let count = 0, sum = 0;
    if (galaxy) {
      for (const sector of galaxy.sectors) {
        for (const s of sector.systems) {
          count++;
          sum += s.pos[0] * 3.1 + s.pos[1] * 1.7 + s.pos[2] * 0.9;
        }
      }
    }
    const key = `${system.id}|${size}|${count}|${sum.toFixed(3)}`;
    if (key === this.key) return;
    this.key = key;

    if (!this.cubeRT || this.cubeRT.width !== size) {
      this.cubeRT?.dispose();
      this.cubeRT = new WebGLCubeRenderTarget(size, {
        type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter,
      });
      this.cubeCam = new CubeCamera(0.1, 10, this.cubeRT);
    }
    const texel = Math.PI / 2 / size;
    this.setSeed(system.id, texel);
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

  /** Per-frame values: star sharpness and the pixel size of neighbour stars follow the view. */
  frame(params: ViewParams): void {
    this.skyMat.uniforms.uSigma!.value = params.pixAngle * 0.85;
    (this.neighbourMat.uniforms.uHalf!.value as Vector2).set(14 / params.width, 14 / params.height);
  }

  private setSeed(id: string, texel: number): void {
    const rnd = seededRandom(hashString(id));
    const u = this.bakeMat.uniforms;
    (u.uSeed!.value as Vector3).set(rnd(), rnd(), rnd());
    u.uSigma!.value = texel * 0.8;
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
      const size = 0.30 + rnd() * 0.50;
      // The first nebula is the system's landmark; the others stay faint.
      const strength = i === 0 ? 0.16 + rnd() * 0.16 : 0.03 + rnd() * rnd() * 0.14;
      // x: cosine of the angular radius, y: strength, z: noise frequency, w: noise offset.
      pars[i]!.set(Math.cos(size), strength, 2.0 + rnd() * 2.2, rnd() * 40);
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
    this.box.dispose();
    this.skyMat.dispose();
    this.bakeMat.dispose();
    this.neighbourMat.dispose();
    this.neighbourBakeMat.dispose();
  }
}
