import { errors, type Page } from 'playwright';
import type { ProjectCheck, ProjectCheckResult } from '@lastmile/contracts/projects';
import type { NetworkProfile } from '@lastmile/contracts';
import { fieldNameLocator } from './field-locator';

const TOTAL_TIMEOUT_MS = 15_000;
const LOCATOR_TIMEOUT_MS = 2_000;

type Budget = { deadline: number; locatorTimeoutMs: number; signal?: AbortSignal };
function verificationBudget(signal?: AbortSignal, network?: NetworkProfile): Budget {
  // Emulated slow connections delay both the document and client-rendered forms.
  // Wait for the control to exist, then read once; never wait for a value to become correct.
  const slow = network?.mode === 'throttled' || network?.mode === 'request_delay';
  return { deadline: performance.now() + (slow ? 60_000 : TOTAL_TIMEOUT_MS), locatorTimeoutMs: slow ? 15_000 : LOCATOR_TIMEOUT_MS, signal };
}
class CheckUnavailable extends Error {}

function ready(page: Page, { deadline, signal }: Budget): number {
  if (signal?.aborted) throw new CheckUnavailable('Verification cancelled');
  if (page.isClosed()) throw new CheckUnavailable('Page closed during verification');
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new CheckUnavailable('Verification timed out');
  return remaining;
}

async function bounded<T>(page: Page, budget: Budget, operation: (timeout: number) => Promise<T>): Promise<T> {
  const remaining = ready(page, budget);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckUnavailable('Verification timed out')), remaining);
    onAbort = () => reject(new CheckUnavailable('Verification cancelled'));
    budget.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([operation(remaining), guard]);
    ready(page, budget);
    return value;
  } finally {
    clearTimeout(timer);
    if (onAbort) budget.signal?.removeEventListener('abort', onAbort);
  }
}

function applicationUrl(raw: string, origin?: string): URL {
  const url = URL.parse(raw);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (origin && url.origin !== origin)) {
    throw new CheckUnavailable('Page is outside the application origin');
  }
  return url;
}

function readbackUrl(path: string | undefined, origin: string): URL {
  if (!path || !/^\/(?!\/)[^\\\t\r\n]*$/.test(path)) throw new CheckUnavailable('Invalid readback path');
  return applicationUrl(new URL(path, origin).href, origin);
}

function requireTargetPage(page: Page, target: URL): void {
  const current = applicationUrl(page.url(), target.origin);
  if (current.pathname !== target.pathname || current.search !== target.search || current.hash !== target.hash) {
    throw new CheckUnavailable('Browser is on a different page from the check target');
  }
}

async function navigate(page: Page, target: URL, budget: Budget, reload = false): Promise<void> {
  const response = await bounded(page, budget, timeout => {
    const options = { timeout, waitUntil: 'domcontentloaded' as const };
    return reload ? page.reload(options) : page.goto(target.href, options);
  });
  requireTargetPage(page, target);
  // A fragment-only navigation can retain the original document.
  if (!response && !reload) return navigate(page, target, budget, true);
  if (!response || response.status() >= 400) throw new CheckUnavailable('Readback page is unavailable');
}

function locate(page: Page, { by, value, name }: ProjectCheck['locator']) {
  switch (by) {
    case 'role': return page.getByRole(value as Parameters<Page['getByRole']>[0], { name, exact: true });
    case 'label': return page.getByLabel(value, { exact: true });
    case 'text': return page.getByText(value, { exact: true });
    case 'testId': return page.getByTestId(value);
    case 'fieldName': return fieldNameLocator(page, value);
  }
}

