import { describe, expect, it } from 'vitest';
import { ContextPackSchema, ScenarioSchema, compileInputs, resolveExpected } from '../packages/contracts/src/index';
import { desktopContext, storeScenario, inventoryScenario } from '../packages/contracts/src/examples';

describe('dynamic configuration boundary', () => {
  it('accepts unrelated goals with no scenario dispatch', () => {
    for (const source of [storeScenario, inventoryScenario]) {
      expect(ScenarioSchema.parse({ ...source, id: 'new-task', goal: 'Complete a seller task using the supplied values' }).id).toBe('new-task');
    }
  });
  it('rejects external and protocol-relative entry paths', () => {
    for (const entryPath of ['https://example.com', '//example.com', '/\\evil']) {
      expect(ScenarioSchema.safeParse({ ...storeScenario, entryPath }).success).toBe(false);
    }
  });
  it('rejects unsupported required network settings', () => {
    expect(ContextPackSchema.safeParse({ ...desktopContext, network: { mode: '4g' } }).success).toBe(false);
  });
  it('rejects unsupported viewport values', () => {
    expect(ContextPackSchema.safeParse({ ...desktopContext, viewport: { width: 0, height: 844 } }).success).toBe(false);
  });
  it('resolves typed bindings without changing the contract', () => {
    const context = { ...desktopContext, inputs: { storeName: 'Siri Crafts' } };
    const inputs = compileInputs(storeScenario, context);
    expect(resolveExpected({ input: 'storeName' }, inputs)).toBe('Siri Crafts');
    expect(storeScenario.contract.assertions.length).toBeGreaterThan(0);
  });
  it('rejects missing required inputs and wrong types', () => {
    expect(() => compileInputs(storeScenario, { ...desktopContext, inputs: {} })).toThrow('storeName');
    expect(() => compileInputs(inventoryScenario, { ...desktopContext, inputs: { quantity: '12' } })).toThrow('quantity');
  });
  it('does not silently pass an undefined expected binding', () => {
    expect(() => resolveExpected({ input: 'missing' }, {})).toThrow('missing');
  });
});
