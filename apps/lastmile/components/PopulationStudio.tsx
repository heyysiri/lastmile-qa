'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, History, UsersRound } from 'lucide-react';
import type { PopulationEpisode, PopulationTester } from '@lastmile/contracts/populations';
import { api, useLoad } from '../lib/api';
import { isActive, populationExecutionHref } from '../lib/populations';
import { ApplicationProvenance } from './ApplicationProvenance';
import { PopulationLaunch } from './PopulationLaunch';
import { fieldName, RunSteps } from './RunEvidence';
import { plural, StudioBack, StudioError, studyHref, TesterFace } from './Studio';
import { Pending, StatusBadge } from './ui';

export function PopulationStudio({ id }: { id: string }) {
  const population = useLoad(() => api.population(id), [id]);
  const executions = useLoad(api.populationExecutions);
  const catalog = useLoad(api.applications);
  const health = useLoad(api.health);
  const details = population.data;
  const history = (executions.data ?? []).filter(execution => execution.populationId === id);
  const active = history.find(execution => isActive(execution.status));
  const activeId = active?.id;
  const previousActive = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (previousActive.current && !activeId) void population.reload();
    previousActive.current = activeId;
    if (!activeId || executions.loading) return;
    const timer = setTimeout(() => void executions.reload(), 2500);
    return () => clearTimeout(timer);
  }, [activeId, executions.loading, executions.reload, population.reload]);

  function refresh() {
    void population.reload();
    void executions.reload();
  }

  const application = catalog.data?.find(app => app.id === details?.applicationId && app.origin === details.origin);
  return <div className="studio population-studio">
    <StudioBack href="/populations">Populations</StudioBack>
    <StudioError error={population.error ?? executions.error} onRetry={refresh} />
    {(population.loading || executions.loading) && (!details || !executions.data) && <Pending label="Loading population…" />}
    {details && <>
      <header className="studio-heading review-heading">
        <div><h1>{details.label}</h1><p>{application?.name ?? details.applicationId} · {plural(details.testers.length, 'persistent tester')}</p></div>
        <Link className="pill pill-mint" href={studyHref(details.studyId)}>Saved study · revision {details.studyRevision}<ArrowUpRight size={14} aria-hidden="true" /></Link>
      </header>
      <section aria-labelledby="population-accounts">
        <div className="section-heading"><UsersRound size={20} aria-hidden="true" /><h2 id="population-accounts">Tester accounts</h2></div>
        <div className="result-grid">
          {details.testers.map((tester, index) => <AccountCard key={tester.id} tester={tester} index={index}
            episodes={details.episodes.filter(episode => episode.testerId === tester.id && episode.run.continuity?.mode !== 'checkpoint')} populationId={id} />)}
        </div>
      </section>
      <StudioError error={catalog.error} onRetry={catalog.reload} />
      <StudioError error={health.error} onRetry={health.reload} />
      {!catalog.loading && !catalog.error && !application && <p className="note warn">The application connection or origin has changed. Restore the enrolled connection to start another execution.</p>}
      {catalog.data && <PopulationLaunch population={details} workflows={application?.workflows ?? []} executions={history}
        active={active} canLaunch={Boolean(application && !catalog.error && !population.error && !population.loading && executions.data && !executions.loading && !executions.error)}
        health={health.error ? null : health.data} refresh={refresh} />}
      <section className="studio-card" aria-labelledby="population-history">
        <div className="card-heading"><span className="icon-tile"><History size={18} aria-hidden="true" /></span><h2 id="population-history">Release executions</h2></div>
        {executions.data && !history.length && <p className="empty-state">Your first continuation will appear here once it’s queued.</p>}
        <ul className="studio-list">
          {history.map(execution => <li key={execution.id}>
            <Link href={populationExecutionHref(id, execution.id)}>
              <span><strong>{execution.releaseLabel}</strong><small>{execution.mode === 'continue' ? 'Continuing journeys' : 'Checkpoint comparison'} · {execution.buildId} · {new Date(execution.createdAt).toLocaleString()}</small></span>
              <StatusBadge value={execution.status} /><ArrowRight size={17} aria-hidden="true" />
            </Link>
          </li>)}
        </ul>
      </section>
      <CurrentApplicationContext applicationId={details.applicationId} />
    </>}
  </div>;
}

function CurrentApplicationContext({ applicationId }: { applicationId: string }) {
  const { data, loading, error, reload } = useLoad(() => api.applicationContext(applicationId), [applicationId]);
  return <ApplicationProvenance context={data} loading={loading} error={error} onRetry={reload} />;
}

function AccountCard({ tester, index, episodes, populationId }: {
  tester: PopulationTester; index: number; episodes: PopulationEpisode[]; populationId: string;
}) {
  const { profile } = tester;
  return <article className={`studio-card result-card tone-${index % 3}`} aria-labelledby={`account-${tester.id}`}>
    <header className="tester-heading"><TesterFace index={index} />
      <div><h3 id={`account-${tester.id}`}>{profile.name}</h3><p>Tester ID · <code>{tester.id}</code></p></div>
    </header>
    <p>{profile.summary}</p>
    <details className="studio-disclosure">
      <summary>Fixed tester profile</summary>
      <p>{profile.coverageReason}</p>
      <p className="field-hint">Starting fixture <code>{tester.initialStateId}</code> · {fieldName(profile.context.interaction)} · {profile.context.viewport.width} × {profile.context.viewport.height} · {profile.context.locale}</p>
      {profile.assumptions.length > 0 && <ul>{profile.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>}
    </details>
    <details className="studio-disclosure">
      <summary>Observed history <span className="badge">{episodes.length}</span></summary>
      {episodes.length === 0 && <p className="muted">No journeys recorded yet.</p>}
      <ol className="population-episodes">
        {[...episodes].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)).map(({ executionId, releaseLabel, run }) => {
          const observation = run.steps.findLast(step => step.observation.trim())?.observation;
          return <li key={run.id}>
            <Link href={populationExecutionHref(populationId, executionId)}>{releaseLabel}</Link> <StatusBadge value={run.verdict ?? run.status} />
            <small>{new Date(run.createdAt).toLocaleString()} · {run.evidence?.buildId ?? run.expectedBuildId ?? 'Build unavailable'}</small>
            <strong>{run.scenario.goal}</strong>
            <p>{observation || 'No visible observation was recorded.'}</p>
            <RunSteps run={run} />
            <Link href={`/runs/${encodeURIComponent(run.id)}`}>Full run evidence</Link>
          </li>;
        })}
      </ol>
    </details>
  </article>;
}
