/**
 * The light effects throw on what is near them: a blast on the hull beside it, a muzzle flash on
 * the ship that fired, a beam on the plating around its ends, and all of them on the inside of
 * the cockpit.
 *
 * Three compiles a material for the number of lights in its scene, and every lit pixel pays for
 * each light whether it shines or not. So the lights here are a fixed few, made once and never
 * hidden: a light without a source has intensity 0. Each frame the effects name their sources and
 * the strongest as seen from the camera get the lights.
 *
 *   begin(frame)     once per frame, by the effects part
 *   add(...)         a source for this frame only; whatever glows for longer calls it every frame
 *   pulse(...)       a source that starts now and fades by itself, for events that arrive once
 *   end()            chooses, writes the lights and forgets the frame's sources
 *
 * Sources are kept until `end`, not dropped by `begin`, so a part that updates before the effects
 * part may add its own. Positions are in the axes of the zone's frame (see `core.ts`), like
 * everything the effects write; the group of lights hangs in the effects part, which turns into
 * system axes as a whole.
 *
 * A light stays on the source it has for as long as that source is among the strongest, and a
 * source that loses its light, or goes out between two frames, lets it fade over a few frames. A
 * light is only moved while it is dark.
 */
import { Group, PointLight } from 'three';
import { CabinGlow } from '../objects/lights.ts';
import { Pool, type Frame } from './core.ts';

/** Lights in the local scene. */
const LIGHTS = 3;
/** Sources kept per frame to choose among: more than there are lights, so a light can stay with its source. */
const KEEP = 8;
/** Sources this close together, metres, count as one; a blast is several glows in one place. */
const MERGE = 1.5;
/** A source this close, metres, to where a light stood a frame ago is the source that light is on. */
const SAME = 10;
/** How much stronger another source must be to take the light from the source that has it. */
const HOLD = 1.5;
/** Seconds a light takes to go dark once its source is gone. */
const FADE = 0.05;
/** A source that had dropped below this share of its peak when it went leaves nothing to fade. */
const SPENT = 0.03;
/**
 * The cockpit's one light stands for the strongest source outside: in its direction, this far
 * from the pilot's eye at most (metres) and no nearer than `NEAR`, with the strength that gives
 * the cabin what the source itself would. Far enough out that the light falls across the whole
 * dashboard from one side, near enough to stay inside the cockpit's depth range.
 */
const OUT = 4;
const NEAR = 1.5;
/**
 * The share of a source's light that the canopy lets in. The cabin is pale and matt where a hull
 * is dark metal, so the light that only just shows on a hull would bleach the dashboard.
 */
const CANOPY = 0.45;

interface Source {
  /** Relative to the camera, zone axes. */
  x: number; y: number; z: number;
  /** Colour times intensity. */
  r: number; g: number; b: number;
  reach: number;
  /** Brightness as seen from the camera: intensity over squared distance. */
  score: number;
  /** The light that stands where this source is, or -1. */
  slot: number;
  chosen: boolean;
}

interface Slot {
  readonly light: PointLight;
  /** Where its source is, relative to the zone anchor: that does not move when the camera does. */
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  reach: number;
  /** 1 while it has its source, falling to 0 after; 0 is dark and free. */
  fade: number;
  /** The most its source gave it, to tell a source that died down from one that was cut off. */
  peak: number;
  held: boolean;
}

/** A source with a life of its own: bright at once and fading, like the flashes in `particles.ts`. */
interface Pulse {
  /** Relative to the zone anchor, or to the entity it moves with. */
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  reach: number;
  age: number; life: number;
  follow: number;
}

const makeSlot = (): Slot => ({
  // Decay 2 is the physical falloff, and the ground only takes light from lamps that have one.
  light: new PointLight(0xffffff, 0, 1, 2),
  x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, reach: 1, fade: 0, peak: 0, held: false,
});

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The share of a light that is left at `d` metres when it is cut off at `reach`, as three computes it. */
function within(d: number, reach: number): number {
  const q = d / reach;
  const w = 1 - q * q * q * q;
  return w > 0 ? w * w : 0;
}

const V: [number, number, number] = [0, 0, 0];

/** Rotates (x, y, z) by the quaternion q into `V`. */
function turn(qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number): void {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  V[0] = x + qw * tx + (qy * tz - qz * ty);
  V[1] = y + qw * ty + (qz * tx - qx * tz);
  V[2] = z + qw * tz + (qx * ty - qy * tx);
}

