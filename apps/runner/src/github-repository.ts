import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PatchProposalSchema, type PatchProposal } from '@lastmile/contracts/evolution';
import { hashValue } from './artifacts';

const execFileAsync = promisify(execFile);
const defaultApiOrigin = 'https://api.github.com';
const defaultRemoteOrigin = 'https://github.com';
const requestTimeoutMs = 30_000;
const maxResponseBytes = 8_000_000;
const cloneTimeoutMs = 10 * 60_000;
const gitTimeoutMs = 5 * 60_000;

export type GitHubTransportErrorCode =
  | 'invalid_input' | 'auth' | 'permission' | 'not_found' | 'redirect' | 'stale_base'
  | 'before_mismatch' | 'branch_diverged' | 'api_error' | 'git_failed';
export class GitHubTransportError extends Error {
  constructor(readonly code: GitHubTransportErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubTransportError';
  }
}
const invalid = (message: string) => new GitHubTransportError('invalid_input', message);

export type GitHubRepository = { owner: string; name: string; defaultBranch: string; cloneUrl: string };
export type GitHubPullRequest = { url: string; number: number; branch: string; headSha: string; baseSha: string };
export type PublishVerifiedPatchInput = {
  repositoryUrl: string; baseBranch: string; baseSha: string; repairId: string; patch: PatchProposal;
  title: string; body: string; signal?: AbortSignal;
};
export type GitHubRepositoryClient = {
  inspectRepository(repositoryUrl: string): Promise<GitHubRepository>;
  resolveBranch(repository: Pick<GitHubRepository, 'owner' | 'name'>, branch: string): Promise<{ sha: string }>;
  publishVerifiedPatch(input: PublishVerifiedPatchInput): Promise<GitHubPullRequest>;
};
export type GitHubRepositoryClientOptions = { token: string; apiOrigin?: string; fetch?: typeof fetch };
export type CloneRepositoryInput = {
  repositoryUrl: string; directory: string; branch: string; token: string; signal?: AbortSignal; remoteOrigin?: string;
};
export type SyncRepositoryInput = CloneRepositoryInput;

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const namePattern = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const repositoryUrlPattern = /^https:\/\/github\.com\/([^/?#\\@:]+)\/([^/?#\\@:]+?)(?:\.git)?\/?$/;
const sha1Pattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const loopbackOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;

export function parseGitHubRepositoryUrl(repositoryUrl: string): { owner: string; name: string; cloneUrl: string } {
  const match = typeof repositoryUrl === 'string' ? repositoryUrlPattern.exec(repositoryUrl) : null;
  // Never echo the rejected value: it may carry credentials.
  if (!match || !ownerPattern.test(match[1]) || !namePattern.test(match[2])) {
    throw invalid('Repository must be a https://github.com/<owner>/<repo> URL');
  }
  return { owner: match[1], name: match[2], cloneUrl: `${defaultRemoteOrigin}/${match[1]}/${match[2]}.git` };
}

export function assertValidBranch(branch: string): void {
  if (
    typeof branch !== 'string' || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.')
    || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
  ) throw invalid('Branch name is not a valid git branch');
}

export const repairBranchName = (repairId: string, patchHash: string): string => {
  if (!idPattern.test(repairId)) throw invalid('Repair id is invalid');
  if (!/^[a-f0-9]{64}$/.test(patchHash)) throw invalid('Patch hash is invalid');
  return `lastmile/${repairId}-${patchHash.slice(0, 12)}`;
};

const assertToken = (token: string) => {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(token)) throw invalid('GitHub token is missing or malformed');
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const blobSha = (value: string) => {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const redactor = (token: string) => {
  const secrets = [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
  return (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text)
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, '[redacted]');
};

const Sha = z.string().regex(sha1Pattern);
const RepoSchema = z.object({
  name: z.string(), default_branch: z.string(), archived: z.boolean().optional(), disabled: z.boolean().optional(),
  owner: z.object({ login: z.string() }), permissions: z.object({ push: z.boolean().optional() }).optional(),
});
const RefSchema = z.object({ ref: z.string(), object: z.object({ sha: Sha, type: z.string() }) });
const CommitSchema = z.object({ sha: Sha, tree: z.object({ sha: Sha }), parents: z.array(z.object({ sha: Sha })) });
const TreeSchema = z.object({
  sha: Sha, truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: Sha })),
});
const BlobSchema = z.object({ sha: Sha });
const CompareSchema = z.object({
  status: z.string(), ahead_by: z.number(), behind_by: z.number(),
  commits: z.array(z.object({ sha: Sha, parents: z.array(z.object({ sha: Sha })) })),
  files: z.array(z.object({ filename: z.string(), status: z.string(), sha: z.string() })).optional(),
});
const repoRef = z.object({ full_name: z.string() }).nullable();
const PullSchema = z.object({
  html_url: z.string(), number: z.number().int().positive(), state: z.string(),
  head: z.object({ ref: z.string(), sha: Sha, repo: repoRef }),
  base: z.object({ ref: z.string(), repo: repoRef }),
});
type Pull = z.infer<typeof PullSchema>;

