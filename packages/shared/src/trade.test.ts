import { describe, expect, it } from 'vitest';
import { COMMODITIES, HULLS, starterLoadout } from './catalog.ts';
import { PROTOCOL_VERSION } from './constants.ts';
import { generateKeyPair, idFromPublicKey } from './crypto.ts';
import { signDescriptor, verifyDescriptor, type ServerDescriptor, type TrustLevel } from './federation.ts';
import { sanitizePassport, type CargoItem } from './pilot.ts';
import {
  absorbable,
  attributeCargo,
  attributeLot,
  bindArrivingShip,
  cargoTradeUnits,
  defaultShipLimit,
  effectiveTier,
  hullAllowed,
  hullsByPrice,
  largestHullWithin,
  lotStatus,
  publishedRating,
  remainingAllowance,
  remainingLicence,
  rulesFingerprint,
  shipLimitFor,
  tradeUnits,
  type ArrivalRules,
} from './trade.ts';

const SELF = 'a'.repeat(16);
const UNION = 'b'.repeat(16);
const PARTNER = 'c'.repeat(16);
const VISITOR = 'd'.repeat(16);
const OTHER_PARTNER = 'e'.repeat(16);

const TIERS: Record<string, TrustLevel> = { [UNION]: 'union', [PARTNER]: 'partner', [OTHER_PARTNER]: 'partner', [VISITOR]: 'visitor' };
const tierOf = (id: string): TrustLevel => (Object.hasOwn(TIERS, id) ? TIERS[id]! : 'visitor');
const rules = (issuer: string): ArrivalRules => ({ self: SELF, issuer, issuerTier: tierOf(issuer), tierOf });
const lot = (origin: string, sealed = false): CargoItem => (sealed ? { c: 'food', n: 5, origin, sealed: true } : { c: 'food', n: 5, origin });

describe('trade units', () => {
  it('are tonnes times the catalog price', () => {
    expect(tradeUnits('food', 3)).toBe(3 * COMMODITIES.food!.price);
    expect(tradeUnits('made_up', 3)).toBe(0);
    expect(tradeUnits('__proto__', 3)).toBe(0);
    expect(tradeUnits('food', -1)).toBe(0);
    expect(cargoTradeUnits([{ c: 'food', n: 2 }, { c: 'alloys', n: 1 }])).toBe(2 * COMMODITIES.food!.price + COMMODITIES.alloys!.price);
  });
});

describe('rules fingerprint', () => {
  it('is stable, and changes with the catalog and with extra rule values', () => {
    const fp = rulesFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesFingerprint()).toBe(fp);
    expect(rulesFingerprint({ spread: 0.06 })).not.toBe(fp);
    const food = COMMODITIES.food!;
    const price = food.price;
    food.price = price + 1;
    try {
      expect(rulesFingerprint()).not.toBe(fp);
    } finally {
      food.price = price;
    }
    expect(rulesFingerprint()).toBe(fp);
  });
});

describe('effective tier', () => {
  it('is a customs union only when both sides say so and the rules match', () => {
    expect(effectiveTier('union', 'union', true)).toBe('union');
    expect(effectiveTier('union', 'union', false)).toBe('partner');
    expect(effectiveTier('union', 'partner', true)).toBe('partner');
    expect(effectiveTier('union', 'visitor', true)).toBe('partner');
    expect(effectiveTier('union', null, true)).toBe('partner');
  });

  it('leaves the other ratings as the operator set them', () => {
    for (const mine of ['partner', 'visitor', 'blocked'] as const) {
      expect(effectiveTier(mine, 'union', true)).toBe(mine);
      expect(effectiveTier(mine, null, false)).toBe(mine);
    }
  });

  it('reads the rating a descriptor publishes; a default never makes a union', () => {
    const desc = (defaultTrust: TrustLevel, union: string[], partner: string[]) => ({
      rules: { openPeering: true, defaultTrust, tariff: 0.1 },
      trade: { fingerprint: 'ab'.repeat(32), union, partner, shipLimit: { partner: null, visitor: null } },
    });
    expect(publishedRating(desc('visitor', [SELF], []), SELF)).toBe('union');
    expect(publishedRating(desc('visitor', [], [SELF]), SELF)).toBe('partner');
    expect(publishedRating(desc('visitor', [], []), SELF)).toBe('visitor');
    expect(publishedRating(desc('union', [], []), SELF)).toBe('partner');
    expect(publishedRating(desc('blocked', [], []), SELF)).toBe('blocked');
    // A descriptor stored by an older version has no trade policy at all.
    expect(publishedRating({ rules: { openPeering: true, defaultTrust: 'partner', tariff: 0 } } as never, SELF)).toBeNull();
  });
});

