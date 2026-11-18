/**
 * Name generators for systems, stations, outposts and factions. Every function is a pure
 * function of the `Rng` it is given, so names are identical on every machine.
 */
import type { Rng } from '../prng.ts';

/** Consonant groups that may start a name. */
const START_ONSETS = [
  'b', 'c', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z',
  'br', 'cr', 'dr', 'gr', 'kr', 'pr', 'tr', 'vr', 'th', 'sh', 'st', 'sk', 'gl', 'kh', 'qu',
] as const;
/** Consonant groups between two vowels; single consonants are listed twice to keep names soft. */
const MID_ONSETS = [
  'b', 'd', 'g', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z', 'l', 'm', 'n', 'r', 's', 't',
  'dr', 'th', 'sh', 'st', 'nd', 'lt', 'll', 'ss', 'nt', 'rv', 'ld', 'rm',
] as const;
/** Plain vowels, weighted toward the open ones. */
const VOWELS = ['a', 'a', 'a', 'e', 'e', 'e', 'i', 'i', 'o', 'o', 'o', 'u', 'y'] as const;
/** Vowel pairs; a name carries at most one. */
const DIPHTHONGS = ['ia', 'io', 'ae', 'ei', 'ou', 'ea', 'au'] as const;
/** What a name may end on after its last vowel. */
const ENDINGS = ['', '', '', 'n', 'r', 's', 'x', 'l', 'th', 'm', 'k', 'nd', 'rn', 'n', 'r', 's'] as const;

const MIN_LETTERS = 4;
const MAX_LETTERS = 12;

const isVowel = (ch: string): boolean => 'aeiouy'.includes(ch);

/** True when the word has three consonants or three vowels in a row, or the same letter three times. */
function hasAwkwardRun(word: string): boolean {
  let run = 1;
  let same = 1;
  for (let i = 1; i < word.length; i++) {
    run = isVowel(word[i]!) === isVowel(word[i - 1]!) ? run + 1 : 1;
    same = word[i] === word[i - 1] ? same + 1 : 1;
    if (run >= 3 || same >= 3) return true;
  }
  return false;
}

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A pronounceable proper name of 4 to 12 letters built from syllables, capitalised,
 * e.g. `Veldar`, `Thorien`, `Asku`.
 */
export function generateName(rng: Rng): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    const syllables = 2 + rng.weighted([10, 8, 1]);
    const pairAt = rng.chance(0.3) ? rng.int(0, syllables - 1) : -1;
    let word = '';
    for (let i = 0; i < syllables; i++) {
      // Some names open on a vowel: "Aldera", "Ostrin".
      if (i === 0) word += rng.chance(0.16) ? '' : rng.pick(START_ONSETS);
      else word += rng.pick(MID_ONSETS);
      word += i === pairAt ? rng.pick(DIPHTHONGS) : rng.pick(VOWELS);
    }
    word += rng.pick(ENDINGS);
    if (word.length >= MIN_LETTERS && word.length <= MAX_LETTERS && !hasAwkwardRun(word)) return capitalise(word);
  }
  // Every candidate was rejected, which the syllable tables make practically impossible.
  return capitalise(rng.pick(START_ONSETS) + 'a' + rng.pick(MID_ONSETS).charAt(0) + 'en');
}

/**
 * Draws from `make` until the result is not in `taken`, records it there and returns it.
 * Falls back to a numbered variant when the generator keeps colliding.
 */
export function uniqueName(rng: Rng, taken: Set<string>, make: (rng: Rng) => string): string {
  let name = make(rng);
  for (let attempt = 0; attempt < 64 && taken.has(name); attempt++) name = make(rng);
  for (let n = 2; taken.has(name); n++) name = `${make(rng)} ${romanNumeral(n)}`;
  taken.add(name);
  return name;
}

/** A unique system name; the fallback keeps it to letters only by appending a syllable. */
export function uniqueSystemName(rng: Rng, taken: Set<string>): string {
  let name = generateName(rng);
  for (let attempt = 0; attempt < 200 && taken.has(name); attempt++) name = generateName(rng);
  while (taken.has(name)) {
    const stem = name.length > MAX_LETTERS - 2 ? name.slice(0, MAX_LETTERS - 2) : name;
    name = stem + rng.pick(['ra', 'no', 'li', 'ta', 've']);
  }
  taken.add(name);
  return name;
}

/** Name of a large station, e.g. `Port Veldar`, `Thorien Hub`. */
export function stationName(rng: Rng): string {
  const n = generateName(rng);
  switch (rng.int(0, 6)) {
    case 0: return `Port ${n}`;
    case 1: return `${n} Station`;
    case 2: return `${n} Hub`;
    case 3: return `${n} Reach`;
    case 4: return `${n} Terminal`;
    case 5: return `${n} Anchorage`;
    default: return `${n} Citadel`;
  }
}

/** Name of a small outpost, e.g. `Camp Asku`, `Dorin Depot`. */
export function outpostName(rng: Rng): string {
  const n = generateName(rng);
  switch (rng.int(0, 5)) {
    case 0: return `${n} Outpost`;
    case 1: return `${n} Depot`;
    case 2: return `Camp ${n}`;
    case 3: return `${n} Rest`;
    case 4: return `${n} Waystation`;
    default: return `${n} Rig`;
  }
}

/** Name of a ground base, e.g. `Asku Landing`, `Fort Dorin`. */
export function baseName(rng: Rng): string {
  const n = generateName(rng);
  switch (rng.int(0, 5)) {
    case 0: return `${n} Landing`;
    case 1: return `${n} Base`;
    case 2: return `Fort ${n}`;
    case 3: return `${n} Diggings`;
    case 4: return `${n} Field`;
    default: return `${n} Ground`;
  }
}

/** Name of a political faction, e.g. `Veldar Combine`, `Free Thorien League`. */
export function factionName(rng: Rng): string {
  const n = generateName(rng);
  switch (rng.int(0, 8)) {
    case 0: return `${n} Combine`;
    case 1: return `${n} Syndicate`;
    case 2: return `Free ${n} League`;
    case 3: return `${n} Concord`;
    case 4: return `House ${n}`;
    case 5: return `${n} Collective`;
    case 6: return `${n} Dominion`;
    case 7: return `Order of ${n}`;
    default: return `${n} Compact`;
  }
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/** Roman numeral of a positive integer below 4000 (planet designations: I, II, III ...). */
export function romanNumeral(n: number): string {
  let rest = Math.max(1, Math.min(3999, Math.floor(n)));
  let out = '';
  for (const [value, digits] of ROMAN) {
    while (rest >= value) {
      out += digits;
      rest -= value;
    }
  }
  return out;
}

/** Lower-case letter designating the n-th moon of a planet (0 = `a`); wraps to `aa`, `ab` after `z`. */
export function moonLetter(n: number): string {
  const i = Math.max(0, Math.floor(n));
  const last = String.fromCharCode(97 + (i % 26));
  return i < 26 ? last : moonLetter(Math.floor(i / 26) - 1) + last;
}
