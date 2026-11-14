// Shape of assets/audio/render/manifest.json, see tools/audio/SOUND_DESIGN.md section 3.

export interface Loc {
  en: string;
  de: string;
}

export interface ManifestCategory extends Loc {
  id: string;
}

export interface SoundChecks {
  pass: boolean;
  failed: string[];
  peakDb?: number;
  lufs?: number;
  lowShare?: number;
  highShare?: number;
  clap?: { best: string; margin: number };
  /** Soft warnings that do not fail the sound, for example "clap-margin". */
  hints?: string[];
  described?: string;
}

export interface ManifestSound extends Loc {
  id: string;
  file: string;
  spectrogram?: string;
  category: string;
  kind: 'loop' | 'oneshot' | 'ir';
  path: 'structure' | 'cabin' | 'sensor' | 'radio' | 'energy';
  family?: string | null;
  params?: { thrust?: number } & Record<string, unknown>;
  intent: string;
  source: string;
  licence: string;
  duration: number;
  channels: number;
  gain?: number;
  dry?: boolean;
  checks?: SoundChecks;
  /** First twelve hex digits of the SHA-256 of the file, written by the build; absent in older manifests. */
  hash?: string;
  /** Direction in degrees (0 ahead, 90 right, -90 left, 180 behind), or 'event' when the game decides each time. */
  place?: number | 'event' | null;
  /** Seconds after which the next sound of a chain starts. */
  cue?: number;
}

export interface Manifest {
  version: number;
  placeholder?: boolean;
  categories: ManifestCategory[];
  sounds: ManifestSound[];
}

/** An earlier rating that was replaced because the sound's file had changed. Kept so that nothing is lost. */
export interface PastRating {
  stars: number;
  verdict: '' | 'fits' | 'close' | 'wrong';
  note: string;
  at: string;
  hash?: string;
}

export interface SoundRating {
  stars: number;
  verdict: '' | 'fits' | 'close' | 'wrong';
  note: string;
  at: string;
  /** Hash of the file as it was when rated. Without it the rating was given on the files of round 1. */
  hash?: string;
  history?: PastRating[];
}

export interface RatingsFile {
  version: 1;
  savedAt: string;
  manifest: { placeholder: boolean; count: number };
  ratings: Record<string, SoundRating>;
  scenes: Record<string, { note: string; at: string }>;
  general: string;
}