describe('trade policy in a descriptor', () => {
  const NOW = 1_800_000_000_000;
  const keys = generateKeyPair();
  const id = idFromPublicKey(keys.publicKey);
  const base = (): ServerDescriptor => ({
    v: 1, id, name: 'Alpha', url: 'http://localhost:8420', proto: PROTOCOL_VERSION, version: '0.1.0',
    pos: [10, 0, -5], radius: 18,
    systems: [{ id: `${id}:0`, name: 'Sol', pos: [11, 0, -5], starClass: 'G', security: 'secure', stations: 2, tags: [] }],
    links: [], gates: [],
    rules: { openPeering: true, defaultTrust: 'visitor', tariff: 0.1 },
    trade: { fingerprint: rulesFingerprint(), union: [UNION], partner: [PARTNER], shipLimit: { partner: null, visitor: 260_000 } },
    online: 0, updatedAt: NOW,
  });
  const check = (edit: (d: ServerDescriptor) => void) => {
    const d = base();
    edit(d);
    return verifyDescriptor(signDescriptor(d, keys), NOW);
  };

  it('is accepted when well formed and refused otherwise', () => {
    expect(check(() => {})).toMatchObject({ ok: true });
    expect(check((d) => delete (d as Partial<ServerDescriptor>).trade)).toMatchObject({ ok: false, reason: 'bad trade policy' });
    expect(check((d) => (d.trade.fingerprint = 'short'))).toMatchObject({ ok: false, reason: 'bad trade policy' });
    expect(check((d) => (d.trade.union = ['not an id']))).toMatchObject({ ok: false, reason: 'bad trade ratings' });
    expect(check((d) => (d.trade.partner = Array.from({ length: 257 }, () => PARTNER)))).toMatchObject({ ok: false, reason: 'bad trade ratings' });
    expect(check((d) => (d.trade.shipLimit = { partner: -1, visitor: null }))).toMatchObject({ ok: false, reason: 'bad ship limits' });
    expect(check((d) => ((d.rules as { defaultTrust: string }).defaultTrust = 'neutral'))).toMatchObject({ ok: false, reason: 'bad rules' });
  });

  it('a passport keeps a bound claim only in a clean shape', () => {
    const ship = starterLoadout('wisp');
    const claimed = sanitizePassport({ ship: { loadout: ship, bound: { hull: 'yes', slots: [true, 1, false] } } }, 'p'.repeat(16), { issuer: PARTNER });
    expect(claimed.ship.bound).toEqual({ hull: false, slots: ship.modules.map((_, i) => i === 0) });
    expect(sanitizePassport({ ship: { loadout: ship } }, 'p'.repeat(16), { issuer: PARTNER }).ship.bound).toBeUndefined();
  });
});

