import type { ContextPack, RunRecord, RunRequest, ScenarioDefinition } from '@lastmile/contracts';

export type Health = { status: 'ok'; modelConfigured: boolean; executionReady: boolean };
export type CapabilityInfo = { factor: string; mode?: string; description?: string; [k: string]: unknown };
export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/runner/${path}`, {
      method, cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, 'dashboard_offline', 'Could not reach the dashboard server.');
  }
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const e = (json ?? {}) as { code?: string; message?: string };
    throw new ApiFailure(res.status, e.code ?? 'http_error', e.message ?? `Request failed with status ${res.status}`);
  }
  return json as T;
}

export const api = {
  health: () => call<Health>('GET', 'health'),
  capabilities: () => call<CapabilityInfo[]>('GET', 'capabilities'),
  scenarios: () => call<ScenarioDefinition[]>('GET', 'scenarios'),
  contexts: () => call<ContextPack[]>('GET', 'context-packs'),
  createScenario: (s: ScenarioDefinition) => call<ScenarioDefinition>('POST', 'scenarios', s),
  updateScenario: (s: ScenarioDefinition) => call<ScenarioDefinition>('PUT', `scenarios/${encodeURIComponent(s.id)}`, s),
  createContext: (c: ContextPack) => call<ContextPack>('POST', 'context-packs', c),
  updateContext: (c: ContextPack) => call<ContextPack>('PUT', `context-packs/${encodeURIComponent(c.id)}`, c),
  runs: () => call<RunRecord[]>('GET', 'runs'),
  run: (id: string) => call<RunRecord>('GET', `runs/${encodeURIComponent(id)}`),
  artifacts: (id: string) => call<unknown[]>('GET', `runs/${encodeURIComponent(id)}/artifacts`),
  startRun: (r: RunRequest) => call<{ id: string; status: string }>('POST', 'runs', r),
};

/** Small load helper with explicit loading/error state. */
import { useCallback, useEffect, useState } from 'react';
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); } catch (e) { setError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e))); } finally { setLoading(false); }
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
