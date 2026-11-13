/**
 * Everything that flies: other ships, wrecks, cargo pods, missiles and, in chase view, the pilot's
 * own ship. Entities come and go between frames, so the drawn objects are pooled: one per entity
 * id while it is in view, returned to a free list per model when it is gone.
 *
 * Near the ground of a landable body a ship shows where it stands to it: a ship hovering under
 * flight assist burns its attitude jets against gravity, one that is low enough has its landing
 * lamp on, and one that has landed is quiet, with idle engines and no jets.
 */
import { EntityFlag, EntityKind, FlightMode, G, HULLS } from '@primacy2/shared';
import { Group, Vector3, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';
import type { FrameView } from '../../../contracts.ts';
import { clamp01, damp, hash01, wrap } from '../util.ts';
import type { Exhaust } from './exhaust.ts';
import type { Glints } from './glints.ts';
import { GroundProbe, LAMP_DROP, LAMP_FORE, LANDING_LIGHT_HEIGHT, landingLampLevel } from './landing.ts';
import { isEmissive, type Model, type ModelLibrary } from './models.ts';

/** Below this projected radius in pixels a craft is drawn as a point of light instead. */
const POINT_BELOW_PX = 3;
/** Navigation lamps flash twice every this many seconds. */
const STROBE_PERIOD = 2.4;
/** Other ships are asked for their height above the ground, for the landing lamp, within this distance. */
const LAMP_RANGE = 30_000;
/** A landed ship keeps its landing lamp on at this level. */
const LAMP_PARKED = 0.45;

interface Craft {
  id: number;
  kind: number;
  /** `info.model` this craft was built for; compared each frame without building a key. */
  modelName: string;
  poolKey: string;
  model: Model;
  obj: Object3D;
  wreck: boolean;
  /** Own copy of the engine-glow material, so each ship throttles on its own. */
  engineMat: MeshStandardMaterial | null;
  engineFull: number;
  /** A wreck's own copies of the lamp materials: they flicker and die. */
  sparkMats: MeshStandardMaterial[];
  sparkFull: number[];
  thrust: number;
  boost: number;
  /** Smoothed attitude-jet levels, index-aligned with `model.jets`. */
  jets: Float32Array;
  /** Metres from the origin down to the underside of the hull, for the lamp under the nose. */
  belly: number;
  /** 0..1: how brightly the landing lamp burns this frame. */
  lamp: number;
  seen: number;
}

const tmp = new Vector3();
const axis = new Vector3();

export class Fleet {
  readonly group = new Group();
  private readonly byId = new Map<number, Craft>();
  private readonly active: Craft[] = [];
  private readonly free = new Map<string, Craft[]>();
  private readonly keys = new Map<string, string>();
  private own: Craft | null = null;
  private readonly probe = new GroundProbe();
  private frame = 0;
  /** 0..1: how far the landing light of the pilot's ship is on; set before `update`. */
  ownLamp = 0;
  /** Camera-relative position and radius of the pilot's ship while it is drawn, else radius 0. */
  readonly ownPos = new Vector3();
  ownRadius = 0;
  /** The nearest drawn craft other than the pilot's, for the shadow focus; radius 0 when none. */
  readonly nearPos = new Vector3();
  nearRadius = 0;

  constructor(private readonly lib: ModelLibrary, private readonly exhaust: Exhaust, private readonly glints: Glints) {}

  /** The model key for an entity's `info.model`, built once per distinct name. */
  private keyFor(kind: number, modelName: string): string {
    const ship = kind === EntityKind.Ship || kind === EntityKind.Wreck;
    const cacheKey = ship ? modelName : `=${modelName}`;
    let key = this.keys.get(cacheKey);
    if (!key) {
      key = ship ? `ship_${modelName}` : modelName || (kind === EntityKind.Missile ? 'missile' : 'cargo_pod');
      this.keys.set(cacheKey, key);
    }
    return key;
  }

  private acquire(id: number, kind: number, modelName: string, size: number): Craft | null {
    const key = this.keyFor(kind, modelName);
    const model = this.lib.get(key);
    if (!model) {
      this.lib.request(key, size);
      return null;
    }
    const wreck = kind === EntityKind.Wreck;
    const poolKey = wreck ? `${key}|wreck` : key;
    let craft = this.free.get(poolKey)?.pop();
    if (!craft) craft = this.build(model, poolKey, wreck);
    craft.id = id;
    craft.kind = kind;
    craft.modelName = modelName;
    craft.thrust = 0;
    craft.boost = 0;
    craft.jets.fill(0);
    craft.belly = (kind === EntityKind.Ship ? HULLS[modelName]?.belly : undefined) ?? model.radius * 0.2;
    craft.lamp = 0;
    this.group.add(craft.obj);
    return craft;
  }

  private build(model: Model, poolKey: string, wreck: boolean): Craft {
    const obj = this.lib.instantiate(model);
    const craft: Craft = {
      id: 0, kind: 0, modelName: '', poolKey, model, obj, wreck,
      engineMat: null, engineFull: 0, sparkMats: [], sparkFull: [],
      thrust: 0, boost: 0, jets: new Float32Array(model.jets.length), belly: 0, lamp: 0, seen: 0,
    };
    obj.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as MeshStandardMaterial;
      if (!mat.isMeshStandardMaterial) return;
      if (wreck) {
        if (isEmissive(mat) && mat.name !== 'emissive_engine') {
          const own = this.lib.materials.add(mat.clone());
          craft.sparkMats.push(own);
          craft.sparkFull.push(mat.emissiveIntensity);
          mesh.material = own;
        } else {
          mesh.material = this.lib.wreckMaterial(mat);
        }
      } else if (mat.name === 'emissive_engine') {
        if (!craft.engineMat) {
          craft.engineMat = this.lib.materials.add(mat.clone());
          craft.engineFull = mat.emissiveIntensity;
        }
        mesh.material = craft.engineMat;
      }
    });
    return craft;
  }

  private release(craft: Craft): void {
    this.group.remove(craft.obj);
    let list = this.free.get(craft.poolKey);
    if (!list) {
      list = [];
      this.free.set(craft.poolKey, list);
    }
    list.push(craft);
  }

  update(view: FrameView, pxPerRad: number): void {
    const frame = ++this.frame;
    const dt = view.dt;
    this.nearRadius = 0;
    let nearDist = Infinity;
    this.probe.begin(view);

    const ents = view.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      const kind = e.info.kind;
      if (kind !== EntityKind.Ship && kind !== EntityKind.Wreck && kind !== EntityKind.Loot && kind !== EntityKind.Missile) continue;
      let craft = this.byId.get(e.id);
      if (craft && (craft.kind !== kind || craft.modelName !== e.info.model)) {
        // The id now stands for something else (a ship that became a wreck, say).
        craft.seen = -1;
        this.byId.delete(e.id);
        craft = undefined;
      }
      if (!craft) {
        const made = this.acquire(e.id, kind, e.info.model, e.info.radius);
        if (!made) continue;
        craft = made;
        this.byId.set(e.id, craft);
        this.active.push(craft);
      }
      craft.seen = frame;
      const powered = kind === EntityKind.Ship || kind === EntityKind.Missile;
      const thrust = powered && (e.flags & (EntityFlag.Thrust | EntityFlag.Boost | EntityFlag.Cruise)) ? 1 : 0;
      const boost = powered && (e.flags & (EntityFlag.Boost | EntityFlag.Cruise)) ? 1 : 0;
      craft.thrust = damp(craft.thrust, thrust, 7, dt);
      craft.boost = damp(craft.boost, boost, 5, dt);
      // A ship low over the ground has its landing lamp on; one that stands on it keeps it burning low.
      craft.lamp = 0;
      if (kind === EntityKind.Ship) {
        if (e.flags & EntityFlag.Landed) craft.lamp = LAMP_PARKED;
        else if (Math.abs(e.rel[0]) + Math.abs(e.rel[1]) + Math.abs(e.rel[2]) < LAMP_RANGE) {
          craft.lamp = landingLampLevel(this.probe.height(e.rel[0], e.rel[1], e.rel[2], LANDING_LIGHT_HEIGHT) - craft.belly);
        }
      }
      const dist = this.place(craft, e.rel, e.rot, view, pxPerRad, e.hull);
      if (kind === EntityKind.Ship && dist < nearDist) {
        nearDist = dist;
        this.nearPos.set(e.rel[0], e.rel[1], e.rel[2]);
        this.nearRadius = craft.model.radius;
      }
    }

    // The pilot's own ship is drawn from outside only; in the cockpit its hull would block the view.
    const self = view.self;
    const wantOwn = self !== null && view.camera.mode === 'chase';
    if (this.own && (!wantOwn || this.own.modelName !== self.hull)) {
      this.release(this.own);
      this.own = null;
    }
    this.ownRadius = 0;
    if (wantOwn) {
      if (!this.own) this.own = this.acquire(self.id, EntityKind.Ship, self.hull, self.stats.radius);
      const own = this.own;
      if (own) {
        const t = self.input.thrust;
        const cruising = view.fx.cruise > 0 ? 1 : 0;
        // Standing on the ground the engines idle and no jet fires, whatever the throttle is set to.
        const landed = view.mode === FlightMode.Landed;
        own.thrust = damp(own.thrust, landed ? 0 : clamp01(Math.max(t[2], self.input.throttle, cruising)), 7, dt);
        own.boost = damp(own.boost, !landed && (view.fx.boosting || cruising) ? 1 : 0, 5, dt);
        // Over a landable body flight assist holds the ship up against gravity: the jets that push
        // away from the ground burn all the time, the harder the less thrust the hull has to spare.
        let hx = 0, hy = 0, hz = 0;
        const surface = view.surface;
        const over = surface?.ship;
        if (surface && over && !landed && self.state.fa && view.mode === FlightMode.Normal) {
          const body = view.system.bodies[surface.body]!;
          const rr = over.pos[0] * over.pos[0] + over.pos[1] * over.pos[1] + over.pos[2] * over.pos[2];
          const hold = Math.min(1, (G * body.mass) / (Math.max(rr, 1) * Math.max(self.stats.accelVert, 0.1)));
          // Straight up, in ship axes: the ship's orientation undone.
          const q = self.rot;
          const u = over.up;
          const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
          const ax = 2 * (qy * u[2] - qz * u[1]), ay = 2 * (qz * u[0] - qx * u[2]), az = 2 * (qx * u[1] - qy * u[0]);
          hx = (u[0] + qw * ax + (qy * az - qz * ay)) * hold;
          hy = (u[1] + qw * ay + (qz * ax - qx * az)) * hold;
          hz = -(u[2] + qw * az + (qx * ay - qy * ax)) * hold;
        }
        // Thrust is [right, up, forward] in ship axes; a jet fires when it pushes that way.
        const jets = own.model.jets;
        for (let k = 0; k < jets.length; k++) {
          const d = jets[k]!.dir;
          const push = landed ? 0 : -(d.x * (t[0] + hx) + d.y * (t[1] + hy) - d.z * (t[2] + hz));
          own.jets[k] = damp(own.jets[k]!, clamp01(push), 14, dt);
        }
        own.lamp = this.ownLamp;
        this.place(own, self.rel, self.rot, view, pxPerRad, 1);
        this.ownPos.set(self.rel[0], self.rel[1], self.rel[2]);
        this.ownRadius = own.model.radius;
      }
    }

    // Whatever was not in this frame's list is gone.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const craft = this.active[i]!;
      if (craft.seen === frame) continue;
      if (this.byId.get(craft.id) === craft) this.byId.delete(craft.id);
      this.release(craft);
      this.active[i] = this.active[this.active.length - 1]!;
      this.active.pop();
    }
  }

  /** Positions one craft and emits its exhaust, lamps and far-away point. Returns its distance. */
  private place(
    craft: Craft, rel: readonly number[], rot: readonly number[], view: FrameView, pxPerRad: number, salvage: number,
  ): number {
    const obj = craft.obj;
    const model = craft.model;
    const x = rel[0]!, y = rel[1]!, z = rel[2]!;
    const dist = Math.hypot(x, y, z);
    obj.position.set(x, y, z);
    obj.quaternion.set(rot[0]!, rot[1]!, rot[2]!, rot[3]!);
    obj.updateMatrix();

    const px = (model.radius / Math.max(dist, 1e-3)) * pxPerRad;
    obj.visible = px > 1;
    const quality = view.graphics.quality;

    if (craft.wreck) {
      // A few lamps still spark now and then; fewer as the wreck is cut up.
      for (let k = 0; k < craft.sparkMats.length; k++) {
        const slot = Math.floor(view.clock * 9 + k * 3.7);
        const spark = hash01(slot * 31 + craft.id * 977 + k) > 0.93 - 0.05 * salvage ? 1 : 0;
        craft.sparkMats[k]!.emissiveIntensity = craft.sparkFull[k]! * spark * (0.25 + 0.75 * salvage);
      }
    } else {
      const power = craft.thrust * (1 + 0.7 * craft.boost);
      if (craft.engineMat) craft.engineMat.emissiveIntensity = craft.engineFull * (0.03 + 0.97 * craft.thrust) * (1 + 0.6 * craft.boost);

      if (obj.visible) {
        const m = obj.matrix;
        if (power > 0.01) {
          axis.set(0, 0, 1).transformDirection(m);
          for (let k = 0; k < model.engines.length; k++) {
            const n = model.engines[k]!;
            tmp.copy(n.pos).applyMatrix4(m);
            this.exhaust.add(tmp, axis, n.radius, craft.thrust, craft.boost, craft.id * 7 + k);
          }
        }
        for (let k = 0; k < craft.jets.length; k++) {
          const level = craft.jets[k]!;
          if (level < 0.02) continue;
          const jet = model.jets[k]!;
          tmp.copy(jet.pos).applyMatrix4(m);
          axis.copy(jet.dir).transformDirection(m);
          this.exhaust.addJet(tmp, axis, Math.max(0.12, model.radius * 0.014), level, craft.id * 13 + k);
        }

        // Navigation strobes: two short flashes per period, each craft on its own phase.
        const phase = wrap(view.time + hash01(craft.id) * STROBE_PERIOD, STROBE_PERIOD);
        const flash = phase < 0.07 || (phase > 0.22 && phase < 0.29) ? 1 : 0;
        if (flash && (quality > 0 || craft === this.own)) {
          for (let k = 0; k < model.lamps.length; k++) {
            const p = model.lamps[k]!;
            tmp.copy(p).applyMatrix4(m);
            // Red to port, green to starboard, white on the centre line.
            const side = Math.abs(p.x) < model.radius * 0.08 ? 0 : p.x < 0 ? -1 : 1;
            this.glints.addLamp(tmp, side < 0 ? 1 : side > 0 ? 0.1 : 1, side < 0 ? 0.12 : side > 0 ? 1 : 0.95, side < 0 ? 0.08 : side > 0 ? 0.25 : 0.85, 0.16, 5, pxPerRad);
          }
        }
      }
      // The landing lamp under the nose: steady and warm, and seen from much farther than the hull.
      if (craft.lamp > 0.01) {
        tmp.set(0, -craft.belly - LAMP_DROP, -model.radius * LAMP_FORE).applyMatrix4(obj.matrix);
        this.glints.addLamp(tmp, 1, 0.95, 0.86, 0.22, 9 * craft.lamp, pxPerRad);
      }
      // A missile is tiny; its motor is what you see of it.
      if (craft.kind === EntityKind.Missile && craft.thrust > 0.05) {
        this.glints.addLamp(obj.position, 0.6, 0.8, 1, 0.35, 3 * craft.thrust, pxPerRad);
      }
    }

    if (px < POINT_BELOW_PX && craft.kind !== EntityKind.Missile) {
      this.glints.addBody(obj.position, dist, model.radius, model.albedo * (craft.wreck ? 0.2 : 1), 0, clamp01((POINT_BELOW_PX - px) / 1.5), pxPerRad);
    }
    return dist;
  }

  dispose(): void {
    this.group.clear();
    this.byId.clear();
    this.active.length = 0;
    this.free.clear();
    this.own = null;
  }
}
