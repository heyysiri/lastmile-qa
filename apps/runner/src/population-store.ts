import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ApplicationContext, ContinuityEvidence, EnrollPopulationRequest, LaunchPopulationRequest, MemoryObservation,
  Population, PopulationDetail, PopulationExecution, PopulationExecutionDetail, ReleaseComparison,
} from '@lastmile/contracts/populations';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import { compileStudyUser, type Study, type StudyApplication, type StudyUser } from '@lastmile/contracts/studies';
import { hashValue } from './artifacts';
import { buildReplay, hashReplayPlan } from './replay';
import { RunnerError } from './store';

type Manifest = Pick<EvidenceRun, 'scenario' | 'context' | 'inputs' | 'executionMode' | 'replay'> & {
  continuity: ContinuityEvidence;
};
type RunAccess = {
  enqueue: (requestId: string, requestJson: string, manifest: Manifest & { sellerDemoUrl: string; expectedBuildId: string }) => EvidenceRun;
  get: (id: string) => EvidenceRun | undefined;
  save: (run: EvidenceRun) => EvidenceRun;
  hasRunning: () => boolean;
};
type JsonRow = { data: string };
type RequestRow = JsonRow & { payload_hash: string };
type EpisodeRow = JsonRow & { execution_id: string; tester_id: string; release_label: string };
const timestamp = () => new Date().toISOString();
const decode = <T>(row: JsonRow): T => JSON.parse(row.data);
const notFound = () => new RunnerError(404, 'not_found', 'Population does not exist');
const activeConflict = () => new RunnerError(409, 'population_active', 'Population already has an active execution');
const invalidBaseline = () => new RunnerError(409, 'invalid_baseline', 'Choose a completed continuing execution with passing, replayable evidence and a starting checkpoint for every tester');

function matchingRequest<T>(row: RequestRow | undefined, request: EnrollPopulationRequest | LaunchPopulationRequest): T | undefined {
  if (!row) return;
  if (row.payload_hash !== hashValue(request)) {
    throw new RunnerError(409, 'request_conflict', 'Request ID already has a different payload');
  }
  return decode<T>(row);
}

function assertionsComplete(run: EvidenceRun) {
  const { assertions } = run.scenario.contract;
  const evaluated = new Set(run.assertions.filter(result => result.status === 'passed' || result.status === 'failed').map(result => result.id));
  return run.assertions.length === assertions.length && assertions.every(({ id }) => evaluated.has(id));
}

function compareRelease(run: EvidenceRun, buildId: string): ReleaseComparison {
  const continuity = run.continuity!;
  const result = { testerId: continuity.testerId, baselineRunId: continuity.baselineRunId! };
  const inconclusive = (message: string): ReleaseComparison => ({ ...result, outcome: 'inconclusive', message });
  if (run.status === 'interrupted') return inconclusive('Candidate replay was interrupted');
  if (run.status !== 'completed') return inconclusive('Candidate replay has not completed');
  const { replay, evidence } = run;
  if (!replay || !evidence || evidence.replayCompatible !== true || evidence.replayHash !== replay.hash ||
      evidence.buildId !== buildId || evidence.scenarioHash !== replay.scenarioHash ||
      hashValue(run.scenario) !== replay.scenarioHash || evidence.modelCalls !== 0) {
    return inconclusive('Candidate replay did not establish compatibility with the frozen actions, build and scenario');
  }
  if (!assertionsComplete(run)) return inconclusive('Candidate replay did not evaluate every frozen assertion');
  const failed = run.assertions.filter(assertion => assertion.status === 'failed');
  if (run.verdict === 'failed' && failed.length) {
    return {
      ...result, outcome: 'regression',
      message: failed.map(assertion => {
        const rule=run.scenario.contract.assertions.find(item=>item.id===assertion.id);
        const label=rule&&'path' in rule?`${rule.path} (${assertion.id})`:assertion.id;
        return `${label}: baseline passed; candidate expected ${JSON.stringify(assertion.expected)??'configured outcome'}, observed ${JSON.stringify(assertion.actual)??'unavailable'}.`;
      }).join(' '),
    };
  }
  if (run.verdict === 'passed' && !failed.length) {
    return { ...result, outcome: 'still_passing', message: 'All baseline assertions passed on the candidate' };
  }
  return inconclusive('Candidate replay did not produce a verifiable verdict');
}

