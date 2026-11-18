/**
 * Persistence on SQLite through the built-in `node:sqlite` module (no native build step).
 * Everything is stored as JSON documents; the schema is deliberately tiny.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Passport, ServerDescriptor, ShipState, Signed, TradeLedger } from '@primacy2/shared';

export interface PlayerRecord {
  id: string;
  /** Public key, hex. */
  key: string;
  passport: Passport;
  /** Credits on this server. */
  credits: number;
  /** `here`: playing or logged out here. `transit`: a ticket was issued. `away`: the ticket was redeemed. */
  status: 'here' | 'transit' | 'away';
  /**
   * Where the ship went. `exported` is the trade units booked as an export when the destination
   * redeemed the ticket, kept so the booking can be taken back if the ship is recalled.
   */
  away?: { server: string; nonce: string; expiresAt: number; since: number; exported?: number };
  /** System the ship is in. */
  system: string;
  /** Last dynamic ship state, or null to spawn at the home station. */
  ship: ShipState | null;
  homeSystem: string | null;
  homeSite: number | null;
  /** Data owned by gameplay modules, keyed by module name. */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface StoredPeer {
  id: string;
  descriptor: Signed<ServerDescriptor>;
  /** True when the two servers completed a mutual hello. */
  linked: boolean;
  lastSeen: number;
}

export class Store {
  private readonly db: DatabaseSync;

  /** `path` is a file path, or `:memory:` for a throwaway database. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (c TEXT NOT NULL, id TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (c, id));
    `);
  }

  getKv<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, JSON.stringify(value));
  }

  loadPlayer(id: string): PlayerRecord | undefined {
    const row = this.db.prepare('SELECT v FROM players WHERE id = ?').get(id) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as PlayerRecord) : undefined;
  }

  savePlayer(rec: PlayerRecord): void {
    rec.updatedAt = Date.now();
    this.db
      .prepare('INSERT INTO players (id, v, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET v = excluded.v, updated = excluded.updated')
      .run(rec.id, JSON.stringify(rec), rec.updatedAt);
  }

  playerCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
  }

  /** Records a ticket nonce. Returns false when it was already present (a replay). */
  claimNonce(nonce: string, expiresAt: number): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, expires) VALUES (?, ?)').run(nonce, expiresAt);
    return Number(res.changes) === 1;
  }

  /** Forgets a claimed nonce again, for a ticket that turned out not to be redeemable. */
  releaseNonce(nonce: string): void {
    this.db.prepare('DELETE FROM nonces WHERE nonce = ?').run(nonce);
  }

  pruneNonces(now: number): void {
    this.db.prepare('DELETE FROM nonces WHERE expires < ?').run(now);
  }

  loadPeers(): StoredPeer[] {
    const rows = this.db.prepare('SELECT v FROM peers').all() as { v: string }[];
    return rows.map((r) => JSON.parse(r.v) as StoredPeer);
  }

  savePeer(peer: StoredPeer): void {
    this.db.prepare('INSERT INTO peers (id, v) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET v = excluded.v').run(peer.id, JSON.stringify(peer));
  }

  deletePeer(id: string): void {
    this.db.prepare('DELETE FROM peers WHERE id = ?').run(id);
  }

  /** This server's trade books for one peer, in trade units. A peer never traded with has an empty row. */
  loadLedger(peer: string): TradeLedger {
    const doc = this.getDoc<Partial<TradeLedger>>('ledger', peer);
    const units = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
    return { exports: units(doc?.exports), imports: units(doc?.imports) };
  }

  saveLedger(peer: string, ledger: TradeLedger): void {
    this.putDoc('ledger', peer, { exports: ledger.exports, imports: ledger.imports });
  }

  getDoc<T>(collection: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT v FROM docs WHERE c = ? AND id = ?').get(collection, id) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  putDoc(collection: string, id: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO docs (c, id, v) VALUES (?, ?, ?) ON CONFLICT(c, id) DO UPDATE SET v = excluded.v')
      .run(collection, id, JSON.stringify(value));
  }

  deleteDoc(collection: string, id: string): void {
    this.db.prepare('DELETE FROM docs WHERE c = ? AND id = ?').run(collection, id);
  }

  listDocs<T>(collection: string): { id: string; value: T }[] {
    const rows = this.db.prepare('SELECT id, v FROM docs WHERE c = ?').all(collection) as { id: string; v: string }[];
    return rows.map((r) => ({ id: r.id, value: JSON.parse(r.v) as T }));
  }

  close(): void {
    this.db.close();
  }
}
