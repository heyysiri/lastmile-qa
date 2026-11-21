import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import type { ZodType } from 'zod';
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
        if (!run) break;
        let updating = true;
        try {
          const result = await execute(run, (update) => {
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

  return app;
}
