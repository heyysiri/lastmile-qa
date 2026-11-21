import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import type { ZodType } from 'zod';
import { InvestigationRequestSchema, ReplayRequestSchema, type EvidenceRun, type ReplayPlan } from '@lastmile/contracts/runtime';
import type { GenerateStudy, StudyApplication, StudyUser } from '@lastmile/contracts/studies';
import type { GenerateSuggestions, RepairRuntime } from '@lastmile/contracts/evolution';
import type { ApplicationContext } from '@lastmile/contracts/populations';
import { compileInputs } from '@lastmile/contracts';
import { readArtifact, hashValue } from './artifacts';
import { buildReplay } from './replay';
import { investigate } from '../../../packages/differential/src/index';
import {
  capabilities, ContextPackSchema, RunRequestSchema, ScenarioSchema, type RunRecord,
} from '@lastmile/contracts';
import { executeRun, type ExecuteRun } from './execution';
import { openRunStore, RunnerError } from './store';
import { registerStudyRoutes } from './study-routes';
import { registerPopulationRoutes } from './population-routes';
import { registerEvolutionRoutes } from './evolution-routes';

export type ServerOptions = {
  databasePath: string;
  apiToken?: string;
  artifactRoot?: string;
  sellerDemoUrl?: string;
  modelConfigured?: boolean;
  executeRun?: ExecuteRun;
  getBuildId?:()=>Promise<string>;
  applications?: StudyApplication[];
  generateStudy?: GenerateStudy;
  generateSuggestions?: GenerateSuggestions;
  repairRuntime?: RepairRuntime;
  validateStudyUser?: (application: StudyApplication, user: StudyUser) => void;
  getApplicationContext?: (application: StudyApplication) => Promise<ApplicationContext>;
  executeReplay?: (run:EvidenceRun,onUpdate:(run:RunRecord)=>void,replay:ReplayPlan)=>Promise<EvidenceRun>;
};

const allowedOrigins = new Set(['http://127.0.0.1:3000', 'http://localhost:3000']);
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const digest = (value: string) => createHash('sha256').update(value).digest();

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new RunnerError(400, 'validation', 'Request does not match the expected schema');
  return result.data;
}

function validateEdit(id: string, body: unknown, editedId: string) {
  if (id !== editedId || !Object.hasOwn(body as object, 'revision')) {
    throw new RunnerError(400, 'validation', 'Update requires the matching ID and existing revision');
  }
}

async function existingArtifacts(root: string, run: RunRecord) {
  let directory: string;
  const expectedDirectory = resolve(root, run.id);
  try {
    directory = await realpath(expectedDirectory);
    if (directory !== resolve(await realpath(root), run.id)) return [];
  } catch {
    return [];
  }

  const artifacts: string[] = [];
  for (const item of new Set(run.artifacts)) {
    if(item.endsWith('/trace.zip'))continue;
    const parts = item.split('/');
    if (parts[0] !== run.id || parts.length < 2 ||
        parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) continue;
    try {
      const path = await realpath(resolve(root, item));
      const withinRun = relative(directory, path);
      if (withinRun && !isAbsolute(withinRun) && withinRun !== '..' && !withinRun.startsWith(`..${sep}`) && (await stat(path)).isFile()) {
        artifacts.push(item);
      }
    } catch {
      // The file may have been removed after the run was recorded.
    }
  }
  return artifacts;
}

