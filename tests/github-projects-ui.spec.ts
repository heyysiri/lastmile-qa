import { expect, test, type Page } from '@playwright/test';
import { desktopContext, inventoryScenario } from '../packages/contracts/src/examples';
import type {
  ConnectGitHubProjectRequest, ProjectCase, ProjectCheck, ProjectDetail, ProjectFinding, ProjectJourney,
  ProjectRepair, ProjectRun, ProjectTester, ProjectTesterResult, SourceReference, SyncGitHubProjectRequest,
} from '../packages/contracts/src/projects';

test.use({ baseURL: process.env.STUDIES_TEST_URL ?? 'http://127.0.0.1:3000' });

const timestamp = '2026-11-20T08:00:00.000Z';
const hash = 'a'.repeat(64);
const firstSha = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const mergedSha = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const reference: SourceReference = { path: 'src/cart.ts', startLine: 4, endLine: 9, hash, excerpt: 'saveCart(items)' };
const tester: ProjectTester = { id: 'noa', name: 'Noa', role: 'Shopper', summary: 'Keeps a cart.', context: desktopContext };
const check: ProjectCheck = {
  id: 'cart', label: 'Saved cart', kind: 'field', locator: { by: 'label', value: 'Cart' },
  expected: '2 items', phase: 'after_reload', basis: 'test', sources: [reference],
};
const journey: ProjectJourney = {
  id: 'return', testerId: 'noa', title: 'Return to a saved cart', goal: 'Reopen the saved cart.',
  entryPath: '/', inputs: {}, checks: [check], sources: [reference], reason: 'Returning shoppers keep carts.',
};
const finding: ProjectFinding = {
  id: 'cart-lost', testerId: 'noa', journeyId: 'return', title: 'Saved cart is empty',
  description: 'The cart is empty after reload.', impact: 'Shoppers lose their selection.', confidence: 'confirmed',
  sources: [reference], failedCheckIds: ['cart'],
};
const result: ProjectTesterResult = {
  tester, journey, sessionContinued: true, checks: [{ ...check, status: 'failed', actual: '0 items' }], finding,
  run: {
    id: 'browser-run', requestId: 'browser-run', createdAt: timestamp, status: 'completed', verdict: 'failed',
    executionMode: 'ai_guided', context: desktopContext, scenario: inventoryScenario, manifestHash: hash,
    inputs: {}, steps: [], artifacts: [], assertions: [], findings: [], capabilities: [],
  },
};
const cases: ProjectCase[] = [
  { id: 'case-cart', tester, journey, createdAt: timestamp, lastSeenAt: timestamp, lastRunId: 'run-1', outcome: 'failed' },
  { id: 'case-wishlist', tester, journey: { ...journey, id: 'wishlist', title: 'Open a wishlist' }, createdAt: timestamp, lastSeenAt: timestamp },
];
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const pullRequest = { url: 'https://github.com/heyysiri/vendure/pull/7', number: 7, branch: 'lastmile/fix-1', headSha: 'c'.repeat(40), baseSha: firstSha };

function githubProject(options: { ran?: boolean; status?: ProjectDetail['status'] } = {}): ProjectDetail {
  const status = options.status ?? 'ready';
  return {
    id: 'desk', name: 'Vendure Shop', appUrl: 'http://127.0.0.1:4010', repositoryPath: '/private/checkouts/vendure',
    brief: 'Shoppers return to saved carts.', requirements: '', accounts: [], allowedOrigins: [],
    createdAt: timestamp, updatedAt: timestamp, status, progress: 'Cloning the repository',
    github: { repositoryUrl: 'https://github.com/heyysiri/vendure', branch: 'lastmile-demo', setup: 'auto', entryPath: '/',
      sha: firstSha, syncedAt: minutesAgo(5), lastTestedSha: options.ran ? firstSha : undefined, coverageMode: 'retain' },
    discovery: status === 'ready' ? {
      index: { version: hash, indexedAt: timestamp, changedPaths: [], sourceLines: 900, fileCount: 40, excludedFiles: 1 },
      plan: { summary: 'Shoppers manage carts.', testers: [tester], journeys: [journey],
        features: [{ id: 'cart', title: 'Saved carts', description: 'Keep a cart.', sources: [reference] }], roles: ['Shopper'], gaps: [] },
      observations: [], modelCalls: 2, durationMs: 900, generatedAt: timestamp,
    } : undefined,
    runs: options.ran ? [completedRun('run-1', firstSha)] : [], history: [], cases,
  };
}

function completedRun(id: string, revision: string): ProjectRun {
  return {
    id, projectId: 'desk', request: { requestId: `${id}-request`, mode: 'release', autoRepair: true }, status: 'completed',
    phase: 'Complete', createdAt: timestamp, finishedAt: timestamp, revision, results: [result], findings: [finding], summary: '',
    metrics: { elapsedMs: 1200, modelCalls: 3, browserActions: 6, passed: 0, failed: 1, inconclusive: 0 },
  };
}

