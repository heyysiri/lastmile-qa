'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FilePenLine, ShieldCheck } from 'lucide-react';
import { VerifyRepairRequestSchema, type PatchProposal } from '@lastmile/contracts/evolution';
import { ProjectRepairRequestSchema, type Project, type ProjectRepair, type ProjectRun } from '@lastmile/contracts/projects';
import { api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { useJobPolling } from '../lib/evolution';
import { isActive, usePendingWrite } from '../lib/populations';
import { canPrepareProjectRepair, projectRepairHref, projectRunHref } from '../lib/projects';
import { ContextInvestigation, RunFindings, TesterResults } from './ProjectEvidence';
import { StudioBack, StudioError } from './Studio';
import { Pending } from './ui';

export function ProjectRepairAction({ project, run }: { project: Project; run: ProjectRun }) {
  if (run.request.autoRepair) return <AutomaticRepairStatus project={project} run={run} key={run.id} />;
  if (!canPrepareProjectRepair(run)) return null;
  if (!run.results.some(result => result.run.verdict === 'passed')) return <div className="project-repair-action">
    <p className="field-hint">Preparing a fix requires a passing tester journey to replay alongside the failing one.</p>
  </div>;
  return <PrepareProjectRepair project={project} run={run} key={run.id} />;
}

function AutomaticRepairStatus({ project, run }: { project: Project; run: ProjectRun }) {
  const records = useLoad(() => api.projectRepairs(project.id), [project.id]);
  const latest = records.data?.filter(job => job.request.runId === run.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const active = Boolean(latest && isActive(latest.status));
  useJobPolling(active, records.loading, records.reload);
  if (run.repairBlockedReason) return <p className="note warn">{run.repairBlockedReason}</p>;
  if (!latest) return <StudioError error={records.error} onRetry={records.reload} />;
  const label = active ? latest.phase === 'verify' ? 'Verifying the fix' : 'Preparing a fix' : repairStatus(latest);
  return <div className="project-repair-action" aria-live="polite">
    {active ? <Pending label={label} /> : <strong>{label}</strong>}
    <Link className="btn secondary" href={projectRepairHref(latest.id)}>Review fix</Link>
    <StudioError error={latest.error || records.error} onRetry={records.error ? records.reload : undefined} />
  </div>;
}

// Only settled, unsuccessful attempts may be retried; active, reviewable, and verified jobs stay single.
const canRetryRepair = (job: ProjectRepair) => job.status === 'interrupted'
  || (job.status === 'completed' && job.verification?.outcome !== 'verified');

function PrepareProjectRepair({ project, run }: { project: Project; run: ProjectRun }) {
  const router = useRouter();
  const health = useLoad(api.health);
  const records = useLoad(() => api.projectRepairs(project.id), [project.id]);
  const write = usePendingWrite(`lastmile-pending-project-repair-${run.id}`, ProjectRepairRequestSchema, api.prepareProjectRepair,
    id => router.push(projectRepairHref(id)), () => { void records.reload(); });
  const accepted = records.data?.find(job => job.request.requestId === write.pending?.requestId);
  const resolve = write.resolve;
  useEffect(() => {
    if (accepted && !write.busy) resolve();
  }, [accepted, resolve, write.busy]);

  const latest = records.data?.filter(job => job.request.runId === run.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const retry = Boolean(latest && canRetryRepair(latest));
  const ready = health.data?.projectRepairsReady === true && !health.error;
  const needsSetup = !project.commands?.start.length || (!health.loading && !ready);

  return <div className="project-repair-action">
    {latest && (!write.pending || retry) && <Link className="btn secondary" href={projectRepairHref(latest.id)}><FilePenLine size={16} aria-hidden="true" />{retry ? 'Review last attempt' : 'Review fix'}</Link>}
    {(!latest || retry || write.pending) && <>
      {!write.pending && needsSetup ? <>
        {!project.commands?.start.length && <p className="field-hint">To prepare and verify fixes, connect the repository with a start command in Advanced connection setup.</p>}
        {!health.loading && !ready && <p className="field-hint">Enable project repairs on the runner to prepare and verify fixes.</p>}
      </> : <button type="button"
        disabled={!write.ready || records.loading || Boolean(records.error) || write.busy || (!ready && !write.pending)}
        onClick={() => void write.submit({ requestId: newRequestId(), runId: run.id, ...(retry ? { automatic: true } : {}) })}>
        <FilePenLine size={16} aria-hidden="true" />
        {write.busy ? 'Requesting fix…' : write.pending ? 'Recover fix request' : retry ? 'Retry fix' : 'Prepare fix'}
      </button>}
    </>}
    <StudioError error={health.error} onRetry={health.reload} />
    <StudioError error={records.error} onRetry={records.reload} />
    <StudioError error={write.error} />
  </div>;
}

const verificationStatus = {
  verified: 'Fix verified',
  rejected: 'Fix rejected',
  inconclusive: 'Verification inconclusive',
};

function repairStatus(job: ProjectRepair) {
  if (job.status === 'interrupted') return job.phase === 'verify' ? 'Verification interrupted' : 'Preparation interrupted';
  if (job.status === 'awaiting_review') return 'Ready for review';
  if (job.status === 'completed') return job.verification ? verificationStatus[job.verification.outcome]
    : job.phase === 'verify' ? 'Verification inconclusive' : 'No patch proposed';
  if (job.phase === 'verify') return job.status === 'queued' ? 'Verification queued' : 'Verifying patch';
  return job.status === 'queued' ? 'Preparation queued' : 'Preparing fix';
}

export function ProjectRepairReview({ id }: { id: string }) {
  const repair = useLoad(() => api.projectRepair(id), [id]);
  const health = useLoad(api.health);
  const job = repair.data;
  const patch = job?.patch;
  const [notice, setNotice] = useState('');
  const write = usePendingWrite(`lastmile-pending-project-verification-${id}`, VerifyRepairRequestSchema,
    request => api.verifyProjectRepair(id, request), (_, result) => repair.setData(result),
    error => { if (error.status === 409) void repair.reload(); }, true);
  const accepted = Boolean(write.pending && job?.verificationRequest?.requestId === write.pending.requestId
    && job.verificationRequest.patchHash === write.pending.patchHash);
  const stale = Boolean(write.pending && !accepted && job?.status === 'awaiting_review' && patch && patch.hash !== write.pending.patchHash);
  const resolve = write.resolve;
  useEffect(() => {
    if (write.busy) return;
    if (stale) setNotice('The patch changed. Review the new proposal.');
    if (stale || accepted) resolve();
  }, [accepted, resolve, stale, write.busy]);

  const active = Boolean(job && isActive(job.status));
  useJobPolling((active || Boolean(job?.status === 'awaiting_review' && write.pending)) && repair.error?.status !== 404,
    repair.loading, repair.reload);

  const ready = health.data?.projectRepairsReady === true && !health.error;
  return <div className="studio project-studio">
    <StudioBack href={job ? projectRunHref(job.projectId, job.sourceRun.id) : '/'}>{job ? 'Run findings' : 'Projects'}</StudioBack>
    <StudioError error={repair.error} onRetry={repair.reload} />
    {!job && !repair.error && <Pending label="Loading fix…" />}
    {job && <>
      <header className="studio-heading project-page-heading">
        <h1>Review fix</h1><p>{job.project.name}</p>
      </header>
      <div className="project-progress repair-status" data-outcome={job.verification?.outcome ?? (job.error ? 'inconclusive' : undefined)} role="status">
        {active ? <Pending label={repairStatus(job)} /> : <strong>{repairStatus(job)}</strong>}
      </div>
      <StudioError error={job.error} />
      {job.investigation && <ContextInvestigation investigation={job.investigation} />}
      {job.verification && <section className="project-report" aria-label="Verification results">
        <h2>Verification results</h2>
        <p>{job.verification.message}</p>
        {job.verification.outcome === 'verified' && <p>The patch passed verification in the private checkout. You can review and apply it in your own checkout.</p>}
        <TesterResults results={job.verification.results} accounts={job.project.accounts} />
      </section>}
      {patch && <section className="project-report project-patch" aria-labelledby="patch-heading">
        <h2 id="patch-heading">Proposed patch</h2>
        <p>{patch.summary}</p>
        <PatchChanges key={patch.hash} changes={patch.changes} />
        <details className="project-disclosure">
          <summary>Technical details</summary>
          <p>Patch hash <code>{patch.hash}</code></p>
          {job.sourceVersion && <p>Source version <code>{job.sourceVersion}</code></p>}
          {patch.changes.map(change => <p key={change.path}>{change.path} <code>{change.beforeHash}</code></p>)}
        </details>
        {job.status === 'awaiting_review' && !job.request.automatic && <div className="project-actions">
          <p className="field-hint">Verification builds the patch in a private checkout and replays the original checks and passing controls.</p>
          {!job.project.commands?.start.length && <p className="field-hint">The project needs a start command for private verification.</p>}
          {!ready && !health.loading && <p className="field-hint">Enable project repairs on the runner to verify the patch.</p>}
          <StudioError error={health.error} onRetry={health.reload} />
          <button type="button" disabled={!write.ready || write.busy || repair.loading || Boolean(repair.error) || stale
            || (!write.pending && (!ready || !job.project.commands?.start.length))}
            onClick={() => { setNotice(''); void write.submit({ requestId: newRequestId(), patchHash: patch.hash }); }}>
            <ShieldCheck size={16} aria-hidden="true" />
            {write.busy ? 'Requesting verification…' : write.pending ? 'Recover verification request' : 'Verify patch'}
          </button>
        </div>}
        {notice && <p className="note warn" role="alert">{notice}</p>}
        <StudioError error={write.error} />
      </section>}
      <details className="project-disclosure original-evidence"><summary>Original run evidence</summary>
        <RunFindings project={job.project} run={job.sourceRun} title="Original findings" />
      </details>
    </>}
  </div>;
}

function PatchChanges({ changes }: { changes: PatchProposal['changes'] }) {
  return <div className="repair-files">{changes.map(change => <details className="project-disclosure" open={changes.length === 1} key={change.path}>
    <summary><code>{change.path}</code></summary>
    <PatchDiff change={change} />
    <details className="project-disclosure">
      <summary>Full before and after</summary>
      <div className="patch-sources">
        <div><h3>Before</h3><pre tabIndex={0} aria-label={`${change.path} before`}>{change.before}</pre></div>
        <div><h3>After</h3><pre tabIndex={0} aria-label={`${change.path} after`}>{change.after}</pre></div>
      </div>
    </details>
  </details>)}</div>;
}

function PatchDiff({ change }: { change: PatchProposal['changes'][number] }) {
  const before = change.before.split('\n');
  const after = change.after.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (change.before === change.after) return <p>No text changed in this file.</p>;
  return <pre className="project-diff" tabIndex={0} aria-label={`Changed lines in ${change.path}`}>
    {before.slice(start, endBefore).map((line, i) => <del key={i}>− {line}{'\n'}</del>)}
    {after.slice(start, endAfter).map((line, i) => <ins key={i}>+ {line}{'\n'}</ins>)}
  </pre>;
}
