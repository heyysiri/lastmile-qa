'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Play } from 'lucide-react';
import { compileInputs, type RunRequest } from '@lastmile/contracts';
import { ApiFailure, api, useLoad } from '../lib/api';
import { buildRunRequest } from '../lib/editor';
import { ErrorNote, HealthNotice, Pending, StatusBadge } from './ui';

export function RunLauncher() {
  const router = useRouter();
  const scenarios = useLoad(api.scenarios, []);
  const contexts = useLoad(api.contexts, []);
  const runs = useLoad(api.runs, []);
  const [sid, setSid] = useState('');
  const [cid, setCid] = useState('');
  const pendingRequest = useRef<RunRequest | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  const scenario = scenarios.data?.find(s => s.id === (sid || scenarios.data?.[0]?.id));
  const context = contexts.data?.find(c => c.id === (cid || contexts.data?.[0]?.id));
  let inputProblem: string | null = null;
  if (scenario && context) { try { compileInputs(scenario, context); } catch (e) { inputProblem = e instanceof Error ? e.message : String(e); } }

  const start = async () => {
    if (!scenario || !context || starting || inputProblem) return;
    setStarting(true); setError(null);
    if (!pendingRequest.current) pendingRequest.current = buildRunRequest(scenario, context);
    try { const r = await api.startRun(pendingRequest.current); pendingRequest.current = null; router.push(`/runs/${encodeURIComponent(r.id)}`); }
    catch (e) { setError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e))); setStarting(false); }
  };

  const loadErr = scenarios.error ?? contexts.error;
  return (
    <>
      <h1>Run a journey</h1>
      <p className="muted">Pick a scenario, pick who is testing it, then launch. Each run pins the exact revisions shown here.</p>
      <HealthNotice />
      {loadErr && <ErrorNote error={loadErr} onRetry={() => { void scenarios.reload(); void contexts.reload(); }} />}
      {(scenarios.loading || contexts.loading) && !loadErr && <Pending label="Loading configuration…" />}
      <div className="flow">
        <section className="panel stage done" aria-label="Scenario">
          <label className="field"><span>Scenario</span>
            <select value={scenario?.id ?? ''} onChange={e => { setSid(e.target.value); pendingRequest.current = null; }} disabled={starting || !scenarios.data?.length}>
              {(scenarios.data ?? []).map(s => <option key={s.id} value={s.id}>{s.label} (rev {s.revision})</option>)}
            </select></label>
          {scenario ? <><p>{scenario.goal}</p><p className="muted">Starts at <span className="mono">{scenario.entryPath}</span> · {scenario.contract.assertions.length} assertions · revision {scenario.revision}</p></>
            : !scenarios.loading && !loadErr && <p className="muted">No scenarios yet. <Link href="/scenarios">Create one</Link>.</p>}
        </section>
        <section className="panel stage done" aria-label="Context pack">
          <label className="field"><span>Context pack</span>
            <select value={context?.id ?? ''} onChange={e => { setCid(e.target.value); pendingRequest.current = null; }} disabled={starting || !contexts.data?.length}>
              {(contexts.data ?? []).map(c => <option key={c.id} value={c.id}>{c.label} (rev {c.revision})</option>)}
            </select></label>
          {context ? <p className="muted">{context.viewport.width}×{context.viewport.height} · {context.locale} · {context.familiarity === 'first_time' ? 'first-time' : 'experienced'} · {context.interaction === 'pointer' ? 'pointer' : 'keyboard only'} · network {context.network.mode === 'normal' ? 'normal' : `+${context.network.delayMs}ms on ${context.network.pathPrefix}`} · revision {context.revision}</p>
            : !contexts.loading && !loadErr && <p className="muted">No context packs yet. <Link href="/contexts">Create one</Link>.</p>}
        </section>
      </div>
      {inputProblem && <div className="note bad" role="alert">This pair cannot run: {inputProblem}. Edit the context pack inputs.</div>}
      <ErrorNote error={error} />
      <button type="button" onClick={start} disabled={!scenario || !context || starting || !!inputProblem}>
        <Play size={14} aria-hidden /> {starting ? 'Starting…' : 'Launch run'}
      </button>

      <section className="panel" style={{ marginTop: '1.5rem' }}>
        <h2>Recent runs</h2>
        {runs.error && <ErrorNote error={runs.error} onRetry={runs.reload} />}
        {!runs.error && runs.data?.length === 0 && <p className="muted">No runs recorded yet.</p>}
        {!!runs.data?.length && <RunsTable runs={runs.data.slice(0, 5)} />}
      </section>
      <section className="panel muted"><strong>Repair suggestions</strong> — forthcoming. Not available yet; nothing here is generated.</section>
    </>
  );
}

export function RunsTable({ runs }: { runs: Awaited<ReturnType<typeof api.runs>> }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Run</th><th>Scenario · rev</th><th>Context · rev</th><th>Status</th><th>Verdict</th><th>Created</th></tr></thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.id}>
              <td><Link href={`/runs/${encodeURIComponent(r.id)}`} className="mono">{r.id.slice(0, 12)}</Link></td>
              <td>{r.scenario.label} · {r.scenario.revision}</td><td>{r.context.label} · {r.context.revision}</td>
              <td><StatusBadge value={r.status} /></td><td><StatusBadge value={r.verdict} /></td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
