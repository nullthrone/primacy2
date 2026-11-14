/**
 * The controller binding screen: connected devices, a controller binding per action, and the
 * analog axes with a live meter. Keyboard bindings are shown but not edited here. Opened from the
 * settings on the start screen and in the pause menu.
 */
import { useEffect, useState } from 'preact/hooks';
import { t, type StringKey } from '../i18n/index.ts';
import {
  assignAxis, assignPad, clearPad, isRowAction, patchAxis, presetJoystick, presetStandard, removeAxis, resetPad, type PadPatch,
} from '../input/binds.ts';
import {
  PAD_AXIS_ACTIONS, capturedCode, captureNext, captureProgress, devMatches, isPadCode, leverValue, padAxisName, padCodeLabel, shapeAxis,
  snapshotPads, type PadAxisAction, type PadAxisBinding, type PadSnapshot,
} from '../input/gamepad.ts';
import { store, updateSettings, type BindAction } from '../state/store.ts';
import { keyName, padHelpParams } from './format.ts';

type Listening = { kind: 'action'; action: BindAction } | { kind: 'axis'; action: PadAxisAction } | null;

const read = (): PadSnapshot[] => {
  try {
    return snapshotPads(typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []);
  } catch {
    return [];
  }
};

export function Bindings({ onBack }: { onBack: () => void }) {
  const s = store.settings.value;
  const [listening, setListening] = useState<Listening>(null);
  const [snap, setSnap] = useState<PadSnapshot[]>(read);
  const patch = (p: PadPatch): void => updateSettings(p);
  const current = (): PadPatch => {
    const x = store.settings.value;
    return { bindings: x.bindings, padCleared: x.padCleared, pad: x.pad };
  };

  // Live values for the meters, about 20 times a second.
  useEffect(() => {
    const id = setInterval(() => setSnap(read()), 50);
    return () => clearInterval(id);
  }, []);

  // While waiting for a button the flight actions of the pad stay silent and Escape cancels.
  useEffect(() => {
    store.padCapturing.value = listening !== null;
    if (!listening) return;
    const before = read();
    let pending: { dev: string; n: number } | null = null;
    let raf = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setListening(null);
    };
    window.addEventListener('keydown', onKey, true);
    const step = (): void => {
      const now = read();
      if (listening.kind === 'action') {
        const r = captureProgress(before, now, pending);
        pending = r.pending;
        if (r.done) {
          patch(assignPad(current(), listening.action, capturedCode(r.done)));
          setListening(null);
          return;
        }
      } else {
        const c = captureNext(before, now);
        if (c?.kind === 'axis') {
          const pad = assignAxis(store.settings.value.pad, listening.action, c.dev, c.axis);
          updateSettings({ pad });
          setListening(null);
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [listening]);
  useEffect(() => () => { store.padCapturing.value = false; }, []);

  const pads = store.pads.value;
  const style = store.padStyle.value;
  const joy = pads.find((p) => !p.standard);
  const devName = (dev: string): string => {
    const p = pads.find((x) => x.dev === dev);
    return p ? p.name : dev === 'std' ? t('pad.standard') : dev;
  };
  const toggle = (l: Listening): void => setListening(listening && JSON.stringify(listening) === JSON.stringify(l) ? null : l);
  const rows = (Object.keys(s.bindings) as BindAction[]).filter(isRowAction);

  return (
    <div class="bindings">
      <div class="row between">
        <h3>{t('pad.title')}</h3>
        <button type="button" onClick={onBack}>{t('pad.back')}</button>
      </div>

      <h4>{t('pad.devices')}</h4>
      {pads.length === 0 && <div class="dim">{t('pad.none')}</div>}
      {pads.map((p) => (
        <div key={p.index} class="device">
          <span>{p.name}</span>
          <span class="dim">
            {t(p.standard ? 'pad.standard' : 'pad.nonStandard')} · {t('pad.buttonsAxes', { buttons: p.buttons, axes: p.axes })}
          </span>
        </div>
      ))}

      <h4>{t('pad.presets')}</h4>
      <div class="row wrap">
        <button type="button" onClick={() => patch(presetStandard(current()))}>{t('pad.presetPad')}</button>
        <button type="button" disabled={!joy} title={joy ? t('pad.presetJoystickHelp') : t('pad.presetJoystickNone')}
          onClick={() => joy && patch(presetJoystick(current(), joy.dev))}>{t('pad.presetJoystick')}</button>
        <button type="button" class="danger" onClick={() => patch(resetPad(current()))}>{t('pad.reset')}</button>
      </div>
      <p class="dim small">{t('pad.help', padHelpParams())}</p>
      {listening && <div class="listen">{t(listening.kind === 'axis' ? 'pad.listenAxis' : 'pad.listenButton')}</div>}

      <h4>{t('pad.actions')}</h4>
      <table class="bind-table">
        <thead>
          <tr><th></th><th>{t('pad.keyboard')}</th><th>{t('pad.controller')}</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const codes = s.bindings[a] ?? [];
            const kb = codes.filter((c) => !isPadCode(c)).map(keyName).join(' / ');
            const pc = codes.filter(isPadCode).map((c) => padCodeLabel(c, style)).join(' · ');
            const on = listening?.kind === 'action' && listening.action === a;
            return (
              <tr key={a} class={on ? 'listening' : ''}>
                <td>{t(`act.${a}` as StringKey)}</td>
                <td class="dim">{kb || '–'}</td>
                <td>{on ? t('pad.listening') : pc || '–'}</td>
                <td class="acts">
                  <button type="button" class={on ? 'on' : ''} onClick={() => toggle({ kind: 'action', action: a })}>{t(on ? 'pad.cancel' : 'pad.assign')}</button>
                  <button type="button" disabled={!codes.some(isPadCode)} onClick={() => patch(clearPad(current(), a))}>{t('pad.clear')}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h4>{t('pad.axes')}</h4>
      <label class="slider">{t('pad.turnRate')} ({Math.round(s.pad.turnRate * 100)} %)
        <input type="range" min="0.2" max="1" step="0.05" value={s.pad.turnRate}
          onInput={(e) => updateSettings({ pad: { ...store.settings.value.pad, turnRate: Number((e.target as HTMLInputElement).value) } })} />
      </label>
      {PAD_AXIS_ACTIONS.map((a) => {
        const list = s.pad.axes[a] ?? [];
        const on = listening?.kind === 'axis' && listening.action === a;
        return (
          <div key={a} class="axis-block">
            <div class="row between">
              <strong>{t(`pad.axis.${a}` as StringKey)}</strong>
              <button type="button" class={on ? 'on' : ''} onClick={() => toggle({ kind: 'axis', action: a })}>{t(on ? 'pad.cancel' : 'pad.assign')}</button>
            </div>
            {on && <div class="dim">{t('pad.listening')}</div>}
            {list.length === 0 && !on && <div class="dim">{t('pad.axisUnbound')}</div>}
            {list.map((b, i) => (
              <AxisRow key={`${b.dev}:${b.axis}`} action={a} b={b} snap={snap} name={devName(b.dev)}
                onChange={(p) => updateSettings({ pad: patchAxis(store.settings.value.pad, a, i, p) })}
                onRemove={() => updateSettings({ pad: removeAxis(store.settings.value.pad, a, i) })} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function AxisRow({ action, b, snap, name, onChange, onRemove }: {
  action: PadAxisAction; b: PadAxisBinding; snap: PadSnapshot[]; name: string;
  onChange: (p: Partial<PadAxisBinding>) => void; onRemove: () => void;
}) {
  const pad = snap.find((p) => devMatches(b.dev, p));
  const raw = pad?.axes[b.axis];
  const lever = action === 'throttle' && b.lever === true;
  // A bar from the middle towards the shaped value; for a lever from the left edge to its position.
  let left = 50;
  let width = 0;
  if (raw !== undefined) {
    if (lever) {
      left = 0;
      width = leverValue(raw, b.invert) * 100;
    } else {
      const v = shapeAxis(raw, b);
      left = 50 + Math.min(0, v) * 50;
      width = Math.abs(v) * 50;
    }
  }
  return (
    <div class="axis-row">
      <span class="axis-name">{name} · {padAxisName(b.axis)}</span>
      <span class="meter"><i style={{ left: `${left}%`, width: `${width}%` }} /></span>
      <label class="slider">{t('pad.deadzone')} ({b.deadzone.toFixed(2)})
        <input type="range" min="0" max="0.9" step="0.01" value={b.deadzone} onInput={(e) => onChange({ deadzone: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <label class="slider">{t('pad.curve')} ({b.curve.toFixed(1)})
        <input type="range" min="1" max="3" step="0.1" value={b.curve} onInput={(e) => onChange({ curve: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <label class="check"><input type="checkbox" checked={b.invert} onChange={(e) => onChange({ invert: (e.target as HTMLInputElement).checked })} />{t('pad.invert')}</label>
      {action === 'throttle' && (
        <label class="check"><input type="checkbox" checked={lever} onChange={(e) => onChange({ lever: (e.target as HTMLInputElement).checked })} />{t('pad.lever')}</label>
      )}
      <button type="button" onClick={onRemove}>{t('pad.clear')}</button>
    </div>
  );
}
