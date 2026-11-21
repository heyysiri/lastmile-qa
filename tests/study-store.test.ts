import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '../packages/contracts/src/index';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import type { GeneratedStudy, StudyApplication, StudyBrief, StudyExecutionDetail } from '../packages/contracts/src/studies';
import { createServer } from '../apps/runner/src/server';
import { openRunStore } from '../apps/runner/src/store';

const origin = 'http://127.0.0.1:3001';
const application: StudyApplication = {
  id: 'seller-demo', name: 'Seller demo', domain: 'Marketplace', origin, description: 'Set up a store',
  workflows: [{ id: 'setup', description: 'Set up a store', scenario: storeScenario, defaultInputs: { storeName: 'Studio' } }],
};
const brief: StudyBrief = {
  applicationId: application.id, domain: 'Craft', audience: 'Independent sellers opening their first store', count: 1,
};
const generated: GeneratedStudy = {
  draft: {
    title: 'A study', summary: 'Set up a store', assumptions: [],
    users: [{
      id: 'tester', name: 'Seller', summary: 'Opening a store', coverageReason: 'Exercises account setup',
      assumptions: [], workflowId: 'setup', goal: 'Save the supplied store name', context: desktopContext,
    }],
  },
  generation: { source: 'model', model: 'test-model', observedPaths: ['/onboarding'] },
};
let directory: string;
let path: string;
let store: ReturnType<typeof openRunStore> | undefined;
let app: ReturnType<typeof createServer> | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lastmile-study-store-'));
  path = join(directory, 'qa.sqlite');
  store = openRunStore(path);
});
afterEach(async () => {
  store?.close();
  store = undefined;
  await app?.close();
  app = undefined;
  rmSync(directory, { recursive: true, force: true });
});
const headers = { authorization: 'Bearer study-test' };
const detail = (id: string) => app!.inject({ url: `/api/study-executions/${id}`, headers }).then(response => response.json<StudyExecutionDetail>());

it('interrupts running studies, members, and unfinished generation and resumes queued snapshots at listen', async () => {
  const { studies } = store!;
  studies.beginGeneration('unfinished', brief);
  studies.beginGeneration('accepted', brief);
  const study = studies.finishGeneration('accepted', brief, generated);
  const active = studies.launch(study.id, { requestId: 'active', revision: 1 }, application, 'build-one', 'ai_guided');
  const queued = studies.launch(study.id, { requestId: 'queued', revision: 1 }, application, 'build-two', 'ai_guided');
  expect(store!.claimNext()).toBeUndefined();
  expect(studies.claimNext()?.execution.id).toBe(active.id);
  expect(studies.claimNext()).toBeUndefined();
  store!.close();
  store = undefined;

  const changedCatalog = structuredClone(application);
  changedCatalog.workflows[0].scenario.entryPath = '/changed';
  changedCatalog.workflows[0].scenario.contract.assertions = [];
  const generateStudy = vi.fn(async () => generated);
  const executeRun = vi.fn(async (run: RunRecord) => ({ ...run, status: 'completed' as const, verdict: 'passed' as const }));
  app = createServer({
    databasePath: path, apiToken: 'study-test', sellerDemoUrl: origin,
    applications: [changedCatalog], generateStudy, executeRun,
  });
  await app.ready();
  expect(await detail(active.id)).toMatchObject({ status: 'running', runs: [{ status: 'running' }] });
  expect(await detail(queued.id)).toMatchObject({ status: 'queued', runs: [{ status: 'queued' }] });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await vi.waitFor(async () => expect((await detail(queued.id)).status).toBe('completed'));

  expect(await detail(active.id)).toMatchObject({
    status: 'interrupted', finishedAt: expect.any(String), runs: [{ status: 'interrupted', verdict: 'inconclusive' }],
  });
  expect(await detail(queued.id)).toMatchObject({
    study, runs: [{ scenario: { entryPath: storeScenario.entryPath, contract: storeScenario.contract }, expectedBuildId: 'build-two' }],
  });
  expect(executeRun).toHaveBeenCalledOnce();
  const retry = await app.inject({
    method: 'POST', url: '/api/studies/generate', headers, payload: { ...brief, requestId: 'unfinished' },
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json().code).toBe('generation_interrupted');
  expect(generateStudy).not.toHaveBeenCalled();
});

it('never executes a queued study against a different configured origin after restart', async () => {
  const { studies } = store!;
  studies.beginGeneration('accepted', brief);
  const study = studies.finishGeneration('accepted', brief, generated);
  const queued = studies.launch(study.id, { requestId: 'queued', revision: 1 }, application, 'build-one', 'ai_guided');
  store!.close();
  store = undefined;

  const executeRun = vi.fn();
  app = createServer({ databasePath: path, apiToken: 'study-test', sellerDemoUrl: 'http://127.0.0.1:3002', executeRun });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await vi.waitFor(async () => expect((await detail(queued.id)).status).toBe('completed'));
  expect(executeRun).not.toHaveBeenCalled();
  expect(await detail(queued.id)).toMatchObject({
    status: 'completed', runs: [{ status: 'completed', verdict: 'inconclusive' }],
  });
});
