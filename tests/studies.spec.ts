import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { desktopContext, inventoryScenario, mobileContext, storeScenario } from '../packages/contracts/src/examples';
import type { EvidenceRun } from '../packages/contracts/src/runtime';
import type { Study, StudyApplication, StudyExecutionDetail } from '../packages/contracts/src/studies';

test.use({ baseURL: process.env.STUDIES_TEST_URL ?? 'http://127.0.0.1:3000' });

const createdAt = '2026-11-20T08:00:00.000Z';
const application: StudyApplication = {
  id: 'seller-demo', name: 'Seller demo', domain: 'E-commerce', origin: 'http://127.0.0.1:3001',
  description: 'A workspace for sellers.', workflows: [
    { id: 'store-setup', description: 'Create a seller store and save its name.', scenario: storeScenario, defaultInputs: { storeName: 'Studio Supply' } },
    { id: 'inventory-update', description: 'Change the first product’s stock quantity.', scenario: inventoryScenario, defaultInputs: { quantity: 12 } },
  ],
};
const study: Study = {
  id: 'study-1', revision: 1, title: 'First day on the shop floor', summary: 'Explore setup and inventory on different screens.',
  assumptions: ['Testers already have access to the seller workspace.'],
  brief: { applicationId: application.id, domain: 'Independent shops', audience: 'New shop owners learning their way around inventory and setup.', count: 2 },
  users: [
    {
      id: 'mina', name: 'Mina Patel', summary: 'A first-time owner setting up on her phone.', coverageReason: 'Covers a compact first-time setup.',
      assumptions: ['Mina has chosen a shop name.'], workflowId: 'store-setup', goal: 'Save the storefront name.',
      context: { ...mobileContext, inputs: { storeName: 'Fern & Thread' } },
    },
    {
      id: 'leo', name: 'Leo Chan', summary: 'A returning seller updating stock between orders.', coverageReason: 'Covers a repeat inventory edit.',
      assumptions: [], workflowId: 'inventory-update', goal: 'Save the new stock quantity.',
      context: { ...desktopContext, inputs: { quantity: 8 } },
    },
  ],
  createdAt, updatedAt: createdAt, generation: { source: 'model', model: 'test-fixture', observedPaths: ['/onboarding', '/inventory'] },
};

type MockOptions = { ready?: boolean; catalogOffline?: boolean; conflict?: boolean; retryGenerate?: boolean; retryLaunch?: boolean; rejectGeneration?: 'generation_failed' | 'generation_interrupted' };

