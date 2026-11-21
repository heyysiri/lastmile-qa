import { expect, it } from 'vitest';
import { ContextPackSchema, ScenarioSchema, compileInputs, type ContextPack } from '../packages/contracts/src/index';
import type { DifferentialResult, EvidenceRun, InvestigationFactor, ReplayPlan } from '../packages/contracts/src/runtime';
import { investigate } from '../packages/differential/src/index';

const scenario = ScenarioSchema.parse({
  id: 'adjust-availability', label: 'Adjust availability', goal: 'Save the available quantity',
  entryPath: '/availability', initialStateId: 'existing-listing',
  inputSlots: { quantity: { type: 'number' }, enabled: { type: 'boolean' } },
  contract: {
    scope: 'ui_and_api',
    assertions: [
      { id: 'saved', kind: 'visible', locator: { by: 'text', value: 'Saved' } },
      { id: 'quantity', kind: 'state_equals', path: 'listing.quantity', expected: { input: 'quantity' } },
    ],
  },
  investigation: { factors: ['inputs', 'locale', 'network', 'reducedMotion', 'interaction'], maxAttempts: 10 },
});
const targetContext = ContextPackSchema.parse({
  id: 'test-target', label: 'Target', viewport: { width: 800, height: 600 },
  locale: 'ja-JP', preferredLanguage: 'English', familiarity: 'experienced', interaction: 'pointer',
  reducedMotion: 'reduce', network: { mode: 'normal' }, inputs: { quantity: 7, enabled: true },
});
const controlContext: ContextPack = {
  ...targetContext, id: 'test-control', label: 'Control', revision: 2,
  locale: 'en-GB', reducedMotion: 'no-preference', inputs: { quantity: 19, enabled: true },
};
const replay: ReplayPlan = {
  version: 1, hash: 'replay-hash', sourceRunIds: ['control'], scenarioHash: 'scenario-hash', buildId: 'build',
  actions: [{ action: { tool: 'navigate', path: '/availability' }, url: '/availability', observation: '' }, {action:{tool:'fill',locator:{by:'label',value:'Quantity'},value:{input:'quantity'}},url:'/availability',observation:''}],
};

function run(id: string, context: ContextPack, passes: boolean, plan?: ReplayPlan): EvidenceRun {
  return structuredClone({
    id, requestId: id, scenario, context, inputs: compileInputs(scenario, context),
    status: 'completed', verdict: passes ? 'passed' : 'failed', executionMode: plan ? 'deterministic' : 'ai_guided',
    createdAt: '2026-01-01', namespaceId: id, manifestHash: id, steps: [], artifacts: [],
    assertions: [
      { id: 'saved', status: 'passed' },
      { id: 'quantity', status: passes ? 'passed' : 'failed', expected: context.inputs.quantity, actual: passes ? context.inputs.quantity : 0 },
    ],
    findings: passes ? [] : [{ kind: 'api_or_outcome_failure', description: 'Wrong saved quantity', evidencePaths: [] }],
    capabilities: (['locale', 'network', 'reducedMotion', 'inputs'] as const).map(factor => ({
      factor, status: 'applied', value: context[factor],
    })),
    evidence: {
      buildId: replay.buildId, scenarioHash: replay.scenarioHash, policyVersion: 'policy', model: 'synthetic',
      actions: [], modelCalls: 0, finishedByAgent: false, replayHash: plan?.hash, replayCompatible: plan ? true : undefined,
    },
  });
}

function request(passes: (context: ContextPack) => boolean = context => context.inputs.quantity === 19) {
  let attempts = 0;
  return {
    id: 'investigation', target: run('target', targetContext, false), control: run('control', controlContext, true),
    replay: structuredClone(replay), factors: ['reducedMotion', 'inputs', 'locale'] as InvestigationFactor[], maxAttempts: 9,
    runTrial: async (context: ContextPack, plan: ReplayPlan) => run(`attempt-${++attempts}`, context, passes(context), plan),
  };
}

it('repeats each comparison in priority order and preserves constants and resolved expectations', async () => {
  const updates: DifferentialResult[] = [];
  const result = await investigate({
    ...request(), onUpdate: snapshot => updates.push(snapshot),
  });
  expect(result).toMatchObject({
    status: 'completed', conclusion: 'reproducible_failure', isolationStatus: 'isolated', attemptsUsed: 8,
    likelyTriggers: ['inputs'], untestedFactors: ['locale'],
  });
  expect(result.trials.map(trial => [
    trial.role, trial.repeat, trial.factor, trial.run.context.locale, trial.run.context.reducedMotion,
    trial.run.inputs, trial.run.assertions[1].expected,
  ])).toEqual([
    ['target', 1, undefined, 'ja-JP', 'reduce', { quantity: 7, enabled: true }, 7],
    ['target', 2, undefined, 'ja-JP', 'reduce', { quantity: 7, enabled: true }, 7],
    ['control', 1, undefined, 'en-GB', 'no-preference', { quantity: 19, enabled: true }, 19],
    ['control', 2, undefined, 'en-GB', 'no-preference', { quantity: 19, enabled: true }, 19],
    ['candidate', 1, 'reducedMotion', 'ja-JP', 'no-preference', { quantity: 7, enabled: true }, 7],
    ['candidate', 2, 'reducedMotion', 'ja-JP', 'no-preference', { quantity: 7, enabled: true }, 7],
    ['candidate', 1, 'inputs', 'ja-JP', 'reduce', { quantity: 19, enabled: true }, 19],
    ['candidate', 2, 'inputs', 'ja-JP', 'reduce', { quantity: 19, enabled: true }, 19],
  ]);
  expect(result.trials.map(trial => trial.run.evidence?.replayHash)).toEqual(Array(8).fill(replay.hash));
  expect(updates[0]).toMatchObject({ status: 'running', attemptsUsed: 0, trials: [] });
  expect(updates.at(-1)).toEqual(result);
});

