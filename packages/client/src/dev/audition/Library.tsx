import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { engine, soundUrl, type GroupVoice, type Voice } from './engine.ts';
import { hooks } from './sceneRunner.ts';
import { isRated, rate, ratings } from './ratings.ts';
import { dictionaryKeys, loc, t, type Key } from './strings.ts';
import type { Manifest, ManifestSound } from './types.ts';

export const onlyUnrated = signal(false);

// Library voices: a loop is toggled, a one-shot may overlap itself.
const voices = new Map<string, Voice>();
// Loops this list started itself (not those of the engine group or a scene), which decides what a row's button offers.
const activeLoops = signal<ReadonlySet<string>>(new Set());

function setLoopActive(id: string, on: boolean): void {
  const next = new Set(activeLoops.value);
  if (on) next.add(id);
  else next.delete(id);
  activeLoops.value = next;
}
// Loops whose second press came before their file had loaded.
const cancelledLoops = new Set<string>();
const groupVoice = signal<GroupVoice | null>(null);
const groupThrust = signal(0.5);
const groupGains = signal<number[]>([]);

hooks().groupLevels = () => groupVoice.peek()?.levels.map((l) => ({ ...l })) ?? [];

// The filter shows what was unrated when it was switched on, so that a row does not vanish under the cursor as it is rated.
const unratedAtSwitch = signal<ReadonlySet<string>>(new Set());

function setOnlyUnrated(on: boolean, sounds: ManifestSound[]): void {
  unratedAtSwitch.value = new Set(on ? sounds.filter((s) => !isRated(s.id)).map((s) => s.id) : []);
  onlyUnrated.value = on;
}

export function stopLibrary(): void {
  for (const v of voices.values()) v.stop();
  voices.clear();
  activeLoops.value = new Set();
  groupVoice.value?.stop();
  groupVoice.value = null;
}

async function trigger(sound: ManifestSound, viaRadio: boolean): Promise<void> {
  if (sound.kind === 'loop') {
    const running = voices.get(sound.id);
    if (running) {
      running.stop();
      voices.delete(sound.id);
      setLoopActive(sound.id, false);
      return;
    }
    if (activeLoops.value.has(sound.id)) {
      // Pressed again while the file is still loading: the loop must not start at all.
      cancelledLoops.add(sound.id);
      setLoopActive(sound.id, false);
      return;
    }
    setLoopActive(sound.id, true);
    const v = await engine.play(sound, { viaRadio });
    if (v && cancelledLoops.delete(sound.id)) v.stop();
    else if (v) voices.set(sound.id, v);
    else {
      cancelledLoops.delete(sound.id);
      setLoopActive(sound.id, false);
    }
    return;
  }
  if (sound.source === 'download') {
    // Downloaded clips run for seconds: pressing again stops them instead of stacking a second copy.
    const running = voices.get(sound.id);
    if (running && engine.playing.value.has(sound.id)) {
      running.stop();
      voices.delete(sound.id);
      return;
    }
    const v = await engine.play(sound, { viaRadio });
    if (v) voices.set(sound.id, v);
    return;
  }
  await engine.play(sound, { viaRadio });
}

function pathLabel(p: ManifestSound['path']): string {
  return { structure: t('pathStructure'), cabin: t('pathCabin'), sensor: t('pathSensor'), radio: t('pathRadio') }[p];
}

function kindLabel(k: ManifestSound['kind']): string {
  return { loop: t('loop'), oneshot: t('oneshot'), ir: t('ir') }[k];
}

// Downloaded radio material is meant to be heard through the radio filter, so its switch starts on.
const radioRows = signal<ReadonlySet<string>>(new Set());
let radioRowsSeeded = false;
function seedRadioRows(sounds: ManifestSound[]): void {
  if (radioRowsSeeded) return;
  radioRowsSeeded = true;
  radioRows.value = new Set(sounds.filter((s) => s.category === 'radio' && s.source === 'download').map((s) => s.id));
}

function toggleRadioRow(sound: ManifestSound): void {
  const next = new Set(radioRows.value);
  if (next.has(sound.id)) next.delete(sound.id);
  else next.add(sound.id);
  radioRows.value = next;
  // A running loop is restarted so that the switch is heard at once.
  const running = voices.get(sound.id);
  if (running) {
    running.stop();
    voices.delete(sound.id);
    setLoopActive(sound.id, false);
    void trigger(sound, next.has(sound.id));
  }
}

function hintText(h: string): string {
  const key = `hint_${h.replace(/-/g, '_')}` as Key;
  return key in dictionaryKeys ? t(key) : h;
}