export function createServer(options: ServerOptions) {
  const apiToken = options.apiToken ?? process.env.RUNNER_API_TOKEN ??
    (process.env.NODE_ENV === 'production' ? undefined : 'local-development-runner');
  if (!apiToken?.trim() || (process.env.NODE_ENV === 'production' && apiToken === 'local-development-runner')) {
    throw new Error('Configure RUNNER_API_TOKEN before starting the runner');
  }
  const expectedAuth = digest(`Bearer ${apiToken}`);
  const artifactRoot = resolve(options.artifactRoot ?? 'artifacts/runs');
  const sellerDemoUrl = new URL(options.sellerDemoUrl ?? process.env.SELLER_DEMO_URL ?? 'http://127.0.0.1:3001');
  if (!['http:', 'https:'].includes(sellerDemoUrl.protocol) || sellerDemoUrl.username || sellerDemoUrl.password) {
    throw new Error('Configure SELLER_DEMO_URL with an HTTP(S) origin without credentials');
  }

  const modelConfigured = options.modelConfigured ?? Boolean(process.env.OPENAI_API_KEY?.trim());
  const execute = options.executeRun ?? executeRun;
  const executionMode = modelConfigured && execute !== executeRun ? 'ai_guided' : 'deterministic';
  const app = Fastify();
  const store = openRunStore(options.databasePath);
  let active: Promise<void> | undefined;
  let stopping = false;

  function failRun(run: RunRecord, description: string) {
    const current = store.getRun(run.id) ?? run;
    store.updateRun({
      ...current, status: 'completed', verdict: 'inconclusive',
      findings: [...current.findings, { kind: 'environment_failure', description, evidencePaths: [] }],
    });
  }

  async function performRun(run: RunRecord, perform: ExecuteRun) {
    let updating = true;
    try {
      const result = await perform(run, update => {
        if (updating && update.status === 'running') store.updateRun({ ...update, id: run.id });
      });
      if (result.status !== 'completed') throw new Error('Executor returned an unfinished run');
      store.updateRun({ ...result, id: run.id });
    } catch {
      failRun(run, 'Run execution could not be completed');
    } finally {
      updating = false;
    }
  }

  async function performQueuedRun(run: EvidenceRun) {
    if (!run.replay && run.continuity?.mode !== 'checkpoint') return performRun(run, execute);
    const replay = run.replay;
    const executeReplay = options.executeReplay;
    if (!replay || !executeReplay) return failRun(run, 'Replay execution is unavailable');
    await performRun(run, (record, update) => executeReplay(record, update, replay));
  }

  const claimers = [
    () => { const run = store.claimNext(); return run && { kind: 'run' as const, run }; },
    () => { const study = store.studies.claimNext(); return study && { kind: 'study' as const, study }; },
    () => { const job = store.claimInvestigation(); return job && { kind: 'investigation' as const, job }; },
    () => { const batch = store.populations.claimNext(); return batch && { kind: 'population' as const, batch }; },
    () => { const job = store.evolution.claimNext(); return job && { kind: 'evolution' as const, job }; },
  ];
  let nextQueue = 0;

  function claimWork() {
    for (let offset = 0; offset < claimers.length; offset++) {
      const index = (nextQueue + offset) % claimers.length;
      const work = claimers[index]();
      if (work) {
        nextQueue = (index + 1) % claimers.length;
        return work;
      }
    }
  }

  async function drain() {
    try {
      while (!stopping) {
        const work = claimWork();
        if (!work) break;
        if (work.kind === 'study') {
          const { execution, origin, runs } = work.study;
          if (origin === sellerDemoUrl.origin) {
            await Promise.all(runs.map(run => performRun(run, execute)));
          } else {
            for (const run of runs) failRun(run, 'The connected application origin changed after launch');
          }
          store.studies.finishExecution(execution);
          continue;
        }
        if (work.kind === 'population') {
          const { execution, runs } = work.batch;
          if (execution.population.origin === sellerDemoUrl.origin) {
            await Promise.all(runs.map(performQueuedRun));
          } else {
            for (const run of runs) failRun(run, 'The connected application origin changed after launch');
          }
          store.populations.finishExecution(execution);
          continue;
        }
        if (work.kind === 'evolution') {
          await store.evolution.execute(work.job, options);
          continue;
        }
        if (work.kind === 'investigation') {
          const { job } = work;
          try {
            const target=requireRun(job.request.targetRunId) as EvidenceRun,control=requireRun(job.request.controlRunId) as EvidenceRun;
            if(!options.executeReplay)throw new Error('Replay execution is unavailable');
            const replay=buildReplay(control);
            const result=await investigate({id:job.id,target,control,replay,factors:job.request.factors,maxAttempts:job.request.maxAttempts,
              onUpdate:result=>store.updateInvestigation({...job,result}),
              runTrial:async(context,plan)=>{
                const id=randomUUID();
                const trial:EvidenceRun={...structuredClone(target),id,requestId:`trial-${id}`,context,inputs:compileInputs(target.scenario,context),status:'running',verdict:null,createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),finishedAt:undefined,namespaceId:undefined,evidence:undefined,executionMode:'deterministic',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[],expectedBuildId:plan.buildId,manifestHash:hashValue({scenario:target.scenario,context,replay:plan.hash})};
                store.insertTrial(trial);
                try {
                  const result=await options.executeReplay!(trial,update=>store.updateRun(update),plan);
                  store.updateRun(result);return result;
                } catch {
                  const result:EvidenceRun={...trial,status:'completed',verdict:'inconclusive',findings:[{kind:'environment_failure',description:'Replay executor could not complete the trial',evidencePaths:[]}]};
                  store.updateRun(result);return result;
                }
              }});
            store.updateInvestigation({...job,status:'completed',result});
          }catch{store.updateInvestigation({...job,status:'completed',error:'Investigation could not establish a valid matched comparison. Check completed target/control evidence, matching scenario/build and configured factors.'});}
          continue;
        }
        await performQueuedRun(work.run);
      }
    } catch {
      app.log.error('Runner queue processing failed');
    } finally {
      active = undefined;
    }
  }

  function startWorker() {
    if (active || stopping) return;
    active = Promise.resolve().then(drain);
  }

  app.addHook('onListen', async () => {
    store.recoverInterrupted();
    startWorker();
  });
  app.addHook('preClose', async () => {
    stopping = true;
    await active;
  });
  app.addHook('onClose', async () => { store.close(); });

  app.addHook('onRequest', async (request, reply) => {
    const path = (request.routeOptions.url ?? request.url).split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;
    const authorization = request.headers.authorization;
    const origin = request.headers.origin;
    if (!authorization || !timingSafeEqual(digest(authorization), expectedAuth) ||
        (mutationMethods.has(request.method) && origin !== undefined && !allowedOrigins.has(origin))) {
      return reply.code(401).send({ code: 'unauthorized', message: 'Authorization is required' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RunnerError) return reply.code(error.status).send({ code: error.code, message: error.message });
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ code: 'validation', message: 'Invalid request' });
    }
    return reply.code(500).send({ code: 'internal_error', message: 'Runner could not process the request' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'not_found', message: 'Resource does not exist' }));

  const suggestionsReady = Boolean(options.generateSuggestions);
  const repairsReady = Boolean(options.repairRuntime);
  app.get('/api/health', async () => ({
    status: 'ok', modelConfigured, executionReady: execute !== executeRun, suggestionsReady, repairsReady,
  }));
  app.get('/api/capabilities', async () => capabilities);
  registerStudyRoutes(app, store.studies, {
    applications: options.applications ?? [],
    generateStudy: options.generateStudy,
    validateStudyUser: options.validateStudyUser,
    getBuildId: options.getBuildId,
    origin: sellerDemoUrl.origin,
    executionMode,
    startWorker,
  });
  registerPopulationRoutes(app, store.populations, {
    applications: options.applications ?? [],
    getApplicationContext: options.getApplicationContext,
    validateStudyUser: options.validateStudyUser,
    getBuildId: options.getBuildId,
    origin: sellerDemoUrl.origin,
    executionMode,
    replayAvailable: Boolean(options.executeReplay),
    startWorker,
  });

  registerEvolutionRoutes(app, store, {
    applications: options.applications ?? [],
    origin: sellerDemoUrl.origin,
    getApplicationContext: options.getApplicationContext,
    getBuildId: options.getBuildId,
    suggestionsReady,
    repairsReady,
    startWorker,
  });

  function parseScenario(body: unknown) {
    const scenario = parse(ScenarioSchema, body);
    if (/[\u0000-\u001f\u007f]/.test(scenario.entryPath) ||
        new URL(scenario.entryPath, sellerDemoUrl).origin !== sellerDemoUrl.origin) {
      throw new RunnerError(400, 'validation', 'Scenario entry path must stay on the seller demo');
    }
    return scenario;
  }

  app.get('/api/scenarios', async () => store.scenarios.list());
  app.post('/api/scenarios', async (request, reply) =>
    reply.code(201).send(store.scenarios.create(parseScenario(request.body))),
  );
  app.put<{ Params: { id: string } }>('/api/scenarios/:id', async (request) => {
    const item = parseScenario(request.body);
    validateEdit(request.params.id, request.body, item.id);
    return store.scenarios.update(item);
  });
  app.get('/api/context-packs', async () => store.contextPacks.list());
  app.post('/api/context-packs', async (request, reply) =>
    reply.code(201).send(store.contextPacks.create(parse(ContextPackSchema, request.body))),
  );
  app.put<{ Params: { id: string } }>('/api/context-packs/:id', async (request) => {
    const item = parse(ContextPackSchema, request.body);
    validateEdit(request.params.id, request.body, item.id);
    return store.contextPacks.update(item);
  });

  function requireRun(id: string) {
    const run = store.getRun(id);
    if (!run) throw new RunnerError(404, 'not_found', 'Run does not exist');
    return run;
  }

  function requireOrdinaryRun(id: string) {
    const run = requireRun(id);
    if (run.continuity) {
      throw new RunnerError(400, 'persistent_run', 'Use population checkpoint comparisons for persistent tester runs');
    }
    return run;
  }

  app.get('/api/runs', async () => store.listRuns());
  app.post('/api/runs', async (request, reply) => {
    const run = store.enqueue(
      parse(RunRequestSchema, request.body), sellerDemoUrl.href,
      executionMode,
      await options.getBuildId?.(),
    );
    startWorker();
    return reply.code(202).send({ id: run.id, status: run.status });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => requireRun(request.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id/artifacts', async (request) => {
    const items = await existingArtifacts(artifactRoot, requireRun(request.params.id));
    if (!items.length) throw new RunnerError(404, 'not_found', 'Run has no available artifacts');
    return items;
  });

  app.get<{Params:{id:string;name:string}}>('/api/runs/:id/artifacts/:name',async(request,reply)=>{
    const run=requireRun(request.params.id);
    const artifact=`${run.id}/${request.params.name}`;
    if(!(await existingArtifacts(artifactRoot,run)).includes(artifact)) throw new RunnerError(404,'not_found','Artifact does not exist');
    try {
      const digest=(run as EvidenceRun).artifactManifestHash;
      if(!digest)throw new Error('No trusted artifact manifest');
      const bytes=await readArtifact(resolve(artifactRoot,run.id),request.params.name,digest);
      const type=request.params.name.endsWith('.png')?'image/png':request.params.name.endsWith('.zip')?'application/zip':'application/json';
      return reply.type(type).header('x-content-type-options','nosniff').send(bytes);
    } catch {throw new RunnerError(409,'artifact_integrity','Artifact integrity check failed');}
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/replay',async(request,reply)=>{
    if(!options.executeReplay)throw new RunnerError(503,'execution_unavailable','Replay execution is unavailable');
    const input=parse(ReplayRequestSchema,request.body);
    const source=requireOrdinaryRun(request.params.id);
    const context=store.contextPacks.get(input.contextPackId,input.contextRevision);
    if(!context)throw new RunnerError(404,'not_found','Context revision does not exist');
    let replay:ReplayPlan;
    try{replay=buildReplay(source);}catch{throw new RunnerError(400,'invalid_replay','Choose an AI-guided run with all outcome checks passed');}
    const run=store.enqueueReplay(input.requestId,source,context,replay);startWorker();return reply.code(202).send({id:run.id,status:run.status});
  });
  app.get('/api/investigations',async()=>store.listInvestigations());
  app.get<{Params:{id:string}}>('/api/investigations/:id',async request=>{
    const job=store.getInvestigation(request.params.id);if(!job)throw new RunnerError(404,'not_found','Investigation does not exist');return job;
  });
  app.post('/api/investigations',async(request,reply)=>{
    if(!options.executeReplay)throw new RunnerError(503,'execution_unavailable','Replay execution is unavailable');
    const input=parse(InvestigationRequestSchema,request.body);
    const target=requireOrdinaryRun(input.targetRunId),control=requireOrdinaryRun(input.controlRunId);
    if(target.status!=='completed'||target.verdict!=='failed'||control.status!=='completed'||control.verdict!=='passed'||!target.evidence||!control.evidence||target.evidence.scenarioHash!==control.evidence.scenarioHash||target.evidence.buildId!==control.evidence.buildId) throw new RunnerError(400,'invalid_comparison','Choose a failed target and passed control with the same scenario and build');
    if(input.factors.some(f=>!target.scenario.investigation.factors.includes(f))||input.maxAttempts>target.scenario.investigation.maxAttempts)throw new RunnerError(400,'invalid_factors','Investigation exceeds the scenario factor or attempt limits');
    const job=store.enqueueInvestigation(input);startWorker();return reply.code(202).send(job);
  });
  return app;
}
