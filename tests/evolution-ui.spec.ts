import { expect, test, type Page } from '@playwright/test';
import { desktopContext, inventoryScenario } from '../packages/contracts/src/examples';
import type { PrepareRepairRequest, RepairJob, RepairTrial, SuggestionJob, SuggestJourneysRequest, VerifyRepairRequest } from '../packages/contracts/src/evolution';
import type { LaunchPopulationRequest, PopulationDetail, PopulationExecutionDetail } from '../packages/contracts/src/populations';
import type { EvidenceRun } from '../packages/contracts/src/runtime';
import type { StudyApplication } from '../packages/contracts/src/studies';

test.use({ baseURL: 'http://127.0.0.1:3100' });

const createdAt = '2026-11-20T08:00:00.000Z';
const hash = 'a'.repeat(64);
const newHash = 'b'.repeat(64);
const application: StudyApplication = {
  id: 'seller', name: 'Seller Hub', domain: 'Retail', origin: 'http://127.0.0.1:3001', description: 'Manage inventory.',
  workflows: [{ id: inventoryScenario.id, description: 'Change stock.', scenario: inventoryScenario, defaultInputs: { quantity: 5 } }],
};
const population: PopulationDetail = {
  id: 'shops', label: 'Shop owners', applicationId: application.id, origin: application.origin, studyId: 'study-1', studyRevision: 1, createdAt,
  testers: ['Mina', 'Leo'].map(name => ({
    id: name.toLowerCase(), initialStateId: 'seed',
    profile: {
      id: name.toLowerCase(), name, summary: 'A returning seller.', coverageReason: 'Checks saved stock.', assumptions: [],
      workflowId: inventoryScenario.id, goal: 'Save stock.', context: { ...desktopContext, inputs: { quantity: 5 } },
    },
  })),
  episodes: [],
};
const context = {
  applicationId: application.id, version: 'context-1', capturedAt: createdAt,
  sources: [{ kind: 'code' as const, path: 'src/inventory.ts', excerpt: 'saveStock(quantity)', digest: hash }],
};

function run(id: string, failing: boolean): EvidenceRun {
  return {
    id, requestId: id, createdAt, status: 'completed', verdict: failing ? 'failed' : 'passed', executionMode: 'deterministic',
    scenario: inventoryScenario, context: desktopContext, inputs: { quantity: 5 }, manifestHash: hash,
    steps: [{ index: 1, timestamp: createdAt, action: 'Save', observation: 'The stock editor saved.' }],
    assertions: [{ id: 'quantity', status: failing ? 'failed' : 'passed', expected: 5, actual: failing ? 1 : 5 }],
    findings: [], capabilities: [], artifacts: [],
  };
}

const execution: PopulationExecutionDetail = {
  id: 'candidate', requestId: 'checkpoint-1', populationId: population.id, population, buildId: 'candidate-build',
  mode: 'checkpoint', status: 'completed', createdAt, releaseLabel: 'Candidate release',
  members: [{ testerId: 'mina', runId: 'candidate-mina' }, { testerId: 'leo', runId: 'candidate-leo' }],
  runs: [{ ...run('candidate-mina', true), artifacts: ['candidate-mina/final.png'] }, run('candidate-leo', false)],
  comparisons: [
    { testerId: 'mina', baselineRunId: 'baseline-mina', outcome: 'regression', message: 'Expected stock 5 and saw 1.' },
    { testerId: 'leo', baselineRunId: 'baseline-leo', outcome: 'still_passing', message: 'Stock stayed at 5.' },
  ],
};
const trials: RepairTrial[] = [
  { testerId: 'mina', role: 'regression', outcome: 'failed', message: 'The retained case still fails.', run: run('trial-mina', true) },
  { testerId: 'leo', role: 'control', outcome: 'passed', message: 'The control still passes.', run: run('trial-leo', false) },
];

