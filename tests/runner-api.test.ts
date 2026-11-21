import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ContextPack, RunRecord, ScenarioDefinition } from '../packages/contracts/src/index';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import { createServer, type ServerOptions } from '../apps/runner/src/server';
import { openRunStore } from '../apps/runner/src/store';

const token = 'runner-test-secret';
const headers = { authorization: `Bearer ${token}` };
const request = {
  requestId: 'request-one', scenarioId: 'store-setup', scenarioRevision: 1,
  contextPackId: 'desktop-seller', contextRevision: 1,
};
let folder: string;
let app: ReturnType<typeof createServer> | undefined;
let closed: boolean;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lastmile-api-'));
  closed = false;
});

afterEach(async () => {
  if (!closed) await app?.close();
  app = undefined;
  rmSync(folder, { recursive: true, force: true });
});

function setup(options: Partial<ServerOptions> = {}) {
  app = createServer({
    databasePath: join(folder, 'qa.sqlite'), artifactRoot: join(folder, 'artifacts'),
    apiToken: token, modelConfigured: false, ...options,
  });
  return app;
}

it('requires bearer authentication except on health and checks mutation origins', async () => {
  const app = setup();
  expect((await app.inject('/api/health')).json()).toEqual({
    status: 'ok', modelConfigured: false, executionReady: false,
  });
  expect((await app.inject('/api/scenarios')).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/capabilities', headers })).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ factor: 'viewport', mode: 'enforced' })]),
  );
  const submission = { method: 'POST', url: '/api/runs', payload: request } as const;
  expect((await app.inject({ ...submission, headers: { ...headers, origin: 'https://example.org' } })).statusCode).toBe(401);
  expect((await app.inject({ ...submission, headers: { ...headers, origin: 'http://localhost:3000' } })).statusCode).toBe(202);
});

it('rejects invalid requests, unsupported factors, and incompatible inputs', async () => {
  const app = setup();
  const invalid = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { ...request, targetUrl: 'https://example.org' } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  const scenario = { ...storeScenario, id: 'other-flow', investigation: { factors: ['cpu'], maxAttempts: 4 } };
  expect((await app.inject({ method: 'POST', url: '/api/scenarios', headers, payload: scenario })).statusCode).toBe(400);
  const context = { ...desktopContext, id: 'wrong-input', inputs: { storeName: 123 } };
  expect((await app.inject({ method: 'POST', url: '/api/context-packs', headers, payload: context })).statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { ...request, contextPackId: context.id } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/runs', headers })).json()).toEqual([]);
});

it('keeps the snapshot of an arbitrary scenario and context through edits and request retries', async () => {
  const app = setup();
  const scenario = { ...storeScenario, id: 'merchant-journey' };
  const context = { ...desktopContext, id: 'merchant-laptop' };
  expect((await app.inject({ method: 'POST', url: '/api/scenarios', headers, payload: scenario })).statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: '/api/context-packs', headers, payload: context })).statusCode).toBe(201);
  const payload = { ...request, scenarioId: scenario.id, contextPackId: context.id };
  const response = await app.inject({ method: 'POST', url: '/api/runs', headers, payload });
  expect(response.statusCode).toBe(202);
  const { id } = response.json<{ id: string }>();

  const edit = { method: 'PUT', url: `/api/scenarios/${scenario.id}`, headers, payload: { ...scenario, label: 'Changed scenario' } } as const;
  expect((await app.inject(edit)).json<ScenarioDefinition>().revision).toBe(2);
  expect((await app.inject(edit)).statusCode).toBe(409);
  const contextEdit = { method: 'PUT', url: `/api/context-packs/${context.id}`, headers, payload: { ...context, inputs: { storeName: 'Edited input' } } } as const;
  expect((await app.inject(contextEdit)).json<ContextPack>().revision).toBe(2);
  expect((await app.inject(contextEdit)).statusCode).toBe(409);

  const retry = await app.inject({ method: 'POST', url: '/api/runs', headers, payload });
  expect(retry.statusCode).toBe(202);
  expect(retry.json().id).toBe(id);
  expect((await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { ...payload, contextRevision: 2 } })).statusCode).toBe(409);
  const run = (await app.inject({ url: `/api/runs/${id}`, headers })).json<RunRecord>();
  expect(run).toMatchObject({ scenario, context, inputs: { storeName: 'Siri Crafts' } });
  expect((await app.inject({ url: '/api/runs', headers })).json()).toHaveLength(1);
});

function completionSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it('preserves the active worker when a second runner cannot bind its port', async () => {
  const started = completionSignal();
  const release = completionSignal();
  const app = setup({
    async executeRun(run) {
      started.resolve();
      await release.promise;
      return { ...run, status: 'completed', verdict: 'inconclusive' };
    },
  });
  const host = '127.0.0.1';
  const address = await app.listen({ host, port: 0 });
  const response = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: request });
  const { id } = response.json<{ id: string }>();
  await started.promise;
  const contender = createServer({ databasePath: join(folder, 'qa.sqlite'), apiToken: token });
  try {
    await expect(contender.listen({ host, port: Number(new URL(address).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect((await app.inject({ url: `/api/runs/${id}`, headers })).json().status).toBe('running');
  } finally {
    release.resolve();
    await contender.close();
  }
  await app.close();
  closed = true;
  const store = openRunStore(join(folder, 'qa.sqlite'));
  try { expect(store.getRun(id)?.status).toBe('completed'); } finally { store.close(); }
});

it('recovers interrupted jobs and resumes the queue after acquiring its listener', async () => {
  const store = openRunStore(join(folder, 'qa.sqlite'));
  const target = 'http://127.0.0.1:3001';
  const active = store.enqueue(request, target);
  store.claimNext();
  const pending = store.enqueue({ ...request, requestId: 'queued-before-restart' }, target);
  store.close();

  const started = completionSignal();
  const app = setup({
    async executeRun(run) {
      started.resolve();
      return { ...run, status: 'completed', verdict: 'inconclusive' };
    },
  });
  const read = async (id: string) => (await app.inject({ url: `/api/runs/${id}`, headers })).json<RunRecord>();
  await app.ready();
  expect((await read(active.id)).status).toBe('running');
  expect((await read(pending.id)).status).toBe('queued');
  await app.listen({ host: '127.0.0.1', port: 0 });
  await started.promise;
  expect((await read(active.id)).status).toBe('interrupted');
  expect((await read(pending.id)).status).toBe('completed');
});

it('executes queued jobs serially and lists only existing, contained artifact paths', async () => {
  const firstStarted = completionSignal();
  const secondStarted = completionSignal();
  const releaseFirst = completionSignal();
  const artifactRoot = join(folder, 'artifacts');
  const app = setup({
    async executeRun(run, onUpdate) {
      if (run.requestId === request.requestId) {
        onUpdate({ ...run, namespaceId: 'seller-session' });
        firstStarted.resolve();
        await releaseFirst.promise;
        const runFolder = join(artifactRoot, run.id);
        mkdirSync(runFolder, { recursive: true });
        writeFileSync(join(runFolder, 'capture.png'), 'evidence');
        writeFileSync(join(artifactRoot, 'outside.png'), 'outside');
        symlinkSync(join(artifactRoot, 'outside.png'), join(runFolder, 'link.png'));
        return { ...run, status: 'completed', verdict: 'passed', namespaceId: 'seller-session',
          artifacts: [`${run.id}/capture.png`, `${run.id}/missing.png`, `${run.id}/../outside.png`, `${run.id}/link.png`] };
      }
      secondStarted.resolve();
      return { ...run, status: 'completed', verdict: 'passed' };
    },
  });
  try {
    const first = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: request });
    const { id: firstId } = first.json<{ id: string }>();
    await firstStarted.promise;
    const second = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { ...request, requestId: 'next' } });
    const { id: secondId } = second.json<{ id: string }>();
    const get = (id: string) => app.inject({ url: `/api/runs/${id}`, headers });
    expect((await get(firstId)).json()).toMatchObject({ status: 'running', namespaceId: 'seller-session' });
    expect((await get(secondId)).json().status).toBe('queued');
    releaseFirst.resolve();
    await secondStarted.promise;
    expect((await get(firstId)).json().status).toBe('completed');
    expect((await app.inject({ url: `/api/runs/${firstId}/artifacts`, headers })).json()).toEqual([`${firstId}/capture.png`]);
    expect((await app.inject({ url: `/api/runs/${secondId}/artifacts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/runs', headers })).json().map((run: RunRecord) => run.id)).toEqual([secondId, firstId]);
  } finally {
    releaseFirst.resolve();
  }
});

it('persists an inconclusive environment failure when browser execution is unavailable', async () => {
  const app = setup();
  const result = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: request });
  expect(result.statusCode).toBe(202);
  await app.close();
  closed = true;
  const store = openRunStore(join(folder, 'qa.sqlite'));
  try {
    expect(store.getRun(result.json().id)).toMatchObject({
      status: 'completed', verdict: 'inconclusive', steps: [],
      findings: [{ kind: 'environment_failure', description: 'Browser execution is not configured yet' }],
    });
  } finally {
    store.close();
  }
});