function continuingMembers(
  population: Population, request: Extract<LaunchPopulationRequest, { mode: 'continue' }>,
  application: StudyApplication, executionMode: EvidenceRun['executionMode'],
  validateStudyUser?: (application: StudyApplication, user: StudyUser) => void,
): Manifest[] {
  const tasks = new Map(request.tasks.map(task => [task.testerId, task]));
  if (request.tasks.length !== population.testers.length || tasks.size !== population.testers.length ||
      population.testers.some(tester => !tasks.has(tester.id))) {
    throw new RunnerError(400, 'invalid_tasks', 'Include one task for each enrolled tester');
  }
  try {
    return population.testers.map(tester => {
      const task = tasks.get(tester.id)!;
      const workflow = application.workflows.find(item => item.id === task.workflowId);
      if (!workflow || Object.keys(task.inputs).some(key => !Object.hasOwn(workflow.scenario.inputSlots, key))) {
        throw new Error('Unsupported workflow or input slot');
      }
      const user: StudyUser = {
        ...tester.profile, workflowId: task.workflowId, goal: task.goal,
        context: { ...tester.profile.context, inputs: task.inputs },
      };
      const compiled = compileStudyUser(user, application);
      validateStudyUser?.(application, user);
      return {
        ...compiled, executionMode,
        continuity: {
          populationId: population.id, testerId: tester.id, mode: 'continue', initialStateId: tester.initialStateId,
          workflowId: workflow.id, preserveStatePaths: [...(workflow.preserveStatePaths ?? [])], history: [],
        },
      };
    });
  } catch {
    throw new RunnerError(400, 'invalid_tasks', 'Tester workflows and inputs must match the connected application');
  }
}

