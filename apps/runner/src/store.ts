import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ZodError } from 'zod';
import { compileInputs, type RunRecord, type RunRequest } from '@lastmile/contracts';
import { desktopContext, inventoryScenario, mobileContext, storeScenario } from '@lastmile/contracts/examples';

export class RunnerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item,
  );
}

type Config = { id: string; revision: number };
type JsonRow = { data: string };
const decode = <T>(row: JsonRow): T => JSON.parse(row.data);

function revisions<T extends Config>(db: Database.Database, kind: 'scenario' | 'context') {
  const insert = db.prepare('INSERT INTO revisions (kind, id, revision, data) VALUES (?, ?, ?, ?)');
  const latest = db.prepare<[string, string], JsonRow>(
    'SELECT data FROM revisions WHERE kind = ? AND id = ? ORDER BY revision DESC LIMIT 1',
  );
  const lookup = db.prepare<[string, string, number], JsonRow>(
    'SELECT data FROM revisions WHERE kind = ? AND id = ? AND revision = ?',
  );
  const list = db.prepare<[string], JsonRow>(`
    SELECT data FROM revisions r WHERE kind = ? AND revision = (
      SELECT max(revision) FROM revisions WHERE kind = r.kind AND id = r.id
    ) ORDER BY rowid
  `);
  function add(item: T) {
    insert.run(kind, item.id, item.revision, JSON.stringify(item));
    return item;
  }

  return {
    get(id: string, revision: number): T | undefined {
      const row = lookup.get(kind, id, revision);
      return row && decode<T>(row);
    },
    list: () => list.all(kind).map(decode<T>),
    create: db.transaction((item: T) => {
      if (latest.get(kind, item.id)) throw new RunnerError(409, 'duplicate_id', 'Configuration ID already exists');
      if (item.revision !== 1) throw new RunnerError(400, 'validation', 'New configurations must start at revision 1');
      return add(item);
    }).immediate,
    update: db.transaction((item: T) => {
      const row = latest.get(kind, item.id);
      if (!row) throw new RunnerError(404, 'not_found', 'Configuration does not exist');
      const { revision } = decode<T>(row);
      if (revision !== item.revision) throw new RunnerError(409, 'stale_revision', 'Configuration revision has changed');
      return add({ ...item, revision: revision + 1 });
    }).immediate,
  };
}

export function openRunStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS revisions (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (kind, id, revision)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT NOT NULL PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
  `);
  const scenarios = revisions<typeof storeScenario>(db, 'scenario');
  const contextPacks = revisions<typeof desktopContext>(db, 'context');
  const insertRun = db.prepare('INSERT INTO runs (id, request_id, request_json, status, data) VALUES (?, ?, ?, ?, ?)');
  const writeRun = db.prepare('UPDATE runs SET status = ?, data = ? WHERE id = ?');
  const findRun = db.prepare<[string], JsonRow>('SELECT data FROM runs WHERE id = ?');
  const findRequest = db.prepare<[string], JsonRow & { request_json: string }>(
    'SELECT data, request_json FROM runs WHERE request_id = ?',
  );
  const findRunning = db.prepare<[], JsonRow>("SELECT data FROM runs WHERE status = 'running'");
  const nextQueued = db.prepare<[], JsonRow>("SELECT data FROM runs WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const runHistory = db.prepare<[], JsonRow>('SELECT data FROM runs ORDER BY rowid DESC');

  function getRun(id: string): RunRecord | undefined {
    const row = findRun.get(id);
    return row && decode<RunRecord>(row);
  }

  function save(run: RunRecord) {
    writeRun.run(run.status, JSON.stringify(run), run.id);
    return run;
  }

  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM revisions LIMIT 1').get()) {
      scenarios.create(storeScenario);
      scenarios.create(inventoryScenario);
      contextPacks.create(desktopContext);
      contextPacks.create(mobileContext);
    }
  }).immediate();

  const recoverInterrupted = db.transaction(() => {
    for (const row of findRunning.all()) {
      const run = decode<RunRecord>(row);
      save({
        ...run, status: 'interrupted', verdict: 'inconclusive', finishedAt: new Date().toISOString(),
        findings: [...run.findings, {
          kind: 'environment_failure', description: 'Runner restarted during execution', evidencePaths: [],
        }],
      });
    }
  }).immediate;

  return {
    recoverInterrupted,
    scenarios,
    contextPacks,
    getRun,
    listRuns: () => runHistory.all().map(decode<RunRecord>),
    enqueue: db.transaction((request: RunRequest, sellerDemoUrl: string, executionMode: RunRecord['executionMode'] = 'deterministic') => {
      const requestJson = canonicalJson(request);
      const previous = findRequest.get(request.requestId);
      if (previous) {
        if (previous.request_json !== requestJson) throw new RunnerError(409, 'request_conflict', 'Request ID already has a different payload');
        return decode<RunRecord>(previous);
      }
      const scenario = scenarios.get(request.scenarioId, request.scenarioRevision);
      const context = contextPacks.get(request.contextPackId, request.contextRevision);
      if (!scenario || !context) throw new RunnerError(404, 'not_found', 'Scenario or context pack revision does not exist');
      let inputs: RunRecord['inputs'];
      try {
        inputs = compileInputs(scenario, context);
      } catch (error) {
        if (error instanceof ZodError) throw new RunnerError(400, 'invalid_contract', 'The saved scenario has an invalid outcome contract');
        throw new RunnerError(400, 'invalid_inputs', 'Context inputs do not satisfy the scenario');
      }

      const manifest = { scenario, context, inputs, executionMode, sellerDemoUrl };
      const run: RunRecord = {
        id: randomUUID(), requestId: request.requestId, scenario, context, inputs, executionMode,
        manifestHash: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
        status: 'queued', verdict: null, createdAt: new Date().toISOString(),
        steps: [], assertions: [], findings: [], capabilities: [], artifacts: [],
      };
      insertRun.run(run.id, request.requestId, requestJson, run.status, JSON.stringify(run));
      return run;
    }).immediate,
    claimNext: db.transaction(() => {
      if (findRunning.get()) return undefined;
      const row = nextQueued.get();
      return row && save({ ...decode<RunRecord>(row), status: 'running', startedAt: new Date().toISOString() });
    }).immediate,
    updateRun: db.transaction((update: RunRecord) => {
      const run = getRun(update.id);
      if (!run) throw new RunnerError(404, 'not_found', 'Run does not exist');
      if (run.status !== 'running' || (update.status !== 'running' && update.status !== 'completed')) {
        throw new RunnerError(409, 'invalid_run_status', 'Run cannot be updated in this status');
      }
      const completed = update.status === 'completed';
      return save({
        ...run, status: update.status, verdict: completed ? update.verdict ?? 'inconclusive' : null,
        finishedAt: completed ? new Date().toISOString() : undefined,
        namespaceId: update.namespaceId, steps: update.steps, assertions: update.assertions,
        findings: update.findings, capabilities: update.capabilities, artifacts: update.artifacts,
      });
    }).immediate,
    close: () => db.close(),
  };
}
