import { isDeepStrictEqual } from 'node:util';
import { capabilities, compileInputs, type ContextPack } from '../../contracts/src/index';
import type { DifferentialResult, EvidenceRun, InvestigationFactor, InvestigationTrial, ReplayPlan } from '../../contracts/src/runtime';

type InvestigationInput = {
  id: string;
  target: EvidenceRun;
  control: EvidenceRun;
  replay: ReplayPlan;
  factors: InvestigationFactor[];
  maxAttempts: number;
  runTrial: (context: ContextPack, replay: ReplayPlan) => Promise<EvidenceRun>;
  onUpdate?: (result: DifferentialResult) => void;
};

function isFactor(value: unknown): value is InvestigationFactor {
  return capabilities.some(capability => capability.mode === 'enforced' && capability.factor === value);
}

function changedKeys<T extends object>(left: T, right: T): (keyof T)[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof T)[]);
  return [...keys].filter(key => !isDeepStrictEqual(left[key], right[key]));
}

function sameRunConditions(reference: EvidenceRun, run: EvidenceRun): boolean {
  const evidence = reference.evidence;
  return Boolean(evidence?.buildId && evidence.scenarioHash && evidence.policyVersion &&
    evidence.buildId === run.evidence?.buildId && evidence.scenarioHash === run.evidence.scenarioHash &&
    evidence.policyVersion === run.evidence.policyVersion && isDeepStrictEqual(reference.scenario, run.scenario));
}

// An empty signature is a verified pass. Undefined means the outcome cannot support a comparison.
function outcomeSignature(run: EvidenceRun): string[] | undefined {
  if (run.status !== 'completed' || run.findings.some(finding =>
    finding.kind === 'agent_error' || finding.kind === 'environment_failure' ||
    finding.kind === 'replay_mismatch' || finding.kind === 'inconclusive')) return;

  const statuses = new Map(run.assertions.map(assertion => [assertion.id, assertion.status]));
  const required = run.scenario.contract.assertions;
  if (!required.length || run.assertions.length !== required.length || required.some(assertion => {
    const status = statuses.get(assertion.id);
    return status !== 'passed' && status !== 'failed';
  })) return;

  const failed = required.filter(assertion => statuses.get(assertion.id) === 'failed').map(assertion => assertion.id);
  if (!failed.length && run.verdict === 'passed') return failed;
  if (failed.length && run.verdict === 'failed' && run.findings.some(finding =>
    finding.kind === 'functional_failure' || finding.kind === 'api_or_outcome_failure')) return failed;
}

