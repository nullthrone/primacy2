/**
 * The game's sound. It plays the files of the sound library that the owner has approved
 * (`public/audio`, written by `tools/audio/ship.py`), on the stage of the audition page.
 *
 *   library.ts   the shipped manifest and the decoded files, loaded from the start of the page
 *   stage.ts     the audio graph: places, two channels, the cabin's room, the limiter
 *   cues.ts      the mapping from a frame view to what should sound, as a pure function
 *   mixer.ts     makes the stage sound like the mapping says
 *
 * The concept is "you hear your ship, not space" (`tools/audio/SOUND_DESIGN.md`). An event of the
 * game without an approved sound is silent; `public/audio/manifest.json` lists those under `silent`.
 */
import type { FrameView } from '../contracts.ts';
import { cue, initialCueState, type CueState, type Mix } from './cues.ts';
import { Library } from './library.ts';
import { Mixer } from './mixer.ts';
import { Stage } from './stage.ts';

export type UiSound = 'click' | 'hover' | 'open' | 'close' | 'confirm' | 'deny' | 'notice' | 'warning';

export interface GameAudio {
  /** Called once per frame; makes the ship sound as the view and its events say. */
  update(view: FrameView | null): void;
  /** Plays a short interface sound. */
  ui(sound: UiSound): void;
  /** Browsers only allow audio after a user gesture; call from the first click or key press. */
  unlock(): void;
  /** 0..1 */
  setVolume(volume: number): void;
}

/** The event or role each interface sound plays; null makes no sound. */
const UI: Record<UiSound, string | null> = {
  click: 'ui_click',
  hover: null,
  open: 'ui_confirm',
  close: 'ui_confirm',
  confirm: 'ui_confirm',
  deny: null,
  notice: 'ui_notice',
  warning: 'alarm_master_caution',
};

/** What `window.__audio` offers the browser check and the console. */
export interface AudioDebug {
  library: Library;
  stage: Stage;
  mixer: Mixer;
  /** The mix of the last frame and the state behind it. */
  mix: Mix | null;
  state: CueState;
}

export function createAudio(): GameAudio {
  const library = new Library();
  const stage = new Stage();
  const mixer = new Mixer(library, stage);
  let state = initialCueState();
  let silent = true;
  const debug: AudioDebug = { library, stage, mixer, mix: null, state };

  // Fetching and decoding need no click: by the time the pilot has logged in the sounds are there.
  library.start();
  void stage.prepare();

  const audio: GameAudio = {
    update(view) {
      const next = cue(state, view, Math.random);
      state = next.state;
      debug.mix = next.mix;
      debug.state = state;
      if (!view) {
        if (!silent) mixer.silence();
        silent = true;
        return;
      }
      silent = false;
      mixer.apply(next.mix);
    },
    ui(sound) {
      const event = UI[sound];
      if (event) mixer.fire({ event, pick: Math.random(), maxVoices: 3 });
    },
    unlock() {
      stage.unlock();
    },
    setVolume(volume) {
      stage.setVolume(volume);
    },
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => stage.setHidden(document.hidden));
    // Every button of the interface is a console switch.
    document.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('button, [role="button"]')) audio.ui('click');
    }, true);
    (window as unknown as { __audio?: AudioDebug }).__audio = debug;
  }
  return audio;
}
