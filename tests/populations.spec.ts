import { expect, test, type Page } from '@playwright/test';
import { desktopContext, inventoryScenario, mobileContext, storeScenario } from '../packages/contracts/src/examples';
import type { EvidenceRun } from '../packages/contracts/src/runtime';
import type { Study, StudyApplication } from '../packages/contracts/src/studies';
import type { ApplicationContext, EnrollPopulationRequest, LaunchPopulationRequest, Population, PopulationExecutionDetail } from '../packages/contracts/src/populations';
import { resolveProxyTarget } from '../apps/lastmile/lib/proxy-policy';

test.use({ baseURL: process.env.STUDIES_TEST_URL ?? 'http://127.0.0.1:3000' });

const createdAt = '2026-11-20T08:00:00.000Z';
const application: StudyApplication = {
  id: 'seller-demo', name: 'Seller Hub', domain: 'Marketplace sellers', origin: 'http://127.0.0.1:3001',
  description: 'A workspace for sellers.',
  workflows: [
    { id: storeScenario.id, description: 'Update the store name.', scenario: storeScenario, defaultInputs: { storeName: 'Studio Supply' } },
    { id: inventoryScenario.id, description: 'Change stock.', scenario: inventoryScenario, defaultInputs: { quantity: 5 } },
  ],
};
const study: Study = {
  id: 'study-1', revision: 2, title: 'Independent shop owners', summary: 'Test setup on phones and repeat inventory edits.',
  assumptions: [],
  brief: { applicationId: application.id, domain: application.domain, audience: 'Independent shop owners learning to manage their inventory.', count: 2 },
  users: [
    { id: 'mina', name: 'Mina Patel', summary: 'A seller on a narrow phone.', coverageReason: 'Covers setup on a phone.', assumptions: [], workflowId: storeScenario.id, goal: 'Save the storefront name.', context: { ...mobileContext, inputs: { storeName: 'Fern & Thread' } } },
    { id: 'leo', name: 'Leo Chan', summary: 'A returning seller between orders.', coverageReason: 'Covers repeat inventory edits.', assumptions: [], workflowId: inventoryScenario.id, goal: 'Save the new stock quantity.', context: { ...desktopContext, inputs: { quantity: 250 } } },
  ],
  createdAt, updatedAt: createdAt, generation: { model: 'fixture', source: 'model', observedPaths: [] },
};
const population: Population = {
  id: 'shops', label: 'Independent shop owners', applicationId: application.id, origin: application.origin, studyId: study.id, studyRevision: 2, createdAt,
  testers: study.users.map((profile, index) => ({ id: `tester-${profile.id}`, profile, initialStateId: application.workflows[index].scenario.initialStateId })),
};
const applicationContext: ApplicationContext = {
  applicationId: application.id, version: 'context-v1', capturedAt: createdAt,
  sources: [
    { kind: 'requirement', path: 'requirements.md', digest: 'req-digest', excerpt: 'Editing store details preserves stock.' },
    { kind: 'code', path: 'src/store.ts', digest: 'code-digest', excerpt: 'saveStore(profile)' },
  ],
};

function execution(id: string, mode: 'continue' | 'checkpoint' = 'continue'): PopulationExecutionDetail {
  const runs = population.testers.map(({ id: testerId, profile, initialStateId }, index): EvidenceRun => {
    const candidate = mode === 'checkpoint';
    const scenario = { ...application.workflows[index].scenario, goal: profile.goal };
    const action = { action: { tool: 'navigate' as const, path: '/inventory' }, url: '/inventory', observation: 'The stock editor opened.' };
    return {
      id: `${id}-${testerId}`, requestId: `request-${id}-${testerId}`,
      status: 'completed', verdict: candidate && index === 1 ? 'failed' : 'passed',
      executionMode: candidate ? 'deterministic' : 'ai_guided', createdAt, finishedAt: createdAt,
      scenario,
      context: profile.context, inputs: profile.context.inputs, manifestHash: 'manifest',
      steps: [{ index: 1, timestamp: createdAt, action: 'Navigate', observation: 'The seller saw 250 items in stock.' }],
      assertions: scenario.contract.assertions.map(({ id }) => id === 'quantity'
        ? { id, status: candidate ? 'failed' : 'passed', expected: 250, actual: candidate ? 5 : 250 }
        : { id, status: 'passed' }),
      findings: [], capabilities: [], artifacts: [],
      evidence: { buildId: candidate ? 'candidate-build' : 'base-build', scenarioHash: 'scenario', policyVersion: '1', model: 'fixture', actions: [action], modelCalls: candidate ? 0 : 1, finishedByAgent: !candidate },
      continuity: { populationId: population.id, testerId, initialStateId, workflowId: profile.workflowId, mode, preserveStatePaths: [], history: [], startCheckpoint: { id: 'start', digest: 'checkpoint-digest' } },
    };
  });
  return {
    id, populationId: population.id, requestId: `request-${id}`, population, mode, releaseLabel: mode === 'checkpoint' ? 'Spring candidate' : id === 'baseline' ? 'Winter baseline' : 'Spring journey',
    buildId: mode === 'checkpoint' ? 'candidate-build' : 'base-build', status: 'completed', createdAt, finishedAt: createdAt, applicationContext,
    members: runs.map((run, index) => ({ testerId: population.testers[index].id, runId: run.id })), runs,
    baselineExecutionId: mode === 'checkpoint' ? 'baseline' : undefined,
    comparisons: mode === 'checkpoint' ? [
      { testerId: 'tester-mina', baselineRunId: 'baseline-tester-mina', outcome: 'still_passing', message: 'All baseline checks still pass.' },
      { testerId: 'tester-leo', baselineRunId: 'baseline-tester-leo', outcome: 'regression', message: 'Stock changed from 250 to 5.' },
    ] : undefined,
  };
}

