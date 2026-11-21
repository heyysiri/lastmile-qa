import { expect, it } from 'vitest';
import type { ProjectRun, ProjectTesterResult, ProjectContextInvestigation } from '../packages/contracts/src/projects';
import * as investigation from '../apps/runner/src/project-context-investigation';

function fixture() {
  const results = ['failed', 'passed'].map((status, i) => ({
    tester: { id: `tester${i}`, context: { network: { mode: 'request_delay', delayMs: 20, pathPrefix: '/'  } } },
    journey: { id: `journey${i}`, testerId: `tester${i}`, checks: [{ id: 'check', kind: 'text' }] },
    checks: [{ id: 'check', label: 'Value', expected: 'ok', actual: status === 'passed' ? 'ok' : 'bad', status, phase: 'after_reload', basis: 'requirement', sources: [] }],
    run: { status: 'completed', verdict: status, context: { network: { mode: 'request_delay', delayMs: 20, pathPrefix: '/'  } }, evidence: {
      actions: [], modelCalls: 0, replayCompatible: true,
    } },
  })) as unknown as ProjectTesterResult[];
  const source = { status: 'completed', results } as ProjectRun;
  const trials = (['original', 'normal_network'] as const).flatMap(condition => ([1, 2] as const).map(repeat => {
    const results = structuredClone(source.results);
    if (condition === 'normal_network') for (const result of results) {
      result.tester.context.network = { mode: 'normal' };
      result.run.context.network = { mode: 'normal' };
      result.run.verdict = 'passed';
      result.checks[0].status = 'passed';
      result.checks[0].actual = 'ok';
    }
    return { condition, repeat, results };
  }));
  return { source, report: { factor: 'network', outcome: 'likely_trigger', message: 'worker claim', trials } as ProjectContextInvestigation };
}

it('exports the pure investigation boundary', () => {
  expect(investigation).toHaveProperty('createNormalNetworkVariant');
  expect(investigation).toHaveProperty('validateProjectContextInvestigation');
});
it('changes only network and does not mutate frozen input', () => {
  const { source } = fixture();
  const before = structuredClone(source);
  const variant = investigation.createNormalNetworkVariant(source);
  expect(source).toEqual(before);
  expect(variant.results[0].tester.context.network).toEqual({ mode: 'normal' });
  expect(variant.results[0].checks).toEqual(before.results[0].checks);
  expect(variant.results[0].journey).toEqual(before.results[0].journey);
});
it('recomputes a repeatable network trigger from all four trials', () => {
  const { source, report } = fixture();
  report.outcome = 'unresolved';
  expect(investigation.validateProjectContextInvestigation(source, report).outcome).toBe('likely_trigger');
});
it.each(['missing', 'duplicate', 'changed-check', 'stage-check', 'model', 'incompatible', 'control', 'original-pass', 'action', 'context', 'missing-evidence'])(
  'rejects unsupported trigger: %s', kind => {
    const { source, report } = fixture();
    const result = report.trials[3].results[0];
    if (kind === 'missing') report.trials.pop();
    if (kind === 'duplicate') report.trials[3] = structuredClone(report.trials[2]);
    if (kind === 'changed-check') result.checks[0].expected = 'different';
    if (kind === 'stage-check') result.checks[0].atStageStart = 'return';
    if (kind === 'model') result.run.evidence!.modelCalls = 1;
    if (kind === 'incompatible') result.run.evidence!.replayCompatible = false;
    if (kind === 'control') { report.trials[3].results[1].checks[0].status = 'failed'; report.trials[3].results[1].run.verdict = 'failed'; }
    if (kind === 'original-pass') { report.trials[1].results[0].checks[0].status = 'passed'; report.trials[1].results[0].checks[0].actual = 'ok'; report.trials[1].results[0].run.verdict = 'passed'; }
    if (kind === 'action') result.run.evidence!.actions.push({ action: { type: 'wait', ms: 1 } } as never);
    if (kind === 'context') result.run.context.locale = 'other';
    if (kind === 'missing-evidence') delete source.results[0].run.evidence;
    expect(investigation.validateProjectContextInvestigation(source, report).outcome).toBe('unresolved');
  },
);
it('does not investigate a nonnormal passing control alone', () => {
  const { source } = fixture();
  source.results[0].tester.context.network = { mode: 'normal' };
  expect(investigation.hasNetworkInvestigation(source)).toBe(false);
});

