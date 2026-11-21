'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RunRecord } from '@lastmile/contracts';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import { ReplayLauncher } from './ReplayLauncher';
import { InvestigationPanel } from './InvestigationPanel';
import { ApiFailure, api } from '../lib/api';
import { populationHref } from '../lib/populations';
import { artifactHref, displayValue, fieldName, RunChecks, RunScreenshot, RunSteps } from './RunEvidence';
import { StudioBack, StudioError } from './Studio';
import { Pending, StatusBadge } from './ui';

const active = (run: RunRecord) => run.status === 'queued' || run.status === 'running';

export function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<EvidenceRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [artifacts, setArtifacts] = useState<unknown[] | null>(null);
  const [artErr, setArtErr] = useState<unknown>(null);

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
        setError(e);
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
    api.artifacts(id).then(items => { if (!stop) setArtifacts(items); }).catch(e => { if (!stop) setArtErr(e); });
    return () => { stop = true; };
  }, [finished, id, run]);

  return <div className="studio">
    <StudioBack href="/runs">Individual runs</StudioBack>
    <StudioError error={error} />
    {!run && !error && <Pending label="Loading run…" />}
    {run && <>
      <header className="studio-heading review-heading">
        <div><h1>{run.scenario.label}</h1><p>{run.context.label} · {run.executionMode === 'ai_guided' ? 'AI-guided' : 'Deterministic'}</p></div>
        <div className="row"><StatusBadge value={run.status} /><StatusBadge value={run.verdict} /></div>
      </header>
      {active(run) && <Pending label={run.status === 'queued' ? 'Queued for the runner.' : 'Running, with updates every two seconds.'} />}
      {run.status === 'interrupted' && <p className="note warn">This run was interrupted before it could reach a verdict.</p>}

      <section className="studio-card detail-evidence">
        <RunScreenshot run={run} />
        <h2>Findings</h2>
        {run.findings.length === 0 ? <p className="muted">{finished ? 'No findings recorded.' : 'Waiting for findings.'}</p> :
          <ul className="finding-list">{run.findings.map((finding, i) => <li key={i}>
            <strong>{fieldName(finding.kind)}</strong><p>{finding.description}</p>
            {finding.evidencePaths.filter(path => run.artifacts.includes(path)).map(path => <a href={artifactHref(run.id, path)} key={path}>{path.split('/').at(-1)}</a>)}
          </li>)}</ul>}
        <h2>Outcome checks</h2>
        <RunChecks run={run} />
        <RunSteps run={run} />
      </section>

      {run.continuity ? <p className="note">
        Compare releases from the population’s checkpoint controls. <Link href={populationHref(run.continuity.populationId)}>Open population</Link>
      </p> : <>
        {run.verdict === 'passed' && run.evidence?.finishedByAgent && !run.evidence.replayHash && <ReplayLauncher run={run} />}
        {run.verdict === 'inconclusive' && <p className="muted">To corroborate this outcome, open a passing AI-guided run of the same scenario and replay its path under this context.</p>}
        {run.verdict === 'failed' && run.evidence && <InvestigationPanel run={run} />}
      </>}

      <details className="studio-card studio-disclosure technical-details">
        <summary>Configuration and run metadata</summary>
        <p className="muted">Scenario revision {run.scenario.revision} · Context revision {run.context.revision} · Run <span className="mono">{run.id}</span></p>
        {run.evidence && <p className="muted">Model {run.evidence.model} · {run.evidence.modelCalls} model calls · Build <span className="mono">{run.evidence.buildId.slice(0, 12)}</span> · Verification scope {fieldName(run.scenario.contract.scope)}</p>}
        <h3>Capabilities applied</h3>
        {run.capabilities.length === 0 ? <p className="muted">No capabilities recorded.</p> :
          <div className="scroll-table"><table><thead><tr><th>Factor</th><th>Status</th><th>Value</th></tr></thead><tbody>
            {run.capabilities.map(item => <tr key={item.factor}><td>{fieldName(item.factor)}</td><td>{fieldName(item.status)}</td><td className="mono">{displayValue(item.value)}</td></tr>)}
          </tbody></table></div>}
      </details>
      <details className="studio-card studio-disclosure technical-details">
        <summary>Raw artifacts</summary>
        <StudioError error={artErr} />
        {!finished && <p className="muted">Available once the run finishes.</p>}
        {finished && artifacts?.length === 0 && <p className="muted">The runner stored no artifacts for this run.</p>}
        {!!artifacts?.length && <ul>{artifacts.filter((item): item is string => typeof item === 'string').map(path => <li key={path}><a href={artifactHref(run.id, path)} target="_blank" rel="noreferrer">{path.split('/').at(-1)}</a></li>)}</ul>}
      </details>
    </>}
  </div>;
}
