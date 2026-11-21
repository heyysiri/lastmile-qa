import type { Locator, Page } from 'playwright';
import { resolveExpected, type AssertionResult, type InputValue, type LocatorSpec, type ScenarioDefinition } from '@lastmile/contracts';

export type OutcomeContract = ScenarioDefinition['contract'];
type ContractAssertion = OutcomeContract['assertions'][number];
export type VerificationInput = {
  page: Page;
  contract: OutcomeContract;
  inputs: Record<string, InputValue>;
  /** Trusted, server-only readback. Called at most once, after every UI check. */
  readState: () => Promise<unknown>;
  /** Total budget for the UI checks (default 2000 ms); also bounds the single readback. */
  timeoutMs?: number;
  /** Lets the caller (for example a 180 s run deadline) cancel verification early. */
  signal?: AbortSignal;
};

export const DEFAULT_VERIFY_TIMEOUT_MS = 2000;
const POLL_MS = 50;
const MAX_TEXT = 200;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

type Scalar = string | number | boolean;
type Outcome = Omit<AssertionResult, 'id'>;
const isScalar = (value: unknown): value is Scalar => ['string', 'number', 'boolean'].includes(typeof value);
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** Small JSON-safe rendering: scalars are truncated, containers are summarized, never copied. */
export function summarize(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return null;
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).length };
  return typeof value;
}

/** Messages shown to users: first line only, bounded, with URLs and key-like tokens removed. */
export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0].replace(/https?:\/\/\S+/gi, '[url]').replace(/\b(token|key|secret|password|authorization)\b\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, MAX_TEXT);
}

type PathResult = { ok: true; value: unknown } | { ok: false; reason: 'unsafe' | 'missing' };
/** Own-property traversal over JSON data; array segments must be canonical in-range indexes. */
export function readPath(root: unknown, path: string): PathResult {
  const segments = path.split('.');
  if (segments.some(segment => segment === '' || UNSAFE_SEGMENTS.has(segment))) return { ok: false, reason: 'unsafe' };
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d{0,8})$/.test(segment) || Number(segment) >= current.length) return { ok: false, reason: 'missing' };
      current = current[Number(segment)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else return { ok: false, reason: 'missing' };
  }
  return { ok: true, value: current };
}

function locate(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'role': return page.getByRole(spec.value as Parameters<Page['getByRole']>[0], spec.name === undefined ? undefined : { name: spec.name, exact: true });
    case 'label': return page.getByLabel(spec.value, { exact: true });
    case 'text': return page.getByText(spec.value, { exact: true });
    case 'testId': return page.getByTestId(spec.value);
  }
}

function resolveScalar(expected: Parameters<typeof resolveExpected>[0], inputs: Record<string, InputValue>): { ok: true; value: Scalar } | { ok: false; message: string } {
  try {
    const value = resolveExpected(expected, inputs);
    if (!isScalar(value)) return { ok: false, message: 'Expected value must be a string, number or boolean' };
    return { ok: true, value };
  } catch (error) { return { ok: false, message: safeMessage(error) }; }
}

async function readField(match: Locator): Promise<string> {
  return match.evaluate(el => {
    const input = el as HTMLInputElement;
    if (input.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) return String(input.checked);
    if ('value' in el && typeof (el as { value: unknown }).value === 'string') return (el as { value: string }).value;
    return (el.textContent ?? '').trim();
  }, undefined, { timeout: 1000 });
}