export class EffectLights {
  /** The lights of the local scene; a child of the effects part's root, which must stay visible. */
  readonly group = new Group();
  /** The light of the cockpit scene; to be turned like the effects part's root. */
  readonly cockpit = new Group();
  private readonly slots: Slot[] = [];
  private readonly cabin = makeSlot();
  private readonly kept: Source[] = [];
  private count = 0;
  private readonly pulses = new Pool<Pulse>(64, () => ({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, reach: 1, age: 0, life: 1, follow: -1 }));
  private f: Frame | null = null;

  constructor() {
    for (let i = 0; i < LIGHTS; i++) {
      const s = makeSlot();
      this.slots.push(s);
      this.group.add(s.light);
    }
    for (let i = 0; i < KEEP; i++) this.kept.push({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, reach: 1, score: 0, slot: -1, chosen: false });
    // Nothing in the cockpit scene is farther from this light than the cabin is wide.
    this.cabin.light.distance = 0;
    this.cockpit.add(this.cabin.light);
  }

  /** Takes in the frame the sources of this frame belong to. */
  begin(f: Frame): void {
    this.f = f;
  }

  /**
   * A source of light for this frame. Position relative to the camera in zone axes, metres;
   * colour linear, about unit brightness; `intensity` in three's unit for a point light (it lights
   * a surface facing it at d metres like a sun of intensity / d^2); `reach` in metres is where its
   * light ends.
   */
  add(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, reach: number): void {
    if (!(intensity > 0) || !(reach > 0)) return;
    r *= intensity; g *= intensity; b *= intensity;
    const score = luma(r, g, b) / Math.max(x * x + y * y + z * z, 1);
    const kept = this.kept;
    let weakest = 0;
    for (let i = 0; i < this.count; i++) {
      const k = kept[i]!;
      const dx = k.x - x, dy = k.y - y, dz = k.z - z;
      if (dx * dx + dy * dy + dz * dz < MERGE * MERGE) {
        k.r += r; k.g += g; k.b += b;
        k.reach = Math.max(k.reach, reach);
        k.score += score;
        return;
      }
      if (k.score < kept[weakest]!.score) weakest = i;
    }
    let k: Source;
    if (this.count < KEEP) k = kept[this.count++]!;
    else if (score > kept[weakest]!.score) k = kept[weakest]!;
    else return;
    k.x = x; k.y = y; k.z = z; k.r = r; k.g = g; k.b = b; k.reach = reach; k.score = score;
  }

  /**
   * A source that starts now at `intensity` and fades to nothing over `life` seconds. Position
   * relative to the zone anchor, as game events give it, or relative to the entity `follow` when
   * the source moves with one. The rest as for `add`.
   */
  pulse(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, reach: number,
        life: number, follow = -1): void {
    const p = this.pulses.take();
    if (!p) return;
    p.x = x; p.y = y; p.z = z;
    p.r = r * intensity; p.g = g * intensity; p.b = b * intensity;
    p.reach = reach; p.age = 0; p.life = life; p.follow = follow;
  }

