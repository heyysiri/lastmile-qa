import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '../packages/contracts/src/index';
import { desktopContext, inventoryScenario, storeScenario } from '../packages/contracts/src/examples';
import type { GeneratedStudy, Study, StudyApplication, StudyBrief, StudyExecution, StudyExecutionDetail, StudyUser } from '../packages/contracts/src/studies';
import { createApplications, validateApplicationInputValues } from '../apps/runner/src/applications';
import { createServer, type ServerOptions } from '../apps/runner/src/server';

const origin = 'http://127.0.0.1:3001';
const headers = { authorization: 'Bearer study-test' };
const application: StudyApplication = {
  id: 'seller-demo', name: 'Seller demo', domain: 'Marketplace', origin, description: 'Store setup and inventory',
  workflows: [
    { id: 'setup', description: 'Set up a store', scenario: storeScenario, defaultInputs: { storeName: 'Studio' } },
    { id: 'inventory', description: 'Set stock', scenario: inventoryScenario, defaultInputs: { quantity: 12 } },
  ],
};
const brief: StudyBrief = {
  applicationId: application.id, domain: 'Craft', audience: 'Independent sellers opening their first store', count: 3,
};
const generated = ({ count }: StudyBrief): GeneratedStudy => ({
  draft: {
    title: 'Seller study', summary: 'Compare real task outcomes', assumptions: [],
    users: Array.from({ length: count }, (_, i): StudyUser => ({
      id: `tester-${i}`, name: `Seller ${i}`, summary: 'Opening a store', coverageReason: 'Different store names',
      workflowId: i === 2 ? 'inventory' : 'setup', goal: i === 2 ? 'Update the supplied quantity' : 'Save the supplied store name',
      assumptions: [],
      context: {
        ...desktopContext, inputs: i === 2 ? { quantity: 24 } : { storeName: `Studio ${i}` },
      },
    })),
  },
  generation: { source: 'model', model: 'test-model', observedPaths: ['/onboarding', '/inventory'] },
});

let app: ReturnType<typeof createServer>;
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'lastmile-study-api-')); });
afterEach(async () => {
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
});

function setup(options: Partial<ServerOptions> = {}) {
  app = createServer({
    apiToken: 'study-test', databasePath: join(directory, 'qa.sqlite'), sellerDemoUrl: origin,
    applications: [structuredClone(application)], generateStudy: async input => generated(input),
    getBuildId: async () => 'build-one', modelConfigured: false, ...options,
  });
}
const get = (url: string) => app.inject({ url, headers });
const write = (url: string, payload: object, method: 'POST' | 'PUT' = 'POST') => app.inject({ method, url, payload, headers });
const generate = (payload: object = { ...brief, requestId: 'generation' }) => write('/api/studies/generate', payload);
const launch = (study: Study, requestId = 'launch') => write(`/api/studies/${study.id}/launch`, { requestId, revision: study.revision });
const detail = (id: string) => get(`/api/study-executions/${id}`).then(response => response.json<StudyExecutionDetail>());
const editable = ({ title, summary, assumptions, users, revision }: Study) => ({ title, summary, assumptions, users, revision });
const complete = (run: RunRecord) => ({ ...run, status: 'completed' as const, verdict: 'passed' as const });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('authorizes study routes and limits the catalog to the configured origin', async () => {
  setup({ applications: [application, { ...application, id: 'foreign', origin: 'https://example.org' }], generateStudy: undefined });
  expect((await app.inject('/api/applications')).statusCode).toBe(401);
  expect((await app.inject('/api/studies')).statusCode).toBe(401);
  expect((await app.inject('/api/study-executions')).statusCode).toBe(401);
  expect((await get('/api/applications')).json()).toEqual([application]);
  expect((await generate({ ...brief, applicationId: 'foreign', requestId: 'foreign' })).statusCode).toBe(404);
  expect((await generate({ ...brief, count: 4, requestId: 'bad' })).statusCode).toBe(400);
  expect((await generate()).statusCode).toBe(503);
  expect((await get('/api/studies/missing')).statusCode).toBe(404);
  expect((await get('/api/study-executions/missing')).statusCode).toBe(404);
  expect((await app.inject({
    method: 'POST', url: '/api/studies/generate', payload: { ...brief, requestId: 'foreign-origin' },
    headers: { ...headers, origin: 'https://example.org' },
  })).statusCode).toBe(401);
});

