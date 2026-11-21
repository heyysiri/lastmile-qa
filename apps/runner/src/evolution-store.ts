import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { compileInputs, OutcomeContractSchema } from '@lastmile/contracts';
import {
  JourneySuggestionSchema, PatchProposalSchema, type GenerateSuggestions, type PrepareRepairRequest, type RepairJob,
  type RepairRuntime, type RepairSnapshot, type RepairTrial, type RepairVerification, type SuggestionJob,
  type SuggestionSnapshot, type SuggestJourneysRequest, type VerifyRepairRequest,
} from '@lastmile/contracts/evolution';
import type { PopulationExecutionDetail } from '@lastmile/contracts/populations';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import { compileStudyUser, type StudyApplication, type StudyUser } from '@lastmile/contracts/studies';
import { hashValue } from './artifacts';
import { buildReplay, hashReplayPlan } from './replay';
import { RunnerError } from './store';

type Job = SuggestionJob | RepairJob;
type Kind = 'suggestion' | 'repair';
type Work = { kind: 'suggestion'; job: SuggestionJob } | { kind: 'repair'; job: RepairJob };
type Row = { kind: Kind; data: string };
type Dependencies = { getExecutionDetail: (id: string) => PopulationExecutionDetail | undefined };
type Executors = {
  generateSuggestions?: GenerateSuggestions;
  repairRuntime?: RepairRuntime;
  validateStudyUser?: (application: StudyApplication, user: StudyUser) => void;
};
const now = () => new Date().toISOString();
const same = (left: unknown, right: unknown) => hashValue(left ?? null) === hashValue(right ?? null);
const requestConflict = () => new RunnerError(409, 'request_conflict', 'Request ID already has a different payload');
const invalidSource = () => new RunnerError(409, 'invalid_repair_source', 'Choose a completed checkpoint comparison with a regression, a passing control and complete saved evidence');

function matchingRequest<T extends Job>(row: Row | undefined, request: T['request']): T | undefined {
  if (!row) return;
  const job: T = JSON.parse(row.data);
  if (!same(job.request, request)) throw requestConflict();
  return job;
}

function completedChecks(run: EvidenceRun, frozen: EvidenceRun) {
  const ids = new Set(frozen.scenario.contract.assertions.map(check => check.id));
  if (!ids.size || run.assertions.length !== ids.size) return false;
  return run.assertions.every(check => ids.delete(check.id) && ['passed', 'failed'].includes(check.status));
}

function hasVerdict(run: EvidenceRun, frozen: EvidenceRun, verdict: 'passed' | 'failed') {
  return run.status === 'completed' && run.verdict === verdict && completedChecks(run, frozen) &&
    run.assertions.some(check => check.status === 'failed') === (verdict === 'failed');
}

function replayMatches(run: EvidenceRun, frozen: EvidenceRun, buildId: string) {
  const { replay, evidence } = run;
  if (!replay || !frozen.replay || !evidence || !buildId.trim()) return false;
  const rebound = { ...frozen.replay, buildId };
  return run.executionMode === 'deterministic' && run.expectedBuildId === buildId &&
    evidence.buildId === buildId && evidence.scenarioHash === frozen.replay.scenarioHash &&
    evidence.replayCompatible === true && evidence.replayHash === replay.hash && evidence.modelCalls === 0 &&
    !run.findings.some(({ kind }) => kind === 'environment_failure' || kind === 'replay_mismatch' || kind === 'agent_error') &&
    same(replay, { ...rebound, hash: hashReplayPlan(rebound) }) &&
    same(evidence.actions.map(action => action.action), replay.actions.map(action => action.action)) &&
    same(run.scenario, frozen.scenario) && same(run.inputs, frozen.inputs) &&
    same(run.context, frozen.context) && same(run.continuity, frozen.continuity);
}