async function mockStudyApi(page: Page, options: MockOptions = {}) {
  let saved = structuredClone(study);
  let execution: StudyExecutionDetail | undefined;
  let complete = false;
  const generateIds: string[] = [];
  const launchIds: string[] = [];
  await page.route('**/api/runner/**', async route => {
    const { pathname } = new URL(route.request().url());
    const path = pathname.replace('/api/runner/', '');
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    switch (`${method} ${path}`) {
      case 'GET health': return reply({ status: 'ok', modelConfigured: options.ready ?? true, executionReady: true });
      case 'GET applications':
        return options.catalogOffline ? reply({ code: 'runner_offline', message: 'Runner connection failed.' }, 502) : reply([application]);
      case 'GET studies': return reply([saved]);
      case 'GET studies/study-1': return reply(saved);
      case 'POST studies/generate': {
        const { requestId, ...brief } = route.request().postDataJSON();
        generateIds.push(requestId);
        if (options.retryGenerate && generateIds.length === 1) return route.abort('failed');
        if (options.rejectGeneration && requestId === generateIds[0]) {
          return reply({ code: options.rejectGeneration, message: 'Please give the audience more detail.' }, options.rejectGeneration === 'generation_failed' ? 502 : 409);
        }
        saved = { ...saved, brief };
        return reply(saved, 201);
      }
      case 'PUT studies/study-1': {
        const { revision, ...draft } = route.request().postDataJSON();
        if (options.conflict && saved.revision === 1) saved = { ...saved, revision: 2, summary: 'A newer saved summary.' };
        if (revision !== saved.revision) return reply({ code: 'stale_revision', message: 'This study has a newer revision.' }, 409);
        saved = { ...saved, ...draft, revision: revision + 1 };
        return reply(saved);
      }
      case 'POST studies/study-1/launch': {
        const { revision, requestId } = route.request().postDataJSON();
        launchIds.push(requestId);
        if (execution?.requestId === requestId) return reply(execution, 202);
        if (revision !== saved.revision) return reply({ code: 'stale_revision', message: 'Refresh the study revision.' }, 409);
        execution = {
          id: 'execution-1', studyId: saved.id, studyRevision: revision, requestId, study: structuredClone(saved),
          status: 'running', createdAt, members: saved.users.map(user => ({ userId: user.id, runId: `run-${user.id}` })), runs: [],
        };
        if (options.retryLaunch && launchIds.length === 1) return route.abort('failed');
        return reply(execution, 202);
      }
      case 'GET study-executions': return reply(execution ? [execution] : []);
      case 'GET study-executions/execution-1': {
        if (!execution) return reply({ code: 'not_found', message: 'Execution not found.' }, 404);
        const runs = execution.study.users.map((user, index): EvidenceRun => {
          const workflow = application.workflows.find(item => item.id === user.workflowId)!;
          return {
            id: `run-${user.id}`, requestId: `request-${user.id}`,
            scenario: { ...workflow.scenario, label: user.name, goal: user.goal },
            context: user.context, inputs: user.context.inputs, status: complete ? 'completed' : 'running',
            verdict: !complete ? null : index === 0 ? 'failed' : 'inconclusive', createdAt, startedAt: createdAt,
            executionMode: 'ai_guided', manifestHash: '', capabilities: [],
            steps: [{ index: 1, timestamp: createdAt, action: 'Navigate', observation: index === 0 ? 'Opened the inventory screen.' : 'The browser loaded.', screenshot: index === 0 ? 'run-mina/step-1.png' : undefined }],
            assertions: complete && index === 0 ? [{ id: 'confirmation', status: 'passed' }, { id: 'quantity', status: 'failed', expected: 25, actual: 19 }] : [],
            findings: complete ? [{ kind: index === 0 ? 'api_or_outcome_failure' : 'agent_error', description: index === 0 ? 'Persisted state did not match the outcome contract.' : 'The agent ran out of browser actions.', evidencePaths: [] }] : [],
            artifacts: index === 0 ? ['run-mina/step-1.png'] : [],
          };
        });
        return reply({ ...execution, runs, status: complete ? 'completed' : 'running' });
      }
      case 'GET runs/run-mina/artifacts/step-1.png':
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6VtJ5kAAAAASUVORK5CYII=', 'base64') });
      default: return reply({ code: 'not_found', message: 'Unexpected fixture request.' }, 404);
    }
  });
  return { generateIds, launchIds, finish: () => { complete = true; } };
}

test('generates a study, saves new checks, and follows independent tester evidence after reload', async ({ page }) => {
  const mock = await mockStudyApi(page);
  await page.goto('/');
  await expect(page.getByRole('link', { name: study.title })).toBeVisible();
  await expect(page.getByText('Change the first product’s stock quantity.')).toBeVisible();
  await page.getByLabel('Domain').fill('Independent shops');
  await page.getByLabel('Audience', { exact: true }).fill(study.brief.audience);
  await page.getByRole('radio', { name: '2 testers' }).check();
  await page.getByRole('button', { name: 'Generate study' }).click();
  await expect(page).toHaveURL(/\/studies\/study-1$/);
  expect(mock.generateIds).toHaveLength(1);
  expect(mock.launchIds).toHaveLength(0);

  const mina = page.getByRole('article', { name: 'Mina Patel' });
  await mina.getByLabel('Workflow').selectOption('inventory-update');
  await mina.getByRole('spinbutton', { name: 'Quantity' }).fill('25');
  await expect(mina.getByText('25', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run study' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Run study' })).toBeEnabled();

  await page.getByRole('button', { name: 'Run study' }).click();
  await expect(page).toHaveURL(/\/studies\/study-1\/executions\/execution-1$/);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Mina Patel' })).toContainText('1 step');
  await expect(page.getByRole('article', { name: 'Leo Chan' })).toContainText('Running');
  mock.finish();
  const result = page.getByRole('article', { name: 'Mina Patel' });
  await expect(result).toContainText('Outcome mismatch');
  await expect(result).toContainText('Expected 25');
  await expect(result).toContainText('Observed 19');
  await expect(result).toContainText('Expected Visible on screen');
  await expect(result).toContainText('Observed Visible on screen');
  await expect(result.getByRole('link', { name: 'Open screenshot' })).toHaveAttribute('href', '/api/runner/runs/run-mina/artifacts/step-1.png');
  await result.getByText('Journey steps').click();
  await expect(result.getByText('Opened the inventory screen.')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Leo Chan' })).toContainText('Inconclusive');
  await expect(page.getByText('The agent ran out of browser actions.')).toBeVisible();
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByRole('link', { name: /First day on the shop floor/ })).toHaveAttribute('href', '/studies/study-1/executions/execution-1');
  expect(mock.launchIds).toHaveLength(1);
});

