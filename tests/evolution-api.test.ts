import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepairJob, RepairTrial, SuggestionJob, SuggestionSnapshot } from '../packages/contracts/src/evolution';
import { desktopContext, inventoryScenario } from '../packages/contracts/src/examples';
import type { ApplicationContext, Population, PopulationExecutionDetail } from '../packages/contracts/src/populations';
import type { EvidenceRun, ReplayPlan } from '../packages/contracts/src/runtime';
import type { Study, StudyApplication } from '../packages/contracts/src/studies';
import { hashValue } from '../apps/runner/src/artifacts';
import { hashReplayPlan } from '../apps/runner/src/replay';
import { createServer, type ServerOptions } from '../apps/runner/src/server';

const origin = 'http://127.0.0.1:3001';
const headers = { authorization: 'Bearer evolution-test' };
const application: StudyApplication = {
  id: 'seller', name: 'Seller', domain: 'Retail', origin, description: 'Manage store inventory',
  workflows: [{ id: 'stock', description: 'Set stock', scenario: inventoryScenario, defaultInputs: { quantity: 5 } }],
};
const code = 'export const quantity = 5;';
const context: ApplicationContext = {
  applicationId: 'seller', version: 'source-v1', capturedAt: '2026-01-01T00:00:00.000Z',
  sources: [{ kind: 'code', path: 'apps/seller-demo/lib/store.ts', digest: hashValue(code), excerpt: code }],
};
const patchBody = {
  summary: 'Save the requested quantity',
  changes: [{ path: context.sources[0].path, before: code, beforeHash: createHash('sha256').update(code).digest('hex'), after: 'export const quantity = 10;' }],
};
const patch = { ...patchBody, hash: hashValue(patchBody) };

let directory: string;
let app: ReturnType<typeof createServer> | undefined;
let buildId: string;
let applicationContext: ApplicationContext;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'evolution-api-'));
  buildId = 'baseline';
  applicationContext = context;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function setup(options: Partial<ServerOptions> = {}) {
  app = createServer({
    apiToken: 'evolution-test', databasePath: join(directory, 'runner.sqlite'), sellerDemoUrl: origin,
    applications: [application], modelConfigured: true,
    generateStudy: async ({ count }) => ({
      draft: {
        title: 'Seller study', summary: 'Stock updates', assumptions: [],
        users: Array.from({ length: count }, (_, index) => ({
          id: `profile-${index}`, name: `Seller ${index}`, summary: 'Set stock', coverageReason: 'Distinct stock quantity',
          workflowId: 'stock', goal: 'Update inventory stock', assumptions: [],
          context: { ...desktopContext, inputs: { quantity: index + 10 } },
        })),
      },
      generation: { source: 'model', model: 'fixture', observedPaths: ['/inventory'] },
    }),
    getBuildId: async () => buildId,
    getApplicationContext: async () => applicationContext,
    async executeRun(run) {
      const source: EvidenceRun = run;
      return {
        ...source, status: 'completed', verdict: 'passed',
        continuity: { ...source.continuity!, startCheckpoint: { id: `checkpoint-${run.id}`, digest: hashValue(run.id) } },
        assertions: run.scenario.contract.assertions.map(({ id }) => ({ id, status: 'passed' })),
        evidence: {
          buildId, scenarioHash: hashValue(run.scenario), policyVersion: 'test', model: 'fixture',
          actions: [{ action: { tool: 'navigate', path: '/inventory' }, url: '/inventory', observation: 'Inventory loaded' }],
          modelCalls: 1, finishedByAgent: true,
        },
      };
    },
    async executeReplay(run, _update, plan) { return replayResult(run, plan, run.inputs.quantity === 10); },
    ...options,
  });
}

function replayResult(run: EvidenceRun, replay: ReplayPlan, fail: boolean): EvidenceRun {
  return {
    ...run, replay, status: 'completed', verdict: fail ? 'failed' : 'passed',
    assertions: run.scenario.contract.assertions.map(({ id }, index) => fail && index === 0
      ? { id, status: 'failed', expected: 10, actual: 5 }
      : { id, status: 'passed' }),
    evidence: {
      buildId: replay.buildId, scenarioHash: replay.scenarioHash, replayHash: replay.hash, replayCompatible: true,
      policyVersion: 'test', model: 'none', actions: replay.actions, modelCalls: 0, finishedByAgent: false,
    },
  };
}

