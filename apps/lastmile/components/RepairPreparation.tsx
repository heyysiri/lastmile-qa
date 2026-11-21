'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Wrench } from 'lucide-react';
import { PrepareRepairRequestSchema } from '@lastmile/contracts/evolution';
import type { PopulationExecutionDetail } from '@lastmile/contracts/populations';
import { api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { repairHref, useJobPolling } from '../lib/evolution';
import { isActive, usePendingWrite } from '../lib/populations';
import { fieldName } from './RunEvidence';
import { StudioError } from './Studio';

export function RepairPreparation({ execution }: { execution: PopulationExecutionDetail }) {
  const router = useRouter();
  const health = useLoad(api.health);
  const supported = health.data?.repairsReady !== undefined;
  const jobs = useLoad(() => supported ? api.repairs(execution.populationId) : Promise.resolve(null), [execution.populationId, supported]);
  const repairs = jobs.data?.filter(job => job.request.executionId === execution.id) ?? [];
  const active = repairs.some(job => isActive(job.status) || job.status === 'awaiting_review');
  useJobPolling(repairs.some(job => isActive(job.status)), jobs.loading, jobs.reload);
  const write = usePendingWrite(`lastmile-pending-repair-${execution.id}`, PrepareRepairRequestSchema, api.prepareRepair,
    id => router.push(repairHref(id)),
    error => { if (error.status === 409) void jobs.reload(); });
  const ready = health.data?.repairsReady === true && !health.error;
  const disabled = !write.ready || write.busy || (!write.pending && (!ready || !jobs.data || jobs.loading || Boolean(jobs.error)));

  return <section className="studio-card" aria-labelledby="prepare-repair-title">
    <div className="card-heading"><span className="icon-tile lilac"><Wrench size={18} aria-hidden="true" /></span><h2 id="prepare-repair-title">Prepare an isolated repair</h2></div>
    <p>Preparation reuses the same saved states and checks to reproduce each regression and confirm the passing controls. A model can then propose a patch for you to review.</p>
    {repairs.length > 0 && <ul className="repair-links">
      {repairs.map(job => <li key={job.id}>
        <Link className="evidence-link" href={repairHref(job.id)}>
          {job.status === 'awaiting_review' ? 'Review proposed patch' : 'View repair'} <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
        <span className="field-hint"> · {fieldName(job.verification?.outcome ?? job.status)} · {new Date(job.createdAt).toLocaleString()}</span>
      </li>)}
    </ul>}
    {(!active || write.pending) && <button type="button" disabled={disabled}
      onClick={() => {
        if (write.pending) void write.submit();
        else void write.submit({ requestId: newRequestId(), executionId: execution.id });
      }}>
      {write.busy ? 'Submitting…' : write.pending ? 'Recover repair request' : 'Prepare repair'}
    </button>}
    {write.pending && !write.busy && <p className="field-hint">Recover the original preparation request with its saved request ID.</p>}
    {!health.loading && !ready && <p className="field-hint">Repair preparation is unavailable.</p>}
    <StudioError error={health.error} onRetry={health.reload} />
    <StudioError error={jobs.error} onRetry={jobs.reload} />
    <StudioError error={write.error} />
  </section>;
}
