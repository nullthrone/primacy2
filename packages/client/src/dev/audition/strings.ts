import { signal } from '@preact/signals';

// The page's own strings; the game's i18n is not touched on purpose, this is a development tool.

export type Lang = 'en' | 'de';

const en = {
  title: 'Sound audition',
  subtitle: 'Listen, rate, hand the ratings back',
  language: 'Language',
  tabLibrary: 'Library',
  tabScenes: 'Scenes',
  bannerPlaceholder: 'These are placeholder sounds (simple tones), not the real library.',
  bannerPlaceholderHint: 'Render the real sounds with',
  bannerMissing: 'The sound manifest could not be loaded.',
  bannerMissingHint: 'Render the sounds with',
  loading: 'Loading the manifest ...',
  retry: 'Try again',
  master: 'Master',
  cabin: 'Cabin',
  cabinNoIr: 'Cabin (no cabin_ir)',
  radio: 'Radio filter',
  limiter: 'Limiter',
  limiterReduction: 'reduction',
  stopAll: 'Stop all',
  peak: 'Peak',
  clip: 'CLIP',
  clipReset: 'Clear',
  switchesTitle: 'Global switches',
  rated: 'rated',
  onlyUnrated: 'Only unrated',
  export: 'Export',
  import: 'Import',
  saveLocal: 'Saved in this browser only',
  saveServer: 'Saved to assets/audio/ratings.json',
  saveFailed: 'Server not reachable, kept in this browser (use Export)',
  saving: 'Saving ...',
  general: 'General note',
  generalHint: 'Anything about the library as a whole',
  noSounds: 'Nothing to show with this filter.',
  play: 'Play',
  stop: 'Stop',
  loop: 'Loop',
  oneshot: 'One-shot',
  ir: 'Impulse response',
  pathStructure: 'Structure',
  pathCabin: 'Cabin',
  pathSensor: 'Sensor',
  pathRadio: 'Radio',
  dry: 'dry',
  baked: 'cabin baked in',
  viaRadio: 'Via radio',
  seconds: 's',
  checks: 'Checks',
  checksPass: 'all rules passed',
  checksFail: 'failed',
  peakDb: 'peak',
  lufs: 'loudness',
  lowShare: 'below 500 Hz',
  highShare: 'above 4 kHz',
  clapMargin: 'CLAP margin',
  described: 'The describing model says',
  stars: 'Stars',
  star1: '1 star',
  starsN: '{n} stars',
  verdictFits: 'Fits',
  verdictClose: 'Close',
  verdictWrong: 'Wrong',
  note: 'Note',
  notePlaceholder: 'What is off, what is good?',
  group: 'Engine levels',
  groupHint: 'One engine, crossfaded between the levels with equal power.',
  thrust: 'Thrust',
  levels: 'Levels',
  scene: 'Scene',
  playScene: 'Play the scene',
  stopScene: 'Stop the scene',
  sceneRunning: 'Running',
  sceneLive: 'Live',
  sceneLiveOff: 'Silent',
  startLive: 'Start sound',
  stopLive: 'Stop sound',
  sliders: 'Sliders',
  heat: 'Heat',
  boost: 'Boost',
  distance: 'Distance',
  events: 'Events',
  missing: 'Missing from the manifest, skipped',
  sceneNote: 'Note on this scene',
  speed: 'Test speed',
  loaded: '{n} sounds',
  exported: 'Exported',
  importFailed: 'That file is not a ratings file.',
  imported: 'Ratings imported',
} as const;

export type Key = keyof typeof en;

