import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelStreamEvent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { ContextPackSchema, NetworkProfileSchema, type ContextPack, type NetworkProfile } from '../packages/contracts/src/index';
import { BrowserActionSchema, type EvidenceRun } from '../packages/contracts/src/runtime';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import { runAgent } from '../apps/runner/src/agent';
import { createBrowserSession, type BrowserSession } from '../apps/runner/src/browser';

type Network = ContextPack['network'];

describe('connectivity contracts [no browser]', () => {
  it('exports one NetworkProfileSchema that keeps normal and request_delay and adds throttled and offline', () => {
    const profiles: NetworkProfile[] = [
      { mode: 'normal' },
      { mode: 'request_delay', delayMs: 1500, pathPrefix: '/api' },
      { mode: 'throttled', latencyMs: 400, downloadKbps: 256, uploadKbps: 128 },
      { mode: 'throttled', latencyMs: 0, downloadKbps: 16, uploadKbps: 100_000 },
      { mode: 'throttled', latencyMs: 3000, downloadKbps: 100_000, uploadKbps: 16 },
      { mode: 'offline' },
    ];
    for (const profile of profiles) {
      expect(NetworkProfileSchema.parse(profile)).toEqual(profile);
      expect(ContextPackSchema.parse({ ...desktopContext, network: profile }).network).toEqual(profile);
    }
  });

  it('rejects out-of-range, fractional, partial and extra-key profiles', () => {
    const base = { mode: 'throttled', latencyMs: 100, downloadKbps: 256, uploadKbps: 128 };
    for (const bad of [
      { ...base, latencyMs: 3001 }, { ...base, latencyMs: -1 }, { ...base, latencyMs: 1.5 },
      { ...base, downloadKbps: 15 }, { ...base, downloadKbps: 100_001 },
      { ...base, uploadKbps: 15 }, { ...base, uploadKbps: 100_001 }, { ...base, uploadKbps: 16.5 },
      { mode: 'throttled', latencyMs: 100, downloadKbps: 256 },
      { ...base, packetLoss: 0.2 }, { mode: 'offline', latencyMs: 10 }, { mode: 'normal', extra: true },
      { mode: 'carrier', name: '3g' }, { mode: 'packet_loss', percent: 5 },
    ]) {
      expect(NetworkProfileSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(ContextPackSchema.safeParse({ ...desktopContext, network: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('never gives the model a connectivity action', () => {
    expect(BrowserActionSchema.options.map(option => option.shape.tool.value).sort()).toEqual([
      'click', 'fill', 'navigate', 'pressKey', 'scroll', 'select', 'uploadFixture',
    ]);
    expect(BrowserActionSchema.safeParse({ tool: 'setConnectivity', profile: { mode: 'offline' } }).success).toBe(false);
  });
});

describe('model call budget [no browser]', () => {
  const run: EvidenceRun = {
    id: 'run', requestId: 'request', scenario: storeScenario, context: desktopContext,
    inputs: { storeName: 'Synthetic Crafts' }, status: 'running', verdict: null, createdAt: '2026-01-01',
    manifestHash: 'manifest', executionMode: 'ai_guided', steps: [], assertions: [], findings: [], capabilities: [], artifacts: [],
  };
  const options = { apiKey: 'synthetic-model-key', model: 'synthetic-test-model' };

  function browser() {
    return {
      observe: vi.fn(async () => 'textbox "Name"'),
      execute: vi.fn<BrowserSession['execute']>(async () => 'status: Saved'),
      setConnectivity: vi.fn(async () => {}),
    };
  }
  function* toolCalls(...calls: [string, unknown][]): Generator<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    for (const [index, [name, input]] of calls.entries()) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: `tool-${index}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
  afterEach(() => vi.restoreAllMocks());

  it('stops at the remaining budget supplied by the root instead of resetting to 20', async () => {
    const page = browser();
    const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () { yield* toolCalls(['observe', {}]); });
    const result = await runAgent(page as unknown as BrowserSession, run, { ...options, modelCallLimit: 3 });
    expect(result).toMatchObject({ modelCalls: 3, finished: false, reason: expect.stringMatching(/budget/i) });
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it('stops before any browser or model use when no calls remain', async () => {
    const page = browser();
    const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () { yield* toolCalls(['finish', { status: 'done' }]); });
    await expect(runAgent(page as unknown as BrowserSession, run, { ...options, modelCallLimit: 0 }))
      .resolves.toMatchObject({ modelCalls: 0, finished: false, reason: expect.stringMatching(/budget/i) });
    expect(stream).not.toHaveBeenCalled();
    expect(page.observe).not.toHaveBeenCalled();
  });

  it('treats an invalid remaining budget as stop, never as the default 20', async () => {
    const page = browser();
    const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () { yield* toolCalls(['finish', { status: 'done' }]); });
    for (const modelCallLimit of [21, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runAgent(page as unknown as BrowserSession, run, { ...options, modelCallLimit }))
        .resolves.toMatchObject({ modelCalls: 0, finished: false });
    }
    expect(stream).not.toHaveBeenCalled();
    expect(page.observe).not.toHaveBeenCalled();
  });

  it('keeps the default 20 and a full explicit 20 identical', async () => {
    for (const extra of [{}, { modelCallLimit: 20 }]) {
      const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () { yield* toolCalls(['observe', {}]); });
      await expect(runAgent(browser() as unknown as BrowserSession, run, { ...options, ...extra })).resolves.toMatchObject({ modelCalls: 20, finished: false });
      expect(stream).toHaveBeenCalledTimes(20);
      stream.mockRestore();
    }
  });

  it('exposes no connectivity tool and ignores a model attempt to call one', async () => {
    const page = browser();
    let call = 0;
    vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* (messages, settings) {
      const names = settings?.toolSpecs?.map(spec => spec.name).sort();
      expect(names).toEqual(['click', 'fill', 'finish', 'navigate', 'observe', 'pressKey', 'scroll', 'select', 'uploadFixture']);
      expect(JSON.stringify({ specs: settings?.toolSpecs, system: settings?.systemPrompt })).not.toMatch(/connectiv|offline|throttl|bandwidth/i);
      yield* ++call === 1
        ? toolCalls(['setConnectivity', { profile: { mode: 'offline' } }])
        : toolCalls(['finish', { status: 'done' }]);
      void messages;
    });
    await expect(runAgent(page as unknown as BrowserSession, run, options)).resolves.toMatchObject({ finished: true });
    expect(page.setConnectivity).not.toHaveBeenCalled();
    expect(page.execute).not.toHaveBeenCalled();
  });
});

describe('connectivity [chromium]', () => {
  const hits = { ping: 0, blob: 0, upload: 0, apiTest: 0, offsite: 0 };
  let app: Server;
  let other: Server;
  let origin: string;
  let offsite: string;
  let session: BrowserSession | undefined;
  let artifacts: string | undefined;

  const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback address');
    resolve(`http://127.0.0.1:${address.port}`);
  }));
  const drain = (request: IncomingMessage) => new Promise<number>(resolve => {
    let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; });
    request.on('end', () => resolve(bytes));
  });

  beforeAll(async () => {
    other = createServer((_request, response) => { hits.offsite++; response.end('offsite'); });
    offsite = await listen(other);
    app = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://local');
      if (url.pathname === '/ping') { hits.ping++; return response.writeHead(200, { 'cache-control': 'no-store' }).end('pong'); }
      if (url.pathname === '/blob') {
        hits.blob++;
        return response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/octet-stream' })
          .end(Buffer.alloc(Number(url.searchParams.get('bytes') ?? 1024), 120));
      }
      if (url.pathname === '/upload') {
        hits.upload++;
        const bytes = await drain(request);
        return response.writeHead(200, { 'cache-control': 'no-store' }).end(String(bytes));
      }
      if (url.pathname === '/api/test/state') { hits.apiTest++; return response.end('state'); }
      if (url.pathname === '/to-offsite') return response.writeHead(302, { location: offsite + '/redirected' }).end();
      response.setHeader('content-type', 'text/html');
      response.end('<title>Connectivity</title><button>Save</button><output></output>');
    });
    origin = await listen(app);
  });
  afterEach(async () => {
    await session?.close().catch(() => {});
    session = undefined;
    if (artifacts) await rm(artifacts, { recursive: true, force: true });
    artifacts = undefined;
  });
  afterAll(async () => {
    for (const server of [app, other]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  async function open(network: Network = { mode: 'normal' }, extra: { signal?: AbortSignal; actionLimit?: number; storageState?: Parameters<typeof createBrowserSession>[0]['storageState'] } = {}) {
    artifacts = await mkdtemp(join(tmpdir(), 'lastmile-connectivity-'));
    session = await createBrowserSession({
      pack: { ...desktopContext, network }, inputs: {}, origin, artifactDirectory: artifacts,
      signal: extra.signal ?? new AbortController().signal, actionLimit: extra.actionLimit, storageState: extra.storageState, onStep: () => {},
    });
    return session;
  }
  type Timed = { ok: boolean; ms: number; bytes?: number; error?: string };
  /** Fetch from inside the page so the request travels through the real Chromium network stack. */
  const timed = (browser: BrowserSession, target: string, init: { method?: string; body?: string } = {}) => browser.page.evaluate(async ([path, request]) => {
    const started = performance.now();
    try {
      const response = await fetch(path, { cache: 'no-store', mode: 'no-cors', ...(request as RequestInit) });
      const body = await response.arrayBuffer();
      return { ok: true, ms: performance.now() - started, bytes: body.byteLength };
    } catch (error) {
      return { ok: false, ms: performance.now() - started, error: String(error) };
    }
  }, [target, init] as const) as Promise<Timed>;
  const profileOf = (browser: BrowserSession) => browser.capabilities.find(item => item.factor === 'network');
  const changes = (browser: BrowserSession) => browser.networkEvents.filter(event => (event as { kind?: string }).kind === 'connectivity_change');

  it('blocks real local HTTP while offline and restores it when switched back to normal', async () => {
    const browser = await open();
    await browser.execute({ tool: 'navigate', path: '/surface' });
    expect(await timed(browser, '/ping')).toMatchObject({ ok: true });
    const before = hits.ping;

    await browser.setConnectivity({ mode: 'offline' });
    const offline = await timed(browser, '/ping');
    expect(offline.ok).toBe(false);
    expect(hits.ping).toBe(before);
    expect(profileOf(browser)).toMatchObject({ factor: 'network', status: 'applied', value: expect.objectContaining({ mode: 'offline' }) });
    expect(browser.networkEvents).toContainEqual(expect.objectContaining({ kind: 'transport_failure', url: `${origin}/ping` }));

    await expect(browser.setConnectivity({ mode: 'throttled', latencyMs: 5000, downloadKbps: 256, uploadKbps: 128 } as never)).rejects.toThrow(/invalid network/i);
    expect((await timed(browser, '/ping')).ok).toBe(false);
    expect(hits.ping).toBe(before);

    await browser.setConnectivity({ mode: 'normal' });
    expect(await timed(browser, '/ping')).toMatchObject({ ok: true });
    expect(hits.ping).toBe(before + 1);
    expect(profileOf(browser)).toMatchObject({ status: 'applied', value: expect.objectContaining({ mode: 'normal' }) });
    expect(changes(browser)).toEqual([
      expect.objectContaining({ kind: 'connectivity_change', from: 'normal', to: 'offline' }),
      expect.objectContaining({ kind: 'connectivity_change', from: 'offline', to: 'normal' }),
    ]);
  }, 30_000);

  it('applies throttled latency and both bandwidth limits in the real browser, then restores normal speed', async () => {
    const browser = await open();
    await browser.execute({ tool: 'navigate', path: '/surface' });
    const fast = await timed(browser, '/blob?bytes=32768');
    expect(fast).toMatchObject({ ok: true, bytes: 32768 });
    expect(fast.ms).toBeLessThan(300);

    await browser.setConnectivity({ mode: 'throttled', latencyMs: 400, downloadKbps: 256, uploadKbps: 128 });
    expect(profileOf(browser)).toMatchObject({
      factor: 'network', status: 'applied',
      value: expect.objectContaining({ mode: 'throttled', latencyMs: 400, downloadKbps: 256, uploadKbps: 128 }),
    });
    const ping = await timed(browser, '/ping');
    expect(ping.ok).toBe(true);
    expect(ping.ms).toBeGreaterThanOrEqual(350);
    // 32 KiB at 256 kbit/s is about one second of transfer on top of latency.
    const download = await timed(browser, '/blob?bytes=32768');
    expect(download).toMatchObject({ ok: true, bytes: 32768 });
    expect(download.ms).toBeGreaterThanOrEqual(900);
    // 16 KiB at 128 kbit/s is about one second of upload on top of latency.
    const upload = await timed(browser, '/upload', { method: 'POST', body: 'x'.repeat(16384) });
    expect(upload.ok).toBe(true);
    expect(upload.ms).toBeGreaterThanOrEqual(700);

    await browser.setConnectivity({ mode: 'normal' });
    const restored = await timed(browser, '/blob?bytes=32768');
    expect(restored).toMatchObject({ ok: true, bytes: 32768 });
    expect(restored.ms).toBeLessThan(300);
    expect(changes(browser)).toContainEqual(expect.objectContaining({
      kind: 'connectivity_change', from: 'normal', to: 'throttled',
      profile: { mode: 'throttled', latencyMs: 400, downloadKbps: 256, uploadKbps: 128 },
    }));
  }, 40_000);

  it('applies the initial pack network through the same implementation, including offline start and recovery', async () => {
    const slow = await open({ mode: 'throttled', latencyMs: 400, downloadKbps: 1024, uploadKbps: 1024 });
    expect(profileOf(slow)).toMatchObject({ status: 'applied', value: expect.objectContaining({ mode: 'throttled', latencyMs: 400 }) });
    await slow.execute({ tool: 'navigate', path: '/surface' });
    expect((await timed(slow, '/ping')).ms).toBeGreaterThanOrEqual(350);
    await slow.close();
    session = undefined;

    const dark = await open({ mode: 'offline' });
    expect(profileOf(dark)).toMatchObject({ status: 'applied', value: expect.objectContaining({ mode: 'offline' }) });
    await expect(dark.execute({ tool: 'navigate', path: '/surface' })).rejects.toThrow();
    await dark.setConnectivity({ mode: 'normal' });
    await expect(dark.execute({ tool: 'navigate', path: '/surface' })).resolves.toContain('Save');
    expect(await timed(dark, '/ping')).toMatchObject({ ok: true });
  }, 40_000);

  it('clears throttle, offline and request delay on every switch', async () => {
    const browser = await open({ mode: 'request_delay', delayMs: 400, pathPrefix: '/ping' });
    await browser.execute({ tool: 'navigate', path: '/surface' });
    expect((await timed(browser, '/ping')).ms).toBeGreaterThanOrEqual(350);
    const delayed = browser.networkEvents.filter(event => (event as { kind?: string }).kind === 'request_delay').length;
    expect(delayed).toBe(1);

    await browser.setConnectivity({ mode: 'normal' });
    expect((await timed(browser, '/ping')).ms).toBeLessThan(250);
    expect(browser.networkEvents.filter(event => (event as { kind?: string }).kind === 'request_delay')).toHaveLength(delayed);

    await browser.setConnectivity({ mode: 'offline' });
    expect((await timed(browser, '/ping')).ok).toBe(false);
    await browser.setConnectivity({ mode: 'throttled', latencyMs: 400, downloadKbps: 2048, uploadKbps: 2048 });
    const slow = await timed(browser, '/ping');
    expect(slow.ok).toBe(true);
    expect(slow.ms).toBeGreaterThanOrEqual(350);

    await browser.setConnectivity({ mode: 'request_delay', delayMs: 0, pathPrefix: '/nothing-matches' });
    const afterThrottle = await timed(browser, '/ping');
    expect(afterThrottle.ok).toBe(true);
    expect(afterThrottle.ms).toBeLessThan(250);

    await browser.setConnectivity({ mode: 'normal' });
    expect(await timed(browser, '/ping')).toMatchObject({ ok: true });
    expect(profileOf(browser)).toMatchObject({ status: 'applied', value: expect.objectContaining({ mode: 'normal' }) });
  }, 40_000);

  it('keeps the strict origin allowlist under every profile and after switching back', async () => {
    const browser = await open();
    await browser.execute({ tool: 'navigate', path: '/surface' });
    const profiles: Network[] = [
      { mode: 'throttled', latencyMs: 0, downloadKbps: 100_000, uploadKbps: 100_000 },
      { mode: 'request_delay', delayMs: 0, pathPrefix: '/ping' },
      { mode: 'normal' },
    ];
    for (const profile of profiles) {
      await browser.setConnectivity(profile);
      expect(await timed(browser, `${offsite}/direct`), JSON.stringify(profile)).toMatchObject({ ok: false });
      expect(await timed(browser, '/api/test/state')).toMatchObject({ ok: false });
      expect(await timed(browser, '/to-offsite')).toMatchObject({ ok: false });
      expect(await timed(browser, '/ping')).toMatchObject({ ok: true });
    }
    await browser.setConnectivity({ mode: 'offline' });
    await browser.setConnectivity({ mode: 'normal' });
    expect(await timed(browser, `${offsite}/direct`)).toMatchObject({ ok: false });
    expect(hits.offsite).toBe(0);
    expect(hits.apiTest).toBe(0);
  }, 40_000);

  it('does not let the model change connectivity through an action', async () => {
    const browser = await open();
    await browser.execute({ tool: 'navigate', path: '/surface' });
    await expect(browser.execute({ tool: 'setConnectivity', profile: { mode: 'offline' } } as never)).rejects.toThrow(/invalid browser action/i);
    expect(await timed(browser, '/ping')).toMatchObject({ ok: true });
    expect(profileOf(browser)).toMatchObject({ value: expect.objectContaining({ mode: 'normal' }) });
  }, 30_000);

  it('keeps cancellation working under throttling and refuses connectivity changes after cancel', async () => {
    const controller = new AbortController();
    const browser = await open({ mode: 'throttled', latencyMs: 3000, downloadKbps: 16, uploadKbps: 16 }, { signal: controller.signal });
    const started = performance.now();
    const navigation = browser.execute({ tool: 'navigate', path: '/surface' });
    setTimeout(() => controller.abort(), 400);
    await expect(navigation).rejects.toThrow(/cancel/i);
    expect(performance.now() - started).toBeLessThan(2500);
    await expect(browser.setConnectivity({ mode: 'normal' })).rejects.toThrow(/cancel|closed|time limit/i);
  }, 30_000);

  it('bounds actions by the remaining journey budget and never resets it', async () => {
    const browser = await open({ mode: 'normal' }, { actionLimit: 2 });
    await browser.setConnectivity({ mode: 'throttled', latencyMs: 0, downloadKbps: 100_000, uploadKbps: 100_000 });
    await browser.execute({ tool: 'navigate', path: '/surface' });
    await browser.observe();
    await expect(browser.observe()).rejects.toThrow(/budget/i);
    await expect(browser.execute({ tool: 'navigate', path: '/surface' })).rejects.toThrow(/budget/i);
    await browser.close();
    session = undefined;

    for (const actionLimit of [0, 41, 1.5, -1, Number.NaN]) {
      await expect(open({ mode: 'normal' }, { actionLimit }), String(actionLimit)).rejects.toThrow(/budget|invalid|limit/i);
    }
  }, 40_000);

  it('preserves IndexedDB in storageState for a recreated return-stage session', async () => {
    const first = await open();
    await first.execute({ tool: 'navigate', path: '/surface' });
    await first.page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('lastmile-connectivity', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction('kv', 'readwrite');
        transaction.objectStore('kv').put('kept', 'draft');
        transaction.oncomplete = () => { request.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    }));
    const state = await first.storageState();
    expect(JSON.stringify(state.origins)).toContain('lastmile-connectivity');
    await first.close();
    session = undefined;

    const second = await open({ mode: 'offline' }, { storageState: state });
    await second.setConnectivity({ mode: 'normal' });
    await second.execute({ tool: 'navigate', path: '/surface' });
    const value = await second.page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open('lastmile-connectivity');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const read = request.result.transaction('kv').objectStore('kv').get('draft');
        read.onsuccess = () => { request.result.close(); resolve(read.result); };
        read.onerror = () => reject(read.error);
      };
    }));
    expect(value).toBe('kept');
  }, 40_000);
});
