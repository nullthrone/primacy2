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
import { effect } from '@preact/signals';
import type { FrameView } from '../contracts.ts';
import { store } from '../state/store.ts';
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
  open: null,
  close: null,
  confirm: null,
  deny: null,
  notice: 'ui_notice',
  warning: 'alarm_master_caution',
};

/** A chat message older than this when it arrives is history, not a transmission (ms). */
const CHAT_FRESH_MS = 5000;

/** What `window.__audio` offers the browser check and the console. */
export interface AudioDebug {
  library: Library;
  stage: Stage;
  mixer: Mixer;
  /** The mix of the last frame and the state behind it. */
  mix: Mix | null;
  state: CueState;
  /** The recorder of the browser check, loaded on first use so that it is a chunk of its own and a player never fetches it. */
  capture?: () => Promise<{ start(): Promise<void>; stop(): Promise<unknown> }>;
}

export function createAudio(): GameAudio {
  const library = new Library();
  const stage = new Stage();
  const mixer = new Mixer(library, stage);
  let state = initialCueState();
  let silent = true;
  let lastChatAt = 0;
  const debug: AudioDebug = { library, stage, mixer, mix: null, state };
  let recorder: Promise<{ start(): Promise<void>; stop(): Promise<unknown> }> | null = null;
  debug.capture = () => (recorder ??= import('../dev/gameCapture.ts').then((m) => m.createGameCapture(stage, library)));

  // Fetching and decoding need no click: by the time the pilot has logged in the sounds are there.
  library.start();
  void stage.prepare();

  const audio: GameAudio = {
    update(view) {
      stage.nudge();
      // Between two systems the game has no view for a moment (the system is replaced while the ship is in the fold
      // tunnel, also when another server takes it over). The pilot still sits in the ship: what sounds goes on, and
      // the mapping keeps its state, so that the arrival is heard. Only the menu is silence.
      const phase = store.phase.peek();
      if (!view && (phase === 'playing' || phase === 'handoff')) return;
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

  // The radio: a message from somebody else arrives as a tone on the loudspeaker (voices are to come).
  effect(() => {
    const own = store.pilot.peek()?.id;
    let newest = lastChatAt;
    let news = false;
    for (const m of store.chat.value) {
      if (m.at <= lastChatAt) continue;
      newest = Math.max(newest, m.at);
      // Not the pilot's own words, and not what was said before he came (a server may send the last lines on arrival).
      if (m.from.id !== own && Date.now() - m.at < CHAT_FRESH_MS) news = true;
    }
    lastChatAt = newest;
    if (news) mixer.transmission('radio_tone');
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => stage.setHidden(document.hidden));
    // Browsers start sound only after a gesture. The game core unlocks from its own first click or key; these catch
    // every other way in (a start by controller creates the context without a gesture, and it stays suspended then).
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      document.addEventListener(type, () => stage.unlock(), { capture: true, passive: true });
    }
    // Every button of the interface is a console switch.
    document.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('button, [role="button"]')) audio.ui('click');
    }, true);
    (window as unknown as { __audio?: AudioDebug }).__audio = debug;
  }
  return audio;
}
