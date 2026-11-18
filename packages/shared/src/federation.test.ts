import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeShipStats,
  decodeSnapshot,
  Domain,
  encodeSnapshot,
  FlightMode,
  generateKeyPair,
  HULLS,
  idFromPublicKey,
  isValidServerUrl,
  issueTicket,
  MODULES,
  newPassport,
  normalizeLoadout,
  PROTOCOL_VERSION,
  randomNonce,
  sanitizeName,
  sanitizePassport,
  signBody,
  signDescriptor,
  signEnvelope,
  starterLoadout,
  TICKET_TTL_MS,
  verifyDescriptor,
  verifyEnvelope,
  verifySigned,
  verifyTicket,
  type ServerDescriptor,
  type ShipState,
  type Signed,
  type TransferTicket,
} from './index.ts';

const NOW = 1_800_000_000_000;

function makeServer(name = 'Alpha') {
  const keys = generateKeyPair();
  const id = idFromPublicKey(keys.publicKey);
  const desc: ServerDescriptor = {
    v: 1, id, name, url: 'http://localhost:8420', proto: PROTOCOL_VERSION, version: '0.1.0',
    pos: [10, 0, -5], radius: 18,
    systems: [{ id: `${id}:0`, name: 'Sol', pos: [11, 0, -5], starClass: 'G', security: 'secure', stations: 2, tags: [] }],
    links: [], gates: [],
    rules: { openPeering: true, defaultTrust: 'partner', tariff: 0.1 },
    trade: { fingerprint: 'ab'.repeat(32), union: [], partner: [], shipLimit: { partner: null, visitor: 260_000 } },
    online: 0, updatedAt: NOW,
  };
  return { keys, id, desc };
}

describe('canonicalJson', () => {
  it('sorts keys and is stable', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }], z: undefined })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson([Infinity])).toThrow();
  });
});

describe('signatures', () => {
  it('verifies a signed body and rejects tampering', () => {
    const keys = generateKeyPair();
    const signed = signBody(Domain.Fed, { hello: 'world', n: 1 }, keys);
    expect(verifySigned(Domain.Fed, signed)).toBe(true);
    expect(verifySigned(Domain.Fed, { ...signed, body: { hello: 'world', n: 2 } })).toBe(false);
  });
  it('does not accept a signature in another domain', () => {
    const keys = generateKeyPair();
    const signed = signBody(Domain.Fed, { a: 1 }, keys);
    expect(verifySigned(Domain.Ticket, signed)).toBe(false);
  });
  it('never throws on garbage', () => {
    for (const junk of [null, 1, 'x', {}, { body: {}, key: 'zz', sig: 'zz' }, { body: { a: NaN }, key: '', sig: '' }]) {
      expect(verifySigned(Domain.Fed, junk)).toBe(false);
    }
  });
});

describe('descriptor', () => {
  it('accepts a valid descriptor', () => {
    const { keys, desc } = makeServer();
    expect(verifyDescriptor(signDescriptor(desc, keys), NOW).ok).toBe(true);
  });
  it('rejects an id that does not belong to the key', () => {
    const a = makeServer();
    const b = makeServer();
    const forged = signDescriptor({ ...a.desc }, b.keys);
    expect(verifyDescriptor(forged, NOW)).toMatchObject({ ok: false });
  });
  it('rejects systems outside the server namespace', () => {
    const a = makeServer();
    const b = makeServer();
    const desc = { ...a.desc, systems: [{ ...a.desc.systems[0]!, id: `${b.id}:0` }] };
    expect(verifyDescriptor(signDescriptor(desc, a.keys), NOW)).toMatchObject({ ok: false });
  });
  it('rejects stale and future descriptors', () => {
    const { keys, desc } = makeServer();
    expect(verifyDescriptor(signDescriptor({ ...desc, updatedAt: NOW + 3_600_000 }, keys), NOW).ok).toBe(false);
    expect(verifyDescriptor(signDescriptor({ ...desc, updatedAt: NOW - 30 * 86_400_000 }, keys), NOW).ok).toBe(false);
  });
  it('rejects bad urls', () => {
    for (const url of ['ftp://x', 'http://user:pw@host', 'http://host/path', 'javascript:alert(1)', 'http://host?x=1', '']) {
      expect(isValidServerUrl(url)).toBe(false);
    }
    expect(isValidServerUrl('https://play.example.org')).toBe(true);
    expect(isValidServerUrl('http://127.0.0.1:8420')).toBe(true);
  });
});

