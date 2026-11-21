import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InputValue } from '../packages/contracts/src/index';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import type { BrowserAction, EvidenceRun, RecordedAction } from '../packages/contracts/src/runtime';
import { buildReplay, executeReplay, hashReplayPlan, validateReplay } from '../apps/runner/src/replay';
import { verifyOutcome } from '../apps/runner/src/verifier';

const rec = (action: BrowserAction, observation = 'ok'): RecordedAction => ({ action, url: 'http://127.0.0.1/onboarding', observation });
const baseActions: RecordedAction[] = [
  rec({ tool: 'navigate', path: '/onboarding' }),
  rec({ tool: 'fill', locator: { by: 'label', value: 'Store name' }, value: { input: 'storeName' } }, 'Filled Store name with Siri Crafts'),
  rec({ tool: 'click', locator: { by: 'role', value: 'button', name: 'Save' } }),
];
function passedRun(overrides: Partial<EvidenceRun> = {}, actions: RecordedAction[] = baseActions): EvidenceRun {
  return {
    id: 'run-source', requestId: 'req', scenario: storeScenario, context: desktopContext,
    inputs: { storeName: 'Siri Crafts', quantity: 12 }, status: 'completed', verdict: 'passed',
    createdAt: '2026-01-01T00:00:00.000Z', manifestHash: 'm', executionMode: 'ai_guided', steps: [],
    assertions: [{ id: 'confirmation', status: 'passed' }, { id: 'store-name', status: 'passed' }],
    findings: [], capabilities: [], artifacts: [],
    evidence: { buildId: 'build-1', scenarioHash: 'scenario-1', policyVersion: 'p1', model: 'm', actions, modelCalls: 3, finishedByAgent: true },
    ...overrides,
  };
}
const target = (extra: Partial<EvidenceRun> = {}) => passedRun({ id: 'run-target', verdict: null, status: 'queued', assertions: [], ...extra });

describe('buildReplay', () => {
  it('builds a hashed plan from a verifier-passed run with symbolic input refs and no literal input copies', () => {
    const plan = buildReplay(passedRun());
    expect(plan).toMatchObject({ version: 1, sourceRunIds: ['run-source'], scenarioHash: 'scenario-1', buildId: 'build-1' });
    expect(plan.actions).toHaveLength(3);
    expect(plan.hash).toBe(hashReplayPlan(plan));
    expect(plan.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(plan)).not.toContain('Siri Crafts');
    expect(plan.actions[1].action).toEqual({ tool: 'fill', locator: { by: 'label', value: 'Store name' }, value: { input: 'storeName' } });
  });

  it('is deterministic regardless of key order and does not mutate the run', () => {
    const run = passedRun();
    const before = JSON.stringify(run);
    const a = buildReplay(run);
    const reordered = passedRun({}, baseActions.map(r => ({ observation: r.observation, url: r.url, action: r.action })));
    expect(buildReplay(reordered).hash).toBe(a.hash);
    expect(JSON.stringify(run)).toBe(before);
  });

  it.each([
    ['failed verdict', { verdict: 'failed' as const }],
    ['inconclusive verdict', { verdict: 'inconclusive' as const }],
    ['running run', { status: 'running' as const }],
    ['a failed assertion', { assertions: [{ id: 'a', status: 'failed' as const }] }],
    ['not-evaluated assertion', { assertions: [{ id: 'a', status: 'not_evaluated' as const }] }],
    ['no assertions', { assertions: [] }],
    ['no evidence', { evidence: undefined }],
  ])('refuses %s', (_, overrides) => {
    expect(() => buildReplay(passedRun(overrides))).toThrow();
  });

  it('refuses incomplete evidence', () => {
    const evidence = passedRun().evidence!;
    expect(() => buildReplay(passedRun({ evidence: { ...evidence, actions: [] } }))).toThrow(/action/i);
    expect(() => buildReplay(passedRun({ evidence: { ...evidence, finishedByAgent: false } }))).toThrow(/finish/i);
    expect(() => buildReplay(passedRun({ evidence: { ...evidence, buildId: '' } }))).toThrow(/build/i);
    expect(() => buildReplay(passedRun({ evidence: { ...evidence, scenarioHash: '' } }))).toThrow(/scenario/i);
    expect(() => buildReplay(passedRun({ evidence: { ...evidence, replayHash: 'abc' } }))).toThrow(/replay/i);
    expect(() => buildReplay(passedRun({}, Array.from({ length: 101 }, () => baseActions[2])))).toThrow(/too many/i);
  });

  it('rejects malformed actions, unknown input refs and forbidden navigation', () => {
    const bad = (action: unknown) => () => buildReplay(passedRun({}, [{ action: action as BrowserAction, url: 'u', observation: 'o' }]));
    expect(bad({ tool: 'evaluate', code: 'alert(1)' })).toThrow();
    expect(bad({ tool: 'click', locator: { by: 'css', value: '#x' } })).toThrow();
    expect(bad({ tool: 'click', locator: { by: 'text', value: 'x' }, extra: true })).toThrow();
    expect(bad({ tool: 'fill', locator: { by: 'label', value: 'x' }, value: { input: 'missing' } })).toThrow(/input/i);
    expect(bad({ tool: 'fill', locator: { by: 'label', value: 'x' }, value: { input: '__proto__' } })).toThrow(/input/i);
    expect(bad({ tool: 'uploadFixture', locator: { by: 'label', value: 'x' }, input: 'storeName' })).toThrow(/fixture/i);
    expect(bad({ tool: 'navigate', path: '/api/test/state' })).toThrow(/navigat/i);
    expect(bad({ tool: 'navigate', path: '/API/test/state?x=1' })).toThrow(/navigat/i);
    expect(bad({ tool: 'navigate', path: '/%61pi/test/state' })).toThrow(/navigat/i);
    expect(bad({ tool: 'navigate', path: '//evil.example/x' })).toThrow(/navigat/i);
    expect(bad({ tool: 'navigate', path: 'https://evil.example/' })).toThrow(/navigat/i);
    expect(bad({ tool: 'navigate', path: '/a/../api/test/build' })).toThrow(/navigat/i);
  });

  it('accepts a fixture upload bound to a file input and keeps fixture ids out of observations', () => {
    const run = passedRun({ inputs: { logo: { fixtureId: 'logo-png' } as InputValue } }, [
      rec({ tool: 'uploadFixture', locator: { by: 'label', value: 'Logo' }, input: 'logo' }),
    ]);
    expect(buildReplay(run).actions[0].action).toMatchObject({ tool: 'uploadFixture', input: 'logo' });
  });

  it('carries error text only in sanitized form', () => {
    const plan = buildReplay(passedRun({}, [rec({ tool: 'navigate', path: '/onboarding' }, 'Navigated\nstack at /Users/x/file.ts:1')]));
    expect(plan.actions[0].observation).not.toContain('stack at');
  });
});

