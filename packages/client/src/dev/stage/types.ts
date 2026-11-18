/**
 * The effect stage of the dev page (`/dev/local.html?scene=fx`): one effect at a time, close to
 * the camera, repeating. An act is a small script that puts ships on the stage and sends the game
 * events an effect is started by; the families of acts live in the files beside this one.
 */
import type { GameEvent, Quat, Vec3 } from '@primacy2/shared';
import type { EntityView } from '../../contracts.ts';

/** What an act is given each frame, and fills in. */
export interface StageFrame {
  /** Seconds into the current repetition of the act. */
  t: number;
  /** The same one frame earlier; below zero on the first frame of a repetition. */
  prev: number;
  /** Scene clock and frame time, seconds (slowed by `slow`). */
  clock: number;
  dt: number;
  /** How often the act has repeated. */
  round: number;
  /** Distance of the action from the camera, metres (`range`, default 60). */
  dist: number;
  /** The hull the act is about (`hull`, default wisp): the ship that is hit, blows up, arrives. */
  hull: string;
  /** Id of the pilot's own ship when the stage has one (`own=1`, or the cockpit camera), else null. */
  ownId: number | null;
  ents: EntityView[];
  events: GameEvent[];
  /** A point x metres to the right, y up and z ahead of the camera, as a camera-relative position. */
  rel(x: number, y: number, z: number): Vec3;
  /** A camera-relative position as events carry it: relative to the zone anchor. */
  at(rel: Vec3): Vec3;
  /** A direction or velocity given in camera axes (x right, y up, z ahead), in system axes. */
  dir(x: number, y: number, z: number): Vec3;
  /** The orientation of a ship whose nose points along a direction given in camera axes. */
  facing(x: number, y: number, z: number): Quat;
  ship(id: number, hull: string, rel: Vec3, rot: Quat, extra?: Partial<EntityView>): EntityView;
  /** True in the one frame in which `t` passes `time`. */
  crossed(time: number): boolean;
  /** True `perSecond` times a second, the first time `phase` seconds into the act. */
  ticked(perSecond: number, phase?: number): boolean;
}

export interface Act {
  /** What the act shows, in one line; printed in the corner of the page. */
  note: string;
  /** Seconds after which it starts over; `every=<s>` on the page overrides it. */
  period: number;
  frame(f: StageFrame): void;
}
