import { signal } from '@preact/signals';
import type { RatingsFile, SoundRating } from './types.ts';

// Ratings live in localStorage, are saved to the dev server a moment after every change, and can be
// exported as a file for the case that the server is not there.

const KEY = 'audition.ratings.v1';
const SAVE_DELAY_MS = 500;

export const ratings = signal<Record<string, SoundRating>>({});
export const sceneNotes = signal<Record<string, { note: string; at: string }>>({});
export const general = signal('');
export type SaveStatus = 'idle' | 'saving' | 'server' | 'local' | 'failed';
export const saveStatus = signal<SaveStatus>('idle');

let manifestInfo = { placeholder: false, count: 0 };
let timer = 0;
let loaded = false;

export function setManifestInfo(placeholder: boolean, count: number): void {
  manifestInfo = { placeholder, count };
}

function isRatingsFile(x: unknown): x is RatingsFile {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Partial<RatingsFile>;
  return f.version === 1 && typeof f.ratings === 'object' && f.ratings !== null;
}

export function snapshot(): RatingsFile {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    manifest: manifestInfo,
    ratings: ratings.value,
    scenes: sceneNotes.value,
    general: general.value,
  };
}

function apply(f: RatingsFile): void {
  ratings.value = f.ratings ?? {};
  sceneNotes.value = f.scenes ?? {};
  general.value = f.general ?? '';
}

/** Takes the browser's copy, or the server's file when the browser has none or an older one. */
export async function loadRatings(): Promise<void> {
  let local: RatingsFile | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRatingsFile(parsed)) local = parsed;
    }
  } catch {
    // Unreadable storage: start from the server's file or empty.
  }
  let remote: RatingsFile | null = null;
  try {
    const r = await fetch('/audio-lib/ratings.json', { cache: 'no-store' });
    if (r.ok) {
      const parsed: unknown = await r.json();
      if (isRatingsFile(parsed)) remote = parsed;
    }
  } catch {
    // No server, no file: the browser's copy is all there is.
  }
  const best = local && remote ? (Date.parse(remote.savedAt) > Date.parse(local.savedAt) ? remote : local) : (local ?? remote);
  if (best) apply(best);
  loaded = true;
}

async function saveNow(): Promise<void> {
  const data = snapshot();
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Without storage the server copy and the export still work.
  }
  try {
    const r = await fetch('/audio-lib/ratings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    saveStatus.value = r.ok ? 'server' : 'failed';
  } catch {
    saveStatus.value = 'failed';
  }
}

function scheduleSave(): void {
  if (!loaded) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot()));
  } catch {
    // See saveNow.
  }
  saveStatus.value = 'saving';
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
}

const empty = (): SoundRating => ({ stars: 0, verdict: '', note: '', at: '' });

export function rate(id: string, patch: Partial<SoundRating>): void {
  const next = { ...(ratings.value[id] ?? empty()), ...patch, at: new Date().toISOString() };
  ratings.value = { ...ratings.value, [id]: next };
  scheduleSave();
}

export function isRated(id: string): boolean {
  const r = ratings.value[id];
  return !!r && (r.stars > 0 || r.verdict !== '' || r.note !== '');
}

export function setSceneNote(id: string, note: string): void {
  sceneNotes.value = { ...sceneNotes.value, [id]: { note, at: new Date().toISOString() } };
  scheduleSave();
}

export function setGeneral(text: string): void {
  general.value = text;
  scheduleSave();
}

export function exportRatings(): void {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ratings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function importRatings(file: File): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (!isRatingsFile(parsed)) return false;
    apply(parsed);
    scheduleSave();
    return true;
  } catch {
    return false;
  }
}
