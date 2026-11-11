/**
 * Entry point: builds the renderer, the game core, the UI and audio, and connects them.
 */
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/share-tech-mono/400.css';
import { createAudio } from './audio/index.ts';
import { createGame } from './game/Game.ts';
import { createLocalLayer } from './render/local/index.ts';
import { createRenderer } from './render/Renderer.ts';
import { loadSettings } from './state/store.ts';
import { mountUi } from './ui/index.tsx';

async function boot(): Promise<void> {
  loadSettings();
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = createRenderer(canvas);
  await renderer.init(createLocalLayer());
  const audio = createAudio();
  const game = createGame({ canvas, renderer, audio });
  mountUi(document.getElementById('ui')!, game, audio);
  game.start();
  // Exposed for automated tests and for debugging from the browser console.
  (window as unknown as { primacy2: unknown }).primacy2 = { game };
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('ui');
  if (el) {
    el.textContent = `PRIMACY2 could not start: ${err instanceof Error ? err.message : String(err)}`;
    el.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#ffb347;font:16px sans-serif;padding:2rem;text-align:center';
  }
});
