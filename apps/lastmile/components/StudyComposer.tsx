'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, FlaskConical, Layers3, Plug, Sparkles } from 'lucide-react';
import { StudyBriefSchema, type StudyBrief } from '@lastmile/contracts/studies';
import { ApiFailure, api, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { plural, StudioError, studyHref, TesterFace } from './Studio';
import { Pending } from './ui';

const pendingGenerationKey = 'lastmile-pending-generation';

const example = {
  domain: 'Independent retail',
  audience: 'First-time shop owners setting up a storefront on a phone, and returning sellers updating stock between orders on a laptop.',
};

export function StudyComposer() {
  const router = useRouter();
  const catalog = useLoad(api.applications);
  const studies = useLoad(api.studies);
  const health = useLoad(api.health);
  const [selected, setSelected] = useState('');
  const [domain, setDomain] = useState('');
  const [audience, setAudience] = useState('');
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [generationError, setGenerationError] = useState<unknown>(null);
  const request = useRef<{ key: string; id: string; brief: StudyBrief } | null>(null);
  const submitting = useRef(false);
  const application = catalog.data?.find(app => app.id === selected) ?? catalog.data?.[0];
  const brief = StudyBriefSchema.safeParse({ applicationId: application?.id, domain, audience, count });
  const ready = Boolean(health.data?.modelConfigured && !health.error && application?.workflows.length && !catalog.error);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(pendingGenerationKey);
      if (!raw) return;
      const pending = JSON.parse(raw);
      const parsed = StudyBriefSchema.safeParse(pending.brief);
      if (!parsed.success || typeof pending.id !== 'string' || pending.key !== JSON.stringify(parsed.data)) return;
      request.current = pending;
      setSelected(parsed.data.applicationId);
      setDomain(parsed.data.domain);
      setAudience(parsed.data.audience);
      setCount(parsed.data.count);
    } catch { /* Open-tab retries still work when session storage is unavailable. */ }
  }, []);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !ready || !brief.success) return;
    submitting.current = true;
    setBusy(true);
    setGenerationError(null);
    const payload: StudyBrief = brief.data;
    const key = JSON.stringify(payload);
    if (request.current?.key !== key) request.current = { key, id: newRequestId(), brief: payload };
    try { sessionStorage.setItem(pendingGenerationKey, JSON.stringify(request.current)); } catch { /* Keep the in-memory key. */ }
    try {
      const study = await api.generateStudy({ ...payload, requestId: request.current.id });
      try { sessionStorage.removeItem(pendingGenerationKey); } catch { /* The response is already accepted. */ }
      router.push(studyHref(study.id));
    } catch (error) {
      // A transport error can occur after the runner accepted the request.
      if (error instanceof ApiFailure && ['generation_failed', 'generation_interrupted'].includes(error.code)) {
        request.current = null;
        try { sessionStorage.removeItem(pendingGenerationKey); } catch { /* The next explicit attempt gets a new key. */ }
      }
      setGenerationError(error);
      submitting.current = false;
      setBusy(false);
    }
  }

  return <div className="studio">
    <header className="studio-heading">
      <h1>New study</h1>
      <p>Describe your audience and turn it into a small group of testers with concrete tasks.</p>
    </header>
    <div className="composer-grid">
      <form className="studio-card composer-card" onSubmit={generate} aria-label="Study brief">
        <div className="card-heading">
          <span className="icon-tile"><FlaskConical size={20} aria-hidden="true" /></span>
          <h2>Study brief</h2>
          <button type="button" className="text-button example-button" disabled={busy} onClick={() => {
            setDomain(example.domain);
            setAudience(example.audience);
            setGenerationError(null);
          }}><Sparkles size={15} aria-hidden="true" />Use example brief</button>
        </div>
        <fieldset className="plain-fieldset" disabled={busy}>
          <div className="studio-fields">
            <label className="field"><span>Connected application</span>
              <select value={application?.id ?? ''} onChange={event => setSelected(event.target.value)} disabled={!catalog.data?.length}>
                {!catalog.data?.length && <option value="">{catalog.loading ? 'Loading apps…' : 'No connected apps'}</option>}
                {catalog.data?.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Domain</span>
              <input list="study-domains" value={domain} maxLength={120} placeholder={application?.domain ?? 'e.g. Independent retail'} required onChange={event => setDomain(event.target.value)} />
              <datalist id="study-domains">
                {[...new Set([application?.domain, 'E-commerce', 'Independent retail', 'Small business'].filter(Boolean))].map(option => <option value={option} key={option} />)}
              </datalist>
            </label>
          </div>
          <label className="field audience-field"><span>Audience</span>
            <textarea className="short" value={audience} minLength={20} maxLength={4000} required aria-label="Audience" aria-describedby="audience-hint" placeholder="Who uses this app? What are they trying to get done, and under what conditions?" onChange={event => setAudience(event.target.value)} />
          </label>
          <div id="audience-hint" className="field-hint">At least 20 characters. Use fictional examples and test data.</div>
          <fieldset className="plain-fieldset tester-count">
            <legend>How many testers?</legend>
            <div className="count-options">
              {[1, 2, 3].map(n => <label className="count-option" key={n}>
                <input type="radio" name="count" value={n} aria-label={plural(n, 'tester')} checked={count === n} onChange={() => setCount(n)} />
                <span>{plural(n, 'tester')}</span>
              </label>)}
            </div>
          </fieldset>
        </fieldset>
        <StudioError error={catalog.error ?? health.error} onRetry={() => { void catalog.reload(); void health.reload(); }} />
        {!health.error && health.data && !health.data.modelConfigured && <div className="note warn" role="status">Model credentials are missing. Configure the runner’s OpenAI key to generate studies.</div>}
        {!catalog.loading && !catalog.error && !application?.workflows.length && <div className="note warn" role="status">Connect an app with a supported workflow to generate a study.</div>}
        <StudioError error={generationError} />
        <div className="composer-actions">
          <button type="submit" disabled={busy || !ready || !brief.success}>
            <Sparkles size={17} aria-hidden="true" />{busy ? 'Generating…' : 'Generate study'}
          </button>
          {busy ? <Pending label="Preparing your testers from the connected workflows." /> : <span className="muted">Review the draft before any tests run.</span>}
        </div>
      </form>
      <aside className="composer-aside">
        <section className="tester-intro studio-card" aria-label="About synthetic testers">
          <div className="face-scene">
            <TesterFace index={0} /><TesterFace index={1} /><TesterFace index={2} />
            <Sparkles size={20} aria-hidden="true" />
          </div>
          <h2>Different testers, different journeys</h2>
          <p>Each synthetic tester has a goal, a starting situation, and checks that show whether the task succeeded. Use them to explore product gaps.</p>
        </section>
        <section className="studio-card connection-card" aria-labelledby="connection-title">
          <div className="card-heading"><span className="icon-tile mint"><Plug size={18} aria-hidden="true" /></span><h2 id="connection-title">What the app can test</h2></div>
          {catalog.loading && !catalog.data && <Pending label="Loading connected workflows…" />}
          {application && <>
            <p className="connection-name">{application.name}</p>
            <p className="muted">{application.description}</p>
            <ul className="workflow-list">{application.workflows.map(({ id, scenario, description }) => (
              <li key={id}><strong>{scenario.label}</strong><span>{description}</span></li>
            ))}</ul>
          </>}
          <p className="field-hint">The connected app defines the available workflows and checks. Domain text guides the brief.</p>
        </section>
      </aside>
    </div>

    <section className="studio-card saved-studies" aria-labelledby="saved-title">
      <div className="card-heading"><span className="icon-tile"><Layers3 size={18} aria-hidden="true" /></span><h2 id="saved-title">Saved studies</h2></div>
      {studies.loading && !studies.data && <Pending label="Loading saved studies…" />}
      <StudioError error={studies.error} onRetry={studies.reload} />
      {studies.data?.length === 0 && <p className="muted empty-state">Your generated studies will appear here.</p>}
      <ul className="studio-list">{studies.data?.map(study => <li key={study.id}>
        <Link href={studyHref(study.id)} aria-label={study.title}>
          <span><strong>{study.title}</strong><small>{study.brief.domain} · {plural(study.users.length, 'tester')}</small></span>
          <ArrowRight size={17} aria-hidden="true" />
        </Link>
      </li>)}</ul>
    </section>
  </div>;
}
