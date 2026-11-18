import { signal } from '@preact/signals';
import type { ManifestSound, RatingsFile, SoundRating } from './types.ts';

// Ratings live in localStorage, are saved to the dev server a moment after every change, and can be
// exported as a file for the case that the server is not there.

const KEY = 'audition.ratings.v1';
const SAVE_DELAY_MS = 500;

export const ratings = signal<Record<string, SoundRating>>({});
export const sceneNotes = signal<Record<string, { note: string; at: string }>>({});
export const general = signal('');
/** File hashes of round 1: a rating without a hash of its own was given on these files. */
export const round1Hashes = signal<Record<string, string>>({});
/** Hashes of the files in the current manifest (only the sounds for which the build wrote one). */
export const currentHashes = signal<Record<string, string>>({});
export type SaveStatus = 'idle' | 'saving' | 'server' | 'local' | 'failed';
export const saveStatus = signal<SaveStatus>('idle');

let manifestInfo = { placeholder: false, count: 0 };
let timer = 0;
let loaded = false;

export function setManifestInfo(placeholder: boolean, count: number): void {
  manifestInfo = { placeholder, count };
}

export function setCurrentHashes(sounds: ManifestSound[]): void {
  const next: Record<string, string> = {};
  for (const s of sounds) if (typeof s.hash === 'string' && s.hash) next[s.id] = s.hash;
  currentHashes.value = next;
}

/** The hashes of round 1, served read-only by the dev server; a missing file only means no sound can be marked from it. */
export async function loadRound1(): Promise<void> {
  try {
    const r = await fetch('/audio-lib/rounds/round1.json', { cache: 'no-store' });
    if (!r.ok) return;
    const parsed = (await r.json()) as { hashes?: Record<string, string> };
    if (parsed && typeof parsed.hashes === 'object' && parsed.hashes !== null) round1Hashes.value = parsed.hashes;
  } catch {
    // Without the file the ratings that carry no hash are simply never marked.
  }
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

export function isRated(id: string): boolean {
  const r = ratings.value[id];
  return !!r && (r.stars > 0 || r.verdict !== '' || r.note !== '');
}

/** The hash of the file the owner heard when he rated: stored with the rating, else that of round 1. */
export function ratedHash(id: string): string | undefined {
  const r = ratings.value[id];
  if (!r) return undefined;
  return r.hash ?? round1Hashes.value[id];
}

/** True when the sound is rated and its file is not the one that was rated. Unknown hashes never count as a change. */
export function isChanged(id: string): boolean {
  if (!isRated(id)) return false;
  const now = currentHashes.value[id];
  const then = ratedHash(id);
  return !!now && !!then && now !== then;
}

export function rate(id: string, patch: Partial<SoundRating>): void {
  const old = ratings.value[id] ?? empty();
  const hash = currentHashes.value[id];
  let base: SoundRating = old;
  if (isChanged(id)) {
    // Rating a sound whose file changed starts a new rating (the note stays to be edited); the old one is kept in the history.
    const past = { stars: old.stars, verdict: old.verdict, note: old.note, at: old.at, hash: ratedHash(id) };
    base = { ...empty(), note: old.note, history: [...(old.history ?? []), past] };
  }
  const next: SoundRating = { ...base, ...patch, at: new Date().toISOString() };
  if (hash) next.hash = hash;
  ratings.value = { ...ratings.value, [id]: next };
  scheduleSave();
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
