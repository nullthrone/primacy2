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
  described?: string;
}

export interface ManifestSound extends Loc {
  id: string;
  file: string;
  spectrogram?: string;
  category: string;
  kind: 'loop' | 'oneshot' | 'ir';
  path: 'structure' | 'cabin' | 'sensor' | 'radio';
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
}

export interface Manifest {
  version: number;
  placeholder?: boolean;
  categories: ManifestCategory[];
  sounds: ManifestSound[];
}

export interface SoundRating {
  stars: number;
  verdict: '' | 'fits' | 'close' | 'wrong';
  note: string;
  at: string;
}

export interface RatingsFile {
  version: 1;
  savedAt: string;
  manifest: { placeholder: boolean; count: number };
  ratings: Record<string, SoundRating>;
  scenes: Record<string, { note: string; at: string }>;
  general: string;
}
