/**
 * Root of the interface: start screen, HUD and panels over the 3D view.
 */
import '../styles/ui.css';
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { GameAudio } from '../audio/index.ts';
import type { GameApi } from '../contracts.ts';
import { store } from '../state/store.ts';
import { Hud } from './Hud.tsx';
import { ContactsPanel, GalaxyMap, NavPanel } from './Maps.tsx';
import { PauseMenu, StartScreen } from './Menu.tsx';
import { startPadNav } from './padnav.ts';
import { Station } from './Station.tsx';

function App({ api, audio }: { api: GameApi; audio: GameAudio }) {
  const phase = store.phase.value;
  const panel = store.panel.value;
  const station = store.station.value;
  // Open the station screen when docking and close it when leaving; in between the pilot may
  // close it to look at the station from outside.
  const wasDocked = useRef(false);
  useEffect(() => {
    const docked = station !== null;
    if (docked && !wasDocked.current) store.panel.value = 'station';
    if (!docked && wasDocked.current && store.panel.value === 'station') store.panel.value = null;
    wasDocked.current = docked;
  }, [station]);
  useEffect(() => {
    audio.setVolume(store.settings.value.volume);
  }, []);

  if (phase === 'menu' || phase === 'connecting' || phase === 'error') return <StartScreen api={api} audio={audio} />;
  return (
    <>
      <Hud api={api} />
      {panel !== null && panel !== 'chat' && (
        <div class="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) store.panel.value = null; }}>
          {panel === 'station' && (station ? <Station api={api} /> : null)}
          {panel === 'galaxy' && <GalaxyMap api={api} />}
          {panel === 'system' && <NavPanel api={api} />}
          {panel === 'contacts' && <ContactsPanel api={api} />}
          {panel === 'menu' && <PauseMenu api={api} audio={audio} />}
        </div>
      )}
    </>
  );
}

export function mountUi(root: HTMLElement, api: GameApi, audio: GameAudio): void {
  render(<App api={api} audio={audio} />, root);
  startPadNav();
}
