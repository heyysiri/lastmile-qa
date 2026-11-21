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

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

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
    `);
  }
  close() { this.db.close(); }

  createSession(fixtureId: FixtureId): { namespaceId: string; token: string } {
    if (!FIXTURES.includes(fixtureId)) throw new ValidationError('Unknown fixtureId');
    const namespaceId = randomUUID();
    const token = randomBytes(24).toString('base64url');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO namespaces (id, created_at) VALUES (?, ?)').run(namespaceId, new Date().toISOString());
      this.db.prepare('INSERT INTO sessions (token_hash, namespace_id) VALUES (?, ?)').run(hash(token), namespaceId);
      if (fixtureId === 'active-seller') this.db.prepare('INSERT INTO stores VALUES (?, ?, ?)').run(namespaceId, 'Demo Store', 'ready');
      this.db.prepare('INSERT INTO inventory VALUES (?, ?, ?, ?, ?)').run(namespaceId, 'SCARF-001', 'Cotton scarf', 5, 0);
    })();
    return { namespaceId, token };
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

  saveStoreName(namespaceId: string, name: unknown): { name: string; status: string } {
    if (typeof name !== 'string') throw new ValidationError('Store name must be text');
    const trimmed = name.trim();
    if (!trimmed) throw new ValidationError('Enter a store name');
    if (trimmed.length > MAX_STORE_NAME) throw new ValidationError(`Store name must be ${MAX_STORE_NAME} characters or fewer`);
    this.db.prepare(`INSERT INTO stores VALUES (?, ?, 'ready') ON CONFLICT(namespace_id) DO UPDATE SET name = excluded.name, status = 'ready'`).run(namespaceId, trimmed);
    return this.getState(namespaceId).store!;
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
