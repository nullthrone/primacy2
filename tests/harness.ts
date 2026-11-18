/**
 * Test harness: real servers on ephemeral ports with a shared, manually advanced clock, so
 * minutes of simulated flight run in well under a second of wall time.
 */
import { DT, UNIVERSE_EPOCH_MS, publicKeyOf, sha256Hex, type KeyPair } from '@primacy2/shared';
import { startServer, type PrimacyServer, type ServerConfig } from '@primacy2/server';
import type { Bot } from './bot.ts';

/** A fixed identity derived from a label, so a test server has the same id and sector on every run. */
export function testKeys(label: string): KeyPair {
  const secretKey = sha256Hex('primacy2-test:' + label);
  return { secretKey, publicKey: publicKeyOf(secretKey) };
}

export class Cluster {
  /** Shared wall clock in milliseconds. */
  nowMs = UNIVERSE_EPOCH_MS + 400 * 86_400_000;
  readonly servers: PrimacyServer[] = [];
  readonly bots = new Set<Bot>();
  readonly logs: string[] = [];

  async start(over: Partial<ServerConfig>): Promise<PrimacyServer> {
    const server = await startServer(
      // No base licence in the tests: they count the licence exactly. The base has its own test in trade.test.ts.
      { host: '127.0.0.1', port: 0, dataDir: ':memory:', systems: 8, bootstrapWaitMs: 2_000, importLicenceBase: 0, ...over },
      {
        now: () => this.nowMs, autoTick: false, keys: testKeys(over.name ?? `server-${this.servers.length}`),
        log: (m) => this.logs.push(`${over.name ?? '?'}: ${m}`),
      },
    );
    this.servers.push(server);
    return server;
  }

  /** Lets pending socket and HTTP work run. */
  async io(turns = 3): Promise<void> {
    for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /** Advances every server by `ticks` simulation ticks; bots send their held input each tick. */
  async run(ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      this.nowMs += DT * 1000;
      for (const b of this.bots) if (!b.closed) b.sendInput();
      await this.io(2);
      for (const s of this.servers) s.tick();
      await this.io(2);
    }
  }

  /** Runs until `pred` holds. Throws with `what` after `maxTicks`. */
  async until(pred: () => boolean, what: string, maxTicks = 3000): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (pred()) return;
      await this.run(1);
    }
    if (!pred()) throw new Error(`timed out waiting for: ${what}`);
  }

  /** Waits (in real time) for something that depends on network round trips rather than ticks. */
  async settle(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  track(bot: Bot): Bot {
    this.bots.add(bot);
    return bot;
  }

  async stop(): Promise<void> {
    for (const b of this.bots) b.close();
    await Promise.all(this.servers.map((s) => s.stop()));
  }
}
