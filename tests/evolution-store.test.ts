import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SuggestionJob, SuggestionSnapshot } from '../packages/contracts/src/evolution';
import { createServer } from '../apps/runner/src/server';
import { openRunStore } from '../apps/runner/src/store';

const snapshot: SuggestionSnapshot = {
  population: {
    id: 'population', applicationId: 'seller', origin: 'http://127.0.0.1:3001', label: 'Sellers',
    studyId: 'study', studyRevision: 1, createdAt: '2026-01-01T00:00:00Z', testers: [], episodes: [],
  },
  application: {
    id: 'seller', origin: 'http://127.0.0.1:3001', name: 'Seller', domain: 'Retail', description: 'Inventory', workflows: [],
  },
  context: { applicationId: 'seller', version: 'v1', capturedAt: '2026-01-01T00:00:00Z', sources: [] },
};

it('interrupts running work on listen and resumes queued work once after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evolution-store-'));
  const databasePath = join(directory, 'runner.sqlite');
  let app: ReturnType<typeof createServer> | undefined;
  try {
    const store = openRunStore(databasePath);
    const running = store.evolution.enqueueSuggestion('population', { requestId: 'running' }, { ...snapshot, objective: 'Interrupted work' });
    const queued = store.evolution.enqueueSuggestion('population', { requestId: 'queued' }, { ...snapshot, objective: 'Queued work' });
    expect(store.evolution.claimNext()).toMatchObject({ kind: 'suggestion', job: { id: running.id, status: 'running' } });
    expect(store.evolution.claimNext()).toBeUndefined();
    store.close();

    const objectives: (string | undefined)[] = [];
    app = createServer({
      databasePath, apiToken: 'store-test',
      generateSuggestions: async input => {
        objectives.push(input.objective);
        throw new Error('Test provider unavailable');
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const get = async (id: string) => (await app!.inject({
      url: `/api/suggestions/${id}`, headers: { authorization: 'Bearer store-test' },
    })).json<SuggestionJob>();
    await vi.waitFor(async () => expect(await get(queued.id)).toMatchObject({ status: 'completed' }));
    expect(await get(running.id)).toMatchObject({ status: 'interrupted', finishedAt: expect.any(String) });
    expect(objectives).toEqual(['Queued work']);
  } finally {
    await app?.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
