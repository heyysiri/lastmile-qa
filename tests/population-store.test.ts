import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import type { LaunchPopulationRequest, PopulationExecutionDetail } from '../packages/contracts/src/populations';
import type { StudyApplication } from '../packages/contracts/src/studies';
import { createServer } from '../apps/runner/src/server';
import { openRunStore } from '../apps/runner/src/store';

it('recovers a claimed population batch, preserves queued batches, and never claims a member as a legacy run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'population-store-'));
  const databasePath = join(directory, 'runner.sqlite');
  const origin = 'http://127.0.0.1:3001';
  const application: StudyApplication = {
    id: 'seller', name: 'Seller', domain: 'Retail', origin, description: 'Store setup',
    workflows: [{ id: 'setup', description: 'Set up a store', scenario: storeScenario, defaultInputs: { storeName: 'Store' } }],
  };
  const store = openRunStore(databasePath);
  let app: ReturnType<typeof createServer> | undefined;
  let reopened: ReturnType<typeof openRunStore> | undefined;
  try {
    store.studies.beginGeneration('gen', { applicationId: application.id, domain: 'Retail', audience: 'Sellers starting an independent business', count: 1 });
    const study = store.studies.finishGeneration('gen', {
      applicationId: application.id, domain: 'Retail', audience: 'Sellers starting an independent business', count: 1,
    }, {
      draft: {
        title: 'Sellers', summary: 'Store setup study', assumptions: [],
        users: [{
          id: 'profile', name: 'Seller', summary: 'Small retail seller', assumptions: [], coverageReason: 'Store profile',
          workflowId: 'setup', goal: 'Save the store profile', context: { ...desktopContext, inputs: { storeName: 'Store' } },
        }],
      },
      generation: { source: 'model', model: 'test-model', observedPaths: [] },
    });
    expect(store).toHaveProperty('populations');
    const populations = store.populations;
    function queue(requestId: string) {
      const population = populations.enroll({ requestId, studyId: study.id, revision: study.revision, label: requestId }, () => application);
      const request: LaunchPopulationRequest = {
        mode: 'continue', requestId: 'launch', releaseLabel: 'First release',
        tasks: [{ testerId: population.testers[0].id, workflowId: 'setup', goal: 'Save the store profile', inputs: { storeName: 'Updated store' } }],
      };
      return populations.prepareLaunch(population, request, application, 'ai_guided')('build-one');
    }
    const first = queue('first');
    const second = queue('second');
    expect(store.claimNext()).toBeUndefined();
    expect(populations.claimNext()?.execution.id).toBe(first.id);
    expect(populations.claimNext()).toBeUndefined();

    reopened = openRunStore(databasePath);
    reopened.recoverInterrupted();
    expect(reopened.populations.getExecutionDetail(first.id)).toMatchObject({
      status: 'interrupted', finishedAt: expect.any(String),
      runs: [{ id: first.members[0].runId, status: 'interrupted', verdict: 'inconclusive' }],
    });
    expect(reopened.populations.getExecutionDetail(second.id)).toMatchObject({
      status: 'queued', runs: [{ id: second.members[0].runId, status: 'queued', verdict: null }],
    });
    expect(reopened.claimNext()).toBeUndefined();

    const executeRun = vi.fn();
    app = createServer({ databasePath, sellerDemoUrl: 'http://127.0.0.1:3002', apiToken: 'test', executeRun });
    await app.listen({ host: '127.0.0.1', port: 0 });
    await vi.waitFor(async () => {
      const response = await app!.inject({
        url: `/api/population-executions/${second.id}`, headers: { authorization: 'Bearer test' },
      });
      expect(response.json<PopulationExecutionDetail>()).toMatchObject({
        status: 'completed',
        runs: [{ status: 'completed', verdict: 'inconclusive', findings: [{ description: expect.stringMatching(/origin changed/i) }] }],
      });
    });
    expect(executeRun).not.toHaveBeenCalled();
  } finally {
    await app?.close();
    reopened?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