function Checks({ sound }: { sound: ManifestSound }): JSX.Element | null {
  const c = sound.checks;
  // Downloaded files are not measured by the build; there is nothing to show.
  if (!c || sound.source === 'download') return null;
  const pct = (v: number | undefined): string => (v === undefined ? '-' : `${(v * 100).toFixed(1)} %`);
  const hints = c.hints ?? [];
  return (
    <details class="checks">
      <summary class={c.pass ? 'ok' : 'bad'}>
        {t('checks')}: {c.pass ? t('checksPass') : `${t('checksFail')} (${c.failed.length})`}
        {hints.length > 0 && <span class="hint">{` · ${t('hintsLabel')}: ${hints.map(hintText).join(', ')}`}</span>}
      </summary>
      <dl class="mono">
        {c.failed.length > 0 && (
          <>
            <dt class="bad">{t('checksFail')}</dt>
            <dd class="bad">{c.failed.join('; ')}</dd>
          </>
        )}
        {hints.length > 0 && (
          <>
            <dt class="hint">{t('hintsLabel')}</dt>
            <dd class="hint">{hints.map(hintText).join('; ')}</dd>
          </>
        )}
        <dt>{t('peakDb')}</dt>
        <dd>{c.peakDb ?? '-'} dBFS</dd>
        <dt>{t('lufs')}</dt>
        <dd>{c.lufs ?? '-'} LUFS</dd>
        <dt>{t('lowShare')}</dt>
        <dd>{pct(c.lowShare)}</dd>
        <dt>{t('highShare')}</dt>
        <dd>{pct(c.highShare)}</dd>
        {c.clap && (
          <>
            <dt>{t('clapMargin')}</dt>
            <dd>
              {c.clap.margin.toFixed(3)} ({c.clap.best})
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

function Rating({ sound }: { sound: ManifestSound }): JSX.Element {
  const r = ratings.value[sound.id];
  const stars = r?.stars ?? 0;
  const verdicts: ['fits' | 'close' | 'wrong', string][] = [
    ['fits', t('verdictFits')],
    ['close', t('verdictClose')],
    ['wrong', t('verdictWrong')],
  ];
  return (
    <div class="rate">
      <div class="stars" role="group" aria-label={t('stars')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            class={n <= stars ? 'lit' : ''}
            aria-pressed={n === stars}
            aria-label={n === 1 ? t('star1') : t('starsN', { n })}
            onClick={() => rate(sound.id, { stars: n === stars ? 0 : n })}
          >
            {n <= stars ? '★' : '☆'}
          </button>
        ))}
      </div>
      <div class="verdicts">
        {verdicts.map(([v, label]) => (
          <button
            key={v}
            type="button"
            class={`${v} ${r?.verdict === v ? 'on' : ''}`}
            aria-pressed={r?.verdict === v}
            onClick={() => rate(sound.id, { verdict: r?.verdict === v ? '' : v })}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        rows={2}
        aria-label={t('note')}
        placeholder={t('notePlaceholder')}
        value={r?.note ?? ''}
        onInput={(e) => rate(sound.id, { note: (e.currentTarget as HTMLTextAreaElement).value })}
      />
    </div>
  );
}

function onRowKey(e: KeyboardEvent, sound: ManifestSound): void {
  const target = e.target as HTMLElement;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[0-5]$/.test(e.key)) rate(sound.id, { stars: Number(e.key) });
  else if (e.key === 'f') rate(sound.id, { verdict: 'fits' });
  else if (e.key === 'c') rate(sound.id, { verdict: 'close' });
  else if (e.key === 'w') rate(sound.id, { verdict: 'wrong' });
}

function SoundRow({ sound }: { sound: ManifestSound }): JSX.Element {
  const isPlaying = engine.playing.value.has(sound.id);
  const loopOn = activeLoops.value.has(sound.id);
  const viaRadio = radioRows.value.has(sound.id);
  const label = loc(sound);
  const canRadio = sound.path !== 'radio';
  const isDownload = sound.source === 'download';
  const length = engine.lengthOf(sound);
  const stoppable = loopOn || (isDownload && isPlaying);
  return (
    <div
      class={`sound ${sound.source === 'download' ? 'download' : ''} ${isPlaying ? 'playing' : ''} ${isRated(sound.id) ? 'rated' : ''}`}
      id={`s-${sound.id}`}
      onKeyDown={(e) => onRowKey(e, sound)}
    >
      <button
        type="button"
        class={`play ${stoppable ? 'on' : 'primary'}`}
        data-sound={sound.id}
        aria-label={`${stoppable ? t('stop') : t('play')}: ${label}`}
        onClick={() => void trigger(sound, viaRadio)}
      >
        {stoppable ? '■' : '▶'}
      </button>
      <div>
        <div class="title">
          <strong>{label}</strong>
          <code class="dim">{sound.id}</code>
        </div>
        <p class="intent">{sound.intent}</p>
        <div class="badges">
          <span class={`badge ${sound.path}`}>{pathLabel(sound.path)}</span>
          <span class="badge">{kindLabel(sound.kind)}</span>
          <span class="badge">{sound.dry ? t('dry') : t('baked')}</span>
          <span class="badge mono">{length > 0 ? `${Number(length.toFixed(2))} ${t('seconds')}` : t('secondsUnknown')}</span>
          {sound.channels === 2 && <span class="badge">stereo</span>}
          {isDownload && <span class="badge dl">{t('downloadBadge')}</span>}
          {sound.source !== 'synth' && <span class="badge licence">{sound.licence}</span>}
          {canRadio && (
            <label class="switch small">
              <input type="checkbox" checked={viaRadio} onChange={() => toggleRadioRow(sound)} />
              {t('viaRadio')}
            </label>
          )}
        </div>
        {sound.checks?.described && sound.source !== 'download' && (
          <p class="described">
            <span class="dim">{t('described')}:</span> {sound.checks.described}
          </p>
        )}
        <div class="media">
          {sound.spectrogram && <img class="spec" loading="lazy" alt="" src={soundUrl(sound.spectrogram)} width={320} height={80} />}
          <Checks sound={sound} />
        </div>
      </div>
      <Rating sound={sound} />
    </div>
  );
}

function thrustLevels(sounds: ManifestSound[], family: string): ManifestSound[] {
  return sounds
    .filter((s) => s.family === family && s.kind === 'loop' && typeof s.params?.thrust === 'number')
    .sort((a, b) => (a.params?.thrust ?? 0) - (b.params?.thrust ?? 0));
}

async function toggleGroup(levels: ManifestSound[]): Promise<void> {
  if (groupVoice.value) {
    groupVoice.value.stop();
    groupVoice.value = null;
    return;
  }
  const v = await engine.playGroup(levels, groupThrust.value);
  if (v) {
    groupVoice.value = v;
    groupGains.value = v.levels.map((l) => l.gain);
  }
}

function setGroupThrust(v: number): void {
  groupThrust.value = v;
  const g = groupVoice.value;
  if (g) {
    g.setThrust(v);
    groupGains.value = g.levels.map((l) => l.gain);
  }
}

function EngineGroup({ levels }: { levels: ManifestSound[] }): JSX.Element {
  const running = groupVoice.value !== null;
  const gains = groupGains.value;
  const max = Math.max(...levels.map((l) => l.params?.thrust ?? 0));
  return (
    <div class="group" id="group-engine">
      <div class="head">
        <h3>{t('group')}</h3>
        <span class="dim">{t('groupHint')}</span>
        <span class="spacer" />
        <button type="button" class={running ? 'on' : 'primary'} id="group-toggle" onClick={() => void toggleGroup(levels)}>
          {running ? `■ ${t('stop')}` : `▶ ${t('play')}`}
        </button>
      </div>
      <div class="slider-line">
        <label for="group-thrust">{t('thrust')}</label>
        <input
          id="group-thrust"
          type="range"
          min={0}
          max={max}
          step={0.01}
          value={groupThrust.value}
          onInput={(e) => setGroupThrust(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="mono">{groupThrust.value.toFixed(2)}</span>
      </div>
      <div class="level-bars">
        {levels.map((l, i) => (
          <div class="level" key={l.id}>
            <div class="dim">
              {loc(l)} ({l.params?.thrust})
            </div>
            <div class="bar2">
              <div style={{ width: `${Math.round((gains[i] ?? 0) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Library({ manifest }: { manifest: Manifest }): JSX.Element {
  const unrated = onlyUnrated.value;
  const sounds = manifest.sounds;
  seedRadioRows(sounds);
  const total = sounds.length;
  const done = sounds.filter((s) => isRated(s.id)).length;
  return (
    <>
      <div class="counter">
        <strong class="mono" id="rated-count">
          {done} / {total} {t('rated')}
        </strong>
        <div class="progress" aria-hidden="true">
          <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <label class="switch">
          <input type="checkbox" checked={unrated} onChange={(e) => setOnlyUnrated((e.currentTarget as HTMLInputElement).checked, sounds)} />
          {t('onlyUnrated')}
        </label>
        <span class="dim small">1-5 {t('stars')}, F / C / W</span>
      </div>
      {manifest.categories.map((cat) => {
        const inCat = sounds.filter((s) => s.category === cat.id);
        const shown = unrated ? inCat.filter((s) => unratedAtSwitch.value.has(s.id)) : inCat;
        if (shown.length === 0) return null;
        const families = [...new Set(inCat.map((s) => s.family).filter((f): f is string => !!f))];
        const group = families.map((f) => thrustLevels(inCat, f)).find((l) => l.length >= 2);
        return (
          <section class="cat" key={cat.id} id={`cat-${cat.id}`}>
            <h2>
              {loc(cat)}
              <span class="dim">
                {inCat.filter((s) => isRated(s.id)).length} / {inCat.length}
              </span>
            </h2>
            {group && <EngineGroup levels={group} />}
            {[
              { key: 'rendered', title: t('rendered'), list: shown.filter((s) => s.source !== 'download') },
              { key: 'downloaded', title: t('downloaded'), list: shown.filter((s) => s.source === 'download') },
            ].map(
              (part) =>
                part.list.length > 0 && (
                  <div class={`part ${part.key}`} key={part.key} data-part={part.key}>
                    <h3 class="part-title">
                      {part.title}
                      <span class="dim"> {part.list.length}</span>
                      {part.key === 'downloaded' && <span class="dim small"> {t('downloadedNote')}</span>}
                    </h3>
                    {part.list.map((s) => (
                      <SoundRow key={s.id} sound={s} />
                    ))}
                  </div>
                ),
            )}
          </section>
        );
      })}
      {unrated && unratedAtSwitch.value.size === 0 && <p class="empty">{t('noSounds')}</p>}
    </>
  );
}
