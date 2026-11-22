import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

type TenantServerOptions = {
  root: string;
  apiToken: string;
  createWorkspace: (directory: string) => FastifyInstance | Promise<FastifyInstance>;
};

const workspaceLimit = 16;
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createTenantServer({ root, apiToken, createWorkspace }: TenantServerOptions): FastifyInstance {
  if (!/^\S{32,}$/.test(apiToken)) {
    throw new Error('Configure RUNNER_API_TOKEN with a secret of at least 32 characters for Clerk mode');
  }

  const app = Fastify();
  const workspaceRoot = resolve(root);
  const authorization = `Bearer ${apiToken}`;
  const expectedAuth = digest(authorization);
  const workspaces = new Map<string, Promise<FastifyInstance>>();

  function openWorkspace(key: string) {
    return (async () => {
      const directory = resolve(workspaceRoot, key);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const workspace = await createWorkspace(directory);
      try {
        await workspace.ready();
        return workspace;
      } catch (error) {
        await workspace.close();
        throw error;
      }
    })().catch(error => {
      workspaces.delete(key);
      throw error;
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    const user = request.headers['x-lastmile-user-id'];
    const bearer = request.headers.authorization;
    if (request.method === 'GET' && request.url === '/api/health' && bearer === undefined && user === undefined) {
      return reply.send({ status: 'ok' });
    }

    if (!bearer || !timingSafeEqual(digest(bearer), expectedAuth) ||
        typeof user !== 'string' || !/^user_[A-Za-z0-9_-]{1,128}$/.test(user)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'Authorization is required' });
    }
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ code: 'validation', message: 'Invalid request' });
    }
    request.log.error(error);
    return reply.code(500).send({ code: 'internal_error', message: 'Runner could not process the request' });
  });

  app.all<{ Body: Buffer | undefined }>('/*', async (request, reply) => {
    // onRequest authenticates the proxy and validates its Clerk user header.
    const key = digest(request.headers['x-lastmile-user-id'] as string).toString('hex');
    let pending = workspaces.get(key);
    if (!pending) {
      if (workspaces.size >= workspaceLimit) {
        return reply.code(503).send({ code: 'capacity', message: 'Runner workspace capacity reached' });
      }
      pending = openWorkspace(key);
      workspaces.set(key, pending);
    }

    const workspace = await pending;
    const contentType = request.headers['content-type'];
    const response = await workspace.inject({
      method: request.method,
      url: request.url,
      headers: contentType ? { authorization, 'content-type': contentType } : { authorization },
      payload: request.body,
    });
    if (response.headers['content-type']) reply.header('content-type', response.headers['content-type']);
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    return reply.code(response.statusCode).send(response.rawPayload);
  });

  app.addHook('onClose', async () => {
    await Promise.all([...workspaces.values()].map(async pending => {
      const workspace = await pending;
      await workspace.close();
    }));
  });

  return app;
}
