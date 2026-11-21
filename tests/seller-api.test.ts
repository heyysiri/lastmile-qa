import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SellerStore } from '../apps/seller-demo/lib/store';
import { createApi } from '../apps/seller-demo/lib/api';
import { resolveDatabasePath } from '../apps/seller-demo/lib/config';

let dir: string;
let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seller-')); dbPath = join(dir, 'seller.sqlite'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SellerStore persistence', () => {
  it('seeds fresh and active fixtures with isolated namespaces', () => {
    const store = new SellerStore(dbPath);
    const a = store.createSession('fresh-seller');
    const b = store.createSession('active-seller');
    expect(a.namespaceId).not.toBe(b.namespaceId);
    expect(store.getState(a.namespaceId)).toEqual({ namespaceId: a.namespaceId, store: null, inventory: [{ sku: 'SCARF-001', name: 'Cotton scarf', quantity: 5 }] });
    expect(store.getState(b.namespaceId).store).toEqual({ name: 'Demo Store', status: 'ready' });
    store.saveStoreName(a.namespaceId, 'Siri Crafts');
    store.saveQuantity(a.namespaceId, 'SCARF-001', 12);
    expect(store.getState(b.namespaceId).inventory[0].quantity).toBe(5);
    expect(store.getState(b.namespaceId).store?.name).toBe('Demo Store');
    store.close();
  });
  it('persists across reopening and resolves opaque tokens', () => {
    const s1 = new SellerStore(dbPath);
    const session = s1.createSession('fresh-seller');
    s1.saveStoreName(session.namespaceId, '  Siri Crafts ');
    s1.close();
    const s2 = new SellerStore(dbPath);
    expect(s2.resolveSession(session.token)).toBe(session.namespaceId);
    expect(s2.resolveSession('nope')).toBeNull();
    expect(s2.getState(session.namespaceId).store).toEqual({ name: 'Siri Crafts', status: 'ready' });
    s2.close();
  });
  it('rejects invalid input without changing state', () => {
    const store = new SellerStore(dbPath);
    const { namespaceId } = store.createSession('active-seller');
    for (const bad of ['', '   ', 'x'.repeat(81), 5 as unknown as string]) expect(() => store.saveStoreName(namespaceId, bad)).toThrow();
    for (const bad of [-1, 1.5, NaN, Infinity, '7' as unknown as number, 1_000_001]) expect(() => store.saveQuantity(namespaceId, 'SCARF-001', bad)).toThrow();
    expect(() => store.saveQuantity(namespaceId, 'MISSING', 3)).toThrow();
    expect(store.getState(namespaceId)).toMatchObject({ store: { name: 'Demo Store' }, inventory: [{ quantity: 5 }] });
    store.saveQuantity(namespaceId, 'SCARF-001', 0);
    expect(store.getState(namespaceId).inventory[0].quantity).toBe(0);
    store.close();
  });
});

describe('database path', () => {
  it('resolves relative to repository root, not cwd', () => {
    const root = resolve(__dirname, '..');
    expect(resolveDatabasePath({}, join(root, 'apps/seller-demo'))).toBe(join(root, '.data/seller-demo.sqlite'));
    expect(resolveDatabasePath({ SELLER_DATABASE_PATH: 'x/y.sqlite' }, join(root, 'apps/seller-demo'))).toBe(join(root, 'x/y.sqlite'));
    expect(resolveDatabasePath({ SELLER_DATABASE_PATH: '/abs/z.sqlite' }, root)).toBe('/abs/z.sqlite');
  });
});

