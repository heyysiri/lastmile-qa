'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RunRecord } from '@lastmile/contracts';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import { ReplayLauncher } from './ReplayLauncher';
import { InvestigationPanel } from './InvestigationPanel';
import { ApiFailure, api } from '../lib/api';
import { formatLocator } from '../lib/editor';
import { ErrorNote, Pending, StatusBadge } from './ui';

const active = (r: RunRecord) => r.status === 'queued' || r.status === 'running';
const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

export function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<EvidenceRun | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [artifacts, setArtifacts] = useState<unknown[] | null>(null);
  const [artErr, setArtErr] = useState<ApiFailure | null>(null);

  useEffect(() => {
    setRun(null); setError(null);
    let stop = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api.run(id);
        if (stop) return;
        setRun(r); setError(null);
        if (active(r)) timer = setTimeout(() => void tick(), 2000);
      } catch (e) {
        if (stop) return;
        setError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e)));
        if (!(e instanceof ApiFailure && e.status === 404)) timer = setTimeout(() => void tick(), 4000);
      }
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);

  const finished = run && !active(run);
  useEffect(() => {
    let stop = false;
    setArtifacts(null); setArtErr(null);
    if (!finished) return;
    if (run.artifacts.length === 0) { setArtifacts([]); return; }
    api.artifacts(id).then(a => { if (!stop) setArtifacts(a); }).catch(e => { if (!stop) setArtErr(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e))); });
    return () => { stop = true; };
  }, [finished, id, run]);

  if (!run) return <>
    <p><Link href="/runs">← Run history</Link></p>
    {error ? <ErrorNote error={error} /> : <Pending label="Loading run…" />}
  </>;

  const evaluated = (a: RunRecord['assertions'][number]) => {
    const def = run.scenario.contract.assertions.find(x => x.id === a.id);
    const what = !def ? '' : 'locator' in def ? `${def.kind} ${formatLocator(def.locator)}` : `${def.kind} ${def.path}`;
    return what;
  };

  return (
    <>
      <p><Link href="/runs">← Run history</Link></p>
      <h1>{run.scenario.label}</h1>
      <p className="row">
        <StatusBadge value={run.status} /> <StatusBadge value={run.verdict} />
        <span className="badge">{run.executionMode === 'ai_guided' ? 'AI-guided' : 'deterministic'}</span>
        <span className="muted">Scenario rev {run.scenario.revision} · {run.context.label} rev {run.context.revision} · <span className="mono">{run.id}</span></span>
      </p>
      {active(run) && <Pending label={run.status === 'queued' ? 'Queued — waiting for the runner to pick this up.' : 'Running — updating every 2 seconds.'} />}
      {error && <ErrorNote error={error} />}
      {run.status === 'interrupted' && <div className="note warn">This run was interrupted before it finished. No verdict is claimed.</div>}

      {run.evidence && <p className="muted">Model: {run.evidence.model} · Model calls: {run.evidence.modelCalls} · Build: <span className="mono">{run.evidence.buildId.slice(0,12)}</span> · Verification scope: {run.scenario.contract.scope}</p>}
      {run.verdict === 'passed' && run.evidence?.finishedByAgent && !run.evidence.replayHash && <ReplayLauncher run={run}/>}
      {run.verdict === 'inconclusive' && <p className="muted">To corroborate this outcome, open a passing AI-guided run of the same scenario and replay its path under this context.</p>}
      {run.verdict === 'failed' && run.evidence && <InvestigationPanel run={run}/>}
      <section className="panel"><h2>Assertions</h2>
        {run.assertions.length === 0 ? <p className="muted">No assertion results recorded.</p> : (
          <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Check</th><th>Result</th><th>Expected</th><th>Actual</th></tr></thead><tbody>
            {run.assertions.map(a => (
              <tr key={a.id}><td><span className="mono">{a.id}</span><br /><span className="muted">{evaluated(a)}</span></td>
                <td><span className={`badge ${a.status === 'passed' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'}`}>{a.status.replace('_', ' ')}</span></td>
                <td className="mono">{show(a.expected)}</td><td className="mono">{show(a.actual)}{a.message ? <><br /><span className="muted">{a.message}</span></> : null}</td></tr>
            ))}
          </tbody></table></div>)}
      </section>

      <section className="panel"><h2>Findings</h2>
        {run.findings.length === 0 ? <p className="muted">{finished ? 'No findings recorded.' : 'None yet.'}</p> : (
          <ul className="list">{run.findings.map((f, i) => (
            <li key={i} className="note" style={{ marginBottom: 0 }}><span className="badge warn">{f.kind.replace(/_/g, ' ')}</span> {f.description}
              {f.evidencePaths.length > 0 && <div className="mono muted">Evidence: {f.evidencePaths.join(', ')}</div>}</li>))}</ul>)}
      </section>

      <section className="panel"><h2>Steps</h2>
        {run.steps.length === 0 ? <p className="muted">No steps recorded yet.</p> : (
          <ol style={{ paddingLeft: '1.2rem' }}>{run.steps.map(s => (
            <li key={s.index} style={{ marginBottom: '.6rem' }}><strong>{s.action}</strong>
              <div className="muted">{s.observation}</div>
              <div className="mono muted">{new Date(s.timestamp).toLocaleTimeString()}{s.screenshot ? ` · screenshot ${s.screenshot}` : ''}</div></li>))}</ol>)}
      </section>

      <section className="panel"><h2>Capabilities applied</h2>
        {run.capabilities.length === 0 ? <p className="muted">Not recorded.</p> : (
          <table><thead><tr><th>Factor</th><th>Status</th><th>Value</th></tr></thead><tbody>
            {run.capabilities.map(c => <tr key={c.factor}><td>{c.factor}</td>
              <td><span className={`badge ${c.status === 'applied' ? 'ok' : c.status === 'unsupported' ? 'bad' : 'warn'}`}>{c.status.replace('_', ' ')}</span></td>
              <td className="mono">{show(c.value)}</td></tr>)}</tbody></table>)}
      </section>

      <section className="panel"><h2>Artifacts</h2>
        {artErr && <ErrorNote error={artErr} />}
        {!finished && <p className="muted">Available once the run finishes.</p>}
        {finished && artifacts && artifacts.length === 0 && <p className="muted">The runner stored no artifacts for this run.</p>}
        {run.artifacts.length > 0 && <p className="mono muted">Manifest: {run.artifacts.join(', ')}</p>}
        {!!artifacts?.length && <ul>{artifacts.filter((a): a is string => typeof a === 'string').map(path => <li key={path}><a href={`/api/runner/runs/${run.id}/artifacts/${encodeURIComponent(path.split('/').at(-1)!)}`} target="_blank" rel="noreferrer">{path.split('/').at(-1)}</a></li>)}</ul>}
      </section>
      <section className="panel muted"><strong>Repair suggestions</strong> — forthcoming. Not available yet.</section>
    </>
  );
}