function trials(job: RepairJob, verify = false): RepairTrial[] {
  return job.snapshot.execution.runs.map(source => {
    const regression = source.verdict === 'failed';
    const fail = regression && !verify;
    const rebound = { ...source.replay!, buildId: verify ? 'fixed-build' : 'isolated-build' };
    const replay = { ...rebound, hash: hashReplayPlan(rebound) };
    return {
      testerId: source.continuity!.testerId, role: regression ? 'regression' : 'control',
      outcome: fail ? 'failed' : 'passed', message: 'Replay completed',
      run: replayResult({ ...source, id: `trial-${source.id}`, expectedBuildId: replay.buildId }, replay, fail),
    };
  });
}
const runtime: NonNullable<ServerOptions['repairRuntime']> = {
  prepare: async job => ({ reproduction: trials(job), patch, sourceVersion: 'isolated-copy' }),
  verify: async job => ({ outcome: 'verified', trials: trials(job, true), message: 'All checks passed' }),
};
const get = (url: string) => app!.inject({ url, headers });
const post = (url: string, payload: object) => app!.inject({ method: 'POST', url, payload, headers });
function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
async function enroll(count = 2) {
  const study = await post('/api/studies/generate', {
    requestId: 'study', applicationId: 'seller', domain: 'Retail', audience: 'Independent store owners', count,
  });
  expect(study.statusCode).toBe(201);
  const { id, revision } = study.json<Study>();
  const enrolled = await post('/api/populations', { requestId: 'enroll', studyId: id, revision, label: 'Sellers' });
  expect(enrolled.statusCode).toBe(201);
  return enrolled.json<Population>();
}
const launch = (population: Population, requestId = 'baseline') => post(`/api/populations/${population.id}/executions`, {
  requestId, mode: 'continue', releaseLabel: 'Baseline',
  tasks: population.testers.map(({ id }, index) => ({ testerId: id, workflowId: 'stock', goal: 'Update inventory stock', inputs: { quantity: index + 10 } })),
});
async function waitForStatus<T>(url: string, status: string) {
  let data!: T;
  await vi.waitFor(async () => {
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    data = response.json<T>();
    expect(data).toMatchObject({ status });
  });
  return data;
}
async function completedExecution(response: Awaited<ReturnType<typeof launch>>) {
  expect(response.statusCode).toBe(202);
  return waitForStatus<PopulationExecutionDetail>(`/api/population-executions/${response.json().id}`, 'completed');
}
async function compare(population: Population, baseline: PopulationExecutionDetail) {
  buildId = 'candidate';
  return completedExecution(await post(`/api/populations/${population.id}/executions`, {
    requestId: 'comparison', mode: 'checkpoint', releaseLabel: 'Candidate', baselineExecutionId: baseline.id,
  }));
}
function suggestions(snapshot: SuggestionSnapshot) {
  return snapshot.population.testers.map(tester => ({
    task: { testerId: tester.id, workflowId: 'stock', goal: 'Set a different inventory quantity', inputs: { quantity: 20 } },
    reason: 'Exercise the inventory save requirement',
    sourcePaths: [context.sources[0].path],
    historyRunIds: snapshot.population.episodes.filter(episode => episode.testerId === tester.id).map(episode => episode.run.id),
    assumptions: [],
  }));
}

