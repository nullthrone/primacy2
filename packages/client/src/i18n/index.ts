/**
 * Translations. `t('key', { name: 'x' })` returns the string in the current language with
 * `{name}` placeholders filled in. Reading `t` inside a component subscribes it to language changes.
 */
import { store } from '../state/store.ts';
import { de } from './de.ts';
import { en, type StringKey } from './en.ts';

const tables: Record<'en' | 'de', Partial<Record<StringKey, string>>> = { en, de };

export function t(key: StringKey, params?: Record<string, string | number>): string {
  const table = tables[store.settings.value.lang] ?? en;
  let text: string = table[key] ?? en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** Number formatting in the current language, e.g. 12,345 or 12.345. */
export function fmt(n: number, digits = 0): string {
  return n.toLocaleString(store.settings.value.lang === 'de' ? 'de-DE' : 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export type { StringKey };
