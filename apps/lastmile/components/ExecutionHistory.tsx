'use client';

import Link from 'next/link';
import { ArrowRight, History } from 'lucide-react';
import { api, useLoad } from '../lib/api';
import { executionHref, plural, StudioError } from './Studio';
import { Pending, StatusBadge } from './ui';

export function ExecutionHistory() {
  const { data, loading, error, reload } = useLoad(api.executions);
  return <div className="studio">
    <header className="studio-heading"><h1>Execution history</h1><p>Revisit prior results and the tester snapshots used in each execution.</p></header>
    <section className="studio-card">
      <div className="card-heading"><span className="icon-tile"><History size={18} aria-hidden="true" /></span><h2>Study executions</h2></div>
      {loading && !data && <Pending label="Loading execution history…" />}
      <StudioError error={error} onRetry={reload} />
      {data?.length === 0 && <p className="empty-state">When you run a study, its results will appear here. <Link href="/studies">Create a study</Link></p>}
      <ul className="studio-list">{data?.map(execution => <li key={execution.id}>
        <Link href={executionHref(execution.studyId, execution.id)}>
          <span><strong>{execution.study.title}</strong><small>Revision {execution.studyRevision} · {plural(execution.study.users.length, 'tester')} · {new Date(execution.createdAt).toLocaleString()}</small></span>
          <StatusBadge value={execution.status} /><ArrowRight size={17} aria-hidden="true" />
        </Link>
      </li>)}</ul>
    </section>
    <p className="history-footer"><Link href="/runs">Open individual run history</Link></p>
  </div>;
}
