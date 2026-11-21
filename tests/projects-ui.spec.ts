import { expect, test, type Page } from '@playwright/test';
import { desktopContext, inventoryScenario } from '../packages/contracts/src/examples';
import type {
  ConnectProjectRequest, ProjectCheck, ProjectDetail, ProjectFinding, ProjectJourney, ProjectRepair,
  ProjectRepairRequest, ProjectRunRequest, ProjectTester, ProjectTesterResult, SourceReference,
} from '../packages/contracts/src/projects';

test.use({ baseURL: process.env.STUDIES_TEST_URL ?? 'http://127.0.0.1:3000' });

const timestamp = '2026-11-20T08:00:00.000Z';
const hash = 'a'.repeat(64);
const reference: SourceReference = {
  path: 'src/reservations.ts', startLine: 12, endLine: 18, hash, excerpt: 'writeReservation(form.values)',
};
const tester: ProjectTester = {
  id: 'noa', name: 'Noa', role: 'Front desk', summary: 'Handles reservations.', context: desktopContext,
};
const check: ProjectCheck = {
  id: 'save', label: 'Saved reservation', kind: 'field', locator: { by: 'label', value: 'Reservation' },
  expected: 'Tuesday', phase: 'after_reload', basis: 'test', sources: [reference],
};
const journey: ProjectJourney = {
  id: 'reserve', testerId: tester.id, title: 'Move a reservation', goal: 'Move a booking to Tuesday.',
  entryPath: '/reservations', inputs: {}, checks: [check], sources: [reference], reason: 'Front desk staff reschedule bookings.',
};
const finding: ProjectFinding = {
  id: 'date-lost', testerId: tester.id, journeyId: journey.id, title: 'Reservation date resets',
  description: 'The original date returns when the page reloads.', impact: 'Front desk staff may double book a room.',
  confidence: 'confirmed', sources: [reference], failedCheckIds: ['save'],
};
const result: ProjectTesterResult = {
  tester, journey, sessionContinued: true,
  run: {
    id: 'browser-run', requestId: 'browser-run', createdAt: timestamp, status: 'completed', verdict: 'failed',
    executionMode: 'ai_guided', context: desktopContext, scenario: inventoryScenario, manifestHash: hash,
    inputs: {}, steps: [], artifacts: [], assertions: [], findings: [], capabilities: [],
  },
  checks: [
    { ...check, status: 'failed', actual: 'Monday' },
    { ...check, id: 'timezone', label: 'Time zone preserved', status: 'passed', expected: 'UTC', actual: 'UTC' },
    { ...check, id: 'notes', label: 'Booking notes', status: 'not_evaluated', message: 'The notes control could not be located.' },
  ],
  finding,
};
const control: ProjectTesterResult = {
  ...result, tester: { ...tester, id: 'ash', name: 'Ash', role: 'Night auditor', accountId: 'audit-account' },
  journey: { ...journey, id: 'confirm', testerId: 'ash', title: 'Read a reservation' },
  run: { ...result.run, id: 'control-run', verdict: 'passed' }, checks: [],
  finding: undefined, sessionContinued: false,
};
function makeProject(status: ProjectDetail['status'] = 'ready'): ProjectDetail {
  return {
    id: 'desk', name: 'Room Desk', appUrl: 'http://127.0.0.1:9000', repositoryPath: '/work/room-desk',
    brief: 'Front desk staff move bookings.', requirements: '', accounts: [], allowedOrigins: [],
    createdAt: timestamp, updatedAt: timestamp, status, progress: 'Reading reservation screens',
    commands: { start: ['pnpm', 'start'] },
    discovery: status === 'ready' ? {
      index: { version: hash, indexedAt: timestamp, changedPaths: [], sourceLines: 374, fileCount: 12, excludedFiles: 2 },
      plan: { summary: 'Staff manage room bookings.', testers: [tester], journeys: [journey],
        features: [{ id: 'reservations', title: 'Reservations', description: 'Move bookings.', sources: [reference] }], roles: ['Front desk'], gaps: ['Cancellation was not corroborated.'] },
      observations: [], modelCalls: 3, durationMs: 1300, generatedAt: timestamp,
    } : undefined,
    runs: [], history: [],
  };
}

