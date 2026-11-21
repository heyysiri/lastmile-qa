'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, FolderGit2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConnectProjectSchema, MAX_PROJECT_TESTERS, type ConnectProjectRequest } from '@lastmile/contracts/projects';
import { api, ApiFailure, useLoad } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { connectWasRejected, projectHref, projectRequestId } from '../lib/projects';
import { StudioError, TesterFace } from './Studio';
import { Dialog, DialogContent, DialogTrigger } from './primitives';
import { Pending } from './ui';

const pendingKey = 'lastmile-pending-project-connection';
const lines = (value: FormDataEntryValue | null) => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export function ProjectsList() {
  const projects = useLoad(api.projects);
  const health = useLoad(api.health);
  const ready = health.data?.projectDiscoveryReady === true && !health.error;


  return <div className="studio project-studio">
    <header className="directory-hero">
      <div><span className="workspace-eyebrow">Persistent AI users for your app</span>
        <h1>New release.<br />Same users.</h1>
        <p>Your AI users return, pick up where they left off, and test what changed. Find the failure. Verify the fix.</p>
      </div>
      <div className="directory-illustration" aria-hidden="true">
        <span className="orbit-label label-one">Different people.</span>
        <div className="hero-faces"><TesterFace index={0} /><TesterFace index={1} /><TesterFace index={2} /></div>
        <span className="orbit-label label-two">Unexpected discoveries.</span>
      </div>
    </header>
    <StudioError error={health.error} onRetry={health.reload} />
    <section className="project-directory" aria-labelledby="connected-projects">
      <div className="directory-heading"><h2 id="connected-projects">Your projects <span>{projects.data?.length ?? '–'}</span></h2>
        <ConnectProject ready={ready} checkingHealth={health.loading} />
      </div>
      <StudioError error={projects.error} onRetry={projects.reload} />
      {projects.loading && !projects.data && <Pending label="Loading projects…" />}
      {projects.data?.length === 0 && <div className="directory-empty">
        <FolderGit2 size={30} aria-hidden="true" /><h3>Meet your first test team</h3>
        <p>Connect a repository and its running app to get started.</p>
      </div>}
      <ul className="project-grid">{projects.data?.map((project, index) => <li key={project.id}>
        <Link href={projectHref(project.id)} className="project-tile">
          <div className="project-tile-top"><span className={`project-monogram tone-${index % 3}`} aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
            <span className="project-list-status" data-status={project.status}><i />{project.status === 'discovering' ? 'Getting to know your app' : project.status === 'failed' ? 'Needs attention' : 'Ready to test'}</span>
          </div>
          <h3>{project.name}</h3><p>{project.appUrl}</p>
          <div className="project-tile-footer"><span>Open workspace</span><ArrowUpRight size={19} aria-hidden="true" /></div>
        </Link>
      </li>)}</ul>
    </section>
  </div>;
}