test('keeps generation and launch idempotent across lost responses', async ({ page }) => {
  const mock = await mockStudyApi(page, { retryGenerate: true, retryLaunch: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use example brief' }).click();
  await expect(page.getByLabel('Audience', { exact: true })).not.toHaveValue('');
  expect(mock.generateIds).toHaveLength(0);
  await page.getByRole('button', { name: 'Generate study' }).dblclick();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  expect(mock.generateIds).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Use example brief' }).click();
  await page.getByRole('button', { name: 'Generate study' }).click();
  await expect(page).toHaveURL(/\/studies\/study-1$/);
  expect(mock.generateIds).toHaveLength(2);
  expect(mock.generateIds[0]).toBeTruthy();
  expect(mock.generateIds[0]).toEqual(mock.generateIds[1]);

  await page.getByRole('button', { name: 'Run study' }).dblclick();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  expect(mock.launchIds).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Run study' }).click();
  await expect(page).toHaveURL(/\/executions\/execution-1$/);
  expect(mock.launchIds).toHaveLength(2);
  expect(mock.launchIds[0]).toBeTruthy();
  expect(mock.launchIds[0]).toEqual(mock.launchIds[1]);
});

test('preserves unsaved edits and blocks launch when a save conflicts', async ({ page }) => {
  const mock = await mockStudyApi(page, { conflict: true });
  await page.goto('/studies/study-1');
  const goal = page.getByRole('article', { name: 'Mina Patel' }).getByRole('textbox', { name: 'Goal', exact: true });
  await goal.fill('Save the chosen name on a narrow screen.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('newer revision');
  await expect(goal).toHaveValue('Save the chosen name on a narrow screen.');
  await expect(page.getByRole('button', { name: 'Run study' })).toBeDisabled();
  expect(mock.launchIds).toHaveLength(0);

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Studies' }).click();
  await page.getByRole('link', { name: study.title }).click();
  await expect(page.getByText(/Your edits are still in this tab/)).toBeVisible();
  await expect(goal).toHaveValue('Save the chosen name on a narrow screen.');
  await expect(page.getByRole('button', { name: 'Run study' })).toBeDisabled();
});

test('shows offline and missing model states and disables generation', async ({ page, context }) => {
  await mockStudyApi(page, { catalogOffline: true });
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Runner connection failed');
  await expect(page.getByRole('button', { name: 'Generate study' })).toBeDisabled();

  const missingModelPage = await context.newPage();
  await mockStudyApi(missingModelPage, { ready: false });
  await missingModelPage.goto('/');
  await expect(missingModelPage.getByText(/model credentials/i)).toBeVisible();
  await expect(missingModelPage.getByRole('button', { name: 'Generate study' })).toBeDisabled();
});

test('keeps generation failures actionable on a narrow screen with keyboard access', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockStudyApi(page, { rejectGeneration: 'generation_failed' });
  await page.goto('/');
  const example = page.getByRole('button', { name: 'Use example brief' });
  await example.focus();
  await expect(example).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Audience', { exact: true })).not.toHaveValue('');
  const generate = page.getByRole('button', { name: 'Generate study' });
  await generate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Please give the audience more detail.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

for (const code of ['generation_failed', 'generation_interrupted'] as const) {
  test(`sends a new request after ${code}`, async ({ page }) => {
    const mock = await mockStudyApi(page, { rejectGeneration: code });
    await page.goto('/');
    await page.getByRole('button', { name: 'Use example brief' }).click();
    await page.getByRole('button', { name: 'Generate study' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Please give the audience more detail.');
    await page.getByRole('button', { name: 'Generate study' }).click();
    await expect.poll(() => mock.generateIds.length).toBe(2);
    expect(mock.generateIds[0]).not.toEqual(mock.generateIds[1]);
    await expect(page).toHaveURL(/\/studies\/study-1$/);
  });
}
