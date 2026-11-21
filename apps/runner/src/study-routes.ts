import type { FastifyInstance } from 'fastify';
import type { RunRecord } from '@lastmile/contracts';
import {
  GenerateStudyRequestSchema, LaunchStudyRequestSchema, SaveStudyRequestSchema, validateStudyDraft,
  type GenerateStudy, type Study, type StudyApplication, type StudyExecution, type StudyUser,
} from '@lastmile/contracts/studies';
import { z } from 'zod';
import { RunnerError, type openRunStore } from './store';

const GenerationMetadataSchema = z.object({
  source: z.literal('model'), model: z.string().trim().min(1), observedPaths: z.array(z.string()),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new RunnerError(400, 'validation', 'Request does not match the expected schema');
  return result.data;
}

type StudyRouteOptions = {
  applications: StudyApplication[];
  origin: string;
  generateStudy?: GenerateStudy;
  validateStudyUser?: (application: StudyApplication, user: StudyUser) => void;
  getBuildId?: () => Promise<string>;
  executionMode: RunRecord['executionMode'];
  startWorker: () => void;
};

export function registerStudyRoutes(
  app: FastifyInstance, store: ReturnType<typeof openRunStore>['studies'], options: StudyRouteOptions,
) {
  const applications = structuredClone(options.applications).filter(application => {
    if (!URL.canParse(application.origin)) return false;
    const url = new URL(application.origin);
    return url.origin === options.origin && !url.username && !url.password;
  });
  const generating = new Map<string, Promise<Study>>();
  const launching = new Map<string, { studyId: string; revision: number; promise: Promise<StudyExecution> }>();

  function requireApplication(id: string) {
    const application = applications.find(item => item.id === id);
    if (!application) throw new RunnerError(404, 'not_found', 'Connected application does not exist');
    return application;
  }

  function validatedDraft(value: unknown, application: StudyApplication, count?: number) {
    const draft = validateStudyDraft(value, application, count);
    for (const user of draft.users) options.validateStudyUser?.(application, user);
    return draft;
  }

  app.get('/api/applications', async () => applications);
  app.get('/api/studies', async () => store.listStudies());
  app.get<{ Params: { id: string } }>('/api/studies/:id', async request => store.requireStudy(request.params.id));
  app.post('/api/studies/generate', async (request, reply) => {
    const { requestId, ...brief } = parse(GenerateStudyRequestSchema, request.body);
    let previous = store.getGeneration(requestId, brief);
    const generate = options.generateStudy;
    if (!previous) {
      const application = requireApplication(brief.applicationId);
      if (!generate) throw new RunnerError(503, 'generation_unavailable', 'Study generation is unavailable');
      previous = store.beginGeneration(requestId, brief);
      if (!previous) {
        const pending = Promise.resolve().then(async () => {
          let generated;
          try {
            const output = await generate(structuredClone(brief), structuredClone(application));
            generated = {
              draft: validatedDraft(output.draft, application, brief.count),
              generation: GenerationMetadataSchema.parse(output.generation),
            };
          } catch {
            store.failGeneration(requestId);
            throw new RunnerError(502, 'generation_failed', 'Could not generate a valid study. Review the audience and submit a new request.');
          }
          return store.finishGeneration(requestId, brief, generated);
        }).finally(() => { generating.delete(requestId); });
        generating.set(requestId, pending);
        return reply.code(201).send(await pending);
      }
    }
    if (previous.study) return reply.code(201).send(previous.study);
    const pending = generating.get(requestId);
    if (pending) return reply.code(201).send(await pending);
    if (previous.status === 'pending') throw new RunnerError(409, 'generation_pending', 'Study generation is already in progress');
    if (previous.status === 'interrupted') {
      throw new RunnerError(409, 'generation_interrupted', 'Generation was interrupted. Submit a new request.');
    }
    throw new RunnerError(409, 'generation_failed', 'Generation failed. Submit a new request.');
  });

  app.put<{ Params: { id: string } }>('/api/studies/:id', async request => {
    const { revision, ...input } = parse(SaveStudyRequestSchema, request.body);
    const study = store.requireStudy(request.params.id, revision);
    const application = requireApplication(study.brief.applicationId);
    let draft;
    try {
      draft = validatedDraft(input, application);
    } catch {
      throw new RunnerError(400, 'invalid_study', 'Use distinct testers with supported workflows and valid input values');
    }
    return store.saveDraft(study.id, revision, draft);
  });

  app.post<{ Params: { id: string } }>('/api/studies/:id/launch', async (request, reply) => {
    const launch = parse(LaunchStudyRequestSchema, request.body);
    const { id } = request.params;
    const previous = store.getLaunch(id, launch);
    if (previous) {
      options.startWorker();
      return reply.code(202).send(previous);
    }
    const inFlight = launching.get(launch.requestId);
    if (inFlight) {
      if (inFlight.studyId !== id || inFlight.revision !== launch.revision) {
        throw new RunnerError(409, 'request_conflict', 'Launch request ID already has a different payload');
      }
      return reply.code(202).send(await inFlight.promise);
    }

    const study = store.requireStudy(id, launch.revision);
    const application = requireApplication(study.brief.applicationId);
    try {
      validatedDraft({title:study.title,summary:study.summary,assumptions:study.assumptions,users:study.users}, application);
    } catch {
      throw new RunnerError(400, 'invalid_study', 'Tester inputs must satisfy the connected workflow limits');
    }
    const promise = Promise.resolve().then(async () => {
      let buildId;
      try {
        buildId = await options.getBuildId?.();
        if (typeof buildId !== 'string' || !buildId.trim()) throw new Error('Missing build identity');
      } catch {
        throw new RunnerError(503, 'build_unavailable', 'Could not identify the connected application build');
      }
      const execution = store.launch(id, launch, application, buildId, options.executionMode);
      options.startWorker();
      return execution;
    }).finally(() => { launching.delete(launch.requestId); });
    launching.set(launch.requestId, { studyId: id, revision: launch.revision, promise });
    return reply.code(202).send(await promise);
  });

  app.get('/api/study-executions', async () => store.listExecutions());
  app.get<{ Params: { id: string } }>('/api/study-executions/:id', async request => {
    const execution = store.getExecutionDetail(request.params.id);
    if (!execution) throw new RunnerError(404, 'not_found', 'Study execution does not exist');
    return execution;
  });
}