it('shares a paid generation between concurrent retries and persists the accepted response', async () => {
  const started = deferred();
  const release = deferred();
  const generateStudy = vi.fn(async (input: StudyBrief) => {
    started.resolve();
    await release.promise;
    return generated(input);
  });
  setup({ generateStudy });
  const first = generate();
  const retry = generate();
  try {
    await vi.waitFor(() => expect(generateStudy).toHaveBeenCalledOnce());
    await started.promise;
    const conflict = await generate({ ...brief, audience: 'An audience with different requirements', requestId: 'generation' });
    expect(conflict.statusCode).toBe(409);
    expect((await get('/api/studies')).json()).toEqual([]);
    expect((await get('/api/runs')).json()).toEqual([]);
  } finally {
    release.resolve();
  }
  const [accepted, duplicate] = await Promise.all([first, retry]);
  expect(accepted.statusCode).toBe(201);
  expect(duplicate.json()).toEqual(accepted.json());
  expect(generateStudy).toHaveBeenCalledTimes(1);

  const study = accepted.json<Study>();
  expect(study).toMatchObject({ revision: 1, brief, generation: generated(brief).generation });
  const edited = await write(`/api/studies/${study.id}`, { ...editable(study), title: 'Edited', users: study.users.slice(0, 1) }, 'PUT');
  expect(edited.statusCode).toBe(200);
  expect(edited.json<Study>()).toMatchObject({ revision: 2, brief, title: 'Edited', users: [study.users[0]] });
  await app.close();
  setup({ generateStudy });
  expect((await generate()).json()).toEqual(study);
  expect((await get('/api/studies')).json()).toEqual([edited.json()]);
  expect(generateStudy).toHaveBeenCalledTimes(1);
});

it('rejects invalid generated or edited drafts and keeps provider errors private', async () => {
  const output = generated(brief);
  const generateStudy = vi.fn()
    .mockRejectedValueOnce(new Error('secret provider response'))
    .mockResolvedValueOnce({ ...output, draft: { ...output.draft, users: output.draft.users.slice(0, 1) } })
    .mockResolvedValueOnce({ ...output, draft: { ...output.draft, users: [{ ...output.draft.users[0], workflowId: 'unavailable' }, ...output.draft.users.slice(1)] } })
    .mockResolvedValue(output);
  setup({ generateStudy });
  const providerFailure = await generate();
  expect(providerFailure.statusCode).toBe(502);
  expect(providerFailure.body).not.toContain('secret provider response');
  expect((await generate()).statusCode).toBe(409);
  expect((await generate({ ...brief, requestId: 'wrong-count' })).statusCode).toBe(502);
  expect((await generate({ ...brief, requestId: 'unsupported-workflow' })).statusCode).toBe(502);
  expect((await get('/api/studies')).json()).toEqual([]);

  const study = (await generate({ ...brief, requestId: 'valid' })).json<Study>();
  const invalidUser = { ...study.users[0], context: { ...study.users[0].context, inputs: { storeName: 123 } } };
  const url = `/api/studies/${study.id}`;
  expect((await write(url, { ...editable(study), users: [invalidUser] }, 'PUT')).statusCode).toBe(400);
  expect((await write(url, { ...editable(study), brief }, 'PUT')).statusCode).toBe(400);
  expect((await get(url)).json()).toEqual(study);
});