export function createPopulationStore(
  db: Database.Database, runs: RunAccess, requireStudy: (id: string, revision: number) => Study,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS populations (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS population_executions (
      id TEXT PRIMARY KEY, population_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      status TEXT NOT NULL, mode TEXT NOT NULL, release_label TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE (population_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS population_active_execution ON population_executions (population_id)
      WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS population_execution_status ON population_executions (status);
    CREATE TABLE IF NOT EXISTS population_runs (
      run_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, tester_id TEXT NOT NULL,
      UNIQUE (execution_id, tester_id)
    );
  `);

  const insertPopulation = db.prepare('INSERT INTO populations (id, request_id, payload_hash, data) VALUES (?, ?, ?, ?)');
  const findPopulation = db.prepare<[string], JsonRow>('SELECT data FROM populations WHERE id = ?');
  const findEnrollment = db.prepare<[string], RequestRow>('SELECT data, payload_hash FROM populations WHERE request_id = ?');
  const listPopulations = db.prepare<[], JsonRow>('SELECT data FROM populations ORDER BY rowid DESC');

  const insertExecution = db.prepare(`
    INSERT INTO population_executions (id, population_id, request_id, payload_hash, status, mode, release_label, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writeExecution = db.prepare('UPDATE population_executions SET status = ?, data = ? WHERE id = ?');
  const findExecution = db.prepare<[string], JsonRow>('SELECT data FROM population_executions WHERE id = ?');
  const findLaunch = db.prepare<[string, string], RequestRow>(
    'SELECT data, payload_hash FROM population_executions WHERE population_id = ? AND request_id = ?',
  );
  const listExecutions = db.prepare<[], JsonRow>('SELECT data FROM population_executions ORDER BY rowid DESC');
  const findActive = db.prepare<[string]>(
    "SELECT id FROM population_executions WHERE population_id = ? AND status IN ('queued', 'running')",
  );
  const findRunning = db.prepare<[], JsonRow>("SELECT data FROM population_executions WHERE status = 'running'");
  const nextQueued = db.prepare<[], JsonRow>("SELECT data FROM population_executions WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const trackMember = db.prepare('INSERT INTO population_runs (run_id, execution_id, tester_id) VALUES (?, ?, ?)');
  const episodeQuery = `
    SELECT runs.data, member.execution_id, member.tester_id, execution.release_label
    FROM population_executions execution
    JOIN population_runs member ON member.execution_id = execution.id
    JOIN runs ON runs.id = member.run_id
    WHERE execution.population_id = ?
  `;
  const listEpisodes = db.prepare<[string], EpisodeRow>(`${episodeQuery} ORDER BY execution.rowid DESC, member.rowid`);
  const testerEpisodes = db.prepare<[string, string], EpisodeRow>(`${episodeQuery}
    AND member.tester_id = ? AND execution.mode = 'continue' AND execution.status IN ('completed', 'interrupted')
    ORDER BY execution.rowid DESC
  `);

  function requirePopulation(id: string) {
    const row = findPopulation.get(id);
    if (!row) throw notFound();
    return decode<Population>(row);
  }

  function ensureIdle(id: string) {
    if (findActive.get(id)) throw activeConflict();
  }

  function getLaunch(id: string, request: LaunchPopulationRequest) {
    return matchingRequest<PopulationExecution>(findLaunch.get(id, request.requestId), request);
  }

  function saveExecution(execution: PopulationExecution) {
    writeExecution.run(execution.status, JSON.stringify(execution), execution.id);
    return execution;
  }

  function memberRuns(execution: PopulationExecution) {
    return execution.members.map(({ runId }) => {
      const run = runs.get(runId);
      if (!run) throw new Error('Population execution member does not exist');
      return run;
    });
  }

  function history(populationId: string, testerId: string) {
    const observations: MemoryObservation[] = [];
    for (const row of testerEpisodes.iterate(populationId, testerId)) {
      const run = decode<EvidenceRun>(row);
      const step = [...run.steps].reverse().find(step => step.observation.trim());
      const buildId = run.evidence?.buildId;
      if (!step || !buildId) continue;
      observations.push({
        runId: run.id, buildId, goal: run.scenario.goal, observation: step.observation.trim().slice(0, 1600), recordedAt: step.timestamp,
      });
      if (observations.length === 3) break;
    }
    return observations;
  }

  function checkpointMembers(population: Population, baselineId: string): Manifest[] {
    const row = findExecution.get(baselineId);
    if (!row) throw invalidBaseline();
    const baseline = decode<PopulationExecution>(row);
    if (baseline.populationId !== population.id || baseline.status !== 'completed' || baseline.mode !== 'continue') {
      throw invalidBaseline();
    }
    return memberRuns(baseline).map((run, index) => {
      const continuity = run.continuity;
      if (run.executionMode !== 'ai_guided' || continuity?.mode !== 'continue' ||
          continuity.populationId !== population.id || continuity.testerId !== baseline.members[index].testerId ||
          !continuity.startCheckpoint?.id || !continuity.startCheckpoint.digest ||
          run.evidence?.buildId !== baseline.buildId || run.evidence.scenarioHash !== hashValue(run.scenario) ||
          !assertionsComplete(run)) throw invalidBaseline();
      let replay;
      try { replay = buildReplay(run); } catch { throw invalidBaseline(); }
      return {
        scenario: run.scenario, context: run.context, inputs: run.inputs, executionMode: 'deterministic', replay,
        continuity: { ...continuity, mode: 'checkpoint', baselineRunId: run.id, sourceReplayHash: replay.hash },
      };
    });
  }

  function prepareLaunch(
    population: Population, request: LaunchPopulationRequest, application: StudyApplication,
    executionMode: EvidenceRun['executionMode'], validateStudyUser?: (application: StudyApplication, user: StudyUser) => void,
  ) {
    ensureIdle(population.id);
    const manifests = request.mode === 'continue'
      ? continuingMembers(population, request, application, executionMode, validateStudyUser)
      : checkpointMembers(population, request.baselineExecutionId);

    return db.transaction((buildId: string, applicationContext?: ApplicationContext) => {
      const previous = getLaunch(population.id, request);
      if (previous) return previous;
      ensureIdle(population.id);
      const id = randomUUID();
      const members = manifests.map(({ replay, continuity, ...configuration }) => {
        const testerId = continuity.testerId;
        const rebound = replay && { ...replay, buildId };
        const run = runs.enqueue(`population-${randomUUID()}`, JSON.stringify({ populationExecutionId: id, testerId }), {
          ...configuration, sellerDemoUrl: population.origin, expectedBuildId: buildId,
          continuity: continuity.mode === 'continue' ? { ...continuity, history: history(population.id, testerId) } : continuity,
          replay: rebound && { ...rebound, hash: hashReplayPlan(rebound) },
        });
        trackMember.run(run.id, id, testerId);
        return { testerId, runId: run.id };
      });
      const execution: PopulationExecution = {
        id, populationId: population.id, population, requestId: request.requestId,
        status: 'queued', mode: request.mode, releaseLabel: request.releaseLabel, buildId, applicationContext,
        createdAt: timestamp(), members,
        ...(request.mode === 'checkpoint' && { baselineExecutionId: request.baselineExecutionId }),
      };
      insertExecution.run(id, population.id, request.requestId, hashValue(request), execution.status, request.mode, request.releaseLabel, JSON.stringify(execution));
      return execution;
    }).immediate;
  }

  return {
    enroll: db.transaction((request: EnrollPopulationRequest, requireApplication: (id: string) => StudyApplication) => {
      const previous = matchingRequest<Population>(findEnrollment.get(request.requestId), request);
      if (previous) return previous;
      const study = requireStudy(request.studyId, request.revision);
      const application = requireApplication(study.brief.applicationId);
      const testers = study.users.map(profile => {
        const workflow = application.workflows.find(item => item.id === profile.workflowId);
        if (!workflow) throw new RunnerError(400, 'invalid_study', 'Tester workflows must match the connected application');
        return { id: randomUUID(), profile, initialStateId: workflow.scenario.initialStateId };
      });
      const population: Population = {
        id: randomUUID(), label: request.label, applicationId: application.id, origin: new URL(application.origin).origin,
        studyId: study.id, studyRevision: study.revision, createdAt: timestamp(), testers,
      };
      insertPopulation.run(population.id, request.requestId, hashValue(request), JSON.stringify(population));
      return population;
    }).immediate,
    requirePopulation,
    listPopulations: () => listPopulations.all().map(decode<Population>),
    getPopulationDetail(id: string): PopulationDetail {
      const population = requirePopulation(id);
      return {
        ...population,
        episodes: listEpisodes.all(id).map(row => ({
          testerId: row.tester_id, executionId: row.execution_id, releaseLabel: row.release_label, run: decode<EvidenceRun>(row),
        })),
      };
    },
    getLaunch,
    prepareLaunch,
    listExecutions: () => listExecutions.all().map(decode<PopulationExecution>),
    getExecutionDetail(id: string): PopulationExecutionDetail | undefined {
      const row = findExecution.get(id);
      if (!row) return;
      const execution = decode<PopulationExecution>(row);
      const runs = memberRuns(execution);
      return {
        ...execution, runs,
        ...(execution.mode === 'checkpoint' && execution.finishedAt && {
          comparisons: runs.map(run => compareRelease(run, execution.buildId)),
        }),
      };
    },
    claimNext: db.transaction(() => {
      if (runs.hasRunning() || findRunning.get()) return;
      const row = nextQueued.get();
      if (!row) return;
      const execution = saveExecution({ ...decode<PopulationExecution>(row), status: 'running' });
      const startedAt = timestamp();
      const claimed = memberRuns(execution).map(run => runs.save({ ...run, status: 'running', startedAt }));
      return { execution, runs: claimed };
    }).immediate,
    finishExecution: (execution: PopulationExecution) => saveExecution({ ...execution, status: 'completed', finishedAt: timestamp() }),
    recoverInterrupted() {
      const finishedAt = timestamp();
      for (const row of findRunning.all()) {
        saveExecution({ ...decode<PopulationExecution>(row), status: 'interrupted', finishedAt });
      }
    },
  };
}