async function mockApi(page: Page, setup?: ProjectDetail) {
  let project = setup;
  let connectId: string | undefined;
  let repair: ProjectRepair | undefined;
  const earlierRepairs: ProjectRepair[] = [];
  const health = { status: 'ok', modelConfigured: true, executionReady: true,
    projectDiscoveryReady: true, projectExecutionReady: true, projectRepairsReady: true };
  const connects: string[] = [];
  const runs: ProjectRunRequest[] = [];
  const refreshes: string[] = [];
  const repairs: ProjectRepairRequest[] = [];
  const verifications: { requestId: string; patchHash: string }[] = [];
  const lookups: string[] = [];
  const flags = { loseConnect: false, loseRun: false, loseVerify: false, loseRepair: false, stale: false };
  await page.route('**/api/runner/**', async route => {
    const request = route.request();
    expect(request.headers()).not.toHaveProperty('authorization');
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/runner/', '');
    const method = request.method();
    const respond = (json: unknown, status = 200) => route.fulfill({ json, status });
    const missing = () => respond({ code: 'not_found', message: 'No matching request.' }, 404);
    if (path === 'health') return respond(health);
    if (path === 'projects' && method === 'GET') return respond(project ? [project] : []);
    if (path === 'projects' && method === 'POST') {
      const input = request.postDataJSON() as ConnectProjectRequest;
      connects.push(input.requestId);
      expect(input.name).toBe('Room Desk');
      connectId = input.requestId;
      project = { ...makeProject('discovering'), commands: input.commands,
        accounts: input.accounts.map(({ label }, i) => ({ label, id: `account-${i}` })) };
      if (flags.loseConnect) return route.abort();
      return respond(project, 202);
    }
    if (path.startsWith('projects/by-request/') && method === 'GET') {
      const id = path.split('/').at(-1)!;
      lookups.push(id);
      return id === connectId && project ? respond(project) : missing();
    }
    if (!project) return missing();
    if (path === 'projects/desk') return respond(project);
    if (path === 'projects/desk/refresh') {
      refreshes.push(request.postDataJSON().requestId);
      project = { ...project, status: 'discovering', progress: 'Re-indexing changed source files' };
      return respond(project);
    }
    if (path === 'projects/desk/runs') {
      const input = request.postDataJSON() as ProjectRunRequest;
      runs.push(input);
      let run = project.runs.find(item => item.request.requestId === input.requestId);
      if (!run) {
        run = { id: `run-${project.runs.length + 1}`, projectId: project.id, request: input, status: 'running',
          phase: 'Checking the booking form', createdAt: timestamp, results: [], findings: [], summary: '',
          metrics: { elapsedMs: 0, modelCalls: 0, browserActions: 0, passed: 0, failed: 0, inconclusive: 0 } };
        project.runs.unshift(run);
      }
      return flags.loseRun ? route.abort() : respond(run, 202);
    }
    if (path.startsWith('project-runs/')) {
      const run = project.runs.find(item => item.id === path.split('/').at(-1));
      return run ? respond(run) : missing();
    }
    if (path === 'project-repairs' && method === 'GET') {
      expect(url.searchParams.get('projectId')).toBe(project.id);
      return respond(repair ? [...earlierRepairs, repair] : []);
    }
    if (path === 'project-repairs' && method === 'POST') {
      const input = request.postDataJSON() as ProjectRepairRequest;
      repairs.push(input);
      const sourceRun = project.runs.find(run => run.id === input.runId);
      if (!sourceRun) return missing();
      const duplicate = [...earlierRepairs, ...(repair ? [repair] : [])].find(job => job.request.requestId === input.requestId);
      if (duplicate) return respond(duplicate, 202);
      if (repair && !retryable(repair)) return respond({ code: 'repair_active', message: 'This run already has a repair.' }, 409);
      if (repair) earlierRepairs.push(repair);
      const number = earlierRepairs.length + 1;
      repair = { id: `fix-${number}`, projectId: project.id, request: input, project, sourceRun,
        phase: 'prepare', status: 'awaiting_review', createdAt: `2026-11-20T08:0${number}:00.000Z`, sourceVersion: hash,
        patch: { hash, summary: 'Persist the selected date.', changes: [
          { path: reference.path, beforeHash: hash, before: 'date: originalDate', after: 'date: enteredDate' },
        ] } };
      return flags.loseRepair ? route.abort() : respond(repair, 202);
    }
    const stored = [...earlierRepairs, ...(repair ? [repair] : [])].find(job => path === `project-repairs/${job.id}`);
    if (stored) return respond(stored);
    if (repair && path === `project-repairs/${repair.id}/verify`) {
      const input = request.postDataJSON() as NonNullable<ProjectRepair['verificationRequest']>;
      verifications.push(input);
      if (flags.stale) {
        flags.stale = false;
        repair.patch = { ...repair.patch!, hash: 'b'.repeat(64) };
        return respond({ code: 'stale_patch', message: 'The patch changed. Review the new proposal.' }, 409);
      }
      expect(input.patchHash).toBe(repair.patch?.hash);
      repair = { ...repair, phase: 'verify', status: 'running', verificationRequest: input };
      return flags.loseVerify ? route.abort() : respond(repair, 202);
    }
    return missing();
  });
  return {
    health, connects, runs, lookups, flags, refreshes, repairs, verifications,
    ready() { if (project) project = { ...project, ...makeProject(), accounts: project.accounts, commands: project.commands, runs: project.runs, history: project.history }; },
    finish(confidence: ProjectFinding['confidence'] = 'confirmed', includeControl = false) {
      if (!project?.runs[0]) throw new Error('A run must exist first');
      Object.assign(project.runs[0], { status: 'completed', phase: 'Complete', finishedAt: timestamp,
        findings: [{ ...finding, confidence }], results: includeControl ? [result, control] : [result],
        discovery: project.discovery, metrics: { elapsedMs: 1640, modelCalls: 4, browserActions: 9, passed: 1, failed: 1, inconclusive: 1 } });
      project.history = [{ testerId: 'noa', runId: result.run.id, goal: journey.goal,
        outcome: 'failed', observations: ['Observed Monday after reload.'], createdAt: timestamp }];
    },
    setRepair(change: Partial<ProjectRepair>) {
      if (!repair) throw new Error('A repair must exist first');
      repair = { ...repair, ...change };
    },
    failPreparation() {
      if (!repair) throw new Error('A repair must exist first');
      repair = { ...repair, patch: undefined, status: 'completed', error: 'No patch could be proposed for this failure.' };
    },
    rejectPatch() {
      if (!repair) throw new Error('A repair must exist first');
      repair = { ...repair, status: 'completed', verification: {
        outcome: 'rejected', message: 'The original date reset still occurs.', results: [result, control],
      } };
    },
  };
}