it('runs three isolated members together, then resumes legacy work and the next batch after a member throws', async () => {
  const threeStarted = deferred();
  const release = deferred();
  const executionStarts: RunRecord[] = [];
  const running = new Set<string>();
  let peak = 0;
  const getBuildId = vi.fn(async () => 'build-one');
  setup({
    getBuildId,
    modelConfigured: true,
    async executeRun(run, onUpdate) {
      executionStarts.push(run);
      running.add(run.id);
      peak = Math.max(peak, running.size);
      const namespaceId = `session-${run.id}`;
      onUpdate({ ...run, namespaceId, steps: [{ index: 0, timestamp: new Date().toISOString(), action: 'navigate', observation: 'Opened browser' }] });
      if (executionStarts.length === 3) threeStarted.resolve();
      try {
        await release.promise;
        if (run.scenario.id === 'tester-1') throw new Error('private executor error');
        return { ...complete(run), namespaceId };
      } finally {
        running.delete(run.id);
      }
    },
  });
  try {
    const study = (await generate()).json<Study>();
    const [response, duplicate] = await Promise.all([launch(study), launch(study)]);
    expect(response.statusCode).toBe(202);
    const first = response.json<StudyExecution>();
    expect(duplicate.json<StudyExecution>().id).toBe(first.id);
    expect(first.expectedBuildId).toBe('build-one');
    await threeStarted.promise;
    expect(peak).toBe(3);

    const save = await write(`/api/studies/${study.id}`, {
      ...editable(study), title: 'Updated draft', users: [{ ...study.users[0], goal: 'Review and save the supplied store name' }],
    }, 'PUT');
    const revised = save.json<Study>();
    expect(revised.revision).toBe(2);
    expect((await write(`/api/studies/${study.id}`, editable(study), 'PUT')).statusCode).toBe(409);
    expect((await launch(study, 'stale')).statusCode).toBe(409);
    expect((await launch(revised)).statusCode).toBe(409);
    expect((await launch(study)).json<StudyExecution>().id).toBe(first.id);
    const second = (await launch(revised, 'next-study')).json<StudyExecution>();
    expect(second.status).toBe('queued');
    const legacy = (await write('/api/runs', {
      requestId: 'legacy', scenarioId: storeScenario.id, scenarioRevision: 1,
      contextPackId: desktopContext.id, contextRevision: 1,
    })).json<{ id: string }>();
    expect((await get(`/api/runs/${legacy.id}`)).json().status).toBe('queued');

    const inProgress = await detail(first.id);
    expect(inProgress.study).toEqual(study);
    expect(inProgress.runs.map(run => run.id)).toEqual(first.members.map(member => member.runId));
    expect(new Set(inProgress.runs.map(run => run.namespaceId)).size).toBe(3);
    expect(inProgress.runs.every(run => run.status === 'running' && run.steps.length === 1)).toBe(true);
    expect(inProgress.runs.map(run => run.scenario.contract)).toEqual([storeScenario.contract, storeScenario.contract, inventoryScenario.contract]);
    expect(inProgress.runs.map(run => run.inputs)).toEqual([{ storeName: 'Studio 0' }, { storeName: 'Studio 1' }, { quantity: 24 }]);
    expect(executionStarts).toHaveLength(3);

    release.resolve();
    await vi.waitFor(async () => expect((await detail(second.id)).status).toBe('completed'));
    const terminal = await detail(first.id);
    expect(terminal).toMatchObject({ status: 'completed', study, finishedAt: expect.any(String) });
    expect(terminal.runs.map(run => run.verdict)).toEqual(['passed', 'inconclusive', 'passed']);
    expect(terminal.runs[1].findings).toEqual([expect.objectContaining({ kind: 'environment_failure' })]);
    expect(JSON.stringify(terminal)).not.toContain('private executor error');
    expect((await get(`/api/runs/${legacy.id}`)).json().status).toBe('completed');
    expect(executionStarts.map(run => run.id)).toEqual([...first.members.map(member => member.runId), legacy.id, second.members[0].runId]);
    expect((await get('/api/study-executions')).json<StudyExecution[]>().map(item => item.id)).toEqual([second.id, first.id]);
    expect(getBuildId).toHaveBeenCalledTimes(3);
  } finally {
    release.resolve();
  }
});

it('waits for active members on close and rejects launch if the build cannot be frozen', async () => {
  const started = deferred();
  const release = deferred();
  const getBuildId = vi.fn().mockRejectedValueOnce(new Error('private service error')).mockResolvedValue('build-one');
  setup({
    getBuildId,
    async executeRun(run) {
      started.resolve();
      await release.promise;
      return complete(run);
    },
  });
  const study = (await generate({ ...brief, count: 1, requestId: 'single' })).json<Study>();
  const failed = await launch(study);
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('private service error');
  expect((await get('/api/study-executions')).json()).toEqual([]);
  const accepted = (await launch(study)).json<StudyExecution>();
  let closed = false;
  try {
    await started.promise;
    const close = app.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release.resolve();
    await close;
  } finally {
    release.resolve();
  }
  setup();
  expect(await detail(accepted.id)).toMatchObject({ status: 'completed', runs: [{ status: 'completed' }] });
});


it('enforces connected application input limits on edited drafts before creating any runs', async () => {
 const catalog=createApplications(origin)[0];
 const output=generated(brief);
 output.draft.users.forEach((user,i)=>{user.workflowId=i===2?'inventory-update':'store-setup';});
 setup({applications:[catalog],generateStudy:async()=>output,validateStudyUser:validateApplicationInputValues});
 const study=(await generate()).json<Study>();
 expect(study.revision).toBe(1);
 for(const [index,inputs] of [[0,{storeName:'x'.repeat(81)}],[0,{storeName:' '}],[2,{quantity:-1}],[2,{quantity:1.5}]] as const){
  const draft=editable(structuredClone(study));
  draft.users[index].context.inputs={...inputs};
  expect((await write(`/api/studies/${study.id}`,draft,'PUT')).statusCode).toBe(400);
 }
 expect((await get(`/api/studies/${study.id}`)).json()).toEqual(study);
 expect((await get('/api/runs')).json()).toEqual([]);
});

it('revalidates new launches but preserves retries of an already accepted execution',async()=>{
 let reject=false;
 setup({validateStudyUser:()=>{if(reject)throw new Error('private validation detail');}});
 const study=(await generate({...brief,count:1,requestId:'single'})).json<Study>();
 const accepted=await launch(study);
 expect(accepted.statusCode).toBe(202);
 reject=true;
 expect((await launch(study)).json<StudyExecution>().id).toBe(accepted.json<StudyExecution>().id);
 const invalid=await launch(study,'new-attempt');
 expect(invalid.statusCode).toBe(400);
 expect(invalid.body).not.toContain('private validation detail');
 expect((await get('/api/study-executions')).json()).toHaveLength(1);
});
