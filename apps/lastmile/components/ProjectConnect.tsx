'use client';

import { useEffect, useRef, useState, type Dispatch, type FormEvent, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ConnectProjectSchema, MAX_PROJECT_TESTERS, type ConnectProjectRequest, type Project } from '@lastmile/contracts/projects';
import { api, ApiFailure } from '../lib/api';
import { newRequestId } from '../lib/editor';
import { buildGitHubConnectRequest, connectWasRejected, projectHref, projectRequestId, repositoryLines } from '../lib/projects';
import { StudioError } from './Studio';
import { Dialog, DialogContent, DialogTrigger, Tabs, TabsContent, TabsList, TabsTrigger } from './primitives';

type Kind = 'github' | 'local';
const storageKey: Record<Kind, string> = { github: 'lastmile-pending-github-connection', local: 'lastmile-pending-project-connection' };

export type ConnectionSession = {
  restored: boolean; restoredId?: string; pendingId?: string; canResend: boolean; busy: boolean; error: unknown;
  draft: MutableRefObject<Record<string, string>>; accountCount: number; setAccountCount: Dispatch<SetStateAction<number>>;
  setError: (error: unknown) => void;
  lookup: (id: string) => Promise<void>;
  send: (requestId: string, call: () => Promise<Project>) => Promise<void>;
};