describe('validateReplay', () => {
  it('accepts a plan for the same build/scenario even when the context differs', () => {
    const plan = buildReplay(passedRun());
    const mobile = target({ context: { ...desktopContext, id: 'mobile', viewport: { width: 390, height: 844 } } });
    expect(validateReplay(plan, mobile)).toEqual({ compatible: true });
  });

  it('rejects tampered hash, actions, build and scenario mismatches', () => {
    const plan = buildReplay(passedRun());
    const tampered = { ...plan, actions: [...plan.actions, rec({ tool: 'pressKey', key: 'Enter' })] };
    expect(validateReplay(tampered, target()).compatible).toBe(false);
    expect(validateReplay({ ...plan, hash: 'f'.repeat(64) }, target()).compatible).toBe(false);
    const otherBuild = target({ evidence: { ...passedRun().evidence!, buildId: 'build-2' } });
    expect(validateReplay(plan, otherBuild)).toMatchObject({ compatible: false, message: expect.stringMatching(/build/i) });
    const otherScenario = target({ evidence: { ...passedRun().evidence!, scenarioHash: 'scenario-2' } });
    expect(validateReplay(plan, otherScenario)).toMatchObject({ compatible: false, message: expect.stringMatching(/scenario/i) });
    expect(validateReplay(plan, target({ evidence: undefined })).compatible).toBe(false);
  });

  it('re-validates action shapes and rehashed malicious plans', () => {
    const plan = buildReplay(passedRun());
    const evil = { ...plan, actions: [rec({ tool: 'navigate', path: '/api/test/state' })] };
    const rehashed = { ...evil, hash: hashReplayPlan(evil) };
    expect(validateReplay(rehashed, target()).compatible).toBe(false);
    const missingRef = { ...plan, actions: [baseActions[1]] };
    expect(validateReplay({ ...missingRef, hash: hashReplayPlan(missingRef) }, target({ inputs: {} })).compatible).toBe(false);
    const empty = { ...plan, actions: [] };
    expect(validateReplay({ ...empty, hash: hashReplayPlan(empty) }, target()).compatible).toBe(false);
    expect(validateReplay({ ...plan, version: 2 } as never, target()).compatible).toBe(false);
    expect(validateReplay(null as never, target()).compatible).toBe(false);
  });
});

