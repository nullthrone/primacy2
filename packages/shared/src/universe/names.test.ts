import { describe, expect, it } from 'vitest';
import { Rng } from '../prng.ts';
import {
  factionName, generateName, moonLetter, outpostName, romanNumeral, stationName, uniqueName, uniqueSystemName,
} from './names.ts';

describe('generateName', () => {
  const names = (() => {
    const rng = new Rng('names');
    return Array.from({ length: 5000 }, () => generateName(rng));
  })();

  it('produces capitalised words of 4 to 12 letters', () => {
    for (const n of names) expect(n).toMatch(/^[A-Z][a-z]{3,11}$/);
    const lengths = new Set(names.map((n) => n.length));
    expect(Math.min(...lengths)).toBe(4);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(10);
  });

  it('is pronounceable: no three consonants or three vowels in a row', () => {
    for (const n of names) {
      const word = n.toLowerCase();
      expect(word, n).not.toMatch(/[^aeiouy]{3}/);
      expect(word, n).not.toMatch(/[aeiouy]{3}/);
      expect(word, n).toMatch(/[aeiouy]/);
      expect(word, n).not.toMatch(/(.)\1\1/);
    }
  });

  it('is varied', () => {
    expect(new Set(names).size).toBeGreaterThan(4700);
    expect(new Set(names.map((n) => n[0])).size).toBeGreaterThanOrEqual(18);
    expect(new Set(names.map((n) => n.slice(-2))).size).toBeGreaterThan(40);
  });

  it('is deterministic for a seed', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    for (let i = 0; i < 50; i++) expect(generateName(a)).toBe(generateName(b));
    expect(generateName(new Rng(8))).not.toBe(generateName(new Rng(9)));
  });
});

describe('station, outpost and faction names', () => {
  it('follow their patterns', () => {
    const rng = new Rng('stations');
    const stations = new Set<string>();
    const outposts = new Set<string>();
    const factions = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const s = stationName(rng);
      expect(s).toMatch(/^(Port [A-Z][a-z]+|[A-Z][a-z]+ (Station|Hub|Reach|Terminal|Anchorage|Citadel))$/);
      stations.add(s.split(' ').find((w) => ['Port', 'Station', 'Hub', 'Reach', 'Terminal', 'Anchorage', 'Citadel'].includes(w))!);
      const o = outpostName(rng);
      expect(o).toMatch(/^(Camp [A-Z][a-z]+|[A-Z][a-z]+ (Outpost|Depot|Rest|Waystation|Rig))$/);
      outposts.add(o.split(' ').find((w) => ['Camp', 'Outpost', 'Depot', 'Rest', 'Waystation', 'Rig'].includes(w))!);
      const f = factionName(rng);
      expect(f).toMatch(/^(Free [A-Z][a-z]+ League|House [A-Z][a-z]+|Order of [A-Z][a-z]+|[A-Z][a-z]+ (Combine|Syndicate|Concord|Collective|Dominion|Compact))$/);
      factions.add(f);
      for (const name of [s, o, f]) expect(name.length).toBeLessThanOrEqual(48);
    }
    // Every pattern is used.
    expect(stations.size).toBe(7);
    expect(outposts.size).toBe(6);
    expect(factions.size).toBeGreaterThan(390);
  });
});

describe('unique names', () => {
  it('uniqueName never repeats, even with a generator that has few results', () => {
    const rng = new Rng('unique');
    const taken = new Set<string>(['A']);
    const few = (r: Rng): string => r.pick(['A', 'B', 'C']);
    const out = Array.from({ length: 12 }, () => uniqueName(rng, taken, few));
    expect(new Set(out).size).toBe(12);
    expect(out).not.toContain('A');
    for (const n of out) expect(taken.has(n)).toBe(true);
    expect(out.slice(0, 2).sort()).toEqual(['B', 'C']);
  });

  it('uniqueSystemName never repeats and keeps to letters', () => {
    const rng = new Rng('systems');
    const taken = new Set<string>();
    const out = Array.from({ length: 3000 }, () => uniqueSystemName(rng, taken));
    expect(new Set(out).size).toBe(3000);
    for (const n of out) expect(n).toMatch(/^[A-Z][a-z]{3,11}$/);
  });
});

describe('designations', () => {
  it('romanNumeral', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 40, 90, 400, 1994, 3999].map(romanNumeral)).toEqual(
      ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XIV', 'XL', 'XC', 'CD', 'MCMXCIV', 'MMMCMXCIX'],
    );
    expect(romanNumeral(0)).toBe('I');
    expect(romanNumeral(2.9)).toBe('II');
  });

  it('moonLetter', () => {
    expect([0, 1, 2, 3, 25, 26, 27, 51, 52].map(moonLetter)).toEqual(['a', 'b', 'c', 'd', 'z', 'aa', 'ab', 'az', 'ba']);
  });
});
