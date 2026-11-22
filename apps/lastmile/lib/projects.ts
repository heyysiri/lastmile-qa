import { z } from 'zod';
import { ConnectGitHubProjectSchema, type ConnectGitHubProjectRequest, type ProjectRepair, type ProjectRun } from '@lastmile/contracts/projects';
import { ApiFailure } from './api';

export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const projectRunHref = (id: string, runId: string) => `${projectHref(id)}/runs/${encodeURIComponent(runId)}`;
export const projectRepairHref = (id: string) => `/project-repairs/${encodeURIComponent(id)}`;
export const projectRequestId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const projectRefreshRequest = z.object({ requestId: projectRequestId });
export const canPrepareProjectRepair = (run: ProjectRun) => run.status === 'completed'
  && run.results.some(result => result.run.verdict === 'failed')
  && run.findings.some(finding => finding.confidence === 'confirmed' && finding.failedCheckIds.length > 0);

// A gateway or transport failure can arrive after the write was accepted.
export const connectWasRejected = (error: unknown) => error instanceof ApiFailure
  && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);

export const projectPublishRequest = z.object({ requestId: projectRequestId });
export const repositoryLines = (value: FormDataEntryValue | null) => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export const shortSha = (sha?: string) => sha?.slice(0, 7) ?? '';
export const githubRepoName = (url: string) => url.replace(/\/+$/, '').replace(/\.git$/, '').split('/').slice(-2).join('/');

export function relativeTime(iso: string, now = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// A verified patch that is not yet a pull request can be published again; the patch is never regenerated.
export const canRetryPublish = (job: ProjectRepair) => Boolean(job.project.github)
  && job.verification?.outcome === 'verified' && !job.pullRequest && job.status !== 'queued' && job.status !== 'running';

export function buildGitHubConnectRequest(data: FormData, requestId: string, accountCount: number):
  { ok: true; request: ConnectGitHubProjectRequest } | { ok: false; message: string } {
  const field = (name: string) => String(data.get(name) ?? '');
  const custom = field('setup') === 'custom';
  const start = repositoryLines(data.get('start'));
  if (custom && !start.length) return { ok: false, message: 'Enter a start command for the custom setup.' };
  const build = repositoryLines(data.get('build'));
  const install = repositoryLines(data.get('install'));
  const cwd = field('cwd').trim();
  const parsed = ConnectGitHubProjectSchema.safeParse({
    requestId, name: field('name'), repositoryUrl: field('repositoryUrl').trim(), branch: field('branch').trim(),
    brief: field('brief'), requirements: field('requirements'),
    accounts: Array.from({ length: accountCount }, (_, index) => ({
      label: field(`label-${index}`), username: field(`username-${index}`), password: field(`password-${index}`),
    })),
    setup: custom ? 'custom' : 'auto', entryPath: field('entryPath').trim() || '/',
    ...(custom ? {
      install: install.length ? install : undefined,
      commands: { start, build: build.length ? build : undefined, cwd: cwd || undefined },
    } : {}),
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const issue = parsed.error.issues[0];
  const messages: Record<string, string> = {
    repositoryUrl: 'Enter a GitHub repository URL like https://github.com/owner/repo.',
    branch: 'Enter a valid branch name.',
    entryPath: 'The starting page must be a path on your app, beginning with /.',
  };
  return { ok: false, message: messages[String(issue.path[0])] ?? issue.message };
}
