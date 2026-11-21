import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectDiscovery, ProjectSecrets, SourceReference } from '../packages/contracts/src/projects';
import { createRepositoryBrain } from '../apps/runner/src/project-brain';

const accountId = 'keeper';
const username = 'fixture-keeper@example.test';
const password = 'test-secret-never-share';
const now = '2026-01-02T00:00:00.000Z';
let fixture: string;
let project: Project;
let secrets: ProjectSecrets;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'project-brain-test-'));
  vi.stubEnv('XDG_CACHE_HOME', join(fixture, '.cache'));
  project = {
    id: 'tidal', name: 'Tidal readings', repositoryPath: fixture, appUrl: 'http://localhost:4321', allowedOrigins: [],
    brief: 'A station keeper records tidal readings.', requirements: 'When a reading is saved it must survive a reload.',
    accounts: [{ id: accountId, label: 'Station keeper' }], status: 'discovering', progress: '', createdAt: now, updatedAt: now,
  };
  secrets = { accounts: [{ id: accountId, label: 'Station keeper', username, password }] };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixture, { recursive: true, force: true });
});

function call(turn: number, name: string, input: unknown) {
  return { choices: [{ index: 0, finish_reason: 'tool_calls', delta: { role: 'assistant', tool_calls: [
    { index: 0, id: `call_${turn}`, type: 'function', function: { name, arguments: JSON.stringify(input) } },
  ] } }] };
}

function completion() {
  return { choices: [{ index: 0, finish_reason: 'stop', delta: { role: 'assistant', content: 'Done' } }] };
}

async function setup(route: string, label: string, change?: 'role' | 'path' | 'hash' | 'excerpt' | 'unread' | 'account' | 'reuse' | 'route' | 'selector' | 'basis' | 'identity' | 'multiple') {
  await writeFile(join(fixture, 'station.py'), `from tides import station\nroute = "${route}"\nlabel = "${label}"\n`);
  await writeFile(join(fixture, 'unread.py'), 'protected = "Not looked up"\n');
  const observe = vi.fn(async (_project: Project, _secrets: ProjectSecrets, paths: string[]) => paths.map(path => ({
    path, ...(project.accounts.length ? { accountId } : {}), text: `- textbox "${label}"\n${username} ${password}`, observedAt: now,
  })));
  let turn = 0;
  let source: { citation: string; reference: SourceReference };
  let requirement: { citation: string; reference: SourceReference };
  let submissionResult = '';
  let prompt = '';
  const complete = vi.fn(async (request: unknown) => {
    const body = request as { messages: { role: string; content: string }[]; parallel_tool_calls: boolean };
    expect(JSON.stringify(body)).not.toContain(username);
    expect(JSON.stringify(body)).not.toContain(password);
    expect(body.parallel_tool_calls).toBe(false);
    const result = body.messages.at(-1)?.content ?? '';
    switch (++turn) {
      case 1:
        prompt = JSON.stringify(body.messages);
        return call(turn, 'search_source', { query: label });
      case 2:
        source = (JSON.parse(result) as (typeof source)[])[0];
        return call(turn, 'read_source', { path: '$requirements', startLine: 1, endLine: 1 });
      case 3:
        requirement = JSON.parse(result);
        return call(turn, 'observe_app', { paths: [route] });
      case 4: {
        expect(JSON.parse(result)[0]).toMatchObject({ path: route, text: expect.stringContaining(label) });
        const evidence = { ...source.reference };
        if (change === 'path') evidence.path = 'imaginary.py';
        if (change === 'hash') evidence.hash = '0'.repeat(64);
        if (change === 'excerpt') evidence.excerpt += ' invented ending';
        if (change === 'unread') {
          const { readRepositorySource, scanRepository } = await import('../apps/runner/src/repository-index');
          Object.assign(evidence, await readRepositorySource(await scanRepository(fixture), 'unread.py'));
        }
        const tester = { id: change === 'identity' ? 'replaced' : 'station', name: 'Station keeper',
          role: 'Keeper', summary: 'Records observations.', ...(project.accounts.length
            ? { accountId: change === 'account' ? 'outside' : accountId } : {}) };
        const locator = change === 'role' ? { by: 'role', value: 'checkbox', name: label }
          : { by: 'label', value: change === 'selector' ? 'Unseen control' : label };
        const cited = ['path', 'hash', 'excerpt', 'unread'].includes(change ?? '') ? evidence : source.citation;
        const check = { id: 'saved', label: 'Saved reading', kind: 'field', locator, path: route, expected: '12.9',
          phase: 'after_reload', basis: change === 'basis' ? 'test' : 'requirement', sources: [requirement.citation] };
        const journey = { id: 'record', testerId: tester.id, title: 'Log a tide', goal: 'Record a tidal reading.',
          entryPath: change === 'route' ? '/invented' : route, inputs: { reading: '12.9' }, sources: [cited, requirement.citation],
          checks: [check, { ...check, id: 'reachable', kind: 'visible', phase: 'after_action', basis: 'implementation',
            sources: [source.citation], expected: undefined }], reason: 'Record and read back a station measurement.' };
        return call(turn, 'submit_plan', { plan: {
          summary: 'Station readings', features: [{ id: 'log', title: 'Reading log', description: 'Records readings.', sources: [cited] }],
          roles: ['Keeper'], testers: change === 'reuse' ? [tester, { ...tester, id: 'second' }] : [tester],
          journeys: change === 'reuse' ? [journey, { ...journey, id: 'record2', testerId: 'second' }]
            : change === 'multiple' ? [journey, { ...journey, id: 'record2' }] : [journey],
          gaps: [],
        } });
      }
      default:
        submissionResult = result;
        return completion();
    }
  });
  const onProgress = vi.fn();
  const discover = createRepositoryBrain({ model: 'mock-brain', observe, complete });
  return { complete, observe, onProgress, prompt: () => prompt, submitted: () => submissionResult,
    run: (previous?: ProjectDiscovery) => discover(project, secrets, onProgress, previous) };
}