it('authenticates both job APIs, advertises hooks and returns 404 for missing resources', async () => {
  setup({ generateSuggestions: async () => [], repairRuntime: runtime });
  expect((await get('/api/health')).json()).toMatchObject({ executionReady: true, suggestionsReady: true, repairsReady: true });
  for (const url of ['/api/populations/missing/suggestions', '/api/suggestions/missing', '/api/repairs', '/api/repairs/missing']) {
    expect((await app!.inject(url)).statusCode).toBe(401);
  }
  expect((await app!.inject({ method: 'POST', url: '/api/repairs', payload: { requestId: 'req', executionId: 'missing' } })).statusCode).toBe(401);
  expect((await post('/api/repairs', { requestId: 'req', executionId: 'missing', path: '/private/source' })).statusCode).toBe(400);
  expect((await post('/api/repairs', { requestId: 'req', executionId: 'missing' })).statusCode).toBe(404);
  expect((await post('/api/repairs/missing/verify', { requestId: 'verify', patchHash: patch.hash })).statusCode).toBe(404);
  expect((await post('/api/populations/missing/suggestions', { requestId: 'req' })).statusCode).toBe(404);
  expect((await get('/api/populations/missing/suggestions')).statusCode).toBe(404);
  expect((await get('/api/suggestions/missing')).statusCode).toBe(404);
  expect((await get('/api/repairs/missing')).statusCode).toBe(404);
});

it('coalesces suggestion capture and freezes enrolled testers, history, and both contexts for retry', async () => {
  const capture = deferred();
  const entered = deferred();
  let captures = 0;
  setup({
    generateSuggestions: async snapshot => suggestions(snapshot),
    getApplicationContext: async () => {
      captures++;
      if (captures > 1) {
        entered.release();
        await capture.wait;
      }
      return applicationContext;
    },
  });
  try {
    const population = await enroll();
    const baseline = await completedExecution(await launch(population));
    applicationContext = { ...context, version: 'new-source' };
    const url = `/api/populations/${population.id}/suggestions`;
    const request = { requestId: 'suggest', objective: 'Test a later inventory update' };
    const first = post(url, request);
    const duplicate = post(url, request);
    await entered.wait;
    expect((await post(url, { ...request, objective: 'Different objective' })).statusCode).toBe(409);
    capture.release();
    const responses = await Promise.all([first, duplicate]);
    expect(responses.map(response => response.statusCode)).toEqual([202, 202]);
    const { id } = responses[0].json<SuggestionJob>();
    expect(responses[1].json().id).toBe(id);
    expect(captures).toBe(2);
    const job = await waitForStatus<SuggestionJob>(`/api/suggestions/${id}`, 'completed');
    expect(job.snapshot).toMatchObject({ population, application, previousContext: baseline.applicationContext, context: applicationContext, objective: request.objective });
    expect(job.suggestions?.map(item => item.historyRunIds)).toEqual(baseline.members.map(member => [member.runId]));
    await app!.close();
    setup({ applications: [], getApplicationContext: async () => { throw new Error('provider payload'); } });
    expect((await get('/api/health')).json()).toMatchObject({ suggestionsReady: false, repairsReady: false });
    expect((await post(url, request)).json()).toEqual(job);
    expect((await post(url, { ...request, objective: 'Changed after completion' })).statusCode).toBe(409);
    expect((await get(url)).json()).toEqual([job]);
  } finally { capture.release(); }
});

it.each(['foreign history', 'unknown workflow', 'wrong input type', 'unknown input', 'invented source', 'missing tester', 'extra contract', 'throw'])(
  'safely rejects suggestions with %s', async issue => {
    setup({ generateSuggestions: async snapshot => {
      const items = suggestions(snapshot);
      if (issue === 'foreign history') items[0].historyRunIds = items[1].historyRunIds;
      if (issue === 'unknown workflow') items[0].task.workflowId = 'injected';
      if (issue === 'wrong input type') Object.assign(items[0].task.inputs, { quantity: 'provider payload' });
      if (issue === 'unknown input') Object.assign(items[0].task.inputs, { injected: 'provider payload' });
      if (issue === 'invented source') items[0].sourcePaths = ['other.ts'];
      if (issue === 'missing tester') items.pop();
      if (issue === 'extra contract') Object.assign(items[0].task, { assertions: [] });
      if (issue === 'throw') throw new Error('provider payload');
      return items;
    } });
    const population = await enroll();
    await completedExecution(await launch(population));
    const { id } = (await post(`/api/populations/${population.id}/suggestions`, { requestId: 'bad' })).json<SuggestionJob>();
    const job = await waitForStatus<SuggestionJob>(`/api/suggestions/${id}`, 'completed');
    expect(job.error).toBeTruthy();
    expect(job.suggestions).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain('provider payload');
  },
);

