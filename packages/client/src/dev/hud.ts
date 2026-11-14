/**
 * The real interface over a development scene (`hud=1` on the dev page): the HUD the game
 * shows, fed with the scene's frame views through a stand-in for the game core. It shows what a
 * pilot would see over that view; nothing in it can be operated, since there is no game behind it.
 */
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/share-tech-mono/400.css';
import { quat, type Vec3 } from '@primacy2/shared';
import type { GameAudio } from '../audio/index.ts';
import type { FrameView, GameApi, ScreenPoint } from '../contracts.ts';
import { store } from '../state/store.ts';
import { mountUi } from '../ui/index.tsx';

/** Mounts the interface in the playing state. `view` gives the frame view last drawn; `lang` is `en` or `de`. */
export function mountDevHud(view: () => FrameView | null, lang: string | null): void {
  const root = document.createElement('div');
  root.id = 'ui';
  root.style.cssText = 'position:fixed;inset:0';
  document.body.appendChild(root);
  if (lang === 'en' || lang === 'de') store.settings.value = { ...store.settings.value, lang };
  store.phase.value = 'playing';
  store.pointerLocked.value = true;
  store.serverName.value = 'Dev';

  const api: GameApi = {
    get view() { return view(); },
    // The projection the game core uses (Game.ts), over the whole window.
    project(rel: Readonly<Vec3>): ScreenPoint {
      const v = view();
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (!v) return { x: w / 2, y: h / 2, visible: false, behind: true };
      const c = quat.unrotate(v.camera.rot, rel as Vec3);
      const tan = Math.tan((v.camera.fov * Math.PI) / 360);
      const depth = -c[2];
      const behind = depth <= 1e-6;
      const d = behind ? Math.max(1e-6, -depth) : depth;
      let nx = c[0] / d / (tan * (w / h));
      let ny = c[1] / d / tan;
      if (behind) {
        const len = Math.hypot(nx, ny) || 1;
        nx = (nx / len) * 2;
        ny = (ny / len) * 2;
      }
      return { x: (nx * 0.5 + 0.5) * w, y: (-ny * 0.5 + 0.5) * h, visible: !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1, behind };
    },
    connect: async () => {},
    disconnect() {},
    cmd: async () => ({ ok: true }),
    chat() {},
    setTarget() {},
    cycleTarget() {},
    setNav() {},
    cycleNav() {},
    setFoldTarget() {},
    toggleCruise() {},
    startFold() {},
    toggleFlightAssist() {},
    setCameraMode() {},
    capturePointer() {},
    releasePointer() {},
    identity: { id: 'dev', exportKey: () => '', importKey: () => false },
  };
  const audio: GameAudio = { update() {}, ui() {}, unlock() {}, setVolume() {} };
  mountUi(root, api, audio);
  // The HUD redraws when the frame counter of the store moves, as the game core moves it.
  const tick = (): void => {
    store.frame.value++;
    requestAnimationFrame(tick);
  };
  tick();
}
