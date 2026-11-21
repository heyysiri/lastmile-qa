import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import type { ZodType } from 'zod';
import { InvestigationRequestSchema, ReplayRequestSchema, type EvidenceRun, type ReplayPlan } from '@lastmile/contracts/runtime';
import { compileInputs } from '@lastmile/contracts';
import { readArtifact, hashValue } from './artifacts';
import { buildReplay } from './replay';
import { investigate } from '../../../packages/differential/src/index';
import {
  capabilities, ContextPackSchema, RunRequestSchema, ScenarioSchema, type RunRecord,
} from '@lastmile/contracts';
import { executeRun, type ExecuteRun } from './execution';
import { openRunStore, RunnerError } from './store';

export type ServerOptions = {
  databasePath: string;
  apiToken?: string;
  artifactRoot?: string;
  sellerDemoUrl?: string;
  modelConfigured?: boolean;
  executeRun?: ExecuteRun;
  getBuildId?:()=>Promise<string>;
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
  const app = Fastify();
  const store = openRunStore(options.databasePath);
  let active: Promise<void> | undefined;
  let stopping = false;

  async function drain() {
    try {
      while (!stopping) {
        const run = store.claimNext();
        if (!run) {
          const job=store.claimInvestigation();
          if(!job) break;
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
        let updating = true;
        try {
          const replay=(run as EvidenceRun).replay;
          const perform=replay&&options.executeReplay ? (r:RunRecord,u:(r:RunRecord)=>void)=>options.executeReplay!(r,u,replay) : execute;
          const result = await perform(run, (update) => {
            if (updating && update.status === 'running') store.updateRun({ ...update, id: run.id });
          });
          if (result.status !== 'completed') throw new Error('Executor returned an unfinished run');
          store.updateRun({ ...result, id: run.id });
        } catch {
          const current = store.getRun(run.id) ?? run;
          store.updateRun({
            ...current, status: 'completed', verdict: 'inconclusive',
            findings: [...current.findings, {
              kind: 'environment_failure', description: 'Run execution could not be completed', evidencePaths: [],
            }],
          });
        } finally {
          updating = false;
        }
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

  app.get('/api/health', async () => ({
    status: 'ok', modelConfigured, executionReady: execute !== executeRun,
  }));
  app.get('/api/capabilities', async () => capabilities);

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

  app.get('/api/runs', async () => store.listRuns());
  app.post('/api/runs', async (request, reply) => {
    const run = store.enqueue(
      parse(RunRequestSchema, request.body), sellerDemoUrl.href,
      modelConfigured && execute !== executeRun ? 'ai_guided' : 'deterministic',
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
    const source=requireRun(request.params.id) as EvidenceRun;
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
    const target=requireRun(input.targetRunId) as EvidenceRun,control=requireRun(input.controlRunId) as EvidenceRun;
    if(target.status!=='completed'||target.verdict!=='failed'||control.status!=='completed'||control.verdict!=='passed'||!target.evidence||!control.evidence||target.evidence.scenarioHash!==control.evidence.scenarioHash||target.evidence.buildId!==control.evidence.buildId) throw new RunnerError(400,'invalid_comparison','Choose a failed target and passed control with the same scenario and build');
    if(input.factors.some(f=>!target.scenario.investigation.factors.includes(f))||input.maxAttempts>target.scenario.investigation.maxAttempts)throw new RunnerError(400,'invalid_factors','Investigation exceeds the scenario factor or attempt limits');
    const job=store.enqueueInvestigation(input);startWorker();return reply.code(202).send(job);
  });
  return app;
}
