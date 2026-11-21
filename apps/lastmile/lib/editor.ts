import { ContextPackSchema, ScenarioSchema } from '@lastmile/contracts';
import type { ContextPack, LocatorSpec, RunRequest, ScenarioDefinition } from '@lastmile/contracts';
import type { ZodError } from 'zod';

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function issues(error: ZodError): string[] {
  return error.issues.map(i => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

function parseWith<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodError } }, value: unknown): Parsed<T> {
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: issues(r.error) };
}

function parseJson<T>(schema: Parameters<typeof parseWith<T>>[0], text: string): Parsed<T> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return parseWith(schema, raw);
}

export const parseScenarioJson = (text: string) => parseJson<ScenarioDefinition>(ScenarioSchema as never, text);
export const parseContextJson = (text: string) => parseJson<ContextPack>(ContextPackSchema as never, text);

export type ScenarioBasics = { label: string; goal: string; entryPath: string };
export function applyScenarioBasics(base: ScenarioDefinition, b: ScenarioBasics): Parsed<ScenarioDefinition> {
  return parseWith<ScenarioDefinition>(ScenarioSchema as never, { ...base, ...b });
}

export type ContextBasics = {
  label: string; viewport: { width: number; height: number }; locale: string; preferredLanguage: string;
  familiarity: ContextPack['familiarity']; interaction: ContextPack['interaction']; reducedMotion: ContextPack['reducedMotion'];
  network: ContextPack['network']; knownTerms: string;
};
export function applyContextBasics(base: ContextPack, b: ContextBasics): Parsed<ContextPack> {
  const knownTerms = b.knownTerms.split(',').map(t => t.trim()).filter(Boolean);
  return parseWith<ContextPack>(ContextPackSchema as never, { ...base, ...b, knownTerms });
}

export function nextUniqueId(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  const make = (suffix: string) => `${base.slice(0, 80 - suffix.length)}${suffix}`;
  let candidate = make('-copy');
  for (let n = 2; taken.has(candidate) || candidate === base; n++) candidate = make(`-copy-${n}`);
  return candidate;
}

export function duplicateScenario(s: ScenarioDefinition, existingIds: readonly string[]): ScenarioDefinition {
  return { ...structuredClone(s), id: nextUniqueId(s.id, existingIds), revision: 1, label: `${s.label} (copy)`.slice(0, 120) };
}
export function duplicateContext(c: ContextPack, existingIds: readonly string[]): ContextPack {
  return { ...structuredClone(c), id: nextUniqueId(c.id, existingIds), revision: 1, label: `${c.label} (copy)`.slice(0, 120) };
}

export function newRequestId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `ui-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function buildRunRequest(s: ScenarioDefinition, c: ContextPack): RunRequest {
  return { requestId: newRequestId(), scenarioId: s.id, scenarioRevision: s.revision, contextPackId: c.id, contextRevision: c.revision };
}

export function formatLocator(l: LocatorSpec): string {
  if (l.by === 'role') return `role ${l.value}${l.name ? ` named "${l.name}"` : ''}`;
  return `${l.by} "${l.value}"`;
}