function ConnectProject({ ready, checkingHealth }: { ready: boolean; checkingHealth: boolean }) {
  const [open, setOpen] = useState(false);
  const draft = useRef<Record<string, string>>({});
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const lock = useRef(false);
  const [accountCount, setAccountCount] = useState(0);
  const [restored, setRestored] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const [canResend, setCanResend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    try {
      const saved = projectRequestId.safeParse(sessionStorage.getItem(pendingKey));
      if (saved.success) {
        setOpen(true);
        setPendingId(saved.data);
        void lookup(saved.data);
      }
    } catch { /* Retain the request ID in memory when storage is unavailable. */ }
    setRestored(true);
    // Look up a restored ID once, without replaying the connection POST.
  }, []);

  function retain(id?: string) {
    setPendingId(id);
    try {
      if (id) sessionStorage.setItem(pendingKey, id);
      else sessionStorage.removeItem(pendingKey);
    } catch { /* Retain the request ID in memory when storage is unavailable. */ }
  }

  function connected(id: string) {
    draft.current = {};
    form.current?.reset();
    setAccountCount(0);
    retain(undefined);
    router.replace(projectHref(id));
  }

  async function lookup(id: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await api.projectByRequest(id);
      if (!response?.id) throw new Error('The connection response was incomplete. Check the connection again.');
      connected(response.id);
    } catch (problem) {
      if (problem instanceof ApiFailure && problem.status === 404) setCanResend(true);
      else setError(problem);
      lock.current = false;
      setBusy(false);
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !restored || lock.current || (pendingId && !canResend)) return;
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '');
    const build = lines(data.get('build'));
    const start = lines(data.get('start'));
    const cwd = field('cwd').trim();
    const databasePath = field('databasePath').trim();
    const runtimeFiles = lines(data.get('runtimeFiles'));
    const input: ConnectProjectRequest = {
      requestId: pendingId ?? newRequestId(),
      name: field('name'), repositoryPath: field('repositoryPath').trim(),
      appUrl: field('appUrl').trim(), brief: field('brief'), requirements: field('requirements'),
      allowedOrigins: lines(data.get('allowedOrigins')),
      accounts: Array.from({ length: accountCount }, (_, index) => ({
        label: field(`label-${index}`), username: field(`username-${index}`), password: field(`password-${index}`),
      })),
      commands: start.length || build.length || cwd || databasePath || runtimeFiles.length
        ? { start, build: build.length ? build : undefined, cwd: cwd || undefined, databasePath: databasePath || undefined, runtimeFiles:runtimeFiles.length?runtimeFiles:undefined }
        : undefined,
    };
    // Check URL syntax before the shared refinement constructs a URL.
    if (!URL.canParse(input.appUrl)) {
      setError('Enter a valid URL for the running app.');
      return;
    }
    if (input.allowedOrigins.some(origin => !URL.canParse(origin))) {
      setError('Enter a valid URL for each additional allowed origin.');
      return;
    }
    const parsed = ConnectProjectSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue.path[0] === 'commands' && !start.length ? 'Enter a start command for private repair verification.' : issue.message);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    setCanResend(false);
    retain(input.requestId);
    try {
      const result = await api.connectProject(parsed.data);
      if (!result?.id) throw new Error('The connection response was incomplete.');
      connected(result.id);
    } catch (problem) {
      if (connectWasRejected(problem)) retain(undefined);
      setError(problem);
      lock.current = false;
      setBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><button type="button"><Plus size={17} aria-hidden="true" />New project</button></DialogTrigger>
    <DialogContent title="Connect a project" description="Start your app locally. We’ll read its code and explore it with your users in mind.">
    <div className="project-connect">
    <form ref={form} onSubmit={connect} onChange={event => {
      const input = event.target;
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) draft.current[input.name] = input.value;
    }} onInvalidCapture={event => {
      const disclosure = (event.target as HTMLElement).closest('details');
      if (disclosure) disclosure.open = true;
    }}>
      <fieldset className="plain-fieldset" disabled={busy}>
        <div className="studio-fields">
          <label className="field"><span>Project name</span><input name="name" defaultValue={draft.current.name ?? ''} required maxLength={100} /></label>
          <label className="field"><span>Running app URL</span><input name="appUrl" defaultValue={draft.current.appUrl ?? ''} type="url" placeholder="http://localhost:8080" required /></label>
        </div>
        <label className="field"><span>Repository path</span><input name="repositoryPath" defaultValue={draft.current.repositoryPath ?? ''} placeholder="/path/to/your/repository" required maxLength={2000} /></label>
        <label className="field"><span>Audience and intent</span><textarea name="brief" defaultValue={draft.current.brief ?? ''} className="short compact" rows={2} placeholder="Who uses the app, and what do they need to do?" required maxLength={3000} /></label>
        <details className="project-disclosure">
          <summary>Add requirements</summary>
          <label className="field"><span className="sr-only">Requirements</span><textarea name="requirements" defaultValue={draft.current.requirements ?? ''} className="short compact" maxLength={12000} /></label>
        </details>
        <details className="project-disclosure">
          <summary>Advanced connection setup</summary>
          <div className="project-setup">
            <h3>Development accounts</h3>
            <p className="field-hint">Add up to {MAX_PROJECT_TESTERS} existing accounts for access. Personas are generated for you. Multiple personas can share an account and business data, with separate browser storage.</p>
            {Array.from({ length: accountCount }, (_, index) => <fieldset className="plain-fieldset project-account" key={index}>
              <legend>Account {index + 1}</legend>
              <label className="field"><span>Role or label</span><input name={`label-${index}`} defaultValue={draft.current[`label-${index}`] ?? ''} autoComplete="off" required maxLength={100} /></label>
              <div className="studio-fields">
                <label className="field"><span>Username</span><input name={`username-${index}`} defaultValue={draft.current[`username-${index}`] ?? ''} autoComplete="off" required maxLength={300} /></label>
                <label className="field"><span>Password</span><input name={`password-${index}`} defaultValue={draft.current[`password-${index}`] ?? ''} type="password" autoComplete="off" required maxLength={1000} /></label>
              </div>
            </fieldset>)}
            <div className="row">
              {accountCount < MAX_PROJECT_TESTERS && <button type="button" className="text-button" onClick={() => setAccountCount(count => count + 1)}>Add development account</button>}
              {accountCount > 0 && <button type="button" className="text-button" onClick={() => { for (const field of ['label', 'username', 'password']) delete draft.current[`${field}-${accountCount - 1}`]; setAccountCount(count => count - 1); }}>Remove last account</button>}
            </div>
            <label className="field"><span>Additional allowed origins</span><textarea name="allowedOrigins" defaultValue={draft.current.allowedOrigins ?? ''} className="short compact" placeholder="One HTTP origin per line" /></label>
            <h3>Private repair verification</h3>
            <p className="field-hint">These commands run in a private checkout when you verify a fix. Enter the executable on the first line and each argument on its own line.</p>
            <div className="studio-fields">
              <label className="field"><span>Start command</span><textarea name="start" defaultValue={draft.current.start ?? ''} className="short compact" /></label>
              <label className="field"><span>Build command (optional)</span><textarea name="build" defaultValue={draft.current.build ?? ''} className="short compact" /></label>
              <label className="field"><span>Working directory (optional)</span><input name="cwd" defaultValue={draft.current.cwd ?? ''} placeholder="Repository-relative path" /></label>
              <label className="field"><span>Database path (optional)</span><input name="databasePath" defaultValue={draft.current.databasePath ?? ''} placeholder="Repository-relative path" /></label>
            </div>
            <label className="field"><span>Private runtime files (optional)</span><textarea name="runtimeFiles" defaultValue={draft.current.runtimeFiles ?? ''} className="short compact" placeholder="One repository-relative path per line" /></label>
            <p className="field-hint">Files your app needs to start, such as local session configuration. Copied only into the private verification app, never sent to the coding model.</p>
          </div>
        </details>
      </fieldset>
      <StudioError error={error} />
      {pendingId && !busy && !canResend && <p className="field-hint">Check whether the original connection reached the runner.</p>}
      {canResend && <p className="field-hint">No connection was found for this request. Confirm the project details to retry with the same request ID.</p>}
      {!ready && !checkingHealth && <p className="field-hint">The runner’s project discovery service must be ready to connect a project.</p>}
      <div className="project-actions">
        {pendingId && !canResend
          ? <button type="button" disabled={busy} onClick={() => void lookup(pendingId)}>{busy ? 'Checking connection…' : 'Check connection'}</button>
          : <button type="submit" disabled={!restored || busy || !ready}>
            <Plus size={17} aria-hidden="true" />{busy ? 'Connecting…' : canResend ? 'Retry connection' : 'Connect project'}
          </button>}
      </div>
    </form>
    </div>
    </DialogContent>
  </Dialog>;
}
