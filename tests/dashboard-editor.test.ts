import { describe, expect, it } from 'vitest';
import { storeScenario, desktopContext } from '../packages/contracts/src/examples';
import {
  parseScenarioJson, parseContextJson, duplicateScenario, duplicateContext, buildRunRequest,
  applyScenarioBasics, applyContextBasics, nextUniqueId, formatLocator,
} from '../apps/lastmile/lib/editor';
import { resolveProxyTarget, isSameOriginWrite, runnerBase } from '../apps/lastmile/lib/proxy-policy';

describe('JSON editing against shared schemas', () => {
  it('accepts a valid scenario and reports schema paths for invalid ones', () => {
    expect(parseScenarioJson(JSON.stringify(storeScenario)).ok).toBe(true);
    const bad = parseScenarioJson(JSON.stringify({ ...storeScenario, entryPath: 'https://evil.test' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join('\n')).toContain('entryPath');
  });
  it('reports malformed JSON without throwing', () => {
    const r = parseContextJson('{nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/JSON/i);
  });
  it('rejects unsupported network modes in context', () => {
    expect(parseContextJson(JSON.stringify({ ...desktopContext, network: { mode: '4g' } })).ok).toBe(false);
  });
});

describe('basic field editors', () => {
  it('updates goal and entry path while keeping contract and revision', () => {
    const next = applyScenarioBasics(storeScenario, { label: 'New label', goal: 'Do the seller thing now', entryPath: '/inventory' });
    expect(next.ok && next.value.entryPath).toBe('/inventory');
    expect(next.ok && next.value.contract).toEqual(storeScenario.contract);
    expect(next.ok && next.value.revision).toBe(storeScenario.revision);
  });
  it('rejects external entry paths from the form', () => {
    expect(applyScenarioBasics(storeScenario, { label: 'x', goal: 'Do the seller thing', entryPath: '//evil.test' }).ok).toBe(false);
  });
  it('edits context viewport, locale, familiarity, network and input fields', () => {
    const r = applyContextBasics(desktopContext, {
      label: 'Slow phone', viewport: { width: 390, height: 844 }, locale: 'hi-IN', preferredLanguage: 'Hindi',
      familiarity: 'first_time', interaction: 'keyboard_only', reducedMotion: 'reduce',
      network: { mode: 'request_delay', delayMs: 1500, pathPrefix: '/api' }, knownTerms: 'SKU, listing',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.viewport).toEqual({ width: 390, height: 844 });
      expect(r.value.knownTerms).toEqual(['SKU', 'listing']);
      expect(r.value.network).toEqual({ mode: 'request_delay', delayMs: 1500, pathPrefix: '/api' });
      expect(r.value.inputs).toEqual(desktopContext.inputs);
    }
  });
  it('rejects invalid locale', () => {
    const r = applyContextBasics(desktopContext, { ...{ label: 'x', viewport: { width: 1280, height: 800 }, preferredLanguage: 'English', familiarity: 'experienced' as const, interaction: 'pointer' as const, reducedMotion: 'no-preference' as const, network: { mode: 'normal' as const }, knownTerms: '' }, locale: 'not a locale!!' });
    expect(r.ok).toBe(false);
  });
});

describe('duplication and ids', () => {
  it('creates a NEW id, resets revision, and never reuses existing ids', () => {
    const copy = duplicateScenario(storeScenario, ['store-setup', 'store-setup-copy']);
    expect(copy.id).toBe('store-setup-copy-2');
    expect(copy.revision).toBe(1);
    expect(copy.label).toContain('copy');
    expect(duplicateContext(desktopContext, []).id).toBe('desktop-seller-copy');
  });
  it('nextUniqueId respects the 80 char id limit', () => {
    const id = nextUniqueId('a'.repeat(80), []);
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id).not.toBe('a'.repeat(80));
  });
});

describe('run request', () => {
  it('pins the exact selected revisions with a fresh valid requestId', () => {
    const a = buildRunRequest({ ...storeScenario, revision: 3 }, { ...desktopContext, revision: 2 });
    const b = buildRunRequest({ ...storeScenario, revision: 3 }, { ...desktopContext, revision: 2 });
    expect(a).toMatchObject({ scenarioId: 'store-setup', scenarioRevision: 3, contextPackId: 'desktop-seller', contextRevision: 2 });
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.requestId).toMatch(/^[a-zA-Z0-9_-]{1,80}$/);
  });
});

describe('locator display', () => {
  it('formats a locator readably', () => {
    expect(formatLocator({ by: 'text', value: 'Store saved' })).toBe('text "Store saved"');
    expect(formatLocator({ by: 'role', value: 'button', name: 'Save' })).toBe('role button named "Save"');
  });
});

describe('runner proxy policy', () => {
  it('maps only allow-listed method/path pairs to runner /api targets', () => {
    expect(resolveProxyTarget('GET', ['health'])).toBe('/api/health');
    expect(resolveProxyTarget('GET', ['runs', 'abc-1'])).toBe('/api/runs/abc-1');
    expect(resolveProxyTarget('GET', ['runs', 'abc-1', 'artifacts'])).toBe('/api/runs/abc-1/artifacts');
    expect(resolveProxyTarget('POST', ['runs'])).toBe('/api/runs');
    expect(resolveProxyTarget('PUT', ['scenarios', 'store-setup'])).toBe('/api/scenarios/store-setup');
    expect(resolveProxyTarget('PUT', ['context-packs', 'desktop-seller'])).toBe('/api/context-packs/desktop-seller');
  });
  it('denies deletes, unknown paths, traversal, and absolute URLs', () => {
    expect(resolveProxyTarget('DELETE', ['scenarios', 'x'])).toBeNull();
    expect(resolveProxyTarget('POST', ['health'])).toBeNull();
    expect(resolveProxyTarget('GET', ['..', 'secret'])).toBeNull();
    expect(resolveProxyTarget('GET', ['runs', '../x'])).toBeNull();
    expect(resolveProxyTarget('GET', ['http://evil.test'])).toBeNull();
    expect(resolveProxyTarget('GET', ['runs', 'a', 'artifacts', 'extra'])).toBeNull();
    expect(resolveProxyTarget('PUT', ['runs', 'a'])).toBeNull();
  });
  it('requires same-origin for writes only', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(isSameOriginWrite(h({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }))).toBe(true);
    expect(isSameOriginWrite(h({ host: '127.0.0.1:3000', origin: 'http://evil.test' }))).toBe(false);
    expect(isSameOriginWrite(h({ host: '127.0.0.1:3000' }))).toBe(false);
    expect(isSameOriginWrite(h({ host: '127.0.0.1:3000', origin: 'null' }))).toBe(false);
  });
  it('defaults the runner URL to loopback:4000', () => {
    expect(runnerBase({})).toBe('http://127.0.0.1:4000');
    expect(runnerBase({ RUNNER_URL: 'http://127.0.0.1:4100/' })).toBe('http://127.0.0.1:4100');
  });
});
