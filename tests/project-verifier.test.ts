import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ProjectCheck } from '../packages/contracts/src/projects';
import { captureProjectChecks, verifyProjectChecks } from '../apps/runner/src/project-verifier';

let server: Server;
let browser: Browser;
let page: Page;
let origin: string;
let stock: string;
let requests: string[];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    requests.push(path);
    if (path === '/unavailable') {
      res.writeHead(503).end('Unavailable');
      return;
    }
    if (path === '/expired-session' || path === '/editor?id=42') {
      res.writeHead(302, { location: path === '/expired-session' ? '/editor' : '/editor?id=43#details' }).end();
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: origin.replace('127.0.0.1', 'localhost') + '/editor' }).end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(path === '/inventory' ? `
      <label for="stock">Stock</label><input id="stock" value="${stock}">
      <p data-testid="owner">  Test Store  </p>
      <button>Archive</button>
    ` : `
      <label for="title">Title</label><input id="title" value="Original">
      <button onclick="document.querySelector('#message').textContent = 'Saved'; document.querySelector('#title').value = 'Optimistic'">Save</button>
      <button>Save as copy</button>
      <button>Duplicate</button><button>Duplicate</button>
      <p role="status" id="message">Ready</p>
      <span data-testid="badge">Active</span><span data-testid="badge" hidden>Inactive</span>
    `);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>(done => server.close(() => done()));
});
beforeEach(async () => {
  await page?.close();
  stock = '009';
  requests = [];
  page = await browser.newPage();
  await page.goto(`${origin}/editor`);
});

function check(id: string, overrides: Partial<ProjectCheck> = {}): ProjectCheck {
  return {
    id, label: id, kind: 'visible', phase: 'after_action',
    locator: { by: 'role', value: 'button', name: 'Save' },
    basis: 'requirement', sources: [{ path: 'requirements.md', startLine: 2, endLine: 2, hash: 'a'.repeat(64), excerpt: 'Save changes' }],
    ...overrides,
  };
}

it('checks optimistic UI before reloading the original page and reports results in input order', async () => {
  const checks = [
    check('saved-title', { phase: 'after_reload', kind: 'field', locator: { by: 'label', value: 'Title' }, expected: 'Optimistic' }),
    check('feedback', { kind: 'text', locator: { by: 'role', value: 'status' }, expected: 'Saved' }),
    check('persisted-title', { phase: 'after_reload', path: '/editor', kind: 'field', locator: { by: 'label', value: 'Title' }, expected: 'Original' }),
  ];
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  const results = await verifyProjectChecks(page, checks, origin);
  expect(results).toMatchObject([
    { id: 'saved-title', status: 'failed', actual: 'Original', expected: 'Optimistic' },
    { id: 'feedback', status: 'passed', actual: 'Saved', expected: 'Saved', phase: 'after_action', basis: 'requirement', label: 'feedback', sources: checks[1].sources },
    { id: 'persisted-title', status: 'passed', actual: 'Original', expected: 'Original' },
  ]);
});

it('reloads the original action page when a pathless check follows a check on a different route', async () => {
  const results = await verifyProjectChecks(page, [
    check('archive', { phase: 'after_reload', path: '/inventory', locator: { by: 'role', value: 'button', name: 'Archive' } }),
    check('save', { phase: 'after_reload' }),
  ], origin);
  expect(results.map(result => result.status)).toEqual(['passed', 'passed']);
  expect(page.url()).toBe(`${origin}/editor`);
});

it('loads a fresh document even when readback only changes the fragment', async () => {
  await page.getByLabel('Title').fill('Unsaved');

  const [result] = await verifyProjectChecks(page, [
    check('fragment', { phase: 'after_reload', path: '/editor#details', kind: 'field', locator: { by: 'label', value: 'Title' }, expected: 'Original' }),
  ], origin);
  expect(result).toMatchObject({ status: 'passed', actual: 'Original' });
  expect(page.url()).toBe(`${origin}/editor#details`);
});

it('treats query and fragment as part of the readback and action page identity', async () => {
  await page.goto(`${origin}/editor?id=43#details`);
  const results = await verifyProjectChecks(page, [
    check('wrong-record', { phase: 'after_reload', path: '/editor?id=42#details' }),
    check('wrong-action-record', { path: '/editor?id=42#details' }),
    check('wrong-action-fragment', { path: '/editor?id=43' }),
    check('current-action-record', { path: '/editor?id=43#details' }),
  ], origin);
  expect(results.map(result => result.status)).toEqual(['not_evaluated', 'not_evaluated', 'not_evaluated', 'passed']);
});

