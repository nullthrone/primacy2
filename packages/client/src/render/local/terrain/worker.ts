/**
 * The terrain worker: runs the shared terrain function off the main thread. It is told the
 * terrain constants of a body once, then bakes tiles and far-map strips of it on request, one
 * job at a time in the order they arrive (the pool on the main thread decides that order and
 * sends no more than one job ahead). The arrays of a result are handed over, not copied.
 */
import type { TerrainParams } from '@primacy2/shared';
import { bakeFarRows, bakeTile, type TileBake, type TileSpec } from './bake.ts';

export type WorkerRequest =
  | { type: 'body'; key: string; params: TerrainParams }
  | { type: 'forget'; key: string }
  | { type: 'tile'; id: number; key: string; spec: TileSpec }
  | { type: 'far'; id: number; key: string; face: number; size: number; row0: number; rows: number };

export type WorkerResult =
  | { type: 'tile'; id: number; ms: number; tile: TileBake }
  | { type: 'far'; id: number; ms: number; data: Uint16Array }
  | { type: 'failed'; id: number; reason: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResult, transfer?: Transferable[]): void;
};

const bodies = new Map<string, TerrainParams>();

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'body') {
    bodies.set(msg.key, msg.params);
    return;
  }
  if (msg.type === 'forget') {
    bodies.delete(msg.key);
    return;
  }
  const params = bodies.get(msg.key);
  if (!params) {
    scope.postMessage({ type: 'failed', id: msg.id, reason: `no terrain for ${msg.key}` });
    return;
  }
  const start = performance.now();
  try {
    if (msg.type === 'tile') {
      const tile = bakeTile(params, msg.spec);
      scope.postMessage(
        { type: 'tile', id: msg.id, ms: performance.now() - start, tile },
        [tile.positions.buffer, tile.coarse.buffer, tile.heights.buffer, tile.map.buffer, tile.frame.buffer, tile.box.buffer],
      );
    } else {
      const data = bakeFarRows(params, msg.face, msg.size, msg.row0, msg.rows);
      scope.postMessage({ type: 'far', id: msg.id, ms: performance.now() - start, data }, [data.buffer]);
    }
  } catch (err) {
    scope.postMessage({ type: 'failed', id: msg.id, reason: String(err) });
  }
};
