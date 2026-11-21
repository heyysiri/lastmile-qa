import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import { PrepareRepairRequestSchema, SuggestJourneysRequestSchema, VerifyRepairRequestSchema } from '@lastmile/contracts/evolution';
import type { ApplicationContext, Population } from '@lastmile/contracts/populations';
import type { StudyApplication } from '@lastmile/contracts/studies';
import { hashValue } from './artifacts';
import { RunnerError, type openRunStore } from './store';

type RouteOptions = {
  applications: StudyApplication[];
  origin: string;
  getApplicationContext?: (application: StudyApplication) => Promise<ApplicationContext>;
  getBuildId?: () => Promise<string>;
  suggestionsReady: boolean;
  repairsReady: boolean;
  startWorker: () => void;
};

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RunnerError(400, 'validation', 'Request does not match the expected schema');
  return result.data;
}

function coalesce<T>() {
  const pending = new Map<string, { hash: string; promise: Promise<T> }>();
  return (key: string, request: unknown, capture: () => Promise<T>) => {
    const hash = hashValue(request);
    const previous = pending.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new RunnerError(409, 'request_conflict', 'Request ID already has a different payload');
      return previous.promise;
    }
    const promise = Promise.resolve().then(capture).finally(() => { pending.delete(key); });
    pending.set(key, { hash, promise });
    return promise;
  };
}

const contextIdentity = ({ applicationId, version, sources }: ApplicationContext) =>
  hashValue({ applicationId, version, sources: sources.map(({ kind, path, digest }) => ({ kind, path, digest })) });

export function registerEvolutionRoutes(app: FastifyInstance, store: ReturnType<typeof openRunStore>, options: RouteOptions) {
  const { evolution, populations } = store;
  const applications = structuredClone(options.applications).filter(application => {
    if (!URL.canParse(application.origin)) return false;
    const url = new URL(application.origin);
    return url.origin === options.origin && !url.username && !url.password;
  });
  const suggest = coalesce<ReturnType<typeof evolution.enqueueSuggestion>>();
  const repair = coalesce<ReturnType<typeof evolution.enqueueRepair>>();

  function requireApplication(population: Population) {
    if (population.origin !== options.origin) {
      throw new RunnerError(409, 'origin_changed', 'The connected application origin changed since enrollment');
    }
    const application = applications.find(item => item.id === population.applicationId);
    if (!application) throw new RunnerError(404, 'not_found', 'Connected application does not exist');
    return application;
  }

  async function captureContext(application: StudyApplication) {
    try {
      const context = await options.getApplicationContext?.(structuredClone(application));
      if (context?.applicationId !== application.id || !context.version.trim() || !context.sources.length) throw new Error();
      return structuredClone(context);
    } catch {
      throw new RunnerError(503, 'context_unavailable', 'Could not capture connected application context');
    }
  }

  async function captureBuildId() {
    try {
      const buildId = await options.getBuildId?.();
      if (typeof buildId !== 'string' || !buildId.trim()) throw new Error();
      return buildId;
    } catch {
      throw new RunnerError(503, 'build_unavailable', 'Could not identify the connected application build');
    }
  }

  function requireRepairRuntime() {
    if (!options.repairsReady) throw new RunnerError(503, 'execution_unavailable', 'Repair execution is unavailable');
  }

  app.post<{ Params: { id: string } }>('/api/populations/:id/suggestions', async (request, reply) => {
    const { id } = request.params;
    const input = parse(SuggestJourneysRequestSchema, request.body);
    const previous = evolution.findSuggestionRequest(id, input);
    const job = previous ?? await suggest(`${id}/${input.requestId}`, input, async () => {
      const population = populations.getPopulationDetail(id);
      const application = requireApplication(population);
      if (!options.suggestionsReady) throw new RunnerError(503, 'execution_unavailable', 'Journey suggestions are unavailable');
      const previousContext = populations.listExecutions().find(execution => execution.populationId === id && execution.status === 'completed')?.applicationContext;
      const context = await captureContext(application);
      return evolution.enqueueSuggestion(id, input, { population, application, context, previousContext, objective: input.objective });
    });
    options.startWorker();
    return reply.code(202).send(job);
  });

  app.get<{ Params: { id: string } }>('/api/populations/:id/suggestions', async request => {
    populations.requirePopulation(request.params.id);
    return evolution.listSuggestions(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/suggestions/:id', async request => {
    const job = evolution.getSuggestion(request.params.id);
    if (!job) throw new RunnerError(404, 'not_found', 'Suggestion job does not exist');
    return job;
  });

  app.post('/api/repairs', async (request, reply) => {
    const input = parse(PrepareRepairRequestSchema, request.body);
    const previous = evolution.findRepairRequest(input);
    const job = previous ?? await repair(input.requestId, input, async () => {
      const execution = evolution.requireRepairSource(input.executionId);
      const application = requireApplication(execution.population);
      requireRepairRuntime();
      evolution.ensureRepairIdle(execution.populationId);
      const [context, buildId] = await Promise.all([captureContext(application), captureBuildId()]);
      const frozenContext = execution.applicationContext!;
      if (buildId !== execution.buildId || contextIdentity(context) !== contextIdentity(frozenContext)) {
        throw new RunnerError(409, 'stale_repair_source', 'The connected build or source context changed since the comparison');
      }
      // Capture checks current identity. Keep the context timestamp and evidence from the source launch.
      return evolution.enqueueRepair(input, { execution, context: frozenContext });
    });
    options.startWorker();
    return reply.code(202).send(job);
  });

  app.get<{ Querystring: { populationId?: string } }>('/api/repairs', async request => {
    const { populationId } = request.query;
    if (populationId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(populationId)) {
      throw new RunnerError(400, 'validation', 'Invalid population ID');
    }
    return evolution.listRepairs(populationId);
  });

  app.get<{ Params: { id: string } }>('/api/repairs/:id', async request => {
    const job = evolution.getRepair(request.params.id);
    if (!job) throw new RunnerError(404, 'not_found', 'Repair does not exist');
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/repairs/:id/verify', async (request, reply) => {
    const input = parse(VerifyRepairRequestSchema, request.body);
    const job = evolution.enqueueVerification(request.params.id, input, job => {
      requireRepairRuntime();
      requireApplication(job.snapshot.execution.population);
    });
    options.startWorker();
    return reply.code(202).send(job);
  });
}
