import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project, ProjectRepair, ProjectRun, ProjectTesterResult } from '../packages/contracts/src/projects';
import { hashValue } from '../apps/runner/src/artifacts';
import { createProjectRepairRuntime } from '../apps/runner/src/project-repair';
import { hashBytes } from '../apps/runner/src/repair-workspace';
import { scanRepository, sourceReference } from '../apps/runner/src/repository-index';

const roots: string[] = [];
const entry = 'packages/values/src.js';
const code = "module.exports = { primary: 'wrong', control: 'ok' };";
const proof = 'requirements.md';
const requirement = 'Both outputs should be ok.';
const privateFile = 'app/.data/credentials.json';
const originalDb = 'app/.data/app.sqlite';
const secrets = { accounts: [{ id: 'account', label: 'Staff', username: 'staff@example.test', password: 'private-password' }] };
const now = '2026-01-01T00:00:00Z';
const patch = (search = "primary: 'wrong'", replace = "primary: 'ok'") => ({
  summary: 'Correct the primary output',
  changes: [{ path: entry, search, replace }],
});

afterEach(() => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(proposal: unknown = patch()) {
  const root = await mkdtemp(join(tmpdir(), 'project-repair-test-'));
  roots.push(root);
  const repositoryPath = join(root, 'repo');
  const privateRoot = join(root, 'private');
  const workspaceRoot = join(privateRoot, 'repairs');
  const snapshot = join(privateRoot, 'snapshots', 'source-run');
  await Promise.all(['packages/values/dist', 'app/.data', 'node_modules/@fixture', 'node_modules/.vite-temp'].map(path => mkdir(join(repositoryPath, path), { recursive: true })));
  await mkdir(join(snapshot, 'sessions'), { recursive: true });
  const valuesPackage = '{"main":"dist/index.js"}';
  const build = `
    const fs = require('node:fs');
    const copy = require.resolve('@fixture/values');
    fs.copyFileSync('../packages/values/src.js', copy);
    fs.mkdirSync('../node_modules/.vite-temp', { recursive: true });
    fs.writeFileSync('../node_modules/.vite-temp/output', 'private-build-output');
    if (process.env.OPENAI_API_KEY || fs.existsSync('../.env')) process.exit(9);
  `;
  const server = `
    const fs = require('node:fs');
    const http = require('node:http');
    const values = require('@fixture/values');
    if (fs.readFileSync('.data/app.sqlite', 'utf8') !== 'before-run-db') process.exit(10);
    if (fs.readFileSync('.data/credentials.json', 'utf8') !== 'private-runtime-file') process.exit(11);
    if (fs.existsSync('.data/other.json')) process.exit(12);
    fs.writeFileSync('.data/app.sqlite', 'runtime-change');
    http.createServer((req, res) => res.end(JSON.stringify(values))).listen(Number(process.argv[2]), process.env.HOST);
  `;
  const contents = {
    [entry]: code, [proof]: requirement, 'packages/values/package.json': valuesPackage, 'app/build.js': build, 'app/server.js': server,
  };
  const files = Object.entries(contents).map(([path, content]) => ({ path, hash: hashBytes(content) }));
  const sourceVersion = hashValue(files);
  await Promise.all([
    ...Object.entries(contents).map(([path, content]) => writeFile(join(repositoryPath, path), content)),
    writeFile(join(repositoryPath, 'packages/values/dist/index.js'), 'original-output'),
    writeFile(join(repositoryPath, 'node_modules/.vite-temp/output'), 'original-cache'),
    writeFile(join(repositoryPath, '.env'), 'OPENAI_API_KEY=private-provider-key'),
    writeFile(join(repositoryPath, originalDb), 'live-db'),
    writeFile(join(repositoryPath, privateFile), 'live-credentials'),
    writeFile(join(repositoryPath, 'app/.data/other.json'), 'unlisted-runtime-file'),
    symlink(join(repositoryPath, 'packages/values'), join(repositoryPath, 'node_modules/@fixture/values')),
    writeFile(join(snapshot, 'source-manifest.json'), JSON.stringify({ version: sourceVersion, files })),
    writeFile(join(snapshot, 'database.sqlite'), 'before-run-db'),
    writeFile(join(snapshot, 'runtime-files.json'), JSON.stringify({ files: [{ path: privateFile, contentBase64: Buffer.from('private-runtime-file').toString('base64') }] })),
    writeFile(join(snapshot, 'sessions/staff.json'), 'before-run-session'),
  ]);
  const project: Project = {
    id: 'project', name: 'Fixture', repositoryPath, appUrl: 'https://original.test/app?view=staff',
    allowedOrigins: ['https://original.test', 'https://unrelated.test'], accounts: [{ id: 'account', label: 'Staff' }],
    commands: { cwd: 'app', build: [process.execPath, 'build.js'], start: [process.execPath, 'server.js', '{port}'], databasePath: originalDb, runtimeFiles: [privateFile] },
    brief: 'Read outputs', requirements: requirement, status: 'ready', progress: '', createdAt: now, updatedAt: now,
  };
  const sources = [
    { path: entry, startLine: 1, endLine: 1, hash: hashBytes(code), excerpt: code },
    { path: proof, startLine: 1, endLine: 1, hash: hashBytes(requirement), excerpt: requirement },
  ];
  const results: ProjectTesterResult[] = (['primary', 'control'] as const).map(key => {
    const tester: ProjectTesterResult['tester'] = {
      id: key, name: key, role: key, summary: 'Read value', accountId: 'account', context: {
        id: key, label: key, revision: 1, viewport: { width: 1280, height: 800 }, locale: 'en-US',
        preferredLanguage: 'English', familiarity: 'experienced', knownTerms: [], interaction: 'pointer',
        reducedMotion: 'no-preference', network: { mode: 'normal' }, inputs: {},
      },
    };
    const check: ProjectTesterResult['journey']['checks'][number] = {
      id: 'output', label: 'Output', kind: 'text', phase: 'after_reload', expected: 'ok',
      basis: 'requirement', sources, locator: { by: 'text', value: 'Output' },
    };
    const status = key === 'primary' ? 'failed' : 'passed';
    return {
      tester, checks: [{ id: check.id, label: check.label, expected: 'ok', actual: key === 'primary' ? 'wrong' : 'ok', status, phase: check.phase, basis: check.basis, sources }],
      journey: { id: key, testerId: key, title: key, goal: 'Read value', entryPath: '/app', inputs: {}, checks: [check], sources, reason: 'Required output' },
      run: {
        id: key, requestId: key, context: tester.context, inputs: {}, status: 'completed', verdict: status,
        createdAt: now, executionMode: 'deterministic', manifestHash: hashValue(key), steps: [], assertions: [],
        findings: [], capabilities: [], artifacts: [],
        scenario: {
          id: key, label: key, revision: 1, goal: 'Read value', entryPath: '/app', initialStateId: 'snapshot',
          inputSlots: {}, contract: { scope: 'ui_only', assertions: [{ kind: 'visible', id: check.id, locator: check.locator }] },
          investigation: { factors: [], maxAttempts: 4 },
        },
      },
      sessionContinued: true,
    };
  });
  const sourceRun: ProjectRun = {
    id: 'source-run', projectId: project.id, request: { requestId: 'run', mode: 'explore' },
    status: 'completed', phase: 'done', createdAt: now, sourceVersion, results, findings: [], summary: '',
    metrics: { elapsedMs: 0, modelCalls: 3, browserActions: 2, passed: 1, failed: 1, inconclusive: 0 },
  };
  const job: ProjectRepair = {
    id: 'repair', projectId: project.id, request: { requestId: 'request', runId: sourceRun.id },
    status: 'running', phase: 'prepare', createdAt: now, sourceRun, project,
  };
  const seen: { url: string; directory: string }[] = [];
  const replay = vi.fn(async (trial: Project, bindings: typeof secrets, frozen: ProjectRun, sessionRoot: string) => {
    seen.push({ url: trial.appUrl, directory: trial.repositoryPath });
    expect(trial.repositoryPath).not.toBe(repositoryPath);
    expect(new URL(trial.appUrl).pathname + new URL(trial.appUrl).search).toBe('/app?view=staff');
    expect(trial.allowedOrigins).toEqual([new URL(trial.appUrl).origin]);
    expect(bindings).toEqual(secrets);
    expect(await readFile(join(sessionRoot, 'staff.json'), 'utf8')).toBe('before-run-session');
    await writeFile(join(sessionRoot, 'staff.json'), 'runtime-change');
    const values = await fetch(trial.appUrl).then(response => response.json());
    for (const result of frozen.results) {
      const check = result.checks[0];
      check.actual = values[result.journey.id];
      check.status = check.actual === check.expected ? 'passed' : 'failed';
      result.run.verdict = check.status;
      result.run.evidence = {
        buildId: 'private', scenarioHash: 'fixture', policyVersion: 'fixture', model: 'none',
        actions: [], modelCalls: 0, finishedByAgent: false, replayCompatible: true,
      };
    }
    return { ...frozen, metrics: { ...frozen.metrics, modelCalls: 0 } };
  });
  const propose = vi.fn(async (_input: unknown) => proposal);
  const runtime = createProjectRepairRuntime({ workspaceRoot, privateRoot, model: 'fixture', propose, replay });
  async function reviewed() {
    const prepared = await runtime.prepare(job, secrets);
    expect(prepared.error).toBeUndefined();
    expect(prepared.patch?.changes[0].before).toBe(code);
    return { ...job, ...prepared, phase: 'verify' as const, verificationRequest: { requestId: 'review', patchHash: prepared.patch!.hash } };
  }
  return { job, runtime, reviewed, repositoryPath, snapshot, privateRoot, workspaceRoot, seen, propose, replay };
}

it('builds and replays a frozen fix through a private workspace alias without touching the original build or state', async () => {
  const f = await fixture();
  vi.stubEnv('OPENAI_API_KEY', 'inherited-secret');
  try {
    const job = await f.reviewed();
    const freshRuntime = createProjectRepairRuntime({ workspaceRoot: f.workspaceRoot, privateRoot: f.privateRoot, model: 'fixture', propose: f.propose, replay: f.replay });
    const result = await freshRuntime.verify(job, secrets);
    expect(result.outcome).toBe('verified');
    expect(result.results.map(r => r.checks[0].actual)).toEqual(['ok', 'ok']);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(f.propose).toHaveBeenCalledTimes(1);
  const input = JSON.stringify(f.propose.mock.calls[0][0]);
  for (const value of ['wrong', 'control', requirement, entry]) expect(input).toContain(value);
  for (const value of ['private-runtime-file', 'before-run-session', 'before-run-db', 'private-password', 'inherited-secret']) expect(input).not.toContain(value);
  expect(f.seen).toHaveLength(2);
  for (const { directory, url } of f.seen) {
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fetch(url)).rejects.toThrow();
  }
  expect(await readFile(join(f.repositoryPath, entry), 'utf8')).toBe(code);
  expect(await readFile(join(f.repositoryPath, 'packages/values/dist/index.js'), 'utf8')).toBe('original-output');
  expect(await readFile(join(f.repositoryPath, 'node_modules/.vite-temp/output'), 'utf8')).toBe('original-cache');
  expect(await readFile(join(f.repositoryPath, originalDb), 'utf8')).toBe('live-db');
  expect(await readFile(join(f.snapshot, 'database.sqlite'), 'utf8')).toBe('before-run-db');
  expect(await readFile(join(f.snapshot, 'sessions/staff.json'), 'utf8')).toBe('before-run-session');
});

it('builds with indexed cache source and excludes unindexed cache files', async () => {
  const f = await fixture();
  const cacheSource = 'app/cache/prepare.js';
  const scratchFile = 'app/cache/stale.bin';
  await mkdir(join(f.repositoryPath, 'app/cache'));
  await writeFile(join(f.repositoryPath, cacheSource), "module.exports = 'indexed';");
  await writeFile(join(f.repositoryPath, scratchFile), 'runtime cache');
  const buildPath = join(f.repositoryPath, 'app/build.js');
  const build = await readFile(buildPath, 'utf8');
  await writeFile(buildPath, `
    if (require('./cache/prepare') !== 'indexed' || require('node:fs').existsSync('cache/stale.bin')) process.exit(13);
    ${build}
  `);
  const { files, version } = await scanRepository(f.repositoryPath);
  expect(files.map(file => file.path)).toContain(cacheSource);
  f.job.sourceRun.sourceVersion = version;
  await writeFile(join(f.snapshot, 'source-manifest.json'), JSON.stringify({
    version, files: files.map(({ path, hash }) => ({ path, hash })),
  }));

  const job = await f.reviewed();
  expect((await f.runtime.verify(job, secrets)).outcome).toBe('verified');
  expect(await readFile(join(f.repositoryPath, scratchFile), 'utf8')).toBe('runtime cache');
});

it('accepts intact user requirement citations and rejects changed virtual excerpts',async()=>{
 const f=await fixture();const ref=sourceReference('$requirements',hashValue(f.job.project.requirements),f.job.project.requirements);
 for(const result of f.job.sourceRun.results){result.checks[0].sources.push(ref);result.journey.checks[0].sources.push(ref);}
 const job=await f.reviewed();expect((await f.runtime.verify(job,secrets)).outcome).toBe('verified');
 const other=await fixture();other.job.sourceRun.results[0].journey.sources.push({...ref,excerpt:'Invented requirement'});
 expect((await other.runtime.prepare(other.job,secrets)).error).toMatch(/citation|stale/i);
});

it('accepts numeric expectations verified through textual UI readback without changing the frozen expected value',async()=>{
 const f=await fixture();const originalReplay=f.replay.getMockImplementation()!;
 f.job.sourceRun.results[1].checks[0].expected=7;f.job.sourceRun.results[1].checks[0].actual='7';f.job.sourceRun.results[1].journey.checks[0].expected=7;
 f.replay.mockImplementation(async(...args)=>{const result=await originalReplay(...args);result.results[1].checks[0].actual='7';result.results[1].checks[0].status='passed';result.results[1].run.verdict='passed';return result;});
 const job=await f.reviewed();expect((await f.runtime.verify(job,secrets)).outcome).toBe('verified');
});

it.each([
  ['ineffective fix', patch("primary: 'wrong'", "primary: 'still wrong'")],
  ['broken passing control', patch("primary: 'wrong', control: 'ok'", "primary: 'ok', control: 'broken'")],
])('rejects a real check failure from a reviewed %s', async (_name, proposal) => {
  const f = await fixture(proposal);
  expect((await f.runtime.verify(await f.reviewed(), secrets)).outcome).toBe('rejected');
  expect(f.propose).toHaveBeenCalledTimes(1);
});

it.each(['missing check', 'changed expectation', 'changed role', 'model call', 'incompatible replay'] as const)(
  'returns inconclusive when verification has a %s', async scenario => {
    const f = await fixture();
    const job = await f.reviewed();
    const replay = async (...args: Parameters<typeof f.replay>) => {
      const run = await f.replay(...args);
      const [first] = run.results;
      if (scenario === 'missing check') first.checks.pop();
      if (scenario === 'changed expectation') first.checks[0].expected = 'changed';
      if (scenario === 'changed role') first.tester.role = 'changed';
      if (scenario === 'model call') first.run.evidence!.modelCalls = 1;
      if (scenario === 'incompatible replay') first.run.evidence!.replayCompatible = false;
      return run;
    };
    const runtime = createProjectRepairRuntime({ workspaceRoot: f.workspaceRoot, privateRoot: f.privateRoot, model: 'fixture', propose: f.propose, replay });
    expect((await runtime.verify(job, secrets)).outcome).toBe('inconclusive');
    expect(f.propose).toHaveBeenCalledTimes(1);
  },
);

it('refuses stale repository source both before preparation and after review', async () => {
  const f = await fixture();
  const job = await f.reviewed();
  await writeFile(join(f.repositoryPath, entry), code + '\n');
  expect((await f.runtime.prepare(f.job, secrets)).error).toMatch(/source/i);
  expect((await f.runtime.verify(job, secrets)).outcome).toBe('inconclusive');
  expect(f.replay).toHaveBeenCalledTimes(1);
  expect(f.propose).toHaveBeenCalledTimes(1);
});

it('refuses a source manifest missing a file from the frozen source version', async () => {
  const f = await fixture();
  const path = join(f.snapshot, 'source-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files = manifest.files.filter((file: { path: string }) => file.path !== 'app/server.js');
  await writeFile(path, JSON.stringify(manifest));
  expect((await f.runtime.prepare(f.job, secrets)).error).toMatch(/manifest/i);
  expect(f.replay).not.toHaveBeenCalled();
});

it.each(['database.sqlite', 'sessions/staff.json', 'runtime-files.json'])('refuses tampered frozen %s before replay', async path => {
  const f = await fixture();
  const job = await f.reviewed();
  await writeFile(join(f.workspaceRoot, job.id, path), 'tampered snapshot');
  expect((await f.runtime.verify(job, secrets)).outcome).toBe('inconclusive');
  expect(f.replay).toHaveBeenCalledTimes(1);
});

it('refuses a changed reviewed patch before replay', async () => {
  const f = await fixture();
  const job = await f.reviewed();
  job.patch!.changes[0].after += '\n';
  expect((await f.runtime.verify(job, secrets)).outcome).toBe('inconclusive');
  expect(f.replay).toHaveBeenCalledTimes(1);
});

it.each(['missing database', 'build error', 'startup error', 'baseline differs', 'unlisted runtime file'] as const)(
  'does not request a patch after a %s', async scenario => {
    const f = await fixture();
    if (scenario === 'missing database') await rm(join(f.snapshot, 'database.sqlite'));
    if (scenario === 'build error') f.job.project.commands!.build = [process.execPath, '-e', 'process.exit(3)'];
    if (scenario === 'startup error') f.job.project.commands!.start = [process.execPath, '-e', 'process.exit(3)'];
    if (scenario === 'baseline differs') f.job.sourceRun.results[0].checks[0].actual = 'different failure';
    if (scenario === 'unlisted runtime file') {
      await writeFile(join(f.snapshot, 'runtime-files.json'), JSON.stringify({ files: [{ path: 'app/server.js', contentBase64: '' }] }));
    }
    const prepared = await f.runtime.prepare(f.job, secrets);
    expect(prepared.error).toBeTruthy();
    expect(f.propose).not.toHaveBeenCalled();
    expect(await readdir(f.workspaceRoot)).toEqual([]);
    for (const { directory, url } of f.seen) {
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fetch(url)).rejects.toThrow();
    }
  },
);

it.each([
  { path: 'app/build.js', search: 'const fs', replace: 'let fs' },
  { path: proof, search: requirement, replace: 'Output can be wrong.' },
  { path: entry, after: 'module.exports = {};' },
])('rejects a protected or whole-file edit', async change => {
  const f = await fixture({ summary: 'Change source', changes: [change] });
  expect((await f.runtime.prepare(f.job, secrets)).error).toBeTruthy();
  expect(f.propose).toHaveBeenCalledTimes(1);
});