async function mockApi(page: Page, options: { enrolled?: boolean; disconnectEnroll?: boolean; disconnectLaunch?: boolean; conflictLaunch?: boolean; rejectRecoveredLaunch?: boolean; contextOffline?: boolean; listOffline?: boolean; modelConfigured?: boolean } = {}) {
  let currentPopulation = options.enrolled ? population : undefined;
  let journey: PopulationExecutionDetail | undefined;
  let check: PopulationExecutionDetail | undefined;
  let complete = false;
  const baseline = execution('baseline');
  const noCheckpoint = execution('no-checkpoint');
  noCheckpoint.releaseLabel = 'Missing checkpoint';
  delete noCheckpoint.runs[0].continuity?.startCheckpoint;
  const partial = execution('partial');
  partial.releaseLabel = 'Incomplete verification';
  partial.runs[0].assertions.pop();
  const enrollments: EnrollPopulationRequest[] = [];
  const launches: LaunchPopulationRequest[] = [];
  await page.route('**/api/runner/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/runner/', '');
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    switch (`${route.request().method()} ${path}`) {
      case 'GET health': return reply({ status: 'ok', modelConfigured: options.modelConfigured ?? true, executionReady: true });
      case 'GET studies': return reply([study]);
      case 'GET studies/study-1': return reply(study);
      case 'GET applications': return reply([application]);
      case 'GET applications/seller-demo/context': return options.contextOffline ? reply({ code: 'unavailable', message: 'Application context is unavailable.' }, 503) : reply(applicationContext);
      case 'GET populations': return options.listOffline ? reply({ code: 'runner_offline', message: 'Runner connection failed.' }, 502) : reply(currentPopulation ? [currentPopulation] : []);
      case 'POST populations': {
        enrollments.push(route.request().postDataJSON());
        currentPopulation ??= { ...population, label: enrollments[0].label };
        return options.disconnectEnroll && enrollments.length === 1 ? route.abort('failed') : reply(currentPopulation, 201);
      }
      case 'GET populations/shops':
        return reply({ ...(currentPopulation ?? population), episodes: [baseline, noCheckpoint, partial].flatMap(item => item.runs.map((run, i) => ({
          testerId: population.testers[i].id, executionId: item.id, releaseLabel: item.releaseLabel, run,
        }))) });
      case 'GET population-executions': return reply([baseline, noCheckpoint, partial, journey, check].filter(Boolean));
      case 'GET population-executions/baseline': return reply(baseline);
      case 'GET population-executions/no-checkpoint': return reply(noCheckpoint);
      case 'GET population-executions/journey': return reply(journey && (complete ? { ...journey, status: 'completed' } : {
        ...journey, runs: journey.runs.map(run => ({ ...run, status: 'running', verdict: null, assertions: [] })),
      }));
      case 'GET population-executions/check': return reply(check);
      case 'GET runs/baseline-tester-mina': return reply(baseline.runs[0]);
      case 'GET runs/check-tester-leo': return reply(execution('check', 'checkpoint').runs[1]);
      case 'POST populations/shops/executions': {
        const payload = route.request().postDataJSON() as LaunchPopulationRequest;
        launches.push(payload);
        if (options.rejectRecoveredLaunch && launches.length === 1) return route.abort('failed');
        if (options.rejectRecoveredLaunch && launches.length === 2) return reply({ code: 'context_unavailable', message: 'Could not capture connected application context.' }, 503);
        if (payload.mode === 'checkpoint') {
          check = { ...execution('check', 'checkpoint'), requestId: payload.requestId };
          return reply(check, 202);
        }
        if (journey?.requestId === payload.requestId) return reply(journey, 202);
        if (options.conflictLaunch && launches.length === 1) return reply({ code: 'population_busy', message: 'This population already has an active execution.' }, 409);
        journey = { ...execution('journey'), releaseLabel: payload.releaseLabel, requestId: payload.requestId, status: 'running' };
        return options.disconnectLaunch && launches.length === 1 ? route.abort('failed') : reply(journey, 202);
      }
      default: return reply({ code: 'not_found', message: 'Unexpected fixture request.' }, 404);
    }
  });
  return { enrollments, launches, finish: () => { complete = true; } };
}

