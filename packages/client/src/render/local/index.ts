/**
 * The local layer: everything near the camera. It is assembled from independent parts (see
 * `part.ts`); a part that fails to load is reported and left out, so one broken part never keeps
 * the game from starting.
 */
import { Scene, type WebGLRenderer } from 'three';
import type { FrameView, Lighting, LocalLayer } from '../../contracts.ts';
import type { Part, PartName } from './part.ts';

const LOADERS: Record<PartName, () => Promise<Part>> = {
  objects: async () => (await import('./objects/index.ts')).createObjects(),
  fx: async () => (await import('./fx/index.ts')).createFx(),
};

export const ALL_PARTS: readonly PartName[] = ['objects', 'fx'];

export function createLocalLayer(names: readonly PartName[] = ALL_PARTS): LocalLayer {
  const scene = new Scene();
  const cockpit = new Scene();
  const parts: Part[] = [];

  return {
    scene,
    cockpit,

    async init(renderer: WebGLRenderer): Promise<void> {
      const loaded = await Promise.all(names.map(async (name) => {
        try {
          const part = await LOADERS[name]();
          await part.init(renderer);
          return part;
        } catch (err) {
          console.error(`local layer: part "${name}" failed to start`, err);
          return null;
        }
      }));
      for (const part of loaded) {
        if (!part) continue;
        parts.push(part);
        scene.add(part.root);
        if (part.cockpitRoot) cockpit.add(part.cockpitRoot);
      }
    },

    update(view: FrameView, light: Lighting): void {
      for (const part of parts) part.update(view, light);
    },

    dispose(): void {
      for (const part of parts) part.dispose();
      parts.length = 0;
      scene.clear();
      cockpit.clear();
    },
  };
}