describe('attribution of an arriving lot', () => {
  it('from a visitor: everything is sealed and keeps its label', () => {
    for (const origin of [VISITOR, SELF, UNION, PARTNER]) {
      expect(attributeLot(lot(origin), rules(VISITOR))).toEqual(lot(origin, true));
    }
  });

  it("from a partner: its own goods and this server's goods become its imports, any other label is sealed", () => {
    expect(attributeLot(lot(PARTNER), rules(PARTNER))).toEqual(lot(PARTNER));
    expect(attributeLot(lot(SELF), rules(PARTNER))).toEqual(lot(PARTNER));
    expect(attributeLot(lot(OTHER_PARTNER), rules(PARTNER))).toEqual(lot(OTHER_PARTNER, true));
    expect(attributeLot(lot(UNION), rules(PARTNER))).toEqual(lot(UNION, true));
    expect(attributeLot(lot(VISITOR), rules(PARTNER))).toEqual(lot(VISITOR, true));
  });

  it('from a union member: the label is believed, never rewritten, and rated by this server', () => {
    expect(attributeLot(lot(SELF), rules(UNION))).toEqual(lot(SELF));
    expect(attributeLot(lot(UNION), rules(UNION))).toEqual(lot(UNION));
    expect(attributeLot(lot(PARTNER), rules(UNION))).toEqual(lot(PARTNER));
    expect(attributeLot(lot(VISITOR), rules(UNION))).toEqual(lot(VISITOR, true));
    expect(attributeLot(lot('f'.repeat(16)), rules(UNION))).toEqual(lot('f'.repeat(16), true));
  });

  it('a lot the issuer marked sealed stays sealed whoever sends it', () => {
    for (const issuer of [UNION, PARTNER, VISITOR]) {
      for (const origin of [SELF, issuer, UNION]) expect(attributeLot(lot(origin, true), rules(issuer))).toEqual(lot(origin, true));
    }
  });

  it('merges lots only when commodity, origin and sealed mark all match', () => {
    const cargo = attributeCargo([lot(PARTNER), lot(SELF), lot(OTHER_PARTNER), lot(OTHER_PARTNER, true), { c: 'alloys', n: 1, origin: PARTNER }], rules(PARTNER));
    expect(cargo).toEqual([
      { c: 'food', n: 10, origin: PARTNER },
      { c: 'food', n: 10, origin: OTHER_PARTNER, sealed: true },
      { c: 'alloys', n: 1, origin: PARTNER },
    ]);
  });

  it('status in the hold follows the mark first, then the current tier of the label', () => {
    expect(lotStatus(lot(SELF), SELF, tierOf)).toBe('local');
    expect(lotStatus(lot(SELF, true), SELF, tierOf)).toBe('sealed');
    expect(lotStatus(lot(UNION), SELF, tierOf)).toBe('free');
    expect(lotStatus(lot(PARTNER), SELF, tierOf)).toBe('import');
    expect(lotStatus(lot(VISITOR), SELF, tierOf)).toBe('sealed');
    expect(lotStatus(lot(UNION, true), SELF, tierOf)).toBe('sealed');
  });
});

describe('allowance and licence', () => {
  it('allowance is exports plus credit line less imports, never negative', () => {
    expect(remainingAllowance({ exports: 0, imports: 0 }, 50_000)).toBe(50_000);
    expect(remainingAllowance({ exports: 20_000, imports: 60_000 }, 50_000)).toBe(10_000);
    expect(remainingAllowance({ exports: 0, imports: 80_000 }, 50_000)).toBe(0);
  });

  it('licence is rate times non-trade income less what was used; no income, no licence', () => {
    expect(remainingLicence({ income: 0, used: 0 }, 1)).toBe(0);
    expect(remainingLicence({ income: 1_000, used: 400 }, 1)).toBe(600);
    expect(remainingLicence({ income: 1_000, used: 400 }, 2)).toBe(1_600);
    expect(remainingLicence({ income: 1_000, used: 4_000 }, 1)).toBe(0);
  });

  it('fills an import up to the smaller limit and says which one applied', () => {
    const price = COMMODITIES.food!.price;
    expect(absorbable('food', 10, 'local', 0, 0)).toEqual({ n: 10, limit: null });
    expect(absorbable('food', 10, 'free', 0, 0)).toEqual({ n: 10, limit: null });
    expect(absorbable('food', 10, 'sealed', 1e9, 1e9)).toEqual({ n: 0, limit: 'sealed' });
    expect(absorbable('food', 10, 'import', 1e9, 1e9)).toEqual({ n: 10, limit: null });
    expect(absorbable('food', 10, 'import', price * 4 + 1, 1e9)).toEqual({ n: 4, limit: 'allowance' });
    expect(absorbable('food', 10, 'import', 1e9, price * 7 - 1)).toEqual({ n: 6, limit: 'licence' });
    expect(absorbable('food', 10, 'import', 0, 0)).toEqual({ n: 0, limit: 'allowance' });
    expect(absorbable('food', 10, 'import', price * 10, price * 10)).toEqual({ n: 10, limit: null });
  });
});

