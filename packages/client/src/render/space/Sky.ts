import {
  AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CubeCamera, DoubleSide, HalfFloatType,
  LinearFilter, LinearMipmapLinearFilter, Mesh, PMREMGenerator, Scene, ShaderMaterial, Vector3, Vector4,
  WebGLCubeRenderTarget,
} from 'three';
import type { CubeTexture, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { GalaxyView, StarClass, SystemDef } from '@primacy2/shared';
import { GLSL_NOISE } from './glsl.ts';
import { hashString, seededRandom } from './types.ts';

const NEBULAE = 4;

const DIR_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}
`;

// Procedural sky, evaluated once per system into a cube map: stars, the galactic band and nebulae.
const BAKE_FRAG = /* glsl */ `
uniform vec3 uSeed;
uniform vec3 uGalN;
uniform vec3 uGalC;
uniform float uSigma;
uniform vec3 uNebDir[${NEBULAE}];
uniform vec3 uNebCol[${NEBULAE}];
uniform vec4 uNebPar[${NEBULAE}];
varying vec3 vDir;
${GLSL_NOISE}

vec3 starTint(float h) {
  vec3 c = mix(vec3(1.0, 0.50, 0.30), vec3(1.0, 0.82, 0.60), smoothstep(0.0, 0.3, h));
  c = mix(c, vec3(1.0), smoothstep(0.3, 0.6, h));
  return mix(c, vec3(0.62, 0.76, 1.0), smoothstep(0.6, 1.0, h));
}

// One star per cell of a 3D grid cut by the unit sphere. A star is kept only when its projection
// onto the sphere stays well inside its own cell, so no star is clipped at a cell border.
vec3 starLayer(vec3 d, float n, float density, float sigma, float gain, float seed) {
  vec3 cell = floor(d * n);
  vec3 h = hash33(cell + seed);
  if (h.x > density) return vec3(0.0);
  vec3 sd = normalize(cell + 0.2 + 0.6 * hash33(cell * 1.31 + seed + 7.7));
  vec3 pr = sd * n - cell;
  if (any(lessThan(pr, vec3(0.1))) || any(greaterThan(pr, vec3(0.9)))) return vec3(0.0);
  float ang = length(d - sd);
  float mag = pow(h.y, 6.0);
  return starTint(h.z) * exp(-ang * ang / (sigma * sigma)) * (0.07 + mag) * gain;
}

