import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssertionSchema, LocatorSchema, type ScenarioDefinition, type StepEvent } from '../packages/contracts/src/index';
import { BrowserActionSchema } from '../packages/contracts/src/runtime';
import type { ProjectCheck } from '../packages/contracts/src/projects';
import { desktopContext } from '../packages/contracts/src/examples';
import { createBrowserSession, BrowserActionError, type BrowserSession } from '../apps/runner/src/browser';
import { captureProjectChecks, verifyProjectChecks } from '../apps/runner/src/project-verifier';
import { verifyOutcome } from '../apps/runner/src/verifier';

const INJECTION = 'x"], input, [name="y';
const PRIVATE_ACCOUNT = 'acct-private@example.test';
const unlabelled = `
  <div><label for="no-such-id-1">Product name</label><input name="translations.0.name" value="Widget"></div>
  <div><label for="no-such-id-2">Stock on hand</label><input type="number" name="stockLevels.0.stockOnHand" value="5"></div>
  <div><label for="no-such-id-3">Reorder level</label><input type="number" name="stockLevels.0.reorder" value="9"></div>`;
const fixture = `
  <aside id="sidebar"></aside>
  ${unlabelled}
  <input name='${INJECTION.replaceAll('"', '&quot;')}' value="injected">
  <input name="y" value="plain-y">
  <input name="items[0][qty]" value="bracketed">
  <input name="back\\slash" value="slashed">
  <input name="a b" value="spaced">
  <input name="dup" value="one"><textarea name="dup">two</textarea>
  <input name="twin" value="visible-twin"><input name="twin" value="hidden-twin" style="display:none">
  <input type="hidden" name="ghost" value="invisible"><input name="ghost" value="zero" style="visibility:hidden">
  <select name="plan"><option value="a">A</option><option value="b">B</option></select>
  <input type="password" name="secret_pw" value="hunter2">
  <input name="${PRIVATE_ACCOUNT}-field" value="x">
  <label>Contact <input name="contact" value="c"></label>
  <label for="wired">Wired label</label><input id="wired" name="wired" value="w">
  <input name="${'n'.repeat(250)}" value="too-long-name">
  <script>
    document.querySelector('#sidebar').innerHTML = location.search.includes('bulk')
      ? Array.from({length: 1500}, (_, i) => '<a href="#item-' + i + '">Navigation item number ' + i + ' with padding</a>').join('')
      : '';
    if (location.search.includes('many')) document.body.insertAdjacentHTML('beforeend',
      Array.from({length: 100}, (_, i) => '<input name="bulk.' + i + '">').join(''));
  </script>`;

let server: Server;
let origin: string;
let stock = '5';
let browser: Browser;
let page: Page;
const sessions: BrowserSession[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url?.startsWith('/inventory')
      ? `<input name="translations.0.name" value="Widget"><input type="number" name="stockLevels.0.stockOnHand" value="${stock}">`
      : fixture);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); await new Promise<void>(done => server?.close(() => done())); });
beforeEach(async () => { stock = '5'; page = await browser.newPage(); await page.goto(`${origin}/`); });
afterEach(async () => {
  await page?.close();
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function session(extra: Partial<Parameters<typeof createBrowserSession>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'field-name-'));
  dirs.push(directory);
  const created = await createBrowserSession({
    pack: desktopContext, inputs: {}, origin, artifactDirectory: directory, signal: AbortSignal.timeout(30_000), onStep: () => {}, ...extra,
  });
  sessions.push(created);
  return created;
}
const byName = (value: string) => ({ by: 'fieldName' as const, value });
function check(id: string, overrides: Partial<ProjectCheck> = {}): ProjectCheck {
  return {
    id, label: id, kind: 'field', phase: 'after_action', locator: byName('stockLevels.0.stockOnHand'),
    basis: 'requirement', sources: [{ path: 'requirements.md', startLine: 2, endLine: 2, hash: 'a'.repeat(64), excerpt: 'Stock' }],
    ...overrides,
  };
}
const fieldLines = (observation: string) => observation.split('\n').filter(line => line.startsWith('- fieldName "'));

describe('contract', () => {
  it('accepts fieldName locators in checks, assertions and browser actions', () => {
    expect(LocatorSchema.parse(byName('stockLevels.0.stockOnHand'))).toEqual(byName('stockLevels.0.stockOnHand'));
    expect(AssertionSchema.safeParse({ id: 'stock', kind: 'field', locator: byName('a'), expected: { literal: '1' } }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ tool: 'fill', locator: byName('a'), value: { literal: '1' } }).success).toBe(true);
  });
  it('rejects an accessible-name qualifier and control characters in a field name', () => {
    expect(LocatorSchema.safeParse({ by: 'fieldName', value: 'a', name: 'Stock' }).success).toBe(false);
    expect(LocatorSchema.safeParse(byName('a\u0000b')).success).toBe(false);
    expect(LocatorSchema.safeParse(byName('a\nb')).success).toBe(false);
  });
});

