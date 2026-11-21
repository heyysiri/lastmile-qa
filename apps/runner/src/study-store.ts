import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RunRecord } from '@lastmile/contracts';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import {
  compileStudyUser, type GeneratedStudy, type LaunchStudyRequestSchema, type Study,
  type StudyApplication, type StudyBrief, type StudyDraft, type StudyExecution, type StudyExecutionDetail,
} from '@lastmile/contracts/studies';
import type { z } from 'zod';
import { RunnerError } from './store';

type LaunchRequest = z.infer<typeof LaunchStudyRequestSchema>;
type RunManifest = ReturnType<typeof compileStudyUser> & {
  sellerDemoUrl: string;
  expectedBuildId: string;
  executionMode: RunRecord['executionMode'];
};
type RunAccess = {
  enqueue: (requestId: string, requestJson: string, manifest: RunManifest) => EvidenceRun;
  get: (id: string) => EvidenceRun | undefined;
  save: (run: EvidenceRun) => EvidenceRun;
  hasRunning: () => boolean;
};
type JsonRow = { data: string };
type ExecutionRow = JsonRow & { origin: string };
type GenerationRow = {
  payload: string;
  status: 'pending' | 'completed' | 'failed' | 'interrupted';
  data: string | null;
};
const timestamp = () => new Date().toISOString();
const decode = <T>(row: JsonRow): T => JSON.parse(row.data);
const briefPayload = ({ applicationId, domain, audience, count }: StudyBrief) =>
  JSON.stringify([applicationId, domain, audience, count]);

