import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { engine } from './engine.ts';
import { Library, stopLibrary } from './Library.tsx';
import { exportRatings, general, importRatings, loadRatings, saveStatus, setGeneral, setManifestInfo } from './ratings.ts';
import { SceneView, sceneRunnerFor } from './ScenesView.tsx';
import { hooks, runners } from './sceneRunner.ts';
import { loc, lang, setLang, t, type Lang } from './strings.ts';
import type { Manifest } from './types.ts';

const BUILD_COMMAND = '.venv-audio/Scripts/python.exe tools/audio/build.py';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; manifest: Manifest };
const load = signal<Load>({ status: 'loading' });
const view = signal<string>('library');
const volume = signal(0.7);
const cabinOn = signal(true);
const radioOn = signal(true);
const limiterOn = signal(true);
const notice = signal('');

async function loadManifest(): Promise<void> {
  load.value = { status: 'loading' };
  try {
    const r = await fetch('/audio-lib/render/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = (await r.json()) as Manifest;
    if (!Array.isArray(m.sounds) || !Array.isArray(m.categories)) throw new Error('not a manifest');
    engine.setSounds(m.sounds);
    setManifestInfo(!!m.placeholder, m.sounds.length);
    for (const runner of runners) runner.refreshMissing();
    load.value = { status: 'ready', manifest: m };
  } catch (e) {
    load.value = { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// Level meter: output peak, a short hold, and a lamp that stays lit after the mix has clipped.
const peakDb = signal(-Infinity);
const holdDb = signal(-Infinity);
const clipUntil = signal(0);
const reductionDb = signal(0);
const nowTick = signal(0);

function startMeter(): void {
  const h = hooks();
  h.peak = 0;
  h.peakMax = 0;
  h.resetPeak = () => {
    h.peakMax = 0;
  };
  let holdAt = 0;
  const frame = (): void => {
    const p = engine.readPeak();
    h.peak = p;
    h.peakMax = Math.max(h.peakMax, p);
    const now = performance.now();
    const db = p > 0 ? 20 * Math.log10(p) : -Infinity;
    peakDb.value = db;
    if (db >= holdDb.peek() || now - holdAt > 1500) {
      holdDb.value = db;
      holdAt = now;
    }
    if (p >= 0.999) clipUntil.value = now + 3000;
    reductionDb.value = engine.limiterReduction;
    nowTick.value = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function dbToPct(db: number): number {
  return Number.isFinite(db) ? Math.min(100, Math.max(0, ((db + 60) / 66) * 100)) : 0;
}

function Meter(): JSX.Element {
  const clipped = clipUntil.value > nowTick.value;
  const hold = holdDb.value;
  return (
    <div class="meter" id="meter">
      <span class="dim">{t('peak')}</span>
      <div class="meter-track" aria-hidden="true">
        <div class="meter-fill" style={{ width: `${dbToPct(peakDb.value)}%` }} />
        <div class="meter-zero" style={{ left: `${dbToPct(0)}%` }} />
        <div class="meter-hold" style={{ left: `${dbToPct(hold)}%`, display: Number.isFinite(hold) ? 'block' : 'none' }} />
      </div>
      <span class="mono meter-read">{Number.isFinite(hold) ? `${hold.toFixed(1)} dB` : '-∞ dB'}</span>
      <button type="button" class={`clip ${clipped ? 'hot' : ''}`} id="clip-lamp" title={t('clipReset')} onClick={() => (clipUntil.value = 0)}>
        {t('clip')}
      </button>
      <span class="mono dim small meter-reduce" title={t('limiterReduction')}>
        {limiterOn.value && reductionDb.value < -0.1 ? `↓ ${Math.abs(reductionDb.value).toFixed(1)} dB` : ''}
      </span>
    </div>
  );
}

function Switch(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; id?: string }): JSX.Element {
  return (
    <label class="switch">
      <input id={props.id} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)} />
      {props.label}
    </label>
  );
}

function statusText(): string {
  switch (saveStatus.value) {
    case 'saving':
      return t('saving');
    case 'server':
      return t('saveServer');
    case 'failed':
      return t('saveFailed');
    default:
      return t('saveLocal');
  }
}

function Header(): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const ready = load.value.status === 'ready';
  const hasIr = ready && engine.hasCabinIr();
  return (
    <header class="top">
      <div class="bar">
        <div class="brand">
          <h1 title={t('subtitle')}>PRIMACY2 / {t('title')}</h1>
          
        </div>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view.value === 'library'} class={view.value === 'library' ? 'on' : ''} data-tab="library" onClick={() => (view.value = 'library')}>
            {t('tabLibrary')}
          </button>
          {runners.map((r) => (
            <button
              type="button"
              role="tab"
              key={r.def.id}
              data-tab={r.def.id}
              aria-selected={view.value === r.def.id}
              class={view.value === r.def.id ? 'on' : ''}
              onClick={() => (view.value = r.def.id)}
            >
              {loc(r.def.title)}
              {r.live.value ? ' ●' : ''}
            </button>
          ))}
        </div>
        <div class="file-actions">
          <button type="button" id="export" onClick={() => exportRatings()}>
            {t('export')}
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            {t('import')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const input = e.currentTarget as HTMLInputElement;
              const f = input.files?.[0];
              if (f) {
                notice.value = (await importRatings(f)) ? t('imported') : t('importFailed');
                window.setTimeout(() => (notice.value = ''), 4000);
              }
              input.value = '';
            }}
          />
        </div>
        <div class="lang" role="group" aria-label={t('language')}>
          {(['de', 'en'] as Lang[]).map((l) => (
            <button type="button" key={l} class={lang.value === l ? 'on' : ''} aria-pressed={lang.value === l} data-lang={l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div class="bar" aria-label={t('switchesTitle')}>
        <div class="volume">
          <label for="master">{t('master')}</label>
          <input
            id="master"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume.value}
            onInput={(e) => {
              volume.value = Number((e.currentTarget as HTMLInputElement).value);
              engine.setVolume(volume.value);
            }}
          />
        </div>
        <Switch
          id="sw-cabin"
          label={hasIr || !ready ? t('cabin') : t('cabinNoIr')}
          checked={cabinOn.value && hasIr}
          disabled={!hasIr}
          onChange={(v) => {
            cabinOn.value = v;
            engine.setCabin(v);
          }}
        />
        <Switch
          id="sw-radio"
          label={t('radio')}
          checked={radioOn.value}
          onChange={(v) => {
            radioOn.value = v;
            engine.setRadio(v);
          }}
        />
        <Switch
          id="sw-limiter"
          label={t('limiter')}
          checked={limiterOn.value}
          onChange={(v) => {
            limiterOn.value = v;
            engine.setLimiter(v);
          }}
        />
        <Meter />
        <button
          type="button"
          class="danger"
          id="stop-all"
          onClick={() => {
            stopLibrary();
            for (const r of runners) r.stopLive();
          }}
        >
          {t('stopAll')}
        </button>
        <span class="spacer" />
        <span class="status dim" id="save-status">
          {notice.value || statusText()}
        </span>
      </div>
    </header>
  );
}

function Banner(): JSX.Element | null {
  const l = load.value;
  if (l.status === 'error') {
    return (
      <div class="banner error" id="banner-missing" role="alert">
        <strong>{t('bannerMissing')}</strong> <span class="dim mono">{l.message}</span>
        <br />
        {t('bannerMissingHint')} <code>{BUILD_COMMAND}</code>{' '}
        <button type="button" onClick={() => void loadManifest()}>
          {t('retry')}
        </button>
      </div>
    );
  }
  if (l.status === 'ready' && l.manifest.placeholder) {
    return (
      <div class="banner" id="banner-placeholder" role="status">
        <strong>{t('bannerPlaceholder')}</strong>
        <br />
        {t('bannerPlaceholderHint')} <code>{BUILD_COMMAND}</code>
      </div>
    );
  }
  return null;
}

export function App(): JSX.Element {
  useEffect(() => {
    startMeter();
    void loadRatings();
    void loadManifest();
  }, []);
  const l = load.value;
  const runner = sceneRunnerFor(view.value);
  return (
    <>
      <Header />
      <Banner />
      <main>
        {l.status === 'loading' && <p class="empty">{t('loading')}</p>}
        {l.status === 'ready' && view.value === 'library' && <Library manifest={l.manifest} />}
        {l.status === 'ready' && runner && <SceneView runner={runner} />}
        {l.status === 'ready' && (
          <section class="card foot">
            <h2>{t('general')}</h2>
            <textarea id="general-note" rows={3} placeholder={t('generalHint')} value={general.value} onInput={(e) => setGeneral((e.currentTarget as HTMLTextAreaElement).value)} />
          </section>
        )}
      </main>
    </>
  );
}
