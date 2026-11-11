/** English strings. Keys are stable identifiers; `de.ts` must define every key. */
export const en = {
  'app.title': 'PRIMACY2',
} as const;

export type StringKey = keyof typeof en;
