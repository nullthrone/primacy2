import type { JSX } from 'preact';
import { runners, type SceneRunner } from './sceneRunner.ts';
import { BOOST_THRUST } from './scenes.ts';
import { sceneNotes, setSceneNote } from './ratings.ts';
import { loc, t } from './strings.ts';

function Slider(props: { id: string; label: string; min: number; max: number; step: number; value: number; unit?: string; onInput: (v: number) => void }): JSX.Element {
  return (
    <div class="slider-line">
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="mono">
        {props.value.toFixed(props.step < 1 ? 2 : 0)}
        {props.unit ? ` ${props.unit}` : ''}
      </span>
    </div>
  );
}

export function SceneView({ runner }: { runner: SceneRunner }): JSX.Element {
  const def = runner.def;
  const s = runner.state.value;
  const live = runner.live.value;
  const scripted = runner.scripted.value;
  const progress = Math.min(1, runner.simTime.value / def.duration);
  const note = sceneNotes.value[def.id]?.note ?? '';
  const missing = runner.missing.value;
  return (
    <div class="scene" id={`scene-${def.id}`}>
      <div>
        <div class="card">
          <h2>{loc(def.title)}</h2>
          <p class="dim">{loc(def.blurb)}</p>
          <div class="scene-actions">
            <button
              type="button"
              class={scripted ? 'on' : 'primary'}
              data-act="play-scene"
              onClick={() => (scripted ? runner.stopLive() : void runner.playScript())}
            >
              {scripted ? `■ ${t('stopScene')}` : `▶ ${t('playScene')}`}
            </button>
            <button type="button" class={live && !scripted ? 'on' : ''} data-act="live" disabled={scripted} onClick={() => (live ? runner.stopLive() : void runner.startLive())}>
              {live ? t('stopLive') : t('startLive')}
            </button>
            <span class={live ? 'ok' : 'dim'}>{scripted ? t('sceneRunning') : live ? t('sceneLive') : t('sceneLiveOff')}</span>
            <span class="mono dim" data-role="clock">
              {runner.simTime.value.toFixed(0)} / {def.duration} {t('seconds')}
            </span>
          </div>
          <div class="progress" style={{ flex: 'none', width: '100%' }}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
          <h3>{t('sliders')}</h3>
          <Slider id={`${def.id}-thrust`} label={t('thrust')} min={0} max={1} step={0.01} value={s.thrust} onInput={(v) => runner.setParam('thrust', v)} />
          <Slider id={`${def.id}-heat`} label={t('heat')} min={0} max={1.2} step={0.01} value={s.heat} onInput={(v) => runner.setParam('heat', v)} />
          <Slider
            id={`${def.id}-distance`}
            label={loc(def.distance.label)}
            min={def.distance.min}
            max={def.distance.max}
            step={def.distance.step}
            value={s.distance}
            unit={def.distance.unit}
            onInput={(v) => runner.setParam('distance', v)}
          />
          <div class="scene-actions">
            <button type="button" class={s.boost ? 'on' : ''} aria-pressed={s.boost} data-act="boost" onClick={() => runner.patch({ boost: !s.boost })}>
              {t('boost')} ({BOOST_THRUST})
            </button>
          </div>
          {missing.length > 0 && (
            <div class="missing" data-role="missing">
              {t('missing')}: <code>{missing.join(', ')}</code>
            </div>
          )}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>{t('events')}</h2>
          <div class="events">
            {def.events.map((e) => (
              <button
                type="button"
                key={e.key}
                class={e.toggle && s.on[e.key] ? 'on' : ''}
                aria-pressed={e.toggle ? !!s.on[e.key] : undefined}
                data-event={e.key}
                onClick={() => {
                  runner.prepare();
                  runner.fire(e.key);
                }}
              >
                {loc(e.label)}
              </button>
            ))}
          </div>
        </div>
        <div class="card">
          <h2>{t('sceneNote')}</h2>
          <textarea rows={4} value={note} onInput={(e) => setSceneNote(def.id, (e.currentTarget as HTMLTextAreaElement).value)} />
        </div>
      </div>
    </div>
  );
}

export function sceneRunnerFor(id: string): SceneRunner | undefined {
  return runners.find((r) => r.def.id === id);
}