async function mockApi(page: Page, initial?: ProjectDetail) {
  let project = initial;
  let connectId: string | undefined;
  let repair: ProjectRepair | undefined;
  const health = { status: 'ok', modelConfigured: true, executionReady: true, projectDiscoveryReady: true, projectExecutionReady: true, projectRepairsReady: true };
  const flags = { loseConnect: false, loseSync: false, losePublish: false };
  const connects: ConnectGitHubProjectRequest[] = [];
  const localConnects: string[] = [];
  const syncs: SyncGitHubProjectRequest[] = [];
  const publishes: string[] = [];
  const runs: unknown[] = [];
  const repairWrites: unknown[] = [];
  const refreshes: unknown[] = [];
  await page.route('**/api/runner/**', async route => {
    const request = route.request();
    expect(request.headers()).not.toHaveProperty('authorization');
    const path = new URL(request.url()).pathname.replace('/api/runner/', '');
    const method = request.method();
    const respond = (json: unknown, status = 200) => route.fulfill({ json, status });
    const missing = () => respond({ code: 'not_found', message: 'No matching request.' }, 404);
    if (path === 'health') return respond(health);
    if (path === 'projects' && method === 'GET') return respond(project ? [project] : []);
    if (path === 'projects/github' && method === 'POST') {
      const input = request.postDataJSON() as ConnectGitHubProjectRequest;
      connects.push(input);
      connectId = input.requestId;
      project = { ...githubProject({ status: 'discovering' }), name: input.name };
      return flags.loseConnect ? route.abort() : respond(project, 202);
    }
    if (path === 'projects' && method === 'POST') {
      localConnects.push((request.postDataJSON() as { requestId: string }).requestId);
      return respond({ ...githubProject({ status: 'discovering' }), github: undefined }, 202);
    }
    if (path.startsWith('projects/by-request/')) return path.endsWith(connectId ?? '\0') && project ? respond(project) : missing();
    if (!project) return missing();
    if (path === 'projects/desk') return respond(project);
    if (path === 'projects/desk/refresh') {refreshes.push(request.postDataJSON());project={...project,status:'discovering',progress:'Preparing the repository'};return respond(project,202);}
    if (path === 'projects/desk/sync') {
      const input = request.postDataJSON() as SyncGitHubProjectRequest;
      if (!syncs.some(item => item.requestId === input.requestId)) {
        syncs.push(input);
        project = { ...project, status: 'discovering', progress: 'Pulling the latest commits' };
      }
      return flags.loseSync ? route.abort() : respond(project, 202);
    }
    if (path === 'projects/desk/runs') {
      const input = request.postDataJSON() as ProjectRun['request'];
      runs.push(input);
      if (!project.runs.some(run => run.request.requestId === input.requestId)) {
        project.runs.unshift({ ...completedRun('run-1', firstSha), request: input, status: 'running', phase: 'Opening the shop', results: [], findings: [], finishedAt: undefined });
      }
      return respond(project.runs[0], 202);
    }
    if (path.startsWith('project-runs/')) {
      const run = project.runs.find(item => item.id === path.split('/').at(-1));
      return run ? respond(run) : missing();
    }
    if (path === 'project-repairs' && method === 'GET') return respond(repair ? [repair] : []);
    if (path === 'project-repairs' && method === 'POST') { repairWrites.push(request.postDataJSON()); return respond({ code: 'unexpected', message: 'Unexpected repair write.' }, 400); }
    if (repair && path === 'project-repairs/fix-1' && method === 'GET') return respond(repair);
    if (repair && path === 'project-repairs/fix-1/publish') {
      const input = request.postDataJSON() as { requestId: string };
      if (!publishes.includes(input.requestId)) {
        publishes.push(input.requestId);
        repair = { ...repair, status: 'completed', phase: 'publish', error: undefined, pullRequest };
        project.repairs = [repair];
      } else publishes.push(input.requestId);
      return flags.losePublish ? route.abort() : respond(repair, 202);
    }
    return missing();
  });
  return {
    health, flags, connects, localConnects, syncs, publishes, runs, repairWrites, refreshes,
    ready() { if (project) project = { ...githubProject(), runs: project.runs, repairs: project.repairs }; },
    finishFirstRun() {
      if (!project) throw new Error('A project must exist first');
      project.runs[0] = completedRun(project.runs[0].id, firstSha);
      project.runs[0].request = { requestId: 'first-run', mode: 'explore', autoRepair: true };
      project.github = { ...project.github!, lastTestedSha: firstSha };
    },
    setRepair(change: Partial<ProjectRepair>) {
      if (!project) throw new Error('A project must exist first');
      const sourceRun = project.runs[0] ?? completedRun('run-1', firstSha);
      repair = { id: 'fix-1', projectId: 'desk', request: { requestId: 'auto-1', runId: sourceRun.id, automatic: true }, project: structuredClone({ ...project, repairs: undefined }),
        sourceRun, status: 'running', phase: 'prepare', createdAt: timestamp, ...repair, ...change } as ProjectRepair;
      project.repairs = [repair];
    },
    finishSync(testing = true) {
      if (!project) throw new Error('A project must exist first');
      project = { ...project, status: 'ready', github: { ...project.github!, sha: mergedSha, syncedAt: new Date().toISOString() } };
      if (testing) project.runs.unshift({ ...completedRun('run-2', mergedSha), status: 'running', phase: 'Testing the merged commit', results: [], findings: [], finishedAt: undefined });
    },
    finishSyncRun() {
      if (!project) throw new Error('A project must exist first');
      project.runs[0] = completedRun('run-2', mergedSha);
      project.github = { ...project.github!, lastTestedSha: mergedSha };
    },
  };
}