  /** Chooses the sources that get a light, sets the lights and forgets the sources of this frame. */
  end(): void {
    const f = this.f;
    if (!f) { this.count = 0; return; }

    const pulses = this.pulses.items;
    for (let i = this.pulses.count - 1; i >= 0; i--) {
      const p = pulses[i]!;
      p.age += f.dt;
      if (p.age >= p.life) { this.pulses.free(i); continue; }
      let x = p.x + f.zx, y = p.y + f.zy, z = p.z + f.zz;
      if (p.follow >= 0) {
        const host = f.tracks.get(p.follow);
        if (!host) { this.pulses.free(i); continue; }
        x += host.x; y += host.y; z += host.z;
      }
      const u = 1 - p.age / p.life;
      this.add(x, y, z, p.r, p.g, p.b, u * u, p.reach);
    }

    // At the lowest quality the lights are in the scene, as always, and stay dark.
    const n = f.quality > 0 ? this.count : 0;
    this.count = 0;
    const kept = this.kept, slots = this.slots;

    for (let i = 0; i < n; i++) {
      const k = kept[i]!;
      k.slot = this.standing(k);
      k.chosen = false;
    }
    for (let i = 0; i < LIGHTS; i++) slots[i]!.held = false;
    // The strongest first, the source a light is already on counting for more than it is.
    for (let pick = 0; pick < LIGHTS; pick++) {
      let best: Source | null = null, rank = 0;
      for (let i = 0; i < n; i++) {
        const k = kept[i]!;
        const s = k.slot >= 0 ? k.score * HOLD : k.score;
        if (!k.chosen && s > rank) { best = k; rank = s; }
      }
      if (!best) break;
      best.chosen = true;
      let slot = best.slot >= 0 && !slots[best.slot]!.held ? slots[best.slot]! : null;
      for (let i = 0; i < LIGHTS && !slot; i++) if (slots[i]!.fade === 0 && !slots[i]!.held) slot = slots[i]!;
      // No light is dark yet: this source gets one in a few frames, when another has faded.
      if (slot) this.put(slot, best.x, best.y, best.z, best.r, best.g, best.b, best.reach);
    }
    for (let i = 0; i < LIGHTS; i++) {
      const s = slots[i]!;
      this.settle(s);
      s.light.position.set(s.x + f.zx, s.y + f.zy, s.z + f.zz);
      s.light.distance = s.reach;
    }

    // The cockpit: what the strongest source sends in through the canopy, from one light near by.
    const cabin = this.cabin;
    cabin.held = false;
    const view = f.view;
    if (n > 0 && view.camera.mode === 'cockpit' && view.self) {
      const q = view.camera.rot;
      let best: Source | null = null, most = 0, gain = 0;
      for (let i = 0; i < n; i++) {
        const k = kept[i]!;
        const d = Math.hypot(k.x, k.y, k.z);
        if (d < 1e-3) continue;
        // The direction of the source in the cabin's own axes: zone axes to system axes, then back by the view.
        turn(f.qx, f.qy, f.qz, f.qw, k.x / d, k.y / d, k.z / d);
        turn(-q[0], -q[1], -q[2], q[3], V[0], V[1], V[2]);
        const at = Math.max(d, NEAR), out = Math.min(at, OUT);
        // Times the source's own strength this is the strength the light near by must have.
        const g = CANOPY * within(d, k.reach) * CabinGlow.open(V[0], V[1], V[2]) * (out * out) / (at * at);
        const dx = k.x - f.zx - cabin.x, dy = k.y - f.zy - cabin.y, dz = k.z - f.zz - cabin.z;
        const same = cabin.fade > 0 && dx * dx + dy * dy + dz * dz < SAME * SAME;
        const e = luma(k.r, k.g, k.b) * g / (out * out) * (same ? HOLD : 1);
        if (e > most) { best = k; most = e; gain = g; k.slot = same ? 0 : -1; }
      }
      if (best && (best.slot === 0 || cabin.fade === 0)) {
        this.put(cabin, best.x, best.y, best.z, best.r * gain, best.g * gain, best.b * gain, 1);
      }
    }
    this.settle(cabin);
    const cx = cabin.x + f.zx, cy = cabin.y + f.zy, cz = cabin.z + f.zz;
    const d = Math.hypot(cx, cy, cz) || 1;
    const k = Math.min(Math.max(d, NEAR), OUT) / d;
    cabin.light.position.set(cx * k, cy * k, cz * k);
  }

  /** Everything dark at once, and nothing pending: the zone is gone or its anchor has changed. */
  off(): void {
    this.count = 0;
    this.pulses.count = 0;
    for (let i = 0; i < LIGHTS; i++) {
      this.slots[i]!.fade = 0;
      this.slots[i]!.light.intensity = 0;
    }
    this.cabin.fade = 0;
    this.cabin.light.intensity = 0;
  }

  /** The lit light that stands where the source `k` is, or -1. */
  private standing(k: Source): number {
    const f = this.f!;
    const x = k.x - f.zx, y = k.y - f.zy, z = k.z - f.zz;
    let found = -1, near = SAME * SAME;
    for (let i = 0; i < LIGHTS; i++) {
      const s = this.slots[i]!;
      if (s.fade === 0) continue;
      const dx = s.x - x, dy = s.y - y, dz = s.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < near) { found = i; near = d2; }
    }
    return found;
  }

  /** Gives the light of `s` to the source at (x, y, z) relative to the camera, for this frame. */
  private put(s: Slot, x: number, y: number, z: number, r: number, g: number, b: number, reach: number): void {
    const f = this.f!;
    const level = luma(r, g, b);
    s.peak = s.fade === 0 ? level : Math.max(s.peak, level);
    s.x = x - f.zx; s.y = y - f.zy; s.z = z - f.zz;
    s.r = r; s.g = g; s.b = b;
    s.reach = reach;
    s.fade = 1;
    s.held = true;
  }

  /** Fades a light that has no source this frame, and writes colour and strength of any. */
  private settle(s: Slot): void {
    if (!s.held && s.fade > 0) {
      const spent = luma(s.r, s.g, s.b) < SPENT * s.peak;
      s.fade = spent ? 0 : Math.max(0, s.fade - this.f!.dt / FADE);
    }
    s.light.color.setRGB(s.r, s.g, s.b);
    s.light.intensity = s.fade;
  }
}

/** The one set of effect lights; any part of the local layer may add sources to it. */
export const effectLights = new EffectLights();