describe('transfer ticket', () => {
  const issuer = makeServer('Issuer');
  const dest = makeServer('Dest');
  const player = generateKeyPair();
  const playerId = idFromPublicKey(player.publicKey);
  const make = (over: Partial<Parameters<typeof issueTicket>[0]> = {}): Signed<TransferTicket> =>
    issueTicket(
      {
        issuer: issuer.id, dest: dest.id, playerKey: player.publicKey,
        passport: newPassport(playerId, 'Ada', issuer.id),
        arrival: { kind: 'fold', system: `${dest.id}:0` },
        nonce: randomNonce(), nowMs: NOW, ...over,
      },
      issuer.keys,
    );
  const ctx = { selfId: dest.id, playerKey: player.publicKey, nowMs: NOW + 1000 };

  it('accepts a valid ticket', () => {
    expect(verifyTicket(make(), ctx).ok).toBe(true);
  });
  it('rejects a tampered passport', () => {
    const t = make();
    const tampered = { ...t, body: { ...t.body, passport: { ...t.body.passport, name: 'Mallory' } } };
    expect(verifyTicket(tampered, ctx)).toEqual({ ok: false, reason: 'bad signature' });
  });
  it('rejects a ticket addressed to another server', () => {
    const other = makeServer('Other');
    expect(verifyTicket(make(), { ...ctx, selfId: other.id }).ok).toBe(false);
  });
  it('rejects a ticket for another player', () => {
    const other = generateKeyPair();
    expect(verifyTicket(make(), { ...ctx, playerKey: other.publicKey }).ok).toBe(false);
  });
  it('rejects an expired ticket', () => {
    expect(verifyTicket(make(), { ...ctx, nowMs: NOW + TICKET_TTL_MS + 1 }).ok).toBe(false);
  });
  it('rejects an issuer id that does not match the signing key', () => {
    const t = make();
    const mallory = generateKeyPair();
    const forged = signBody(Domain.Ticket, t.body, mallory);
    expect(verifyTicket(forged, ctx)).toEqual({ ok: false, reason: 'issuer does not match key' });
  });
  it('rejects an over-long validity window', () => {
    const t = make();
    const long = signBody(Domain.Ticket, { ...t.body, expiresAt: t.body.issuedAt + TICKET_TTL_MS * 100 }, issuer.keys);
    expect(verifyTicket(long, ctx).ok).toBe(false);
  });
  it('rejects arrival in a system of another server', () => {
    expect(verifyTicket(make({ arrival: { kind: 'fold', system: `${issuer.id}:0` } }), ctx).ok).toBe(false);
  });
  it('rejects a self-issued ticket', () => {
    const self = issueTicket(
      {
        issuer: dest.id, dest: dest.id, playerKey: player.publicKey, passport: newPassport(playerId, 'Ada', dest.id),
        arrival: { kind: 'fold', system: `${dest.id}:0` }, nonce: randomNonce(), nowMs: NOW,
      },
      dest.keys,
    );
    expect(verifyTicket(self, ctx).ok).toBe(false);
  });
});

describe('fed envelope', () => {
  it('binds sender, addressee and time', () => {
    const a = makeServer();
    const b = makeServer();
    const env = signEnvelope(a.id, b.id, { op: 'x' }, randomNonce(), NOW, a.keys);
    expect(verifyEnvelope(env, b.id, NOW).ok).toBe(true);
    expect(verifyEnvelope(env, a.id, NOW).ok).toBe(false);
    expect(verifyEnvelope(env, b.id, NOW + 10 * 60_000).ok).toBe(false);
    const forged = signEnvelope(a.id, b.id, { op: 'x' }, randomNonce(), NOW, b.keys);
    expect(verifyEnvelope(forged, b.id, NOW).ok).toBe(false);
  });
});

