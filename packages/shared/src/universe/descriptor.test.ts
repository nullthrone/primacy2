import { describe, expect, it } from 'vitest';
import {
  canonicalJson, chooseSectorCenter, DEFAULT_SECTOR_RADIUS, GAME_VERSION, generateKeyPair, generateSector, idFromPublicKey,
  MAX_DESCRIPTOR_BYTES, MAX_SYSTEMS_PER_SECTOR, nearestPair, PROTOCOL_VERSION, sectorOffsets, signDescriptor, summarize,
  upsertGateSite, verifyDescriptor, type GateLink, type ServerDescriptor, type SystemDef, type Vec3,
} from '../index.ts';

const NOW = 1_800_000_000_000;

function makeDescriptor(id: string, center: Vec3, radius: number, systems: SystemDef[], gates: GateLink[] = []): ServerDescriptor {
  return {
    v: 1, id, name: 'Generated Sector', url: 'http://localhost:8420', proto: PROTOCOL_VERSION, version: GAME_VERSION,
    pos: center, radius, systems: systems.map(summarize), links: [], gates,
    rules: { openPeering: true, defaultTrust: 'neutral', tariff: 0.1 },
    online: 0, updatedAt: NOW,
  };
}

describe('descriptor compatibility', () => {
  it('a descriptor built from a generated sector passes verifyDescriptor', () => {
    for (const count of [1, 16, MAX_SYSTEMS_PER_SECTOR]) {
      const keys = generateKeyPair();
      const id = idFromPublicKey(keys.publicKey);
      const center: Vec3 = [10, 0, -5];
      const systems = generateSector({ serverId: id, seed: 'descriptor', center, radius: DEFAULT_SECTOR_RADIUS, count });
      const signed = signDescriptor(makeDescriptor(id, center, DEFAULT_SECTOR_RADIUS, systems), keys);
      const result = verifyDescriptor(signed, NOW);
      expect(result).toEqual({ ok: true, value: signed });
      expect(signed.body.systems).toHaveLength(count);
      expect(signed.body.systems[0]!.id).toBe(`${id}:0`);
      // The full system list of the largest sector is far below the descriptor size limit.
      expect(canonicalJson(signed).length).toBeLessThan(MAX_DESCRIPTOR_BYTES / 4);
    }
  });

  it('holds for many keys, seeds, radii and placements', () => {
    for (let k = 0; k < 12; k++) {
      const keys = generateKeyPair();
      const id = idFromPublicKey(keys.publicKey);
      const radius = [3, 8, DEFAULT_SECTOR_RADIUS, 40, 150, 500][k % 6]!;
      const offsets = sectorOffsets(id, `seed-${k}`, radius, 24);
      const center = chooseSectorCenter({ serverId: id, offsets, radius, peer: null, others: [], reach: 9 });
      const systems = generateSector({ serverId: id, seed: `seed-${k}`, center, radius, count: 24 });
      const result = verifyDescriptor(signDescriptor(makeDescriptor(id, center, radius, systems), keys), NOW);
      expect(result, `radius ${radius}: ${result.ok ? '' : result.reason}`).toMatchObject({ ok: true });
    }
  });

  it('holds for a sector placed beside a peer, including its gate', () => {
    const peerKeys = generateKeyPair();
    const peerId = idFromPublicKey(peerKeys.publicKey);
    const peerCenter: Vec3 = [-30, 3, 60];
    const peerSystems = generateSector({ serverId: peerId, seed: 'peer', center: peerCenter, radius: DEFAULT_SECTOR_RADIUS, count: 32 });

    const keys = generateKeyPair();
    const id = idFromPublicKey(keys.publicKey);
    const offsets = sectorOffsets(id, 'mine', DEFAULT_SECTOR_RADIUS, 32);
    const center = chooseSectorCenter({
      serverId: id, offsets, radius: DEFAULT_SECTOR_RADIUS, reach: 9, others: [],
      peer: { pos: peerCenter, radius: DEFAULT_SECTOR_RADIUS, systems: peerSystems.map(summarize) },
    });
    const systems = generateSector({ serverId: id, seed: 'mine', center, radius: DEFAULT_SECTOR_RADIUS, count: 32 });

    // The starter hull (9 ly) can jump across.
    const pair = nearestPair(systems, peerSystems)!;
    expect(pair.dist).toBeGreaterThanOrEqual(4.5);
    expect(pair.dist).toBeLessThanOrEqual(8.1);

    // A gate between the two closest systems, advertised in the descriptor.
    const site = upsertGateSite(
      pair.a,
      { linkId: 'link-0001', peer: peerId, remoteSystem: pair.b.id, state: 'building', progress: 0.25, remoteProgress: 0 },
      [pair.b.pos[0] - pair.a.pos[0], pair.b.pos[1] - pair.a.pos[1], pair.b.pos[2] - pair.a.pos[2]],
    );
    const gates: GateLink[] = [{
      linkId: site.gate!.linkId, system: pair.a.id, site: site.id, peer: peerId, remoteSystem: pair.b.id, state: site.gate!.state, progress: site.gate!.progress,
    }];
    const signed = signDescriptor(makeDescriptor(id, center, DEFAULT_SECTOR_RADIUS, systems, gates), keys);
    const result = verifyDescriptor(signed, NOW);
    expect(result, result.ok ? '' : result.reason).toMatchObject({ ok: true });
    expect(signed.body.systems.find((s) => s.id === pair.a.id)!.tags).toContain('gate');
  });

  it('is rejected when the sector was generated for another server id', () => {
    const keys = generateKeyPair();
    const id = idFromPublicKey(keys.publicKey);
    const other = idFromPublicKey(generateKeyPair().publicKey);
    const systems = generateSector({ serverId: other, seed: 'descriptor', center: [0, 0, 0], radius: DEFAULT_SECTOR_RADIUS, count: 4 });
    const result = verifyDescriptor(signDescriptor(makeDescriptor(id, [0, 0, 0], DEFAULT_SECTOR_RADIUS, systems), keys), NOW);
    expect(result).toEqual({ ok: false, reason: 'system id outside own namespace' });
  });
});
