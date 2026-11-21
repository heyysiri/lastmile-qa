import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desktopContext } from '../packages/contracts/src/examples';
import type { ContextPack, StepEvent } from '../packages/contracts/src/index';
import { createBrowserSession, type BrowserSession } from '../apps/runner/src/browser';

const document = `
  <label>Title <input value="Old" onkeydown="if (event.key === 'N') document.querySelector('output').textContent = 'Typed'"></label>
  <label for="choice">Choice</label><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <button onclick="document.querySelector('output').textContent = 'Saved'">Save</button>
  <button>Duplicate</button><button>Duplicate</button>
  <button style="display:none">Invisible</button>
  <button aria-hidden="true">Unobserved</button>
  <button onclick="fetch('/unavailable?secret=synthetic')">Fetch error</button>
  <button onclick="fetch('/broken').catch(() => {})">Transport error</button>
  <a href="/popup" target="_blank">Popup</a>
  <output></output>
`;
const requests: string[] = [];
const server = createServer((req, res) => {
  const path = req.url ?? '';
  requests.push(path);
  if (path === '/redirect') return res.writeHead(302, { location: '/next' }).end();
  if (path === '/next') return res.writeHead(302, { location: '/%61pi%2Ftest/state' }).end();
  if (path === '/external') return res.writeHead(302, { location: origin.replace('127.0.0.1', 'localhost') + '/elsewhere' }).end();
  if (path === '/allowed-redirect') return res.writeHead(302, { location: '/surface' }).end();
  if (path.startsWith('/unavailable')) return res.writeHead(503).end();
  if (path === '/broken') return req.socket.destroy();
  res.setHeader('content-type', 'text/html');
  res.end(req.headers.cookie === 'example=synthetic-session' ? document : '<p>Cookie missing</p>');
});
let origin: string;
let session: BrowserSession | undefined;
let artifacts: string;
let steps: StepEvent[];

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  if (artifacts) await rm(artifacts, { recursive: true, force: true });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function open(overrides: Partial<ContextPack> = {}, signal = new AbortController().signal) {
  artifacts = await mkdtemp(join(tmpdir(), 'lastmile-context-'));
  steps = [];
  session = await createBrowserSession({
    pack: { ...desktopContext, ...overrides },
    inputs: { title: 'New title' },
    origin, cookie: { name: 'example', value: 'synthetic-session', path: '/' },
    artifactDirectory: artifacts, signal, onStep: step => steps.push(step),
  });
  return session;
}
const title = { by: 'role', value: 'textbox', name: 'Title' } as const;
const button = (name: string) => ({ by: 'role', value: 'button', name }) as const;

