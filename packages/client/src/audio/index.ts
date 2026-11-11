import type { FrameView } from '../contracts.ts';

export type UiSound = 'click' | 'hover' | 'open' | 'close' | 'confirm' | 'deny' | 'notice' | 'warning';

export interface GameAudio {
  /** Called once per frame; drives engine, weapon and ambience sounds from the view and its events. */
  update(view: FrameView | null): void;
  /** Plays a short interface sound. */
  ui(sound: UiSound): void;
  /** Browsers only allow audio after a user gesture; call from the first click or key press. */
  unlock(): void;
  /** 0..1 */
  setVolume(volume: number): void;
}

/** Placeholder until the audio engine is implemented: silent. */
export function createAudio(): GameAudio {
  return { update() {}, ui() {}, unlock() {}, setVolume() {} };
}
