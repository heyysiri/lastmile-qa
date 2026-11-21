import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ZodError } from 'zod';
import type { EvidenceRun, InvestigationRecord, InvestigationRequest, ReplayPlan } from '@lastmile/contracts/runtime';
import { compileInputs, type RunRecord, type RunRequest, type ContextPack } from '@lastmile/contracts';
import { desktopContext, inventoryScenario, mobileContext, storeScenario } from '@lastmile/contracts/examples';
import { createStudyStore } from './study-store';
import { createPopulationStore } from './population-store';

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
    CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
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
  const runHistory = db.prepare<[], JsonRow>('SELECT data FROM runs ORDER BY rowid DESC');

  function getRun(id: string): EvidenceRun | undefined {
    const row = findRun.get(id);
    return row && decode<EvidenceRun>(row);
  }

  function save(run: EvidenceRun) {
    writeRun.run(run.status, JSON.stringify(run), run.id);
    return run;
  }

  function enqueueRun(requestId: string, requestJson: string, manifest: Pick<EvidenceRun,
    'scenario' | 'context' | 'inputs' | 'executionMode' | 'expectedBuildId' | 'continuity' | 'replay'> & { sellerDemoUrl: string }) {
    const { scenario, context, inputs, executionMode, expectedBuildId, continuity, replay } = manifest;
    const run: EvidenceRun = {
      id: randomUUID(), requestId, scenario, context, inputs, executionMode, expectedBuildId,
      continuity, replay,
      manifestHash: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
      status: 'queued', verdict: null, createdAt: new Date().toISOString(),
      steps: [], assertions: [], findings: [], capabilities: [], artifacts: [],
    };
    insertRun.run(run.id, requestId, requestJson, run.status, JSON.stringify(run));
    return run;
  }

  const runAccess = { enqueue: enqueueRun, get: getRun, save, hasRunning: () => Boolean(findRunning.get()) };
  const studies = createStudyStore(db, runAccess);
  const populations = createPopulationStore(db, runAccess, studies.requireStudy);
  const nextQueued = db.prepare<[], JsonRow>(`
    SELECT data FROM runs WHERE status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM study_runs WHERE run_id = runs.id)
      AND NOT EXISTS (SELECT 1 FROM population_runs WHERE run_id = runs.id)
    ORDER BY rowid LIMIT 1
  `);

  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM revisions LIMIT 1').get()) {
      scenarios.create(storeScenario);
      scenarios.create(inventoryScenario);
      contextPacks.create(desktopContext);
      contextPacks.create(mobileContext);
    }
  }).immediate();

  const findInvestigation=db.prepare<[string],JsonRow>('SELECT data FROM investigations WHERE id = ?');
  const listInvestigations=()=>db.prepare<[],JsonRow>('SELECT data FROM investigations ORDER BY rowid DESC').all().map(decode<InvestigationRecord>);
  const saveInvestigation=(record:InvestigationRecord)=>{db.prepare('UPDATE investigations SET data = ? WHERE id = ?').run(JSON.stringify(record),record.id);return record;};
  const recoverInterrupted = db.transaction(() => {
    studies.recoverInterrupted();
    populations.recoverInterrupted();
    for(const record of listInvestigations()) if(record.status==='running') saveInvestigation({...record,status:'interrupted',error:'Runner restarted during investigation'});
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
    studies,
    populations,
    getInvestigation:(id:string)=>{const row=findInvestigation.get(id);return row?decode<InvestigationRecord>(row):undefined;},
    listInvestigations,
    enqueueInvestigation:db.transaction((request:InvestigationRequest)=>{
      const previous=db.prepare<[string],JsonRow>('SELECT data FROM investigations WHERE request_id = ?').get(request.requestId);
      if(previous){const record=decode<InvestigationRecord>(previous);if(canonicalJson(record.request)!==canonicalJson(request)) throw new RunnerError(409,'request_conflict','Request ID already has a different payload');return record;}
      const record:InvestigationRecord={id:randomUUID(),request,status:'queued',createdAt:new Date().toISOString()};
      db.prepare('INSERT INTO investigations (id,request_id,data) VALUES (?,?,?)').run(record.id,request.requestId,JSON.stringify(record));return record;
    }).immediate,
    claimInvestigation:db.transaction(()=>{const records=listInvestigations();if(records.some(r=>r.status==='running'))return;const record=records.reverse().find(r=>r.status==='queued');return record?saveInvestigation({...record,status:'running'}):undefined;}).immediate,
    updateInvestigation:(record:InvestigationRecord)=>{
      const row=findInvestigation.get(record.id);if(!row||decode<InvestigationRecord>(row).status!=='running')throw new RunnerError(409,'invalid_status','Investigation is not running');
      return saveInvestigation(record);
    },
    insertTrial:(run:EvidenceRun)=>{insertRun.run(run.id,run.requestId,canonicalJson({trial:run.id}),run.status,JSON.stringify(run));return run;},
    scenarios,
    contextPacks,
    getRun,
    listRuns: () => runHistory.all().map(decode<RunRecord>),
    enqueue: db.transaction((request: RunRequest, sellerDemoUrl: string, executionMode: RunRecord['executionMode'] = 'deterministic', expectedBuildId?:string) => {
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

      if(Object.values(inputs).some(value=>typeof value==='object')) throw new RunnerError(400,'unsupported_fixture','File fixtures are not registered for this project');
      return enqueueRun(request.requestId, requestJson, { scenario, context, inputs, executionMode, sellerDemoUrl, expectedBuildId });
    }).immediate,
    enqueueReplay:db.transaction((requestId:string,source:EvidenceRun,context:ContextPack,replay:ReplayPlan)=>{
      const requestJson=canonicalJson({requestId,sourceId:source.id,contextId:context.id,contextRevision:context.revision,replayHash:replay.hash});
      const previous=findRequest.get(requestId);
      if(previous){if(previous.request_json!==requestJson)throw new RunnerError(409,'request_conflict','Request ID already has a different payload');return decode<EvidenceRun>(previous);}
      const inputs=compileInputs(source.scenario,context);
      if(Object.values(inputs).some(v=>typeof v==='object'))throw new RunnerError(400,'unsupported_fixture','File fixtures are not registered');
      const run:EvidenceRun={...structuredClone(source),id:randomUUID(),requestId,context:structuredClone(context),inputs,expectedBuildId:replay.buildId,replay:structuredClone(replay),evidence:undefined,artifactManifestHash:undefined,status:'queued',verdict:null,createdAt:new Date().toISOString(),startedAt:undefined,finishedAt:undefined,namespaceId:undefined,executionMode:'deterministic',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[],manifestHash:createHash('sha256').update(canonicalJson({scenario:source.scenario,context,replay})).digest('hex')};
      insertRun.run(run.id,requestId,requestJson,run.status,JSON.stringify(run));return run;
    }).immediate,
    claimNext: db.transaction(() => {
      if (findRunning.get()) return undefined;
      const row = nextQueued.get();
      return row && save({ ...decode<RunRecord>(row), status: 'running', startedAt: new Date().toISOString() });
    }).immediate,
    updateRun: db.transaction((update: EvidenceRun) => {
      const run = getRun(update.id);
      if (!run) throw new RunnerError(404, 'not_found', 'Run does not exist');
      if (run.status !== 'running' || (update.status !== 'running' && update.status !== 'completed')) {
        throw new RunnerError(409, 'invalid_run_status', 'Run cannot be updated in this status');
      }
      const completed = update.status === 'completed';
      const checkpoint = update.continuity?.startCheckpoint;
      // The trusted executor resolves preserve-state assertions against the starting checkpoint.
      // Store both together once so every later comparison uses the same scenario.
      const freezeStart = run.continuity?.mode === 'continue' && !run.continuity.startCheckpoint && checkpoint;
      return save({
        ...run, status: update.status, verdict: completed ? update.verdict ?? 'inconclusive' : null,
        ...(freezeStart && { scenario: update.scenario, continuity: { ...run.continuity!, startCheckpoint: checkpoint } }),
        finishedAt: completed ? new Date().toISOString() : undefined,
        namespaceId: update.namespaceId, steps: update.steps, assertions: update.assertions,
        findings: update.findings, capabilities: update.capabilities, artifacts: update.artifacts,
        ...({evidence:update.evidence,artifactManifestHash:update.artifactManifestHash}),
      });
    }).immediate,
    close: () => db.close(),
  };
}
