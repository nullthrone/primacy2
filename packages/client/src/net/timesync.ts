/**
 * Clock estimates derived from the network. All local times are seconds on one monotonic clock
 * (`performance.now() / 1000`); nothing here reads a clock itself.
 */

/** Offsets further off than this are adopted at once instead of being smoothed in, seconds. */
const SNAP = 0.5;

/**
 * Universe time as the server sees it, estimated from `welcome` and from ping round trips.
 * `now(local)` is the server's universe time at local time `local`.
 */
export class UniverseClock {
  /** Universe time minus local time, seconds. */
  private offset = 0;
  private samples = 0;
  /** Smoothed round-trip time in milliseconds. */
  ping = 0;
  /** True once `welcome` or a pong has set the offset. */
  synced = false;

  /** Starts from the universe time in `welcome`; the first pong then corrects for the latency. */
  reset(universeTime: number, local: number): void {
    this.offset = universeTime - local;
    this.samples = 0;
    this.ping = 0;
    this.synced = true;
  }

  /** A pong arrived: the ping left at `sent`, came back at `received`, and the server stamped `universeTime`. */
  pong(sent: number, received: number, universeTime: number): void {
    const rtt = Math.max(0, received - sent);
    // The server stamped the pong half a round trip ago, assuming a symmetric path.
    const estimate = universeTime + rtt / 2 - received;
    const diff = estimate - this.offset;
    if (this.samples === 0 || Math.abs(diff) > SNAP) this.offset = estimate;
    else this.offset += diff * (this.samples < 4 ? 0.5 : 0.1);
    this.ping = this.samples === 0 ? rtt * 1000 : this.ping + (rtt * 1000 - this.ping) * 0.25;
    this.samples++;
    this.synced = true;
  }

  now(local: number): number {
    return local + this.offset;
  }
}

/**
 * Tracks how the time stamps of arriving snapshots relate to the local clock, so that other
 * entities can be drawn a fixed delay behind the newest data whatever the latency is.
 * `time(local)` is the snapshot time that "should be arriving" at local time `local`.
 */
export class StreamClock {
  private offset: number | null = null;

  reset(): void {
    this.offset = null;
  }

  /** A snapshot stamped `snapshotTime` arrived at local time `local`. */
  arrived(snapshotTime: number, local: number): void {
    const sample = snapshotTime - local;
    if (this.offset === null || Math.abs(sample - this.offset) > SNAP) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.1;
  }

  /** Null until the first snapshot has arrived. */
  time(local: number): number | null {
    return this.offset === null ? null : local + this.offset;
  }
}
