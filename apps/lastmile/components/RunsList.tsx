'use client';
import { api, useLoad } from '../lib/api';
import { ErrorNote, Pending } from './ui';
import { RunsTable } from './RunsTable';

export function RunsList() {
  const runs = useLoad(api.runs, []);
  return (
    <>
      <h1>Run history</h1>
      <p className="muted">Every run stored by the runner, newest first.</p>
      {runs.loading && !runs.data && <Pending label="Loading runs…" />}
      {runs.error && <ErrorNote error={runs.error} onRetry={runs.reload} />}
      {runs.data?.length === 0 && <p className="muted">No runs recorded yet.</p>}
      {!!runs.data?.length && <section className="panel"><RunsTable runs={runs.data} /></section>}
    </>
  );
}
