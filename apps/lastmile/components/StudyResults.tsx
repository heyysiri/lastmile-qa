'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Camera, CircleCheck, Clock3 } from 'lucide-react';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import type { StudyExecutionDetail, StudyUser } from '@lastmile/contracts/studies';
import { ApiFailure, api } from '../lib/api';
import { displayValue, fieldName, RunChecks, RunScreenshot, RunSteps } from './RunEvidence';
import { plural, StudioBack, StudioError, studyHref, TesterFace } from './Studio';
import { Pending } from './ui';

const statusLabel = { queued: 'Queued', running: 'Running', completed: 'Completed', interrupted: 'Interrupted' } as const;

export function StudyResults({ studyId, executionId }: { studyId: string; executionId: string }) {
  const [execution, setExecution] = useState<StudyExecutionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api.execution(executionId);
        if (stopped) return;
        if (result.studyId !== studyId) throw new ApiFailure(404, 'not_found', 'This execution belongs to a different study.');
        setExecution(result);
        setError(null);
        if (result.status === 'queued' || result.status === 'running') timer = setTimeout(poll, 1500);
      } catch (problem) {
        if (stopped) return;
        setError(problem);
        if (!(problem instanceof ApiFailure && problem.status === 404)) timer = setTimeout(poll, 4000);
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [studyId, executionId, attempt]);

  const current = execution?.id === executionId && execution.studyId === studyId ? execution : null;
  const memberRuns = current?.study.users.map(user => {
    const member = current.members.find(item => item.userId === user.id);
    return current.runs.find(run => run.id === member?.runId);
  }) ?? [];
  const complete = memberRuns.filter(run => run?.status === 'completed' || run?.status === 'interrupted').length;
  const countVerdict = (verdict: EvidenceRun['verdict']) => memberRuns.filter(run => run?.status === 'completed' && run.verdict === verdict).length;
  const active = current?.status === 'queued' || current?.status === 'running';
  return <div className="studio">
    <StudioBack href={studyHref(studyId)}>Study draft</StudioBack>
    <StudioError error={error} onRetry={() => setAttempt(value => value + 1)} />
    {!current && !error && <Pending label="Loading study execution…" />}
    {current && <>
      <header className="studio-heading review-heading">
        <div><h1>{current.study.title}</h1><p>Study execution · revision {current.studyRevision} · {new Date(current.createdAt).toLocaleString()}</p></div>
        <span className={`pill pill-${current.status === 'completed' ? 'mint' : current.status === 'interrupted' ? 'peach' : 'lilac'}`} role="status">
          {active ? <Clock3 size={15} aria-hidden="true" /> : <CircleCheck size={15} aria-hidden="true" />}{statusLabel[current.status]}
        </span>
      </header>
      <section className="studio-card execution-overview" aria-label="Execution summary">
        <div className="progress-title" aria-live="polite">
          <strong>{complete} of {current.study.users.length} finished</strong>
          {active && <span className="muted">{error ? 'Reconnecting…' : 'Updating live'}</span>}
        </div>
        <progress aria-label="Testers finished" value={complete} max={current.study.users.length} />
        <div className="outcome-summary">
          <span className="pill pill-mint">{countVerdict('passed')} task achieved</span>
          <span className="pill pill-peach">{countVerdict('failed')} outcome mismatch</span>
          <span className="pill pill-lilac">{countVerdict('inconclusive')} inconclusive</span>
        </div>
        {current.status === 'interrupted' && <p className="muted">This execution was interrupted. Completed tester evidence is shown below.</p>}
      </section>
      <div className="result-grid">
        {current.study.users.map((user, index) => <TesterResult key={user.id} user={user} index={index} run={memberRuns[index]} executionActive={active} />)}
      </div>
    </>}
  </div>;
}

function TesterResult({ user, index, run, executionActive }: { user: StudyUser; index: number; run?: EvidenceRun; executionActive: boolean }) {
  const verdict = run?.status === 'completed' ? run.verdict : null;
  const outcome = verdict === 'passed' ? 'Task achieved' : verdict === 'failed' ? 'Outcome mismatch' : verdict === 'inconclusive' ? 'Inconclusive'
    : run && run.status !== 'completed' ? statusLabel[run.status] : executionActive ? 'Queued' : 'No verdict';
  const tone = verdict === 'passed' ? 'mint' : verdict === 'failed' ? 'peach' : 'lilac';
  const screenshot = run?.artifacts.some(path => /\.png$/i.test(path));
  return <article className={`studio-card result-card tone-${index % 3}`} aria-labelledby={`result-${user.id}`}>
    <header className="tester-heading">
      <TesterFace index={index} />
      <div><h2 id={`result-${user.id}`}>{user.name}</h2><p>{user.context.familiarity === 'first_time' ? 'First-time user' : 'Experienced user'} · {user.context.viewport.width} × {user.context.viewport.height}</p></div>
    </header>
    <div className="result-status"><span className={`pill pill-${tone}`}>{outcome}</span><span className="muted">{plural(run?.steps.length ?? 0, 'step')}</span></div>
    {run && screenshot ? <RunScreenshot run={run} /> : <p className="screenshot-state"><Camera size={16} aria-hidden="true" />{executionActive && (!run || run.status === 'queued' || run.status === 'running') ? 'Waiting for screenshot evidence' : 'No screenshot recorded'}</p>}
    <h3>Goal</h3><p>{user.goal}</p>
    {verdict === 'passed' && <p className="muted">The recorded journey met the configured checks.</p>}
    {verdict === 'failed' && <p className="muted">The verifier observed a result that differed from the task requirements.</p>}
    {verdict === 'inconclusive' && <p className="muted">An agent or environment issue left too little evidence to determine the outcome.</p>}
    {run?.findings.map((finding, i) => <p className="finding-note" key={i}>{finding.description}</p>)}
    {run && run.assertions.length > 0 && <section aria-label="Outcome checks"><h3>Outcome checks</h3><RunChecks run={run} /></section>}
    {run && <RunSteps run={run} />}
    <details className="studio-disclosure snapshot">
      <summary>Tester snapshot</summary>
      <p>{user.summary}</p><p>{user.coverageReason}</p>
      <dl>
        <dt>Interaction</dt><dd>{fieldName(user.context.interaction)}</dd>
        <dt>Browser locale</dt><dd>{user.context.locale}</dd>
        <dt>Preferred language</dt><dd>{user.context.preferredLanguage}</dd>
        <dt>Motion</dt><dd>{fieldName(user.context.reducedMotion)}</dd>
        <dt>Network</dt><dd>{user.context.network.mode === 'normal' ? 'Normal' : `+${user.context.network.delayMs} ms on ${user.context.network.pathPrefix}`}</dd>
        {user.context.knownTerms.length > 0 && <><dt>Known terms</dt><dd>{user.context.knownTerms.join(', ')}</dd></>}
        {Object.entries(run?.inputs ?? user.context.inputs).map(([label, value]) => <div className="snapshot-pair" key={label}><dt>{fieldName(label)}</dt><dd>{displayValue(value)}</dd></div>)}
      </dl>
      {user.assumptions.length > 0 && <><h4>Assumptions</h4><ul>{user.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
    </details>
    {run && <Link className="evidence-link" href={`/runs/${encodeURIComponent(run.id)}`}>Full run evidence <ArrowUpRight size={15} aria-hidden="true" /></Link>}
  </article>;
}
