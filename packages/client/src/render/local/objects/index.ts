/**
 * Solid things near the camera: ships, stations, gates, beacons, asteroids, cargo pods, missiles
 * and the cockpit, plus the lights of both local scenes.
 */
import { Group } from 'three';
import type { Part } from '../part.ts';

/** Placeholder: draws nothing yet. */
export function createObjects(): Part {
  return {
    root: new Group(),
    cockpitRoot: new Group(),
    init: () => Promise.resolve(),
    update: () => {},
    dispose: () => {},
  };
}