function exactTesters<T extends { testerId: string }>(members: T[], expected: Set<string>) {
  const byTester = new Map(members.map(member => [member.testerId, member]));
  if (members.length !== expected.size || byTester.size !== expected.size ||
      [...expected].some(id => !byTester.has(id))) throw invalidSource();
  return byTester;
}

function validateSource(execution: PopulationExecutionDetail, baseline: PopulationExecutionDetail | undefined) {
  if (execution.status !== 'completed' || execution.mode !== 'checkpoint' || !execution.finishedAt ||
      !execution.applicationContext || execution.applicationContext.applicationId !== execution.population.applicationId ||
      execution.populationId !== execution.population.id ||
      !baseline || baseline.status !== 'completed' || baseline.mode !== 'continue' ||
      baseline.populationId !== execution.populationId || !execution.comparisons) throw invalidSource();

  const expected = new Set(execution.population.testers.map(tester => tester.id));
  const comparisons = exactTesters(execution.comparisons, expected);
  const baselineMembers = exactTesters(baseline.members, expected);
  const members = exactTesters(execution.members, expected);
  const sources = new Map(baseline.runs.map(run => [run.id, run]));
  const candidates = new Map(execution.runs.map(run => [run.id, run]));
  if (sources.size !== expected.size || candidates.size !== expected.size ||
      !execution.comparisons.some(item => item.outcome === 'regression') ||
      !execution.comparisons.some(item => item.outcome === 'still_passing')) throw invalidSource();

  for (const [testerId, comparison] of comparisons) {
    const source = sources.get(baselineMembers.get(testerId)!.runId);
    const candidate = candidates.get(members.get(testerId)!.runId);
    if (!source || !candidate || comparison.outcome === 'inconclusive' ||
        comparison.baselineRunId !== source.id || source.continuity?.testerId !== testerId ||
        source.continuity.populationId !== execution.populationId || source.continuity.mode !== 'continue' ||
        !source.continuity.startCheckpoint?.id || !source.continuity.startCheckpoint.digest ||
        source.executionMode !== 'ai_guided' || source.expectedBuildId !== baseline.buildId ||
        source.evidence?.buildId !== baseline.buildId || source.evidence.scenarioHash !== hashValue(source.scenario) ||
        !hasVerdict(source, source, 'passed')) throw invalidSource();
    const replay = buildReplay(source);
    const frozen: EvidenceRun = {
      ...source, replay, continuity: { ...source.continuity, mode: 'checkpoint', baselineRunId: source.id, sourceReplayHash: replay.hash },
    };
    OutcomeContractSchema.parse(source.scenario.contract);
    if (!same(source.inputs, compileInputs(source.scenario, source.context)) ||
        !replayMatches(candidate, frozen, execution.buildId) ||
        !hasVerdict(candidate, frozen, comparison.outcome === 'regression' ? 'failed' : 'passed')) throw invalidSource();
  }
}

function validateSuggestions(snapshot: SuggestionSnapshot, result: unknown, validateUser?: Executors['validateStudyUser']) {
  const suggestions = JourneySuggestionSchema.array().parse(result);
  const testers = new Map(snapshot.population.testers.map(tester => [tester.id, tester]));
  const paths = new Set(snapshot.context.sources.map(source => source.path));
  for (const { task, sourcePaths, historyRunIds } of suggestions) {
    const tester = testers.get(task.testerId);
    const workflow = snapshot.application.workflows.find(item => item.id === task.workflowId);
    const history = new Set(snapshot.population.episodes.filter(episode => episode.testerId === task.testerId).map(episode => episode.run.id));
    if (!tester || !workflow || sourcePaths.some(path => !paths.has(path)) || historyRunIds.some(id => !history.has(id)) ||
        Object.keys(task.inputs).some(key => !Object.hasOwn(workflow.scenario.inputSlots, key))) throw new Error('Invalid suggestion');
    const user: StudyUser = {
      ...tester.profile, workflowId: task.workflowId, goal: task.goal, context: { ...tester.profile.context, inputs: task.inputs },
    };
    compileStudyUser(user, snapshot.application);
    validateUser?.(structuredClone(snapshot.application), structuredClone(user));
    testers.delete(task.testerId);
  }
  if (testers.size) throw new Error('Missing tester suggestion');
  return suggestions;
}