async function mockEvolution(page: Page, options: {
  ready?: boolean; ineligible?: boolean; loseSuggestion?: boolean; failSuggestion?: boolean;
  losePrepare?: boolean; loseVerify?: boolean; acceptLostVerify?: boolean; stalePatch?: boolean;
  outcome?: 'verified' | 'rejected' | 'inconclusive'; existingRepair?: boolean;
} = {}) {
  const suggestions: SuggestJourneysRequest[] = [];
  const preparations: PrepareRepairRequest[] = [];
  const verifications: VerifyRepairRequest[] = [];
  const launches: LaunchPopulationRequest[] = [];
  let suggestion: SuggestionJob | undefined;
  let repair: RepairJob | undefined;
  const patch = {
    hash, summary: 'Preserve the submitted stock quantity.',
    changes: [{ path: 'src/inventory.ts', beforeHash: hash, before: `export const stock = '${'x'.repeat(350)}';`, after: 'export const stock = submitted;' }],
  };
  const preparing = (request: PrepareRepairRequest): RepairJob => ({
    id: 'repair-1', request, populationId: population.id, status: 'running', stage: 'prepare', createdAt, snapshot: { execution, context },
  });
  if (options.existingRepair) repair = { ...preparing({ requestId: 'existing', executionId: execution.id }), status: 'awaiting_review', patch, reproduction: trials };
  await page.route('**/api/runner/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/runner/', '');
    const request = `${route.request().method()} ${path}`;
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    switch (request) {
      case 'GET health': return reply({ status: 'ok', modelConfigured: true, executionReady: true, suggestionsReady: options.ready ?? true, repairsReady: options.ready ?? true });
      case 'GET applications': return reply([application]);
      case 'GET applications/seller/context': return reply(context);
      case 'GET populations/shops': return reply(population);
      case 'GET population-executions': return reply([]);
      case 'GET population-executions/candidate':
        return reply(options.ineligible ? { ...execution, comparisons: [...execution.comparisons!, { testerId: 'other', outcome: 'inconclusive' }] } : execution);
      case 'GET populations/shops/suggestions': return reply(suggestion ? [suggestion] : []);
      case 'POST populations/shops/suggestions': {
        const request = route.request().postDataJSON() as SuggestJourneysRequest;
        suggestions.push(request);
        if (suggestion?.request.requestId !== request.requestId) suggestion = {
          id: `suggestion-${suggestions.length}`, populationId: population.id, request, status: 'queued', createdAt,
          snapshot: { population, application, context, objective: request.objective },
        };
        return options.loseSuggestion && suggestions.length === 1 ? route.abort('failed') : reply(suggestion, 202);
      }
      case `GET suggestions/${suggestion?.id}`: return reply(suggestion);
      case 'POST populations/shops/executions':
        launches.push(route.request().postDataJSON());
        return reply(execution, 202);
      case 'GET repairs': return reply(url.searchParams.get('populationId') === population.id && repair ? [repair] : []);
      case 'POST repairs': {
        const request = route.request().postDataJSON() as PrepareRepairRequest;
        preparations.push(request);
        repair ??= preparing(request);
        return options.losePrepare && preparations.length === 1 ? route.abort('failed') : reply(repair, 202);
      }
      case 'GET repairs/repair-1': return repair ? reply(repair) : reply({ message: 'Repair missing.' }, 404);
      case 'POST repairs/repair-1/verify': {
        const request = route.request().postDataJSON() as VerifyRepairRequest;
        verifications.push(request);
        if (!repair) return reply({ message: 'Repair missing.' }, 404);
        if (options.stalePatch && verifications.length === 1) {
          repair = { ...repair, patch: { ...patch, hash: newHash, summary: 'Use the updated stock calculation.' } };
          return reply({ code: 'stale_patch', message: 'The patch changed. Review it again.' }, 409);
        }
        if (options.loseVerify && verifications.length === 1) return route.abort('failed');
        repair = { ...repair, stage: 'verify', status: 'queued', verificationRequest: request };
        return options.acceptLostVerify && verifications.length === 1 ? route.abort('failed') : reply(repair, 202);
      }
      default: return reply({ message: `Unexpected fixture request: ${request}` }, 404);
    }
  });
  return {
    suggestions, preparations, verifications, launches,
    finishSuggestions: () => {
      if (!suggestion) throw new Error('No suggestion job');
      suggestion = options.failSuggestion ? { ...suggestion, status: 'completed', error: 'Generation failed.' } : {
        ...suggestion, status: 'completed', suggestions: [{
          task: { testerId: 'mina', workflowId: inventoryScenario.id, goal: 'Confirm inventory persists after saving.', inputs: { quantity: 12 } },
          reason: 'The inventory save path and the previous edit support this hypothesis.',
          sourcePaths: ['src/inventory.ts'], historyRunIds: ['baseline-mina'], assumptions: ['The seller edits the same item again.'],
        }],
      };
    },
    finishPreparation: (result: 'patch' | 'failure' = 'patch') => {
      if (!repair) throw new Error('No repair job');
      repair = result === 'patch'
        ? { ...repair, status: 'awaiting_review', patch, reproduction: trials }
        : { ...repair, status: 'completed', reproduction: trials, error: 'The retained failure could not be reproduced.' };
    },
    finishVerification: () => {
      if (!repair) throw new Error('No repair job');
      const outcome = options.outcome ?? 'rejected';
      const regression: RepairTrial = outcome === 'verified'
        ? { ...trials[0], outcome: 'passed', message: 'The retained case now passes.', run: run('verify-mina', false) }
        : outcome === 'inconclusive'
          ? { ...trials[0], outcome: 'inconclusive', message: 'The browser disconnected.', run: { ...run('verify-mina', true), verdict: 'inconclusive', assertions: [] } }
          : trials[0];
      repair = {
        ...repair, status: 'completed',
        verification: { outcome, message: outcome === 'inconclusive' ? 'Browser disconnected during the retained checks.' : 'Retained checks finished.', trials: [regression, trials[1]] },
      };
    },
  };
}