const json = (url: string, init: RequestInit & { cookie?: string; token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', `seller_session=${init.cookie}`);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`http://127.0.0.1:3001${url}`, { ...init, headers });
};

describe('HTTP handlers', () => {
  let store: SellerStore;
  const enabled = { ENABLE_TEST_API: 'true', TEST_API_TOKEN: 'secret-test', SELLER_BUILD_ID: 'b1' };
  beforeEach(() => { store = new SellerStore(dbPath); });
  afterEach(() => store.close());

  it('keeps test APIs off unless enabled', async () => {
    const api = createApi({ store, env: { TEST_API_TOKEN: 'secret-test' } });
    expect((await api.testSessions(json('/api/test/sessions', { method: 'POST', token: 'secret-test', body: '{"fixtureId":"fresh-seller"}' }))).status).toBe(404);
    expect((await api.testBuild(json('/api/test/build', { token: 'secret-test' }))).status).toBe(404);
    expect((await api.testState(json('/api/test/state?namespaceId=x', { token: 'secret-test' }))).status).toBe(404);
  });
  it('requires the test token and validates fixtures', async () => {
    const api = createApi({ store, env: enabled });
    const post = (token: string | undefined, body: string) => api.testSessions(json('/api/test/sessions', { method: 'POST', token, body }));
    expect((await post(undefined, '{"fixtureId":"fresh-seller"}')).status).toBe(401);
    expect((await post('wrong', '{"fixtureId":"fresh-seller"}')).status).toBe(401);
    expect((await post('secret-test', '{"fixtureId":"other"}')).status).toBe(400);
    expect((await post('secret-test', 'not json')).status).toBe(400);
    expect((await api.testState(json('/api/test/state?namespaceId=x'))).status).toBe(401);
    expect((await api.testState(json('/api/test/state?namespaceId=missing', { token: 'secret-test' }))).status).toBe(404);
    const build = await api.testBuild(json('/api/test/build', { token: 'secret-test' }));
    expect(await build.json()).toEqual({ buildId: 'b1' });
  });
  it('rejects malformed credentials without crashing the handler', async () => {
    const api = createApi({ store, env: enabled });
    const unicode = await api.testBuild(json('/api/test/build', { token: 'é'.repeat(11) }));
    expect(unicode.status).toBe(401);
    const malformed = await api.getStore(json('/api/store', { cookie: '%' }));
    expect(malformed.status).toBe(401);
  });
  it('round-trips a seeded session through business endpoints and reports real state', async () => {
    const api = createApi({ store, env: enabled });
    const created = await (await api.testSessions(json('/api/test/sessions', { method: 'POST', token: 'secret-test', body: '{"fixtureId":"fresh-seller"}' }))).json();
    expect(created.cookie).toMatchObject({ name: 'seller_session', path: '/' });
    const cookie = created.cookie.value;
    const saved = await api.putStore(json('/api/store', { method: 'PUT', cookie, body: '{"name":"Siri Crafts"}' }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ store: { name: 'Siri Crafts', status: 'ready' } });
    const inv = await api.putInventory(json('/api/inventory', { method: 'PUT', cookie, body: '{"sku":"SCARF-001","quantity":12}' }));
    expect((await inv.json()).inventory[0].quantity).toBe(12);
    const state = await (await api.testState(json(`/api/test/state?namespaceId=${created.namespaceId}`, { token: 'secret-test' }))).json();
    expect(state).toEqual({ namespaceId: created.namespaceId, store: { name: 'Siri Crafts', status: 'ready' }, inventory: [{ sku: 'SCARF-001', name: 'Cotton scarf', quantity: 12 }] });
  });
  it('rejects missing session and invalid payloads with {code,message}', async () => {
    const api = createApi({ store, env: {} });
    const none = await api.putStore(json('/api/store', { method: 'PUT', body: '{"name":"A"}' }));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'unauthorized' });
    expect((await api.putStore(json('/api/store', { method: 'PUT', cookie: 'bogus', body: '{"name":"A"}' }))).status).toBe(401);
    const start = await api.startSession(json('/api/session', { method: 'POST', body: '{}' }));
    const cookie = /seller_session=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')![1];
    for (const body of ['{"name":""}', '{"name":7}', '{}', 'x']) expect((await api.putStore(json('/api/store', { method: 'PUT', cookie, body }))).status).toBe(400);
    for (const body of ['{"sku":"SCARF-001","quantity":-1}', '{"sku":"SCARF-001","quantity":1.5}', '{"sku":"SCARF-001","quantity":"3"}', '{"quantity":3}', '{"namespaceId":"x","sku":"SCARF-001","quantity":"a"}']) expect((await api.putInventory(json('/api/inventory', { method: 'PUT', cookie, body }))).status).toBe(400);
    expect((await (await api.getStore(json('/api/store', { cookie }))).json()).store).toBeNull();
  });
  it('ignores any namespace supplied by the client and isolates sessions', async () => {
    const api = createApi({ store, env: {} });
    const mk = async () => {
      const r = await api.startSession(json('/api/session', { method: 'POST', body: '{"fixtureId":"active-seller"}' }));
      expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);
      return /seller_session=([^;]+)/.exec(r.headers.get('set-cookie')!)![1];
    };
    const a = await mk(); const b = await mk();
    await api.putInventory(json('/api/inventory', { method: 'PUT', cookie: a, body: '{"sku":"SCARF-001","quantity":9,"namespaceId":"whatever"}' }));
    const qty = async (c: string) => (await (await api.getInventory(json('/api/inventory', { cookie: c }))).json()).inventory[0].quantity;
    expect(await qty(a)).toBe(9);
    expect(await qty(b)).toBe(5);
  });
  it('does not expose a test-privileged session start publicly', async () => {
    const api = createApi({ store, env: {} });
    expect((await api.startSession(json('/api/session', { method: 'POST', body: '{"fixtureId":"bad"}' }))).status).toBe(400);
  });
});
