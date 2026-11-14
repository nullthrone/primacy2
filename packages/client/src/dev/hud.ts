/**
 * The real interface over a development scene (`hud=1` on the dev page): the HUD the game
 * shows, fed with the scene's frame views through a stand-in for the game core. There is no game
 * behind it, so nothing flies; what the stand-in does carry out is choosing targets, with the
 * same rules as the game core: O and L step through the places, T and G through the ships, U
 * clears, N and Tab open the lists.
 *
 * Options
 *   lang=en|de        language
 *   nav=<anchor id>   the chosen place; target=<entity id> the locked ship
 *   list=1            the list of places is open, as right after a step
 *   device=pad        hints name the buttons of a controller (padstyle=playstation for its names)
 *   panel=station     the station screen with a made-up station that has every tab
 *
 * `window.__api` is the stand-in, `window.__store` the store, for scripts.
 */
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/share-tech-mono/400.css';
import { EntityKind, quat, v3, type Vec3 } from '@primacy2/shared';
import type { GameAudio } from '../audio/index.ts';
import type { FrameView, GameApi, ScreenPoint } from '../contracts.ts';
import { PLACE_LIST_MS, listPlaces, stepPlace } from '../state/places.ts';
import { store, type Contact } from '../state/store.ts';
import { mountUi } from '../ui/index.tsx';
import { fakeStation } from './fakeStation.ts';

/** Mounts the interface in the playing state. `view` gives the frame view last drawn. */
export function mountDevHud(view: () => FrameView | null, params: URLSearchParams): void {
  const root = document.createElement('div');
  root.id = 'ui';
  root.style.cssText = 'position:fixed;inset:0';
  document.body.appendChild(root);
  const lang = params.get('lang');
  if (lang === 'en' || lang === 'de') store.settings.value = { ...store.settings.value, lang };
  store.phase.value = 'playing';
  store.pointerLocked.value = true;
  store.serverName.value = 'Dev';
  if (params.get('device') === 'pad') {
    store.device.value = 'pad';
    document.documentElement.dataset.device = 'pad';
    if (params.get('padstyle') === 'playstation') store.padStyle.value = 'playstation';
  }
  const num = (key: string): number | null => (params.get(key) === null || params.get(key) === '' ? null : Number(params.get(key)));
  store.navAnchor.value = num('nav');
  store.targetId.value = num('target');

  // The scene knows nothing of the store: the targets chosen here are written into its view.
  const current = (): FrameView | null => {
    const v = view();
    if (!v) return null;
    v.navAnchor = store.navAnchor.value;
    v.targetId = store.targetId.value;
    return v;
  };
  const ships = (): Contact[] => store.contacts.value.filter((c) => c.info.kind === EntityKind.Ship);

  const api: GameApi = {
    get view() { return current(); },
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
    setTarget(id) { store.targetId.value = id; },
    cycleTarget(dir) {
      const list = ships();
      if (!list.length) return void (store.targetId.value = null);
      const i = list.findIndex((c) => c.id === store.targetId.value);
      store.targetId.value = list[(i + dir + list.length) % list.length]!.id;
    },
    setNav(id) { store.navAnchor.value = id; },
    // As `cycleNav` of the game core.
    cycleNav(dir) {
      const v = view();
      if (!v) return;
      const now = performance.now();
      const open = store.navList.value;
      const ids = open && now - open.at < PLACE_LIST_MS ? open.ids : listPlaces(v).map((p) => p.id);
      const next = stepPlace(ids, store.navAnchor.value, dir);
      store.navList.value = { ids, at: now };
      if (next !== null) store.navAnchor.value = next;
    },
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

  window.addEventListener('keydown', (e) => {
    const panel = (p: 'system' | 'contacts'): void => void (store.panel.value = store.panel.value === p ? null : p);
    if (e.code === 'Escape') store.panel.value = null;
    else if (e.code === 'KeyN') panel('system');
    else if (e.code === 'Tab') panel('contacts');
    else if (store.panel.value !== null) return;
    else if (e.code === 'KeyO') api.cycleNav(1);
    else if (e.code === 'KeyL') api.cycleNav(-1);
    else if (e.code === 'KeyT') api.cycleTarget(1);
    else if (e.code === 'KeyG') api.cycleTarget(-1);
    else if (e.code === 'KeyU') {
      if (store.targetId.value !== null) store.targetId.value = null;
      else store.navAnchor.value = null;
    } else return;
    e.preventDefault();
  });

  if (params.get('panel') === 'station') {
    const v = view();
    const site = v?.system.sites.find((s) => s.kind === 'station') ?? v?.system.sites[0];
    const fake = fakeStation(site?.id ?? 1000, site?.name ?? 'Dev Station');
    store.serverId.value = fake.serverId;
    store.pilot.value = fake.pilot;
    store.station.value = fake.station;
  }

  const hooks = window as unknown as { __api: GameApi; __store: typeof store };
  hooks.__api = api;
  hooks.__store = store;

  // The HUD redraws when the frame counter of the store moves, as the game core moves it; the
  // contacts are refreshed a few times per second, as the game core does.
  let frames = 0;
  const tick = (): void => {
    const v = view();
    if (v && frames++ % 12 === 0) {
      const self = v.self;
      store.contacts.value = self
        ? v.ents.map((e) => ({ id: e.id, info: e.info, dist: v3.dist(e.rel, self.rel), hull: e.hull, shield: e.shield, flags: e.flags })).sort((a, b) => a.dist - b.dist)
        : [];
      // `list=1` keeps the list of places open for a screenshot.
      if (params.get('list') === '1') store.navList.value = { ids: store.navList.value?.ids ?? listPlaces(v).map((p) => p.id), at: performance.now() };
    }
    store.frame.value++;
    requestAnimationFrame(tick);
  };
  tick();
}