export async function investigate(input: InvestigationInput): Promise<DifferentialResult> {
  const { target, control, replay, maxAttempts } = structuredClone({
    target: input.target, control: input.control, replay: input.replay, maxAttempts: input.maxAttempts,
  });
  const { runTrial, onUpdate } = input;
  const requested = Array.isArray(input.factors) ? [...input.factors] : [];
  const factors = [...new Set(requested.filter(isFactor))];
  const result: DifferentialResult = {
    id: input.id, targetRunId: target.id, controlRunId: control.id, replayHash: replay.hash,
    status: 'running', conclusion: 'inconclusive', isolationStatus: 'not_attempted', likelyTriggers: [],
    attemptsUsed: 0, maxAttempts, trials: [], untestedFactors: [...factors],
    message: 'Checking target and control replay outcomes.', createdAt: new Date().toISOString(),
  };
  const publish = () => onUpdate?.(structuredClone(result));
  function complete(message: string, inconclusive = false): DifferentialResult {
    if (inconclusive) {
      result.conclusion = 'inconclusive';
      result.likelyTriggers = [];
      if (result.isolationStatus === 'isolated') result.isolationStatus = 'unresolved';
    }
    result.status = 'completed';
    result.message = message;
    publish();
    return result;
  }

  const targetSignature = outcomeSignature(target);
  if (!targetSignature?.length || outcomeSignature(control)?.length !== 0 || !sameRunConditions(target, control)) {
    return complete('A verified failure and a verified pass for the same scenario, build, and policy are required.');
  }
  if (replay.version !== 1 || !replay.hash || replay.buildId !== target.evidence?.buildId ||
    replay.scenarioHash !== target.evidence?.scenarioHash) {
    return complete('The replay does not match the reference scenario and build.');
  }
  if (!Array.isArray(input.factors) || factors.length !== requested.length ||
    factors.some(factor => !target.scenario.investigation.factors.includes(factor))) {
    return complete('The comparison factors must be distinct, enforced, and allowed by the scenario.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 4 || maxAttempts > 12 ||
    maxAttempts > target.scenario.investigation.maxAttempts) {
    return complete('The replay budget is outside the allowed range.');
  }

  const changes = changedKeys(target.context, control.context);
  if (changes.some(key => key !== 'id' && key !== 'revision' && key !== 'label' &&
    (!isFactor(key) || !factors.includes(key)))) {
    return complete('The reference contexts differ outside the selected factors.');
  }
  const variedFactors = factors.filter(factor => changes.includes(factor));
  if (!variedFactors.length) return complete('The references must differ in at least one selected factor.');

  let bindingsMatch: boolean;
  try {
    bindingsMatch = [target, control].every(reference =>
      isDeepStrictEqual(compileInputs(target.scenario, reference.context), reference.inputs));
  } catch {
    return complete('The reference input bindings are invalid.');
  }
  if (!bindingsMatch) return complete('The reference input bindings do not match their contexts.');
  if (changes.includes('inputs')) {
    const bindings = changedKeys(target.context.inputs, control.context.inputs);
    if (bindings.length !== 1 || !Object.hasOwn(target.scenario.inputSlots, bindings[0])) {
      return complete('An inputs comparison must change exactly one declared binding.');
    }
    const binding=bindings[0];
    const usesBinding=replay.actions.some(({action})=>(action.tool==='fill'||action.tool==='select')&&'input' in action.value&&action.value.input===binding);
    const unsafe=replay.actions.some(({action})=>((action.tool==='fill'||action.tool==='select')&&'literal' in action.value)||(action.tool==='pressKey'&&!['Tab','Shift+Tab','Enter','Space','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Escape'].includes(action.key)));
    if(!usesBinding||unsafe)return complete('Input comparisons require proven symbolic bindings and no literal or key-entered substitute.');
  }

  const runIds = new Set([target.id, control.id]);
  const namespaces = new Set([target.namespaceId, control.namespaceId]);
  let trialError = '';

  async function repeat(role: InvestigationTrial['role'], context: ContextPack, factor?: InvestigationFactor) {
    const expectedInputs = compileInputs(target.scenario, context);
    const signatures: string[][] = [];
    for (let repeat = 1; repeat <= 2; repeat++) {
      result.attemptsUsed++;
      let run: EvidenceRun;
      try {
        run = structuredClone(await runTrial(structuredClone(context), structuredClone(replay)));
      } catch {
        trialError = 'A replay attempt did not return evidence.';
        return;
      }
      result.trials.push(factor ? { role, factor, repeat, run } : { role, repeat, run });
      const signature = outcomeSignature(run);
      if (runIds.has(run.id) || (run.namespaceId && namespaces.has(run.namespaceId)) ||
        run.executionMode !== 'deterministic' || !sameRunConditions(target, run) ||
        run.evidence?.replayCompatible !== true || run.evidence.replayHash !== replay.hash ||
        !isDeepStrictEqual(run.context, context) || !isDeepStrictEqual(run.inputs, expectedInputs)) {
        trialError = 'A trial did not match the requested fresh replay conditions.';
        return;
      }
      if (variedFactors.some(key => !run.capabilities.some(item => item.factor === key && item.status === 'applied'))) {
        trialError = 'A trial did not exercise all changed capabilities.';
        return;
      }
      if (!signature || (role === 'target' && !isDeepStrictEqual(signature, targetSignature)) ||
        (role === 'control' && signature.length !== 0)) {
        trialError = 'A trial did not corroborate the required outcome.';
        return;
      }
      runIds.add(run.id);
      if (run.namespaceId) namespaces.add(run.namespaceId);
      signatures.push(signature);
      publish();
    }
    return signatures;
  }

  publish();
  if (!await repeat('target', target.context) || !await repeat('control', control.context)) {
    return complete(trialError, true);
  }
  result.conclusion = 'reproducible_failure';
  result.message = 'The target failure and passing control both reproduced.';
  for (const factor of variedFactors) {
    if (result.attemptsUsed + 2 > maxAttempts) break;
    if (result.isolationStatus === 'not_attempted') result.isolationStatus = 'unresolved';
    const candidate = { ...target.context, [factor]: control.context[factor] };
    const signatures = await repeat('candidate', candidate, factor);
    if (!signatures) return complete(trialError, true);
    result.untestedFactors = result.untestedFactors.filter(key => key !== factor);
    if (signatures.every(signature => signature.length === 0)) {
      result.likelyTriggers.push(factor);
      result.isolationStatus = 'isolated';
    }
  }

  if (result.isolationStatus === 'isolated') return complete('A single-factor substitution passed in both trials for each listed trigger.');
  if (result.isolationStatus === 'unresolved') return complete('The failure reproduced without a repeatable single-factor resolution.');
  return complete('The failure reproduced and no candidate comparisons were attempted.');
}
