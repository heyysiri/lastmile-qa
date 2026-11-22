'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CircleCheck, Clock3, GitPullRequestArrow, Play, RotateCw, Users } from 'lucide-react';
import { ProjectRunRequestSchema, SyncGitHubProjectSchema, type ProjectDetail, type ProjectRun } from '@lastmile/contracts/projects';
import { api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { useJobPolling } from '../lib/evolution';
import { isActive, usePendingWrite } from '../lib/populations';
import { projectHref, projectRefreshRequest, projectRunHref, shortSha } from '../lib/projects';
import { GitHubSource } from './GitHubSource';
import { TestInventory } from './TestInventory';
import { JourneyStages, MeasuredResults, RunFindings, SourceCitations, TesterAccount, TesterPersona } from './ProjectEvidence';
import { ProjectRepairAction } from './ProjectRepairReview';
import { StudioBack, StudioError, TesterFace } from './Studio';
import { Pending } from './ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './primitives';

export function ProjectHome({ id }: { id: string }) {
  const [tab, setTab] = useState('results');
  const detail = useLoad(() => api.project(id), [id]);
  const health = useLoad(api.health);
  const project = detail.data;
  const runs = [...(project?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.find(run => isActive(run.status));
  const activeRepair = project?.repairs?.find(job => isActive(job.status));
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
  const sync = usePendingWrite(`lastmile-pending-project-sync-${id}`, SyncGitHubProjectSchema,
    request => api.syncProject(id, request),
    () => { void detail.reload(); },
    () => { void detail.reload(); }, true);
  const accepted = Boolean(write.pending && runs.some(run => run.request.requestId === write.pending?.requestId));
  const resolveRun = write.resolve;
  useEffect(() => {
    if (accepted && !write.busy) resolveRun();
  }, [accepted, resolveRun, write.busy]);

  useJobPolling(Boolean(active || activeRepair || project?.status === 'discovering') && detail.error?.status !== 404, detail.loading, detail.reload);

  const plan = project?.discovery?.plan;
  const discoveryReady = health.data?.projectDiscoveryReady === true && !health.error;
  const executionReady = health.data?.projectExecutionReady === true && !health.error;
  const github = project?.github;
  const requestInFlight = write.busy || refresh.busy || sync.busy;
  const canRun = project?.status === 'ready' && executionReady && (hasCompleted ? discoveryReady : true);
  const canRefresh = Boolean(project && project.status !== 'discovering' && discoveryReady);
  const canSync = Boolean(project && project.status !== 'discovering' && discoveryReady && executionReady && !active && !activeRepair);
  const syncFirst = Boolean(github && hasCompleted);

  function runButton(recovering = false) {
    if (!recovering && write.pending) return null;
    return <button type="button"
      disabled={!write.ready || requestInFlight || Boolean(refresh.pending) || Boolean(sync.pending) || detail.loading || Boolean(detail.error) || (!recovering && !canRun)}
      onClick={() => { setTab('results'); void write.submit({ requestId: newRequestId(), mode: hasCompleted ? 'release' : 'explore', autoRepair: true }); }}>
      <Play size={16} aria-hidden="true" />
      {write.busy ? 'Starting team…' : recovering ? 'Recover run request' : hasCompleted ? 'Test changes' : 'Run test team'}
    </button>;
  }

  function syncButton(recovering = false, run = true) {
    if (!recovering && sync.pending) return null;
    const disabled = !sync.ready || requestInFlight || Boolean(write.pending) || Boolean(refresh.pending) || detail.loading || Boolean(detail.error)
      || (!recovering && !(run ? canSync : canRefresh));
    return <button type="button" className={run ? undefined : 'secondary'} disabled={disabled}
      onClick={() => { if (run) setTab('results'); void sync.submit({ requestId: newRequestId(), run }); }}>
      {run ? <GitPullRequestArrow size={16} aria-hidden="true" /> : <RotateCw size={15} aria-hidden="true" />}
      {sync.busy ? 'Syncing…' : recovering ? 'Recover sync request' : run ? 'Sync & test' : 'Retry sync'}
    </button>;
  }

  function refreshButton() {
    return <button type="button" className="secondary"
      disabled={!refresh.ready || requestInFlight || Boolean(write.pending) || Boolean(sync.pending) || detail.loading || Boolean(detail.error) || (!refresh.pending && !canRefresh)}
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
        <div><h1>{project.name}</h1>{github ? <GitHubSource project={project} />
          : <a className="project-app-link" href={project.appUrl} target="_blank" rel="noreferrer">{project.appUrl}<ArrowUpRight size={14} aria-hidden="true" /></a>}</div>
        {!active && !activeRepair && project.status === 'ready' && (syncFirst ? syncButton() : runButton())}
      </header>
      {project.status === 'discovering' && <div className="project-progress"><Pending label={project.progress || 'Discovery queued'} /></div>}
      {project.status === 'failed' && <div className="project-progress">
        <h2>Discovery needs attention</h2>
        <p>{project.error || project.progress || 'Discovery ended before the project was ready.'}</p>
        {github ? !sync.pending && syncButton(false, false) : !refresh.pending && refreshButton()}
      </div>}
      {active && <TeamProgress run={active} />}
      {(write.pending && !accepted || refresh.pending || sync.pending) && <div className="project-progress">
        {write.pending && !accepted && runButton(true)}
        {refresh.pending && refreshButton()}
        {sync.pending && syncButton(true, sync.pending.run)}
      </div>}
      <StudioError error={write.error} />
      <StudioError error={refresh.error} />
      <StudioError error={sync.error} />
      {project.status === 'ready' && !active && !activeRepair && !write.pending && !health.loading && !canRun && <p className="note warn">
        {executionReady ? 'Enable project discovery on the runner to test changes against refreshed source.' : 'Enable project execution on the runner to run the test team.'}
      </p>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="results"><CircleCheck size={16} aria-hidden="true" />Results</TabsTrigger>
          <TabsTrigger value="team"><Users size={16} aria-hidden="true" />Team</TabsTrigger>
          <TabsTrigger value="history"><Clock3 size={16} aria-hidden="true" />History</TabsTrigger>
        </TabsList>
        <TabsContent value="results">
          {latest ? <RunFindings run={latest} project={project} title={active ? 'Previous results' : 'Latest findings'}
            detailLink={<Link className="project-report-link" href={projectRunHref(id, latest.id)}>Shareable results <ArrowUpRight size={14} aria-hidden="true" /></Link>}
            actions={<ProjectRepairAction project={project} run={latest} />} />
          : project.status === 'ready' && !active ? <div className="team-ready">
            <div className="ready-faces" aria-hidden="true">{plan?.testers.map((tester, i) => <TesterFace key={tester.id} index={i} />)}</div>
            <h2>Your team is ready</h2>
            <p>{plan?.testers.length ?? 0} testers. {plan?.journeys.length ?? 0} journeys to explore.<br />Run your team to test what happens along the way.</p>
            <ul className="project-feature-list">{plan?.features.map(feature => <li key={feature.id}>{feature.title}</li>)}</ul>
          </div> : null}
        </TabsContent>
        <TabsContent value="team">
      {plan && project.status === 'ready' && <section className="project-team" aria-labelledby="team-heading">
        <div className="project-section-heading"><h2 id="team-heading">Your test team</h2></div>
        <p className="field-hint">Personas are generated from your app and audience. Multiple personas can share an access account and business data, with separate browser storage.</p>
        <div className="project-team-roster">{plan.testers.map((tester, i) => <article key={tester.id}>
          <TesterFace index={i} />
          <div><h3>{tester.name}</h3><p>{tester.role}</p><TesterPersona tester={tester} /><small><TesterAccount tester={tester} accounts={project.accounts} /></small></div>
        </article>)}</div>
        <TestInventory cases={project.cases} coverageMode={github?.coverageMode} />
        <div className="project-understanding">
          <div className="project-section-heading"><h2>What the team found in the app</h2></div>
          <ul className="project-feature-list">{plan.features.map(feature => <li key={feature.id}>{feature.title}</li>)}</ul>
          <details className="project-disclosure">
            <summary>Review generated journeys</summary>
            <p>{plan.summary}</p>
            <ul className="project-journeys">{plan.journeys.map(journey => <li key={journey.id}>
              <strong>{journey.title}</strong> <span className="muted">{plan.testers.find(tester => tester.id === journey.testerId)?.name}</span>
              <p>{journey.goal}</p>
              <p className="field-hint">{journey.reason}</p>
              <JourneyStages journey={journey} network={plan.testers.find(tester => tester.id === journey.testerId)!.context.network} />
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
      {project.status === 'ready' && !github && !active && !activeRepair && !refresh.pending && <div className="project-refresh">
        {refreshButton()}
        {!discoveryReady && !health.loading && <p className="field-hint">Enable project discovery on the runner to refresh the application understanding.</p>}
      </div>}
        </TabsContent>
        <TabsContent value="history"><ProjectHistory project={project} runs={runs.filter(run => !isActive(run.status))} /></TabsContent>
      </Tabs>
      <StudioError error={health.error} onRetry={health.reload} />
    </>}
  </div>;
}

function ProjectHistory({ project, runs }: { project: ProjectDetail; runs: ProjectRun[] }) {
  if (!runs.length && !project.history.length) return <div className="workspace-empty"><Clock3 size={24} aria-hidden="true" /><p>No runs yet. Your team’s history will appear here.</p></div>;
  return <section className="project-history">
    <h2>Tester history</h2>
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
      <Link href={projectRunHref(project.id, run.id)}>{run.request.mode === 'explore' ? 'First look' : 'Test changes'}{run.revision && <> · <code>{shortSha(run.revision)}</code></>} · <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time></Link>
    </li>)}</ul>}
  </section>;
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
      <header className="studio-heading project-page-heading"><h1>{project.data.name}</h1><p>{data.request.mode === 'explore' ? 'First look' : 'Test changes'}{data.revision && <> · <code>{shortSha(data.revision)}</code></>}</p></header>
      {isActive(data.status) ? <TeamProgress run={data} /> : <RunFindings run={data} project={project.data} title="Findings"
        actions={<ProjectRepairAction run={data} project={project.data} />} />}
    </>}
  </div>;
}
