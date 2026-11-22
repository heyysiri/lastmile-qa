import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { desktopContext } from '../packages/contracts/src/examples';
import type { Project, ProjectCase, ProjectRepair, ProjectRun } from '../packages/contracts/src/projects';
import { resolveProxyTarget } from '../apps/lastmile/lib/proxy-policy';
import { buildGitHubConnectRequest, canRetryPublish, githubRepoName, relativeTime, shortSha } from '../apps/lastmile/lib/projects';
import { GitHubSource } from '../apps/lastmile/components/GitHubSource';
import { TestInventory } from '../apps/lastmile/components/TestInventory';
import { GitHubConnectForm, LocalConnectForm } from '../apps/lastmile/components/ProjectConnect';
import { RepairPublication, repairStatus } from '../apps/lastmile/components/ProjectRepairReview';

const dashboardRequire = createRequire(new URL('../apps/lastmile/package.json', import.meta.url));
const { createElement } = dashboardRequire('react');
const { renderToStaticMarkup } = dashboardRequire('react-dom/server');
const render = (component: unknown, props: object) => renderToStaticMarkup(createElement(component, props));

const sha = '0123456789abcdef0123456789abcdef01234567';
const timestamp = '2026-11-20T08:00:00.000Z';
const now = Date.parse('2026-11-20T08:05:00.000Z');
const project = {
  id: 'vendure', name: 'Vendure Shop', appUrl: 'http://127.0.0.1:4010', repositoryPath: '/private/checkout', allowedOrigins: [], brief: 'Shoppers.', requirements: '',
  accounts: [], createdAt: timestamp, updatedAt: timestamp, status: 'ready', progress: '',
  github: { repositoryUrl: 'https://github.com/heyysiri/vendure.git', branch: 'lastmile-demo', setup: 'auto', entryPath: '/', sha, syncedAt: timestamp, lastTestedSha: 'fedcba9876543210' },
} as Project;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
const base = { name: 'Vendure Shop', repositoryUrl: ' https://github.com/heyysiri/vendure ', branch: ' lastmile-demo ', brief: 'Shoppers return to saved carts.' };

describe('GitHub lifecycle routes in the dashboard proxy', () => {
  it.each([
    ['POST', 'projects/github'], ['POST', 'projects/vendure/sync'], ['POST', 'project-repairs/fix-1/publish'],
  ])('allows %s %s', (method, path) => expect(resolveProxyTarget(method, path.split('/'))).toBe(`/api/${path}`));

  it.each([
    ['GET', 'projects/vendure/sync'], ['PUT', 'projects/github'], ['POST', 'projects/github/sync/extra'],
    ['GET', 'project-repairs/fix-1/publish'], ['POST', 'project-repairs/fix-1/publish/extra'], ['POST', 'project-repairs/publish'],
    ['POST', 'projects/by-request/sync'], ['POST', 'projects/vendure/merge'], ['POST', 'project-repairs/fix-1/merge'],
  ])('denies %s %s', (method, path) => expect(resolveProxyTarget(method, path.split('/'))).toBeNull());
});

