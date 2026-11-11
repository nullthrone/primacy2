import type { GameRenderer } from '../contracts.ts';

/** Placeholder until the renderer is implemented. */
export function createRenderer(_canvas: HTMLCanvasElement): GameRenderer {
  throw new Error('The renderer is not implemented yet.');
}
