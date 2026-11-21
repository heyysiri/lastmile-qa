import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelStreamEvent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { desktopContext, storeScenario } from '../packages/contracts/src/examples';
import type { EvidenceRun } from '../packages/contracts/src/runtime';
import { runAgent } from '../apps/runner/src/agent';
import type { BrowserSession } from '../apps/runner/src/browser';

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
  };
}

function* toolCalls(...calls: [string, unknown][]): Generator<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  for (const [index, [name, input]] of calls.entries()) {
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name, toolUseId: `tool-${index}` },
    };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
    yield { type: 'modelContentBlockStopEvent' };
  }
  yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
}

afterEach(() => vi.restoreAllMocks());

describe('Strands journey loop', () => {
  it('registers nine tools, runs them in order and stops mutations after finish', async () => {
    const page = browser();
    const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* (messages, settings) {
      expect(settings?.toolSpecs?.map(spec => spec.name).sort()).toEqual([
        'click', 'fill', 'finish', 'navigate', 'observe', 'pressKey', 'scroll', 'select', 'uploadFixture',
      ]);
      expect(JSON.stringify({ messages, settings })).toContain('Synthetic Crafts');
      expect(JSON.stringify(messages)).toContain('textbox');
      const fill=settings?.toolSpecs?.find(spec=>spec.name==='fill');
      expect(JSON.stringify(fill)).toContain('enum');
      expect(JSON.stringify(fill)).toContain('storeName');
      expect(JSON.stringify({ messages, settings })).not.toContain('state_equals');
      yield* toolCalls(
        ['observe', {}],
        ['pressKey', { key: 'Tab' }],
        ['finish', { status: 'done' }],
        ['navigate', { path: '/later' }],
      );
    });
    await expect(runAgent(page as unknown as BrowserSession, run, options)).resolves.toMatchObject({ modelCalls: 1, finished: true });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(page.observe).toHaveBeenCalledTimes(2);
    expect(page.execute.mock.calls).toEqual([[{ tool: 'pressKey', key: 'Tab' }]]);
  });

  it('counts a transient retry and stops after 20 total attempts', async () => {
    let attempts = 0;
    const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () {
      if (++attempts === 1) throw Object.assign(new Error('Synthetic transport issue'), { status: 503 });
      yield* toolCalls(['observe', {}]);
    });
    await expect(runAgent(browser() as unknown as BrowserSession, run, options)).resolves.toMatchObject({ modelCalls: 20, finished: false });
    expect(stream).toHaveBeenCalledTimes(20);
  });

  it('does not leak raw provider errors or retry permanent failures', async () => {
    const stream = vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () {
      yield* [] as never[];
      throw Object.assign(new Error('raw provider error with synthetic-model-key'), { status: 401 });
    });
    const result = await runAgent(browser() as unknown as BrowserSession, run, options);
    expect(result).toMatchObject({ modelCalls: 1, finished: false });
    expect(result.reason).not.toMatch(/raw provider error|synthetic-model-key/);
    expect(stream).toHaveBeenCalledOnce();
  });

  it('reports a blocked finish separately from a completed journey', async () => {
    vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* () {
      yield* toolCalls(['finish', { status: 'blocked' }]);
    });
    const result = await runAgent(browser() as unknown as BrowserSession, run, options);
    expect(result).toMatchObject({ modelCalls: 1, finished: false, reason: expect.stringMatching(/blocked/i) });
  });

  it('passes cancellation into the provider stream and stops the invocation', async () => {
    const cancel = new AbortController();
    vi.spyOn(OpenAIModel.prototype, 'stream').mockImplementation(async function* (_messages, settings) {
      const signal = settings?.cancelSignal;
      cancel.abort();
      expect(signal?.aborted).toBe(true);
      yield* toolCalls(['navigate', { path: '/late' }]);
    });
    const page = browser();
    const result = await runAgent(page as unknown as BrowserSession, run, { ...options, signal: cancel.signal });
    expect(result).toMatchObject({ modelCalls: 1, finished: false, reason: expect.stringMatching(/cancel/i) });
    expect(page.execute).not.toHaveBeenCalled();
  });
});

it('gives each tester its declared circumstances without leaking outcome internals', async()=>{
 const background='I sell handmade bags and am setting up my first online store.';
 let observed='';
 vi.spyOn(OpenAIModel.prototype,'stream').mockImplementation(async function*(messages){observed=JSON.stringify(messages);yield* toolCalls(['finish',{status:'done'}]);});
 const personalRun={...run,context:{...run.context,background}};
 await runAgent(browser() as unknown as BrowserSession,personalRun,options);
 expect(observed).toContain(background);
 expect(observed).not.toContain('state_equals');
});

it('rejects substituted literal values and accepts only reviewed input references when slots exist', async () => {
 const page=browser();
 let turn=0;
 vi.spyOn(OpenAIModel.prototype,'stream').mockImplementation(async function*(){
  if(turn++===0) yield* toolCalls(['fill',{locator:{by:'label',value:'Store name'},value:{literal:'Changed name'}}]);
  else yield* toolCalls(['fill',{locator:{by:'label',value:'Store name'},value:{input:'storeName'}}],['finish',{status:'done'}]);
 });
 const result=await runAgent(page as unknown as BrowserSession,run,options);
 expect(result.finished).toBe(true);
 expect(page.execute.mock.calls).toEqual([[{tool:'fill',locator:{by:'label',value:'Store name'},value:{input:'storeName'}}]]);
});
