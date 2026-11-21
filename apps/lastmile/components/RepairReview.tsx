'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowUpRight, FileCode2, ShieldCheck } from 'lucide-react';
import { VerifyRepairRequestSchema, type PatchProposal, type RepairJob, type RepairTrial } from '@lastmile/contracts/evolution';
import type { PopulationExecutionDetail } from '@lastmile/contracts/populations';
import { api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { useJobPolling } from '../lib/evolution';
import { isActive, populationExecutionHref, usePendingWrite } from '../lib/populations';
import { artifactHref, fieldName, RunChecks, RunSteps } from './RunEvidence';
import { StudioBack, StudioError, TesterFace } from './Studio';
import { Pending } from './ui';

const outcomes = {
  verified: { label: 'Repair verified', tone: 'mint' },
  rejected: { label: 'Repair rejected', tone: 'peach' },
  inconclusive: { label: 'Verification inconclusive', tone: 'lilac' },
};

function repairStatus(job: RepairJob) {
  if (job.status === 'completed' && job.verification) return outcomes[job.verification.outcome];
  if (job.status === 'interrupted') return { label: 'Repair interrupted', tone: 'peach' };
  if (job.status === 'awaiting_review') return { label: 'Awaiting patch review', tone: 'lilac' };
  if (job.status === 'completed') return { label: job.stage === 'prepare' ? 'No patch proposed' : 'Verification inconclusive', tone: 'peach' };
  if (job.stage === 'verify') return { label: job.status === 'queued' ? 'Verification queued' : 'Verifying patch', tone: 'lilac' };
  return { label: job.status === 'queued' ? 'Preparation queued' : 'Preparing repair', tone: 'lilac' };
}

export function RepairReview({ id }: { id: string }) {
  const repair = useLoad(() => api.repair(id), [id]);
  const health = useLoad(api.health);
  const write = usePendingWrite(`lastmile-pending-repair-verification-${id}`, VerifyRepairRequestSchema,
    request => api.verifyRepair(id, request),
    (_, result) => repair.setData(result),
    error => { if (error.status === 409) void repair.reload(); }, true);
  const job = repair.data;
  const recorded = job?.verificationRequest;
  const accepted = Boolean(write.pending && recorded?.requestId === write.pending.requestId && recorded.patchHash === write.pending.patchHash);
  const { resolve } = write;

  useEffect(() => {
    if (accepted && !write.busy) resolve();
  }, [accepted, resolve, write.busy]);

  useJobPolling(Boolean(job && (isActive(job.status) || (job.status === 'awaiting_review' && write.pending && !write.busy)))
    && repair.error?.status !== 404, repair.loading, repair.reload);

  const status = job && repairStatus(job);
  const execution = job?.snapshot.execution;
  const patch = job?.patch;
  const mayVerify = job?.status === 'awaiting_review' && patch;
  const ready = health.data?.repairsReady === true && !health.error;

  return <div className="studio population-studio">
    <StudioBack href={execution ? populationExecutionHref(execution.populationId, execution.id) : '/populations'}>
      {execution ? 'Release comparison' : 'Populations'}
    </StudioBack>
    <StudioError error={repair.error} onRetry={repair.reload} />
    {!job && !repair.error && <Pending label="Loading repair…" />}
    {job && execution && status && <>
      <header className="studio-heading review-heading">
        <div><h1>Repair review</h1><p>{execution.releaseLabel} · {execution.population.label}</p></div>
        <span className={`pill pill-${status.tone}`} role="status">{status.label}</span>
      </header>
      <StudioError error={job.error} />
      {job.status === 'interrupted' && <p className="note warn">The repair worker stopped during {job.stage === 'prepare' ? 'preparation' : 'verification'}. Any retained evidence is shown below.</p>}
      {job.reproduction && <RepairTrials title="Reproduction evidence" trials={job.reproduction} execution={execution} />}
      {patch && <section className="studio-card" aria-labelledby="repair-patch-title">
        <div className="card-heading"><span className="icon-tile lilac"><FileCode2 size={18} aria-hidden="true" /></span><h2 id="repair-patch-title">Proposed patch</h2></div>
        <p>{patch.summary}</p>
        <details className="studio-disclosure">
          <summary>Technical details</summary>
          <div className="release-builds">
            <div><small>Patch hash</small><code>{patch.hash}</code></div>
            {job.sourceVersion && <div><small>Source version</small><code>{job.sourceVersion}</code></div>}
            <div><small>Build ID</small><code>{execution.buildId}</code></div>
          </div>
        </details>
        <PatchFiles changes={patch.changes} />
        {mayVerify && <>
          <p className="field-hint">Verification builds the proposal in isolation and replays the original failing cases and passing controls.</p>
          {write.pending && !write.busy && <p className="field-hint">Recover the original verification request before starting another one.</p>}
          {!health.loading && !ready && !write.pending && <p className="field-hint">Patch verification is unavailable.</p>}
          <StudioError error={health.error} onRetry={health.reload} />
          <button type="button" disabled={!write.ready || write.busy || repair.loading || Boolean(repair.error) || (!ready && !write.pending)}
            onClick={() => {
              if (write.pending) void write.submit();
              else void write.submit({ requestId: newRequestId(), patchHash: patch.hash });
            }}>
            <ShieldCheck size={17} aria-hidden="true" />
            {write.busy ? 'Submitting…' : write.pending ? 'Recover verification request' : 'Verify patch'}
          </button>
        </>}
        <StudioError error={write.error} />
      </section>}
      {job.verification && <>
        <p className={`note ${job.verification.outcome === 'verified' ? 'ok' : 'warn'}`}>
          {job.verification.message}
          {job.verification.outcome === 'verified' && <> The isolated patch passed the retained checks. Review and apply it manually in your checkout if you choose to use it.</>}
        </p>
        <RepairTrials title="Verification evidence" trials={job.verification.trials} execution={execution} />
      </>}
    </>}
  </div>;
}

function PatchFiles({ changes }: { changes: PatchProposal['changes'] }) {
  return <div className="repair-files">
    {changes.map(change => <details className="studio-disclosure" key={change.path}>
      <summary><code>{change.path}</code></summary>
      <div className="patch-sources">
        <div><h3>Before</h3><pre tabIndex={0} aria-label={`${change.path} before`}>{change.before}</pre></div>
        <div><h3>After</h3><pre tabIndex={0} aria-label={`${change.path} after`}>{change.after}</pre></div>
      </div>
    </details>)}
  </div>;
}

function RepairTrials({ title, trials, execution }: { title: string; trials: RepairTrial[]; execution: PopulationExecutionDetail }) {
  return <section aria-label={title}>
    <div className="section-heading"><h2>{title}</h2></div>
    {trials.length === 0 && <p className="muted">No replay evidence was recorded.</p>}
    <div className="result-grid">
      {trials.map(trial => {
        const index = execution.population.testers.findIndex(item => item.id === trial.testerId);
        const tester = execution.population.testers[index];
        const originalId = execution.members.find(item => item.testerId === trial.testerId)?.runId;
        const screenshot = trial.run.artifacts.find(path => path.split('/').at(-1) === 'final.png');
        const tone = trial.outcome === 'passed' ? 'mint' : trial.outcome === 'failed' ? 'peach' : 'lilac';
        return <article className={`studio-card result-card tone-${Math.max(0, index) % 3}`} key={trial.testerId}>
          <header className="tester-heading"><TesterFace index={Math.max(0, index)} />
            <div><h3>{tester?.profile.name ?? trial.testerId}</h3><p>{trial.role === 'regression' ? 'Original failing case' : 'Passing control'}</p></div>
          </header>
          <div className="result-status"><span className={`pill pill-${tone}`}>{fieldName(trial.outcome)}</span></div>
          <p>{trial.message}</p>
          <p className="field-hint">{trial.run.scenario.goal}</p>
          <RunChecks run={trial.run} collapsePassing />
          <RunSteps run={trial.run} />
          {originalId && <div className="population-evidence-links">
            <Link href={`/runs/${encodeURIComponent(originalId)}`} className="evidence-link">Original comparison evidence <ArrowUpRight size={15} aria-hidden="true" /></Link>
            <Link href={`/runs/${encodeURIComponent(trial.run.id)}`} className="evidence-link">This replay’s evidence <ArrowUpRight size={15} aria-hidden="true" /></Link>
            {screenshot && <a className="evidence-link" href={artifactHref(trial.run.id, screenshot)} target="_blank" rel="noreferrer">This replay’s screenshot</a>}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}