it('requires a current checkpoint comparison and persists one immutable reviewed patch through retries', async () => {
  setup({ repairRuntime: runtime });
  const population = await enroll();
  const baseline = await completedExecution(await launch(population));
  expect((await post('/api/repairs', { requestId: 'bad', executionId: baseline.id })).statusCode).toBe(409);
  const candidate = await compare(population, baseline);
  const request = { requestId: 'repair', executionId: candidate.id };
  buildId = 'stale';
  expect((await post('/api/repairs', request)).statusCode).toBe(409);
  buildId = 'candidate';
  applicationContext = { ...context, version: 'changed-source' };
  expect((await post('/api/repairs', request)).statusCode).toBe(409);
  applicationContext = { ...context, capturedAt: '2026-01-01T01:00:00.000Z' };
  const response = await post('/api/repairs', request);
  expect(response.statusCode).toBe(202);
  const { id } = response.json<RepairJob>();
  const url = `/api/repairs/${id}`;
  const review = await waitForStatus<RepairJob>(url, 'awaiting_review');
  expect(review.snapshot).toEqual({ execution: candidate, context });
  expect(review.reproduction?.map(trial => trial.outcome)).toEqual(['failed', 'passed']);
  expect(review.patch).toEqual(patch);
  expect((await get(`/api/repairs?populationId=${population.id}`)).json()).toEqual([review]);
  expect((await get('/api/repairs?populationId=another')).json()).toEqual([]);
  await app!.close();
  setup({ repairRuntime: runtime });
  await app!.listen({ host: '127.0.0.1', port: 0 });
  expect((await get(url)).json()).toEqual(review);
  expect((await post(`${url}/verify`, { requestId: 'verify', patchHash: 'a'.repeat(64) })).statusCode).toBe(409);
  expect((await post(`${url}/verify`, { requestId: 'verify', patchHash: patch.hash, patch })).statusCode).toBe(400);
  const verificationRequest = { requestId: 'verify', patchHash: patch.hash };
  expect((await post(`${url}/verify`, verificationRequest)).statusCode).toBe(202);
  const verified = await waitForStatus<RepairJob>(url, 'completed');
  expect(verified).toMatchObject({ stage: 'verify', patch, verificationRequest, verification: { outcome: 'verified' } });
  await app!.close();
  setup({ applications: [], getBuildId: async () => { throw new Error('unavailable'); } });
  expect((await post('/api/repairs', request)).json()).toEqual(verified);
  expect((await post('/api/repairs', { ...request, executionId: baseline.id })).statusCode).toBe(409);
  expect((await post(`${url}/verify`, verificationRequest)).json()).toEqual(verified);
  expect((await post(`${url}/verify`, { ...verificationRequest, patchHash: 'a'.repeat(64) })).statusCode).toBe(409);
});

it.each(['missing member', 'duplicate tester', 'swapped role', 'empty assertions', 'missing check', 'changed scenario', 'changed inputs', 'changed replay', 'environment finding'])(
  'downgrades a purported verification with %s', async issue => {
    setup({ repairRuntime: { ...runtime, verify: async job => {
      const result = trials(job, true);
      const first = result[0];
      if (issue === 'missing member') result.pop();
      if (issue === 'duplicate tester') result[1] = first;
      if (issue === 'swapped role') first.role = 'control';
      if (issue === 'empty assertions') first.run.assertions = [];
      if (issue === 'missing check') first.run.assertions.pop();
      if (issue === 'changed scenario') first.run.scenario = { ...first.run.scenario, goal: 'Use a weakened scenario' };
      if (issue === 'changed inputs') first.run.inputs = { ...first.run.inputs, quantity: 900 };
      if (issue === 'changed replay') first.run.replay = { ...first.run.replay!, actions: [] };
      if (issue === 'environment finding') first.run.findings.push({ kind: 'environment_failure', description: 'Build changed during replay', evidencePaths: [] });
      return { outcome: 'verified', trials: result, message: 'untrusted message' };
    } } });
    const population = await enroll();
    const candidate = await compare(population, await completedExecution(await launch(population)));
    const { id } = (await post('/api/repairs', { requestId: 'repair', executionId: candidate.id })).json<RepairJob>();
    const url = `/api/repairs/${id}`;
    await waitForStatus(url, 'awaiting_review');
    expect((await post(`${url}/verify`, { requestId: 'verify', patchHash: patch.hash })).statusCode).toBe(202);
    const job = await waitForStatus<RepairJob>(url, 'completed');
    expect(job.verification?.outcome).toBe('inconclusive');
    expect(job.verification?.message).not.toContain('untrusted message');
    expect(job.patch).toEqual(patch);
  },
);