/** Polls until the single visible match satisfies the check or the deadline passes (always evaluates once). */
async function checkUi(page: Page, assertion: Extract<ContractAssertion, { kind: 'visible' | 'field' }>, inputs: Record<string, InputValue>, deadline: number, signal?: AbortSignal): Promise<Outcome> {
  let expected: Scalar | undefined;
  if (assertion.kind === 'field') {
    const resolved = resolveScalar(assertion.expected, inputs);
    if (!resolved.ok) return { status: 'not_evaluated', message: resolved.message };
    expected = resolved.value;
  }
  const match = locate(page, assertion.locator).filter({ visible: true });
  let last: Outcome = { status: 'failed', message: 'Element not found' };
  let evaluated = false;
  let lastError: unknown;
  for (;;) {
    if (signal?.aborted) return { status: 'not_evaluated', message: 'Verification cancelled' };
    if (page.isClosed()) return { status: 'not_evaluated', message: 'Page closed before verification' };
    try {
      const count = await match.count();
      if (count !== 1) evaluated = true;
      if (count > 1) last = { status: 'failed', message: `Ambiguous locator: ${count} visible matches`, actual: { visibleMatches: count } };
      else if (count === 0) last = { status: 'failed', message: 'No visible element matches the locator', actual: { visibleMatches: 0 } };
      else if (assertion.kind === 'visible') return { status: 'passed' };
      else {
        const actual = await readField(match);
        evaluated = true;
        const wanted = String(expected);
        if (actual === wanted) return { status: 'passed', expected: summarize(expected), actual: summarize(actual) };
        last = { status: 'failed', message: 'Field value differs', expected: summarize(expected), actual: summarize(actual) };
      }
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return evaluated ? last : { status: 'not_evaluated', message: `Page could not be inspected: ${safeMessage(lastError)}` };
}

function checkState(assertion: Extract<ContractAssertion, { kind: 'state_equals' | 'state_count' }>, state: unknown, inputs: Record<string, InputValue>): Outcome {
  let expected: Scalar | undefined;
  if (assertion.kind === 'state_equals') {
    const resolved = resolveScalar(assertion.expected, inputs);
    if (!resolved.ok) return { status: 'not_evaluated', message: resolved.message };
    expected = resolved.value;
  }
  const found = readPath(state, assertion.path);
  if (!found.ok) {
    return found.reason === 'unsafe'
      ? { status: 'not_evaluated', message: 'Unsafe state path' }
      : { status: 'failed', message: 'State path not found', expected: assertion.kind === 'state_count' ? assertion.expected : summarize(expected) };
  }
  if (assertion.kind === 'state_count') {
    if (!Array.isArray(found.value)) return { status: 'failed', message: 'State value is not a list', expected: assertion.expected, actual: summarize(found.value) };
    const length = found.value.length;
    return length === assertion.expected
      ? { status: 'passed', expected: assertion.expected, actual: length }
      : { status: 'failed', message: 'Count differs', expected: assertion.expected, actual: length };
  }
  const same = isScalar(found.value) && typeof found.value === typeof expected && found.value === expected;
  return same
    ? { status: 'passed', expected: summarize(expected), actual: summarize(found.value) }
    : { status: 'failed', message: 'State value differs', expected: summarize(expected), actual: summarize(found.value) };
}

async function readOnce(readState: () => Promise<unknown>, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; state: unknown } | { ok: false; message: string }> {
  if (signal?.aborted) return { ok: false, message: 'Verification cancelled' };
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('State readback timed out')), Math.max(1, timeoutMs));
      onAbort = () => reject(new Error('Verification cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const state = await Promise.race([readState(), guard]);
    if (state === undefined || state === null || typeof state !== 'object') return { ok: false, message: 'State readback returned no data' };
    return { ok: true, state };
  } catch (error) {
    return { ok: false, message: `State readback unavailable: ${safeMessage(error)}` };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Generic, data-driven interpreter for an OutcomeContract. UI checks run first against the page,
 * then trusted state is read once. A failed UI wait is a failed assertion; unavailable readback or
 * an unresolvable contract reference is not_evaluated. Nothing here evaluates contract text as code.
 */
export async function verifyOutcome(input: VerificationInput): Promise<AssertionResult[]> {
  const { page, contract, inputs, readState, signal } = input;
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
  const results = new Map<string, AssertionResult>();
  const deadline = Date.now() + timeoutMs;
  for (const assertion of contract.assertions) {
    if (assertion.kind === 'visible' || assertion.kind === 'field') {
      results.set(assertion.id, { id: assertion.id, ...await checkUi(page, assertion, inputs, deadline, signal) });
    }
  }
  const stateAssertions = contract.assertions.filter((a): a is Extract<ContractAssertion, { kind: 'state_equals' | 'state_count' }> => a.kind === 'state_equals' || a.kind === 'state_count');
  if (stateAssertions.length) {
    const read = await readOnce(readState, timeoutMs, signal);
    for (const assertion of stateAssertions) {
      results.set(assertion.id, { id: assertion.id, ...(read.ok ? checkState(assertion, read.state, inputs) : { status: 'not_evaluated' as const, message: read.message }) });
    }
  }
  return contract.assertions.map(a => results.get(a.id) ?? { id: a.id, status: 'not_evaluated', message: 'Unsupported assertion' });
}
