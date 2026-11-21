import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApplicationContextReader } from '../apps/runner/src/application-context';
import { hashValue } from '../apps/runner/src/artifacts';
import { hashReplayPlan } from '../apps/runner/src/replay';
import { createRepairRuntime, type RepairCodingInput, type WithRepairBuild } from '../apps/runner/src/repair-runtime';
import { createApi } from '../apps/seller-demo/lib/api';
import { SellerStore } from '../apps/seller-demo/lib/store';
import { RESET_STOCK_DEFECT } from '../apps/seller-demo/lib/config';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import type { RepairJob, RepairPreparation } from '../packages/contracts/src/evolution';
import type { EvidenceRun, RecordedAction } from '../packages/contracts/src/runtime';
import type { StudyApplication } from '../packages/contracts/src/studies';

const storePath = 'apps/seller-demo/lib/store.ts';
const original = await readFile(new URL('../apps/seller-demo/lib/store.ts', import.meta.url), 'utf8');
const reset = "if (resetStock) this.db.prepare('UPDATE inventory SET quantity = 5 WHERE namespace_id = ?').run(namespaceId);";
const fixed = original.replace(reset, 'void resetStock;');
const buildId = 'original-build';
const testToken = 'fixture-test-token';
const require = createRequire(import.meta.url);
let dir: string;
let root: string;
let workspaceRoot: string;
let databasePath: string;
let artifactRoot: string;
let job: RepairJob;
let realAccount: { namespaceId: string; token: string };
let seller: SellerStore;
let withBuild: WithRepairBuild;
let envFailureOnVerify: boolean;
let childOrigins: string[];
let verificationBuilds: number;
let closeCurrent: (() => Promise<void>) | undefined;

