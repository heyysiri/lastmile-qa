import type { FastifyInstance } from 'fastify';
import type { RunRecord } from '@lastmile/contracts';
import {
  EnrollPopulationRequestSchema, LaunchPopulationRequestSchema,
  type ApplicationContext, type PopulationExecution,
} from '@lastmile/contracts/populations';
import type { StudyApplication, StudyUser } from '@lastmile/contracts/studies';
import type { ZodType } from 'zod';
import { hashValue } from './artifacts';
import { RunnerError, type openRunStore } from './store';

type PopulationRouteOptions = {
  applications: StudyApplication[];
  origin: string;
  getApplicationContext?: (application: StudyApplication) => Promise<ApplicationContext>;
  getBuildId?: () => Promise<string>;
  validateStudyUser?: (application: StudyApplication, user: StudyUser) => void;
  executionMode: RunRecord['executionMode'];
  replayAvailable: boolean;
  startWorker: () => void;
};

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RunnerError(400, 'validation', 'Request does not match the expected schema');
  return result.data;
}

export function registerPopulationRoutes(
  app: FastifyInstance, store: ReturnType<typeof openRunStore>['populations'], options: PopulationRouteOptions,
) {
  const applications = structuredClone(options.applications).filter(application => {
    if (!URL.canParse(application.origin)) return false;
    const url = new URL(application.origin);
    return url.origin === options.origin && !url.username && !url.password;
  });
  const launching = new Map<string, { requestId: string; hash: string; promise: Promise<PopulationExecution> }>();

  function requireApplication(id: string) {
    const application = applications.find(item => item.id === id);
    if (!application) throw new RunnerError(404, 'not_found', 'Connected application does not exist');
    return application;
  }

  async function captureContext(application: StudyApplication) {
    try {
      if (!options.getApplicationContext) throw new Error('Missing application context provider');
      const context = await options.getApplicationContext(structuredClone(application));
      if (context.applicationId !== application.id) throw new Error('Application context identity mismatch');
      return context;
    } catch {
      throw new RunnerError(503, 'context_unavailable', 'Could not capture connected application context');
    }
  }

  app.get<{ Params: { id: string } }>('/api/applications/:id/context', async request =>
    captureContext(requireApplication(request.params.id)),
  );
  app.get('/api/populations', async () => store.listPopulations());
  app.get<{ Params: { id: string } }>('/api/populations/:id', async request => store.getPopulationDetail(request.params.id));
  app.post('/api/populations', async (request, reply) => {
    const input = parse(EnrollPopulationRequestSchema, request.body);
    return reply.code(201).send(store.enroll(input, requireApplication));
  });

  app.post<{ Params: { id: string } }>('/api/populations/:id/executions', async (request, reply) => {
    const input = parse(LaunchPopulationRequestSchema, request.body);
    const { id } = request.params;
    const previous = store.getLaunch(id, input);
    if (previous) {
      options.startWorker();
      return reply.code(202).send(previous);
    }
    const hash = hashValue(input);
    const pending = launching.get(id);
    if (pending) {
      if (pending.requestId !== input.requestId) throw new RunnerError(409, 'population_active', 'Population already has an active launch');
      if (pending.hash !== hash) throw new RunnerError(409, 'request_conflict', 'Request ID already has a different payload');
      return reply.code(202).send(await pending.promise);
    }

    const population = store.requirePopulation(id);
    if (population.origin !== options.origin) {
      throw new RunnerError(409, 'origin_changed', 'The connected application origin changed since enrollment');
    }
    const application = requireApplication(population.applicationId);
    if (input.mode === 'checkpoint' && !options.replayAvailable) {
      throw new RunnerError(503, 'execution_unavailable', 'Replay execution is unavailable');
    }
    const commit = store.prepareLaunch(population, input, application, options.executionMode, options.validateStudyUser);
    const promise = Promise.resolve().then(async () => {
      const applicationContext = options.getApplicationContext ? await captureContext(application) : undefined;
      let buildId;
      try {
        buildId = await options.getBuildId?.();
        if (typeof buildId !== 'string' || !buildId.trim()) throw new Error('Missing build identity');
      } catch {
        throw new RunnerError(503, 'build_unavailable', 'Could not identify the connected application build');
      }
      const execution = commit(buildId, applicationContext);
      options.startWorker();
      return execution;
    }).finally(() => { launching.delete(id); });
    launching.set(id, { requestId: input.requestId, hash, promise });
    return reply.code(202).send(await promise);
  });

  app.get('/api/population-executions', async () => store.listExecutions());
  app.get<{ Params: { id: string } }>('/api/population-executions/:id', async request => {
    const execution = store.getExecutionDetail(request.params.id);
    if (!execution) throw new RunnerError(404, 'not_found', 'Population execution does not exist');
    return execution;
  });
}
