'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { SuggestJourneysRequestSchema, type JourneySuggestion, type SuggestionJob } from '@lastmile/contracts/evolution';
import type { PersistentTask, PopulationDetail } from '@lastmile/contracts/populations';
import type { ApplicationWorkflow } from '@lastmile/contracts/studies';
import { api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { useJobPolling } from '../lib/evolution';
import { isActive, usePendingWrite } from '../lib/populations';
import { displayValue, fieldName } from './RunEvidence';
import { StudioError } from './Studio';
import { Pending } from './ui';

export function JourneySuggestions({ population, workflows, readiness, canApply, onApply }: {
  population: PopulationDetail; workflows: ApplicationWorkflow[]; readiness?: boolean; canApply: boolean;
  onApply: (tasks: PersistentTask[]) => void;
}) {
  const [objective, setObjective] = useState('');
  const [submitted, setSubmitted] = useState<SuggestionJob | null>(null);
  const [applied, setApplied] = useState(false);
  const supported = readiness !== undefined;
  const history = useLoad(() => supported ? api.suggestions(population.id) : Promise.resolve(null), [population.id, supported]);
  const latest = submitted ?? history.data?.reduce<SuggestionJob | null>((newest, item) =>
    !newest || item.createdAt > newest.createdAt ? item : newest, null);
  const jobId = latest?.id;
  const job = useLoad(() => jobId ? api.suggestion(jobId) : Promise.resolve(null), [jobId]);
  const current = job.data && job.data.id === jobId ? job.data : latest;
  const active = Boolean(current && isActive(current.status));
  useJobPolling(active && job.error?.status !== 404, job.loading, job.reload);

  const write = usePendingWrite(`lastmile-pending-suggestion-${population.id}`, SuggestJourneysRequestSchema,
    request => api.suggestJourneys(population.id, request),
    (_, result) => {
      setSubmitted(result);
      job.setData(result);
      setApplied(false);
    },
    (error, request) => {
      setObjective(request.objective ?? '');
      if (error.status === 409) void history.reload();
    }, true);
  const suggestions = current?.status === 'completed' && !current.error ? current.suggestions ?? [] : [];
  const canGenerate = readiness === true && history.data && !history.loading && !history.error && !active;
  const disabled = !write.ready || write.busy || (!write.pending && !canGenerate);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (write.pending) {
      setObjective(write.pending.objective ?? '');
      void write.submit();
    } else {
      void write.submit({ requestId: newRequestId(), objective: objective.trim() || undefined });
    }
  }

  return <section className="journey-suggestions" aria-labelledby="journey-suggestions-title">
    <div className="card-heading"><span className="icon-tile lilac"><Sparkles size={18} aria-hidden="true" /></span><h2 id="journey-suggestions-title">Plan the next journeys</h2></div>
    <p className="field-hint">Suggestions are hypotheses based on application sources and recorded tester history. Generation may incur model charges.</p>
    <form onSubmit={submit}>
      <label className="field"><span>Objective (optional)</span>
        <input maxLength={2000} placeholder="e.g. Explore repeated inventory edits" value={write.pending ? write.pending.objective ?? '' : objective}
          disabled={Boolean(write.pending) || write.busy} onChange={event => setObjective(event.target.value)} />
      </label>
      <button type="submit" className="secondary" disabled={disabled}>
        {write.busy ? 'Submitting…' : write.pending ? 'Recover suggestions request' : 'Suggest next journeys'}
      </button>
    </form>
    {readiness !== true && <p className="field-hint">Journey suggestions are unavailable.</p>}
    {write.pending && !write.busy && <p className="field-hint">Recover the original request with its saved objective and request ID.</p>}
    <StudioError error={write.error} />
    <StudioError error={history.error} onRetry={history.reload} />
    <StudioError error={job.error} onRetry={job.reload} />
    {active && <Pending label={current?.status === 'queued' ? 'Suggestions queued…' : 'Generating journey suggestions…'} />}
    {current?.error && <StudioError error={current.error} />}
    {current?.status === 'interrupted' && <p className="note warn">Suggestion generation was interrupted. Start a new request to generate another set.</p>}
    {current?.status === 'completed' && !current.error && !suggestions.length && <p className="muted">This request returned no suggestions.</p>}
    {suggestions.length > 0 && <>
      <ul className="suggestion-list">{suggestions.map(suggestion =>
        <Suggestion key={suggestion.task.testerId} suggestion={suggestion} population={population} workflows={workflows} />)}</ul>
      <button type="button" className="secondary" disabled={!canApply} onClick={() => {
        onApply(suggestions.map(item => item.task));
        setApplied(true);
      }}>Apply suggestions</button>
      {applied && <p className="field-hint" role="status">Copied to the editable tasks below.</p>}
    </>}
  </section>;
}

function Suggestion({ suggestion, population, workflows }: {
  suggestion: JourneySuggestion; population: PopulationDetail; workflows: ApplicationWorkflow[];
}) {
  const { task, sourcePaths, historyRunIds, assumptions } = suggestion;
  const tester = population.testers.find(item => item.id === task.testerId);
  const workflow = workflows.find(item => item.id === task.workflowId);
  return <li>
    <h3>{tester?.profile.name ?? task.testerId}</h3>
    <p><strong>{workflow?.scenario.label ?? task.workflowId}</strong> · {task.goal}</p>
    {Object.keys(task.inputs).length > 0 && <dl className="suggestion-inputs">{Object.entries(task.inputs).map(([input, value]) =>
      <div key={input}><dt>{fieldName(input)}</dt><dd>{displayValue(value)}</dd></div>)}</dl>}
    <p>{suggestion.reason}</p>
    <details className="studio-disclosure" open>
      <summary>Sources and assumptions</summary>
      <p><strong>Application sources</strong></p>
      <ul>{[...new Set(sourcePaths)].map(path => <li key={path}><code>{path}</code></li>)}</ul>
      {historyRunIds.length > 0 && <>
        <p><strong>Observed runs</strong></p>
        <ul>{[...new Set(historyRunIds)].map(id => <li key={id}><Link href={`/runs/${encodeURIComponent(id)}`}>{id}</Link></li>)}</ul>
      </>}
      {assumptions.length > 0 && <>
        <p><strong>Assumptions</strong></p>
        <ul>{assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
      </>}
    </details>
  </li>;
}