it('reports unresolved when only the original combination passes', async () => {
  const result = await investigate({
    ...request(context => context.locale === 'en-GB' && context.reducedMotion === 'no-preference'), maxAttempts: 10,
  });
  expect(result).toMatchObject({
    conclusion: 'reproducible_failure', isolationStatus: 'unresolved', attemptsUsed: 10,
    likelyTriggers: [], untestedFactors: [],
  });
});

it.each([
  ['locale', (context: ContextPack) => context.locale === 'en-GB'],
  ['reducedMotion', (context: ContextPack) => context.reducedMotion === 'no-preference'],
] as const)('isolates %s when its substitution passes twice', async (factor, passes) => {
  const result = await investigate({ ...request(passes), maxAttempts: 10 });
  expect(result).toMatchObject({
    conclusion: 'reproducible_failure', isolationStatus: 'isolated', attemptsUsed: 10,
    likelyTriggers: [factor], untestedFactors: [],
  });
});

it('leaves a candidate unresolved when just one repeat passes', async () => {
  let candidateAttempts = 0;
  const result = await investigate({
    ...request(context => context.locale === 'en-GB' ||
      (context.reducedMotion === 'no-preference' && ++candidateAttempts === 1)),
    maxAttempts: 6,
  });
  expect(result).toMatchObject({
    conclusion: 'reproducible_failure', isolationStatus: 'unresolved', attemptsUsed: 6,
    likelyTriggers: [], untestedFactors: ['inputs', 'locale'],
  });
});

it('preserves reproduction evidence when the budget covers baselines only', async () => {
  const result = await investigate({ ...request(), maxAttempts: 4 });
  expect(result).toMatchObject({
    conclusion: 'reproducible_failure', isolationStatus: 'not_attempted', attemptsUsed: 4,
    likelyTriggers: [], untestedFactors: ['reducedMotion', 'inputs', 'locale'],
  });
});

it.each([
  ['guidance factor', (input: ReturnType<typeof request>) => { input.factors.push('knownTerms' as InvestigationFactor); }],
  ['non-array factor list', (input: ReturnType<typeof request>) => { Object.assign(input, { factors: 'locale' }); }],
  ['factor excluded by the scenario', (input: ReturnType<typeof request>) => { input.factors.push('viewport'); }],
  ['unselected changed factor', (input: ReturnType<typeof request>) => { input.factors.pop(); }],
  ['guidance difference', (input: ReturnType<typeof request>) => { input.control.context.knownTerms = ['Publish']; }],
  ['unselected constant', (input: ReturnType<typeof request>) => { input.control.context.viewport.width = 900; }],
  ['identical conditions', (input: ReturnType<typeof request>) => {
    const { id, revision, label } = input.control.context;
    input.control.context = { ...input.target.context, id, revision, label };
    input.control.inputs = input.target.inputs;
  }],
  ['multiple input changes', (input: ReturnType<typeof request>) => {
    input.control.context.inputs.enabled = false;
    input.control.inputs.enabled = false;
  }],
  ['stale control build', (input: ReturnType<typeof request>) => { input.control.evidence!.buildId = 'older'; }],
  ['stale scenario hash', (input: ReturnType<typeof request>) => { input.control.evidence!.scenarioHash = 'older'; }],
  ['stale policy', (input: ReturnType<typeof request>) => { input.control.evidence!.policyVersion = 'older'; }],
  ['changed contract', (input: ReturnType<typeof request>) => { input.control.scenario.contract.assertions.pop(); }],
  ['stale replay', (input: ReturnType<typeof request>) => { input.replay.buildId = 'older'; }],
  ['lack of outcome finding', (input: ReturnType<typeof request>) => { input.target.findings = []; }],
  ['unfinished control', (input: ReturnType<typeof request>) => { input.control.status = 'running'; }],
  ['budget exceeds scenario limit', (input: ReturnType<typeof request>) => { input.maxAttempts = 11; }],
  ['fractional budget', (input: ReturnType<typeof request>) => { input.maxAttempts = 4.5; }],
])('rejects %s before making a trial', async (_name, mutate) => {
  const input = request();
  mutate(input);
  expect(await investigate({ ...input, runTrial: async () => { throw new Error('Unexpected trial'); } })).toMatchObject({
    status: 'completed', conclusion: 'inconclusive', isolationStatus: 'not_attempted', attemptsUsed: 0, trials: [],
  });
});