describe('project verifier', () => {
  it('captures the preserved value, detects a write to the other field, and keeps the untouched field passing', async () => {
    const preserve = [
      check('stock', { phase: 'preserve', path: '/inventory' }),
      check('title', { phase: 'preserve', path: '/inventory', locator: byName('translations.0.name') }),
    ];
    const captured = await captureProjectChecks(page, preserve, origin);
    expect(captured.map(item => item.expected)).toEqual(['5', 'Widget']);
    stock = '12';
    const results = await verifyProjectChecks(page, captured, origin);
    expect(results).toMatchObject([{ status: 'failed', expected: '5', actual: '12' }, { status: 'passed', expected: 'Widget', actual: 'Widget' }]);
  });

  it('never fakes a pass for duplicate visible matches, and ignores hidden twins', async () => {
    const [duplicate, twin, hidden] = await verifyProjectChecks(page, [
      check('dup', { locator: byName('dup'), expected: 'one' }),
      check('twin', { locator: byName('twin'), expected: 'visible-twin' }),
      check('ghost', { locator: byName('ghost'), expected: 'invisible' }),
    ], origin);
    expect(duplicate).toMatchObject({ status: 'not_evaluated', message: 'Locator has multiple visible matches' });
    expect(twin).toMatchObject({ status: 'passed', actual: 'visible-twin' });
    expect(hidden).toMatchObject({ status: 'failed', message: 'No visible element matches the locator' });
    await expect(captureProjectChecks(page, [check('dup', { phase: 'preserve', path: '/', locator: byName('dup') })], origin))
      .rejects.toThrow(/multiple visible/);
  });

  it('matches injection-looking, bracketed, backslashed and spaced names exactly and nothing else', async () => {
    const names: Array<[string, string]> = [[INJECTION, 'injected'], ['y', 'plain-y'], ['items[0][qty]', 'bracketed'], ['back\\slash', 'slashed'], ['a b', 'spaced']];
    const results = await verifyProjectChecks(page, names.map(([name, expected], index) => check(`n${index}`, { locator: byName(name), expected })), origin);
    expect(results.map(result => result.status)).toEqual(names.map(() => 'passed'));
  });
});

describe('outcome verifier', () => {
  const contract = (locator: unknown, expected: string) => ({ scope: 'ui_only', assertions: [{ id: 'a', kind: 'field', locator, expected: { literal: expected } }] }) as ScenarioDefinition['contract'];
  const run = (locator: unknown, expected: string) => verifyOutcome({ page, contract: contract(locator, expected), inputs: {}, readState: async () => ({}), timeoutMs: 300 });
  it('reads the correct unlabelled field, reports duplicates as ambiguous and misses as failed', async () => {
    expect((await run(byName('stockLevels.0.stockOnHand'), '5'))[0]).toMatchObject({ status: 'passed' });
    expect((await run(byName('stockLevels.0.reorder'), '5'))[0]).toMatchObject({ status: 'failed', actual: '9' });
    expect((await run(byName('dup'), 'one'))[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('Ambiguous') });
    expect((await run(byName('ghost'), 'invisible'))[0]).toMatchObject({ status: 'failed', actual: { visibleMatches: 0 } });
    expect((await run(byName(INJECTION), 'injected'))[0]).toMatchObject({ status: 'passed' });
    for (const miss of ['stockLevels.0', 'STOCKLEVELS.0.STOCKONHAND', '*', 'x', 'y"]', 'items[0]']) {
      expect((await run(byName(miss), '5'))[0]).toMatchObject({ status: 'failed', actual: { visibleMatches: 0 } });
    }
  });
});

