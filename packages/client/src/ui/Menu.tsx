/**
 * Start screen, settings and the in-game pause menu.
 */
import { useState } from 'preact/hooks';
import type { GameAudio } from '../audio/index.ts';
import type { GameApi } from '../contracts.ts';
import { t } from '../i18n/index.ts';
import { store, updateSettings } from '../state/store.ts';

export function Settings({ audio }: { audio: GameAudio }) {
  const s = store.settings.value;
  const g = s.graphics;
  return (
    <div class="settings">
      <label>{t('menu.language')}
        <select value={s.lang} onChange={(e) => updateSettings({ lang: (e.target as HTMLSelectElement).value as 'en' | 'de' })}>
          <option value="en">English</option>
          <option value="de">Deutsch</option>
        </select>
      </label>
      <label>{t('menu.camera')}
        <select value={s.camera} onChange={(e) => updateSettings({ camera: (e.target as HTMLSelectElement).value as 'cockpit' | 'chase' })}>
          <option value="cockpit">{t('menu.cameraCockpit')}</option>
          <option value="chase">{t('menu.cameraChase')}</option>
        </select>
      </label>
      <label>{t('menu.sensitivity')}
        <input type="range" min="0.0006" max="0.006" step="0.0002" value={s.mouseSensitivity}
          onInput={(e) => updateSettings({ mouseSensitivity: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <label>{t('menu.fov')} ({s.fov}°)
        <input type="range" min="50" max="100" step="1" value={s.fov}
          onInput={(e) => updateSettings({ fov: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <label>{t('menu.volume')}
        <input type="range" min="0" max="1" step="0.05" value={s.volume}
          onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); updateSettings({ volume: v }); audio.setVolume(v); }} />
      </label>
      <label>{t('menu.quality')}
        <select value={String(g.quality)} onChange={(e) => updateSettings({ graphics: { ...g, quality: Number((e.target as HTMLSelectElement).value) as 0 | 1 | 2 } })}>
          <option value="0">{t('menu.quality0')}</option>
          <option value="1">{t('menu.quality1')}</option>
          <option value="2">{t('menu.quality2')}</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" checked={g.bloom} onChange={(e) => updateSettings({ graphics: { ...g, bloom: (e.target as HTMLInputElement).checked } })} />{t('menu.bloom')}</label>
      <label class="check"><input type="checkbox" checked={s.invertY} onChange={(e) => updateSettings({ invertY: (e.target as HTMLInputElement).checked })} />{t('menu.invertY')}</label>
    </div>
  );
}

export function Controls() {
  return (
    <div class="controls">
      <div>{t('ctl.move')}</div>
      <div>{t('ctl.look')}</div>
      <div>{t('ctl.fire')}</div>
      <div>{t('ctl.nav')}</div>
      <div>{t('ctl.land')}</div>
      <div>{t('ctl.power')}</div>
      <div>{t('ctl.ui')}</div>
      <div class="dim">{t('ctl.ctrlw')}</div>
    </div>
  );
}

function Identity({ api }: { api: GameApi }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<null | boolean>(null);
  // Re-read the id after an import.
  const id = result === true || result === null || result === false ? api.identity.id : '';
  return (
    <div class="identity">
      <p class="dim">{t('menu.identityHelp')}</p>
      <div>{t('menu.pilotId')}: <code>{id}</code></div>
      <div class="row">
        <button type="button" onClick={() => setShow(!show)}>{t(show ? 'menu.hideKey' : 'menu.showKey')}</button>
        {show && (
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(api.identity.exportKey()); setCopied(true); }}>
            {t(copied ? 'menu.copied' : 'menu.copy')}
          </button>
        )}
      </div>
      {show && <code class="secret">{api.identity.exportKey()}</code>}
      <div class="row">
        <input value={text} placeholder={t('menu.importPlaceholder')} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button type="button" disabled={!text.trim()} onClick={() => { setResult(api.identity.importKey(text)); setText(''); }}>{t('menu.importKey')}</button>
      </div>
      {result !== null && <div class={result ? 'ok' : 'bad'}>{t(result ? 'menu.importOk' : 'menu.importBad')}</div>}
    </div>
  );
}

export function StartScreen({ api, audio }: { api: GameApi; audio: GameAudio }) {
  const s = store.settings.value;
  const [name, setName] = useState(s.pilotName);
  const [server, setServer] = useState(s.lastServer || location.origin);
  const [tab, setTab] = useState<'none' | 'identity' | 'settings' | 'controls'>('none');
  const connecting = store.phase.value === 'connecting';
  return (
    <div class="start">
      <form
        class="start-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!connecting) void api.connect(server, name);
        }}
      >
        <h1>{t('app.title')}</h1>
        <p class="tagline">{t('app.tagline')}</p>
        <label>{t('menu.name')}
          <input value={name} maxLength={24} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label>{t('menu.server')}
          <input value={server} spellcheck={false} onInput={(e) => setServer((e.target as HTMLInputElement).value)} />
        </label>
        <button class="primary" type="submit" disabled={connecting || name.trim().length < 2}>
          {connecting ? t('menu.connecting', { server: store.status.value }) : t('menu.connect')}
        </button>
        {store.error.value && <div class="bad">{store.error.value}</div>}
        <div class="tabs">
          <button type="button" class={tab === 'identity' ? 'on' : ''} onClick={() => setTab(tab === 'identity' ? 'none' : 'identity')}>{t('menu.identity')}</button>
          <button type="button" class={tab === 'settings' ? 'on' : ''} onClick={() => setTab(tab === 'settings' ? 'none' : 'settings')}>{t('menu.settings')}</button>
          <button type="button" class={tab === 'controls' ? 'on' : ''} onClick={() => setTab(tab === 'controls' ? 'none' : 'controls')}>{t('menu.controls')}</button>
        </div>
        {tab === 'identity' && <Identity api={api} />}
        {tab === 'settings' && <Settings audio={audio} />}
        {tab === 'controls' && <Controls />}
        <p class="dim small">
          {t('menu.licence')} · <a href="https://github.com/nullthrone/primacy2" target="_blank" rel="noreferrer">{t('menu.source')}</a>
        </p>
      </form>
    </div>
  );
}

export function PauseMenu({ api, audio }: { api: GameApi; audio: GameAudio }) {
  return (
    <div class="panel narrow">
      <header>
        <h2>{t('app.title')}</h2>
        <button onClick={() => (store.panel.value = null)}>{t('menu.resume')}</button>
      </header>
      <Settings audio={audio} />
      <h3>{t('menu.controls')}</h3>
      <Controls />
      <div class="row">
        <button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => {}); }}>
          {t('menu.fullscreen')}
        </button>
        <button class="danger" onClick={() => api.disconnect()}>{t('menu.disconnect')}</button>
      </div>
    </div>
  );
}