const retryable = (job: ProjectRepair) => job.status === 'interrupted'
  || (job.status === 'completed' && job.verification?.outcome !== 'verified');

async function fillConnection(page: Page) {
  await page.getByLabel('Project name').fill('Room Desk');
  await page.getByLabel('Repository path').fill('/work/room-desk');
  await page.getByLabel('Running app URL').fill('http://127.0.0.1:9000');
  await page.getByLabel('Audience and intent').fill('Front desk staff move bookings.');
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const width of [375, 1440]) {
  test(`connects, runs, and lands on the latest findings at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const mock = await mockApi(page);
    await page.goto('/');
    await fillConnection(page);
    await expectNoOverflow(page);
    if (process.env.PROJECT_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.PROJECT_UI_SCREENSHOTS}/connect-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Connect project' }).click();
    await expect(page).toHaveURL(/\/projects\/desk$/);
    await expect(page.getByText('Reading reservation screens')).toBeVisible();
    mock.ready();
    await expect(page.getByRole('listitem').filter({ hasText: /^Reservations$/ }).first()).toBeVisible();
    if (process.env.PROJECT_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.PROJECT_UI_SCREENSHOTS}/ready-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Run test team' }).click();
    expect(mock.runs[0].mode).toBe('explore');
    await expect(page.getByText('Checking the booking form')).toBeVisible();
    mock.finish();
    await expect(page.getByRole('heading', { name: 'Reservation date resets' })).toBeVisible();
    await expect(page.getByText('Front desk staff may double book a room.')).toBeVisible();
    await expect(page.getByText('Saved reservation', { exact: true })).toBeVisible();
    await expect(page.getByText('Booking notes', { exact: true })).toBeVisible();
    await expect(page.getByText('Time zone preserved')).toBeHidden();
    await expect(page.getByText('12 source files')).toBeHidden();
    await expectNoOverflow(page);
    if (process.env.PROJECT_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.PROJECT_UI_SCREENSHOTS}/findings-${width}.png`, fullPage: true });
    await page.getByText('Source citations', { exact: true }).first().click();
    await expect(page.getByText(reference.excerpt).first()).toBeVisible();
    await expect(page.getByText(hash, { exact: true }).first()).toBeHidden();
    await page.getByText('Measured results', { exact: true }).click();
    await expect(page.getByText('12 source files')).toBeVisible();
    await expect(page.locator('dt').filter({hasText:/^Journeys$/})).toBeVisible();
    await page.getByText('Tester history', { exact: true }).click();
    await expect(page.getByText('Observed Monday after reload.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View run results' })).toHaveAttribute('href', '/projects/desk/runs/run-1');
    await expect(page.getByText('Browser profile', { exact: true }).first()).toBeVisible();
    await page.getByRole('link', { name: 'Shareable results' }).click();
    await expect(page).toHaveURL(/\/projects\/desk\/runs\/run-1$/);
    await expect(page.getByRole('heading', { name: finding.title })).toBeVisible();
  });
}