const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');
const sameRepository = (full: string | undefined, owner: string, name: string) => full?.toLowerCase() === `${owner}/${name}`.toLowerCase();

function validatePatch(patch: PatchProposal, secret: string) {
  const parsed = PatchProposalSchema.safeParse(patch);
  if (!parsed.success) throw invalid('Patch proposal is invalid');
  const { hash, summary, changes } = parsed.data;
  if (hash !== hashValue({ summary, changes })) throw invalid('Patch hash does not match its contents');
  for (const { path, beforeHash, before, after } of changes) {
    if (!path.split('/').every(part => part && part !== '.' && part.toLowerCase() !== '.git')) throw invalid('Patch path is not allowed');
    if (sha256(before) !== beforeHash) throw invalid('Patch before content does not match its hash');
    if (before === after) throw invalid('Patch contains an unchanged file');
    if (after.includes(secret)) throw invalid('Patch content must not contain the GitHub token');
  }
  return { hash, summary, changes };
}

export function createGitHubRepositoryClient({ token, apiOrigin = defaultApiOrigin, fetch: fetchImpl = fetch }: GitHubRepositoryClientOptions): GitHubRepositoryClient {
  assertToken(token);
  if (apiOrigin !== defaultApiOrigin && !loopbackOrigin.test(apiOrigin)) throw invalid('GitHub API origin is not allowed');
  const redact = redactor(token);

  async function call(method: string, path: string, options: { body?: unknown; allow?: number[]; signal?: AbortSignal } = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${apiOrigin}${path}`, {
        method, signal, redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          'user-agent': 'lastmile-qa', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      const cause = error instanceof Error ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}` : '';
      const redirected = /redirect/i.test(cause);
      throw new GitHubTransportError(redirected ? 'redirect' : 'api_error', redirected ? 'GitHub request was redirected and refused' : 'GitHub request failed');
    }
    const status = response.status;
    if (status >= 300 && status < 400) throw new GitHubTransportError('redirect', 'GitHub request was redirected and refused', status);
    const length = Number(response.headers.get('content-length') ?? 0);
    const text = length > maxResponseBytes ? '' : await response.text();
    if (length > maxResponseBytes || text.length > maxResponseBytes) throw new GitHubTransportError('api_error', 'GitHub response is too large', status);
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (response.ok || options.allow?.includes(status)) return { status, data };
    const detail = typeof (data as { message?: unknown } | undefined)?.message === 'string' ? redact((data as { message: string }).message).slice(0, 200) : '';
    const code = status === 401 ? 'auth' : status === 403 ? 'permission' : status === 404 ? 'not_found' : 'api_error';
    throw new GitHubTransportError(code, `GitHub ${method} ${path.split('?')[0]} failed (${status})${detail ? `: ${detail}` : ''}`, status);
  }
  const parse = <T extends z.ZodType>(schema: T, data: unknown, what: string): z.infer<T> => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new GitHubTransportError('api_error', `GitHub returned an unexpected ${what} response`);
    return parsed.data;
  };
  const target = (repository: Pick<GitHubRepository, 'owner' | 'name'>) => {
    if (!ownerPattern.test(repository.owner) || !namePattern.test(repository.name)) throw invalid('Repository is invalid');
    return `/repos/${repository.owner}/${repository.name}`;
  };

  async function inspectRepository(repositoryUrl: string): Promise<GitHubRepository> {
    const requested = parseGitHubRepositoryUrl(repositoryUrl);
    const repo = parse(RepoSchema, (await call('GET', target(requested))).data, 'repository');
    if (repo.owner.login.toLowerCase() !== requested.owner.toLowerCase() || repo.name.toLowerCase() !== requested.name.toLowerCase()) {
      throw new GitHubTransportError('api_error', 'GitHub repository identity does not match the request');
    }
    if (repo.archived || repo.disabled) throw new GitHubTransportError('permission', 'GitHub repository is archived or disabled');
    if (repo.permissions?.push === false) throw new GitHubTransportError('permission', 'GitHub token cannot push to this repository');
    assertValidBranch(repo.default_branch);
    return {
      owner: repo.owner.login, name: repo.name, defaultBranch: repo.default_branch,
      cloneUrl: `${defaultRemoteOrigin}/${repo.owner.login}/${repo.name}.git`,
    };
  }

  async function readRef(repository: Pick<GitHubRepository, 'owner' | 'name'>, branch: string, signal?: AbortSignal) {
    assertValidBranch(branch);
    const { status, data } = await call('GET', `${target(repository)}/git/ref/heads/${encodePath(branch)}`, { allow: [404], signal });
    if (status === 404) return undefined;
    const ref = parse(RefSchema, data, 'branch');
    if (ref.ref !== `refs/heads/${branch}` || ref.object.type !== 'commit') throw new GitHubTransportError('api_error', 'GitHub returned a different branch than requested');
    return { sha: ref.object.sha };
  }

  async function resolveBranch(repository: Pick<GitHubRepository, 'owner' | 'name'>, branch: string) {
    const ref = await readRef(repository, branch);
    if (!ref) throw new GitHubTransportError('not_found', 'GitHub branch does not exist');
    return ref;
  }

  async function findPull(repo: GitHubRepository, branch: string, baseBranch: string, signal?: AbortSignal): Promise<Pull | undefined> {
    const query = `state=all&per_page=100&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`;
    const { data } = await call('GET', `${target(repo)}/pulls?${query}`, { signal });
    const pulls = parse(z.array(PullSchema), data, 'pull request list')
      .filter(pull => pull.head.ref === branch && sameRepository(pull.head.repo?.full_name, repo.owner, repo.name));
    const matching = pulls.filter(pull => pull.base.ref === baseBranch && sameRepository(pull.base.repo?.full_name, repo.owner, repo.name));
    if (!matching.length && pulls.length) throw new GitHubTransportError('branch_diverged', 'The repair branch already has a pull request against a different base');
    return matching.find(pull => pull.state === 'open') ?? matching[0];
  }

  async function verifyBranchCommit(repo: GitHubRepository, baseSha: string, headSha: string, changes: PatchProposal['changes'], signal?: AbortSignal) {
    const compare = parse(CompareSchema, (await call('GET', `${target(repo)}/compare/${baseSha}...${headSha}`, { signal })).data, 'comparison');
    const files = compare.files ?? [];
    const expected = new Map(changes.map(change => [change.path, blobSha(change.after)]));
    const exact = compare.status === 'ahead' && compare.ahead_by === 1 && compare.behind_by === 0
      && compare.commits.length === 1 && compare.commits[0].sha === headSha && compare.commits[0].parents.length === 1 && compare.commits[0].parents[0].sha === baseSha
      && files.length === expected.size && files.every(file => file.status === 'modified' && expected.get(file.filename) === file.sha);
    if (!exact) throw new GitHubTransportError('branch_diverged', 'The repair branch already exists with different content; refusing to overwrite it');
  }

  async function publishVerifiedPatch(input: PublishVerifiedPatchInput): Promise<GitHubPullRequest> {
    const { signal } = input;
    const { hash, summary, changes } = validatePatch(input.patch, token);
    assertValidBranch(input.baseBranch);
    const baseSha = typeof input.baseSha === 'string' ? input.baseSha.toLowerCase() : '';
    if (!sha1Pattern.test(baseSha)) throw invalid('Base sha is invalid');
    const branch = repairBranchName(input.repairId, hash);
    if (branch === input.baseBranch) throw invalid('Repair branch must differ from the base branch');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || /[\r\n]/.test(input.title)) throw invalid('Pull request title is invalid');
    if (typeof input.body !== 'string' || input.body.length > 60000) throw invalid('Pull request body is invalid');
    if ([input.title, input.body, summary].some(text => text.includes(token))) throw invalid('Pull request text must not contain the GitHub token');

    const repo = await inspectRepository(input.repositoryUrl);
    const existing = await findPull(repo, branch, input.baseBranch, signal);
    const ref = await readRef(repo, branch, signal);
    if (existing) {
      if (existing.state === 'open' && ref?.sha !== existing.head.sha) throw new GitHubTransportError('branch_diverged', 'The repair branch no longer matches its pull request; refusing to overwrite it');
      await verifyBranchCommit(repo, baseSha, existing.head.sha, changes, signal);
      return pullResult(repo, existing, branch, existing.head.sha, baseSha);
    }

    const tip = await readRef(repo, input.baseBranch, signal);
    if (!tip) throw new GitHubTransportError('not_found', 'GitHub base branch does not exist');
    if (tip.sha !== baseSha) throw new GitHubTransportError('stale_base', 'The base branch moved since verification; refusing to publish against a stale base');

    const baseCommit = parse(CommitSchema, (await call('GET', `${target(repo)}/git/commits/${baseSha}`, { signal })).data, 'commit');
    const trees = new Map<string, z.infer<typeof TreeSchema>['tree']>();
    const readTree = async (sha: string) => {
      const cached = trees.get(sha);
      if (cached) return cached;
      const tree = parse(TreeSchema, (await call('GET', `${target(repo)}/git/trees/${sha}`, { signal })).data, 'tree');
      if (tree.truncated) throw new GitHubTransportError('api_error', 'GitHub tree is too large to inspect');
      trees.set(sha, tree.tree);
      return tree.tree;
    };
    const modes = new Map<string, string>();
    for (const { path, before } of changes) {
      const parts = path.split('/');
      let treeSha = baseCommit.tree.sha;
      let entry: z.infer<typeof TreeSchema>['tree'][number] | undefined;
      for (const [index, part] of parts.entries()) {
        entry = (await readTree(treeSha)).find(candidate => candidate.path === part);
        if (!entry || (index < parts.length - 1 && entry.type !== 'tree')) { entry = undefined; break; }
        treeSha = entry.sha;
      }
      if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new GitHubTransportError('before_mismatch', 'A patched file is missing or is not a regular file at the base commit');
      if (entry.sha !== blobSha(before)) throw new GitHubTransportError('before_mismatch', 'A patched file does not match the verified before content at the base commit');
      modes.set(path, entry.mode);
    }

    let headSha = ref?.sha;
    if (headSha) await verifyBranchCommit(repo, baseSha, headSha, changes, signal);
    else {
      const entries = [];
      for (const { path, after } of changes) {
        const blob = parse(BlobSchema, (await call('POST', `${target(repo)}/git/blobs`, { body: { content: Buffer.from(after, 'utf8').toString('base64'), encoding: 'base64' }, signal })).data, 'blob');
        if (blob.sha !== blobSha(after)) throw new GitHubTransportError('api_error', 'GitHub stored different blob content than requested');
        entries.push({ path, mode: modes.get(path), type: 'blob', sha: blob.sha });
      }
      const tree = parse(TreeSchema, (await call('POST', `${target(repo)}/git/trees`, { body: { base_tree: baseCommit.tree.sha, tree: entries }, signal })).data, 'tree');
      const message = `${input.title.trim()}\n\n${summary}\n\nlastmile repair ${input.repairId}\npatch ${hash}`;
      const commit = parse(CommitSchema, (await call('POST', `${target(repo)}/git/commits`, { body: { message, tree: tree.sha, parents: [baseSha] }, signal })).data, 'commit');
      const created = await call('POST', `${target(repo)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.sha }, allow: [422], signal });
      if (created.status === 422) {
        // Lost a race with a concurrent identical publish: accept only the same verified content.
        const raced = await readRef(repo, branch, signal);
        if (!raced) throw new GitHubTransportError('api_error', 'GitHub rejected the repair branch');
        await verifyBranchCommit(repo, baseSha, raced.sha, changes, signal);
        headSha = raced.sha;
      } else headSha = commit.sha;
    }

    const pullBody = { title: input.title.trim(), head: branch, base: input.baseBranch, body: input.body, maintainer_can_modify: false };
    const created = await call('POST', `${target(repo)}/pulls`, { body: pullBody, allow: [422], signal });
    const pull = created.status === 422 ? await findPull(repo, branch, input.baseBranch, signal) : parse(PullSchema, created.data, 'pull request');
    if (!pull) throw new GitHubTransportError('api_error', 'GitHub rejected the pull request');
    if (pull.head.sha !== headSha) throw new GitHubTransportError('branch_diverged', 'The pull request head does not match the verified commit');
    return pullResult(repo, pull, branch, headSha, baseSha);
  }

  function pullResult(repo: GitHubRepository, pull: Pull, branch: string, headSha: string, baseSha: string): GitHubPullRequest {
    if (!pull.html_url.startsWith(`${defaultRemoteOrigin}/${repo.owner}/${repo.name}/pull/`)) throw new GitHubTransportError('api_error', 'GitHub returned an unexpected pull request URL');
    if (!sameRepository(pull.head.repo?.full_name, repo.owner, repo.name) || !sameRepository(pull.base.repo?.full_name, repo.owner, repo.name)) {
      throw new GitHubTransportError('api_error', 'Pull request must stay inside the requested repository');
    }
    return { url: pull.html_url, number: pull.number, branch, headSha, baseSha };
  }

  return { inspectRepository, resolveBranch, publishVerifiedPatch };
}

// ---- Local git helpers ---------------------------------------------------------------------

function remoteFor(input: CloneRepositoryInput) {
  const repo = parseGitHubRepositoryUrl(input.repositoryUrl);
  assertValidBranch(input.branch);
  assertToken(input.token);
  if (typeof input.directory !== 'string' || !isAbsolute(input.directory)) throw invalid('Checkout directory must be an absolute path');
  const origin = input.remoteOrigin ?? defaultRemoteOrigin;
  // remoteOrigin exists only so tests can point at a local fixture; it can never be a remote host.
  if (origin !== defaultRemoteOrigin && !loopbackOrigin.test(origin) && !/^file:\/\/\/[^?#\s]*[^/?#\s]$/.test(origin)) throw invalid('Remote origin is not allowed');
  return { remote: `${origin}/${repo.owner}/${repo.name}.git`, origin, scheme: origin.slice(0, origin.indexOf(':')) };
}

function gitEnvironment(scheme: string, credentials?: { origin: string; token: string }) {
  const env: Record<string, string> = {};
  // Allowlist: drop inherited credentials (GITHUB_PAT, GIT_ASKPASS, SSH agents, ...) and user git config.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_ALLOW_PROTOCOL: scheme, GIT_OPTIONAL_LOCKS: '0',
  });
  if (credentials) {
    // Scoped to the one origin and held only in this child's environment: never argv, never .git/config.
    const basic = Buffer.from(`x-access-token:${credentials.token}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${credentials.origin}/.extraheader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    });
  }
  return env;
}