/** Connection state outlives the dialog so drafts and uncertain writes survive closing it. */
function useConnectionSession(kind: Kind, onConnected: (id: string) => void): ConnectionSession {
  const draft = useRef<Record<string, string>>({});
  const lock = useRef(false);
  const [accountCount, setAccountCount] = useState(0);
  const [restored, setRestored] = useState(false);
  const [restoredId, setRestoredId] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [canResend, setCanResend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function retain(id?: string) {
    setPendingId(id);
    try {
      if (id) sessionStorage.setItem(storageKey[kind], id);
      else sessionStorage.removeItem(storageKey[kind]);
    } catch { /* Retain the request ID in memory when storage is unavailable. */ }
  }

  function connected(id: string) {
    draft.current = {};
    setAccountCount(0);
    retain(undefined);
    onConnected(id);
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

  async function send(requestId: string, call: () => Promise<Project>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setCanResend(false);
    retain(requestId);
    try {
      const result = await call();
      if (!result?.id) throw new Error('The connection response was incomplete.');
      connected(result.id);
    } catch (problem) {
      if (connectWasRejected(problem)) retain(undefined);
      setError(problem);
      lock.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    try {
      const saved = projectRequestId.safeParse(sessionStorage.getItem(storageKey[kind]));
      if (saved.success) {
        setRestoredId(saved.data);
        setPendingId(saved.data);
        void lookup(saved.data);
      }
    } catch { /* Retain the request ID in memory when storage is unavailable. */ }
    setRestored(true);
    // Look up a restored ID once, without replaying the connection POST.
  }, []);

  return { restored, restoredId, pendingId, canResend, busy, error, draft, accountCount, setAccountCount, setError, lookup, send };
}

export function ConnectProject({ ready, checkingHealth }: { ready: boolean; checkingHealth: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Kind>('github');
  const onConnected = (id: string) => router.replace(projectHref(id));
  const github = useConnectionSession('github', onConnected);
  const local = useConnectionSession('local', onConnected);

  useEffect(() => {
    if (!github.restoredId && !local.restoredId) return;
    setOpen(true);
    setTab(github.restoredId ? 'github' : 'local');
  }, [github.restoredId, local.restoredId]);

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><button type="button"><Plus size={17} aria-hidden="true" />New project</button></DialogTrigger>
    <DialogContent title="Connect a project" description="Choose a GitHub repository. We’ll read its code and explore it with your users in mind.">
      <div className="project-connect">
        <Tabs value={tab} onValueChange={value => setTab(value as Kind)}>
          <TabsList label="Connection source">
            <TabsTrigger value="github"><GitBranch size={16} aria-hidden="true" />GitHub</TabsTrigger>
            <TabsTrigger value="local">Local development</TabsTrigger>
          </TabsList>
          <TabsContent value="github"><GitHubConnectForm ready={ready} checkingHealth={checkingHealth} session={github} /></TabsContent>
          <TabsContent value="local"><LocalConnectForm ready={ready} checkingHealth={checkingHealth} session={local} /></TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  </Dialog>;
}

type FormProps = { ready: boolean; checkingHealth: boolean; session: ConnectionSession };

function FormShell({ session, ready, checkingHealth, submitLabel, resendLabel, busyLabel, onSubmit, children }: FormProps & {
  submitLabel: string; resendLabel: string; busyLabel: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode;
}) {
  const { pendingId, canResend, busy, restored, error, draft } = session;
  return <form onSubmit={onSubmit} onChange={event => {
    const input = event.target;
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) draft.current[input.name] = input.value;
  }} onInvalidCapture={event => {
    const disclosure = (event.target as HTMLElement).closest('details');
    if (disclosure) disclosure.open = true;
  }}>
    <fieldset className="plain-fieldset" disabled={busy}>{children}</fieldset>
    <StudioError error={error} />
    {pendingId && !busy && !canResend && <p className="field-hint">Check whether the original connection reached the runner.</p>}
    {canResend && <p className="field-hint">No connection was found for this request. Confirm the project details to retry with the same request ID.</p>}
    {!ready && !checkingHealth && <p className="field-hint">The runner’s project discovery service must be ready to connect a project.</p>}
    <div className="project-actions">
      {pendingId && !canResend
        ? <button type="button" disabled={busy} onClick={() => void session.lookup(pendingId)}>{busy ? 'Checking connection…' : 'Check connection'}</button>
        : <button type="submit" disabled={!restored || busy || !ready}>
          <Plus size={17} aria-hidden="true" />{busy ? busyLabel : canResend ? resendLabel : submitLabel}
        </button>}
    </div>
  </form>;
}

function AccountFields({ session }: { session: ConnectionSession }) {
  const { draft, accountCount, setAccountCount } = session;
  return <>
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
  </>;
}

export function GitHubConnectForm(props: FormProps) {
  const { session } = props;
  const { draft } = session;
  const [setup, setSetup] = useState(draft.current.setup === 'custom' ? 'custom' : 'auto');

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.ready || !session.restored || session.busy || (session.pendingId && !session.canResend)) return;
    const built = buildGitHubConnectRequest(new FormData(event.currentTarget), session.pendingId ?? newRequestId(), session.accountCount);
    if (!built.ok) {
      session.setError(built.message);
      return;
    }
    await session.send(built.request.requestId, () => api.connectGitHubProject(built.request));
  }

  return <FormShell {...props} onSubmit={connect} submitLabel="Connect from GitHub" resendLabel="Retry connection" busyLabel="Connecting…">
    <label className="field"><span>Project name</span><input name="name" data-autofocus defaultValue={draft.current.name ?? ''} required maxLength={100} /></label>
    <label className="field"><span>Repository URL</span><input name="repositoryUrl" defaultValue={draft.current.repositoryUrl ?? ''} type="url" inputMode="url" placeholder="https://github.com/owner/repo" required /></label>
    <label className="field"><span>Branch</span><input name="branch" defaultValue={draft.current.branch ?? 'main'} autoComplete="off" required maxLength={200} /></label>
    <label className="field"><span>Audience and intent</span><textarea name="brief" defaultValue={draft.current.brief ?? ''} className="short compact" rows={2} placeholder="Who uses the app, and what do they need to do?" required maxLength={3000} /></label>
    <details className="project-disclosure">
      <summary>Add requirements</summary>
      <label className="field"><span className="sr-only">Requirements</span><textarea name="requirements" defaultValue={draft.current.requirements ?? ''} className="short compact" maxLength={12000} /></label>
    </details>
    <details className="project-disclosure">
      <summary>Setup</summary>
      <div className="project-setup">
        <label className="field"><span>Starting page</span><input name="entryPath" defaultValue={draft.current.entryPath ?? '/'} autoComplete="off" /></label>
        <fieldset className="plain-fieldset setup-choice">
          <legend>How should we run it?</legend>
          <label><input type="radio" name="setup" value="auto" checked={setup === 'auto'} onChange={() => setSetup('auto')} />Detected automatically</label>
          <p className="field-hint">We install and start supported projects, such as Vendure, from the repository. Nothing runs on your machine.</p>
          <label><input type="radio" name="setup" value="custom" checked={setup === 'custom'} onChange={() => setSetup('custom')} />Custom commands</label>
        </fieldset>
        {setup === 'custom' && <>
          <p className="field-hint">Enter the executable on the first line and each argument on its own line.</p>
          <div className="studio-fields">
            <label className="field"><span>Install command (optional)</span><textarea name="install" defaultValue={draft.current.install ?? ''} className="short compact" /></label>
            <label className="field"><span>Build command (optional)</span><textarea name="build" defaultValue={draft.current.build ?? ''} className="short compact" /></label>
            <label className="field"><span>Start command</span><textarea name="start" defaultValue={draft.current.start ?? ''} className="short compact" /></label>
            <label className="field"><span>Working directory (optional)</span><input name="cwd" defaultValue={draft.current.cwd ?? ''} placeholder="Repository-relative path" /></label>
          </div>
        </>}
        <AccountFields session={session} />
      </div>
    </details>
  </FormShell>;
}