test('passes explicitly selected private runtime files with the repair commands',async({page})=>{
 await mockApi(page);await page.goto('/');await fillConnection(page);
 await page.getByText('Advanced connection setup',{exact:true}).click();
 await page.getByLabel('Start command',{exact:true}).fill('node\nserver.js');
 await page.getByLabel('Private runtime files (optional)',{exact:true}).fill('app/.data/credentials.json\napp/.data/settings.json');
 const sent=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/runner/projects'));
 await page.getByRole('button',{name:'Connect project'}).click();await expect(page).toHaveURL(/\/projects\/desk$/);
 expect((await sent).postDataJSON().commands.runtimeFiles).toEqual(['app/.data/credentials.json','app/.data/settings.json']);
});

test('recovers a lost connect response using only its request ID and no second write', async ({ page }) => {
  const mock = await mockApi(page);
  mock.flags.loseConnect = true;
  await page.goto('/');
  await fillConnection(page);
  await page.getByText('Advanced connection setup', { exact: true }).click();
  await page.getByRole('button', { name: 'Add development account' }).click();
  await page.getByLabel('Role or label').fill('Front desk');
  await page.getByLabel('Username').fill('dev-user');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-ui-password');
  await page.getByRole('button', { name: 'Connect project' }).click();
  await expect(page.getByRole('button', { name: 'Check connection' })).toBeVisible();
  const stored = await page.evaluate(() => ({ session: Object.values(sessionStorage), local: Object.values(localStorage) }));
  expect(stored.session).toContain(mock.connects[0]);
  expect(JSON.stringify(stored)).not.toMatch(/synthetic-ui-password|dev-user|room-desk/);
  await page.reload();
  await expect(page).toHaveURL(/\/projects\/desk$/);
  expect(mock.lookups).toEqual(mock.connects);
  expect(mock.connects).toHaveLength(1);
  expect(page.url()).not.toContain('synthetic-ui-password');
});

test('uses the accepted run after reload and offers test changes and an explicit refresh', async ({ page }) => {
  const mock = await mockApi(page, makeProject());
  mock.flags.loseRun = true;
  await page.goto('/projects/desk');
  await page.getByRole('button', { name: 'Run test team' }).click();
  await expect(page.getByRole('button', { name: 'Recover run request' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Checking the booking form')).toBeVisible();
  mock.finish('suspected');
  await expect(page.getByText('Suspected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare fix' })).toHaveCount(0);
  expect(mock.runs).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh understanding' }).click();
  await expect(page.getByText('Re-indexing changed source files')).toBeVisible();
  const refresh = mock.refreshes[0];
  expect(refresh).toBeTruthy();
  mock.flags.loseRun = false;
  mock.ready();
  await page.getByRole('button', { name: 'Test changes' }).click();
  expect(mock.runs[1].mode).toBe('release');
});

test('shows discovery failure even when model and execution are ready', async ({ page }) => {
  const project = { ...makeProject('failed'), error: 'The repository could not be indexed.' };
  const mock = await mockApi(page, project);
  mock.health.projectDiscoveryReady = false;
  await page.goto('/projects/desk');
  await expect(page.getByText(project.error)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh understanding' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run test team' })).toHaveCount(0);
});