function classifyTrials(job: RepairJob, trials: RepairTrial[], stage: RepairJob['stage']) {
  const { execution } = job.snapshot;
  const runs = new Map(execution.runs.map(run => [run.continuity?.testerId, run]));
  const comparisons = new Map(execution.comparisons!.map(comparison => [comparison.testerId, comparison]));
  const trialBuild = trials[0]?.run.evidence?.buildId;
  const trialIds = new Set(trials.map(trial => trial.run.id));
  if (!trialBuild || trials.length !== comparisons.size || trialIds.size !== trials.length ||
      execution.runs.some(run => trialIds.has(run.id))) return 'inconclusive';
  let failures = 0;
  for (const { testerId, role, outcome, run } of trials) {
    const frozen = runs.get(testerId);
    const comparison = comparisons.get(testerId);
    if (!frozen || !comparison || role !== (comparison.outcome === 'regression' ? 'regression' : 'control') ||
        (outcome !== 'passed' && outcome !== 'failed') || !hasVerdict(run, frozen, outcome) ||
        !replayMatches(run, frozen, trialBuild)) return 'inconclusive';
    if (stage === 'prepare' && (!same(failureSignature(run), failureSignature(frozen)) || outcome !== frozen.verdict)) return 'inconclusive';
    if (outcome === 'failed') failures++;
    comparisons.delete(testerId);
  }
  if (stage === 'prepare') return 'matched';
  return failures ? 'rejected' : 'verified';
}

function failureSignature(run: EvidenceRun) {
  return run.assertions.filter(check => check.status === 'failed')
    .map(({ id, expected, actual }) => ({ id, expected, actual })).sort((left, right) => left.id.localeCompare(right.id));
}

function validatePatch(snapshot: RepairSnapshot, value: unknown) {
  const parsed = PatchProposalSchema.safeParse(value);
  if (!parsed.success) return;
  const { summary, changes, hash } = parsed.data;
  if (hash !== hashValue({ summary, changes })) return;
  const sourceDigests = new Map(snapshot.context.sources.filter(source => source.kind === 'code').map(source => [source.path, source.digest]));
  if (changes.some(({ path, before, beforeHash, after }) => before === after || sourceDigests.get(path) !== hashValue(before) ||
      createHash('sha256').update(before).digest('hex') !== beforeHash)) return;
  return parsed.data;
}

