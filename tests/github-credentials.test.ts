import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitHubCredentials } from '../apps/runner/src/github-credentials';
import { createServer } from '../apps/runner/src/server';
import { resolveProxyTarget } from '../apps/lastmile/lib/proxy-policy';

const roots: string[] = [];
const apps: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'github-credentials-')); roots.push(root); return root; }
const validFetch = () => vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));

it('persists encrypted credentials across restart without exposing the token in status', async () => {
  const directory = fixture(); const fetcher = validFetch();
  const credentials = createGitHubCredentials({ directory, fetch: fetcher });
  expect(credentials.status()).toEqual({ configured: false, source: 'none' });
  expect(() => credentials.token()).toThrow(/Save a GitHub/);
  await credentials.save('github_pat_fixture_private');
  expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/user');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer github_pat_fixture_private' } });
  expect(credentials.status()).toEqual({ configured: true, source: 'saved' });
  for (const file of readdirSync(directory)) {
    expect(readFileSync(join(directory, file), 'utf8')).not.toContain('github_pat_fixture_private');
    expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  }
  expect(createGitHubCredentials({ directory }).token()).toBe('github_pat_fixture_private');
});

it('saved tokens override the environment fallback and can be replaced', async () => {
  const directory = fixture(); const credentials = createGitHubCredentials({ directory, fallback: 'old-env-token', fetch: validFetch() });
  expect(credentials.status()).toEqual({ configured: true, source: 'environment' });
  await credentials.save('first_saved_token'); await credentials.save('replacement_token');
  expect(credentials.token()).toBe('replacement_token');
  expect(createGitHubCredentials({ directory, fallback: 'old-env-token' }).token()).toBe('replacement_token');
});

it('keeps the previous credential when validation fails and never echoes provider errors', async () => {
  const directory = fixture(); const fetcher = validFetch();
  const credentials = createGitHubCredentials({ directory, fallback: 'working-token', fetch: fetcher });
  fetcher.mockResolvedValueOnce(new Response('invalid-token-secret', { status: 401 }));
  await expect(credentials.save('invalid-token-secret')).rejects.toThrow('GitHub rejected this token');
  fetcher.mockRejectedValueOnce(new Error('provider echoed invalid-token-secret'));
  await expect(credentials.save('invalid-token-secret')).rejects.toThrow('Could not validate the token with GitHub');
  expect(credentials.token()).toBe('working-token');
  for (const token of ['', 'a b', 'a\nb', 'x'.repeat(1001)]) await expect(credentials.save(token)).rejects.toThrow(/valid/);
});

it('protects credential routes, returns status only, and accepts saving without restarting the server', async () => {
  const root = fixture(); const credentials = createGitHubCredentials({ directory: join(root, 'credentials'), fetch: validFetch() });
  const app = createServer({ databasePath: join(root, 'qa.sqlite'), apiToken: 'runner-test', githubCredentials: credentials }); apps.push(app);
  expect((await app.inject({ method: 'PUT', url: '/api/settings/github', payload: { token: 'private_token' } })).statusCode).toBe(401);
  const headers = { authorization: 'Bearer runner-test' };
  expect((await app.inject({ method: 'GET', url: '/api/settings/github', headers })).json()).toEqual({ configured: false, source: 'none' });
  const saved = await app.inject({ method: 'PUT', url: '/api/settings/github', headers, payload: { token: 'private_token' } });
  expect(saved.statusCode).toBe(200); expect(saved.json()).toEqual({ configured: true, source: 'saved' });
  expect(saved.body).not.toContain('private_token'); expect(credentials.token()).toBe('private_token');
  const rejected = await app.inject({ method: 'PUT', url: '/api/settings/github', headers, payload: { token: 123 } });
  expect(rejected.statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url: '/api/settings/github', headers: { ...headers, origin: 'https://foreign.test' }, payload: { token: 'private_token' } })).statusCode).toBe(401);
  expect(resolveProxyTarget('GET', ['settings', 'github'])).toBe('/api/settings/github');
  expect(resolveProxyTarget('PUT', ['settings', 'github'])).toBe('/api/settings/github');
  expect(resolveProxyTarget('POST', ['settings', 'github'])).toBeNull();
});