export function createStudyStore(db: Database.Database, runs: RunAccess) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studies (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS study_generations (
      request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, data TEXT
    );
    CREATE TABLE IF NOT EXISTS study_executions (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS study_execution_status ON study_executions(status);
    CREATE TABLE IF NOT EXISTS study_runs (run_id TEXT PRIMARY KEY);
  `);

  const insertStudy = db.prepare('INSERT INTO studies (id, data) VALUES (?, ?)');
  const writeStudy = db.prepare('UPDATE studies SET data = ? WHERE id = ?');
  const findStudy = db.prepare<[string], JsonRow>('SELECT data FROM studies WHERE id = ?');
  const listStudies = db.prepare<[], JsonRow>('SELECT data FROM studies ORDER BY rowid DESC');
  const findGeneration = db.prepare<[string], GenerationRow>('SELECT payload, status, data FROM study_generations WHERE request_id = ?');
  const insertGeneration = db.prepare("INSERT INTO study_generations (request_id, payload, status) VALUES (?, ?, 'pending')");
  const writeGeneration = db.prepare("UPDATE study_generations SET status = ?, data = ? WHERE request_id = ? AND status = 'pending'");

  const insertExecution = db.prepare('INSERT INTO study_executions (id, request_id, origin, status, data) VALUES (?, ?, ?, ?, ?)');
  const writeExecution = db.prepare('UPDATE study_executions SET status = ?, data = ? WHERE id = ?');
  const findExecution = db.prepare<[string], JsonRow>('SELECT data FROM study_executions WHERE id = ?');
  const findLaunch = db.prepare<[string], JsonRow>('SELECT data FROM study_executions WHERE request_id = ?');
  const listExecutions = db.prepare<[], JsonRow>('SELECT data FROM study_executions ORDER BY rowid DESC');
  const findRunning = db.prepare<[], JsonRow>("SELECT data FROM study_executions WHERE status = 'running'");
  const nextQueued = db.prepare<[], ExecutionRow>("SELECT data, origin FROM study_executions WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const trackMember = db.prepare('INSERT INTO study_runs (run_id) VALUES (?)');

  function getStudy(id: string) {
    const row = findStudy.get(id);
    return row && decode<Study>(row);
  }

  function requireStudy(id: string, revision?: number) {
    const study = getStudy(id);
    if (!study) throw new RunnerError(404, 'not_found', 'Study does not exist');
    if (revision !== undefined && study.revision !== revision) {
      throw new RunnerError(409, 'stale_revision', 'Study revision has changed');
    }
    return study;
  }

  function getGeneration(requestId: string, brief: StudyBrief) {
    const row = findGeneration.get(requestId);
    if (!row) return;
    if (row.payload !== briefPayload(brief)) {
      throw new RunnerError(409, 'request_conflict', 'Generation request ID already has a different payload');
    }
    return { status: row.status, study: row.data ? JSON.parse(row.data) as Study : undefined };
  }

  function getLaunch(id: string, request: LaunchRequest) {
    const row = findLaunch.get(request.requestId);
    if (!row) return;
    const execution = decode<StudyExecution>(row);
    if (execution.studyId !== id || execution.studyRevision !== request.revision) {
      throw new RunnerError(409, 'request_conflict', 'Launch request ID already has a different payload');
    }
    return execution;
  }

  function saveExecution(execution: StudyExecution) {
    writeExecution.run(execution.status, JSON.stringify(execution), execution.id);
    return execution;
  }

  function memberRuns(execution: StudyExecution) {
    return execution.members.map(({ runId }) => {
      const run = runs.get(runId);
      if (!run) throw new Error('Study execution member does not exist');
      return run;
    });
  }

  return {
    getStudy,
    requireStudy,
    listStudies: () => listStudies.all().map(decode<Study>),
    getGeneration,
    beginGeneration: db.transaction((requestId: string, brief: StudyBrief) => {
      const previous = getGeneration(requestId, brief);
      if (previous) return previous;
      insertGeneration.run(requestId, briefPayload(brief));
    }).immediate,
    finishGeneration: db.transaction((requestId: string, brief: StudyBrief, generated: GeneratedStudy) => {
      const { draft, generation } = generated;
      const now = timestamp();
      const study: Study = { ...draft, brief, generation, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
      const data = JSON.stringify(study);
      const reservation = writeGeneration.run('completed', data, requestId);
      if (!reservation.changes) throw new RunnerError(409, 'generation_interrupted', 'Generation was interrupted. Submit a new request.');
      insertStudy.run(study.id, data);
      return study;
    }).immediate,
    failGeneration: (requestId: string) => { writeGeneration.run('failed', null, requestId); },
    saveDraft: db.transaction((id: string, revision: number, draft: StudyDraft) => {
      const study = requireStudy(id, revision);
      const edited: Study = { ...study, ...draft, revision: study.revision + 1, updatedAt: timestamp() };
      writeStudy.run(JSON.stringify(edited), id);
      return edited;
    }).immediate,
    getLaunch,
    launch: db.transaction((
      studyId: string, request: LaunchRequest, application: StudyApplication, expectedBuildId: string,
      executionMode: RunRecord['executionMode'],
    ) => {
      const previous = getLaunch(studyId, request);
      if (previous) return previous;
      const study = requireStudy(studyId, request.revision);
      const origin = new URL(application.origin).origin;
      let compiled: ReturnType<typeof compileStudyUser>[];
      try {
        compiled = study.users.map(user => compileStudyUser(user, application));
      } catch {
        throw new RunnerError(400, 'invalid_study', 'Tester workflows and input values must match the connected application');
      }
      const id = randomUUID();
      const members = compiled.map((configuration, index) => {
        const userId = study.users[index].id;
        const run = runs.enqueue(`study-${randomUUID()}`, JSON.stringify({ studyExecutionId: id, userId }), {
          ...configuration, sellerDemoUrl: origin, expectedBuildId, executionMode,
        });
        trackMember.run(run.id);
        return { userId, runId: run.id };
      });
      const execution: StudyExecution = {
        id, studyId, studyRevision: study.revision, requestId: request.requestId, study, expectedBuildId,
        status: 'queued', createdAt: timestamp(), members,
      };
      insertExecution.run(id, request.requestId, origin, execution.status, JSON.stringify(execution));
      return execution;
    }).immediate,
    listExecutions: () => listExecutions.all().map(decode<StudyExecution>),
    getExecutionDetail(id: string): StudyExecutionDetail | undefined {
      const row = findExecution.get(id);
      if (!row) return;
      const execution = decode<StudyExecution>(row);
      return { ...execution, runs: memberRuns(execution) };
    },
    claimNext: db.transaction(() => {
      if (runs.hasRunning() || findRunning.get()) return;
      const row = nextQueued.get();
      if (!row) return;
      const execution = saveExecution({ ...decode<StudyExecution>(row), status: 'running' });
      const startedAt = timestamp();
      const claimed = memberRuns(execution).map(run => runs.save({ ...run, status: 'running', startedAt }));
      return { execution, origin: row.origin, runs: claimed };
    }).immediate,
    finishExecution(execution: StudyExecution) {
      return saveExecution({ ...execution, status: 'completed', finishedAt: timestamp() });
    },
    recoverInterrupted() {
      db.prepare("UPDATE study_generations SET status = 'interrupted' WHERE status = 'pending'").run();
      const finishedAt = timestamp();
      for (const row of findRunning.all()) {
        saveExecution({ ...decode<StudyExecution>(row), status: 'interrupted', finishedAt });
      }
    },
  };
}
