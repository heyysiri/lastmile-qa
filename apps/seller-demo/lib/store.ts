import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type FixtureId = 'fresh-seller' | 'active-seller';
export const FIXTURES: readonly FixtureId[] = ['fresh-seller', 'active-seller'];
export const MAX_STORE_NAME = 80;
export const MAX_QUANTITY = 1_000_000;

export interface SellerState {
  namespaceId: string;
  store: null | { name: string; status: string };
  inventory: Array<{ sku: string; name: string; quantity: number }>;
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class CorruptCheckpointError extends Error {}

type SellerSession = { namespaceId: string; token: string };
type SellerCheckpoint = { id: string; digest: string; state: SellerState };
type CheckpointRow = { id: string; namespace_id: string; digest: string; state_json: string };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function readCheckpoint(row: CheckpointRow): SellerCheckpoint {
  if (hash(row.state_json) !== row.digest) throw new CorruptCheckpointError('Checkpoint digest mismatch');
  return { id: row.id, digest: row.digest, state: JSON.parse(row.state_json) as SellerState };
}

export class SellerStore {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS namespaces (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, namespace_id TEXT NOT NULL REFERENCES namespaces(id));
      CREATE TABLE IF NOT EXISTS stores (namespace_id TEXT PRIMARY KEY REFERENCES namespaces(id), name TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory (
        namespace_id TEXT NOT NULL REFERENCES namespaces(id), sku TEXT NOT NULL, name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity >= 0), position INTEGER NOT NULL, PRIMARY KEY (namespace_id, sku));
      CREATE TABLE IF NOT EXISTS accounts (
        account_key TEXT PRIMARY KEY, fixture_id TEXT NOT NULL,
        namespace_id TEXT NOT NULL UNIQUE REFERENCES namespaces(id));
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, namespace_id TEXT NOT NULL REFERENCES namespaces(id),
        digest TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_clones (
        clone_key TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        namespace_id TEXT NOT NULL UNIQUE REFERENCES namespaces(id));
    `);
  }
  close() { this.db.close(); }

  private createNamespace(): string {
    const namespaceId = randomUUID();
    this.db.prepare('INSERT INTO namespaces (id, created_at) VALUES (?, ?)').run(namespaceId, new Date().toISOString());
    return namespaceId;
  }

  private issueSession(namespaceId: string): SellerSession {
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, namespace_id) VALUES (?, ?)').run(hash(token), namespaceId);
    return { namespaceId, token };
  }

  createSession(fixtureId: FixtureId): SellerSession {
    if (!FIXTURES.includes(fixtureId)) throw new ValidationError('Unknown fixtureId');
    return this.db.transaction(() => {
      const namespaceId = this.createNamespace();
      if (fixtureId === 'active-seller') this.db.prepare('INSERT INTO stores VALUES (?, ?, ?)').run(namespaceId, 'Demo Store', 'ready');
      this.db.prepare('INSERT INTO inventory VALUES (?, ?, ?, ?, ?)').run(namespaceId, 'SCARF-001', 'Cotton scarf', 5, 0);
      return this.issueSession(namespaceId);
    })();
  }

  openAccount(accountKey: string, fixtureId: FixtureId): SellerSession {
    return this.db.transaction(() => {
      const existing = this.db.prepare<[string], { namespace_id: string; fixture_id: string }>(
        'SELECT namespace_id, fixture_id FROM accounts WHERE account_key = ?',
      ).get(accountKey);
      if (existing) {
        if (existing.fixture_id !== fixtureId) throw new ConflictError('Account key is already assigned to another fixture');
        return this.issueSession(existing.namespace_id);
      }
      const session = this.createSession(fixtureId);
      this.db.prepare('INSERT INTO accounts (account_key, fixture_id, namespace_id) VALUES (?, ?, ?)')
        .run(accountKey, fixtureId, session.namespaceId);
      return session;
    }).immediate();
  }

  captureCheckpoint(namespaceId: string, requestId: string): SellerCheckpoint {
    return this.db.transaction(() => {
      const existing = this.db.prepare<[string], CheckpointRow>('SELECT * FROM checkpoints WHERE request_id = ?').get(requestId);
      if (existing) {
        if (existing.namespace_id !== namespaceId) throw new ConflictError('Request ID is already assigned to another namespace');
        return readCheckpoint(existing);
      }
      const state = this.getState(namespaceId);
      const id = randomUUID();
      const stateJson = JSON.stringify(state);
      const digest = hash(stateJson);
      this.db.prepare('INSERT INTO checkpoints (id, request_id, namespace_id, digest, state_json) VALUES (?, ?, ?, ?, ?)')
        .run(id, requestId, namespaceId, digest, stateJson);
      return { id, digest, state };
    }).immediate();
  }

  cloneCheckpoint(id: string, cloneKey: string): SellerSession & { digest: string } {
    return this.db.transaction(() => {
      const existing = this.db.prepare<[string], { namespace_id: string; checkpoint_id: string }>(
        'SELECT namespace_id, checkpoint_id FROM checkpoint_clones WHERE clone_key = ?',
      ).get(cloneKey);
      if (existing && existing.checkpoint_id !== id) throw new ConflictError('Clone key is already assigned to another checkpoint');
      const row = this.db.prepare<[string], CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?').get(id);
      if (!row) throw new NotFoundError('Unknown checkpoint');
      const { state, digest } = readCheckpoint(row);
      if (existing) return { ...this.issueSession(existing.namespace_id), digest };

      const namespaceId = this.createNamespace();
      if (state.store) {
        this.db.prepare('INSERT INTO stores VALUES (?, ?, ?)').run(namespaceId, state.store.name, state.store.status);
      }
      const insertItem = this.db.prepare('INSERT INTO inventory VALUES (?, ?, ?, ?, ?)');
      state.inventory.forEach((item, position) => insertItem.run(namespaceId, item.sku, item.name, item.quantity, position));
      this.db.prepare('INSERT INTO checkpoint_clones (clone_key, checkpoint_id, namespace_id) VALUES (?, ?, ?)')
        .run(cloneKey, id, namespaceId);
      return { ...this.issueSession(namespaceId), digest };
    }).immediate();
  }

  resolveSession(token: string): string | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT namespace_id FROM sessions WHERE token_hash = ?').get(hash(token)) as { namespace_id: string } | undefined;
    return row?.namespace_id ?? null;
  }

  hasNamespace(namespaceId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM namespaces WHERE id = ?').get(namespaceId);
  }

  getState(namespaceId: string): SellerState {
    if (!this.hasNamespace(namespaceId)) throw new NotFoundError('Unknown namespace');
    const store = this.db.prepare('SELECT name, status FROM stores WHERE namespace_id = ?').get(namespaceId) as { name: string; status: string } | undefined;
    const inventory = this.db.prepare('SELECT sku, name, quantity FROM inventory WHERE namespace_id = ? ORDER BY position').all(namespaceId) as SellerState['inventory'];
    return { namespaceId, store: store ?? null, inventory };
  }

  saveStoreName(namespaceId: string, name: unknown, resetStock = false): { name: string; status: string } {
    if (typeof name !== 'string') throw new ValidationError('Store name must be text');
    const trimmed = name.trim();
    if (!trimmed) throw new ValidationError('Enter a store name');
    if (trimmed.length > MAX_STORE_NAME) throw new ValidationError(`Store name must be ${MAX_STORE_NAME} characters or fewer`);
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO stores VALUES (?, ?, 'ready') ON CONFLICT(namespace_id) DO UPDATE SET name = excluded.name, status = 'ready'`).run(namespaceId, trimmed);
      if (resetStock) this.db.prepare('UPDATE inventory SET quantity = 5 WHERE namespace_id = ?').run(namespaceId);
      return this.getState(namespaceId).store!;
    })();
  }

  saveQuantity(namespaceId: string, sku: unknown, quantity: unknown): SellerState['inventory'] {
    if (typeof sku !== 'string' || !sku) throw new ValidationError('Choose a product');
    if (typeof quantity !== 'number' || !Number.isInteger(quantity)) throw new ValidationError('Stock must be a whole number');
    if (quantity < 0) throw new ValidationError('Stock cannot be negative');
    if (quantity > MAX_QUANTITY) throw new ValidationError(`Stock cannot exceed ${MAX_QUANTITY}`);
    const res = this.db.prepare('UPDATE inventory SET quantity = ? WHERE namespace_id = ? AND sku = ?').run(quantity, namespaceId, sku);
    if (!res.changes) throw new ValidationError('Unknown product');
    return this.getState(namespaceId).inventory;
  }
}