void main() {
  vec3 d = normalize(vDir);
  float lat = dot(d, uGalN);
  float toCore = dot(d, uGalC) * 0.5 + 0.5;
  float band = exp(-lat * lat / 0.035);
  float wide = exp(-lat * lat / 0.22);
  float core = exp(-(1.0 - toCore) / 0.06) * exp(-lat * lat / 0.03);

  float n1 = fbm(d * 2.3 + 4.0, 6);
  float n2 = fbm(d * 5.5 + n1 * 1.5 + 9.0, 6);
  float lanes = smoothstep(-0.05, 0.30, fbm(d * 4.2 + 21.0 + n1 * 0.8, 7)) * exp(-lat * lat / 0.010);
  float glow = max(band * (0.55 + 1.3 * n1 + 0.7 * n2), 0.0);
  vec3 bandCol = mix(vec3(0.40, 0.50, 0.85), vec3(1.0, 0.80, 0.58), clamp(core * 1.4 + toCore * 0.35, 0.0, 1.0));
  vec3 col = bandCol * (glow * 0.040 * (0.35 + 0.65 * toCore) + core * 0.10);
  col += vec3(0.20, 0.25, 0.40) * wide * 0.004;
  col *= 1.0 - 0.88 * lanes;

  float dens = 0.30 + 0.55 * wide + 0.45 * band;
  vec3 stars = starLayer(d, 44.0, 0.20, uSigma * 1.3, 5.5, uSeed.x * 91.0);
  stars += starLayer(d, 105.0, 0.22 * dens, uSigma, 1.5, uSeed.y * 57.0);
  stars += starLayer(d, 220.0, 0.20 * dens, uSigma * 0.9, 0.5, uSeed.z * 33.0);
  stars += starLayer(d, 390.0, 0.26 * dens, uSigma * 0.8, 0.17, uSeed.x * 13.0 + 5.0);
  col += stars * (1.0 - 0.7 * lanes);

  for (int i = 0; i < ${NEBULAE}; i++) {
    float m = smoothstep(uNebPar[i].x, 1.0, dot(d, uNebDir[i]));
    if (m <= 0.0) continue;
    vec3 np = d * uNebPar[i].z + uNebPar[i].w;
    float w = fbm(np * 0.6 + 3.0, 5);
    float f = fbm(np + w * 2.0, 7);
    float wisp = pow(clamp(0.5 + f * 1.15, 0.0, 1.0), 3.0);
    float fil = pow(ridged(np * 1.6 + w, 6), 4.0);
    vec3 nc = mix(uNebCol[i], uNebCol[i].gbr, smoothstep(0.0, 0.45, w + f * 0.5));
    col += nc * (wisp * 0.8 + fil * 0.3) * m * m * uNebPar[i].y;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform samplerCube uSky;
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(textureCube(uSky, vDir).rgb, 1.0);
}
`;

const NEIGHBOUR_VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vColor = color;
  vUv = uv;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}
`;
const NEIGHBOUR_FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
void main() {
  float r2 = dot(vUv, vUv);
  gl_FragColor = vec4(vColor * (exp(-r2 * 9.0) + 0.06 * exp(-r2 * 2.5)) * (1.0 - smoothstep(0.8, 1.0, r2)), 1.0);
}
`;

// Typical luminosity (solar units) and tint per spectral class, for stars of other systems.
const CLASS_LUM: Record<StarClass, number> = { O: 30000, B: 800, A: 40, F: 4, G: 1, K: 0.4, M: 0.05, WD: 0.01, NS: 0.01, BH: 0.005 };
const CLASS_TINT: Record<StarClass, [number, number, number]> = {
  O: [0.60, 0.72, 1.0], B: [0.70, 0.80, 1.0], A: [0.85, 0.90, 1.0], F: [1.0, 1.0, 0.94], G: [1.0, 0.93, 0.78],
  K: [1.0, 0.78, 0.55], M: [1.0, 0.58, 0.38], WD: [0.82, 0.90, 1.0], NS: [0.70, 0.85, 1.0], BH: [1.0, 0.55, 0.30],
};

/**
 * The background of space. The sky of a system is baked into a cube map once; each frame only a
 * textured box is drawn. The same cube map feeds reflections (prefiltered) and the black hole's lensing.
 */
export class Sky {
  /** Box around the camera that shows the baked sky. */
  readonly mesh: Mesh;
  /** Prefiltered environment map of the current sky. */
  envMap: Texture | null = null;
  private readonly skyMat: ShaderMaterial;
  private readonly bakeMat: ShaderMaterial;
  private readonly bakeScene = new Scene();
  private readonly neighbourMat: ShaderMaterial;
  private neighbours: Mesh | null = null;
  private cubeRT: WebGLCubeRenderTarget | null = null;
  private cubeCam: CubeCamera | null = null;
  private pmrem: PMREMGenerator | null = null;
  private envRT: WebGLRenderTarget | null = null;
  private key = '';

  constructor() {
    const box = new BoxGeometry(2, 2, 2);
    this.skyMat = new ShaderMaterial({
      vertexShader: DIR_VERT, fragmentShader: SKY_FRAG, uniforms: { uSky: { value: null } },
      side: BackSide, depthTest: false, depthWrite: false,
    });
    this.mesh = new Mesh(box, this.skyMat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;

    const vecs = (): Vector3[] => Array.from({ length: NEBULAE }, () => new Vector3(0, 1, 0));
    this.bakeMat = new ShaderMaterial({
      vertexShader: DIR_VERT, fragmentShader: BAKE_FRAG,
      uniforms: {
        uSeed: { value: new Vector3() },
        // The galactic plane is the same from every system, tilted against the systems' reference plane.
        uGalN: { value: new Vector3(0.42, 0.84, 0.34).normalize() },
        uGalC: { value: new Vector3(0.84, -0.42, 0).normalize() },
        uSigma: { value: 0.001 },
        uNebDir: { value: vecs() },
        uNebCol: { value: vecs() },
        uNebPar: { value: Array.from({ length: NEBULAE }, () => new Vector4()) },
      },
      side: BackSide, depthTest: false, depthWrite: false,
    });
    const bakeBox = new Mesh(box, this.bakeMat);
    bakeBox.frustumCulled = false;
    this.bakeScene.add(bakeBox);
    this.neighbourMat = new ShaderMaterial({
      vertexShader: NEIGHBOUR_VERT, fragmentShader: NEIGHBOUR_FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
    });
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
    this.setNeighbours(system, galaxy, texel);

    this.cubeCam!.update(renderer, this.bakeScene);
    this.skyMat.uniforms.uSky!.value = this.cubeRT.texture;

    this.pmrem ??= new PMREMGenerator(renderer);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture);
    this.envMap = this.envRT.texture;
  }

  private setSeed(id: string, texel: number): void {
    const rnd = seededRandom(hashString(id));
    const u = this.bakeMat.uniforms;
    (u.uSeed!.value as Vector3).set(rnd(), rnd(), rnd());
    u.uSigma!.value = texel * 0.8;
    // Emission red, oxygen teal, reflection blue, violet, amber.
    const palette: [number, number, number][] = [
      [1.0, 0.22, 0.30], [0.15, 0.75, 0.80], [0.25, 0.40, 1.0], [0.65, 0.25, 1.0], [1.0, 0.55, 0.20],
    ];
    const dirs = u.uNebDir!.value as Vector3[];
    const cols = u.uNebCol!.value as Vector3[];
    const pars = u.uNebPar!.value as Vector4[];
    for (let i = 0; i < NEBULAE; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      dirs[i]!.set(r * Math.cos(a), z, r * Math.sin(a));
      const p = palette[Math.floor(rnd() * palette.length)]!;
      cols[i]!.set(p[0], p[1], p[2]);
      const size = 0.25 + rnd() * 0.55;
      // x: cosine of the angular radius, y: strength, z: noise frequency, w: noise offset.
      pars[i]!.set(Math.cos(size), 0.05 + rnd() * rnd() * 0.22, 2.2 + rnd() * 2.5, rnd() * 40);
    }
  }

  /** Stars of the other known systems as small quads in their true direction. */
  private setNeighbours(system: SystemDef, galaxy: GalaxyView | null, texel: number): void {
    if (this.neighbours) {
      this.bakeScene.remove(this.neighbours);
      this.neighbours.geometry.dispose();
      this.neighbours = null;
    }
    if (!galaxy) return;
    const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
    const n = new Vector3(), t = new Vector3(), b = new Vector3(), up = new Vector3();
    const half = texel * 5;
    for (const sector of galaxy.sectors) {
      for (const s of sector.systems) {
        if (s.id === system.id) continue;
        n.set(s.pos[0] - system.pos[0], s.pos[1] - system.pos[1], s.pos[2] - system.pos[2]);
        const ly = n.length();
        if (!(ly > 1e-6)) continue;
        n.divideScalar(ly);
        up.set(0, 1, 0);
        if (Math.abs(n.y) > 0.9) up.set(1, 0, 0);
        t.crossVectors(n, up).normalize();
        b.crossVectors(n, t);
        const apparent = CLASS_LUM[s.starClass] / (ly * ly);
        const gain = Math.min(7, Math.max(0.9, 3.2 + 0.9 * Math.log10(apparent)));
        const tint = CLASS_TINT[s.starClass];
        const base = pos.length / 3;
        for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          pos.push(n.x + (t.x * cx + b.x * cy) * half, n.y + (t.y * cx + b.y * cy) * half, n.z + (t.z * cx + b.z * cy) * half);
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
    this.neighbours = new Mesh(geo, this.neighbourMat);
    this.neighbours.frustumCulled = false;
    this.neighbours.renderOrder = 1;
    this.bakeScene.add(this.neighbours);
  }

  dispose(): void {
    this.cubeRT?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.neighbours?.geometry.dispose();
    this.mesh.geometry.dispose();
    this.skyMat.dispose();
    this.bakeMat.dispose();
    this.neighbourMat.dispose();
  }
}
