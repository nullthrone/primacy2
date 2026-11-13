/**
 * A small pool of terrain workers and the queue in front of it. Jobs wait on the main thread in
 * order of priority and are handed out one per idle worker, so a job that is no longer wanted can
 * be dropped, and re-ranked, until the moment it starts. The ground tiles and the far maps of
 * all bodies share this one pool.
 */
import type { TerrainParams } from '@primacy2/shared';
import type { TileBake, TileSpec } from './bake.ts';
import type { WorkerRequest, WorkerResult } from './worker.ts';

/** A queued or running job. Lower `priority` runs first; it may be changed while the job waits. */
export interface Job {
  priority: number;
  /** Drops the job: it is not started, or its result is thrown away. */
  cancel(): void;
}

interface Pending extends Job {
  id: number;
  key: string;
  request: WorkerRequest;
  done: (result: WorkerResult | null) => void;
  cancelled: boolean;
}

interface Slot {
  worker: Worker;
  /** The job the worker is busy with. */
  job: Pending | null;
  /** Bodies whose terrain constants this worker has been sent. */
  known: Set<string>;
  dead: boolean;
}

export class TerrainPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly bodies = new Map<string, TerrainParams>();
  private nextId = 1;
  /** Jobs finished and worker milliseconds spent on them, for the statistics. */
  finished = 0;
  workerMs = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      try {
        const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        const slot: Slot = { worker, job: null, known: new Set(), dead: false };
        worker.onmessage = (e: MessageEvent<WorkerResult>) => this.finish(slot, e.data);
        worker.onerror = (e) => {
          // A worker that cannot start or throws outside a job is taken out; its job is given up.
          e.preventDefault();
          console.warn('terrain: a worker failed', e.message);
          slot.dead = true;
          const job = slot.job;
          slot.job = null;
          if (job && !job.cancelled) job.done(null);
          this.pump();
        };
        this.slots.push(slot);
      } catch (err) {
        console.warn('terrain: no worker', err);
      }
    }
  }

  /** False when no worker could be started or all have failed: nothing will ever be baked. */
  get available(): boolean {
    return this.slots.some((s) => !s.dead);
  }

  /** Jobs waiting and running. */
  get pending(): number {
    let n = this.queue.length;
    for (const s of this.slots) if (s.job) n++;
    return n;
  }

  /** Makes the terrain of a body known under `key`. Workers are sent it with their first job for it. */
  body(key: string, params: TerrainParams): void {
    if (!this.bodies.has(key)) this.bodies.set(key, params);
  }

  /** Forgets a body: its waiting jobs are dropped and the workers free its constants. */
  forget(key: string): void {
    if (!this.bodies.delete(key)) return;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.key === key) this.queue.splice(i, 1)[0]!.cancelled = true;
    }
    for (const s of this.slots) {
      if (s.dead || !s.known.delete(key)) continue;
      s.worker.postMessage({ type: 'forget', key } satisfies WorkerRequest);
    }
  }

  tile(key: string, spec: TileSpec, priority: number, done: (tile: TileBake | null) => void): Job {
    return this.submit(key, { type: 'tile', id: 0, key, spec }, priority, (r) => done(r && r.type === 'tile' ? r.tile : null));
  }

  far(key: string, face: number, size: number, row0: number, rows: number, priority: number, done: (data: Uint16Array | null) => void): Job {
    return this.submit(key, { type: 'far', id: 0, key, face, size, row0, rows }, priority, (r) => done(r && r.type === 'far' ? r.data : null));
  }

  private submit(key: string, request: WorkerRequest & { id: number }, priority: number, done: (r: WorkerResult | null) => void): Job {
    const queue = this.queue;
    const job: Pending = {
      id: this.nextId++, key, request, priority, done, cancelled: false,
      cancel() {
        if (job.cancelled) return;
        job.cancelled = true;
        const at = queue.indexOf(job);
        if (at >= 0) queue.splice(at, 1);
      },
    };
    request.id = job.id;
    this.queue.push(job);
    this.pump();
    return job;
  }

  /** Gives every idle worker the most urgent waiting job. */
  private pump(): void {
    for (const slot of this.slots) {
      if (slot.dead || slot.job || this.queue.length === 0) continue;
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i]!.priority < this.queue[best]!.priority) best = i;
      const job = this.queue.splice(best, 1)[0]!;
      const params = this.bodies.get(job.key);
      if (!params) {
        job.done(null);
        continue;
      }
      if (!slot.known.has(job.key)) {
        slot.known.add(job.key);
        slot.worker.postMessage({ type: 'body', key: job.key, params } satisfies WorkerRequest);
      }
      slot.job = job;
      slot.worker.postMessage(job.request);
    }
    if (!this.available) {
      // Nobody is left to do the work: everything waiting is given up.
      for (const job of this.queue.splice(0)) job.done(null);
    }
  }

  private finish(slot: Slot, result: WorkerResult): void {
    const job = slot.job;
    slot.job = null;
    if (job && job.id === result.id) {
      this.finished++;
      if (result.type !== 'failed') this.workerMs += result.ms;
      else console.warn('terrain: a bake failed', result.reason);
      if (!job.cancelled) job.done(result.type === 'failed' ? null : result);
    }
    this.pump();
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    this.slots.length = 0;
    this.queue.length = 0;
    this.bodies.clear();
  }
}

let shared: TerrainPool | null = null;

/** The pool every user of baked terrain shares; workers start with the first call. */
export function terrainPool(): TerrainPool {
  if (!shared) {
    // Half the cores, at most four: the main thread, the GPU process and the page's other work
    // need the rest, and a descent rarely has more than a few tiles waiting.
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    shared = new TerrainPool(Math.min(4, Math.max(1, Math.floor(cores / 2))));
  }
  return shared;
}
