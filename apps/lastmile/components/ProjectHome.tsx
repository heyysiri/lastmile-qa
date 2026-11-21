'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Play, RotateCw } from 'lucide-react';
import { ProjectRunRequestSchema, type ProjectDetail, type ProjectRun } from '@lastmile/contracts/projects';
import { api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { useJobPolling } from '../lib/evolution';
import { isActive, usePendingWrite } from '../lib/populations';
import { projectHref, projectRefreshRequest, projectRunHref } from '../lib/projects';
import { MeasuredResults, RunFindings, SourceCitations, TesterAccount } from './ProjectEvidence';
import { ProjectRepairAction } from './ProjectRepairReview';
import { StudioBack, StudioError, TesterFace } from './Studio';
import { Pending } from './ui';

export function ProjectHome({ id }: { id: string }) {
  const detail = useLoad(() => api.project(id), [id]);
  const health = useLoad(api.health);
  const project = detail.data;
  const runs = [...(project?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.find(run => isActive(run.status));
  const latest = runs.find(run => !isActive(run.status));
  const hasCompleted = runs.some(run => run.status === 'completed');
  const write = usePendingWrite(`lastmile-pending-project-run-${id}`, ProjectRunRequestSchema,
    request => api.runProject(id, request),
    (_, run) => detail.setData(previous => previous && { ...previous, runs: [run, ...previous.runs.filter(item => item.id !== run.id)] }),
    () => { void detail.reload(); }, true);
  const refresh = usePendingWrite(`lastmile-pending-project-refresh-${id}`, projectRefreshRequest,
    request => api.refreshProject(id, request),
    (_, updated) => detail.setData(previous => previous && { ...previous, ...updated }),
    () => { void detail.reload(); }, true);
  const accepted = Boolean(write.pending && runs.some(run => run.request.requestId === write.pending?.requestId));
  const resolveRun = write.resolve;
  useEffect(() => {
    if (accepted && !write.busy) resolveRun();
  }, [accepted, resolveRun, write.busy]);

  useJobPolling(Boolean(active || project?.status === 'discovering') && detail.error?.status !== 404, detail.loading, detail.reload);

  const plan = project?.discovery?.plan;
  const discoveryReady = health.data?.projectDiscoveryReady === true && !health.error;
  const executionReady = health.data?.projectExecutionReady === true && !health.error;
  const requestInFlight = write.busy || refresh.busy;
  const canRun = project?.status === 'ready' && executionReady && (hasCompleted ? discoveryReady : true);
  const canRefresh = Boolean(project && project.status !== 'discovering' && discoveryReady);

  function runButton(recovering = false) {
    if (!recovering && write.pending) return null;
    return <button type="button"
      disabled={!write.ready || requestInFlight || Boolean(refresh.pending) || detail.loading || Boolean(detail.error) || (!recovering && !canRun)}
      onClick={() => void write.submit({ requestId: newRequestId(), mode: hasCompleted ? 'release' : 'explore' })}>
      <Play size={16} aria-hidden="true" />
      {write.busy ? 'Starting team…' : recovering ? 'Recover run request' : hasCompleted ? 'Test changes' : 'Run test team'}
    </button>;
  }

  function refreshButton() {
    return <button type="button" className="secondary"
      disabled={!refresh.ready || requestInFlight || Boolean(write.pending) || detail.loading || Boolean(detail.error) || (!refresh.pending && !canRefresh)}
      onClick={() => void refresh.submit({ requestId: newRequestId() })}>
      <RotateCw size={15} aria-hidden="true" />
      {refresh.busy ? 'Refreshing…' : refresh.pending ? 'Recover refresh request' : 'Refresh understanding'}
    </button>;
  }

  return <div className="studio project-studio">
    <StudioBack href="/">Projects</StudioBack>
    <StudioError error={detail.error} onRetry={detail.reload} />
    {!project && !detail.error && <Pending label="Loading project…" />}
    {project && <>
      <header className="studio-heading project-page-heading project-heading-with-action">
        <div><h1>{project.name}</h1><p>{project.appUrl}</p></div>
        {!active && project.status === 'ready' && runButton()}
      </header>
      {project.status === 'discovering' && <div className="project-progress"><Pending label={project.progress || 'Discovery queued'} /></div>}
      {project.status === 'failed' && <div className="project-progress">
        <h2>Discovery needs attention</h2>
        <p>{project.error || project.progress || 'Discovery ended before the project was ready.'}</p>
      </div>}
      {active && <TeamProgress run={active} />}
      {(write.pending && !accepted || refresh.pending) && <div className="project-progress">
        {write.pending && !accepted && runButton(true)}
        {refresh.pending && refreshButton()}
      </div>}
      <StudioError error={write.error} />
      <StudioError error={refresh.error} />
      {project.status === 'ready' && !active && !write.pending && !health.loading && !canRun && <p className="note warn">
        {executionReady ? 'Enable project discovery on the runner to test changes against refreshed source.' : 'Enable project execution on the runner to run the test team.'}
      </p>}
      {latest && <RunFindings run={latest} project={project}
        detailLink={<Link className="project-report-link" href={projectRunHref(id, latest.id)}>Shareable results</Link>}
        actions={<ProjectRepairAction project={project} run={latest} />} />}
      {plan && project.status === 'ready' && <section className="project-team" aria-labelledby="team-heading">
        <div className="project-section-heading"><h2 id="team-heading">Your test team</h2></div>
        <div className="project-team-roster">{plan.testers.map((tester, i) => <article key={tester.id}>
          <TesterFace index={i} />
          <div><h3>{tester.name}</h3><p>{tester.role}</p><small><TesterAccount tester={tester} accounts={project.accounts} /></small></div>
        </article>)}</div>
        <div className="project-understanding">
          <div className="project-section-heading"><h2>What the team found in the app</h2></div>
          <ul className="project-feature-list">{plan.features.map(feature => <li key={feature.id}>{feature.title}</li>)}</ul>
          <details className="project-disclosure">
            <summary>Review generated journeys</summary>
            <p>{plan.summary}</p>
            <ul className="project-journeys">{plan.journeys.map(journey => <li key={journey.id}>
              <strong>{journey.title}</strong> <span className="muted">{plan.testers.find(tester => tester.id === journey.testerId)?.name}</span>
              <p>{journey.goal}</p>
              <SourceCitations sources={journey.sources} />
            </li>)}</ul>
            <details className="project-disclosure"><summary>Application map evidence</summary>
              <ul>{plan.features.map(feature => <li key={feature.id}>
                <strong>{feature.title}</strong><p>{feature.description}</p><SourceCitations sources={feature.sources} />
              </li>)}</ul>
              {project.discovery && project.discovery.observations.length > 0 && <>
                <h3>Browser observations</h3>
                <ul>{project.discovery.observations.map((observation, i) => <li key={i}>
                  <code>{observation.path}</code>
                  <p>{observation.text}</p>
                </li>)}</ul>
              </>}
              {plan.gaps.length > 0 && <><h3>Coverage gaps</h3><ul>{plan.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></>}
            </details>
            {!latest?.discovery && <MeasuredResults discovery={project.discovery} />}
          </details>
        </div>
      </section>}
      {project.status !== 'discovering' && !active && !refresh.pending && <div className="project-refresh">
        {refreshButton()}
        {!discoveryReady && !health.loading && <p className="field-hint">Enable project discovery on the runner to refresh the application understanding.</p>}
      </div>}
      <StudioError error={health.error} onRetry={health.reload} />
      <ProjectHistory project={project} runs={runs.filter(run => !isActive(run.status) && run.id !== latest?.id)} />
    </>}
  </div>;
}

function ProjectHistory({ project, runs }: { project: ProjectDetail; runs: ProjectRun[] }) {
  if (!runs.length && !project.history.length) return null;
  return <details className="project-disclosure project-history">
    <summary>Tester history</summary>
    {project.history.length > 0 && <ul className="project-history-list">{[...project.history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((event, index) => {
      const run = project.runs.find(run => run.id === event.runId
        || run.results.some(result => result.run.id === event.runId));
      const tester = run?.results.find(result => result.tester.id === event.testerId)?.tester
        ?? project.discovery?.plan.testers.find(tester => tester.id === event.testerId);
      return <li key={`${event.testerId}-${event.runId}-${index}`}>
        {tester && <p><strong>{tester.name} · {tester.role}</strong><br /><TesterAccount tester={tester} accounts={project.accounts} /></p>}
        <p>{event.goal} <span className="badge">{event.outcome}</span></p>
        {event.observations.length > 0 && <ul>{event.observations.map((observation, i) => <li key={i}>{observation}</li>)}</ul>}
        {run && <Link href={projectRunHref(project.id, run.id)}>View run results</Link>}
      </li>;
    })}</ul>}
    {runs.length > 0 && <ul>{runs.map(run => <li key={run.id}>
      <Link href={projectRunHref(project.id, run.id)}>{run.request.mode === 'explore' ? 'First look' : 'Test changes'} · <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time></Link>
    </li>)}</ul>}
  </details>;
}

function TeamProgress({ run }: { run: ProjectRun }) {
  return <div className="project-progress" aria-live="polite">
    <Pending label={run.phase || (run.status === 'queued' ? 'Test team queued' : 'Test team running')} />
    {run.results.length > 0 && <ul>{run.results.map(({ tester, journey, run: evidence }) => <li key={evidence.id}>
      <strong>{tester.name}</strong> · {journey.title} · {evidence.verdict ?? evidence.status}
    </li>)}</ul>}
  </div>;
}

export function ProjectRunPage({ projectId, runId }: { projectId: string; runId: string }) {
  const project = useLoad(() => api.project(projectId), [projectId]);
  const run = useLoad(() => api.projectRun(runId), [runId]);
  const data = run.data?.projectId === projectId ? run.data : null;
  useJobPolling(Boolean(data && isActive(data.status)) && run.error?.status !== 404, run.loading, run.reload);
  return <div className="studio project-studio">
    <StudioBack href={projectHref(projectId)}>{project.data?.name ?? 'Project'}</StudioBack>
    <StudioError error={project.error} onRetry={project.reload} />
    <StudioError error={run.error} onRetry={run.reload} />
    {run.data && !data && <p className="note warn">This run belongs to a different project.</p>}
    {(!run.data || !project.data) && !project.error && !run.error && <Pending label="Loading results…" />}
    {data && project.data && <>
      <header className="studio-heading project-page-heading"><h1>{project.data.name}</h1><p>{data.request.mode === 'explore' ? 'First look' : 'Test changes'}</p></header>
      {isActive(data.status) ? <TeamProgress run={data} /> : <RunFindings run={data} project={project.data} title="Findings"
        actions={<ProjectRepairAction run={data} project={project.data} />} />}
    </>}
  </div>;
}
