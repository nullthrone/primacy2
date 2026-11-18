/**
 * Review of the landing core, shared part: what the generator hands to a universe that exists
 * already. (The comparison with the code before the landing work, system by system, is
 * tests/tools/compare-old-new.mts: it needs that commit extracted next to this tree.)
 */
import { describe, expect, it } from 'vitest';
import { SITE_ID_BASE, generateSector, upsertGateSite, type SystemDef } from '@primacy2/shared';

const SYSTEMS: SystemDef[] = [];
for (let k = 0; k < 12; k++) SYSTEMS.push(...generateSector({ serverId: `gateid${k}abcdefghij`, seed: `gate-${k}`, center: [k, 0, 0], radius: 18, count: 48 }));

describe('ids of sites that are added to a universe after it was generated', () => {
  // A warp gate is added to a system when two servers link up, long after the system was generated,
  // and its anchor id is stored by both servers (the gate project of this one, the `remoteSite` of
  // the other) and in saved ships (a pilot who logged out near a gate is anchored to its id). Before
  // ground bases a new gate got SITE_ID_BASE + the number of sites the system was generated with.
  // The bases are generated after all other sites and before gates, so a system that has one hands
  // that id to the base, and the gate gets the next: in a universe that already has a gate in such a
  // system, the stored id of the gate now names a ground base.
  it.fails('a gate gets the id it would have got before ground bases existed, also in a system with a base', () => {
    let withBases = 0;
    for (const sys of SYSTEMS) {
      if (!sys.sites.some((s) => s.kind === 'base')) continue;
      withBases++;
      const generated = sys.sites.filter((s) => s.kind !== 'base').length;
      const gate = upsertGateSite(sys, { linkId: `link-${sys.id}`, peer: 'peer', remoteSystem: 'x:0', state: 'active', progress: 1, remoteProgress: 1 }, [1, 0, 0]);
      expect(gate.id, `${sys.id} has a base`).toBe(SITE_ID_BASE + generated);
    }
    expect(withBases).toBeGreaterThan(20);
  });

  it('a gate added to a system without a base gets the same id as before', () => {
    let without = 0;
    for (const sys of SYSTEMS) {
      if (sys.sites.some((s) => s.kind === 'base')) continue;
      without++;
      const generated = sys.sites.length;
      const gate = upsertGateSite(sys, { linkId: `link-${sys.id}`, peer: 'peer', remoteSystem: 'x:0', state: 'active', progress: 1, remoteProgress: 1 }, [1, 0, 0]);
      expect(gate.id).toBe(SITE_ID_BASE + generated);
    }
    expect(without).toBeGreaterThan(100);
  });
});
