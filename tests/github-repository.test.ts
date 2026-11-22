import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PatchProposalSchema, type PatchProposal } from '../packages/contracts/src/evolution';
import { hashValue } from '../apps/runner/src/artifacts';
import {
  GitHubTransportError, assertValidBranch, cloneRepository, createGitHubRepositoryClient, parseGitHubRepositoryUrl,
  repairBranchName, syncRepository, type GitHubTransportErrorCode,
} from '../apps/runner/src/github-repository';

const token = 'ghp_fixtureTokenForTestsOnly1234567890';
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const blobSha = (value: string) => sha1(`blob ${Buffer.byteLength(value)}\0${value}`);
const repoUrl = 'https://github.com/heyysiri/vendure';

const files = {
  'src/app.ts': { content: 'export const answer = 41;\n', mode: '100644' },
  'src/lib/util.ts': { content: 'export const util = () => 1;\n', mode: '100644' },
  'scripts/run.sh': { content: '#!/bin/sh\necho old\n', mode: '100755' },
  'README.md': { content: '# vendure\n', mode: '100644' },
};
const patchFor = (changes: { path: string; before: string; after: string }[], summary = 'Fix the answer') => {
  const body = { summary, changes: changes.map(change => ({ ...change, beforeHash: sha256(change.before) })) };
  return PatchProposalSchema.parse({ ...body, hash: hashValue(body) });
};
const appPatch = () => patchFor([{ path: 'src/app.ts', before: files['src/app.ts'].content, after: 'export const answer = 42;\n' }]);
const failure = async (promise: Promise<unknown>): Promise<GitHubTransportError> => {
  try { await promise; } catch (error) { return error as GitHubTransportError; }
  throw new Error('Expected the call to fail');
};
const expectCode = async (promise: Promise<unknown>, code: GitHubTransportErrorCode) => {
  const error = await failure(promise);
  expect(error).toBeInstanceOf(GitHubTransportError);
  expect(error.code).toBe(code);
  expect(error.message).not.toContain(token);
  return error;
};

// ---- Fake GitHub REST + Git data API ---------------------------------------------------------