test('recovers a lost suggestion response and explicitly applies editable journey inputs', async ({ page }) => {
  const mock = await mockEvolution(page, { loseSuggestion: true });
  await page.goto('/populations/shops');
  await page.getByLabel('Objective (optional)').fill('  Explore repeat edits  ');
  await page.getByRole('button', { name: 'Suggest next journeys' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  await page.reload();
  await expect(page.getByLabel('Objective (optional)')).toHaveValue('Explore repeat edits');
  await page.getByRole('button', { name: 'Recover suggestions request' }).click();
  await expect.poll(() => mock.suggestions.length).toBe(2);
  expect(mock.suggestions[1]).toEqual(mock.suggestions[0]);
  mock.finishSuggestions();
  await expect(page.getByText(/suggestions are hypotheses/i)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Plan the next journeys' }).getByText('src/inventory.ts')).toBeVisible();
  await expect(page.getByRole('link', { name: 'baseline-mina' })).toHaveAttribute('href', '/runs/baseline-mina');
  await expect(page.getByText('The seller edits the same item again.')).toBeVisible();
  await page.reload();
  const quantity = page.getByRole('group', { name: 'Next task for Mina' }).getByRole('spinbutton', { name: 'Quantity' });
  await expect(quantity).toHaveValue('5');
  await page.getByRole('button', { name: 'Apply suggestions' }).click();
  await expect(quantity).toHaveValue('12');
  expect(mock.launches).toHaveLength(0);
  await quantity.fill('42');
  await page.getByLabel('Release label').fill('Follow-up');
  await page.getByRole('button', { name: 'Continue with these tasks' }).click();
  await expect.poll(() => mock.launches).toMatchObject([{ tasks: [{ testerId: 'mina', inputs: { quantity: 42 } }, { testerId: 'leo', inputs: { quantity: 5 } }] }]);
});

test('terminal suggestion failure only starts a fresh request on explicit generation', async ({ page }) => {
  const mock = await mockEvolution(page, { failSuggestion: true });
  await page.goto('/populations/shops');
  await page.getByRole('button', { name: 'Suggest next journeys' }).click();
  await expect.poll(() => mock.suggestions.length).toBe(1);
  mock.finishSuggestions();
  await expect(page.getByText('Generation failed.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Generation failed.')).toBeVisible();
  expect(mock.suggestions).toHaveLength(1);
  await page.getByRole('button', { name: 'Suggest next journeys' }).click();
  await expect.poll(() => mock.suggestions.length).toBe(2);
  expect(mock.suggestions[1].requestId).not.toBe(mock.suggestions[0].requestId);
});

test('recovers preparation and verification across reload and shows rejected retained checks at mobile width', async ({ page }) => {
  const mock = await mockEvolution(page, { losePrepare: true, loseVerify: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/populations/shops/executions/candidate');
  await page.getByRole('button', { name: 'Prepare repair' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  await page.reload();
  await page.getByRole('button', { name: 'Recover repair request' }).click();
  await expect(page).toHaveURL(/\/repairs\/repair-1$/);
  expect(mock.preparations).toHaveLength(2);
  expect(mock.preparations[1]).toEqual(mock.preparations[0]);
  await expect(page.getByText('Preparing repair', { exact: true })).toBeVisible();
  await page.reload();
  mock.finishPreparation();
  await expect(page.getByText('Preserve the submitted stock quantity.')).toBeVisible();
  await expect(page.getByText(hash, { exact: true })).toBeVisible();
  await page.getByText('src/inventory.ts', { exact: true }).click();
  await expect(page.getByText(/export const stock = 'x/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const reproduction = page.getByRole('region', { name: 'Reproduction evidence' });
  await expect(reproduction.getByText('Original failing case')).toBeVisible();
  await expect(reproduction.getByText('Passing control')).toBeVisible();
  await expect(reproduction.getByText('Observed 1')).toBeVisible();
  await expect(reproduction.getByRole('link', { name: 'Original comparison evidence' }).first()).toHaveAttribute('href', '/runs/candidate-mina');
  await expect(reproduction.getByRole('link', { name: 'Original comparison screenshot' })).toHaveAttribute('href', '/api/runner/runs/candidate-mina/artifacts/final.png');
  expect(mock.verifications).toHaveLength(0);
  await page.getByRole('button', { name: 'Verify patch' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  await page.reload();
  await page.getByRole('button', { name: 'Recover verification request' }).click();
  await expect(page.getByText('Verification queued', { exact: true })).toBeVisible();
  expect(mock.verifications).toHaveLength(2);
  expect(mock.verifications[1]).toEqual(mock.verifications[0]);
  expect(mock.verifications[0].patchHash).toBe(hash);
  await page.reload();
  mock.finishVerification();
  await expect(page.getByRole('status').filter({ hasText: 'Repair rejected' })).toBeVisible();
  const verification = page.getByRole('region', { name: 'Verification evidence' });
  await expect(verification.getByText('Original failing case')).toBeVisible();
  await expect(verification.getByText('Passing control')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify patch' })).toHaveCount(0);
});

test('refreshes a stale patch without sending a second write and distinguishes inconclusive verification', async ({ page }) => {
  const mock = await mockEvolution(page, { stalePatch: true, outcome: 'inconclusive', existingRepair: true });
  await page.goto('/repairs/repair-1');
  await page.getByRole('button', { name: 'Verify patch' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('The patch changed. Review it again.');
  await expect(page.getByText(newHash, { exact: true })).toBeVisible();
  expect(mock.verifications).toHaveLength(1);
  await page.getByRole('button', { name: 'Verify patch' }).click();
  await expect(page.getByText('Verification queued', { exact: true })).toBeVisible();
  expect(mock.verifications[1].patchHash).toBe(newHash);
  expect(mock.verifications[1].requestId).not.toBe(mock.verifications[0].requestId);
  mock.finishVerification();
  await expect(page.getByRole('status').filter({ hasText: 'Verification inconclusive' })).toBeVisible();
  await expect(page.getByText('Browser disconnected during the retained checks.')).toBeVisible();
  await expect(page.getByText('Repair rejected')).toHaveCount(0);
});

test('recognizes a verification accepted before its response was lost and presents manual follow-through', async ({ page }) => {
  const mock = await mockEvolution(page, { acceptLostVerify: true, outcome: 'verified', existingRepair: true });
  await page.goto('/repairs/repair-1');
  await page.getByRole('button', { name: 'Verify patch' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  await page.reload();
  await expect(page.getByText('Verification queued', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Verify patch|Recover verification/ })).toHaveCount(0);
  mock.finishVerification();
  await expect(page.getByRole('status').filter({ hasText: 'Repair verified' })).toBeVisible();
  await expect(page.getByText(/isolated patch passed the retained checks.*apply it manually/i)).toBeVisible();
  expect(mock.verifications).toHaveLength(1);
});

test('hides repair preparation for inconclusive comparisons and respects readiness flags', async ({ page }) => {
  await mockEvolution(page, { ineligible: true, ready: false });
  await page.goto('/populations/shops/executions/candidate');
  await expect(page.getByRole('heading', { name: 'Candidate release' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare repair' })).toHaveCount(0);
  await page.goto('/populations/shops');
  await expect(page.getByRole('button', { name: 'Suggest next journeys' })).toBeDisabled();
  await expect(page.getByText('Journey suggestions are unavailable.')).toBeVisible();
});

test('keeps an existing repair review readable when verification is unavailable', async ({ page }) => {
  const mock = await mockEvolution(page, { ready: false, existingRepair: true });
  await page.goto('/populations/shops/executions/candidate');
  await expect(page.getByText('Repair preparation is unavailable.')).toBeVisible();
  await page.getByRole('link', { name: 'Review proposed patch' }).click();
  await expect(page.getByRole('button', { name: 'Verify patch' })).toBeDisabled();
  await expect(page.getByText('Patch verification is unavailable.')).toBeVisible();
  expect(mock.preparations).toHaveLength(0);
  expect(mock.verifications).toHaveLength(0);
});

test('shows a failed preparation and its evidence without presenting a verification action', async ({ page }) => {
  const mock = await mockEvolution(page);
  await page.goto('/populations/shops/executions/candidate');
  await page.getByRole('button', { name: 'Prepare repair' }).click();
  await expect(page).toHaveURL(/\/repairs\/repair-1$/);
  mock.finishPreparation('failure');
  await expect(page.getByRole('status').filter({ hasText: 'No patch proposed' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('The retained failure could not be reproduced.');
  await expect(page.getByRole('region', { name: 'Reproduction evidence' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify patch' })).toHaveCount(0);
});
