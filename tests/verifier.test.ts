import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputValue, ScenarioDefinition } from '../packages/contracts/src/index';
import { verifyOutcome } from '../apps/runner/src/verifier';

type Contract = ScenarioDefinition['contract'];
const html = `<!doctype html><html><body>
<h1>Dashboard</h1>
<div role="status">Saved successfully</div>
<label for="name">Store name</label><input id="name" value="Acme Goods">
<label for="qty">Quantity</label><input id="qty" value="12">
<label for="agree">Agree</label><input id="agree" type="checkbox" checked>
<button>Save</button><button>Save</button>
<button data-testid="once">Once</button>
<span data-testid="hidden-dupe">Twin</span><span data-testid="hidden-dupe" style="display:none">Twin</span>
<p data-testid="late" style="display:none">Late arrival</p>
<script>setTimeout(()=>{document.querySelector('[data-testid=late]').style.display='block'},300)</script>
</body></html>`;

let server: Server;
let browser: Browser;
let page: Page;
let url: string;

beforeAll(async () => {
  server = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); await new Promise(done => server?.close(done)); });
beforeEach(async () => { if (page && !page.isClosed()) await page.close(); page = await browser.newPage(); await page.goto(url); });

const contract = (assertions: unknown[], scope: Contract['scope'] = 'ui_and_api') => ({ scope, assertions }) as Contract;
const inputs: Record<string, InputValue> = { storeName: 'Acme Goods', qty: 12 };
const state = { store: { name: 'Acme Goods', qty: 12, active: true, items: [{ sku: 'A' }, { sku: 'B' }] } };
const run = (c: Contract, readState: () => Promise<unknown> = async () => state, extra: { timeoutMs?: number } = {}) =>
  verifyOutcome({ page, contract: c, inputs, readState, timeoutMs: 500, ...extra });