it.each(['no context', 'no control', 'inconclusive member', 'changed recording'])('rejects a source comparison with %s', async issue => {
  setup({
    repairRuntime: runtime,
    ...(issue === 'no context' && { getApplicationContext: undefined }),
    async executeReplay(run, _update, plan) {
      const result = replayResult(run, plan, run.inputs.quantity === 10 || issue === 'no control');
      if (issue === 'inconclusive member' && run.inputs.quantity === 12) result.evidence!.replayCompatible = false;
      if (issue === 'changed recording') result.evidence!.actions = [];
      return result;
    },
  });
  const population = await enroll(3);
  const candidate = await compare(population, await completedExecution(await launch(population)));
  const response = await post('/api/repairs', { requestId: 'repair', executionId: candidate.id });
  expect(response.statusCode).toBe(409);
  expect((await get('/api/repairs')).json()).toEqual([]);
});

it.each(['incorrect patch hash', 'incorrect before hash', 'changed before source', 'absent patch', 'different reproduced failure', 'provider error'])(
  'completes without review when preparation returns %s', async issue => {
    setup({ repairRuntime: { ...runtime, prepare: async job => {
      const reproduction = trials(job);
      if (issue === 'different reproduced failure') reproduction[0].run.assertions[0].actual = 17;
      if (issue === 'provider error') return { reproduction, error: 'provider payload' };
      if (issue === 'absent patch') return { reproduction };
      let proposal = patch;
      if (issue === 'incorrect patch hash') proposal = { ...patch, hash: 'f'.repeat(64) };
      if (issue === 'incorrect before hash' || issue === 'changed before source') {
        const change = { ...patch.changes[0] };
        if (issue === 'incorrect before hash') change.beforeHash = 'e'.repeat(64);
        else {
          change.before = 'export const quantity = 18;';
          change.beforeHash = createHash('sha256').update(change.before).digest('hex');
        }
        const body = { summary: patch.summary, changes: [change] };
        proposal = { ...body, hash: hashValue(body) };
      }
      return { reproduction, patch: proposal, sourceVersion: 'isolated-copy' };
    } } });
    const population = await enroll();
    const candidate = await compare(population, await completedExecution(await launch(population)));
    const response = await post('/api/repairs', { requestId: 'repair', executionId: candidate.id });
    expect(response.statusCode).toBe(202);
    const job = await waitForStatus<RepairJob>(`/api/repairs/${response.json().id}`, 'completed');
    expect(job.patch).toBeUndefined();
    expect(job.reproduction).toHaveLength(2);
    expect(job.error).toBeTruthy();
    expect(JSON.stringify(job)).not.toContain('provider payload');
  },
);

it('keeps a fully evaluated regressed control visible as a rejected verification', async () => {
  setup({ repairRuntime: { ...runtime, verify: async job => {
    const result = trials(job, true);
    const control = result.find(trial => trial.role === 'control')!;
    control.outcome = 'failed';
    control.run = replayResult(control.run, control.run.replay!, true);
    return { outcome: 'rejected', trials: result, message: 'Control regressed' };
  } } });
  const population = await enroll();
  const candidate = await compare(population, await completedExecution(await launch(population)));
  const response = await post('/api/repairs', { requestId: 'repair', executionId: candidate.id });
  const url = `/api/repairs/${response.json().id}`;
  await waitForStatus(url, 'awaiting_review');
  expect((await post(`${url}/verify`, { requestId: 'verify', patchHash: patch.hash })).statusCode).toBe(202);
  const job = await waitForStatus<RepairJob>(url, 'completed');
  expect(job.verification).toMatchObject({
    outcome: 'rejected', trials: [{ outcome: 'passed' }, { role: 'control', outcome: 'failed' }],
  });
});