describe('ships', () => {
  const ship = starterLoadout('drover');
  const allLocal = { hull: false, slots: ship.modules.map(() => false) };

  it('a ship from outside the union is bound; from inside only what the member says', () => {
    for (const tier of ['partner', 'visitor'] as const) {
      const b = bindArrivingShip(ship, tier, allLocal, null);
      expect(b.hull).toBe(true);
      expect(b.slots.every((x) => x)).toBe(true);
    }
    expect(bindArrivingShip(ship, 'union', undefined, null)).toEqual(allLocal);
    const claimed = { hull: true, slots: ship.modules.map((_, i) => i === 1) };
    expect(bindArrivingShip(ship, 'union', claimed, null)).toEqual(claimed);
  });

  it('recognises the ship the pilot left with; a changed module or hull stays bound', () => {
    const departed = { hull: ship.hull, modules: [...ship.modules], bound: allLocal };
    expect(bindArrivingShip(ship, 'partner', undefined, departed)).toEqual(allLocal);

    const changed = { hull: ship.hull, modules: ship.modules.map((m, i) => (i === 0 ? 'other_module' : m)) };
    const b = bindArrivingShip(changed, 'partner', undefined, departed);
    expect(b.hull).toBe(false);
    expect(b.slots[0]).toBe(true);
    expect(b.slots.slice(1).every((x) => !x)).toBe(true);

    const otherHull = starterLoadout('bulwark');
    const c = bindArrivingShip(otherHull, 'visitor', undefined, departed);
    expect(c.hull).toBe(true);
    expect(c.slots.every((x) => x)).toBe(true);
  });

  it('never makes local what was bound when the ship left', () => {
    const departed = { hull: ship.hull, modules: [...ship.modules], bound: { hull: true, slots: ship.modules.map((_, i) => i !== 2) } };
    const b = bindArrivingShip(ship, 'partner', undefined, departed);
    expect(b.hull).toBe(true);
    expect(b.slots.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0)).toEqual([2]);
  });

  it('class limits: none for the union, the two dearest hulls stay out for visitors by default', () => {
    const byPrice = hullsByPrice();
    expect(HULLS[byPrice[0]!]!.price).toBeGreaterThanOrEqual(HULLS[byPrice[1]!]!.price);
    const def = defaultShipLimit();
    expect(def.partner).toBeNull();
    expect(def.visitor).toBe(byPrice[2]);
    const limits = { partner: null, visitor: HULLS[def.visitor!]!.price };
    expect(shipLimitFor('union', limits)).toBeNull();
    expect(shipLimitFor('partner', limits)).toBeNull();
    const cap = shipLimitFor('visitor', limits);
    expect(hullAllowed(byPrice[0]!, cap)).toBe(false);
    expect(hullAllowed(byPrice[1]!, cap)).toBe(false);
    expect(hullAllowed(byPrice[2]!, cap)).toBe(true);
    expect(hullAllowed('wisp', cap)).toBe(true);
    expect(hullAllowed('made_up', cap)).toBe(false);
    expect(hullAllowed('made_up', null)).toBe(true);
    expect(largestHullWithin(cap!)).toBe(byPrice[2]);
    expect(largestHullWithin(0)).toBeNull();
  });
});