describe('UI assertions', () => {
  it('passes visible and field checks with literal and input-bound expectations', async () => {
    const results = await run(contract([
      { id: 'banner', kind: 'visible', locator: { by: 'text', value: 'Saved successfully' } },
      { id: 'name', kind: 'field', locator: { by: 'label', value: 'Store name' }, expected: { input: 'storeName' } },
      { id: 'qty', kind: 'field', locator: { by: 'label', value: 'Quantity' }, expected: { input: 'qty' } },
      { id: 'agree', kind: 'field', locator: { by: 'label', value: 'Agree' }, expected: { literal: true } },
    ], 'ui_only'));
    expect(results.map(r => [r.id, r.status])).toEqual([['banner', 'passed'], ['name', 'passed'], ['qty', 'passed'], ['agree', 'passed']]);
  });

  it('fails ambiguous locators instead of picking the first match', async () => {
    const [result] = await run(contract([{ id: 'dup', kind: 'visible', locator: { by: 'role', value: 'button', name: 'Save' } }], 'ui_only'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/ambiguous|2/i);
  });

  it('ignores hidden duplicates when exactly one match is visible', async () => {
    const [result] = await run(contract([{ id: 'twin', kind: 'visible', locator: { by: 'testId', value: 'hidden-dupe' } }], 'ui_only'));
    expect(result.status).toBe('passed');
  });

  it('fails a missing element after the bounded wait, never not_evaluated', async () => {
    const started = Date.now();
    const [result] = await run(contract([{ id: 'gone', kind: 'visible', locator: { by: 'text', value: 'Nope' } }], 'ui_only'), undefined, { timeoutMs: 300 });
    expect(result.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('waits for elements that appear within the budget', async () => {
    const [result] = await run(contract([{ id: 'late', kind: 'visible', locator: { by: 'testId', value: 'late' } }], 'ui_only'), undefined, { timeoutMs: 1500 });
    expect(result.status).toBe('passed');
  });

  it('fails a field with the wrong value and reports small expected/actual values', async () => {
    const [result] = await run(contract([{ id: 'name', kind: 'field', locator: { by: 'label', value: 'Store name' }, expected: { literal: 'Other' } }], 'ui_only'));
    expect(result).toMatchObject({ status: 'failed', expected: 'Other', actual: 'Acme Goods' });
  });

  it('marks unresolved input references not_evaluated', async () => {
    const [result] = await run(contract([{ id: 'name', kind: 'field', locator: { by: 'label', value: 'Store name' }, expected: { input: 'absent' } }], 'ui_only'));
    expect(result.status).toBe('not_evaluated');
  });

  it('marks a closed page not_evaluated', async () => {
    const closing = await browser.newPage();
    await closing.close();
    const [result] = await verifyOutcome({
      page: closing, inputs, readState: async () => state, timeoutMs: 300,
      contract: contract([{ id: 'x', kind: 'visible', locator: { by: 'text', value: 'x' } }], 'ui_only'),
    });
    expect(result.status).toBe('not_evaluated');
  });

  it('honors a cancellation signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const [result] = await verifyOutcome({
      page, inputs, readState: async () => state, timeoutMs: 10_000, signal: controller.signal,
      contract: contract([{ id: 'x', kind: 'visible', locator: { by: 'text', value: 'missing' } }], 'ui_only'),
    });
    expect(result.status).toBe('not_evaluated');
  });
});

describe('state assertions', () => {
  const ui = { id: 'banner', kind: 'visible', locator: { by: 'text', value: 'Saved successfully' } };

  it('passes equality and counts with type-preserving comparison', async () => {
    const results = await run(contract([
      ui,
      { id: 'n', kind: 'state_equals', path: 'store.name', expected: { input: 'storeName' } },
      { id: 'q', kind: 'state_equals', path: 'store.qty', expected: { input: 'qty' } },
      { id: 'b', kind: 'state_equals', path: 'store.active', expected: { literal: true } },
      { id: 'c', kind: 'state_count', path: 'store.items', expected: 2 },
      { id: 'i', kind: 'state_equals', path: 'store.items.1.sku', expected: { literal: 'B' } },
    ]));
    expect(results.map(r => r.status)).toEqual(Array(6).fill('passed'));
  });

  it('keeps a success banner from proving persistence', async () => {
    const results = await run(contract([
      ui, { id: 'n', kind: 'state_equals', path: 'store.name', expected: { literal: 'Acme Goods' } },
    ]), async () => ({ store: { name: 'Wrong' } }));
    expect(results.map(r => r.status)).toEqual(['passed', 'failed']);
  });

  it('does not coerce scalar types', async () => {
    const results = await run(contract([
      ui,
      { id: 'a', kind: 'state_equals', path: 'store.qty', expected: { literal: '12' } },
      { id: 'b', kind: 'state_equals', path: 'store.active', expected: { literal: 'true' } },
    ]));
    expect(results.slice(1).map(r => r.status)).toEqual(['failed', 'failed']);
  });

  it('fails wrong counts, non-arrays and missing paths', async () => {
    const results = await run(contract([
      ui,
      { id: 'a', kind: 'state_count', path: 'store.items', expected: 3 },
      { id: 'b', kind: 'state_count', path: 'store.name', expected: 1 },
      { id: 'c', kind: 'state_equals', path: 'store.absent', expected: { literal: 'x' } },
      { id: 'd', kind: 'state_count', path: 'store.items.9', expected: 0 },
    ]));
    expect(results.slice(1).map(r => r.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(results[1].actual).toBe(2);
  });

  it('rejects prototype-chain paths without passing', async () => {
    const results = await run(contract([
      ui,
      { id: 'a', kind: 'state_equals', path: '__proto__.polluted', expected: { literal: 'x' } },
      { id: 'b', kind: 'state_count', path: 'store.constructor', expected: 0 },
      { id: 'c', kind: 'state_equals', path: 'store.items.length', expected: { literal: 2 } },
      { id: 'd', kind: 'state_equals', path: 'store..name', expected: { literal: 'x' } },
    ]));
    expect(results.slice(1).map(r => r.status)).toEqual(['not_evaluated', 'not_evaluated', 'failed', 'not_evaluated']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reads state exactly once, after the UI checks', async () => {
    const order: string[] = [];
    const readState = vi.fn(async () => { order.push('state'); return state; });
    const spyPage = new Proxy(page, { get: (t, p, r) => { if (p === 'getByText') order.push('ui'); return Reflect.get(t, p, r) as unknown; } });
    await verifyOutcome({
      page: spyPage, inputs, readState, timeoutMs: 500,
      contract: contract([
        { id: 's1', kind: 'state_count', path: 'store.items', expected: 2 },
        { id: 'ui', kind: 'visible', locator: { by: 'text', value: 'Saved successfully' } },
        { id: 's2', kind: 'state_equals', path: 'store.name', expected: { literal: 'Acme Goods' } },
      ]),
    });
    expect(readState).toHaveBeenCalledTimes(1);
    expect(order.at(-1)).toBe('state');
    expect(order.indexOf('ui')).toBeLessThan(order.indexOf('state'));
  });

  it.each([
    ['throws', async () => { throw new Error('connect ECONNREFUSED http://secret-host/api/test/state?token=abc'); }],
    ['returns undefined', async () => undefined],
    ['returns null', async () => null],
    ['hangs', () => new Promise<unknown>(() => undefined)],
  ])('marks state assertions not_evaluated when readback %s', async (_, readState) => {
    const results = await run(contract([
      ui, { id: 'n', kind: 'state_equals', path: 'store.name', expected: { literal: 'Acme Goods' } },
      { id: 'c', kind: 'state_count', path: 'store.items', expected: 2 },
    ]), readState, { timeoutMs: 300 });
    expect(results.map(r => r.status)).toEqual(['passed', 'not_evaluated', 'not_evaluated']);
    expect(JSON.stringify(results)).not.toMatch(/secret-host|token=abc/);
  });

  it('does not read state for UI-only contracts and truncates oversized actual values', async () => {
    const readState = vi.fn(async () => state);
    await run(contract([ui], 'ui_only'), readState);
    expect(readState).not.toHaveBeenCalled();
    const huge = { store: { name: 'x'.repeat(5000), items: Array.from({ length: 500 }, () => ({})) } };
    const results = await run(contract([
      ui, { id: 'n', kind: 'state_equals', path: 'store.name', expected: { literal: 'y' } },
      { id: 'o', kind: 'state_equals', path: 'store.items', expected: { literal: 'y' } },
    ]), async () => huge);
    expect(JSON.stringify(results).length).toBeLessThan(1500);
    expect(results[2].status).toBe('failed');
  });

  it('treats a fixture-object expectation as not evaluable', async () => {
    const results = await verifyOutcome({
      page, readState: async () => state, timeoutMs: 300, inputs: { ...inputs, doc: { fixtureId: 'f1' } },
      contract: contract([ui, { id: 'n', kind: 'state_equals', path: 'store.name', expected: { input: 'doc' } }]),
    });
    expect(results[1].status).toBe('not_evaluated');
  });
});

it('does not classify an unreadable visible field as a missing product outcome',async()=>{
 const locator={count:async()=>1,evaluate:async()=>{throw new Error('Page transport failed');},filter:()=>locator};
 const fake={isClosed:()=>false,getByLabel:()=>locator} as unknown as Page;
 const [result]=await verifyOutcome({page:fake,inputs:{},timeoutMs:1,readState:async()=>({}),contract:{scope:'ui_only',assertions:[{id:'field',kind:'field',locator:{by:'label',value:'Name'},expected:{literal:'value'}}]}});
 expect(result.status).toBe('not_evaluated');
});
