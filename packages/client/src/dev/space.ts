/**
 * Development page for the space renderer: draws synthetic frame views of the demo sector.
 * Scenes: ?scene=menu|star|system|terran|ocean|desert|rocky|gas|icegiant|gasrings|lava|ice|
 * blackhole-far|blackhole-near|blackhole-disk|neutron|cruise|fold|close|belt|neighbour|info.
 * Options: q=0..2, bloom=0, probe=1 (spheres in the local scenes), camera overrides dist (body
 * radii), phase and elev (degrees), rs (black hole distance in Schwarzschild radii), clock (start
 * value of the page clock in seconds, to check long sessions), and effect overrides cruise, fold,
 * charge, kind, dil, heat, hit.
 */
import { anchorState, quat } from '@primacy2/shared';
import type { BodyDef, SystemDef, Vec3 } from '@primacy2/shared';
import { AmbientLight, DirectionalLight, Mesh, MeshStandardMaterial, Quaternion, Scene, SphereGeometry, Vector3 } from 'three';
import type { FrameFx, FrameView, Lighting, LocalLayer } from '../contracts.ts';
import { createRenderer } from '../render/Renderer.ts';
import { bodyAxis } from '../render/space/types.ts';
import { demoGalaxy, demoSector, makeView, type FakeViewOptions } from './fakeView.ts';

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'terran';
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  return v === null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v);
};
const T0 = 1_000_000;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const rad = (deg: number): number => (deg * Math.PI) / 180;

const systems = demoSector();
const galaxy = demoGalaxy(systems);

interface Found { sys: SystemDef; body: BodyDef }

function find(pred: (b: BodyDef) => boolean): Found | null {
  for (const sys of systems) {
    const body = sys.bodies.find(pred);
    if (body) return { sys, body };
  }
  return null;
}

/** A copy of the system with one body changed, for classes the demo sector lacks. */
function patched(f: Found, patch: Partial<BodyDef>): Found {
  const body = { ...f.body, ...patch };
  return { sys: { ...f.sys, bodies: f.sys.bodies.map((b) => (b.id === body.id ? body : b)) }, body };
}

function toSun(f: Found): Vec3 {
  if (f.body.id === 0) return [1, 0, 0];
  return norm(sub(anchorState(f.sys, 0, T0).pos, anchorState(f.sys, f.body.id, T0).pos));
}

/** Camera offset at `dist` metres, `phase` degrees away from the sun direction and `elev` degrees above it. */
function sunCam(f: Found, dist: number, phase: number, elev: number): Vec3 {
  const s = toSun(f);
  const side = norm(cross(s, [0, 1, 0]));
  const up = cross(side, s);
  const flat = add(scale(s, Math.cos(rad(phase))), scale(side, Math.sin(rad(phase))));
  return scale(add(scale(flat, Math.cos(rad(elev))), scale(up, Math.sin(rad(elev)))), dist);
}

