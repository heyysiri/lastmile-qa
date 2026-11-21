import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openRunStore } from '../apps/runner/src/store';

let folder: string;
let file: string;
let store: ReturnType<typeof openRunStore>;
const request = {
  requestId: 'first', scenarioId: 'store-setup', scenarioRevision: 1,
  contextPackId: 'desktop-seller', contextRevision: 1,
};
const target = 'http://127.0.0.1:3001';

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lastmile-store-'));
  file = join(folder, 'runs.sqlite');
  store = openRunStore(file);
});

afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

it('retains the exact revision after a newer edit and restart', () => {
  const original = store.scenarios.list().find(({ id }) => id === request.scenarioId)!;
  store.scenarios.update({ ...original, label: 'Edited store setup' });
  store.close();
  store = openRunStore(file);
  expect(store.scenarios.list()).toHaveLength(2);
  expect(store.scenarios.get(original.id, 2)?.label).toBe('Edited store setup');
  expect(store.enqueue(request, target).scenario).toEqual(original);
});

it('interrupts running jobs on restart and leaves queued jobs claimable', () => {
  const active = store.enqueue(request, target);
  const pending = store.enqueue({ ...request, requestId: 'next' }, target);
  expect(store.claimNext()?.id).toBe(active.id);
  store.close();
  store = openRunStore(file);
  store.recoverInterrupted();
  expect(store.getRun(active.id)).toMatchObject({ status: 'interrupted', verdict: 'inconclusive' });
  expect(store.getRun(pending.id)?.status).toBe('queued');
  expect(store.claimNext()?.id).toBe(pending.id);
});

it('rejects launching an older revision with state assertions in a screen-only contract', () => {
  const scenario = store.scenarios.get(request.scenarioId, request.scenarioRevision)!;
  const legacy = store.scenarios.create({
    ...scenario, id: 'legacy-screen-only', contract: { ...scenario.contract, scope: 'ui_only' },
  });
  expect(() => store.enqueue({ ...request, scenarioId: legacy.id }, target)).toThrow(
    expect.objectContaining({ status: 400, code: 'invalid_contract' }),
  );
  expect(store.listRuns()).toHaveLength(0);
});

it('preserves the manifest through executor updates and rejects changes to terminal runs', () => {
  const queued = store.enqueue(request, target);
  const running = store.claimNext()!;
  store.updateRun({
    ...running, inputs: {}, scenario: { ...running.scenario, label: 'Changed by executor' },
    manifestHash: 'changed', status: 'completed', verdict: 'inconclusive',
  });
  expect(store.getRun(queued.id)).toMatchObject({
    status: 'completed', inputs: { storeName: 'Siri Crafts' },
    scenario: queued.scenario, manifestHash: queued.manifestHash,
  });
  expect(() => store.updateRun({ ...running, status: 'completed', verdict: 'passed' })).toThrow();
  expect(store.getRun(queued.id)?.verdict).toBe('inconclusive');
});

it('hashes the configuration independently of request identity and includes context edits', () => {
  const first = store.enqueue(request, target);
  const second = store.enqueue({ ...request, requestId: 'same-config' }, target);
  expect(second.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(second.manifestHash).toBe(first.manifestHash);
  store.contextPacks.update({ ...first.context, preferredLanguage: 'Hindi' });
  const edited = store.enqueue({ ...request, requestId: 'edited-context', contextRevision: 2 }, target);
  expect(edited.inputs).toEqual(first.inputs);
  expect(edited.manifestHash).not.toBe(first.manifestHash);
});

it('rejects file bindings until approved fixture registration exists',()=>{
 const scenario=store.scenarios.get('store-setup',1)!;
 const context=store.contextPacks.get('desktop-seller',1)!;
 store.scenarios.create({...scenario,id:'file-task',inputSlots:{document:{type:'file',required:true}},contract:{scope:'ui_only',assertions:[{id:'visible',kind:'visible',locator:{by:'text',value:'Ready'}}]}});
 store.contextPacks.create({...context,id:'file-context',inputs:{document:{fixtureId:'unregistered'}}});
 expect(()=>store.enqueue({...request,scenarioId:'file-task',contextPackId:'file-context'},target)).toThrow(expect.objectContaining({code:'unsupported_fixture'}));
});