async function listen(fn: import('node:http').RequestListener) {
  const server = createServer(fn);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

const actions: RecordedAction[] = [
  { action: { tool: 'navigate', path: '/onboarding' }, url: '/onboarding', observation: 'Loaded form' },
  { action: { tool: 'fill', locator: { by: 'label', value: 'Store name' }, value: { input: 'storeName' } }, url: '/onboarding', observation: 'Filled name' },
  { action: { tool: 'click', locator: { by: 'role', value: 'button', name: 'Save' } }, url: '/onboarding', observation: 'Saved store' },
];

function freezeMember(testerId: string, checkpoint: { id: string; digest: string }, quantity: number): EvidenceRun {
  const scenario = structuredClone(storeScenario);
  scenario.contract.assertions.push({ id: 'preserve-stock', kind: 'state_equals', path: 'inventory.0.quantity', expected: { literal: quantity } });
  const scenarioHash = hashValue(scenario);
  const baselineRunId = `baseline-${testerId}`;
  const baseline = { version: 1 as const, sourceRunIds: [baselineRunId], scenarioHash, buildId: 'good-build', actions: structuredClone(actions) };
  const replay = { ...baseline, buildId };
  const failed = quantity !== 5;
  return {
    id: `source-${testerId}`, requestId: `source-${testerId}`, scenario, context: structuredClone(desktopContext),
    inputs: { storeName: 'Siri Crafts' }, createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    manifestHash: hashValue(testerId), status: 'completed', verdict: failed ? 'failed' : 'passed', executionMode: 'deterministic',
    steps: [], findings: [], capabilities: [], artifacts: [], expectedBuildId: buildId,
    assertions: [
      { id: 'confirmation', status: 'passed' },
      { id: 'store-name', status: 'passed', expected: 'Siri Crafts', actual: 'Siri Crafts' },
      { id: 'store-status', status: 'passed', expected: 'ready', actual: 'ready' },
      { id: 'preserve-stock', status: failed ? 'failed' : 'passed', expected: quantity, actual: 5 },
    ],
    continuity: {
      populationId: 'population', testerId, initialStateId: 'active-seller', workflowId: 'store-setup', mode: 'checkpoint',
      preserveStatePaths: ['inventory.0.quantity'], startCheckpoint: checkpoint, baselineRunId, sourceReplayHash: hashReplayPlan(baseline), history: [],
    },
    replay: { ...replay, hash: hashReplayPlan(replay) },
    evidence: {
      buildId, scenarioHash, actions: structuredClone(actions), modelCalls: 0, model: 'none', policyVersion: 'browser-v1',
      finishedByAgent: false, replayCompatible: true, replayHash: hashReplayPlan(replay),
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'repair-runtime-test-'));
  root = join(dir, 'root');
  workspaceRoot = join(dir, 'workspaces');
  databasePath = join(dir, 'seller.sqlite');
  artifactRoot = join(dir, 'artifacts');
  await mkdir(join(root, 'apps/seller-demo/lib'), { recursive: true });
  await writeFile(join(root, storePath), original);
  await writeFile(join(root, 'requirements.md'), 'Saving the store must preserve the existing stock quantity.');
  await writeFile(join(root, 'package.json'), '{}');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  seller = new SellerStore(databasePath);
  realAccount = seller.openAccount('real-regression', 'active-seller');
  seller.saveQuantity(realAccount.namespaceId, 'SCARF-001', 17);
  const control = seller.openAccount('real-control', 'active-seller');
  const runs = [
    freezeMember('regression', seller.captureCheckpoint(realAccount.namespaceId, 'reg'), 17),
    freezeMember('control', seller.captureCheckpoint(control.namespaceId, 'control'), 5),
  ];
  const live = await listen((req, res) => {
    res.writeHead(req.url === '/api/test/build' && req.headers.authorization === `Bearer ${testToken}` ? 200 : 404).end(JSON.stringify({ buildId }));
  });
  closeCurrent = live.close;
  const context = await createApplicationContextReader(root, { 'seller-demo': [
    { kind: 'code', path: storePath }, { kind: 'requirement', path: 'requirements.md' },
  ] })({ id: 'seller-demo' } as StudyApplication);
  job = {
    id: 'job', request: { requestId: 'prepare', executionId: 'execution' }, populationId: 'population',
    status: 'running', stage: 'prepare', createdAt: runs[0].createdAt,
    snapshot: { context, execution: {
      id: 'execution', populationId: 'population', requestId: 'original-checkpoint', mode: 'checkpoint', releaseLabel: 'Candidate', buildId,
      status: 'completed', createdAt: runs[0].createdAt, finishedAt: runs[0].finishedAt, baselineExecutionId: 'baseline',
      population: {
        id: 'population', label: 'Sellers', applicationId: 'seller-demo', origin: live.origin, studyId: 'study', studyRevision: 1,
        createdAt: runs[0].createdAt, testers: [],
      },
      members: runs.map(run => ({ testerId: run.continuity!.testerId, runId: run.id })),
      applicationContext: context, runs,
      comparisons: [
        { testerId: 'regression', baselineRunId: 'baseline-regression', outcome: 'regression', message: 'Stock changed' },
        { testerId: 'control', baselineRunId: 'baseline-control', outcome: 'still_passing', message: 'Stock unchanged' },
      ],
    } },
  };
  envFailureOnVerify = false;
  childOrigins = [];
  verificationBuilds = 0;
  withBuild = async (options, use) => {
    const { tree, databasePath, testToken, defect } = options;
    expect(defect).toBe(RESET_STOCK_DEFECT);
    const content = await readFile(join(tree, storePath), 'utf8');
    const verifying = content !== original;
    if (verifying) verificationBuilds++;
    const compiled = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
    const exports = {} as { SellerStore: typeof SellerStore };
    runInNewContext(compiled.outputText, { require, exports });
    const store = new exports.SellerStore(databasePath);
    const buildId = hashValue(content);
    const api = createApi({ store, env: { ENABLE_TEST_API: 'true', TEST_API_TOKEN: testToken, SELLER_DEMO_DEFECT: defect },
      getBuildId: async () => buildId });
    const server = await listen(async (req, res) => {
      try {
        const url = `http://127.0.0.1${req.url}`;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
        const path = new URL(url).pathname;
        const clone = /^\/api\/test\/checkpoints\/([^/]+)\/clone$/.exec(path);
        let response: Response;
        if (clone) response = await api.testCheckpointClone(request, clone[1]);
        else if (path === '/api/test/build') response = await api.testBuild(request);
        else if (path === '/api/test/state') response = verifying && envFailureOnVerify ? new Response(null, { status: 503 }) : await api.testState(request);
        else if (req.method === 'POST') {
          const name = new URLSearchParams(Buffer.concat(chunks).toString()).get('name');
          const saved = await api.putStore(new Request(url, { method: 'PUT', headers: request.headers, body: JSON.stringify({ name }) }));
          response = new Response(saved.ok ? '<h1>Store saved</h1>' : '<h1>Save failed</h1>', { headers: { 'content-type': 'text/html' } });
        } else {
          response = new Response('<form method="post"><label>Store name<input name="name"></label><button>Save</button></form>', { headers: { 'content-type': 'text/html' } });
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
      } catch { res.writeHead(500).end(); }
    });
    childOrigins.push(server.origin);
    try { return await use({ origin: server.origin, buildId }); }
    finally { await server.close(); store.close(); }
  };
});

afterEach(async () => {
  await closeCurrent?.();
  seller.close();
  await rm(dir, { recursive: true, force: true });
});

function runtime(after = fixed) {
  const propose = vi.fn(async (_input: RepairCodingInput, _signal: AbortSignal) => ({ summary: 'Preserve stock', changes: [{ path: storePath, after }] }));
  const options = { root, workspaceRoot, sellerDatabasePath: databasePath, artifactRoot,
    origin: job.snapshot.execution.population.origin, testToken, defect: RESET_STOCK_DEFECT, model: 'fixture-model' };
  return { propose, options, repair: createRepairRuntime(options, { propose, withBuild }) };
}

function forVerification(prepared: RepairPreparation): RepairJob {
  expect(prepared.error).toBeUndefined();
  expect(prepared.patch).toBeDefined();
  return { ...job, stage: 'verify', patch: prepared.patch, sourceVersion: prepared.sourceVersion,
    verificationRequest: { requestId: 'verify', patchHash: prepared.patch!.hash } };
}

it('replays the regression and control and verifies the reviewed stock repair in a fresh runtime and database', async () => {
  const { repair, propose, options } = runtime();
  const prepared = await repair.prepare(job);
  const verificationJob = forVerification(prepared);
  expect(prepared.reproduction.map(({ role, outcome }) => ({ role, outcome }))).toEqual([
    { role: 'regression', outcome: 'failed' }, { role: 'control', outcome: 'passed' },
  ]);
  expect(propose).toHaveBeenCalledTimes(1);
  expect(propose.mock.calls[0][0].sources).toEqual([{ path: storePath, content: original, editable: true }]);
  expect(JSON.stringify(propose.mock.calls[0][0])).not.toContain(realAccount.token);
  // A different checkout and no reachable live server at verification time.
  await writeFile(join(root, storePath), 'new live code');
  await closeCurrent?.();
  closeCurrent = undefined;
  const result = await createRepairRuntime(options, { withBuild }).verify(verificationJob);
  expect(result.outcome, result.message).toBe('verified');
  expect(result.trials.map(trial => trial.outcome)).toEqual(['passed', 'passed']);
  for (const [index, trial] of result.trials.entries()) {
    const source = job.snapshot.execution.runs[index];
    expect(trial.run.continuity).toEqual(source.continuity);
    expect(trial.run.inputs).toEqual(source.inputs);
    expect(trial.run.scenario).toEqual(source.scenario);
    expect(trial.run.replay?.actions).toEqual(source.replay!.actions);
    expect(trial.run.replay?.hash).not.toBe(source.replay!.hash);
    expect(trial.run.evidence?.modelCalls).toBe(0);
    expect(trial.run.namespaceId).not.toBe(prepared.reproduction[index].run.namespaceId);
    expect(trial.run.artifacts).toContain(`${trial.run.id}/readback.json`);
    expect(await readFile(join(artifactRoot, trial.run.id, 'assertions.json'), 'utf8')).toContain('preserve-stock');
  }
  expect(seller.getState(realAccount.namespaceId).inventory[0].quantity).toBe(17);
  expect(seller.resolveSession(realAccount.token)).toBe(realAccount.namespaceId);
  expect(await readdir(join(workspaceRoot, job.id))).not.toContain(expect.stringMatching(/^trial-/));
  for (const origin of childOrigins) await expect(fetch(origin)).rejects.toThrow();
}, 20_000);

it.each([
  ['still corrupts stock', original.replace(reset, reset.replace('quantity = 5', 'quantity = 6')), ['failed', 'failed']],
  ['breaks only the passing control', original.replace(reset, "void resetStock; this.db.prepare('UPDATE inventory SET quantity = 0 WHERE namespace_id = ? AND quantity = 5').run(namespaceId);"), ['passed', 'failed']],
] as const)('rejects a patch that %s', async (_name, after, outcomes) => {
  const { repair } = runtime(after);
  const result = await repair.verify(forVerification(await repair.prepare(job)));
  expect(result.outcome, result.message).toBe('rejected');
  expect(result.trials.map(trial => trial.outcome)).toEqual(outcomes);
}, 20_000);

it('flags missing trusted checks as inconclusive', async () => {
  const { repair } = runtime();
  const prepared = await repair.prepare(job);
  envFailureOnVerify = true;
  const result = await repair.verify(forVerification(prepared));
  expect(result.outcome, result.message).toBe('inconclusive');
  expect(result.trials.map(trial => trial.outcome)).toEqual(['inconclusive', 'inconclusive']);
}, 20_000);

it.each(['id', 'expected', 'actual'] as const)('refuses to propose when the reproduced failure differs by %s', async field => {
  const { repair, propose } = runtime();
  const assertion = job.snapshot.execution.runs[0].assertions.at(-1)!;
  if (field === 'id') {
    const run = job.snapshot.execution.runs[0];
    run.assertions.find(result => result.id === 'store-name')!.status = 'failed';
    assertion.status = 'passed';
  } else {
    assertion[field] = 23;
  }
  const result = await repair.prepare(job);
  expect(result.patch).toBeUndefined();
  expect(result.reproduction).toHaveLength(2);
  expect(propose).not.toHaveBeenCalled();
}, 20_000);

it('requires the original context digest and refuses a changed live source', async () => {
  const { repair, propose } = runtime();
  await writeFile(join(root, storePath), original + '\n');
  const result = await repair.prepare(job);
  expect(result.error).toMatch(/source/i);
  expect(propose).not.toHaveBeenCalled();
});

it.each(['action', 'assertion', 'source'] as const)('refuses changes to the frozen %s after review', async changed => {
  const { repair } = runtime();
  const request = forVerification(await repair.prepare(job));
  if (changed === 'source') await writeFile(join(workspaceRoot, job.id, 'source', 'package.json'), '{"changed":true}');
  else {
    const run = request.snapshot.execution.runs[0];
    if (changed === 'action') run.replay!.actions[0].action = { tool: 'navigate', path: '/inventory' };
    else run.scenario.contract.assertions.pop();
  }
  const result = await repair.verify(request);
  expect(result.outcome).toBe('inconclusive');
  expect(result.trials).toEqual([]);
  expect(verificationBuilds).toBe(0);
}, 20_000);