describe('GitHub display helpers', () => {
  it('abbreviates commits and names repositories without credentials or suffixes', () => {
    expect(shortSha(sha)).toBe('0123456');
    expect(shortSha(undefined)).toBe('');
    expect(githubRepoName('https://github.com/heyysiri/vendure.git')).toBe('heyysiri/vendure');
    expect(githubRepoName('https://github.com/heyysiri/vendure/')).toBe('heyysiri/vendure');
  });

  it('uses relative time for recent syncs and a readable date once it is old', () => {
    expect(relativeTime('2026-11-20T08:04:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-11-20T08:00:00.000Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-11-20T05:05:00.000Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-10T08:00:00.000Z', now)).toMatch(/Nov/);
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('GitHub connection request', () => {
  it('builds the simple automatic request with trimmed values and no credentials', () => {
    const result = buildGitHubConnectRequest(form(base), 'connect-1', 0);
    expect(result).toEqual({ ok: true, request: expect.objectContaining({
      requestId: 'connect-1', repositoryUrl: 'https://github.com/heyysiri/vendure', branch: 'lastmile-demo', setup: 'auto', entryPath: '/', accounts: [], requirements: '',
    }) });
    if (result.ok) {
      expect(result.request.commands).toBeUndefined();
      expect(result.request.install).toBeUndefined();
    }
  });

  it('keeps the setup choice, entry path and development accounts only when supplied', () => {
    const result = buildGitHubConnectRequest(form({
      ...base, setup: 'custom', entryPath: '/shop', install: 'pnpm\ninstall\n--frozen-lockfile', build: 'pnpm\nbuild', start: 'pnpm\nstart', cwd: 'apps/web',
      'label-0': 'Buyer', 'username-0': 'buyer', 'password-0': 'synthetic',
    }), 'connect-2', 1);
    expect(result).toMatchObject({ ok: true, request: {
      setup: 'custom', entryPath: '/shop', install: ['pnpm', 'install', '--frozen-lockfile'],
      commands: { start: ['pnpm', 'start'], build: ['pnpm', 'build'], cwd: 'apps/web' },
      accounts: [{ label: 'Buyer', username: 'buyer', password: 'synthetic' }],
    } });
  });

  it('ignores hidden custom commands while automatic setup is selected', () => {
    const result = buildGitHubConnectRequest(form({ ...base, setup: 'auto', start: 'node\nserver.js', install: 'npm\ninstall' }), 'connect-3', 0);
    expect(result).toMatchObject({ ok: true, request: { setup: 'auto' } });
    if (result.ok) expect(result.request).not.toHaveProperty('commands');
  });

  it.each([
    [{ repositoryUrl: 'https://example.com/a/b' }, /GitHub repository URL/],
    [{ repositoryUrl: 'https://github.com/a/b/tree/main' }, /GitHub repository URL/],
    [{ branch: '-main' }, /branch/i],
    [{ setup: 'custom' }, /start command/i],
    [{ entryPath: 'shop' }, /starting page/i],
  ])('explains invalid input %j in plain language', (change, message) => {
    const result = buildGitHubConnectRequest(form({ ...base, ...change }), 'connect-4', 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});

describe('GitHub source metadata', () => {
  it('shows repository, branch, short commit, sync time and last tested commit compactly', () => {
    const html = render(GitHubSource, { project, now });
    expect(html).toContain('heyysiri/vendure');
    expect(html).toContain('href="https://github.com/heyysiri/vendure"');
    for (const value of ['lastmile-demo', '0123456', '5 min ago', 'fedcba9']) expect(html).toContain(value);
    expect(html).toContain('dateTime="2026-11-20T08:00:00.000Z"');
    expect(html).not.toContain(sha);
    expect(html).not.toContain('127.0.0.1:4010');
    expect(html).not.toContain('/private/checkout');
  });

  it('says plainly when no commit has been tested or the checkout has not synced', () => {
    const html = render(GitHubSource, { project: { ...project, github: { ...project.github!, lastTestedSha: undefined, sha: undefined, syncedAt: undefined } }, now });
    expect(html).toContain('Not synced yet');
    expect(html).toContain('Not tested yet');
  });

  it('renders nothing for a local project', () => {
    expect(render(GitHubSource, { project: { ...project, github: undefined }, now })).toBe('');
  });
});

describe('test inventory', () => {
  const tester = { id: 'noa', name: 'Noa', role: 'Shopper', summary: 'Keeps a cart.', context: desktopContext };
  const journey = { id: 'cart', testerId: 'noa', title: 'Return to a saved cart', goal: 'Reopen the saved cart.', entryPath: '/', inputs: {}, checks: [], sources: [], reason: 'Returning shoppers.' };
  const cases: ProjectCase[] = [
    { id: 'case-cart', tester, journey, createdAt: timestamp, lastSeenAt: timestamp, lastRunId: 'run-1', outcome: 'failed' },
    { id: 'case-new', tester, journey: { ...journey, id: 'wishlist', title: 'Open a wishlist' }, createdAt: timestamp, lastSeenAt: timestamp },
  ];

  it('lists persistent cases with stable IDs, tester, last outcome and an unrun state', () => {
    const html = render(TestInventory, { cases, coverageMode: 'retain' });
    for (const value of ['Return to a saved cart', 'Open a wishlist', 'Noa', 'Shopper', 'failed', 'Not run yet', 'Existing coverage kept']) expect(html).toContain(value);
    expect(html).toContain('data-case-id="case-cart"');
    expect(html).toContain('data-case-id="case-new"');
    expect(html).not.toContain('{"');
  });

  it('describes refreshed coverage and renders nothing without cases', () => {
    expect(render(TestInventory, { cases, coverageMode: 'refresh' })).toContain('Coverage refreshed for the latest source');
    expect(render(TestInventory, { cases: [], coverageMode: 'retain' })).toBe('');
    expect(render(TestInventory, { cases: undefined })).toBe('');
  });
});

describe('connection forms', () => {
  const session = { restored: true, restoredId: undefined, pendingId: undefined, canResend: false, busy: false, error: null,
    draft: { current: {} }, accountCount: 0, setAccountCount: () => undefined, setError: () => undefined, lookup: async () => undefined, send: async () => undefined };
  const props = { ready: true, checkingHealth: false, session };

  it('asks only for the repository, branch, name and audience before any setup', () => {
    const html = render(GitHubConnectForm, props);
    for (const label of ['Repository URL', 'Branch', 'Project name', 'Audience and intent']) expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('https://github.com/owner/repo');
    expect(html).toContain('Connect from GitHub');
    for (const forbidden of [/Repository path/, /Running app URL/]) expect(html).not.toMatch(forbidden);
    expect(html).toMatch(/<details[^>]*class="project-disclosure"[^>]*>\s*<summary>Setup<\/summary>/);
    expect(html).toContain('Detected automatically');
    expect(html).toContain('name="entryPath"');
    expect(html).not.toContain('Account 1');
  });

  it('keeps the local repository form as the secondary development path', () => {
    const html = render(LocalConnectForm, props);
    for (const label of ['Repository path', 'Running app URL', 'Project name']) expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('Connect project');
    expect(html).not.toContain('Repository URL');
  });
});

describe('automatic repair publication', () => {
  const run = { id: 'run-1', projectId: 'vendure', request: { requestId: 'run-request', mode: 'release', autoRepair: true }, status: 'completed', phase: 'Complete', createdAt: timestamp, results: [], findings: [], summary: '', metrics: { elapsedMs: 0, modelCalls: 0, browserActions: 0, passed: 0, failed: 1, inconclusive: 0 } } as ProjectRun;
  const verified: NonNullable<ProjectRepair['verification']> = { outcome: 'verified', message: 'Passed.', results: [] };
  const job = (change: Partial<ProjectRepair>) => ({
    id: 'fix-1', projectId: 'vendure', request: { requestId: 'auto', runId: 'run-1', automatic: true }, status: 'running', phase: 'publish',
    createdAt: timestamp, sourceRun: run, project, verification: verified, ...change,
  }) as ProjectRepair;
  const pullRequest = { url: 'https://github.com/heyysiri/vendure/pull/7', number: 7, branch: 'lastmile/fix-1', headSha: 'a'.repeat(40), baseSha: sha };

  it('labels each automatic stage, including publishing', () => {
    expect(repairStatus(job({ status: 'running', phase: 'prepare', verification: undefined }))).toBe('Preparing fix');
    expect(repairStatus(job({ status: 'running', phase: 'verify', verification: undefined }))).toBe('Verifying patch');
    expect(repairStatus(job({ status: 'queued' }))).toBe('Pull request queued');
    expect(repairStatus(job({ status: 'running' }))).toBe('Publishing pull request');
    expect(repairStatus(job({ status: 'completed', pullRequest }))).toBe('Pull request ready');
    expect(repairStatus(job({ status: 'interrupted' }))).toBe('Fix verified, pull request not opened');
  });

  it('shows progress while the verified fix is being published', () => {
    const html = render(RepairPublication, { job: job({ status: 'running' }), onChange: () => undefined });
    expect(html).toContain('Publishing pull request');
    expect(html).not.toContain('Retry PR');
    expect(html).not.toContain('Review pull request');
  });

  it('links to the pull request and explains the manual merge then sync', () => {
    const html = render(RepairPublication, { job: job({ status: 'completed', pullRequest }), onChange: () => undefined });
    expect(html).toMatch(/<a[^>]*href="https:\/\/github\.com\/heyysiri\/vendure\/pull\/7"[^>]*rel="noopener noreferrer"[^>]*>Review pull request/);
    expect(html).toContain('#7');
    expect(html).toMatch(/Merge it on GitHub yourself, then choose[^.]*Sync &amp; test/);
    expect(html).not.toContain('Retry PR');
  });

  it('offers Retry PR for a failed publish and never offers to regenerate the fix', () => {
    const failed = job({ status: 'interrupted', error: 'GitHub rejected the push.' });
    expect(canRetryPublish(failed)).toBe(true);
    const html = render(RepairPublication, { job: failed, onChange: () => undefined });
    expect(html).toContain('Retry PR');
    expect(html).not.toMatch(/Retry fix|Prepare fix|regenerat/i);
    expect(html).toContain('same verified patch');
  });

  it.each([
    ['active publish', job({ status: 'running' })],
    ['an existing pull request', job({ status: 'completed', pullRequest })],
    ['an unverified patch', job({ status: 'completed', verification: { ...verified, outcome: 'rejected' } })],
    ['a local project', job({ status: 'interrupted', project: { ...project, github: undefined } })],
  ])('does not allow publishing for %s', (_, candidate) => expect(canRetryPublish(candidate)).toBe(false));
});