test('enrolls a saved revision and recovers the same enrollment after a lost response', async ({ page }) => {
  const mock = await mockApi(page, { disconnectEnroll: true });
  await page.goto('/populations');
  await page.getByRole('link', { name: 'Create a study' }).click();
  await page.getByRole('link', { name: study.title }).click();
  const enroll = page.getByRole('button', { name: 'Enroll persistent testers' });
  await expect(enroll).toBeEnabled();
  await page.getByLabel('Study title').fill('Unsaved name');
  await expect(enroll).toBeDisabled();
  await page.getByLabel('Study title').fill(study.title);
  await page.getByLabel('Population name').fill('Shopkeepers');
  await enroll.dblclick();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  expect(mock.enrollments).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Recover enrollment' }).click();
  await expect(page).toHaveURL(/\/populations\/shops$/);
  expect(mock.enrollments).toHaveLength(2);
  expect(mock.enrollments[1]).toEqual(mock.enrollments[0]);
  expect(mock.enrollments[0]).toMatchObject({ studyId: study.id, revision: 2, label: 'Shopkeepers' });
  await expect(page.getByText('Saved study · revision 2')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Populations' }).click();
  await expect(page.getByRole('link', { name: /Shopkeepers/ })).toBeVisible();
});

test('edits all next tasks, recovers an accepted launch across reload, and polls live results', async ({ page }) => {
  const mock = await mockApi(page, { enrolled: true, disconnectLaunch: true });
  await page.goto('/populations/shops');
  const start = page.getByRole('button', { name: 'Continue with these tasks' });
  await expect(start).toBeDisabled();
  await page.getByLabel('Release label').fill('Spring journey');
  const mina = page.getByRole('group', { name: 'Next task for Mina Patel' });
  await mina.getByRole('combobox', { name: 'Workflow', exact: true }).selectOption(inventoryScenario.id);
  await mina.getByLabel('Quantity', { exact: true }).fill('42');
  await mina.getByRole('textbox', { name: 'Goal', exact: true }).fill('Save 42 items in stock.');
  await start.dblclick();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  expect(mock.launches).toHaveLength(1);
  await expect(page).toHaveURL(/\/populations\/shops$/);
  await page.reload();
  await expect(page.getByText(/An execution is already queued or running/)).toBeVisible();
  await expect(page.getByLabel('Release label')).toHaveValue('Spring journey');
  await expect(mina.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('42');
  await expect(mina.getByRole('spinbutton', { name: 'Quantity' })).toBeDisabled();
  await page.getByRole('button', { name: 'Recover launch' }).click();
  await expect(page).toHaveURL(/\/executions\/journey$/);
  expect(mock.launches).toHaveLength(2);
  expect(mock.launches[0]).toMatchObject({
    mode: 'continue', releaseLabel: 'Spring journey', tasks: [
      { testerId: 'tester-mina', workflowId: inventoryScenario.id, goal: 'Save 42 items in stock.', inputs: { quantity: 42 } },
      { testerId: 'tester-leo', workflowId: inventoryScenario.id, inputs: { quantity: 250 } },
    ],
  });
  expect(mock.launches[1]).toEqual(mock.launches[0]);
  await expect(page.getByText('Updating live')).toBeVisible();
  mock.finish();
  await expect(page.getByText('2 of 2 finished')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Completed' })).toBeVisible();
});

test('uses eligible frozen baselines and presents regression evidence, account history, and provenance', async ({ page }) => {
  const mock = await mockApi(page, { enrolled: true, modelConfigured: false });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/populations/shops');
  await expect(page.getByText('tester-leo', { exact: true })).toBeVisible();
  const account = page.getByRole('article', { name: 'Leo Chan' });
  await account.getByText('Observed history').click();
  const baselineEpisode = account.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Winter baseline' }) });
  await expect(baselineEpisode.getByText('The seller saw 250 items in stock.').filter({ visible: true })).toBeVisible();
  await page.getByText('Application context', { exact: true }).click();
  await expect(page.getByText('requirements.md')).toBeVisible();
  await expect(page.getByText('req-digest')).toBeVisible();
  await expect(page.getByText('saveStore(profile)')).toBeVisible();
  const compare = page.getByRole('radio', { name: 'Compare a release' });
  await compare.focus();
  await page.keyboard.press('Space');
  await page.getByLabel('Release label').fill('Spring candidate');
  const baseline = page.getByLabel('Baseline execution');
  await expect(baseline.locator('option')).toHaveCount(2);
  await expect(baseline.locator('option').last()).toContainText('Winter baseline');
  await baseline.selectOption('baseline');
  await page.getByRole('button', { name: 'Run checkpoint comparison' }).click();
  await expect(page).toHaveURL(/\/executions\/check$/);
  expect(mock.launches[0]).toMatchObject({ mode: 'checkpoint', baselineExecutionId: 'baseline', releaseLabel: 'Spring candidate' });
  await expect(page.getByText('Checkpoint replay · no model calls')).toBeVisible();
  const leo = page.getByRole('article', { name: 'Leo Chan' });
  await expect(leo).toContainText('Regression');
  await expect(leo).toContainText('Stock changed from 250 to 5.');
  await expect(leo).toContainText('Expected 250');
  await expect(leo).toContainText('Observed 5');
  await expect(leo.getByRole('link', { name: 'Baseline run evidence' })).toHaveAttribute('href', '/runs/baseline-tester-leo');
  await expect(page.getByRole('article', { name: 'Mina Patel' })).toContainText('Still passing');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('surfaces conflicts and context failures and uses a new key after a definitive rejection', async ({ page }) => {
  const mock = await mockApi(page, { enrolled: true, conflictLaunch: true, contextOffline: true });
  await page.goto('/populations/shops');
  await page.getByText('Application context', { exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Application context is unavailable.');
  await page.getByLabel('Release label').fill('Retry candidate');
  const start = page.getByRole('button', { name: 'Continue with these tasks' });
  await start.click();
  await expect(page.getByText('This population already has an active execution.')).toBeVisible();
  await start.click();
  await expect(page).toHaveURL(/\/executions\/journey$/);
  expect(mock.launches[0].requestId).not.toEqual(mock.launches[1].requestId);
});

test('lets users edit a recovered draft after the runner definitively rejects it', async ({ page }) => {
  const mock = await mockApi(page, { enrolled: true, rejectRecoveredLaunch: true });
  await page.goto('/populations/shops');
  const label = page.getByLabel('Release label');
  await label.fill('First attempt');
  await page.getByRole('button', { name: 'Continue with these tasks' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach');
  await page.reload();
  await page.getByRole('button', { name: 'Recover launch' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not capture connected application context');
  await expect(label).toBeEnabled();
  await expect(label).toHaveValue('First attempt');
  await label.fill('Second attempt');
  await page.getByRole('button', { name: 'Continue with these tasks' }).click();
  await expect(page).toHaveURL(/\/executions\/journey$/);
  expect(mock.launches[1]).toEqual(mock.launches[0]);
  expect(mock.launches[2].requestId).not.toBe(mock.launches[1].requestId);
});

test('shows population list fetch failures with retry', async ({ page }) => {
  await mockApi(page, { listOffline: true });
  await page.goto('/populations');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Runner connection failed.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

test('allowlists only the specified population proxy routes', () => {
  for (const [method, path] of [
    ['GET', 'populations'], ['POST', 'populations'], ['GET', 'populations/shops'],
    ['POST', 'populations/shops/executions'], ['GET', 'population-executions'],
    ['GET', 'population-executions/first-run'], ['GET', 'applications/seller-demo/context'],
  ]) expect(resolveProxyTarget(method, path.split('/'))).toBe(`/api/${path}`);
  for (const [method, path] of [
    ['POST', 'population-executions'], ['PUT', 'populations/shops'], ['GET', 'populations/shops/executions'],
    ['POST', 'populations/shops'], ['GET', 'population-executions/a/b'], ['POST', 'applications/seller-demo/context'],
    ['GET', 'populations/../executions'], ['POST', 'populations/test%2fdev/executions'],
  ]) expect(resolveProxyTarget(method, path.split('/'))).toBeNull();
});

test('routes persistent run evidence back to its population without legacy replay controls', async ({ page }) => {
  await mockApi(page, { enrolled: true });
  await page.goto('/runs/baseline-tester-mina');
  await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open population' })).toHaveAttribute('href', '/populations/shops');
  await expect(page.getByRole('button', { name: /replay/i })).toHaveCount(0);
  await page.goto('/runs/check-tester-leo');
  await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Investigate differences' })).toHaveCount(0);
});
