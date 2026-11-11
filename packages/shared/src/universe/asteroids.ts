import type { AsteroidDef, SiteDef, SystemDef } from './types.ts';

/**
 * The asteroids of a `belt`, `ring` or `anomaly` mining site, deterministic from the site seed, positioned
 * relative to the site anchor. Server and client call this with the same arguments and get the
 * same field, so only depletion state needs to cross the network. Returns [] for other site kinds.
 */
export function generateAsteroids(sys: SystemDef, site: SiteDef): AsteroidDef[] {
  throw new Error('generateAsteroids is not implemented');
}
