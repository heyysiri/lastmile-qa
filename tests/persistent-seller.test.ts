import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../apps/seller-demo/lib/api';
import { SellerStore } from '../apps/seller-demo/lib/store';

const enabled = { ENABLE_TEST_API: 'true', TEST_API_TOKEN: 'test-secret', SELLER_BUILD_ID: 'same-source' };
const defect = { ...enabled, SELLER_DEMO_DEFECT: 'reset-stock-on-store-save' };
const defaultSku = { sku: 'SCARF-001', name: 'Cotton scarf', quantity: 5 };

function request(path: string, options: {
  method?: string; body?: object; cookie?: string; token?: string;
} = {}) {
  const headers = new Headers();
  if (options.cookie) headers.set('cookie', `seller_session=${options.cookie}`);
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body) headers.set('content-type', 'application/json');
  return new Request(`http://localhost${path}`, {
    method: options.method,
    body: options.body && JSON.stringify(options.body),
    headers,
  });
}

const testPost = (path: string, body: object, token = enabled.TEST_API_TOKEN) =>
  request(path, { method: 'POST', body, token });

const accountPath = '/api/test/accounts/session';
const checkpointPath = '/api/test/checkpoints';

describe('persistent seller adapter', () => {
  let dir: string;
  let dbPath: string;
  let store: SellerStore;
  let api: ReturnType<typeof createApi>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persistent-seller-'));
    dbPath = join(dir, 'seller.sqlite');
    store = new SellerStore(dbPath);
    api = createApi({ store, env: enabled });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function restart(env = enabled) {
    store.close();
    store = new SellerStore(dbPath);
    api = createApi({ store, env });
  }

  const account = (accountKey: string, fixtureId = 'active-seller') =>
    api.testAccountSession(testPost(accountPath, { accountKey, fixtureId }));

  const checkpoint = (namespaceId: string, requestId: string) =>
    api.testCheckpoint(testPost(checkpointPath, { namespaceId, requestId }));

  const clone = (id: string, cloneKey: string) =>
    api.testCheckpointClone(testPost(`${checkpointPath}/${id}/clone`, { cloneKey }), id);

  async function openAccount(key: string, fixtureId?: string) {
    const res = await account(key, fixtureId);
    expect(res.ok).toBe(true);
    const session = await res.json();
    expect(session.cookie).toMatchObject({ name: 'seller_session', path: '/', value: expect.any(String) });
    return session;
  }

  async function saveStock(cookie: string, quantity: number) {
    const res = await api.putInventory(request('/api/inventory', {
      method: 'PUT', cookie, body: { sku: defaultSku.sku, quantity },
    }));
    expect(res.status).toBe(200);
  }

  async function saveProfile(cookie: string, name: string) {
    const res = await api.putStore(request('/api/store', { method: 'PUT', cookie, body: { name } }));
    expect(res.status).toBe(200);
  }

  async function state(namespaceId: string) {
    const res = await api.testState(request(`/api/test/state?namespaceId=${namespaceId}`, { token: enabled.TEST_API_TOKEN }));
    expect(res.status).toBe(200);
    return res.json();
  }

  it('reopens the same account with its saved state across restart and keeps accounts isolated', async () => {
    const returning = await openAccount('population:tester-1');
    await saveStock(returning.cookie.value, 250);
    await saveProfile(returning.cookie.value, 'Siri Crafts');
    const reopened = await openAccount('population:tester-1');
    expect(reopened.namespaceId).toBe(returning.namespaceId);
    restart();
    const restored = await openAccount('population:tester-1');
    expect(restored.namespaceId).toBe(returning.namespaceId);
    const other = await openAccount('population:tester-2');
    expect(other.namespaceId).not.toBe(returning.namespaceId);
    expect(await state(other.namespaceId)).toEqual({
      namespaceId: other.namespaceId, store: { name: 'Demo Store', status: 'ready' }, inventory: [defaultSku],
    });
    const inventory = await api.getInventory(request('/api/inventory', { cookie: restored.cookie.value }));
    expect(await inventory.json()).toEqual({ inventory: [{ ...defaultSku, quantity: 250 }] });
    expect(await state(restored.namespaceId)).toEqual({
      namespaceId: returning.namespaceId,
      store: { name: 'Siri Crafts', status: 'ready' },
      inventory: [{ ...defaultSku, quantity: 250 }],
    });
    expect((await account('population:tester-1', 'fresh-seller')).status).toBe(409);
    expect((await state(restored.namespaceId)).inventory[0].quantity).toBe(250);
  });

  it('captures immutable checkpoints and reopens isolated clones across restart', async () => {
    const original = await openAccount('population:original');
    await saveStock(original.cookie.value, 250);
    const captured = await checkpoint(original.namespaceId, 'start-journey');
    expect(captured.ok).toBe(true);
    const before = await captured.json();
    expect(before.state).toEqual({
      namespaceId: original.namespaceId,
      store: { name: 'Demo Store', status: 'ready' },
      inventory: [{ ...defaultSku, quantity: 250 }],
    });
    expect(before.digest).toBe(createHash('sha256').update(JSON.stringify(before.state)).digest('hex'));
    await saveStock(original.cookie.value, 400);
    await saveProfile(original.cookie.value, 'After capture');

    const restored = await clone(before.id, 'candidate-a');
    expect(restored.ok).toBe(true);
    const branch = await restored.json();
    expect(branch.namespaceId).not.toBe(original.namespaceId);
    expect(branch.cookie).toMatchObject({ name: 'seller_session', path: '/' });
    expect(branch.digest).toBe(before.digest);
    expect(await state(branch.namespaceId)).toEqual({ ...before.state, namespaceId: branch.namespaceId });
    await saveStock(branch.cookie.value, 12);

    restart();
    expect(await (await checkpoint(original.namespaceId, 'start-journey')).json()).toEqual(before);
    expect((await checkpoint(branch.namespaceId, 'start-journey')).status).toBe(409);
    const reopened = await (await clone(before.id, 'candidate-a')).json();
    expect(reopened.namespaceId).toBe(branch.namespaceId);
    expect(reopened.digest).toBe(before.digest);
    const inventory = await api.getInventory(request('/api/inventory', { cookie: reopened.cookie.value }));
    expect(await inventory.json()).toEqual({ inventory: [{ ...defaultSku, quantity: 12 }] });
    expect(await state(original.namespaceId)).toMatchObject({
      store: { name: 'After capture' }, inventory: [{ quantity: 400 }],
    });

    const newCapture = await (await checkpoint(original.namespaceId, 'next-journey')).json();
    expect(newCapture.digest).not.toBe(before.digest);
    expect((await clone(newCapture.id, 'candidate-a')).status).toBe(409);
    const freshClone = await (await clone(before.id, 'candidate-b')).json();
    expect(freshClone.namespaceId).not.toBe(branch.namespaceId);
    expect(await state(freshClone.namespaceId)).toEqual({ ...before.state, namespaceId: freshClone.namespaceId });
  });

  it('rejects unknown namespaces, unknown checkpoints, and corrupted snapshots', async () => {
    expect((await checkpoint('missing', 'start-journey')).status).toBe(404);
    expect((await clone('missing', 'candidate')).status).toBe(404);
    const original = await openAccount('population:original', 'fresh-seller');
    const before = await (await checkpoint(original.namespaceId, 'start-journey')).json();
    const restored = await (await clone(before.id, 'candidate')).json();
    expect(await state(restored.namespaceId)).toEqual({ namespaceId: restored.namespaceId, store: null, inventory: [defaultSku] });

    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE checkpoints SET state_json = ? WHERE id = ?').run('{}', before.id);
    } finally {
      db.close();
    }
    expect((await checkpoint(original.namespaceId, 'start-journey')).status).toBe(500);
    expect((await clone(before.id, 'candidate')).status).toBe(500);
    expect((await clone(before.id, 'different-candidate')).status).toBe(500);
  });

  it.each([
    [{ TEST_API_TOKEN: enabled.TEST_API_TOKEN }, enabled.TEST_API_TOKEN, 404],
    [enabled, '', 401],
    [enabled, 'incorrect', 401],
  ])('gates all persistent test endpoints (%#)', async (env, token, status) => {
    api = createApi({ store, env });
    expect((await api.testAccountSession(testPost(accountPath, {}, token))).status).toBe(status);
    expect((await api.testCheckpoint(testPost(checkpointPath, {}, token))).status).toBe(status);
    expect((await api.testCheckpointClone(testPost(checkpointPath + '/id/clone', {}, token), 'id')).status).toBe(status);
  });

  it('requires bounded identifiers and a recognized fixture', async () => {
    for (const key of ['', '  ', 'x'.repeat(201), 7]) {
      expect((await api.testAccountSession(testPost(accountPath, { accountKey: key, fixtureId: 'fresh-seller' }))).status).toBe(400);
      expect((await api.testCheckpoint(testPost(checkpointPath, { namespaceId: 'missing', requestId: key }))).status).toBe(400);
      expect((await api.testCheckpointClone(testPost(checkpointPath + '/id/clone', { cloneKey: key }), 'id')).status).toBe(400);
    }
    expect((await account('population:tester', 'missing')).status).toBe(400);
    expect((await checkpoint('', 'request')).status).toBe(400);
  });

  it('identifies the seeded build and resets only the edited namespace, leaving default stock at 5', async () => {
    const freshSession = async () => {
      const res = await api.testSessions(testPost('/api/test/sessions', { fixtureId: 'active-seller' }));
      expect(res.status).toBe(201);
      return res.json();
    };
    const returning = await freshSession();
    const defaultAccount = await freshSession();
    const other = await freshSession();
    await saveStock(returning.cookie.value, 250);
    await saveStock(other.cookie.value, 75);
    await saveProfile(returning.cookie.value, 'Updated on healthy build');
    expect((await state(returning.namespaceId)).inventory[0].quantity).toBe(250);
    const build = () => api.testBuild(request('/api/test/build', { token: enabled.TEST_API_TOKEN }));
    const healthyBuild = await (await build()).json();

    restart(defect);
    const defectBuild = await (await build()).json();
    await saveProfile(returning.cookie.value, 'Updated on candidate build');
    await saveProfile(defaultAccount.cookie.value, 'Default inventory');
    expect((await state(returning.namespaceId)).inventory[0].quantity).toBe(5);
    expect((await state(defaultAccount.namespaceId)).inventory[0].quantity).toBe(5);
    expect((await state(other.namespaceId)).inventory[0].quantity).toBe(75);
    expect(defectBuild.buildId).not.toBe(healthyBuild.buildId);
  });
});
