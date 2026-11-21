'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, UsersRound } from 'lucide-react';
import { EnrollPopulationRequestSchema } from '@lastmile/contracts/populations';
import type { Study } from '@lastmile/contracts/studies';
import { api } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { populationHref, usePendingWrite } from '../lib/populations';
import { plural, StudioError } from './Studio';

export function PopulationEnrollment({ study, disabled, onStale }: { study: Study; disabled: boolean; onStale: () => void }) {
  const router = useRouter();
  const [label, setLabel] = useState<string>();
  const enrollment = usePendingWrite(`lastmile-pending-enrollment-${study.id}`, EnrollPopulationRequestSchema, api.enrollPopulation,
    id => router.push(populationHref(id)), (error, rejected) => {
      setLabel(rejected.label);
      if (error.code === 'stale_revision') onStale();
    });

  function enroll() {
    const request = EnrollPopulationRequestSchema.safeParse({ requestId: newRequestId(), label: label ?? study.title, studyId: study.id, revision: study.revision });
    if (!disabled && request.success) void enrollment.submit(request.data);
  }

  return <section className="studio-card enrollment-card" aria-labelledby="enroll-testers-title">
    <div className="card-heading"><span className="icon-tile mint"><UsersRound size={19} aria-hidden="true" /></span><h2 id="enroll-testers-title">Keep these testers</h2></div>
    <p>Enroll {plural(study.users.length, 'tester')} from saved revision {study.revision}. Their profiles stay fixed, and future journeys use the same accounts.</p>
    <label className="field"><span>Population name</span><input maxLength={120} value={enrollment.pending?.label ?? label ?? study.title} onChange={event => setLabel(event.target.value)} disabled={disabled || Boolean(enrollment.pending) || enrollment.busy} /></label>
    <button type="button" disabled={!enrollment.ready || enrollment.busy || (!enrollment.pending && (disabled || !(label ?? study.title).trim()))}
      onClick={enrollment.pending ? () => void enrollment.submit() : enroll}>
      {enrollment.busy ? 'Enrolling…' : enrollment.pending ? 'Recover enrollment' : 'Enroll persistent testers'}<ArrowRight size={16} aria-hidden="true" />
    </button>
    <StudioError error={enrollment.error} />
    {enrollment.pending && !enrollment.busy && <p className="field-hint">Recover the original enrollment for revision {enrollment.pending.revision} before starting another one.</p>}
  </section>;
}