test('reviews actual patch files, handles a stale patch, and recovers rejected verification after reload', async ({ page }) => {
  const mock = await mockApi(page, { ...makeProject(), accounts: [{ id: 'audit-account', label: 'Audit access' }] });
  await page.goto('/projects/desk');
  await page.getByRole('button', { name: 'Run test team' }).click();
  await expect(page.getByText('Checking the booking form')).toBeVisible();
  mock.finish('confirmed', true);
  await expect(page.getByText('Development account: Audit access', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare fix' }).click();
  await expect(page).toHaveURL(/\/project-repairs\/fix-1$/);
  expect(mock.repairs[0].runId).toBe('run-1');
  const diff = page.getByLabel(`Changed lines in ${reference.path}`, { exact: true });
  await expect(diff).toBeHidden();
  await page.locator('summary').filter({ hasText: reference.path }).click();
  await expect(diff.getByText('date: originalDate')).toBeVisible();
  await expect(diff.getByText('date: enteredDate')).toBeVisible();
  await expect(page.getByLabel(`${reference.path} after`, { exact: true })).toBeHidden();
  await expect(page.getByText(hash, { exact: true }).first()).toBeHidden();
  mock.flags.stale = true;
  await page.getByRole('button', { name: 'Verify patch' }).click();
  await expect(page.getByText('The patch changed. Review the new proposal.')).toBeVisible();
  mock.flags.loseVerify = true;
  await page.getByRole('button', { name: 'Verify patch' }).click();
  await expect(page.getByText('Verifying patch', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Verifying patch', { exact: true })).toBeVisible();
  mock.rejectPatch();
  await expect(page.getByText('Fix rejected', { exact: true })).toBeVisible();
  await expect(page.getByText('The original date reset still occurs.')).toBeVisible();
  const verification = page.getByRole('region', { name: 'Verification results' });
  await expect(verification.getByText('Saved reservation', { exact: true })).toBeVisible();
  await expect(verification.getByText('Time zone preserved')).toBeHidden();
  expect(mock.verifications.map(item => item.patchHash)).toEqual([hash, 'b'.repeat(64)]);
});

async function prepareFirstFix(page: Page, mock: Awaited<ReturnType<typeof mockApi>>) {
  await page.goto('/projects/desk');
  await page.getByRole('button', { name: 'Run test team' }).click();
  await expect(page.getByText('Checking the booking form')).toBeVisible();
  mock.finish('confirmed', true);
  await page.getByRole('button', { name: 'Prepare fix' }).click();
  await expect(page).toHaveURL(/\/project-repairs\/fix-1$/);
  await page.goto('/projects/desk');
}

test('retries a repair that proposed no patch with a new request ID while keeping the prior evidence', async ({ page }) => {
  const mock = await mockApi(page, { ...makeProject(), accounts: [{ id: 'audit-account', label: 'Audit access' }] });
  await prepareFirstFix(page, mock);
  mock.failPreparation();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Review last attempt' })).toHaveAttribute('href', '/project-repairs/fix-1');
  await expect(page.getByRole('button', { name: 'Prepare fix' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry fix' }).click();
  await expect(page).toHaveURL(/\/project-repairs\/fix-2$/);
  expect(mock.repairs).toHaveLength(2);
  expect(mock.repairs[1].runId).toBe(mock.repairs[0].runId);
  expect(mock.repairs[1].requestId).not.toBe(mock.repairs[0].requestId);
  await expect(page.getByText('Ready for review')).toBeVisible();
  await page.goto('/projects/desk');
  await expect(page.getByRole('link', { name: 'Review fix' })).toHaveAttribute('href', '/project-repairs/fix-2');
  await expect(page.getByRole('button', { name: 'Retry fix' })).toHaveCount(0);
  expect(mock.repairs).toHaveLength(2);
});

const unsuccessful: [string, Partial<ProjectRepair>][] = [
  ['rejected verification', { phase: 'verify', status: 'completed', verification: { outcome: 'rejected', message: 'Still fails.', results: [result, control] } }],
  ['inconclusive verification', { phase: 'verify', status: 'completed', verification: { outcome: 'inconclusive', message: 'Could not tell.', results: [result, control] } }],
  ['interrupted preparation', { status: 'interrupted', error: 'The runner restarted.' }],
  ['interrupted verification', { phase: 'verify', status: 'interrupted', error: 'The runner restarted.' }],
];
for (const [name, change] of unsuccessful) {
  test(`offers a retry after ${name}`, async ({ page }) => {
    const mock = await mockApi(page, { ...makeProject(), accounts: [{ id: 'audit-account', label: 'Audit access' }] });
    await prepareFirstFix(page, mock);
    mock.setRepair(change);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Review last attempt' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry fix' })).toBeEnabled();
  });
}

const settled: [string, Partial<ProjectRepair>][] = [
  ['queued preparation', { status: 'queued', patch: undefined }],
  ['running preparation', { status: 'running', patch: undefined }],
  ['a patch awaiting review', {}],
  ['running verification', { phase: 'verify', status: 'running' }],
  ['a verified fix', { phase: 'verify', status: 'completed', verification: { outcome: 'verified', message: 'Passes.', results: [result, control] } }],
];
for (const [name, change] of settled) {
  test(`offers no retry for ${name}`, async ({ page }) => {
    const mock = await mockApi(page, { ...makeProject(), accounts: [{ id: 'audit-account', label: 'Audit access' }] });
    await prepareFirstFix(page, mock);
    mock.setRepair(change);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Review fix' })).toHaveAttribute('href', '/project-repairs/fix-1');
    await expect(page.getByRole('button', { name: /Retry fix|Prepare fix|Recover fix request/ })).toHaveCount(0);
    expect(mock.repairs).toHaveLength(1);
  });
}

test('recovers a lost retry response with the same new request ID and no duplicate launch', async ({ page }) => {
  const mock = await mockApi(page, { ...makeProject(), accounts: [{ id: 'audit-account', label: 'Audit access' }] });
  await prepareFirstFix(page, mock);
  mock.failPreparation();
  await page.reload();
  mock.flags.loseRepair = true;
  await page.getByRole('button', { name: 'Retry fix' }).click();
  await expect(page.getByRole('button', { name: 'Recover fix request' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review last attempt' })).toBeVisible();
  mock.flags.loseRepair = false;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Review fix' })).toHaveAttribute('href', '/project-repairs/fix-2');
  await expect(page.getByRole('button', { name: /Retry fix|Recover fix request/ })).toHaveCount(0);
  expect(mock.repairs).toHaveLength(2);
  expect(mock.repairs[1].requestId).not.toBe(mock.repairs[0].requestId);
});

test('keeps invalid advanced origins in the form until they are corrected', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await fillConnection(page);
  await page.getByText('Advanced connection setup', { exact: true }).click();
  await page.getByLabel('Additional allowed origins').fill('not a url');
  await page.getByRole('button', { name: 'Connect project' }).click();
  await expect(page.getByText('Enter a valid URL for each additional allowed origin.')).toBeVisible();
  expect(mock.connects).toHaveLength(0);
  await page.getByLabel('Additional allowed origins').fill('http://127.0.0.1:9001');
  await page.getByRole('button', { name: 'Connect project' }).click();
  await expect(page).toHaveURL(/\/projects\/desk$/);
  expect(mock.connects).toHaveLength(1);
});

test('keeps legacy studies reachable under Advanced', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(navigation.getByRole('link', { name: 'Studies', exact: true })).toBeHidden();
  await navigation.getByText('Advanced', { exact: true }).click();
  await navigation.getByRole('link', { name: 'Studies', exact: true }).click();
  await expect(page).toHaveURL(/\/studies$/);
  await expect(page.getByRole('heading', { name: 'New study', exact: true })).toBeVisible();
});
