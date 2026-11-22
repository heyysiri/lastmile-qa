import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createGitHubCredentials } from '../apps/runner/src/github-credentials';
import { createServer } from '../apps/runner/src/server';
import { openRunStore } from '../apps/runner/src/store';
import { ConnectProjectSchema } from '../packages/contracts/src/projects';
import { createTenantServer } from '../apps/runner/src/tenant-server';

const apiToken = 'tenant-test-secret-for-the-trusted-proxy';
const authorization = `Bearer ${apiToken}`;
const tenantHeaders = (user: string) => ({ authorization, 'x-lastmile-user-id': user });
const apps: ReturnType<typeof createTenantServer>[] = [];
const roots: string[] = [];

const projectBody = (root: string, name: string) => ({
  requestId: 'same-request',
  name,
  repositoryPath: root,
  appUrl: 'http://127.0.0.1:9998',
  brief: 'Review the warehouse inventory workflow',
  accounts: [{ label: 'Staff', username: 'staff@example.test', password: 'test-password' }],
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'runner-tenants-'));
  roots.push(root);
  const opened: string[] = [];
  const start = () => {
    const app = createTenantServer({
      root,
      apiToken,
      createWorkspace: directory => {
        opened.push(directory);
        return createServer({
          databasePath: join(directory, 'runner.sqlite'), artifactRoot: join(directory, 'runs'), apiToken,
          githubCredentials: createGitHubCredentials({
            directory: join(directory, 'credentials'),
            fetch: async () => new Response(null, { status: 200 }),
          }),
        });
      },
    });
    apps.push(app);
    return app;
  };
  return { root, start, opened };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('requires the trusted bearer and a valid Clerk user header before opening any workspace', async () => {
  const { root, start } = await setup();
  const app = start();
  expect((await app.inject({ url: '/api/health' })).json()).toEqual({ status: 'ok' });
  expect((await app.inject({ url: '/api/projects', headers: { 'x-lastmile-user-id': 'user_forged' } })).statusCode).toBe(401);
  expect((await app.inject({ url: '/' })).statusCode).toBe(401);
  for (const headers of [
    { authorization },
    { ...tenantHeaders('user_forged'), authorization: 'Bearer another-secret' },
    tenantHeaders('../outside'),
    tenantHeaders('user_good,user_other'),
  ]) {
    expect((await app.inject({ url: '/api/projects?userId=user_forged', headers })).statusCode).toBe(401);
  }
  expect(await readdir(root)).toEqual([]);
});

it('isolates project records and request IDs across users and reopens persisted records', async () => {
  const { root, start, opened } = await setup();
  const app = start();
  const alice = tenantHeaders('user_alice');
  const bob = tenantHeaders('user_bob');
  const connect = (headers: typeof alice, name: string) => app.inject({
    url: '/api/projects',
    method: 'POST',
    headers,
    payload: projectBody(root, name),
  });

  const [aliceProject, aliceRetry, bobProject] = await Promise.all([
    connect(alice, 'Alice project'), connect(alice, 'Alice project'), connect(bob, 'Bob project'),
  ]);
  expect(aliceProject.statusCode).toBe(202);
  expect(bobProject.statusCode).toBe(202);
  const aliceId = aliceProject.json().id;
  const bobId = bobProject.json().id;
  expect(opened).toHaveLength(2);
  expect(aliceRetry.json().id).toBe(aliceId);
  expect(aliceId).not.toBe(bobId);
  expect((await app.inject({ url: `/api/projects/${aliceId}`, headers: bob })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/projects/by-request/same-request', headers: alice })).json().id).toBe(aliceId);

  await app.close();
  const reopened = start();
  expect((await reopened.inject({ url: '/api/projects', headers: alice })).json()).toMatchObject([{ id: aliceId }]);
  expect((await reopened.inject({ url: '/api/projects', headers: bob })).json()).toMatchObject([{ id: bobId }]);
});

it('keeps saved GitHub credentials private to each workspace across restart', async () => {
  const { start } = await setup();
  const app = start();
  const alice = tenantHeaders('user_alice');
  const bob = tenantHeaders('user_bob');
  const url = '/api/settings/github';
  const fakeToken = 'github_pat_fixture_alice';
  const saved = await app.inject({ method: 'PUT', url, headers: alice, payload: { token: fakeToken } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ configured: true, source: 'saved' });
  expect(saved.body).not.toContain(fakeToken);
  expect((await app.inject({ url, headers: bob })).json()).toEqual({ configured: false, source: 'none' });

  await app.close();
  const reopened = start();
  expect((await reopened.inject({ url, headers: alice })).json()).toEqual({ configured: true, source: 'saved' });
  expect((await reopened.inject({ url, headers: bob })).json()).toEqual({ configured: false, source: 'none' });
});

it('preserves binary artifact responses', async () => {
  const { root } = await setup();
  const bytes = Buffer.from([0, 255, 128, 42]);
  const app = createTenantServer({
    root, apiToken,
    createWorkspace: () => {
      const child = Fastify();
      child.get('/api/runs/run/artifacts/image.png', async (_request, reply) => reply.type('image/png').header('x-content-type-options', 'nosniff').send(bytes));
      return child;
    },
  });
  apps.push(app);
  const response = await app.inject({ url: '/api/runs/run/artifacts/image.png', headers: tenantHeaders('user_alice') });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('image/png');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.rawPayload).toEqual(bytes);
});


it('resumes a workspace queue when its owner returns after a restart', async () => {
  const { root } = await setup();
  const user = 'user_returning';
  const directory = join(root, createHash('sha256').update(user).digest('hex'));
  await mkdir(directory);
  const databasePath = join(directory, 'runner.sqlite');
  const store = openRunStore(databasePath);
  const interrupted = store.projects.connect(ConnectProjectSchema.parse(projectBody(root, 'Interrupted project')));
  expect(store.projects.claimNext()?.projectId).toBe(interrupted.id);
  const queued = store.projects.connect(ConnectProjectSchema.parse({
    ...projectBody(root, 'Queued project'), requestId: 'another-request',
  }));
  store.close();

  const discovered: string[] = [];
  const app = createTenantServer({
    root, apiToken,
    createWorkspace: directory => createServer({
      databasePath: join(directory, 'runner.sqlite'), apiToken, startOnReady: true,
      projectRuntime: {
        async discover(project) {
          discovered.push(project.id);
          throw new Error('Fixture discovery failure');
        },
        async execute() { throw new Error('Unexpected run'); },
      },
    }),
  });
  apps.push(app);
  const get = async (id: string) => (await app.inject({ url: `/api/projects/${id}`, headers: tenantHeaders(user) })).json();
  await expect.poll(async () => (await get(queued.id)).status).toBe('failed');
  expect(await get(interrupted.id)).toMatchObject({ status: 'failed', progress: 'Discovery interrupted' });
  expect(discovered).toEqual([queued.id]);
});
