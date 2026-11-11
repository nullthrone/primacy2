import type { GameAudio } from '../audio/index.ts';
import type { GameApi, GameRenderer } from '../contracts.ts';

export interface GameDeps {
  canvas: HTMLCanvasElement;
  renderer: GameRenderer;
  audio: GameAudio;
}

export interface Game extends GameApi {
  /** Starts the frame loop. */
  start(): void;
}

/** Placeholder until the game core is implemented. */
export function createGame(_deps: GameDeps): Game {
  throw new Error('The game core is not implemented yet.');
}