const de: Record<Key, string> = {
  title: 'Klang-Vorspiel',
  subtitle: 'Anhören, bewerten, die Bewertung zurückgeben',
  language: 'Sprache',
  tabLibrary: 'Bibliothek',
  tabScenes: 'Szenen',
  bannerPlaceholder: 'Das sind Platzhalter-Klänge (einfache Töne), nicht die echte Bibliothek.',
  bannerPlaceholderHint: 'Die echten Klänge entstehen mit',
  bannerMissing: 'Das Klang-Manifest konnte nicht geladen werden.',
  bannerMissingHint: 'Die Klänge entstehen mit',
  loading: 'Manifest wird geladen ...',
  retry: 'Noch einmal',
  master: 'Lautstärke',
  cabin: 'Kabine',
  cabinNoIr: 'Kabine (kein cabin_ir)',
  radio: 'Funkfilter',
  limiter: 'Limiter',
  limiterReduction: 'Absenkung',
  stopAll: 'Alles stoppen',
  peak: 'Spitze',
  clip: 'CLIP',
  clipReset: 'Löschen',
  switchesTitle: 'Globale Schalter',
  rated: 'bewertet',
  onlyUnrated: 'Nur unbewertete',
  export: 'Exportieren',
  import: 'Importieren',
  saveLocal: 'Nur in diesem Browser gespeichert',
  saveServer: 'Gespeichert in assets/audio/ratings.json',
  saveFailed: 'Server nicht erreichbar, im Browser behalten (Exportieren nutzen)',
  saving: 'Speichert ...',
  general: 'Allgemeine Notiz',
  generalHint: 'Alles zur Bibliothek als Ganzes',
  noSounds: 'Mit diesem Filter ist nichts zu sehen.',
  play: 'Abspielen',
  stop: 'Stopp',
  loop: 'Schleife',
  oneshot: 'Einzelklang',
  ir: 'Impulsantwort',
  pathStructure: 'Struktur',
  pathCabin: 'Kabine',
  pathSensor: 'Sensor',
  pathRadio: 'Funk',
  dry: 'trocken',
  baked: 'Kabine eingebaut',
  viaRadio: 'Über Funk',
  seconds: 's',
  checks: 'Prüfungen',
  checksPass: 'alle Regeln bestanden',
  checksFail: 'durchgefallen',
  peakDb: 'Spitze',
  lufs: 'Lautheit',
  lowShare: 'unter 500 Hz',
  highShare: 'über 4 kHz',
  clapMargin: 'CLAP-Abstand',
  described: 'Das beschreibende Modell sagt',
  stars: 'Sterne',
  star1: '1 Stern',
  starsN: '{n} Sterne',
  verdictFits: 'Passt',
  verdictClose: 'Nah dran',
  verdictWrong: 'Falsch',
  note: 'Notiz',
  notePlaceholder: 'Was stimmt nicht, was ist gut?',
  group: 'Triebwerksstufen',
  groupHint: 'Ein Triebwerk, zwischen den Stufen mit gleicher Leistung übergeblendet.',
  thrust: 'Schub',
  levels: 'Stufen',
  scene: 'Szene',
  playScene: 'Szene abspielen',
  stopScene: 'Szene stoppen',
  sceneRunning: 'Läuft',
  sceneLive: 'Live',
  sceneLiveOff: 'Still',
  startLive: 'Ton starten',
  stopLive: 'Ton stoppen',
  sliders: 'Regler',
  heat: 'Hitze',
  boost: 'Boost',
  distance: 'Entfernung',
  events: 'Ereignisse',
  missing: 'Fehlt im Manifest, übersprungen',
  sceneNote: 'Notiz zu dieser Szene',
  speed: 'Testtempo',
  loaded: '{n} Klänge',
  exported: 'Exportiert',
  importFailed: 'Diese Datei ist keine Bewertungsdatei.',
  imported: 'Bewertungen importiert',
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, de };

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem('audition.lang');
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    // Storage can be blocked; the browser language is a fine default.
  }
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export const lang = signal<Lang>(initialLang());

export function setLang(next: Lang): void {
  lang.value = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem('audition.lang', next);
  } catch {
    // Not stored; the choice still holds for this visit.
  }
}

/** Reading `lang.value` here makes every component that calls t() rerender on a language switch. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  let s = dictionaries[lang.value][key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function loc(l: { en: string; de: string }): string {
  return l[lang.value];
}
