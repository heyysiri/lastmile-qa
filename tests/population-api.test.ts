import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '../packages/contracts/src/index';
import { desktopContext, inventoryScenario, storeScenario } from '../packages/contracts/src/examples';
import type { EvidenceRun } from '../packages/contracts/src/runtime';
import type {
  ApplicationContext, EnrollPopulationRequest, LaunchPopulationRequest, Population, PopulationDetail,
  PopulationExecution, PopulationExecutionDetail,
} from '../packages/contracts/src/populations';
import type { GeneratedStudy, Study, StudyApplication, StudyUser } from '../packages/contracts/src/studies';
import { hashValue } from '../apps/runner/src/artifacts';
import { buildReplay, hashReplayPlan } from '../apps/runner/src/replay';
import { createServer, type ServerOptions } from '../apps/runner/src/server';
import { openRunStore } from '../apps/runner/src/store';

const origin = 'http://127.0.0.1:3001';
const headers = { authorization: 'Bearer population-test' };
const application: StudyApplication = {
  id: 'seller', name: 'Seller', domain: 'Retail', origin, description: 'Store setup and inventory',
  workflows: [
    { id: 'setup', description: 'Edit the store profile', scenario: storeScenario, defaultInputs: { storeName: 'Studio' }, preserveStatePaths: ['inventory.0.quantity'] },
    { id: 'inventory', description: 'Set stock', scenario: inventoryScenario, defaultInputs: { quantity: 5 } },
  ],
};
const generated = (count: number): GeneratedStudy => ({
  draft: {
    title: 'Seller study', summary: 'Different seller goals', assumptions: [],
    users: Array.from({ length: count }, (_, index): StudyUser => ({
      id: `profile-${index}`, name: `Seller ${index}`, summary: 'Opening a store', coverageReason: 'Different store names',
      workflowId: index === 0 ? 'inventory' : 'setup', goal: 'Save the configured value', assumptions: [],
      context: { ...desktopContext, inputs: index === 0 ? { quantity: 250 } : { storeName: `Studio ${index}` } },
    })),
  },
  generation: { source: 'model', model: 'test-model', observedPaths: ['/onboarding'] },
});
const appContext: ApplicationContext = {
  applicationId: 'seller', version: 'source-v1', capturedAt: '2026-01-01T00:00:00.000Z',
  sources: [{ kind: 'requirement', path: 'requirements.md', digest: 'rules-digest', excerpt: 'Stock must be preserved.' }],
};

let directory: string;
let app: ReturnType<typeof createServer>;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'population-api-')); });
afterEach(async () => {
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
});

function setup(options: Partial<ServerOptions> = {}) {
  app = createServer({
    apiToken: 'population-test', databasePath: join(directory, 'runner.sqlite'), sellerDemoUrl: origin,
    applications: [application], modelConfigured: true, generateStudy: async ({ count }) => generated(count),
    getBuildId: async () => 'build-one', ...options,
  });
}
const get = (url: string) => app.inject({ url, headers });
const write = (url: string, payload: object, method: 'POST' | 'PUT' = 'POST') => app.inject({ method, url, payload, headers });
async function generate(count = 3) {
  const response = await write('/api/studies/generate', {
    requestId: `generation-${count}`, applicationId: 'seller', domain: 'Retail',
    audience: 'Independent sellers setting up their shop', count,
  });
  expect(response.statusCode).toBe(201);
  return response.json<Study>();
}
const enrollment = (study: Study, requestId = 'enroll'): EnrollPopulationRequest => ({
  requestId, studyId: study.id, revision: study.revision, label: 'Returning sellers',
});
async function enroll(count = 3) {
  const response = await write('/api/populations', enrollment(await generate(count)));
  expect(response.statusCode).toBe(201);
  return response.json<Population>();
}
const continueRequest = (population: Population, requestId = 'next'): Extract<LaunchPopulationRequest, { mode: 'continue' }> => ({
  mode: 'continue', requestId, releaseLabel: 'Release one',
  tasks: population.testers.map((tester, index) => ({
    testerId: tester.id, workflowId: 'setup', goal: 'Update the store profile', inputs: { storeName: `New store ${index}` },
  })),
});
const launch = (population: Population, request: LaunchPopulationRequest = continueRequest(population)) =>
  write(`/api/populations/${population.id}/executions`, request);