describe('repository brain', () => {
  it.each([['/chart-cabinet', 'High tide'], ['/survey-locker', 'Water level']])(
    'discovers an arbitrary %s route and distinguishes requirement from implementation', async (route, label) => {
      const test = await setup(route, label);
      const discovery = await test.run();
      expect(test.observe).toHaveBeenCalledWith(project, secrets, [route]);
      expect(discovery.modelCalls).toBe(4);
      expect(discovery.index).toMatchObject({ fileCount: 2, sourceLines: 4 });
      expect(discovery.index).not.toHaveProperty('files');
      expect(discovery.plan.testers[0]).toMatchObject({ id: 'station', accountId });
      expect(discovery.plan.journeys[0]).toMatchObject({ entryPath: route, inputs: { reading: '12.9' },
        checks: [{ basis: 'requirement', sources: [{ path: '$requirements', startLine: 1, endLine: 1,
          excerpt: project.requirements, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }] },
        { basis: 'implementation', sources: [{ path: 'station.py' }] }] });
      expect(JSON.stringify(discovery)).not.toContain(username);
      expect(JSON.stringify(discovery)).not.toContain(password);
      expect(JSON.stringify(discovery.plan.testers[0].context)).not.toContain('station.py');
      expect(discovery.plan.gaps.join(' ')).toMatch(/hypotheses/i);
    },
  );

  it.each([
    ['path', /citation/i], ['hash', /citation/i], ['excerpt', /citation/i], ['unread', /citation/i],
    ['account', /account/i], ['reuse', /account/i], ['route', /route/i], ['selector', /locator/i],
    ['basis', /basis/i], ['multiple', /one journey/i], ['role', /locator/i],
  ] as const)('rejects %s without accepting a plan', async (change, reason) => {
    const test = await setup('/chart-cabinet', 'High tide', change);
    await expect(test.run()).rejects.toThrow(reason);
    expect(test.submitted()).toMatch(reason);
  });

  it('preserves tester identities across source changes and reports changed paths', async () => {
    const first = await (await setup('/chart-cabinet', 'High tide')).run();
    const revised = await setup('/tide-locker', 'High tide');
    const second = await revised.run(first);
    expect(second.index.changedPaths).toEqual(['station.py']);
    expect(second.index.version).not.toBe(first.index.version);
    expect(second.plan.testers[0].id).toBe(first.plan.testers[0].id);
    expect(revised.prompt()).toContain('changedPaths');
    expect(revised.prompt()).toContain('/chart-cabinet');
    const replacement = await setup('/tide-locker', 'High tide', 'identity');
    await expect(replacement.run(first)).rejects.toThrow(/identit/i);
  });

  it('describes independent browser personas when accounts are absent', async () => {
    project.accounts = [];
    const discovery = await (await setup('/tide-locker', 'High tide')).run();
    expect(discovery.plan.testers[0]).not.toHaveProperty('accountId');
    expect(discovery.plan.gaps.join(' ')).toMatch(/browser personas/i);
  });

  it('ranks matching source under the startup directory above an archived implementation', async () => {
    project.commands = { cwd: 'runtime', start: ['python', 'server.py'] };
    for (const directory of ['archive', 'runtime']) {
      await mkdir(join(fixture, directory));
      await writeFile(join(fixture, directory, 'view.py'), 'station = "High tide"\n');
    }
    let ranked: SourceReference[] = [];
    const complete = vi.fn(async (request: unknown) => {
      if (complete.mock.calls.length === 1) return call(1, 'search_source', { query: 'High tide' });
      const { messages } = request as { messages: { content: string }[] };
      ranked = JSON.parse(messages.at(-1)!.content).map(({ reference }: { reference: SourceReference }) => reference);
      return completion();
    });
    await expect(createRepositoryBrain({ model: 'mock-brain', complete })(project, secrets, () => {}))
      .rejects.toThrow(/without a submitted plan/);
    expect(ranked.map(ref => ref.path)).toEqual(['runtime/view.py', 'archive/view.py']);
  });

  it('stops provider errors after one call and reports a sanitized failure', async () => {
    const onProgress = vi.fn();
    const complete = vi.fn(async () => { throw new Error(`Provider failed with ${password}`); });
    const discover = createRepositoryBrain({ model: 'mock-brain', complete });
    await expect(discover(project, secrets, onProgress)).rejects.toThrow(/provider/i);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls.flat()).toContain('Repository discovery provider failed');
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(password);
  });

  it('stops a provider that keeps requesting source at twelve turns', async () => {
    let turn = 0;
    const complete = vi.fn(async () => call(++turn, 'search_source', { query: 'nothing' }));
    const discover = createRepositoryBrain({ model: 'mock-brain', complete });
    await expect(discover(project, secrets, () => {})).rejects.toThrow(/turn limit/i);
    expect(complete).toHaveBeenCalledTimes(12);
  });
});
