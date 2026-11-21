'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CircleCheck, Clock3, GitCompareArrows } from 'lucide-react';
import type { PopulationExecutionDetail, ReleaseComparison, PopulationTester } from '@lastmile/contracts/populations';
import type { EvidenceRun } from '@lastmile/contracts/runtime';
import { api, ApiFailure, useLoad } from '../lib/api';
import { isActive, populationExecutionHref, populationHref } from '../lib/populations';
import { ApplicationProvenance } from './ApplicationProvenance';
import { fieldName, RunChecks, RunScreenshot, RunSteps } from './RunEvidence';
import { StudioBack, StudioError, TesterFace } from './Studio';
import { Pending } from './ui';

const comparisonLabels = {
  still_passing: 'Still passing',
  regression: 'Regression',
  inconclusive: 'Inconclusive',
};

export function PopulationResults({ populationId, executionId }: { populationId: string; executionId: string }) {
  const [execution, setExecution] = useState<PopulationExecutionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const current = await api.populationExecution(executionId);
        if (stopped) return;
        if (current.populationId !== populationId) throw new ApiFailure(404, 'not_found', 'This execution belongs to a different population.');
        setExecution(current);
        setError(null);
        if (isActive(current.status)) timer = setTimeout(poll, 1500);
      } catch (problem) {
        if (stopped) return;
        setError(problem);
        if (!(problem instanceof ApiFailure && problem.status === 404)) timer = setTimeout(poll, 4000);
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [executionId, populationId, attempt]);

  const active = Boolean(execution && isActive(execution.status));
  const checkpoint = execution?.mode === 'checkpoint';
  const runs = execution?.members.map(member => execution.runs.find(run => run.id === member.runId)) ?? [];
  const finished = runs.filter(run => run && !isActive(run.status)).length;

  return <div className="studio population-studio">
    <StudioBack href={populationHref(populationId)}>Population</StudioBack>
    <StudioError error={error} onRetry={() => setAttempt(value => value + 1)} />
    {!execution && !error && <Pending label="Loading release execution…" />}
    {execution && <>
      <header className="studio-heading review-heading">
        <div>
          <h1>{execution.releaseLabel}</h1>
          <p>{execution.population.label} · {checkpoint ? 'Checkpoint replay · no model calls' : 'Continuing journeys · AI-guided'}</p>
        </div>
        <span role="status" className={`pill pill-${active ? 'lilac' : execution.status === 'interrupted' ? 'peach' : 'mint'}`}>
          {active ? <Clock3 size={15} aria-hidden="true" /> : execution.status === 'completed' ? <CircleCheck size={15} aria-hidden="true" /> : null}{fieldName(execution.status)}
        </span>
      </header>
      <section className="studio-card execution-overview" aria-label="Release and progress">
        <div className="progress-title" aria-live="polite">
          <strong>{finished} of {execution.members.length} finished</strong>
          {active && <span className="muted">{error ? 'Reconnecting…' : 'Updating live'}</span>}
        </div>
        <progress aria-label="Testers finished" value={finished} max={execution.members.length} />
        <div className="release-builds">
          {execution.baselineExecutionId && <BaselineBuild populationId={populationId} id={execution.baselineExecutionId} />}
          <div><small>{checkpoint ? 'Candidate build' : 'App build'}</small><code>{execution.buildId}</code></div>
        </div>
        {checkpoint && <div className="outcome-summary">
          {(Object.keys(comparisonLabels) as ReleaseComparison['outcome'][]).map((outcome, index) =>
            <span key={outcome} className={`pill pill-${['mint', 'peach', 'lilac'][index]}`}>{execution.comparisons?.filter(comparison => comparison.outcome === outcome).length ?? 0} {comparisonLabels[outcome].toLowerCase()}</span>)}
        </div>}
        {execution.status === 'interrupted' && <p className="muted">Execution interrupted. Any evidence recorded before the interruption is shown below.</p>}
      </section>
      <div className="result-grid">
        {execution.population.testers.map((tester, index) => {
          const member = execution.members.find(item => item.testerId === tester.id);
          return <PopulationTesterResult key={tester.id} tester={tester} index={index} run={runs.find(run => run?.id === member?.runId)}
            comparison={execution.comparisons?.find(comparison => comparison.testerId === tester.id)} active={active} />;
        })}
      </div>
      <ApplicationProvenance context={execution.applicationContext} recorded />
    </>}
  </div>;
}

function BaselineBuild({ populationId, id }: { populationId: string; id: string }) {
  const baseline = useLoad(() => api.populationExecution(id), [id]);
  const verified = baseline.data?.populationId === populationId ? baseline.data : null;
  return <div>
    <small><GitCompareArrows size={14} aria-hidden="true" /> Baseline build</small>
    <Link href={populationExecutionHref(populationId, id)}>{verified?.releaseLabel ?? 'View baseline execution'}</Link>
    {verified && <code>{verified.buildId}</code>}
    {baseline.error && <button className="text-button" type="button" onClick={baseline.reload}>Retry baseline details</button>}
  </div>;
}

function PopulationTesterResult({ tester, index, run, comparison, active }: {
  tester: PopulationTester; index: number; run?: EvidenceRun; comparison?: ReleaseComparison; active: boolean;
}) {
  const verdict = run?.verdict;
  const status = comparison ? comparisonLabels[comparison.outcome]
    : verdict === 'passed' ? 'Task achieved' : verdict === 'failed' ? 'Outcome mismatch' : verdict === 'inconclusive' ? 'Inconclusive'
    : run ? fieldName(run.status) : active ? 'Queued' : 'No verdict';
  const tone = comparison ? comparison.outcome === 'still_passing' ? 'mint' : comparison.outcome === 'regression' ? 'peach' : 'lilac'
    : verdict === 'passed' ? 'mint' : verdict === 'failed' ? 'peach' : 'lilac';

  return <article className={`studio-card result-card tone-${index % 3}`} aria-labelledby={`result-${tester.id}`}>
    <header className="tester-heading"><TesterFace index={index} />
      <div><h2 id={`result-${tester.id}`}>{tester.profile.name}</h2><p>Tester ID · <code>{tester.id}</code></p></div>
    </header>
    <div className="result-status"><span className={`pill pill-${tone}`}>{status}</span>{run?.evidence && <span className="muted">{run.evidence.modelCalls} model {run.evidence.modelCalls === 1 ? 'call' : 'calls'}</span>}</div>
    {comparison && <p className={`comparison-reason comparison-${comparison.outcome}`}>{comparison.message}</p>}
    {run && <>
      <RunScreenshot run={run} />
      <h3>Goal</h3><p>{run.scenario.goal}</p>
      {run.findings.map((finding, index) => <p className="finding-note" key={index}>{finding.description}</p>)}
      <h3>Outcome checks</h3><RunChecks run={run} />
      <RunSteps run={run} />
      {run.continuity?.startCheckpoint && <p className="field-hint">Starting checkpoint <code>{run.continuity.startCheckpoint.id}</code></p>}
    </>}
    <div className="population-evidence-links">
      {run && <Link href={`/runs/${encodeURIComponent(run.id)}`} className="evidence-link">Full run evidence <ArrowUpRight size={15} aria-hidden="true" /></Link>}
      {comparison && <Link href={`/runs/${encodeURIComponent(comparison.baselineRunId)}`} className="evidence-link">Baseline run evidence <ArrowUpRight size={15} aria-hidden="true" /></Link>}
    </div>
  </article>;
}
