import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../apps/runner/src/server';

// Exercise the actual API and persistence with an isolated no-model executor.
// Live AI journeys are explicitly launched by demo:investigate instead.
export const test = base.extend<{ isolatedRunner: ReturnType<typeof createServer> }>({
  isolatedRunner: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'runner-ui-'));
    const server = createServer({ databasePath: join(directory, 'qa.sqlite'), apiToken: 'ui-test', modelConfigured: false });
    await server.ready();
    try { await use(server); } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  },
  page: async ({ page, isolatedRunner }, use) => {
    await page.route('**/api/runner/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await isolatedRunner.inject({
        method: request.method() as 'GET' | 'POST' | 'PUT',
        url: url.pathname.replace('/api/runner/', '/api/') + url.search,
        headers: { authorization: 'Bearer ui-test', ...(request.postData() ? { 'content-type': 'application/json' } : {}) },
        payload: request.postData() ?? undefined,
      });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await use(page);
  },
});
export { expect };