async function git(cwd: string | undefined, args: string[], options: { env: Record<string, string>; token: string; signal?: AbortSignal; timeoutMs?: number }) {
  const safe = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'http.followRedirects=false', '-c', 'advice.detachedHead=false'];
  const label = args.find(arg => !arg.startsWith('-')) ?? 'git';
  try {
    const { stdout } = await execFileAsync('git', [...safe, ...args], {
      cwd, env: options.env, encoding: 'utf8', maxBuffer: 1_000_000, timeout: options.timeoutMs ?? gitTimeoutMs, signal: options.signal,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const detail = redactor(options.token)(stderr).trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new GitHubTransportError('git_failed', `git ${label} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function head(run: (args: string[]) => Promise<string>) {
  const sha = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!sha1Pattern.test(sha)) throw new GitHubTransportError('git_failed', 'git did not return a commit');
  return sha;
}

export async function cloneRepository(input: CloneRepositoryInput): Promise<string> {
  const { remote, origin, scheme } = remoteFor(input);
  const { directory, branch, token, signal } = input;
  const exists = await lstat(directory).then(stats => stats, () => undefined);
  if (exists && (!exists.isDirectory() || (await readdir(directory)).length)) throw invalid('Checkout directory already exists and is not empty');
  await mkdir(dirname(directory), { recursive: true });
  const staging = await mkdtemp(join(dirname(directory), `.clone-${basename(directory)}-`));
  try {
    const checkout = join(staging, 'checkout');
    const withToken = { env: gitEnvironment(scheme, { origin, token }), token, signal, timeoutMs: cloneTimeoutMs };
    await git(undefined, ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--branch', branch, '--', remote, checkout], withToken);
    const local = { env: gitEnvironment(scheme), token, signal };
    const run = (args: string[]) => git(checkout, args, local);
    if ((await run(['config', '--get', 'remote.origin.url'])).trim() !== remote) throw new GitHubTransportError('git_failed', 'Cloned origin does not match the requested repository');
    const sha = await head(run);
    if (exists) await rmdir(directory);
    await rename(checkout, directory);
    return sha;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function syncRepository(input: SyncRepositoryInput): Promise<string> {
  const { remote, origin, scheme } = remoteFor(input);
  const { branch, token, signal } = input;
  const directory = await realpath(input.directory).catch(() => { throw invalid('Checkout directory does not exist'); });
  const local = { env: gitEnvironment(scheme), token, signal };
  const run = (args: string[]) => git(directory, args, local);
  const top = await run(['rev-parse', '--show-toplevel']).catch(() => '');
  if (!top || await realpath(top.trim()).catch(() => '') !== directory) throw invalid('Checkout directory is not the root of a git checkout');
  if ((await run(['config', '--get', 'remote.origin.url']).catch(() => '')).trim() !== remote) throw invalid('Checkout origin does not match the requested repository');
  // Tracked changes would be lost or mixed in; untracked/ignored files (runtime databases) are never touched.
  if ((await run(['status', '--porcelain=v1', '-z', '--untracked-files=no'])).length) throw invalid('Checkout has tracked local changes; refusing to sync');
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  await git(directory, ['fetch', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', remote, refspec], { env: gitEnvironment(scheme, { origin, token }), token, signal });
  const target = (await run(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim();
  await run(['checkout', '--quiet', '-B', branch, target]);
  const sha = await head(run);
  if (sha !== target) throw new GitHubTransportError('git_failed', 'Checkout did not land on the fetched commit');
  return sha;
}