export function createEvolutionStore(db: Database.Database, dependencies: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, population_id TEXT NOT NULL, request_id TEXT NOT NULL,
      status TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS evolution_suggestion_request ON evolution_jobs (population_id, request_id)
      WHERE kind = 'suggestion';
    CREATE UNIQUE INDEX IF NOT EXISTS evolution_repair_request ON evolution_jobs (request_id)
      WHERE kind = 'repair';
    CREATE UNIQUE INDEX IF NOT EXISTS evolution_active_repair ON evolution_jobs (population_id)
      WHERE kind = 'repair' AND status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS evolution_status ON evolution_jobs (status);
  `);
  const insert = db.prepare('INSERT INTO evolution_jobs (id, kind, population_id, request_id, status, data) VALUES (?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE evolution_jobs SET status = ?, data = ? WHERE id = ?');
  const find = db.prepare<[Kind, string], Row>('SELECT kind, data FROM evolution_jobs WHERE kind = ? AND id = ?');
  const list = db.prepare<[Kind], Row>('SELECT kind, data FROM evolution_jobs WHERE kind = ? ORDER BY rowid DESC');
  const listPopulation = db.prepare<[Kind, string], Row>('SELECT kind, data FROM evolution_jobs WHERE kind = ? AND population_id = ? ORDER BY rowid DESC');
  const suggestionRequest = db.prepare<[string, string], Row>("SELECT kind, data FROM evolution_jobs WHERE kind = 'suggestion' AND population_id = ? AND request_id = ?");
  const repairRequest = db.prepare<[string], Row>("SELECT kind, data FROM evolution_jobs WHERE kind = 'repair' AND request_id = ?");
  const activeRepair = db.prepare<[string]>("SELECT 1 FROM evolution_jobs WHERE kind = 'repair' AND population_id = ? AND status IN ('queued', 'running')");
  const activePopulation = db.prepare<[string]>("SELECT 1 FROM population_executions WHERE population_id = ? AND status IN ('queued', 'running')");
  const running = db.prepare<[], Row>("SELECT kind, data FROM evolution_jobs WHERE status = 'running'");
  const next = db.prepare<[], Row>("SELECT kind, data FROM evolution_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1");

  function add<T extends Job>(kind: Kind, job: T) {
    insert.run(job.id, kind, job.populationId, job.request.requestId, job.status, JSON.stringify(job));
    return job;
  }

  function save<T extends Job>(job: T) {
    update.run(job.status, JSON.stringify(job), job.id);
    return job;
  }

  function get<T extends Job>(kind: Kind, id: string): T | undefined {
    const row = find.get(kind, id);
    return row && JSON.parse(row.data);
  }

  function findSuggestionRequest(populationId: string, request: SuggestJourneysRequest) {
    return matchingRequest<SuggestionJob>(suggestionRequest.get(populationId, request.requestId), request);
  }

  function findRepairRequest(request: PrepareRepairRequest) {
    return matchingRequest<RepairJob>(repairRequest.get(request.requestId), request);
  }

  function ensureNoActiveRepair(populationId: string) {
    if (activeRepair.get(populationId)) throw new RunnerError(409, 'repair_active', 'Population already has an active repair');
  }

  function ensureRepairIdle(populationId: string) {
    ensureNoActiveRepair(populationId);
    if (activePopulation.get(populationId)) throw new RunnerError(409, 'population_active', 'Population already has an active execution');
  }

  function requireRepairSource(id: string) {
    let execution: PopulationExecutionDetail | undefined;
    try {
      execution = dependencies.getExecutionDetail(id);
      if (execution) {
        const baseline = execution.baselineExecutionId ? dependencies.getExecutionDetail(execution.baselineExecutionId) : undefined;
        validateSource(execution, baseline);
      }
    } catch {
      throw invalidSource();
    }
    if (!execution) throw new RunnerError(404, 'not_found', 'Population execution does not exist');
    return execution;
  }

  async function execute(work: Work, executors: Executors) {
    if (work.kind === 'suggestion') {
      const { job } = work;
      try {
        const result = await executors.generateSuggestions?.(structuredClone(job.snapshot));
        const suggestions = validateSuggestions(job.snapshot, result, executors.validateStudyUser);
        save({ ...job, status: 'completed', finishedAt: now(), suggestions });
      } catch {
        save({ ...job, status: 'completed', finishedAt: now(), error: 'Journey suggestions could not be generated or validated' });
      }
      return;
    }
    const repair = work.job;
    try {
      if (!executors.repairRuntime) throw new Error('Repair runtime is unavailable');
      if (repair.stage === 'prepare') {
        const result = await executors.repairRuntime.prepare(structuredClone(repair));
        const { reproduction } = result;
        const patch = validatePatch(repair.snapshot, result.patch);
        if (result.error || !patch || !result.sourceVersion?.trim() ||
            classifyTrials(repair, reproduction, 'prepare') !== 'matched') {
          save({ ...repair, status: 'completed', finishedAt: now(), reproduction, error: 'Repair did not produce a reviewable patch' });
          return;
        }
        save({ ...repair, status: 'awaiting_review', finishedAt: now(), reproduction, patch, sourceVersion: result.sourceVersion });
        return;
      }
      const result = await executors.repairRuntime.verify(structuredClone(repair));
      const outcome = classifyTrials(repair, result.trials, 'verify');
      const verifiedOutcome = outcome === 'matched' || outcome !== result.outcome ? 'inconclusive' : outcome;
      const messages = {
        verified: 'The reviewed patch passed all frozen regression and control checks',
        rejected: 'The reviewed patch failed one or more frozen checks',
        inconclusive: 'Verification could not establish a complete, compatible replay of all frozen checks',
      };
      const verification: RepairVerification = { outcome: verifiedOutcome, trials: result.trials, message: messages[verifiedOutcome] };
      save({ ...repair, status: 'completed', finishedAt: now(), verification });
    } catch {
      const error = 'Repair execution could not be completed';
      const verification: RepairVerification | undefined = repair.stage === 'verify'
        ? { outcome: 'inconclusive', trials: [], message: error }
        : undefined;
      save({ ...repair, status: 'completed', finishedAt: now(), error, verification });
    }
  }

  return {
    getSuggestion: (id: string) => get<SuggestionJob>('suggestion', id),
    getRepair: (id: string) => get<RepairJob>('repair', id),
    listSuggestions: (populationId: string) => listPopulation.all('suggestion', populationId).map(row => JSON.parse(row.data) as SuggestionJob),
    listRepairs: (populationId?: string) => (populationId === undefined ? list.all('repair') : listPopulation.all('repair', populationId))
      .map(row => JSON.parse(row.data) as RepairJob),
    findSuggestionRequest, findRepairRequest, requireRepairSource, ensureNoActiveRepair, ensureRepairIdle,
    enqueueSuggestion: db.transaction((populationId: string, request: SuggestJourneysRequest, snapshot: SuggestionSnapshot) =>
      findSuggestionRequest(populationId, request) ??
        add<SuggestionJob>('suggestion', { id: randomUUID(), populationId, request, snapshot, status: 'queued', createdAt: now() }),
    ).immediate,
    enqueueRepair: db.transaction((request: PrepareRepairRequest, snapshot: RepairSnapshot) => {
      const previous = findRepairRequest(request);
      if (previous) return previous;
      const { populationId } = snapshot.execution;
      ensureRepairIdle(populationId);
      return add<RepairJob>('repair', {
        id: randomUUID(), populationId, request, snapshot, status: 'queued', stage: 'prepare', createdAt: now(),
      });
    }).immediate,
    enqueueVerification: db.transaction((id: string, request: VerifyRepairRequest, ensureReady: (job: RepairJob) => void) => {
      const repair = get<RepairJob>('repair', id);
      if (!repair) throw new RunnerError(404, 'not_found', 'Repair does not exist');
      if (repair.verificationRequest?.requestId === request.requestId) {
        if (!same(repair.verificationRequest, request)) throw requestConflict();
        return repair;
      }
      if (repair.status !== 'awaiting_review' || repair.stage !== 'prepare' || repair.patch?.hash !== request.patchHash) {
        throw new RunnerError(409, 'invalid_verification', 'Verification requires an awaiting-review repair and its exact patch hash');
      }
      ensureReady(repair);
      ensureRepairIdle(repair.populationId);
      return save({ ...repair, status: 'queued', stage: 'verify', finishedAt: undefined, verificationRequest: request });
    }).immediate,
    claimNext: db.transaction((): Work | undefined => {
      if (running.get()) return;
      const row = next.get();
      if (!row) return;
      if (row.kind === 'suggestion') return { kind: 'suggestion', job: save({ ...JSON.parse(row.data) as SuggestionJob, status: 'running' }) };
      return { kind: 'repair', job: save({ ...JSON.parse(row.data) as RepairJob, status: 'running' }) };
    }).immediate,
    recoverInterrupted() {
      for (const row of running.all()) {
        save({ ...JSON.parse(row.data) as Job, status: 'interrupted', finishedAt: now(), error: 'Runner restarted during execution' });
      }
    },
    execute,
  };
}