async function observe(page: Page, check: ProjectCheck, origin: string, budget: Budget): Promise<string | boolean | undefined> {
  applicationUrl(page.url(), origin);
  const match = locate(page, check.locator).filter({ visible: true });
  try {
    const value = await bounded(page, budget, async remaining => {
      const timeout = Math.min(remaining, budget.locatorTimeoutMs);
      switch (check.kind) {
        case 'visible': await match.waitFor({ state: 'visible', timeout }); return true;
        case 'field': return match.inputValue({ timeout });
        case 'text': return (await match.textContent({ timeout }))?.trim();
      }
    });
    applicationUrl(page.url(), origin);
    return value;
  } catch (error) {
    ready(page, budget);
    applicationUrl(page.url(), origin);
    if (error instanceof errors.TimeoutError) return check.kind === 'visible' ? false : undefined;
    throw error;
  }
}

function unavailableMessage(error: unknown): string {
  if (error instanceof CheckUnavailable) return error.message;
  if (error instanceof Error && /strict mode violation/i.test(error.message)) return 'Locator has multiple visible matches';
  return 'Page could not be inspected';
}

export async function captureProjectChecks(page: Page, checks: ProjectCheck[], origin: string, signal?: AbortSignal, network?: NetworkProfile): Promise<ProjectCheck[]> {
  const budget = verificationBudget(signal, network);
  const captured: ProjectCheck[] = [];
  for (const check of checks) {
    if (check.phase !== 'preserve' || check.expected !== undefined) {
      captured.push(check);
      continue;
    }
    try {
      const appOrigin = applicationUrl(origin).origin;
      const target = readbackUrl(check.path, appOrigin);
      await navigate(page, target, budget);
      const expected = await observe(page, check, appOrigin, budget);
      requireTargetPage(page, target);
      if (expected === undefined || expected === false) throw new CheckUnavailable('No visible element matches the locator');
      captured.push({ ...check, expected });
    } catch (error) {
      throw new Error(`Could not capture preserved state: ${unavailableMessage(error)}`);
    }
  }
  return captured;
}

export async function verifyProjectChecks(page: Page, checks: ProjectCheck[], origin: string, signal?: AbortSignal, network?: NetworkProfile): Promise<ProjectCheckResult[]> {
  const budget = verificationBudget(signal, network);
  const originalUrl = page.url();
  const results: ProjectCheckResult[] = [];
  const entries = [...checks.entries()];
  const ordered = [
    ...entries.filter(([, check]) => check.phase === 'after_action'),
    ...entries.filter(([, check]) => check.phase !== 'after_action'),
  ];
  for (const [index, check] of ordered) {
    const { id, label, basis, phase, sources } = check;
    const expected = check.expected ?? (check.kind === 'visible' && phase !== 'preserve' ? true : undefined);
    const result = { id, label, basis, phase, sources, expected, ...(check.atStageStart ? {atStageStart:check.atStageStart} : {}) };
    try {
      ready(page, budget);
      if (expected === undefined) throw new CheckUnavailable('Check has no frozen expectation');
      if (check.kind === 'visible' && typeof expected !== 'boolean') throw new CheckUnavailable('Visibility check requires a boolean expectation');
      const appOrigin = applicationUrl(origin).origin;
      let target: URL | undefined;
      if (phase === 'after_action') {
        if (check.path !== undefined) {
          target = readbackUrl(check.path, appOrigin);
          requireTargetPage(page, target);
        }
      } else {
        const pathless = phase === 'after_reload' && check.path === undefined;
        target = pathless ? applicationUrl(originalUrl, appOrigin) : readbackUrl(check.path, appOrigin);
        await navigate(page, target, budget, pathless && page.url() === originalUrl);
      }
      const actual = await observe(page, check, appOrigin, budget);
      if (target) requireTargetPage(page, target);
      const passed = actual === (check.kind === 'visible' ? expected : String(expected));
      results[index] = { ...result, actual, status: passed ? 'passed' : 'failed' };
      if (!passed) results[index].message = actual === undefined || actual === false
        ? 'No visible element matches the locator' : 'Observed value differs from the expectation';
    } catch (error) {
      results[index] = { ...result, status: 'not_evaluated', message: unavailableMessage(error) };
    }
  }
  return results;
}