type Entry = { path: string; mode: string; type: 'blob' | 'tree'; sha: string };
type Logged = { method: string; path: string; authorization?: string; body: string };
class FakeGitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, Entry[]>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  refs = new Map<string, string>();
  pulls: { number: number; state: string; head: string; base: string; sha: string }[] = [];
  log: Logged[] = [];
  failOnce: string[] = [];
  redirectRepo = false;
  leakTokenOnError = false;
  pushAllowed = true;
  server!: Server;
  origin = '';

  constructor() {
    const flat = new Map(Object.entries(files).map(([path, file]) => [path, { mode: file.mode, sha: this.blob(file.content) }]));
    const commit = this.commit(this.writeTree(flat), [], 'initial');
    this.refs.set('refs/heads/main', commit);
  }
  blob(content: string) { const sha = blobSha(content); this.blobs.set(sha, content); return sha; }
  writeTree(flat: Map<string, { mode: string; sha: string }>): string {
    const children = new Map<string, Map<string, { mode: string; sha: string }>>();
    const entries: Entry[] = [];
    for (const [path, value] of flat) {
      const [head, ...rest] = path.split('/');
      if (!rest.length) entries.push({ path: head, mode: value.mode, type: 'blob', sha: value.sha });
      else children.set(head, (children.get(head) ?? new Map()).set(rest.join('/'), value));
    }
    for (const [name, child] of children) entries.push({ path: name, mode: '040000', type: 'tree', sha: this.writeTree(child) });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const sha = sha1(JSON.stringify(entries));
    this.trees.set(sha, entries);
    return sha;
  }
  flatten(treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    for (const entry of this.trees.get(treeSha) ?? []) {
      if (entry.type === 'tree') for (const [path, value] of this.flatten(entry.sha, `${prefix}${entry.path}/`)) out.set(path, value);
      else out.set(`${prefix}${entry.path}`, { mode: entry.mode, sha: entry.sha });
    }
    return out;
  }
  commit(tree: string, parents: string[], message: string) {
    const sha = sha1(JSON.stringify({ tree, parents, message }));
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
  tip(branch = 'main') { return this.refs.get(`refs/heads/${branch}`)!; }
  advance(branch: string, path: string, content: string) {
    const parent = this.tip(branch);
    const flat = this.flatten(this.commits.get(parent)!.tree);
    flat.set(path, { mode: '100644', sha: this.blob(content) });
    this.refs.set(`refs/heads/${branch}`, this.commit(this.writeTree(flat), [parent], `advance ${path}`));
  }
  count(match: string) { return this.log.filter(entry => `${entry.method} ${entry.path}`.startsWith(match)).length; }
  writes() { return this.log.filter(entry => entry.method !== 'GET'); }

  async listen() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  close() { this.server.close(); }
  pullJson(pull: FakeGitHub['pulls'][number]) {
    const repo = { full_name: 'heyysiri/vendure' };
    return {
      html_url: `https://github.com/heyysiri/vendure/pull/${pull.number}`, number: pull.number, state: pull.state,
      head: { ref: pull.head, sha: pull.sha, repo }, base: { ref: pull.base, repo },
    };
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url!, this.origin);
    const method = req.method!;
    const path = decodeURIComponent(url.pathname) + url.search;
    this.log.push({ method, path, authorization: req.headers.authorization, body: bodyText });
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
    const failing = this.failOnce.findIndex(match => `${method} ${url.pathname}`.startsWith(match));
    if (failing >= 0) {
      this.failOnce.splice(failing, 1);
      return send(500, { message: this.leakTokenOnError ? `boom ${token}` : 'boom' });
    }
    const body = bodyText ? JSON.parse(bodyText) : {};
    const base = '/repos/heyysiri/vendure';
    if (url.pathname === base && method === 'GET') {
      if (this.redirectRepo) { res.writeHead(301, { location: `${this.origin}/elsewhere` }); return res.end(); }
      return send(200, { name: 'vendure', default_branch: 'main', owner: { login: 'heyysiri' }, permissions: { push: this.pushAllowed } });
    }
    if (url.pathname === '/elsewhere') return send(200, {});
    if (!url.pathname.startsWith(`${base}/`)) return send(404, { message: 'Not Found' });
    const rest = url.pathname.slice(base.length + 1);
    let match: RegExpExecArray | null;
    if (method === 'GET' && (match = /^git\/ref\/(.+)$/.exec(rest))) {
      const ref = `refs/${match[1]}`;
      const sha = this.refs.get(ref);
      return sha ? send(200, { ref, object: { sha, type: 'commit' } }) : send(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (match = /^git\/commits\/(\w+)$/.exec(rest))) {
      const commit = this.commits.get(match[1]);
      return commit ? send(200, { sha: match[1], tree: { sha: commit.tree }, parents: commit.parents.map(sha => ({ sha })) }) : send(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (match = /^git\/trees\/(\w+)$/.exec(rest))) {
      const tree = this.trees.get(match[1]);
      return tree ? send(200, { sha: match[1], tree, truncated: false }) : send(404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === 'git/blobs') {
      expect(body.encoding).toBe('base64');
      return send(201, { sha: this.blob(Buffer.from(body.content, 'base64').toString('utf8')) });
    }
    if (method === 'POST' && rest === 'git/trees') {
      const flat = this.flatten(this.commits.get([...this.commits].find(([, commit]) => commit.tree === body.base_tree)![0])!.tree);
      for (const entry of body.tree) flat.set(entry.path, { mode: entry.mode, sha: entry.sha });
      return send(201, { sha: this.writeTree(flat), tree: [] });
    }
    if (method === 'POST' && rest === 'git/commits') return send(201, { sha: this.commit(body.tree, body.parents, body.message), tree: { sha: body.tree }, parents: body.parents.map((sha: string) => ({ sha })) });
    if (method === 'POST' && rest === 'git/refs') {
      if (this.refs.has(body.ref)) return send(422, { message: 'Reference already exists' });
      this.refs.set(body.ref, body.sha);
      return send(201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
    }
    if (method === 'GET' && (match = /^compare\/(\w+)\.\.\.(\w+)$/.exec(rest))) {
      const [, from, to] = match;
      const chain: string[] = [];
      for (let sha = to; sha && sha !== from; sha = this.commits.get(sha)?.parents[0] as string) chain.unshift(sha);
      const before = this.flatten(this.commits.get(from)!.tree);
      const after = this.flatten(this.commits.get(to)!.tree);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.sha !== after.get(path)?.sha);
      return send(200, {
        status: chain.length ? 'ahead' : 'identical', ahead_by: chain.length, behind_by: 0,
        commits: chain.map(sha => ({ sha, parents: this.commits.get(sha)!.parents.map(parent => ({ sha: parent })) })),
        files: changed.map(path => ({ filename: path, status: before.has(path) ? (after.has(path) ? 'modified' : 'removed') : 'added', sha: after.get(path)?.sha ?? before.get(path)!.sha })),
      });
    }
    if (rest.startsWith('pulls') && method === 'GET') {
      const head = (url.searchParams.get('head') ?? '').replace(/^heyysiri:/, '');
      return send(200, this.pulls.filter(pull => pull.head === head).map(pull => this.pullJson(pull)));
    }
    if (rest === 'pulls' && method === 'POST') {
      if (this.pulls.some(pull => pull.head === body.head && pull.state === 'open')) return send(422, { message: 'A pull request already exists' });
      const pull = { number: this.pulls.length + 7, state: 'open', head: body.head, base: body.base, sha: this.refs.get(`refs/heads/${body.head}`)! };
      this.pulls.push(pull);
      return send(201, this.pullJson(pull));
    }
    return send(404, { message: 'Not Found' });
  }
}

let fake: FakeGitHub;
const clientFor = () => createGitHubRepositoryClient({ token, apiOrigin: fake.origin });
const publishInput = (patch: PatchProposal = appPatch(), overrides: Record<string, unknown> = {}) => ({
  repositoryUrl: repoUrl, baseBranch: 'main', baseSha: fake.tip(), repairId: 'repair_1', patch, title: 'Fix the answer', body: 'Verified by Lastmile.', ...overrides,
});
beforeEach(async () => { fake = new FakeGitHub(); await fake.listen(); });
afterEach(() => fake.close());

describe('input validation', () => {
  it('accepts only github.com owner/repo URLs and never echoes rejected input', () => {
    expect(parseGitHubRepositoryUrl('https://github.com/heyysiri/vendure')).toEqual({ owner: 'heyysiri', name: 'vendure', cloneUrl: 'https://github.com/heyysiri/vendure.git' });
    expect(parseGitHubRepositoryUrl('https://github.com/heyysiri/vendure.git/').name).toBe('vendure');
    for (const bad of [
      'http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com.evil.test/a/b', 'git@github.com:a/b.git', 'ssh://github.com/a/b',
      `https://user:${token}@github.com/a/b`, 'https://github.com:444/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?x=1',
      'https://github.com/a/..', 'https://github.com/-a/b', 'https://github.com/a/b#frag', 'https://github.com\\a\\b', 'file:///tmp/x', '',
    ]) {
      const error = (() => { try { parseGitHubRepositoryUrl(bad); } catch (e) { return e as GitHubTransportError; } })();
      expect(error, bad).toBeInstanceOf(GitHubTransportError);
      expect(error!.code).toBe('invalid_input');
      expect(error!.message).not.toContain(token);
    }
  });

  it('rejects branch names that could be options or ref tricks', () => {
    for (const ok of ['main', 'release/1.2', 'feature_x-1']) expect(() => assertValidBranch(ok)).not.toThrow();
    for (const bad of ['', '-x', '--upload-pack=sh', 'a..b', 'a b', 'a;rm', '$(x)', 'a//b', 'a/', '.hidden', 'a/.b', 'x.lock', 'a.', 'a@{1}', 'a~1', 'a:b', 'a\nb', 'x'.repeat(201)]) {
      expect(() => assertValidBranch(bad), bad).toThrow(GitHubTransportError);
    }
  });

  it('refuses a non-GitHub API origin and a malformed token', () => {
    expect(() => createGitHubRepositoryClient({ token, apiOrigin: 'https://evil.example' })).toThrow(/not allowed/);
    expect(() => createGitHubRepositoryClient({ token: 'short' })).toThrow(/token/);
  });
});

describe('authenticated API contract', () => {
  it('inspects a repository and resolves a branch with the token only in the Authorization header', async () => {
    const client = clientFor();
    const repo = await client.inspectRepository(`${repoUrl}.git`);
    expect(repo).toEqual({ owner: 'heyysiri', name: 'vendure', defaultBranch: 'main', cloneUrl: 'https://github.com/heyysiri/vendure.git' });
    expect(await client.resolveBranch(repo, 'main')).toEqual({ sha: fake.tip() });
    await expectCode(client.resolveBranch(repo, 'missing'), 'not_found');
    await expectCode(client.resolveBranch(repo, '--bad'), 'invalid_input');
    expect(fake.log.length).toBeGreaterThan(0);
    for (const entry of fake.log) {
      expect(entry.authorization).toBe(`Bearer ${token}`);
      expect(entry.path).not.toContain(token);
      expect(entry.body).not.toContain(token);
    }
  });

  it('maps bad credentials, read-only access and redirects to explicit errors without leaking the token', async () => {
    const wrong = createGitHubRepositoryClient({ token: 'ghp_wrongTokenForTestsOnly1234567', apiOrigin: fake.origin });
    const auth = await expectCode(wrong.inspectRepository(repoUrl), 'auth');
    expect(auth.message).not.toContain('ghp_wrongToken');
    fake.pushAllowed = false;
    await expectCode(clientFor().inspectRepository(repoUrl), 'permission');
    fake.pushAllowed = true;
    fake.redirectRepo = true;
    await expectCode(clientFor().inspectRepository(repoUrl), 'redirect');
    expect(fake.count('GET /elsewhere')).toBe(0);
  });

  it('redacts a token that GitHub echoes back in an error', async () => {
    fake.leakTokenOnError = true;
    fake.failOnce.push('GET /repos/heyysiri/vendure');
    const error = await expectCode(clientFor().inspectRepository(repoUrl), 'api_error');
    expect(error.message).toContain('[redacted]');
  });
});

describe('publishVerifiedPatch', () => {
  it('publishes the exact patch as one commit on a deterministic branch and opens a same-repo PR', async () => {
    const patch = patchFor([
      { path: 'src/app.ts', before: files['src/app.ts'].content, after: 'export const answer = 42;\n' },
      { path: 'scripts/run.sh', before: files['scripts/run.sh'].content, after: '#!/bin/sh\necho new\n' },
    ]);
    const base = fake.tip();
    const pr = await clientFor().publishVerifiedPatch(publishInput(patch));
    const branch = repairBranchName('repair_1', patch.hash);
    expect(pr).toMatchObject({ url: 'https://github.com/heyysiri/vendure/pull/7', number: 7, branch, baseSha: base });
    expect(branch).toBe(`lastmile/repair_1-${patch.hash.slice(0, 12)}`);
    expect(pr.headSha).toBe(fake.tip(branch));
    expect(fake.tip()).toBe(base);
    const commit = fake.commits.get(pr.headSha)!;
    expect(commit.parents).toEqual([base]);
    const head = fake.flatten(commit.tree);
    const before = fake.flatten(fake.commits.get(base)!.tree);
    expect(fake.blobs.get(head.get('src/app.ts')!.sha)).toBe('export const answer = 42;\n');
    expect(head.get('scripts/run.sh')).toMatchObject({ mode: '100755' });
    expect(fake.blobs.get(head.get('scripts/run.sh')!.sha)).toBe('#!/bin/sh\necho new\n');
    for (const path of ['src/lib/util.ts', 'README.md']) expect(head.get(path)).toEqual(before.get(path));
    expect(fake.pulls).toEqual([{ number: 7, state: 'open', head: branch, base: 'main', sha: pr.headSha }]);
    expect(commit.message).toContain(patch.hash);
    for (const entry of fake.log) { expect(entry.path).not.toContain(token); expect(entry.body).not.toContain(token); }
  });

  it('returns the same PR on retry without writing anything', async () => {
    const client = clientFor();
    const first = await client.publishVerifiedPatch(publishInput());
    const writes = fake.writes().length;
    expect(await client.publishVerifiedPatch(publishInput())).toEqual(first);
    expect(fake.writes().length).toBe(writes);
    expect(fake.pulls).toHaveLength(1);
    // Even after the base branch has moved on, the existing PR is still the answer.
    fake.advance('main', 'README.md', '# moved\n');
    expect(await client.publishVerifiedPatch(publishInput(appPatch(), { baseSha: first.baseSha }))).toEqual(first);
  });

  it('recovers after a crash between pushing the branch and opening the PR without creating a second commit', async () => {
    const client = clientFor();
    fake.failOnce.push('POST /repos/heyysiri/vendure/pulls');
    await expectCode(client.publishVerifiedPatch(publishInput()), 'api_error');
    const branch = repairBranchName('repair_1', appPatch().hash);
    const pushed = fake.tip(branch);
    const commits = fake.commits.size;
    const pr = await client.publishVerifiedPatch(publishInput());
    expect(pr.headSha).toBe(pushed);
    expect(fake.commits.size).toBe(commits);
    expect(fake.count('POST /repos/heyysiri/vendure/git/refs')).toBe(1);
    expect(fake.pulls).toHaveLength(1);
  });

  it('never overwrites a repair branch whose content differs', async () => {
    const patch = appPatch();
    const branch = repairBranchName('repair_1', patch.hash);
    fake.refs.set(`refs/heads/${branch}`, fake.tip());
    fake.advance(branch, 'src/app.ts', 'export const answer = 99;\n');
    const attacker = fake.tip(branch);
    await expectCode(clientFor().publishVerifiedPatch(publishInput(patch)), 'branch_diverged');
    expect(fake.tip(branch)).toBe(attacker);
    expect(fake.pulls).toHaveLength(0);
    expect(fake.count('POST /repos/heyysiri/vendure/git/refs')).toBe(0);
  });

  it('rejects a branch with extra changes even when the patched file matches', async () => {
    const patch = appPatch();
    const branch = repairBranchName('repair_1', patch.hash);
    fake.refs.set(`refs/heads/${branch}`, fake.tip());
    fake.advance(branch, 'src/app.ts', 'export const answer = 42;\n');
    fake.advance(branch, 'README.md', '# smuggled\n');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(patch)), 'branch_diverged');
  });

  it('refuses an existing PR that targets a different base', async () => {
    const patch = appPatch();
    const branch = repairBranchName('repair_1', patch.hash);
    fake.refs.set(`refs/heads/${branch}`, fake.tip());
    fake.pulls.push({ number: 3, state: 'open', head: branch, base: 'develop', sha: fake.tip() });
    await expectCode(clientFor().publishVerifiedPatch(publishInput(patch)), 'branch_diverged');
  });

  it('fails explicitly and writes nothing when the base moved', async () => {
    const stale = fake.tip();
    fake.advance('main', 'README.md', '# moved\n');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(appPatch(), { baseSha: stale })), 'stale_base');
    expect(fake.writes()).toHaveLength(0);
  });

  it('fails when a before content differs at the base sha, for every change, and writes nothing', async () => {
    fake.advance('main', 'src/lib/util.ts', 'export const util = () => 2;\n');
    const patch = patchFor([
      { path: 'src/app.ts', before: files['src/app.ts'].content, after: 'export const answer = 42;\n' },
      { path: 'src/lib/util.ts', before: files['src/lib/util.ts'].content, after: 'export const util = () => 3;\n' },
    ]);
    await expectCode(clientFor().publishVerifiedPatch(publishInput(patch)), 'before_mismatch');
    expect(fake.writes()).toHaveLength(0);
    const missing = patchFor([{ path: 'src/nope.ts', before: 'x', after: 'y' }]);
    await expectCode(clientFor().publishVerifiedPatch(publishInput(missing)), 'before_mismatch');
    const notAFile = patchFor([{ path: 'src', before: 'x', after: 'y' }]);
    await expectCode(clientFor().publishVerifiedPatch(publishInput(notAFile)), 'before_mismatch');
    expect(fake.writes()).toHaveLength(0);
  });

  it('rejects tampered, traversing and malformed patches before any request', async () => {
    const good = appPatch();
    const requests = () => fake.log.length;
    const tampered = { ...good, changes: [{ ...good.changes[0], after: 'export const answer = 0;\n' }] };
    await expectCode(clientFor().publishVerifiedPatch(publishInput(tampered)), 'invalid_input');
    const forgedBefore = patchFor([{ path: 'src/app.ts', before: files['src/app.ts'].content, after: 'x\n' }]);
    const badBeforeHash = { ...forgedBefore, changes: [{ ...forgedBefore.changes[0], beforeHash: sha256('other') }] };
    await expectCode(clientFor().publishVerifiedPatch(publishInput(badBeforeHash)), 'invalid_input');
    for (const path of ['../outside.ts', '/etc/passwd', '.git/config', 'src/.git/hooks/x', 'src//app.ts', 'src/./app.ts', 'src/app.ts/']) {
      const patch = { ...good, changes: [{ ...good.changes[0], path }] };
      await expectCode(clientFor().publishVerifiedPatch(publishInput(patch as PatchProposal)), 'invalid_input');
    }
    await expectCode(clientFor().publishVerifiedPatch(publishInput(good, { baseBranch: '--force' })), 'invalid_input');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(good, { repairId: '../x' })), 'invalid_input');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(good, { baseSha: 'main' })), 'invalid_input');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(good, { repositoryUrl: 'https://github.com/other/repo' })), 'not_found');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(good, { title: 'multi\nline' })), 'invalid_input');
    await expectCode(clientFor().publishVerifiedPatch(publishInput(good, { body: `leak ${token}` })), 'invalid_input');
    expect(requests()).toBe(1); // only the not_found probe for the other repository reached the server
    expect(fake.writes()).toHaveLength(0);
  });
});

