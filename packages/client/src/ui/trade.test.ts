import { describe, expect, it } from 'vitest';
import type { CargoItem, GalaxyView, SectorView, TrustLevel } from '@primacy2/shared';
import { holdInFlight, isSaleLimit, isTier, jumpForecast, sectorName, tiersAtStation } from './trade.ts';

const SELF = 'self';

function sector(id: string, tier: TrustLevel): SectorView {
  return {
    id, name: `Sector ${id}`, url: `http://${id}`, pos: [0, 0, 0], radius: 1, online: true, linked: true,
    trust: tier, tier, rulesMatch: true, allowance: tier === 'partner' ? 1000 : null, entryTier: tier, entryHullCap: null, players: 0, systems: [], links: [], gates: [],
  };
}

const galaxy = (self: string): GalaxyView => ({
  self, sectors: [sector(self, 'union'), sector('union', 'union'), sector('partner', 'partner'), sector('visitor', 'visitor')],
});

const cargo: CargoItem[] = [
  { c: 'iron_ore', n: 10, origin: SELF },
  { c: 'iron_ore', n: 2, origin: SELF, sealed: true },
  { c: 'iron_ore', n: 3, origin: 'union' },
  { c: 'iron_ore', n: 4, origin: 'partner' },
  { c: 'iron_ore', n: 5, origin: 'visitor' },
  { c: 'iron_ore', n: 6, origin: 'visitor', sealed: true },
  { c: 'iron_ore', n: 7, origin: 'nowhere' },
];

describe('holdInFlight', () => {
  it('counts sealed marks and visitor goods as sealed, partner goods as imports', () => {
    expect(holdInFlight(cargo, SELF, galaxy(SELF))).toEqual({ sealed: 2 + 5 + 6, imports: 4 });
  });

  it('leaves out an unmarked lot from a sector the view does not list', () => {
    const only: CargoItem[] = [{ c: 'iron_ore', n: 7, origin: 'nowhere' }];
    expect(holdInFlight(only, SELF, galaxy(SELF))).toEqual({ sealed: 0, imports: 0 });
  });

  it('goes by the seal marks alone when the galaxy view is missing or from another sector', () => {
    expect(holdInFlight(cargo, SELF, null)).toEqual({ sealed: 2 + 6, imports: 0 });
    expect(holdInFlight(cargo, SELF, galaxy('partner'))).toEqual({ sealed: 2 + 6, imports: 0 });
  });

  it('reports nothing for a hold of local goods', () => {
    expect(holdInFlight([{ c: 'iron_ore', n: 10, origin: SELF }], SELF, galaxy(SELF))).toEqual({ sealed: 0, imports: 0 });
  });
});

describe('jumpForecast', () => {
  it('sorts the hold into sealed lots, lots of the two sectors and lots of third sectors', () => {
    expect(jumpForecast(cargo, SELF, 'partner')).toEqual({ sealed: 2 + 6, direct: 10 + 4, third: 3 + 5 + 7 });
  });

  it('is all zero for an empty hold', () => {
    expect(jumpForecast([], SELF, 'partner')).toEqual({ sealed: 0, direct: 0, third: 0 });
  });
});

describe('view guards', () => {
  it('accept only the tiers and limits there are words for', () => {
    expect(isTier('partner')).toBe(true);
    expect(isTier('constructor')).toBe(false);
    expect(isTier(undefined)).toBe(false);
    expect(isSaleLimit('missing')).toBe(true);
    expect(isSaleLimit('toString')).toBe(false);
    expect(isSaleLimit(null)).toBe(false);
  });

  it('rate an origin the station view does not list like a visitor', () => {
    const tierOf = tiersAtStation([{ origin: 'partner', name: 'P', tier: 'partner', allowance: 10, tonnes: 1, sealed: 0 }]);
    expect(tierOf('partner')).toBe('partner');
    expect(tierOf('nowhere')).toBe('visitor');
  });

  it('name a sector from the galaxy view, or by the start of its id', () => {
    expect(sectorName(galaxy(SELF), 'partner')).toBe('Sector partner');
    expect(sectorName(null, 'abcdefghij')).toBe('abcdef');
  });
});