describe('browser journey', () => {
  it('applies context and records observed, slot-based actions and artifacts', async () => {
    const browser = await open({
      viewport: { width: 420, height: 680 }, locale: 'fr-FR', reducedMotion: 'reduce',
      network: { mode: 'request_delay', delayMs: 40, pathPrefix: '/surface' },
    });
    expect(await browser.execute({ tool: 'navigate', path: '/surface' })).toContain('textbox "Title"');
    expect(await browser.page.evaluate(() => [innerWidth, innerHeight, navigator.language, matchMedia('(prefers-reduced-motion: reduce)').matches]))
      .toEqual([420, 680, 'fr-FR', true]);
    const action = { tool: 'fill', locator: title, value: { input: 'title' } } as const;
    await browser.execute(action);
    expect(await browser.page.getByLabel('Title').inputValue()).toBe('New title');
    expect(browser.actions[1].action).toEqual(action);
    await browser.execute({ tool: 'select', locator: { by: 'label', value: 'Choice' }, value: { literal: 'Beta' } });
    expect(await browser.page.getByLabel('Choice').inputValue()).toBe('b');
    expect(await browser.execute({ tool: 'click', locator: button('Save') })).toContain('Saved');
    await browser.observe();
    expect(browser.actions).toHaveLength(4);
    expect(steps.flatMap(step => step.screenshot)).toEqual(['step-1.png', 'step-2.png', 'step-3.png', 'step-4.png', 'step-5.png']);
    expect(browser.capabilities).toContainEqual({ factor: 'inputs', status: 'applied', value: { title: 'New title' } });
    expect(browser.capabilities).toContainEqual({ factor: 'familiarity', status: 'guidance_only', value: { familiarity: 'experienced', knownTerms: [] } });
    expect(browser.capabilities).toContainEqual(expect.objectContaining({
      factor: 'network', status: 'applied', value: expect.objectContaining({ matchedRequests: 1 }),
    }));
    await browser.close();
    expect(browser.page.isClosed()).toBe(true);
    for (const file of ['trace.zip', 'final.png', 'step-5.png', 'network.json']) {
      expect((await stat(join(artifacts, file))).size).toBeGreaterThan(0);
    }
  }, 15_000);

  it('requires a focused observed editable and denies pointer operations in keyboard-only mode', async () => {
    const browser = await open({ interaction: 'keyboard_only', network: { mode: 'request_delay', delayMs: 10, pathPrefix: '/unmatched' } });
    await browser.execute({ tool: 'navigate', path: '/surface' });
    expect(browser.capabilities).toContainEqual(expect.objectContaining({
      factor: 'network', status: 'not_exercised', value: expect.objectContaining({ matchedRequests: 0 }),
    }));
    const fill = { tool: 'fill', locator: title, value: { input: 'title' } } as const;
    await expect(browser.execute(fill)).rejects.toThrow(/focused/);
    for (const action of [
      { tool: 'click', locator: button('Save') },
      { tool: 'scroll', direction: 'down', pixels: 50 },
      { tool: 'select', locator: { by: 'label', value: 'Choice' }, value: { literal: 'b' } },
      { tool: 'uploadFixture', locator: title, input: 'title' },
    ] as const) {
      await expect(browser.execute(action)).rejects.toThrow(/keyboard/);
    }
    expect(await browser.execute({ tool: 'pressKey', key: 'Tab' })).toMatch(/focused:.*textbox "Title"/i);
    expect(await browser.execute(fill)).toContain('Typed');
    expect(await browser.page.getByLabel('Title').inputValue()).toBe('New title');
    expect(browser.actions.map(entry => entry.action.tool)).toEqual(['navigate', 'pressKey', 'fill']);
  }, 15_000);

  it('rejects hidden, ambiguous and unobserved locators, unknown slots and arbitrary uploads', async () => {
    const browser = await open();
    await browser.execute({ tool: 'navigate', path: '/surface' });
    for (const name of ['Duplicate', 'Invisible', 'Unobserved']) {
      await expect(browser.execute({ tool: 'click', locator: { by: 'text', value: name } })).rejects.toThrow(/unique|visible|observed/);
    }
    await browser.page.evaluate(() => {
      const late = window.document.createElement('button');
      late.textContent = 'Late control';
      window.document.body.append(late);
    });
    await expect(browser.execute({ tool: 'click', locator: button('Late control') })).rejects.toThrow(/observed/);
    await browser.observe();
    await browser.execute({ tool: 'click', locator: button('Late control') });
    await expect(browser.execute({ tool: 'fill', locator: title, value: { input: 'toString' } })).rejects.toThrow(/input slot/i);
    await expect(browser.execute({ tool: 'uploadFixture', locator: title, input: '/some/local/file' })).rejects.toThrow(/upload.*unsupported/i);
    expect(browser.actions).toHaveLength(2);
  }, 15_000);

  it('blocks encoded test paths, redirect chains and popups and sanitizes network evidence', async () => {
    requests.length = 0;
    const browser = await open();
    await expect(browser.execute({ tool: 'navigate', path: '/%2561pi%252Ftest/state' })).rejects.toThrow(/approved|blocked/i);
    await expect(browser.execute({ tool: 'navigate', path: '/redirect' })).rejects.toThrow();
    await expect(browser.execute({ tool: 'navigate', path: '/external' })).rejects.toThrow();
    await browser.execute({ tool: 'navigate', path: '/allowed-redirect' });
    expect(new URL(browser.page.url()).pathname).toBe('/surface');
    await browser.execute({ tool: 'click', locator: { by: 'role', value: 'link', name: 'Popup' } });
    await browser.execute({ tool: 'click', locator: button('Fetch error') });
    await browser.execute({ tool: 'click', locator: button('Transport error') });
    expect(requests).toEqual(expect.arrayContaining(['/redirect', '/next', '/external', '/surface']));
    expect(requests.some(path => /test|elsewhere|popup/.test(path))).toBe(false);
    await browser.close();
    const network = await readFile(join(artifacts, 'network.json'), 'utf8');
    expect(JSON.parse(network)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'http_error', url: `${origin}/unavailable`, status: 503 }),
      expect.objectContaining({ kind: 'transport_failure', url: `${origin}/broken` }),
    ]));
    expect(network).not.toContain('secret');
    expect(network).not.toContain('synthetic-session');
  }, 15_000);

  it('applies request delay to an allowed redirect destination', async () => {
    const browser = await open({ network: { mode: 'request_delay', delayMs: 80, pathPrefix: '/surface' } });
    await browser.execute({ tool: 'navigate', path: '/allowed-redirect' });
    expect(browser.capabilities).toContainEqual(expect.objectContaining({
      factor: 'network', status: 'applied', value: expect.objectContaining({ matchedRequests: 1 }),
    }));
    expect(browser.networkEvents).toContainEqual(expect.objectContaining({
      kind: 'request_delay', url: `${origin}/surface`, delayMs: 80, elapsedMs: expect.any(Number),
    }));
  }, 15_000);

  it('releases the browser and writes remaining artifacts when trace export fails', async () => {
    const browser = await open();
    await browser.execute({ tool: 'navigate', path: '/surface' });
    await mkdir(join(artifacts, 'trace.zip'));
    await expect(browser.close()).rejects.toThrow(/evidence/);
    session = undefined;
    expect(browser.page.isClosed()).toBe(true);
    expect((await stat(join(artifacts, 'final.png'))).size).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(artifacts, 'network.json'), 'utf8'))).toEqual([]);
  }, 15_000);

  it('rejects further actions after the budget or caller cancellation', async () => {
    const controller = new AbortController();
    const browser = await open({ interaction: 'keyboard_only' }, controller.signal);
    for (let count = 0; count < 40; count++) {
      await expect(browser.execute({ tool: 'click', locator: button('Save') })).rejects.toThrow(/keyboard/);
    }
    await expect(browser.execute({ tool: 'navigate', path: '/surface' })).rejects.toThrow(/budget/);
    controller.abort();
    await expect(browser.observe()).rejects.toThrow(/cancelled/);
  }, 15_000);
});
