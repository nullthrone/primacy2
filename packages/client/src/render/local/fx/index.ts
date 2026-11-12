/**
 * Self-lit effects near the camera: weapon fire, impacts, explosions, mining beams, jump flashes
 * and the dust that gives a sense of speed.
 */
import { Group } from 'three';
import type { Part } from '../part.ts';

/** Placeholder: draws nothing yet. */
export function createFx(): Part {
  return {
    root: new Group(),
    init: () => Promise.resolve(),
    update: () => {},
    dispose: () => {},
  };
}
