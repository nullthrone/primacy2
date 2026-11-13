/**
 * Review of the landing core, server part: where a transfer ticket may put a ship. A ticket names
 * the anchor a ship arrives at when it comes through a warp gate. Since ground bases are sites too,
 * any site id that exists is a valid anchor, and the ticket is signed by the sending server, not
 * by anyone this server can check the choice against.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, idFromPublicKey, issueTicket, newPassport, randomNonce } from '@primacy2/shared';
import type { PrimacyServer } from '@primacy2/server';
import { Bot } from './bot.ts';
import { Cluster, testKeys } from './harness.ts';

const c = new Cluster();
let A: PrimacyServer;
let B: PrimacyServer;

afterAll(async () => {
  await c.stop();
});

beforeAll(async () => {
  A = await c.start({ name: 'Alpha', seed: 'alpha' });
  B = await c.start({ name: 'Beta', seed: 'beta', peers: [A.url] });
  await B.peer();
});

async function refusal(site: number | undefined): Promise<string> {
  const player = generateKeyPair();
  const ticket = issueTicket(
    {
      issuer: A.id, dest: B.id, playerKey: player.publicKey,
      passport: newPassport(idFromPublicKey(player.publicKey), 'Stray', A.id),
      arrival: { kind: 'gate', system: `${B.id}:0`, ...(site !== undefined ? { site } : {}) }, nonce: randomNonce(), nowMs: c.nowMs,
    },
    testKeys('Alpha'),
  );
  try {
    const b = await Bot.connect(B.url, { keys: player, ticket });
    b.close();
    return 'accepted';
  } catch (err) {
    const b = (err as { bot?: Bot }).bot;
    if (!b) throw err;
    return b.authFail?.msg ?? 'no message';
  }
}

describe('arrival at a gate', () => {
  it('names a gate: a ticket whose gate is a station, a ground base or nothing is refused for that reason', async () => {
    const def = B.world.defs.get(`${B.id}:0`)!;
    const station = def.sites.find((s) => s.kind === 'station' || s.kind === 'outpost')!;
    expect(await refusal(station.id)).toMatch(/gate/i);
    const base = def.sites.find((s) => s.kind === 'base');
    if (base) expect(await refusal(base.id)).toMatch(/gate/i);
    expect(await refusal(undefined)).toMatch(/gate/i);
  });
});