it('coalesces repair capture and excludes competing launches while preparation or verification is active', async () => {
  const capture = deferred();
  const capturing = deferred();
  const prepare = deferred();
  const started = deferred();
  const verify = deferred();
  const verifying = deferred();
  let captures = 0;
  let delayCapture = false;
  setup({
    getApplicationContext: async () => {
      if (delayCapture) {
        captures++;
        capturing.release();
        await capture.wait;
      }
      return context;
    },
    repairRuntime: {
      prepare: async job => { started.release(); await prepare.wait; return runtime.prepare(job); },
      verify: async job => { verifying.release(); await verify.wait; return runtime.verify(job); },
    },
  });
  try {
    const population = await enroll();
    const baseline = await completedExecution(await launch(population));
    const candidate = await compare(population, baseline);
    delayCapture = true;
    const request = { requestId: 'repair', executionId: candidate.id };
    const first = post('/api/repairs', request);
    const retry = post('/api/repairs', request);
    await capturing.wait;
    expect((await post('/api/repairs', { ...request, executionId: baseline.id })).statusCode).toBe(409);
    capture.release();
    const [accepted, coalesced] = await Promise.all([first, retry]);
    expect(accepted.statusCode).toBe(202);
    expect(coalesced.json().id).toBe(accepted.json().id);
    expect(captures).toBe(1);
    await started.wait;
    expect((await launch(population, 'competing-launch')).statusCode).toBe(409);
    expect((await post('/api/repairs', { ...request, requestId: 'competing-repair' })).statusCode).toBe(409);
    expect((await launch(population)).json().id).toBe(baseline.id);
    prepare.release();
    const url = `/api/repairs/${accepted.json().id}`;
    await waitForStatus(url, 'awaiting_review');
    expect((await post(`${url}/verify`, { requestId: 'verify', patchHash: patch.hash })).statusCode).toBe(202);
    await verifying.wait;
    expect((await launch(population, 'competing-launch')).statusCode).toBe(409);
    expect((await post('/api/repairs', { ...request, requestId: 'competing-repair' })).statusCode).toBe(409);
    verify.release();
    await waitForStatus(url, 'completed');
    await completedExecution(await launch(population, 'competing-launch'));
  } finally {
    capture.release();
    prepare.release();
    verify.release();
  }
});

it('shares the worker with the three-member execution and waits for active work on close', async () => {
  const runGate = deferred();
  const suggestionGate = deferred();
  const suggestionStarted = deferred();
  let runsStarted = 0;
  let activeRuns = 0;
  let overlappingRuns: number | undefined;
  setup({
    async executeRun(run) {
      runsStarted++;
      activeRuns++;
      await runGate.wait;
      activeRuns--;
      return { ...run, status: 'completed', verdict: 'passed' };
    },
    generateSuggestions: async snapshot => {
      overlappingRuns = activeRuns;
      suggestionStarted.release();
      await suggestionGate.wait;
      return suggestions(snapshot);
    },
  });
  try {
    const population = await enroll(3);
    expect((await launch(population)).statusCode).toBe(202);
    await vi.waitFor(() => expect(runsStarted).toBe(3));
    const { id } = (await post(`/api/populations/${population.id}/suggestions`, { requestId: 'suggest' })).json<SuggestionJob>();
    expect((await get(`/api/suggestions/${id}`)).json().status).toBe('queued');
    runGate.release();
    await suggestionStarted.wait;
    expect(overlappingRuns).toBe(0);
    let closed = false;
    const close = app!.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    suggestionGate.release();
    await close;
    setup();
    expect((await get(`/api/suggestions/${id}`)).json().status).toBe('completed');
  } finally {
    runGate.release();
    suggestionGate.release();
  }
});