const verified = { outcome: 'verified' as const, message: 'All frozen checks passed.', results: [] };

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function fillGitHub(page: Page) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a project' });
  await dialog.getByLabel('Project name').fill('Vendure Shop');
  await dialog.getByLabel('Repository URL').fill('https://github.com/heyysiri/vendure');
  await dialog.getByLabel('Branch').fill('lastmile-demo');
  await dialog.getByLabel('Audience and intent').fill('Shoppers return to saved carts.');
  return dialog;
}

for (const width of [375, 1440]) {
  test(`connects a GitHub repository with only the essentials at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const mock = await mockApi(page);
    await page.goto('/');
    const dialog = await fillGitHub(page);
    await expect(dialog.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel('Repository path')).toHaveCount(0);
    await expect(dialog.getByLabel('Running app URL')).toHaveCount(0);
    await expect(dialog.getByLabel('Starting page')).toBeHidden();
    await expect(dialog.getByText(/token|password/i)).toHaveCount(0);
    await expectNoOverflow(page);
    await dialog.getByRole('button', { name: 'Connect from GitHub' }).click();
    await expect(page).toHaveURL(/\/projects\/desk$/);
    expect(mock.connects).toHaveLength(1);
    expect(mock.connects[0]).toMatchObject({ repositoryUrl: 'https://github.com/heyysiri/vendure', branch: 'lastmile-demo', setup: 'auto', entryPath: '/', accounts: [] });
    expect(mock.connects[0].commands).toBeUndefined();
    await expect(page.getByText('Cloning the repository')).toBeVisible();
    mock.ready();
    await expect(page.getByRole('button', { name: 'Run test team' })).toBeVisible();
    const source = page.getByLabel('Source');
    await expect(source.getByText('heyysiri/vendure')).toBeVisible();
    await expect(source.getByText('lastmile-demo')).toBeVisible();
    await expect(source.getByText('1111111', { exact: true })).toBeVisible();
    await expect(source.getByText(/^\d+ min ago$/)).toBeVisible();
    await expect(source.getByText('Not tested yet')).toBeVisible();
    await expect(page.getByText(firstSha)).toHaveCount(0);
    await expect(page.getByText('127.0.0.1:4010')).toHaveCount(0);
    await expectNoOverflow(page);
  });
}

test('sends custom commands only from the expanded setup and keeps Local development secondary', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  const dialog = await fillGitHub(page);
  await dialog.getByText('Setup', { exact: true }).click();
  await expect(dialog.getByLabel('Detected automatically')).toBeChecked();
  await dialog.getByLabel('Starting page').fill('/shop');
  await dialog.getByLabel('Custom commands').check();
  await dialog.getByLabel('Install command (optional)').fill('pnpm\ninstall');
  await dialog.getByLabel('Start command', { exact: true }).fill('pnpm\nstart');
  await dialog.getByRole('tab', { name: 'Local development' }).click();
  await expect(dialog.getByLabel('Repository path')).toBeVisible();
  await expect(dialog.getByLabel('Repository URL')).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'GitHub' }).click();
  await expect(dialog.getByLabel('Project name')).toHaveValue('Vendure Shop');
  await dialog.getByRole('button', { name: 'Connect from GitHub' }).click();
  await expect(page).toHaveURL(/\/projects\/desk$/);
  expect(mock.connects[0]).toMatchObject({ setup: 'custom', entryPath: '/shop', install: ['pnpm', 'install'], commands: { start: ['pnpm', 'start'] } });
  expect(mock.localConnects).toHaveLength(0);
});

test('recovers a lost GitHub connect response by request ID without a second write', async ({ page }) => {
  const mock = await mockApi(page);
  mock.flags.loseConnect = true;
  await page.goto('/');
  const dialog = await fillGitHub(page);
  await dialog.getByRole('button', { name: 'Connect from GitHub' }).click();
  await expect(dialog.getByRole('button', { name: 'Check connection' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/projects\/desk$/);
  expect(mock.connects).toHaveLength(1);
});

test('runs the team first, then syncs and tests while retaining saved test IDs', async ({ page }) => {
  const mock = await mockApi(page, githubProject());
  await page.goto('/projects/desk');
  await page.getByRole('button', { name: 'Run test team' }).click();
  expect(mock.runs).toHaveLength(1);
  mock.finishFirstRun();
  await expect(page.getByRole('heading', { name: 'Saved cart is empty' })).toBeVisible();
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await expect(page.locator('[data-case-id]')).toHaveCount(2);
  await expect(page.locator('[data-case-id="case-cart"]')).toContainText('Return to a saved cart');
  await expect(page.getByRole('button', { name: 'Refresh understanding' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync & test' }).click();
  expect(mock.syncs).toHaveLength(1);
  expect(mock.syncs[0].run).toBe(true);
  await expect(page.getByText('Pulling the latest commits')).toBeVisible();
  mock.finishSync();
  await expect(page.getByText('Testing the merged commit')).toBeVisible();
  mock.finishSyncRun();
  const source = page.getByLabel('Source');
  await expect(source.getByText('2222222', { exact: true }).first()).toBeVisible();
  await expect(source.getByText('Tested')).toBeVisible();
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await expect(page.locator('[data-case-id]')).toHaveCount(2);
  await expect(page.locator('[data-case-id="case-cart"]')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('"requestId"');
});

test('recovers a lost sync response with the same request ID after reload', async ({ page }) => {
  const mock = await mockApi(page, githubProject({ ran: true }));
  mock.flags.loseSync = true;
  await page.goto('/projects/desk');
  await page.getByRole('button', { name: 'Sync & test' }).click();
  await expect(page.getByRole('button', { name: 'Recover sync request' })).toBeVisible();
  await page.reload();
  mock.flags.loseSync = false;
  await page.getByRole('button', { name: 'Recover sync request' }).click();
  await expect(page.getByRole('button', { name: 'Recover sync request' })).toHaveCount(0);
  expect(mock.syncs).toHaveLength(1);
  await expect(page.getByText('Pulling the latest commits')).toBeVisible();
});

test('shows verification, publishing and the pull request link without regenerating a fix', async ({ page }) => {
  const mock = await mockApi(page, githubProject({ ran: true }));
  mock.setRepair({ status: 'running', phase: 'verify' });
  await page.goto('/projects/desk');
  await expect(page.getByText('Verifying the fix', { exact: true })).toBeVisible();
  mock.setRepair({ status: 'running', phase: 'publish', verification: verified });
  await expect(page.getByText('Publishing pull request', { exact: true }).first()).toBeVisible();
  mock.setRepair({ status: 'completed', phase: 'publish', verification: verified, pullRequest });
  const link = page.getByRole('link', { name: 'Review pull request' });
  await expect(link).toHaveAttribute('href', pullRequest.url);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(page.getByText(/Merge it on GitHub yourself, then choose Sync & test/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync & test' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry PR|Retry fix|Prepare fix/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Review fix', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Review pull request' })).toBeVisible();
  await expect(page.getByText('review and apply it in your own checkout')).toHaveCount(0);
  expect(mock.repairWrites).toHaveLength(0);
});

test('retries a failed publish as Retry PR with one idempotent request and no new fix', async ({ page }) => {
  const mock = await mockApi(page, githubProject({ ran: true }));
  mock.setRepair({ status: 'interrupted', phase: 'publish', verification: verified, error: 'GitHub rejected the push.' });
  mock.flags.losePublish = true;
  await page.goto('/projects/desk');
  await expect(page.getByText('GitHub rejected the push.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry fix|Prepare fix/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry PR' }).click();
  await expect(page.getByRole('button', { name: 'Retry PR' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry PR' }).click();
  await expect.poll(() => mock.publishes.length).toBe(2);
  expect(mock.publishes[1]).toBe(mock.publishes[0]);
  mock.flags.losePublish = false;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Review pull request' })).toHaveAttribute('href', pullRequest.url);
  expect(mock.repairWrites).toHaveLength(0);
});

test('retries failed initial GitHub setup through discovery rather than release sync',async({page})=>{const mock=await mockApi(page,githubProject({status:'failed'}));await page.goto('/projects/desk');await page.getByRole('button',{name:'Retry setup'}).click();await expect.poll(()=>mock.refreshes.length).toBe(1);expect(mock.syncs).toHaveLength(0);await expect(page.getByText('Preparing the repository',{exact:true})).toBeVisible();});