describe('passport sanitising', () => {
  const issuer = 'abcdefghijklmnop';
  const playerId = 'qrstuvwxyz234567';
  it('clamps everything a hostile server could inflate', () => {
    const hostile = {
      playerId: 'someoneelse',
      name: '<script>alert(1)</script>' + 'x'.repeat(200),
      ship: {
        loadout: { hull: 'wisp', modules: ['rail_1', 'nonexistent', 'reactor_3', 'cargo_3', 'fold_3', 'x', 'cargo_3', 'cargo_3'] },
        hull: 1e12,
        fuel: 1e12,
        cargo: [
          { c: 'exotic_matter', n: 1e9, origin: 'abcdefghijklmnop' },
          { c: 'not_a_commodity', n: 5, origin: 'abcdefghijklmnop' },
          { c: 'food', n: -4, origin: 5 },
          { c: 'toString', n: 3, origin: 'abcdefghijklmnop' },
        ],
      },
      stats: { kills: -5, jumps: 'many', distance: Infinity },
      home: 'not an id',
      seq: 3.7,
      credits: 1e15,
    };
    const p = sanitizePassport(hostile, playerId, { issuer });
    const stats = computeShipStats(p.ship.loadout);
    expect(p.playerId).toBe(playerId);
    expect(p.name.length).toBeLessThanOrEqual(24);
    expect(p.name).not.toMatch(/[<>]/);
    expect(p.ship.hull).toBeLessThanOrEqual(stats.hullMax);
    expect(p.ship.fuel).toBeLessThanOrEqual(stats.fuelCap);
    expect(p.ship.cargo.reduce((s, c) => s + c.n, 0)).toBeLessThanOrEqual(stats.cargoCap);
    expect(p.ship.cargo.every((c) => c.c === 'exotic_matter')).toBe(true);
    // a weapon in slot 0 is fine, but modules in the wrong slot type are dropped or reset to stock
    expect(p.ship.loadout.modules[0]).toBe('rail_1');
    expect(p.ship.loadout.modules[1]).toBeNull();
    expect(p.ship.loadout.modules[2]).toBe('shield_1');
    expect(p.stats.kills).toBe(0);
    expect(p.stats.distance).toBe(0);
    expect(p.home).toBe(issuer);
    expect(p.seq).toBe(3);
    expect((p as unknown as Record<string, unknown>).credits).toBeUndefined();
  });
  it('impounds cargo when asked', () => {
    const base = newPassport(playerId, 'Ada', issuer);
    base.ship.cargo.push({ c: 'food', n: 4, origin: issuer });
    // A sealed mark travels with its lot; lots that differ only in the mark do not merge.
    const marked = sanitizePassport(
      { ship: { loadout: { hull: 'wisp', modules: [] }, cargo: [
        { c: 'food', n: 2, origin: issuer, sealed: true }, { c: 'food', n: 3, origin: issuer }, { c: 'food', n: 1, origin: issuer, sealed: 'yes' },
      ] } },
      playerId, { issuer },
    ).ship.cargo;
    expect(marked).toEqual([{ c: 'food', n: 2, origin: issuer, sealed: true }, { c: 'food', n: 4, origin: issuer }]);
    expect(sanitizePassport(base, playerId, { issuer }).ship.cargo).toEqual([{ c: 'food', n: 4, origin: issuer }]);
  });
  it('survives total garbage', () => {
    for (const junk of [null, undefined, 42, 'str', [], { ship: 7 }, { ship: { loadout: { hull: 'bulwark', modules: 'x' } } }]) {
      const p = sanitizePassport(junk, playerId, { issuer });
      expect(HULLS[p.ship.loadout.hull]).toBeDefined();
      expect(p.ship.hull).toBeGreaterThan(0);
    }
  });
  it('sanitises names', () => {
    expect(sanitizeName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(sanitizeName('‮evil')).toBe('evil');
    expect(sanitizeName('')).toBe('Pilot');
    expect(sanitizeName(12)).toBe('Pilot');
  });
});

describe('catalog', () => {
  it('every stock loadout is valid and survives normalisation unchanged', () => {
    for (const hull of Object.values(HULLS)) {
      expect(hull.stock.length).toBe(hull.slots.length);
      expect(hull.hardpoints.length).toBe(hull.slots.filter((s) => s === 'weapon').length);
      hull.stock.forEach((id, i) => {
        if (id !== null) expect(MODULES[id]?.slot, `${hull.id} slot ${i}`).toBe(hull.slots[i]);
      });
      expect(normalizeLoadout(starterLoadout(hull.id))).toEqual(starterLoadout(hull.id));
      const stats = computeShipStats(starterLoadout(hull.id));
      for (const v of Object.values(stats)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      expect(stats.accelFwd).toBeGreaterThan(5);
      expect(stats.jumpRange).toBeGreaterThan(5);
    }
  });
  it('unknown hull falls back to the starter', () => {
    expect(normalizeLoadout({ hull: 'deathstar', modules: [] }).hull).toBe('wisp');
    expect(normalizeLoadout({ hull: '__proto__', modules: [] }).hull).toBe('wisp');
  });
});

describe('snapshot codec', () => {
  it('round-trips self state exactly and entities within quantisation', () => {
    const self: ShipState = {
      mode: FlightMode.Cruise, anchor: 1003, fa: false, chargeKind: 2,
      pos: [1.23456789012e11, -4.5e9, 7.000000001e10], vel: [1e8, -2.5, 3.25],
      rot: [0.1, 0.2, 0.3, 0.9273618495495703], angVel: [0.01, -0.02, 0.03], aim: [0.1, -0.2],
      throttle: 0.75, cruiseSpeed: 2.5e8, boost: 1.5, boostCd: 0.5,
      energy: 88.5, heat: 12.25, fuel: 6.5, shield: 150, hull: 200, shieldDelay: 2, charge: 0.4, dilation: 0.93,
      pips: 0x228, sig: 3.375,
    };
    const snap = {
      tick: 123456, ackSeq: 4_000_000_000, time: 27_000_000.125, self,
      ents: [
        { id: 7, flags: 5, hull: 1, shield: 0.5, pos: [10.5, -20.25, 3000] as [number, number, number], vel: [1, 2, 3] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number] },
        { id: 4_000_000_001, flags: 0, hull: 0.25, shield: 0, pos: [0, 0, 0] as [number, number, number], vel: [0, 0, 0] as [number, number, number], rot: [0.5, 0.5, 0.5, 0.5] as [number, number, number, number] },
      ],
    };
    const out = decodeSnapshot(encodeSnapshot(snap))!;
    expect(out.self).toEqual(self);
    expect(out.tick).toBe(snap.tick);
    expect(out.ackSeq).toBe(snap.ackSeq);
    expect(out.time).toBe(snap.time);
    expect(out.ents.length).toBe(2);
    expect(out.ents[0]!.id).toBe(7);
    expect(out.ents[0]!.pos).toEqual([10.5, -20.25, 3000]);
    expect(out.ents[0]!.shield).toBeCloseTo(0.5, 2);
    expect(out.ents[1]!.id).toBe(4_000_000_001);
    expect(out.ents[1]!.rot[0]).toBeCloseTo(0.5, 3);
  });
  it('handles no self and rejects truncated data', () => {
    const buf = encodeSnapshot({ tick: 1, ackSeq: 0, time: 0, self: null, ents: [] });
    expect(decodeSnapshot(buf)).toMatchObject({ self: null, ents: [] });
    expect(decodeSnapshot(buf.slice(0, 5))).toBeNull();
    expect(decodeSnapshot(new Uint8Array([9, 9, 9]).buffer)).toBeNull();
  });
});