it.each([
  ['replay mismatch', (trial: EvidenceRun) => { trial.evidence!.replayCompatible = false; }],
  ['changed replay hash', (trial: EvidenceRun) => { trial.evidence!.replayHash = 'another-replay'; }],
  ['different build', (trial: EvidenceRun) => { trial.evidence!.buildId = 'another-build'; }],
  ['different scenario snapshot', (trial: EvidenceRun) => { trial.scenario.initialStateId = 'other-listing'; }],
  ['different requested context', (trial: EvidenceRun) => { trial.context.interaction = 'keyboard_only'; }],
  ['different input bindings', (trial: EvidenceRun) => { trial.inputs.quantity = 8; }],
  ['reused trial ID', (trial: EvidenceRun) => { trial.id = 'attempt-1'; }],
  ['reused fixture namespace', (trial: EvidenceRun) => { trial.namespaceId = 'attempt-1'; }],
  ['unsupported changed capability', (trial: EvidenceRun) => { trial.capabilities.find(item => item.factor === 'locale')!.status = 'unsupported'; }],
  ['mismatched failure signature', (trial: EvidenceRun) => { trial.assertions[0].status = 'failed'; }],
  ['missing independent outcome finding', (trial: EvidenceRun) => { trial.findings = []; }],
])('preserves the run and returns inconclusive on %s', async (_name, mutate) => {
  const input = request();
  let attempts = 0;
  const result = await investigate({
    ...input,
    runTrial: async (context, plan) => {
      const trial = await input.runTrial(context, plan);
      if (++attempts === 2) mutate(trial);
      return trial;
    },
  });
  expect(result).toMatchObject({ conclusion: 'inconclusive', attemptsUsed: 2, isolationStatus: 'not_attempted' });
  expect(result.trials.map(trial => trial.repeat)).toEqual([1, 2]);
  expect(result.trials[1].run.requestId).toBe('attempt-2');
});

it('requires the network delay to be exercised in a trial', async () => {
  const input = request();
  input.control.context.network = { mode: 'request_delay', delayMs: 100, pathPrefix: '/listings' };
  input.factors.push('network');
  const result = await investigate({
    ...input,
    runTrial: async (context, plan) => {
      const trial = await input.runTrial(context, plan);
      if (context.network.mode === 'request_delay') trial.capabilities.find(item => item.factor === 'network')!.status = 'not_exercised';
      return trial;
    },
  });
  expect(result).toMatchObject({ conclusion: 'inconclusive', attemptsUsed: 3, likelyTriggers: [] });
  expect(result.trials[2].run.capabilities).toContainEqual(expect.objectContaining({ factor: 'network', status: 'not_exercised' }));
});

it('counts a thrown attempt and retains only the trials that returned evidence', async () => {
  const input = request();
  let attempts = 0;
  const result = await investigate({
    ...input,
    runTrial: async (context, plan) => {
      if (++attempts === 6) throw new Error('Browser disconnected');
      return input.runTrial(context, plan);
    },
  });
  expect(result).toMatchObject({
    conclusion: 'inconclusive', isolationStatus: 'unresolved', attemptsUsed: 6,
    likelyTriggers: [], untestedFactors: ['reducedMotion', 'inputs', 'locale'],
  });
  expect(result.trials).toHaveLength(5);
});

it('holds frozen snapshots when the caller or an update consumer mutates its copies', async () => {
  const input = request();
  let first = true;
  const result = await investigate({
    ...input,
    onUpdate: snapshot => { snapshot.untestedFactors.length = 0; snapshot.trials.length = 0; },
    runTrial: async (context, plan) => {
      if (first) {
        first = false;
        input.control.context.inputs.quantity = 99;
        input.target.scenario.initialStateId = 'stale';
        input.replay.hash = 'stale';
        input.factors.reverse();
      }
      return input.runTrial(context, plan);
    },
  });
  expect(result).toMatchObject({
    conclusion: 'reproducible_failure', likelyTriggers: ['inputs'], untestedFactors: ['locale'], replayHash: replay.hash,
  });
  expect(result.trials).toHaveLength(8);
});

it('rejects input comparisons whose replay enters a literal instead of the varied binding',async()=>{
 const input=request();
 input.replay={...input.replay,actions:[{action:{tool:'fill',locator:{by:'label',value:'Quantity'},value:{literal:19}},url:'/availability',observation:''}]};
 const result=await investigate(input);
 expect(result.attemptsUsed).toBe(0);
 expect(result.conclusion).toBe('inconclusive');
 expect(result.message).toMatch(/symbolic|binding/i);
});