describe('executeReplay', () => {
  it('dispatches every action in order through the shared executor without a model', async () => {
    const plan = buildReplay(passedRun());
    const calls: string[] = [];
    const result = await executeReplay(plan, target(), async action => { calls.push(action.tool); return 'ok'; });
    expect(result).toEqual({ compatible: true });
    expect(calls).toEqual(['navigate', 'fill', 'click']);
  });

  it('stops at the first error and reports a sanitized replay mismatch', async () => {
    const plan = buildReplay(passedRun());
    const execute = vi.fn(async (action: BrowserAction) => {
      if (action.tool === 'fill') throw new Error('Timeout 5000ms exceeded.\nwaiting for getByLabel at http://127.0.0.1:3000/onboarding?token=abc\n  at stack');
      return 'ok';
    });
    const result = await executeReplay(plan, target(), execute);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.compatible).toBe(false);
    expect(result.message).toMatch(/action 2.*fill/i);
    expect(result.message).not.toMatch(/stack|token=abc|127\.0\.0\.1/);
  });

  it('treats an error observation from the dispatcher as a mismatch', async () => {
    const plan = buildReplay(passedRun());
    const result = await executeReplay(plan, target(), async () => 'Error: locator matched 2 elements');
    expect(result.compatible).toBe(false);
  });

  it('never runs actions for an invalid plan', async () => {
    const plan = buildReplay(passedRun());
    const execute = vi.fn(async () => 'ok');
    const result = await executeReplay({ ...plan, hash: '0'.repeat(64) }, target(), execute);
    expect(result.compatible).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes copies so an executor cannot mutate the plan', async () => {
    const plan = buildReplay(passedRun());
    const before = JSON.stringify(plan);
    await executeReplay(plan, target(), async action => { (action as { tool: string }).tool = 'hacked'; return 'ok'; });
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('real browser replay against an independent fixture', () => {
  let server: Server; let browser: Browser; let page: Page; let origin: string;
  let saveLabel = 'Save';
  const store: { name?: string } = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ store })); return; }
      if (req.url?.startsWith('/save?')) { store.name = new URL(req.url, 'http://x').searchParams.get('name') ?? ''; }
      res.setHeader('content-type', 'text/html');
      res.end(req.url?.startsWith('/save?')
        ? '<p>Store saved</p>'
        : `<form action="/save"><label for="n">Store name</label><input id="n" name="name"><button>${saveLabel}</button></form>`);
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => { await browser?.close(); await new Promise(done => server?.close(done)); });

  const dispatch = (inputs: Record<string, InputValue>) => async (action: BrowserAction): Promise<string> => {
    const where = (l: Extract<BrowserAction, { locator: unknown }>['locator']) => l.by === 'role'
      ? page.getByRole(l.value as 'button', { name: l.name, exact: true }) : page.getByLabel(l.value, { exact: true });
    if (action.tool === 'navigate') await page.goto(origin + action.path);
    else if (action.tool === 'fill') await where(action.locator).fill(String('input' in action.value ? inputs[action.value.input] : action.value.literal), { timeout: 800 });
    else if (action.tool === 'click') await where(action.locator).click({ timeout: 800 });
    else throw new Error('unsupported');
    return 'done';
  };

  it('reproduces a successful path and the independent verifier then passes; a changed UI is a mismatch', async () => {
    const inputs = { storeName: 'Siri Crafts' };
    const source = passedRun({ inputs });
    const plan = buildReplay(source);
    saveLabel = 'Save';
    const ok = await executeReplay(plan, target({ inputs }), dispatch(inputs));
    expect(ok).toEqual({ compatible: true });
    const results = await verifyOutcome({
      page, inputs, timeoutMs: 800, readState: async () => (await fetch(`${origin}/api/state`)).json(),
      contract: { scope: 'ui_and_api', assertions: [
        { id: 'saved', kind: 'visible', locator: { by: 'text', value: 'Store saved' } },
        { id: 'name', kind: 'state_equals', path: 'store.name', expected: { input: 'storeName' } },
      ] },
    });
    expect(results.map(r => r.status)).toEqual(['passed', 'passed']);

    saveLabel = 'Submit';
    const changed = await executeReplay(plan, target({ inputs }), dispatch(inputs));
    expect(changed.compatible).toBe(false);
    expect(changed.message).toMatch(/action 3.*click/i);
  });
});

it('rejects keyboard activation when the semantic focus no longer matches',async()=>{
 const source=passedRun();
 source.evidence!.actions=[{action:{tool:'pressKey',key:'Enter'},url:'/onboarding',observation:'done',urlBefore:'/onboarding',focusBefore:'- button "Save"'}];
 const plan=buildReplay(source);
 const execute=vi.fn(async()=> 'done');
 const result=await executeReplay(plan,target(),execute,async()=>({url:'/onboarding',focus:'- button "Delete"'}));
 expect(result.compatible).toBe(false);expect(execute).not.toHaveBeenCalled();
});