// ---- Local git transport against a real smart-HTTP server ------------------------------------

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();

function serveGit(root: string, expectedToken: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${expectedToken}`).toString('base64')}`) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
      return void res.end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://localhost');
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH!, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method!, PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', REMOTE_USER: 'fixture', REMOTE_ADDR: '127.0.0.1',
      },
    });
    child.stdin.end(body);
    const out: Buffer[] = [];
    for await (const chunk of child.stdout) out.push(chunk as Buffer);
    const raw = Buffer.concat(out);
    const split = raw.indexOf('\r\n\r\n');
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of raw.subarray(0, split).toString().split('\r\n')) {
      const [name, ...value] = line.split(': ');
      if (name.toLowerCase() === 'status') status = Number(value.join(': ').split(' ')[0]);
      else headers[name] = value.join(': ');
    }
    res.writeHead(status, headers);
    res.end(raw.subarray(split + 4));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe('local git transport', () => {
  let dir: string;
  let work: string;
  let bare: string;
  let server: Server;
  let origin: string;
  const savedEnv = { PATH: process.env.PATH, GITHUB_PAT: process.env.GITHUB_PAT };
  const remote = () => `${origin}/heyysiri/vendure.git`;
  const input = (directory: string, overrides: Record<string, unknown> = {}) => ({ repositoryUrl: repoUrl, directory, branch: 'main', token, remoteOrigin: origin, ...overrides });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'github-transport-'));
    work = join(dir, 'work');
    bare = join(dir, 'srv/heyysiri/vendure.git');
    await mkdir(work, { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    await writeFile(join(work, 'tracked.txt'), 'one\n');
    await writeFile(join(work, '.gitignore'), '*.db\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'one');
    await mkdir(join(dir, 'srv/heyysiri'), { recursive: true });
    git(dir, 'clone', '-q', '--bare', work, bare);
    ({ server, origin } = await serveGit(join(dir, 'srv'), token));
  });
  afterEach(async () => {
    server.close();
    process.env.PATH = savedEnv.PATH;
    if (savedEnv.GITHUB_PAT === undefined) delete process.env.GITHUB_PAT; else process.env.GITHUB_PAT = savedEnv.GITHUB_PAT;
    await rm(dir, { recursive: true, force: true });
  });
  const publishUpstream = async (name: string, content: string) => {
    await writeFile(join(work, name), content);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', `change ${name}`);
    git(work, 'push', '-q', bare, 'main');
    return git(work, 'rev-parse', 'HEAD');
  };

  it('clones with the token kept out of argv, inherited env and the stored config', async () => {
    const shims = join(dir, 'shims');
    const logFile = join(dir, 'git-calls.log');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await mkdir(shims);
    await writeFile(join(shims, 'git'), `#!/bin/sh\n{ echo "ARGS:$*"; env | cut -d= -f1 | sed 's/^/ENV:/'; } >> '${logFile}'\nexec '${realGit}' "$@"\n`);
    chmodSync(join(shims, 'git'), 0o755);
    process.env.PATH = `${shims}:${process.env.PATH}`;
    process.env.GITHUB_PAT = token;

    const checkout = join(dir, 'checkouts/vendure');
    const sha = await cloneRepository(input(checkout));
    expect(sha).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(checkout, 'config', '--get', 'remote.origin.url')).toBe(remote());
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('one\n');

    const calls = await readFile(logFile, 'utf8');
    expect(calls).toContain('ARGS:');
    expect(calls).not.toContain(token);
    expect(calls).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
    expect(calls).not.toMatch(/ENV:(GITHUB_PAT|GIT_ASKPASS|SSH_AUTH_SOCK)\b/);
    const config = await readFile(join(checkout, '.git/config'), 'utf8');
    expect(config).not.toContain(token);
    expect(config).not.toMatch(/extraheader|Authorization/i);
    expect(await readdirNames(join(dir, 'checkouts'))).toEqual(['vendure']);
  });

  it('fails cleanly with a wrong token and leaves nothing behind', async () => {
    const checkout = join(dir, 'checkouts/vendure');
    const error = await expectCode(cloneRepository(input(checkout, { token: 'ghp_wrongTokenForTestsOnly1234567' })), 'git_failed');
    expect(error.message).not.toContain('ghp_wrongToken');
    expect(await readdirNames(join(dir, 'checkouts'))).toEqual([]);
  });

  it('refuses bad urls, branches, origins and non-empty directories', async () => {
    const checkout = join(dir, 'checkouts/vendure');
    await expectCode(cloneRepository(input(checkout, { repositoryUrl: 'https://example.com/a/b' })), 'invalid_input');
    await expectCode(cloneRepository(input(checkout, { branch: '--upload-pack=touch /tmp/pwned' })), 'invalid_input');
    await expectCode(cloneRepository(input('relative/dir')), 'invalid_input');
    await expectCode(cloneRepository(input(checkout, { remoteOrigin: 'https://evil.example' })), 'invalid_input');
    await expectCode(cloneRepository(input(checkout, { branch: 'does-not-exist' })), 'git_failed');
    await mkdir(join(dir, 'busy'));
    await writeFile(join(dir, 'busy/file'), 'x');
    await expectCode(cloneRepository(input(join(dir, 'busy'))), 'invalid_input');
    await mkdir(join(dir, 'empty'));
    expect(await cloneRepository(input(join(dir, 'empty')))).toMatch(/^[a-f0-9]{40}$/);
  });

  it('syncs forward, preserving untracked runtime files', async () => {
    const checkout = join(dir, 'checkout');
    await cloneRepository(input(checkout));
    await writeFile(join(checkout, 'runtime.db'), 'live data');
    await writeFile(join(checkout, 'scratch.log'), 'untracked');
    const next = await publishUpstream('tracked.txt', 'two\n');
    expect(await syncRepository(input(checkout))).toBe(next);
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('two\n');
    expect(await readFile(join(checkout, 'runtime.db'), 'utf8')).toBe('live data');
    expect(await readFile(join(checkout, 'scratch.log'), 'utf8')).toBe('untracked');
    expect(await syncRepository(input(checkout))).toBe(next);
  });

  it('refuses to sync over tracked changes, a foreign origin or a nested directory', async () => {
    const checkout = join(dir, 'checkout');
    const first = await cloneRepository(input(checkout));
    const next = await publishUpstream('tracked.txt', 'two\n');
    await writeFile(join(checkout, 'tracked.txt'), 'local edit\n');
    await expectCode(syncRepository(input(checkout)), 'invalid_input');
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('local edit\n');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(first);
    git(checkout, 'checkout', '--', 'tracked.txt');
    git(checkout, 'remote', 'set-url', 'origin', `${origin}/other/repo.git`);
    await expectCode(syncRepository(input(checkout)), 'invalid_input');
    git(checkout, 'remote', 'set-url', 'origin', remote());
    await mkdir(join(checkout, 'nested'));
    await expectCode(syncRepository(input(join(checkout, 'nested'))), 'invalid_input');
    await expectCode(syncRepository(input(join(dir, 'missing'))), 'invalid_input');
    expect(await syncRepository(input(checkout))).toBe(next);
  });

  it('does not overwrite an untracked file that would collide with an incoming tracked file', async () => {
    const checkout = join(dir, 'checkout');
    const first = await cloneRepository(input(checkout));
    await writeFile(join(checkout, 'incoming.txt'), 'precious local file');
    await publishUpstream('incoming.txt', 'from upstream');
    await expectCode(syncRepository(input(checkout)), 'git_failed');
    expect(await readFile(join(checkout, 'incoming.txt'), 'utf8')).toBe('precious local file');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(first);
  });
});

const readdirNames = (directory: string) => readdir(directory).then(names => names.sort(), () => [] as string[]);