it('captures visible, field and trimmed text before the action and detects later corruption with frozen expectations', async () => {
  const checks = [
    check('stock', { phase: 'preserve', path: '/inventory', kind: 'field', locator: { by: 'label', value: 'Stock' } }),
    check('owner', { phase: 'preserve', path: '/inventory', kind: 'text', locator: { by: 'testId', value: 'owner' } }),
    check('archive', { phase: 'preserve', path: '/inventory', locator: { by: 'role', value: 'button', name: 'Archive' } }),
    check('already-captured', { phase: 'preserve', path: '/inventory', kind: 'field', locator: { by: 'label', value: 'Stock' }, expected: '007' }),
  ];
  const captured = await captureProjectChecks(page, checks, origin);
  expect(captured.map(item => item.expected)).toEqual(['009', 'Test Store', true, '007']);
  expect(checks.map(item => item.expected)).toEqual([undefined, undefined, undefined, '007']);

  stock = '4';
  requests = [];
  const results = await verifyProjectChecks(page, captured.map(item => Object.freeze(item)), origin);
  expect(results).toMatchObject([
    { status: 'failed', expected: '009', actual: '4' },
    { status: 'passed', expected: 'Test Store', actual: 'Test Store' },
    { status: 'passed', expected: true, actual: true },
    { status: 'failed', expected: '007', actual: '4' },
  ]);
  expect(captured.map(item => item.expected)).toEqual(['009', 'Test Store', true, '007']);
  expect(requests.filter(path => path === '/inventory')).toHaveLength(4);
});

it('rejects capture when the readback target is missing', async () => {
  await expect(captureProjectChecks(page, [
    check('missing', { phase: 'preserve', path: '/inventory', locator: { by: 'label', value: 'Missing' }, kind: 'field' }),
  ], origin)).rejects.toThrow(/preserv/i);
}, 5000);

it('reports an uncaptured preserve check as not evaluated', async () => {
  const [result] = await verifyProjectChecks(page, [
    check('uncaptured', { phase: 'preserve', path: '/inventory' }),
  ], origin);
  expect(result.status).toBe('not_evaluated');
  expect(requests).not.toContain('/inventory');
});

it('requires exact matches and considers only visible elements when determining uniqueness', async () => {
  const results = await verifyProjectChecks(page, [
    check('exact'),
    check('ambiguous', { locator: { by: 'role', value: 'button', name: 'Duplicate' } }),
    check('hidden-twin', { locator: { by: 'testId', value: 'badge' } }),
    check('partial', { locator: { by: 'role', value: 'button', name: 'copy' } }),
    check('expected-absence', { locator: { by: 'text', value: 'Deleted' }, expected: false }),
  ], origin);
  expect(results).toMatchObject([
    { status: 'passed' }, { status: 'not_evaluated' }, { status: 'passed' },
    { status: 'failed', actual: false }, { status: 'passed', expected: false, actual: false },
  ]);
}, 6000);

it('cancels a pending locator and skips remaining navigations', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const started = performance.now();
  try {
    const results = await verifyProjectChecks(page, [
      check('waiting', { locator: { by: 'text', value: 'Missing' } }),
      check('later', { phase: 'after_reload', path: '/inventory' }),
    ], origin, controller.signal);
    expect(results).toMatchObject([
      { status: 'not_evaluated', message: expect.stringMatching(/cancel/i) },
      { status: 'not_evaluated', message: expect.stringMatching(/cancel/i) },
    ]);
    expect(performance.now() - started).toBeLessThan(1200);
    expect(requests).not.toContain('/inventory');
  } finally {
    clearTimeout(timer);
  }
});

it('rejects unsafe destinations and classifies uninspectable documents as not evaluated', async () => {
  const results = await verifyProjectChecks(page, [
    check('absolute', { phase: 'after_reload', path: `${origin}/inventory` }),
    check('scheme-relative', { phase: 'after_reload', path: '//example.invalid/inventory' }),
    check('parser-whitespace', { phase: 'after_reload', path: '/\t/example.invalid/inventory' }),
    check('server-error', { phase: 'after_reload', path: '/unavailable' }),
    check('expired-session', { phase: 'after_reload', path: '/expired-session' }),
    check('redirected', { phase: 'after_reload', path: '/redirect' }),
  ], origin);
  expect(results.map(result => result.status)).toEqual(Array(6).fill('not_evaluated'));
  expect(requests).not.toContain('/inventory');
  expect((await verifyProjectChecks(page, [check('wrong-origin')], 'https://example.invalid'))[0].status).toBe('not_evaluated');
  await page.close();
  expect((await verifyProjectChecks(page, [check('closed')], origin))[0].status).toBe('not_evaluated');
});