export function LocalConnectForm(props: FormProps) {
  const { session } = props;
  const { draft } = session;

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.ready || !session.restored || session.busy || (session.pendingId && !session.canResend)) return;
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '');
    const build = repositoryLines(data.get('build'));
    const start = repositoryLines(data.get('start'));
    const cwd = field('cwd').trim();
    const databasePath = field('databasePath').trim();
    const runtimeFiles = repositoryLines(data.get('runtimeFiles'));
    const input: ConnectProjectRequest = {
      requestId: session.pendingId ?? newRequestId(),
      name: field('name'), repositoryPath: field('repositoryPath').trim(),
      appUrl: field('appUrl').trim(), brief: field('brief'), requirements: field('requirements'),
      allowedOrigins: repositoryLines(data.get('allowedOrigins')),
      accounts: Array.from({ length: session.accountCount }, (_, index) => ({
        label: field(`label-${index}`), username: field(`username-${index}`), password: field(`password-${index}`),
      })),
      commands: start.length || build.length || cwd || databasePath || runtimeFiles.length
        ? { start, build: build.length ? build : undefined, cwd: cwd || undefined, databasePath: databasePath || undefined, runtimeFiles: runtimeFiles.length ? runtimeFiles : undefined }
        : undefined,
    };
    // Check URL syntax before the shared refinement constructs a URL.
    if (!URL.canParse(input.appUrl)) {
      session.setError('Enter a valid URL for the running app.');
      return;
    }
    if (input.allowedOrigins.some(origin => !URL.canParse(origin))) {
      session.setError('Enter a valid URL for each additional allowed origin.');
      return;
    }
    const parsed = ConnectProjectSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      session.setError(issue.path[0] === 'commands' && !start.length ? 'Enter a start command for private repair verification.' : issue.message);
      return;
    }
    await session.send(input.requestId, () => api.connectProject(parsed.data));
  }

  return <FormShell {...props} onSubmit={connect} submitLabel="Connect project" resendLabel="Retry connection" busyLabel="Connecting…">
    <p className="field-hint">For a repository and app already running on this machine.</p>
    <div className="studio-fields">
      <label className="field"><span>Project name</span><input name="name" data-autofocus defaultValue={draft.current.name ?? ''} required maxLength={100} /></label>
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
        <AccountFields session={session} />
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
  </FormShell>;
}
