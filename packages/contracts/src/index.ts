import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export const InputValueSchema = z.union([scalar, z.object({ fixtureId: id }).strict()]);
export type InputValue = z.infer<typeof InputValueSchema>;
export const ExpectedSchema = z.union([
  z.object({ literal: scalar }).strict(), z.object({ input: id }).strict(),
]);
export type Expected = z.infer<typeof ExpectedSchema>;
export const LocatorSchema = z.object({
  by: z.enum(['role', 'label', 'text', 'testId']), value: z.string().min(1).max(500), name: z.string().optional(),
}).strict();
export type LocatorSpec = z.infer<typeof LocatorSchema>;
export const AssertionSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('visible'), locator: LocatorSchema }).strict(),
  z.object({ id, kind: z.literal('field'), locator: LocatorSchema, expected: ExpectedSchema }).strict(),
  z.object({ id, kind: z.literal('state_equals'), path: z.string().regex(/^[a-zA-Z0-9_.-]+$/), expected: ExpectedSchema }).strict(),
  z.object({ id, kind: z.literal('state_count'), path: z.string().regex(/^[a-zA-Z0-9_.-]+$/), expected: z.number().int().nonnegative() }).strict(),
]);
export type Assertion = z.infer<typeof AssertionSchema>;
export const OutcomeContractSchema = z.object({
  scope: z.enum(['ui_only', 'ui_and_api']), assertions: z.array(AssertionSchema).min(1).max(30),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.assertions.map(a => a.id)).size !== c.assertions.length) ctx.addIssue({ code: 'custom', message: 'Assertion IDs must be unique' });
  const hasState = c.assertions.some(a => a.kind.startsWith('state_'));
  if (c.scope === 'ui_only' && hasState) {
    ctx.addIssue({ code: 'custom', message: 'Screen-only contracts allow only UI assertions' });
  }
  if (c.scope === 'ui_and_api' && (!hasState || !c.assertions.some(a => !a.kind.startsWith('state_')))) {
    ctx.addIssue({ code: 'custom', message: 'UI and persisted-state assertions are required' });
  }
});
export const ScenarioSchema = z.object({
  id, revision: z.number().int().positive().default(1), label: z.string().min(1).max(120), goal: z.string().min(5).max(3000),
  entryPath: z.string().regex(/^\/(?!\/)[^\\]*$/), initialStateId: id,
  inputSlots: z.record(id, z.object({ type: z.enum(['text', 'number', 'boolean', 'file']), required: z.boolean().default(true) }).strict()),
  contract: OutcomeContractSchema,
  investigation: z.object({ factors: z.array(z.enum(['viewport', 'locale', 'network', 'interaction', 'reducedMotion', 'inputs'])).default(['viewport']), maxAttempts: z.number().int().min(4).max(12).default(12) }).strict().default({ factors: ['viewport'], maxAttempts: 12 }),
}).strict();
export type ScenarioDefinition = z.infer<typeof ScenarioSchema>;
export const ContextPackSchema = z.object({
  id, revision: z.number().int().positive().default(1), label: z.string().min(1).max(120),
  viewport: z.object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(480).max(1600) }).strict(),
  locale: z.string().refine(value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }, 'Invalid locale'),
  preferredLanguage: z.string().min(1).max(80), familiarity: z.enum(['first_time', 'experienced']),
  knownTerms: z.array(z.string().max(100)).max(30).default([]),
  background: z.string().trim().min(1).max(2000).optional(),
  interaction: z.enum(['pointer', 'keyboard_only']), reducedMotion: z.enum(['no-preference', 'reduce']),
  network: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('normal') }).strict(),
    z.object({ mode: z.literal('request_delay'), delayMs: z.number().int().min(0).max(3000), pathPrefix: z.string().regex(/^\/(?!\/)[^\\]*$/) }).strict(),
  ]),
  inputs: z.record(id, InputValueSchema),
}).strict();
export type ContextPack = z.infer<typeof ContextPackSchema>;

export function compileInputs(scenario: ScenarioDefinition, context: ContextPack): Record<string, InputValue> {
  OutcomeContractSchema.parse(scenario.contract);
  const inputs: Record<string, InputValue> = {};
  for (const [key, slot] of Object.entries(scenario.inputSlots)) {
    const value = context.inputs[key];
    if (value === undefined) { if (slot.required) throw new Error(`Missing input: ${key}`); continue; }
    const valid = slot.type === 'file' ? typeof value === 'object' && 'fixtureId' in value : typeof value === ({ text: 'string', number: 'number', boolean: 'boolean' } as const)[slot.type];
    if (!valid) throw new Error(`Invalid input type: ${key}`);
    inputs[key] = value;
  }
  for (const assertion of scenario.contract.assertions) {
    if ('expected' in assertion && typeof assertion.expected === 'object' && 'input' in assertion.expected) resolveExpected(assertion.expected, inputs);
  }
  return inputs;
}
export function resolveExpected(expected: Expected, inputs: Record<string, InputValue>): InputValue {
  if ('literal' in expected) return expected.literal;
  if (!Object.hasOwn(inputs, expected.input)) throw new Error(`Missing expected input: ${expected.input}`);
  return inputs[expected.input];
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'interrupted';
export type Verdict = 'passed' | 'failed' | 'inconclusive';
export type AssertionResult = { id: string; status: 'passed' | 'failed' | 'not_evaluated'; expected?: unknown; actual?: unknown; message?: string };
export type StepEvent = { index: number; timestamp: string; action: string; observation: string; arguments?: unknown; screenshot?: string };
export type Finding = { kind: 'functional_failure' | 'api_or_outcome_failure' | 'suspected_ux_friction' | 'agent_error' | 'environment_failure' | 'replay_mismatch' | 'inconclusive'; description: string; evidencePaths: string[] };
export type AppliedCapability = { factor: string; status: 'applied' | 'guidance_only' | 'not_exercised' | 'unsupported'; value: unknown };
export type RunRecord = {
  id: string; requestId: string; scenario: ScenarioDefinition; context: ContextPack;
  inputs: Record<string, InputValue>; status: RunStatus; verdict: Verdict | null;
  createdAt: string; startedAt?: string; finishedAt?: string; namespaceId?: string;
  manifestHash: string; executionMode: 'ai_guided' | 'deterministic';
  steps: StepEvent[]; assertions: AssertionResult[]; findings: Finding[];
  capabilities: AppliedCapability[]; artifacts: string[];
};
export const RunRequestSchema = z.object({ requestId: id, scenarioId: id, scenarioRevision: z.number().int().positive(), contextPackId: id, contextRevision: z.number().int().positive() }).strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type ApiError = { code: string; message: string };
export const capabilities = [
  { factor: 'viewport', mode: 'enforced', description: 'Chromium viewport emulation' },
  { factor: 'locale', mode: 'enforced', description: 'Browser locale; does not translate the app' },
  { factor: 'preferredLanguage', mode: 'guidance', description: 'Agent language preference, not measured human behavior' },
  { factor: 'familiarity', mode: 'guidance', description: 'Declared knowledge; behavioral simulation' },
  { factor: 'interaction', mode: 'enforced', description: 'Pointer or keyboard-only tools' },
  { factor: 'reducedMotion', mode: 'enforced', description: 'Browser reduced-motion preference' },
  { factor: 'network', mode: 'enforced', description: 'Normal or injected request delay; not bandwidth shaping' },
  { factor: 'inputs', mode: 'enforced', description: 'Typed values and approved fixture bindings' },
] as const;
