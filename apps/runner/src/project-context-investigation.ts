import type { ProjectRun, ProjectTesterResult, ProjectContextInvestigation } from '@lastmile/contracts/projects';
import type { RecordedAction } from '@lastmile/contracts/runtime';
import { hashValue } from './artifacts';

const same = (left: unknown, right: unknown) => hashValue([left]) === hashValue([right]);

function checkIds(result: ProjectTesterResult) {
  const ids = result.journey.checks.map(check => check.id);
  return ids.length > 0 && new Set(ids).size === ids.length
    && same([...ids].sort(), result.checks.map(check => check.id).sort());
}

export function compareProjectReplayResults(source: ProjectRun, results: ProjectTesterResult[]) {
  if (results.length !== source.results.length || new Set(results.map(result => result.journey.id)).size !== results.length) throw new Error('Replay cases changed');
  return source.results.flatMap(original => {
    const result = results.find(item => item.journey.id === original.journey.id);
    if (!result || !checkIds(result) || !same(result.tester, original.tester) || !same(result.journey, original.journey)
      || result.run.status !== 'completed' || result.run.evidence?.modelCalls !== 0 || result.run.evidence.replayCompatible !== true
      || result.checks.some(check => !['passed', 'failed'].includes(check.status))
      || result.run.verdict !== (result.checks.some(check => check.status === 'failed') ? 'failed' : 'passed')) {
      throw new Error('Replay changed a frozen tester, journey, or conclusive check');
    }
    if(original.journey.stages&&!completeProjectReplayEvidence(original,result))throw new Error('Replay changed a frozen stage transition');
    return original.checks.map(before => {
      const after = result.checks.find(check => check.id === before.id)!;
      const identity = ({ id, expected, label, phase, atStageStart, basis, sources }: typeof before) => ({ id, expected, label, phase, atStageStart, basis, sources });
      const checkKind=original.journey.checks.find(check=>check.id===before.id)!.kind;
      const expectedActual=checkKind==='visible'?after.expected:String(after.expected);
      if (!same(identity(before), identity(after))
        || (after.status === 'passed' && after.expected !== undefined && !same(after.actual, expectedActual))) {
        throw new Error('Replay changed a frozen check expectation or returned an inconsistent outcome');
      }
      return { before, after };
    });
  });
}

export function hasNetworkInvestigation(source: ProjectRun): boolean {
  return source.results.some(result => result.checks.some(check => check.status === 'failed')
    && (result.tester.context.network.mode !== 'normal'
      || result.journey.stages?.some(stage => stage.network && stage.network.mode !== 'normal')));
}

export function createNormalNetworkVariant(source: ProjectRun): ProjectRun {
  const variant = structuredClone(source);
  const normalizeJourney = (journey: ProjectTesterResult['journey']) => {
    for (const stage of journey.stages ?? []) if (stage.network) stage.network = { mode: 'normal' };
  };
  for (const result of variant.results) {
    result.tester.context.network = { mode: 'normal' };
    result.run.context.network = { mode: 'normal' };
    normalizeJourney(result.journey);
    for (const stage of result.run.evidence?.stages ?? []) stage.network = { mode: 'normal' };
  }
  for (const tester of variant.discovery?.plan.testers ?? []) tester.context.network = { mode: 'normal' };
  for (const journey of variant.discovery?.plan.journeys ?? []) normalizeJourney(journey);
  return variant;
}

function actionIdentity(recorded: RecordedAction) {
  const route = (raw: string | undefined) => {
    if (raw === undefined || raw === 'blank') return raw;
    const url = new URL(raw, 'http://route.invalid');
    return url.pathname + url.search + url.hash;
  };
  return { action: recorded.action, url: route(recorded.url), urlBefore: route(recorded.urlBefore), focusBefore: recorded.focusBefore, routeVersion: recorded.routeVersion };
}

export function completeProjectReplayEvidence(original: ProjectTesterResult, result: ProjectTesterResult) {
  const before = original.run.evidence;
  const after = result.run.evidence;
  if (!before || !after || !same(original.run.context, result.run.context)
    || !same(before.actions.map(actionIdentity), after.actions.map(actionIdentity))) return false;
  const stages = original.journey.stages ?? [];
  if (!stages.length) return !before.stages?.length && !after.stages?.length;
  if (before.stages?.length !== stages.length || after.stages?.length !== stages.length) return false;
  let end = 0;
  let network = original.tester.context.network;
  for (let i = 0; i < stages.length; i++) {
    const planned = stages[i];
    network = planned.network ?? network;
    const recorded = before.stages[i];
    const replayed = after.stages[i];
    const entry = (recorded as typeof recorded & { entryActionEnd?: number }).entryActionEnd;
    if (recorded.id !== planned.id || recorded.transition !== planned.transition
      || recorded.pauseMs !== (planned.pauseMs ?? 0) || !same(recorded.network, network)
      || !recorded.completed || !replayed.completed || replayed.modelCalls !== 0
      || recorded.actionStart !== end || !Number.isInteger(recorded.actionEnd)
      || !Number.isInteger(entry) || entry! < end || entry! > recorded.actionEnd
      || recorded.actionEnd > before.actions.length
      || !same({ ...recorded, modelCalls: 0 }, replayed)) return false;
    end = recorded.actionEnd;
  }
  return end === before.actions.length;
}

/** Recompute the conclusion at the persistence boundary; worker claims are not evidence. */
export function validateProjectContextInvestigation(source: ProjectRun, investigation: ProjectContextInvestigation): ProjectContextInvestigation {
  let supported = false;
  const trials = Array.isArray(investigation?.trials) ? investigation.trials : [];
  try {
    const normal = createNormalNetworkVariant(source);
    supported = source.status === 'completed' && !source.error && hasNetworkInvestigation(source)
      && new Set(source.results.map(result => result.journey.id)).size === source.results.length
      && source.results.every(result => checkIds(result) && result.tester.id === result.journey.testerId
        && result.run.status === 'completed'
        && result.run.verdict === (result.checks.some(check => check.status === 'failed') ? 'failed' : 'passed'))
      && source.results.some(result => result.checks.every(check => check.status === 'passed'))
      && investigation.factor === 'network' && trials.length === 4
      && new Set(trials.map(trial => `${trial.condition}:${trial.repeat}`)).size === 4
      && trials.every(trial => {
        if (!['original', 'normal_network'].includes(trial.condition) || ![1, 2].includes(trial.repeat)) return false;
        const expected = trial.condition === 'original' ? source : normal;
        const checks = compareProjectReplayResults(expected, trial.results);
        return checks.every(({ before, after }) => ['passed', 'failed'].includes(before.status)
          && (trial.condition === 'original' ? before.status === after.status : after.status === 'passed'))
          && expected.results.every(original => completeProjectReplayEvidence(original, trial.results.find(result => result.journey.id === original.journey.id)!));
      });
  } catch { supported = false; }
  return {
    factor: 'network', outcome: supported ? 'likely_trigger' : 'unresolved',
    message: supported
      ? 'The same failures repeated twice under the original network and passed twice under normal network, with passing controls intact.'
      : 'The network comparison did not establish a repeatable trigger with complete compatible evidence.',
    trials,
  };
}