/** Camera offset at `elev` degrees above the body's equatorial plane; the azimuth is chosen for a sun phase near `phase`. */
function axisCam(f: Found, dist: number, elev: number, phase: number): Vec3 {
  const ax = bodyAxis(f.body);
  const e1 = norm(cross(ax, Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const e2 = cross(ax, e1);
  const s = toSun(f);
  let best: Vec3 = e1, bestErr = Infinity;
  for (let az = 0; az < 360; az += 5) {
    const flat = add(scale(e1, Math.cos(rad(az))), scale(e2, Math.sin(rad(az))));
    const dir = add(scale(flat, Math.cos(rad(elev))), scale(ax, Math.sin(rad(elev))));
    const err = Math.abs(Math.acos(Math.max(-1, Math.min(1, dot(dir, s)))) - rad(phase));
    if (err < bestErr) { bestErr = err; best = dir; }
  }
  return scale(best, dist);
}

function byClass(cls: string): Found {
  const hit = find((b) => b.cls === cls);
  if (hit) return hit;
  const base = find((b) => b.kind === 'planet' && b.cls !== 'gas' && b.cls !== 'icegiant') ?? find((b) => b.kind === 'planet')!;
  return patched(base, { cls: cls as BodyDef['cls'] });
}

function buildScene(name: string): FakeViewOptions | null {
  const sys0 = systems[0]!;
  switch (name) {
    case 'menu':
      return null;
    case 'star': {
      const r = sys0.bodies[0]!.radius;
      return { system: sys0, anchor: 0, offset: [r * 3.6, r * 0.9, r * 2.6], lookAt: [r * 0.5, 0, -r * 0.5], fov: 50 };
    }
    case 'system': {
      let maxA = 0;
      for (const b of sys0.bodies) if (b.orbit && b.orbit.parent === 0) maxA = Math.max(maxA, b.orbit.a);
      return { system: sys0, anchor: 0, offset: scale(norm([0.55, 0.36, 0.75]), maxA * 0.9), fov: 60 };
    }
    case 'terran':
    case 'cruise':
    case 'fold': {
      const f = byClass('terran');
      const far = name === 'terran' ? 3.1 : 6;
      return { system: f.sys, anchor: f.body.id, offset: sunCam(f, f.body.radius * num('dist', far), num('phase', 52), num('elev', 14)), lookAt: [0, 0, 0], fov: 45 };
    }
    case 'close': {
      const f = byClass('terran');
      return { system: f.sys, anchor: f.body.id, offset: sunCam(f, f.body.radius * 1.05, 40, 10), lookAt: scale(sunCam(f, f.body.radius, 75, 30), 1), fov: 70 };
    }
    case 'gasrings': {
      let f = find((b) => b.cls === 'gas' && !!b.rings) ?? find((b) => !!b.rings);
      if (!f) {
        const g = byClass('gas');
        f = patched(g, { rings: { inner: g.body.radius * 1.35, outer: g.body.radius * 2.3, color: 0xcdbfa6, seed: 5 } });
      }
      return { system: f.sys, anchor: f.body.id, offset: axisCam(f, f.body.radius * num('dist', 5.6), num('elev', 16), num('phase', 58)), fov: 45 };
    }
    case 'lava':
    case 'ice':
    case 'ocean':
    case 'desert':
    case 'rocky':
    case 'gas':
    case 'icegiant': {
      const f = byClass(name);
      return { system: f.sys, anchor: f.body.id, offset: sunCam(f, f.body.radius * num('dist', 3.2), num('phase', name === 'lava' ? 95 : 55), num('elev', 12)), fov: 45 };
    }
    case 'blackhole-far':
    case 'blackhole-disk':
    case 'blackhole-near': {
      // far: the hole is small but resolved; disk: the whole accretion disk; near: 15 Schwarzschild radii out.
      const f = find((b) => b.cls === 'BH')!;
      const rs = f.body.rs ?? f.body.radius;
      const near = name === 'blackhole-near';
      const dist = num('rs', 0) > 0 ? rs * num('rs', 0) : near ? rs * 15 : name === 'blackhole-far' ? rs * 150 : (f.body.disk?.outer ?? rs * 500) * 3;
      return { system: f.sys, anchor: f.body.id, offset: axisCam(f, dist, num('elev', near ? 5 : 11), 60), fov: near ? 70 : 45 };
    }
    case 'neutron': {
      const f = find((b) => b.cls === 'NS')!;
      const dist = f.body.jets ? f.body.jets.length * 1.7 : f.body.radius * 3e4;
      return { system: f.sys, anchor: f.body.id, offset: axisCam(f, dist, 22, 60), fov: 50 };
    }
    case 'belt': {
      const f = find(() => false) ?? { sys: systems.find((s) => s.belts.length > 0) ?? sys0, body: sys0.bodies[0]! };
      const belt = f.sys.belts[0];
      const a = belt ? belt.outer : 3e11;
      return { system: f.sys, anchor: belt ? belt.parent : 0, offset: [a * 1.2, a * 0.45, a * 1.1], fov: 55 };
    }
    case 'neighbour': {
      const other = systems[1]!;
      const dir = norm(sub(other.pos, sys0.pos));
      return { system: sys0, anchor: 0, offset: [0, 6e12, 0], rot: quat.lookRotation(dir), fov: 30 };
    }
    default:
      return buildScene('terran');
  }
}

/** Prints what the demo sector contains, for choosing cameras. Uses console.error so the screenshot tool shows it. */
function dumpInfo(): void {
  const e = (x: number): string => x.toExponential(2);
  const lines: string[] = [];
  systems.forEach((sys, i) => {
    lines.push(`# ${i} ${sys.name} ${sys.starClass} pos=${sys.pos.map((p) => p.toFixed(1)).join(',')}`);
    for (const b of sys.bodies) {
      let s = ` b${b.id} ${b.kind} ${b.cls} r=${e(b.radius)} tilt=${b.tilt.toFixed(2)} seed=${b.seed} col=${b.color.toString(16)} T=${Math.round(b.temp)} rot=${e(b.rotPeriod)}`;
      if (b.orbit) s += ` par=${b.orbit.parent} a=${e(b.orbit.a)} inc=${b.orbit.inc.toFixed(2)}`;
      if (b.lum !== undefined) s += ` lum=${e(b.lum)}`;
      if (b.rs !== undefined) s += ` rs=${e(b.rs)}`;
      if (b.disk) s += ` disk=${e(b.disk.inner)}..${e(b.disk.outer)} ${b.disk.color.toString(16)}`;
      if (b.jets) s += ` jets=${e(b.jets.length)} ${b.jets.color.toString(16)}`;
      if (b.rings) s += ` rings=${e(b.rings.inner)}..${e(b.rings.outer)} ${b.rings.color.toString(16)}`;
      if (b.atmo) s += ` atmo=h${e(b.atmo.height)} d${b.atmo.density.toFixed(2)} ${b.atmo.color.toString(16)}`;
      lines.push(s);
    }
    for (const belt of sys.belts) lines.push(` belt${belt.id} par=${belt.parent} ${e(belt.inner)}..${e(belt.outer)} h=${e(belt.height)} ${belt.kind}`);
    for (const site of sys.sites) {
      if (site.kind !== 'ring' && site.kind !== 'belt') continue;
      // Normal of the site's orbital plane, measured from two positions a quarter period apart.
      const o = site.orbit;
      const p0 = sub(anchorState(sys, site.id, T0).pos, anchorState(sys, o.parent, T0).pos);
      const p1 = sub(anchorState(sys, site.id, T0 + o.period / 4).pos, anchorState(sys, o.parent, T0 + o.period / 4).pos);
      const n = norm(cross(p0, p1));
      const ax = bodyAxis(sys.bodies[o.parent]!);
      lines.push(` site ${site.kind} par=${o.parent} a=${e(o.a)} inc=${o.inc.toFixed(2)} node=${o.node.toFixed(2)} n=${n.map((v) => v.toFixed(2)).join(',')} axis=${ax.map((v) => v.toFixed(2)).join(',')}`);
    }
  });
  console.error(lines.join('\n'));
}

/** Stands in for the local layer: two empty scenes, or with probe=1 one lit sphere in each. */
class StubLocal implements LocalLayer {
  readonly scene = new Scene();
  readonly cockpit = new Scene();
  private readonly suns: DirectionalLight[] = [];
  private readonly far = new Mesh(new SphereGeometry(25, 48, 24), new MeshStandardMaterial({ color: 0x9aa4b0, roughness: 0.5, metalness: 0.3 }));
  private readonly near = new Mesh(new SphereGeometry(0.12, 32, 16), new MeshStandardMaterial({ color: 0xb08a4a, roughness: 0.4, metalness: 0.6 }));
  private readonly probe = params.get('probe') === '1';

  init(): Promise<void> {
    if (this.probe) {
      for (const [scene, mesh] of [[this.scene, this.far], [this.cockpit, this.near]] as const) {
        const sun = new DirectionalLight(0xffffff, 1);
        this.suns.push(sun);
        scene.add(mesh, sun, new AmbientLight(0xffffff, 0.06));
      }
    }
    return Promise.resolve();
  }

  update(view: FrameView, light: Lighting): void {
    if (!this.probe) return;
    const q = new Quaternion(view.camera.rot[0], view.camera.rot[1], view.camera.rot[2], view.camera.rot[3]);
    this.far.position.copy(new Vector3(-60, -20, -220).applyQuaternion(q));
    this.near.position.copy(new Vector3(0.35, -0.2, -1.2).applyQuaternion(q));
    for (const sun of this.suns) {
      sun.position.set(light.sunDir[0], light.sunDir[1], light.sunDir[2]);
      sun.color.setRGB(light.sunColor[0], light.sunColor[1], light.sunColor[2]);
      sun.intensity = light.sunIntensity;
    }
    for (const mesh of [this.far, this.near]) (mesh.material as MeshStandardMaterial).envMap = light.envMap;
  }

  dispose(): void {}
}

async function main(): Promise<void> {
  if (sceneName === 'info') dumpInfo();
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = createRenderer(canvas);
  const fit = (): void => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  fit();
  window.addEventListener('resize', fit);
  await renderer.init(new StubLocal());

  const opts = buildScene(sceneName === 'info' ? 'menu' : sceneName);
  const fx: Partial<FrameFx> = {
    cruise: num('cruise', sceneName === 'cruise' ? 0.8 : 0),
    fold: num('fold', sceneName === 'fold' ? 0.5 : 0),
    charge: num('charge', 0),
    chargeKind: num('kind', 0),
    dilation: num('dil', 1),
    heat: num('heat', 0.1),
    hitFlash: num('hit', 0),
  };
  const graphics = { quality: Math.min(2, Math.max(0, Math.round(num('q', 2)))) as 0 | 1 | 2, bloom: params.get('bloom') !== '0' };
  const start = performance.now();
  let frames = 0;
  const frame = (): void => {
    const clock = num('clock', 10) + (performance.now() - start) / 1000;
    if (opts) renderer.render(makeView({ ...opts, time: T0 + clock, clock, galaxy, fx, graphics }));
    else renderer.render(null);
    if (++frames === 20) (window as unknown as { __ready: boolean }).__ready = true;
    requestAnimationFrame(frame);
  };
  frame();
}

void main();