it('sanitizes capture and verification failures and does not retry a completed verify request', async () => {
  let failCapture = false;
  let attempts = 0;
  setup({
    getBuildId: async () => {
      if (failCapture) throw new Error('provider payload');
      return buildId;
    },
    repairRuntime: { ...runtime, verify: async () => { attempts++; throw new Error('provider payload'); } },
  });
  const population = await enroll();
  const candidate = await compare(population, await completedExecution(await launch(population)));
  const request = { requestId: 'repair', executionId: candidate.id };
  failCapture = true;
  const failed = await post('/api/repairs', request);
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('provider payload');
  expect((await get('/api/repairs')).json()).toEqual([]);
  failCapture = false;
  const { id } = (await post('/api/repairs', request)).json<RepairJob>();
  const url = `/api/repairs/${id}`;
  await waitForStatus(url, 'awaiting_review');
  const verify = { requestId: 'verify', patchHash: patch.hash };
  expect((await post(`${url}/verify`, verify)).statusCode).toBe(202);
  const job = await waitForStatus<RepairJob>(url, 'completed');
  expect(job.verification?.outcome).toBe('inconclusive');
  expect(JSON.stringify(job)).not.toContain('provider payload');
  expect((await post(`${url}/verify`, verify)).json()).toEqual(job);
  expect(attempts).toBe(1);
});

it('rechecks an in-flight population launch at commit if a repair was accepted during capture', async () => {
  const capture = deferred();
  const capturing = deferred();
  const prepare = deferred();
  let blockNextCapture = false;
  setup({
    async getApplicationContext() {
      if (blockNextCapture) {
        blockNextCapture = false;
        capturing.release();
        await capture.wait;
      }
      return context;
    },
    repairRuntime: { ...runtime, prepare: async job => { await prepare.wait; return runtime.prepare(job); } },
  });
  try {
    const population = await enroll();
    const candidate = await compare(population, await completedExecution(await launch(population)));
    blockNextCapture = true;
    const pending = launch(population, 'pending-launch');
    await capturing.wait;
    const response = await post('/api/repairs', { requestId: 'repair', executionId: candidate.id });
    expect(response.statusCode).toBe(202);
    capture.release();
    expect((await pending).statusCode).toBe(409);
    expect((await get('/api/population-executions')).json()).toHaveLength(2);
    prepare.release();
    await waitForStatus(`/api/repairs/${response.json().id}`, 'awaiting_review');
  } finally {
    capture.release();
    prepare.release();
  }
});

it('rejects preparation and verification while a population execution is active', async () => {
  const runGate = deferred();
  const runStarted = deferred();
  setup({ repairRuntime: runtime });
  try {
    const population = await enroll();
    const candidate = await compare(population, await completedExecution(await launch(population)));
    const request = { requestId: 'preparing', executionId: candidate.id };
    const response = await post('/api/repairs', request);
    expect(response.statusCode).toBe(202);
    const url = `/api/repairs/${response.json().id}`;
    const review = await waitForStatus<RepairJob>(url, 'awaiting_review');
    await app!.close();
    setup({
      repairRuntime: runtime,
      async executeRun(run) {
        runStarted.release();
        await runGate.wait;
        return { ...run, status: 'completed', verdict: 'passed' };
      },
    });
    const execution = await launch(population, 'running');
    await runStarted.wait;
    expect((await post('/api/repairs', { ...request, requestId: 'another' })).statusCode).toBe(409);
    expect((await post(`${url}/verify`, { requestId: 'verify', patchHash: patch.hash })).statusCode).toBe(409);
    expect((await get(url)).json()).toEqual(review);
    runGate.release();
    await completedExecution(execution);
  } finally { runGate.release(); }
});
it('serves the actual isolated replay evidence through the authenticated run endpoint',async()=>{
 setup({repairRuntime:runtime});
 const population=await enroll();
 const candidate=await compare(population,await completedExecution(await launch(population)));
 const response=await post('/api/repairs',{requestId:'repair-evidence',executionId:candidate.id});
 const job=await waitForStatus<RepairJob>(`/api/repairs/${response.json().id}`,'awaiting_review');
 const trial=job.reproduction![0].run;
 expect((await get(`/api/runs/${trial.id}`)).statusCode).toBe(200);
 expect((await get(`/api/runs/${trial.id}`)).json()).toEqual(trial);
 expect((await app!.inject(`/api/runs/${trial.id}`)).statusCode).toBe(401);
});
