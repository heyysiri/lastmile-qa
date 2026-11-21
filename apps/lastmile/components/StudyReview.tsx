'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ZodError } from 'zod';
import { ArrowRight, ClipboardCheck, Play, Save, Users } from 'lucide-react';
import { compileStudyUser, validateStudyDraft, type Study, type StudyApplication, type StudyDraft, type StudyUser } from '@lastmile/contracts/studies';
import { api, ApiFailure, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { executionHref, plural, StudioBack, StudioError } from './Studio';
import { fieldName } from './RunEvidence';
import { PopulationEnrollment } from './PopulationEnrollment';
import { TesterEditor } from './TesterEditor';
import { Pending } from './ui';

function draftOf({ title, summary, assumptions, users }: Study): StudyDraft {
  return { title, summary, assumptions, users };
}

function restoreDraft(key: string): { draft: StudyDraft; revision: number } | null {
  try {
    const saved = sessionStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

const cleanLines = (lines: string[]) => lines.map(line => line.trim()).filter(Boolean);

export function StudyReview({ id }: { id: string }) {
  const study = useLoad(() => api.study(id), [id]);
  const catalog = useLoad(api.applications);
  const health = useLoad(api.health);
  const application = catalog.data?.find(app => app.id === study.data?.brief.applicationId);

  return <div className="studio">
    <StudioBack />
    <StudioError error={study.error ?? catalog.error} onRetry={() => { void study.reload(); void catalog.reload(); }} />
    {(study.loading || catalog.loading) && (!study.data || !catalog.data) && <Pending label="Loading study draft…" />}
    {study.data && catalog.data && <ReviewEditor key={id} initial={study.data} application={application}
      launchReady={Boolean(health.data?.executionReady && health.data.modelConfigured && !health.error)}
      readinessMessage={health.error ? 'The runner is offline. Reconnect it to launch a study.'
        : health.data && !health.data.modelConfigured ? 'Model credentials are missing. Configure the runner’s OpenAI key to launch.'
        : health.data && !health.data.executionReady ? 'Browser execution is unavailable. Check the runner before launching.' : null}
      checkReadiness={health.reload} />}
  </div>;
}

function ReviewEditor({ initial, application, launchReady, readinessMessage, checkReadiness }: {
  initial: Study; application?: StudyApplication; launchReady: boolean; readinessMessage: string | null; checkReadiness: () => void;
}) {
  const router = useRouter();
  const key = `lastmile-edits-${initial.id}`;
  const [restored] = useState(() => restoreDraft(key));
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => restored?.draft ?? draftOf(initial));
  const [conflict, setConflict] = useState(() => Boolean(restored && restored.revision !== initial.revision));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'save' | 'launch' | 'refresh' | null>(null);
  const lock = useRef(false);
  const launchRequest = useRef<{ revision: number; requestId: string } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  const workflowsAvailable = Boolean(application && draft.users.every(user => application.workflows.some(workflow => workflow.id === user.workflowId)));

  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(key, JSON.stringify({ draft, revision: conflict ? (restored?.revision ?? initial.revision) : saved.revision }));
      else sessionStorage.removeItem(key);
    } catch {
      // The beforeunload guard still protects the active draft when storage is unavailable.
    }
  }, [conflict, dirty, draft, initial.revision, key, restored, saved.revision]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function updateTester(id: string, patch: Partial<StudyUser>) {
    setDraft(current => ({ ...current, users: current.users.map(user => user.id === id ? { ...user, ...patch } : user) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !dirty || !application || conflict) return;
    lock.current = true;
    setBusy('save');
    setError(null);
    try {
      const validated = validateStudyDraft({
        ...draft, assumptions: cleanLines(draft.assumptions),
        users: draft.users.map(user => ({ ...user, assumptions: cleanLines(user.assumptions), context: { ...user.context, knownTerms: cleanLines(user.context.knownTerms) } })),
      }, application);
      const updated = await api.saveStudy(saved.id, { ...validated, revision: saved.revision });
      setSaved(updated);
      setDraft(draftOf(updated));
    } catch (problem) {
      if (problem instanceof ApiFailure && problem.status === 409) setConflict(true);
      if (problem instanceof ZodError) {
        const issue = problem.issues[0];
        const user = issue.path[0] === 'users' && typeof issue.path[1] === 'number' ? draft.users[issue.path[1]] : undefined;
        const field = fieldName(String(issue.path.at(-1) ?? 'Study draft'));
        setError(`${user ? `${user.name || 'Unnamed tester'} · ` : ''}${field}. ${issue.message}`);
      } else setError(problem);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function reloadSaved() {
    if (lock.current || (dirty && !window.confirm('Discard your local edits and load the saved version?'))) return;
    lock.current = true;
    setBusy('refresh');
    setError(null);
    try {
      const latest = await api.study(saved.id);
      setSaved(latest);
      setDraft(draftOf(latest));
      setConflict(false);
    } catch (problem) {
      setError(problem);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function launch() {
    if (lock.current || dirty || conflict || !launchReady || !application || !workflowsAvailable) return;
    lock.current = true;
    setBusy('launch');
    setError(null);
    const pendingKey = `lastmile-pending-launch-${saved.id}`;
    if (!launchRequest.current) {
      try {
        const pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
        if (pending?.revision === saved.revision && typeof pending.requestId === 'string') launchRequest.current = pending;
      } catch { /* Open-tab retries still work when session storage is unavailable. */ }
    }
    if (launchRequest.current?.revision !== saved.revision) launchRequest.current = { revision: saved.revision, requestId: newRequestId() };
    try { sessionStorage.setItem(pendingKey, JSON.stringify(launchRequest.current)); } catch { /* Keep the in-memory key. */ }
    try {
      for (const user of saved.users) compileStudyUser(user, application);
      const execution = await api.launchStudy(saved.id, launchRequest.current);
      try { sessionStorage.removeItem(pendingKey); } catch { /* The response is already accepted. */ }
      router.push(executionHref(execution.studyId, execution.id));
    } catch (problem) {
      if (problem instanceof ApiFailure && problem.status === 409 && problem.code === 'stale_revision') setConflict(true);
      setError(problem);
      lock.current = false;
      setBusy(null);
    }
  }

  return <>
    <header className="studio-heading review-heading">
      <div>
        <h1>{saved.title}</h1>
        <p>{application?.name ?? 'Application unavailable'} · {saved.brief.domain} · {plural(saved.users.length, 'tester')}</p>
      </div>
      <span className={`pill ${dirty ? 'pill-peach' : 'pill-mint'}`} role="status">{dirty ? 'Unsaved changes' : `Saved · revision ${saved.revision}`}</span>
    </header>

    <form className="review-grid" onSubmit={save} noValidate>
      <div className="review-main">
        <section className="studio-card review-overview">
          <div className="card-heading"><span className="icon-tile"><ClipboardCheck size={19} aria-hidden="true" /></span><h2>Review your draft</h2></div>
          <fieldset className="plain-fieldset" disabled={Boolean(busy)}>
            <label className="field"><span>Study title</span><input required maxLength={120} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
            <label className="field"><span>Study summary</span><textarea className="short compact" required maxLength={1000} value={draft.summary} onChange={event => setDraft({ ...draft, summary: event.target.value })} /></label>
            <details className="studio-disclosure" open={draft.assumptions.length > 0 || undefined}>
              <summary>Study assumptions</summary>
              <label className="field"><span className="sr-only">Study assumptions</span><textarea className="short compact" value={draft.assumptions.join('\n')} placeholder="One assumption per line" onChange={event => setDraft({ ...draft, assumptions: event.target.value.split('\n') })} /></label>
            </details>
          </fieldset>
        </section>

        <section aria-labelledby="testers-title">
          <div className="section-heading"><Users size={20} aria-hidden="true" /><h2 id="testers-title">Your testers</h2></div>
          {draft.users.map((user, index) => <TesterEditor key={user.id} user={user} index={index} application={application}
            disabled={Boolean(busy)} onChange={patch => updateTester(user.id, patch)} />)}
        </section>
      </div>

      <aside className="review-sidebar">
        <PopulationEnrollment study={saved} disabled={Boolean(busy) || dirty || conflict || !workflowsAvailable}
          onStale={() => setConflict(true)} />
        <section className="studio-card launch-card" aria-labelledby="run-study-title">
          <div className="card-heading"><span className="icon-tile lilac"><Play size={18} aria-hidden="true" /></span><h2 id="run-study-title">Run this study</h2></div>
          <p>Each tester gets a fresh browser session. The run keeps a snapshot of the saved revision and app build.</p>
          <p className="field-hint">Model usage may incur charges. Each tester has up to 20 model calls, 40 browser actions, and 3 minutes.</p>
          {!workflowsAvailable && <p className="note warn">Choose a connected workflow for every tester before launching.</p>}
          {readinessMessage && <div className="note warn" role="status">{readinessMessage} <button type="button" className="text-button" onClick={checkReadiness}>Check connection</button></div>}
          <StudioError error={error} />
          {conflict && <div className="note warn">
            <p>A newer saved revision is available. Your edits are still in this tab.</p>
            <button type="button" className="text-button" disabled={Boolean(busy)} onClick={reloadSaved}>Reload saved version</button>
          </div>}
          <div className="launch-actions">
            <button type="submit" className="secondary" disabled={Boolean(busy) || !dirty || !workflowsAvailable || conflict}><Save size={16} aria-hidden="true" />{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
            <button type="button" disabled={Boolean(busy) || dirty || conflict || !launchReady || !workflowsAvailable} onClick={launch}>
              {busy === 'launch' ? 'Starting…' : 'Run study'}<ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          {dirty && <p className="field-hint save-hint">Save your edits before running the study.</p>}
        </section>
        <details className="studio-card studio-disclosure brief-card">
          <summary>Original brief</summary>
          <p>{saved.brief.audience}</p>
        </details>
      </aside>
    </form>
  </>;
}