it('normalizes stage overrides, evidence and discovery mirrors while preserving all other fields', () => {
  const { source } = fixture();
  const result = source.results[0];
  result.journey.stages = [{ id: 'return', label: 'Return', goal: 'Read', transition: 'reopen', pauseMs: 3, network: { mode: 'request_delay', delayMs: 30, pathPrefix: '/'  } }];
  result.run.evidence!.stages = [{ id: 'return', actionStart: 0, actionEnd: 0, transition: 'reopen', pauseMs: 3, modelCalls: 0, completed: true, network: { mode: 'request_delay', delayMs: 30, pathPrefix: '/'  } }];
  source.discovery = { plan: { testers: [result.tester], journeys: [result.journey] } } as ProjectRun['discovery'];
  const before = structuredClone(source);
  const variant = investigation.createNormalNetworkVariant(source);
  expect(variant.discovery!.plan.testers[0].context.network).toEqual({ mode: 'normal' });
  expect(variant.discovery!.plan.journeys[0].stages![0].network).toEqual({ mode: 'normal' });
  expect(variant.results[0].run.evidence!.stages![0].network).toEqual({ mode: 'normal' });
  expect(variant.results[0].journey.stages![0].transition).toBe('reopen');
  expect(source).toEqual(before);
});

it.each(['valid', 'missing-entry', 'incomplete', 'gap', 'condition', 'extra-stage'])('requires complete staged traces: %s', kind => {
  const { source } = fixture();
  for (const result of source.results) {
    result.journey.stages = [{ id: 'return', label: 'Return', goal: 'Read', transition: 'reopen' }];
    result.run.evidence!.stages = [{ id: 'return', actionStart: 0, entryActionEnd: 0, actionEnd: 0, transition: 'reopen', pauseMs: 0, modelCalls: 1, completed: true, network: result.tester.context.network } as never];
  }
  const report: ProjectContextInvestigation = { factor: 'network', outcome: 'likely_trigger', message: '', trials: [] };
  for (const condition of ['original', 'normal_network'] as const) for (const repeat of [1, 2] as const) {
    const trial = structuredClone(condition === 'original' ? source : investigation.createNormalNetworkVariant(source));
    for (const result of trial.results) {
      result.run.evidence!.stages![0].modelCalls = 0;
      if (condition === 'normal_network') { result.run.verdict = 'passed'; result.checks[0].status = 'passed'; result.checks[0].actual = 'ok'; }
    }
    report.trials.push({ condition, repeat, results: trial.results });
  }
  const stage = report.trials[3].results[0].run.evidence!.stages![0];
  if (kind === 'missing-entry') delete (stage as typeof stage & {entryActionEnd?:number}).entryActionEnd;
  if (kind === 'incomplete') stage.completed = false;
  if (kind === 'gap') stage.actionStart = 1;
  if (kind === 'condition') stage.network = { mode: 'request_delay', delayMs: 20, pathPrefix: '/'  };
  if (kind === 'extra-stage') report.trials[3].results[0].run.evidence!.stages!.push(stage);
  expect(investigation.validateProjectContextInvestigation(source, report).outcome).toBe(kind === 'valid' ? 'likely_trigger' : 'unresolved');
});

it.each(['missing-check', 'wrong-tester', 'incomplete-run', 'duplicate-case'])('rejects malformed source evidence: %s', kind => {
  const { source, report } = fixture();
  if (kind === 'missing-check') source.results[0].checks = [];
  if (kind === 'wrong-tester') source.results[0].journey.testerId = 'other';
  if (kind === 'incomplete-run') source.results[0].run.status = 'running';
  if (kind === 'duplicate-case') source.results.push(structuredClone(source.results[0]));
  // Keep worker mirrors internally consistent; source itself must still be rejected.
  for (const trial of report.trials) for (const result of trial.results) {
    result.journey = structuredClone(source.results.find(s => s.journey.id === result.journey.id)!.journey);
  }
  expect(investigation.validateProjectContextInvestigation(source, report).outcome).toBe('unresolved');
});

it('rejects a changed route even when the worker claims compatible replay', () => {
  const { source, report } = fixture();
  const action = { action: { tool: 'click' as const, locator: { by: 'text' as const, value: 'Save' } }, url: 'https://original.test/saved', urlBefore: '/edit', routeVersion: 2 as const, observation: 'Saved' };
  source.results[0].run.evidence!.actions = [action];
  for (const trial of report.trials) trial.results[0].run.evidence!.actions = [{ ...action, url: 'http://127.0.0.1:1234/saved' }];
  expect(investigation.validateProjectContextInvestigation(source, report).outcome).toBe('likely_trigger');
  report.trials[3].results[0].run.evidence!.actions[0].url = 'http://127.0.0.1:1234/error';
  expect(investigation.validateProjectContextInvestigation(source, report).outcome).toBe('unresolved');
});

it.each([undefined, null, {}, { trials: null }])('normalizes malformed investigation containers without throwing: %j', report => {
  const { source } = fixture();
  expect(investigation.validateProjectContextInvestigation(source, report as unknown as ProjectContextInvestigation)).toMatchObject({ outcome: 'unresolved', trials: [] });
});