const detail = async (id: string) => (await get(`/api/population-executions/${id}`)).json<PopulationExecutionDetail>();
async function complete(response: Awaited<ReturnType<typeof launch>>) {
  expect(response.statusCode).toBe(202);
  const { id } = response.json<PopulationExecution>();
  await vi.waitFor(async () => expect((await detail(id)).status).toBe('completed'));
  return detail(id);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('freezes reviewed testers and fixture identities, and returns a durable enrollment retry before checking the revision', async () => {
  setup();
  expect((await app.inject('/api/populations')).statusCode).toBe(401);
  const study = await generate();
  const request = enrollment(study);
  const [response, retry] = await Promise.all([write('/api/populations', request), write('/api/populations', request)]);
  expect(response.statusCode).toBe(201);
  const population = response.json<Population>();
  expect(retry.json()).toEqual(population);
  expect(population).toMatchObject({
    studyId: study.id, studyRevision: 1, applicationId: 'seller', origin, label: request.label,
  });
  expect(population.testers.map(tester => tester.profile)).toEqual(study.users);
  expect(population.testers.map(tester => tester.initialStateId)).toEqual(['active-seller', 'fresh-seller', 'fresh-seller']);
  expect(new Set(population.testers.map(tester => tester.id)).size).toBe(3);
  const edited = await write(`/api/studies/${study.id}`, {
    revision: study.revision, title: 'Edited', summary: study.summary, assumptions: study.assumptions, users: study.users.slice(1),
  }, 'PUT');
  expect(edited.statusCode).toBe(200);
  expect((await write('/api/populations', enrollment(study, 'stale'))).statusCode).toBe(409);
  expect((await write('/api/populations', { ...request, label: 'Different' })).statusCode).toBe(409);
  await app.close();
  setup({ applications: [] });
  expect((await write('/api/populations', request)).json()).toEqual(population);
  expect((await get(`/api/populations/${population.id}`)).json()).toEqual({ ...population, episodes: [] });
  expect((await get('/api/populations')).json()).toEqual([population]);
  expect((await get('/api/runs')).json()).toEqual([]);
});

it('authenticates context, freezes it at launch, and leaves no partial work when context or build capture fails', async () => {
  let contextFails = true;
  let buildFails = true;
  setup({
    getApplicationContext: async () => {
      if (contextFails) throw new Error('private source path');
      return appContext;
    },
    getBuildId: async () => {
      if (buildFails) throw new Error('private build details');
      return 'build-one';
    },
    async executeRun(run) { return { ...run, status: 'completed', verdict: 'passed' }; },
  });
  expect((await app.inject('/api/applications/seller/context')).statusCode).toBe(401);
  expect((await get('/api/applications/missing/context')).statusCode).toBe(404);
  const population = await enroll(1);
  const failure = await launch(population);
  expect(failure.statusCode).toBe(503);
  expect(failure.body).not.toContain('private');
  contextFails = false;
  expect((await get('/api/applications/seller/context')).json()).toEqual(appContext);
  const buildFailure = await launch(population);
  expect(buildFailure.statusCode).toBe(503);
  expect(buildFailure.body).not.toContain('private');
  expect((await get('/api/population-executions')).json()).toEqual([]);
  expect((await get('/api/runs')).json()).toEqual([]);
  buildFails = false;
  const execution = await complete(await launch(population));
  expect(execution.applicationContext).toEqual(appContext);
  expect(execution.runs[0]).not.toHaveProperty('applicationContext');
});

it('coalesces accepted retries and rejects invalid tasks or competing jobs without adding runs', async () => {
  const releaseBuild = deferred();
  const buildStarted = deferred();
  const releaseRuns = deferred();
  const getBuildId = vi.fn(async () => {
    buildStarted.resolve();
    await releaseBuild.promise;
    return 'build-one';
  });
  const started: EvidenceRun[] = [];
  setup({
    getBuildId,
    validateStudyUser: (_application, user) => {
      if (user.context.inputs.storeName === 'invalid') throw new Error('private application limit');
    },
    async executeRun(run) {
      started.push(run);
      await releaseRuns.promise;
      return { ...run, status: 'completed', verdict: 'passed' };
    },
  });
  try {
    const population = await enroll();
    expect((await get('/api/applications/seller/context')).statusCode).toBe(503);
    const request = continueRequest(population);
    const [step, ...rest] = request.tasks;
    for (const tasks of [
      [step, step, ...rest], [step], [...rest, { ...step, testerId: 'foreign' }],
      [{ ...step, workflowId: 'unknown' }, ...rest], [{ ...step, inputs: { storeName: 4 } }, ...rest],
      [{ ...step, inputs: { storeName: 'invalid' } }, ...rest], [{ ...step, inputs: { ...step.inputs, extra: 'x' } }, ...rest],
    ]) {
      const response = await launch(population, { ...request, tasks });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('private');
    }
    expect((await get('/api/runs')).json()).toEqual([]);
    const first = launch(population, request);
    const retry = launch(population, request);
    await buildStarted.promise;
    expect((await launch(population, { ...request, releaseLabel: 'Conflict' })).statusCode).toBe(409);
    releaseBuild.resolve();
    const [accepted, duplicate] = await Promise.all([first, retry]);
    expect(accepted.statusCode).toBe(202);
    const execution = accepted.json<PopulationExecution>();
    expect(duplicate.json<PopulationExecution>().id).toBe(execution.id);
    expect(getBuildId).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(new Set(started.map(run => run.continuity?.testerId)).size).toBe(3);
    expect(started[0]).toMatchObject({
      scenario: { goal: step.goal, contract: storeScenario.contract }, inputs: step.inputs,
      continuity: { workflowId: 'setup', initialStateId: 'active-seller', history: [], preserveStatePaths: ['inventory.0.quantity'] },
    });
    expect((await launch(population, continueRequest(population, 'competing'))).statusCode).toBe(409);
    const legacy = (await write('/api/runs', {
      requestId: 'legacy', scenarioId: storeScenario.id, scenarioRevision: 1,
      contextPackId: desktopContext.id, contextRevision: 1,
    })).json<{ id: string }>();
    expect((await get(`/api/runs/${legacy.id}`)).json().status).toBe('queued');
    releaseRuns.resolve();
    await vi.waitFor(async () => expect((await get(`/api/runs/${legacy.id}`)).json().status).toBe('completed'));
    expect(started.at(-1)?.id).toBe(legacy.id);
    await app.close();
    setup({ applications: [], getBuildId: async () => { throw new Error('unavailable'); } });
    expect((await launch(population, request)).json<PopulationExecution>().id).toBe(execution.id);
    expect((await launch(population, { ...request, releaseLabel: 'Conflict' })).statusCode).toBe(409);
  } finally {
    releaseBuild.resolve();
    releaseRuns.resolve();
  }
});

const stockCheck = { id: 'preserved-stock', kind: 'state_equals', path: 'inventory.0.quantity', expected: { literal: 250 } } as const;
function priorEvidence(run: EvidenceRun, observation: string): EvidenceRun {
  const scenario = {
    ...run.scenario, contract: { ...run.scenario.contract, assertions: [...run.scenario.contract.assertions, stockCheck] },
  };
  const recordedAt = '2026-01-01T00:00:01.000Z';
  return {
    ...run, scenario, status: 'completed', verdict: 'passed', namespaceId: `account-${run.continuity!.testerId}`,
    continuity: { ...run.continuity!, startCheckpoint: { id: `checkpoint-${run.id}`, digest: 'immutable-digest' } },
    steps: [
      { index: 0, timestamp: recordedAt, action: 'navigate', observation: 'Earlier screen' },
      { index: 1, timestamp: recordedAt, action: 'click', observation },
      { index: 2, timestamp: recordedAt, action: 'inspect', observation: '   ' },
    ],
    assertions: scenario.contract.assertions.map(({ id }) => ({ id, status: 'passed' })),
    evidence: {
      buildId: run.expectedBuildId!, scenarioHash: hashValue(scenario), policyVersion: 'test', model: 'synthetic',
      actions: [{ action: { tool: 'navigate', path: '/onboarding' }, url: origin, observation: 'Opened store' }],
      modelCalls: 1, finishedByAgent: true,
    },
  };
}

it('rebinds only the verified plan build and classifies compatible comparisons per tester', async () => {
  let buildId = 'baseline-build';
  const perform = vi.fn(async (run: RunRecord) => priorEvidence(run, 'Store profile saved'));
  const replay = vi.fn<NonNullable<ServerOptions['executeReplay']>>(async (run, _update, plan) => {
    const index = Number(String(run.inputs.storeName).at(-1));
    const assertions = run.scenario.contract.assertions.map(({ id }) => ({
      id, status: id === 'preserved-stock' && index === 0 ? 'failed' as const : 'passed' as const,
      ...(id==='preserved-stock'&&index===0?{expected:250,actual:5}:{}),
    }));
    return {
      ...run, status: 'completed', verdict: index === 0 ? 'failed' : 'passed', assertions,
      steps: [{ index: 0, action: 'click', timestamp: run.createdAt, observation: 'Candidate-only observation' }],
      evidence: {
        scenarioHash: plan.scenarioHash, buildId: plan.buildId, replayHash: plan.hash, replayCompatible: index !== 2,
        policyVersion: 'test', model: 'none', modelCalls: 0, actions: plan.actions, finishedByAgent: false,
      },
    };
  });
  setup({ getBuildId: async () => buildId, executeRun: perform, executeReplay: replay });
  const population = await enroll();
  const original = await complete(await launch(population));
  const baseline = await complete(await launch(population, continueRequest(population, 'baseline')));
  expect(baseline.runs.map(run => run.continuity?.history[0]?.runId)).toEqual(original.members.map(member => member.runId));
  expect(baseline.runs[0].scenario.contract.assertions).toContainEqual(stockCheck);
  buildId = 'candidate-build';
  await app.close();
  // Remove the workflow catalog entries. Checkpoint launches must use the baseline artifacts.
  setup({ applications: [{ ...application, workflows: [] }], getBuildId: async () => buildId, executeRun: perform, executeReplay: replay });
  const request = { requestId: 'compare', releaseLabel: 'Candidate', mode: 'checkpoint', baselineExecutionId: baseline.id } as const;
  const candidate = await complete(await launch(population, request));
  expect(perform).toHaveBeenCalledTimes(6);
  expect(replay).toHaveBeenCalledTimes(3);
  expect(candidate.comparisons?.map(result => result.outcome)).toEqual(['regression', 'still_passing', 'inconclusive']);
  expect(candidate.comparisons?.[0].message).toContain('preserved-stock');
  expect(candidate.comparisons?.[0].message).toMatch(/inventory.0.quantity.*250.*5/);
  expect(candidate.comparisons?.[2].message).toMatch(/replay|compatib/i);
  for (const [index, source] of baseline.runs.entries()) {
    const originalPlan = buildReplay(source);
    const rebound = { ...originalPlan, buildId };
    const run = candidate.runs[index];
    expect(run).toMatchObject({
      scenario: source.scenario, inputs: source.inputs, context: source.context,
      continuity: { ...source.continuity, mode: 'checkpoint', baselineRunId: source.id, sourceReplayHash: originalPlan.hash },
      replay: { ...rebound, hash: hashReplayPlan(rebound) },
    });
    expect(replay.mock.calls[index][0].namespaceId).toBeUndefined();
  }
  expect(await detail(baseline.id)).toEqual(baseline);
  expect((await launch(population, { ...request, requestId: 'invalid-baseline', baselineExecutionId: candidate.id })).statusCode).toBe(409);
  await app.close();
  setup({ executeRun: perform });
  expect((await launch(population, request)).json<PopulationExecution>().id).toBe(candidate.id);
  expect((await launch(population, { ...request, requestId: 'no-replay' })).statusCode).toBe(503);
  const next = await complete(await launch(population, continueRequest(population, 'after-candidate')));
  expect(next.runs.map(run => run.continuity?.history.map(entry => entry.runId))).toEqual(
    baseline.members.map((member, index) => [member.runId, original.members[index].runId]),
  );
  const history = (await get(`/api/populations/${population.id}`)).json<PopulationDetail>();
  expect(history.episodes).toHaveLength(12);
  expect(history.episodes.find(episode => episode.executionId === candidate.id)?.run.steps[0].observation).toBe('Candidate-only observation');
});

it('takes only the latest three visible observations per tester and retains full history in episodes', async () => {
  setup({ async executeRun(run) {
    return priorEvidence(run, `${run.inputs.storeName} ${'x'.repeat(1700)}`);
  } });
  const population = await enroll(2);
  const past: PopulationExecutionDetail[] = [];
  for (let index = 0; index < 5; index++) {
    past.push(await complete(await launch(population, continueRequest(population, `history-${index}`))));
  }
  for (let index = 0; index < 2; index++) {
    const memory = past[4].runs[index].continuity!.history;
    expect(memory.map(entry => entry.runId)).toEqual([past[3], past[2], past[1]].map(execution => execution.runs[index].id));
    expect(memory[0]).toMatchObject({
      buildId: 'build-one', goal: 'Update the store profile', recordedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(memory[0].observation).toHaveLength(1600);
    expect(memory[0].observation).toMatch(new RegExp(`^New store ${index} `));
  }
  expect(past[3].runs[0].steps[1].observation.length).toBeGreaterThan(1600);
});

it('never falls back to the continuing executor for a queued checkpoint after restart', async () => {
  const executeRun = vi.fn(async (run: RunRecord) => priorEvidence(run, 'Baseline saved'));
  setup({ executeRun });
  const population = await enroll(1);
  const baseline = await complete(await launch(population));
  await app.close();
  const store = openRunStore(join(directory, 'runner.sqlite'));
  let execution: PopulationExecution;
  try {
    execution = store.populations.prepareLaunch(population, {
      requestId: 'compare', releaseLabel: 'Candidate', mode: 'checkpoint', baselineExecutionId: baseline.id,
    }, application, 'ai_guided')('candidate-build');
  } finally {
    store.close();
  }
  setup({ executeRun });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await vi.waitFor(async () => expect(await detail(execution.id)).toMatchObject({
    status: 'completed',
    comparisons: [{ outcome: 'inconclusive' }],
    runs: [{ verdict: 'inconclusive', findings: [{ description: 'Replay execution is unavailable' }] }],
  }));
  expect(executeRun).toHaveBeenCalledOnce();
});

it.each(['partial evaluation', 'wrong scenario hash', 'nonzero model calls'])('treats %s as inconclusive despite a failed verdict', async issue => {
  setup({
    async executeRun(run) { return priorEvidence(run, 'Baseline saved'); },
    async executeReplay(run, _update, plan) {
      return {
        ...run, status: 'completed', verdict: 'failed',
        assertions: run.scenario.contract.assertions.map(({ id }, index) => ({
          id, status: index === 0 ? 'failed' : issue === 'partial evaluation' ? 'not_evaluated' : 'passed',
        })),
        evidence: {
          buildId: plan.buildId, scenarioHash: issue === 'wrong scenario hash' ? 'incorrect' : plan.scenarioHash,
          replayHash: plan.hash, replayCompatible: true, policyVersion: 'test', model: 'none',
          modelCalls: issue === 'nonzero model calls' ? 1 : 0, finishedByAgent: false, actions: plan.actions,
        },
      };
    },
  });
  const population = await enroll(1);
  const baseline = await complete(await launch(population));
  const candidate = await complete(await launch(population, {
    requestId: 'compare', releaseLabel: 'Candidate', mode: 'checkpoint', baselineExecutionId: baseline.id,
  }));
  expect(candidate.comparisons?.[0].outcome).toBe('inconclusive');
});

it.each(['missing checkpoint', 'wrong scenario hash', 'agent did not finish', 'partial baseline assertions'])('rejects a passing baseline with %s before enqueuing candidates', async issue => {
  setup({
    async executeRun(run) {
      const result = priorEvidence(run, 'Baseline saved');
      if (issue === 'missing checkpoint') delete result.continuity!.startCheckpoint;
      if (issue === 'wrong scenario hash') result.evidence!.scenarioHash = 'wrong';
      if (issue === 'agent did not finish') result.evidence!.finishedByAgent = false;
      if (issue === 'partial baseline assertions') result.assertions.pop();
      return result;
    },
    async executeReplay() { throw new Error('Should not start'); },
  });
  const population = await enroll(1);
  const baseline = await complete(await launch(population));
  expect((await launch(population, {
    requestId: 'compare', releaseLabel: 'Candidate', mode: 'checkpoint', baselineExecutionId: baseline.id,
  })).statusCode).toBe(409);
  expect((await get('/api/population-executions')).json()).toHaveLength(1);
  expect((await get('/api/runs')).json()).toHaveLength(1);
});

it('requires the population checkpoint path for persistent sources, targets and controls', async () => {
  let continuingVerdict: 'passed' | 'failed' = 'passed';
  setup({
    async executeRun(run: EvidenceRun) {
      if (!run.continuity) {
        return { ...run, status: 'completed', verdict: continuingVerdict, evidence: {
          buildId: run.expectedBuildId!, scenarioHash: hashValue(run.scenario), policyVersion: 'test',
          model: 'synthetic', actions: [], modelCalls: 1, finishedByAgent: true,
        } };
      }
      const result = priorEvidence(run, 'Profile saved');
      return { ...result, verdict: continuingVerdict };
    },
    async executeReplay() { throw new Error('Should not start'); },
  });
  const population = await enroll(1);
  const control = (await complete(await launch(population))).runs[0];
  const request = { requestId: 'ordinary-replay', contextPackId: desktopContext.id, contextRevision: 1 };
  const replay = await write(`/api/runs/${control.id}/replay`, request);
  expect(replay.statusCode).toBe(400);
  expect(replay.json().message).toMatch(/population checkpoint/i);
  async function ordinary(requestId: string) {
    const { id } = (await write('/api/runs', {
      requestId, scenarioId: storeScenario.id, scenarioRevision: 1,
      contextPackId: desktopContext.id, contextRevision: 1,
    })).json<{ id: string }>();
    await vi.waitFor(async () => expect((await get(`/api/runs/${id}`)).json().status).toBe('completed'));
    return id;
  }
  const ordinaryControl = await ordinary('ordinary-control');
  continuingVerdict = 'failed';
  const target = (await complete(await launch(population, continueRequest(population, 'failing')))).runs[0];
  const ordinaryTarget = await ordinary('ordinary-target');
  const requestBase = { requestId: 'investigation', factors: ['viewport'], maxAttempts: 4 };
  for (const ids of [
    { targetRunId: target.id, controlRunId: ordinaryControl },
    { targetRunId: ordinaryTarget, controlRunId: control.id },
  ]) {
    const investigation = await write('/api/investigations', { ...requestBase, ...ids });
    expect(investigation.statusCode).toBe(400);
    expect(investigation.json().message).toMatch(/population checkpoint/i);
  }
  expect((await get('/api/investigations')).json()).toEqual([]);
});