describe('browser session', () => {
  it('fills only the named control, records the locator, and keeps privacy redaction on the action', async () => {
    const browserSession = await session();
    await browserSession.execute({ tool: 'navigate', path: '/' });
    const before = await browserSession.page.locator('[name="translations.0.name"]').inputValue();
    await browserSession.execute({ tool: 'fill', locator: byName('stockLevels.0.stockOnHand'), value: { literal: '12' } });
    expect(await browserSession.page.locator('[name="stockLevels.0.stockOnHand"]').inputValue()).toBe('12');
    expect(await browserSession.page.locator('[name="stockLevels.0.reorder"]').inputValue()).toBe('9');
    expect(await browserSession.page.locator('[name="translations.0.name"]').inputValue()).toBe(before);
    await browserSession.execute({ tool: 'select', locator: byName('plan'), value: { literal: 'b' } });
    expect(await browserSession.page.locator('[name="plan"]').inputValue()).toBe('b');
    expect(browserSession.actions[1].action).toEqual({ tool: 'fill', locator: byName('stockLevels.0.stockOnHand'), value: { literal: '12' } });
  });

  it('rejects ambiguous visible matches and ignores hidden ones', async () => {
    const browserSession = await session();
    await browserSession.execute({ tool: 'navigate', path: '/' });
    await expect(browserSession.execute({ tool: 'fill', locator: byName('dup'), value: { literal: 'x' } })).rejects.toThrow(BrowserActionError);
    await expect(browserSession.execute({ tool: 'fill', locator: byName('ghost'), value: { literal: 'x' } })).rejects.toThrow(BrowserActionError);
    await browserSession.execute({ tool: 'fill', locator: byName('twin'), value: { literal: 'now' } });
    expect(await browserSession.page.locator('[name="twin"]').first().inputValue()).toBe('now');
    await browserSession.execute({ tool: 'fill', locator: byName(INJECTION), value: { literal: 'safe' } });
    expect(await browserSession.page.locator('[name="y"]').inputValue()).toBe('plain-y');
  });

  it('lists visible named controls as exact JSON-escaped fieldName lines without values', async () => {
    const browserSession = await session({ redactValues: [PRIVATE_ACCOUNT] });
    const observation = await browserSession.execute({ tool: 'navigate', path: '/' });
    const lines = fieldLines(observation);
    expect(lines).toContain('- fieldName "translations.0.name" nearbyLabel "Product name"');
    expect(lines).toContain('- fieldName "stockLevels.0.stockOnHand" nearbyLabel "Stock on hand"');
    expect(lines).toContain(`- fieldName ${JSON.stringify(INJECTION)}`);
    expect(lines).toContain('- fieldName "back\\\\slash"');
    expect(lines).toContain('- fieldName "contact" nearbyLabel "Contact"');
    expect(lines.filter(line => line.startsWith('- fieldName "dup"'))).toHaveLength(2);
    expect(lines.filter(line => line.startsWith('- fieldName "twin"'))).toHaveLength(1);
    expect(lines.filter(line => line.startsWith('- fieldName "plan"'))).toHaveLength(1);
    for (const hidden of ['ghost', 'secret_pw', 'n'.repeat(250)]) expect(observation).not.toContain(hidden);
    expect(observation).not.toContain(PRIVATE_ACCOUNT);
    for (const value of ['Widget', 'plain-y', 'hunter2', 'visible-twin', 'hidden-twin']) expect(lines.join('\n')).not.toContain(value);
    expect(await browserSession.refreshObservation()).toContain('- fieldName "stockLevels.0.stockOnHand"');
  });

  it('bounds metadata to 60 controls and says how many were omitted', async () => {
    const browserSession = await session();
    const observation = await browserSession.execute({ tool: 'navigate', path: '/?many' });
    expect(fieldLines(observation)).toHaveLength(60);
    expect(observation).toMatch(/^- fieldMetadata omitted: \d+ more visible named controls$/m);
  });

  it('keeps field metadata and the 16k total after a large sidebar, with refs still actionable', async () => {
    const steps: StepEvent[] = [];
    const browserSession = await session({ onStep: step => steps.push(step) });
    const observation = await browserSession.execute({ tool: 'navigate', path: '/?bulk' });
    expect(fieldLines(observation)).toContain('- fieldName "stockLevels.0.stockOnHand" nearbyLabel "Stock on hand"');
    const body = observation.slice(observation.indexOf('\n', observation.indexOf('Focused:')) + 1);
    expect(body.length).toBeLessThanOrEqual(16_000);
    expect(observation).toMatch(/\[ref=e\d+\]/);
    await browserSession.execute({ tool: 'fill', locator: byName('stockLevels.0.stockOnHand'), value: { literal: '3' } });
  });

  it('suppresses a field whose name contains a private value and redacts private label text', async () => {
    const browserSession = await session({ redactValues: [PRIVATE_ACCOUNT, 'Contact'] });
    const observation = await browserSession.execute({ tool: 'navigate', path: '/' });
    expect(observation).not.toContain(PRIVATE_ACCOUNT);
    expect(observation).not.toContain('Contact');
    expect(fieldLines(observation)).toContain('- fieldName "contact" nearbyLabel "[private]"');
  });
});
