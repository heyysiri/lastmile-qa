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

it('explains an empty source index before spending model calls', async () => {
  const complete = vi.fn(async () => completion());
  await expect(createRepositoryBrain({ model: 'test', complete })(project, secrets, () => {}))
    .rejects.toThrow(/no eligible repository files.*ignore/i);
  expect(complete).not.toHaveBeenCalled();
});

it('asks the provider to cite supplied evidence IDs instead of reconstructing source objects', async () => {
  await writeFile(join(fixture, 'app.py'), 'def readings(): return "Readings"');
  let sourceItems: unknown;
  const complete = async (request: unknown) => {
    const body = request as { tools: { function: { name: string; parameters: { properties: { plan: { properties: {
      features: { items: { properties: { sources: { items: unknown } } } };
    } } } } } }[] };
    sourceItems = body.tools.find(tool => tool.function.name === 'submit_plan')!.function.parameters
      .properties.plan.properties.features.items.properties.sources.items;
    return completion();
  };
  await expect(createRepositoryBrain({ model: 'test', complete })(project, secrets, () => {})).rejects.toThrow(/submitted plan/);
  expect(sourceItems).toMatchObject({ type: 'string', pattern: '^S[1-9]\\d*$' });
});

it('lets the guarded browser corroborate an ordinary inferred route before source route syntax is understood',async()=>{
 await writeFile(join(fixture,'app.py'),'def inventory(): return "Stock"');
 const observe=vi.fn(async(_p:Project,_s:ProjectSecrets,paths:string[])=>paths.map(path=>({path,accountId,text:'- heading "Stock"',observedAt:now})));
 let turn=0;const complete=async()=>++turn===1?call(turn,'observe_app',{paths:['/workspace/inventory?view=stock']}):completion();
 await expect(createRepositoryBrain({model:'test',observe,complete})(project,secrets,()=>{})).rejects.toThrow(/submitted plan/);
 expect(observe.mock.calls.some(([, ,paths])=>paths.includes('/workspace/inventory?view=stock'))).toBe(true);
});

it('reserves the last three model turns for submitting and correcting the plan',async()=>{
 await writeFile(join(fixture,'app.py'),'def readings(): return "Readings"');let turn=0;
 const complete=async(request:unknown)=>{const body=request as {tools:{function:{name:string}}[];tool_choice?:unknown};turn++;expect(body.tool_choice).toBe('required');if(turn>=10){expect(body.tools.map(t=>t.function.name)).toEqual(['submit_plan']);expect(body.tool_choice).toBe('required');}return call(turn,'search_source',{query:'readings'});};
 await expect(createRepositoryBrain({model:'test',complete})(project,secrets,()=>{})).rejects.toThrow(/turn limit/);
});

it('returns malformed plan errors to the model without corrupting the provider conversation',async()=>{
 await writeFile(join(fixture,'app.py'),'def readings(): return "Readings"');let turns=0;
 const complete=async()=>++turns===1?call(turns,'submit_plan',{plan:{summary:'Incomplete plan'}}):completion();
 await expect(createRepositoryBrain({model:'test',complete})(project,secrets,()=>{})).rejects.toThrow(/submitted plan|schema/);
 expect(turns).toBe(2);
});

type PlanChange = 'role' | 'path' | 'hash' | 'excerpt' | 'unread' | 'unknown-citation' | 'account' | 'reuse' | 'route' | 'selector'
  | 'basis' | 'identity' | 'multiple' | 'source-goal' | 'source-persona' | 'source-input' | 'oracle-goal' | 'oracle-input';

async function setup(route: string, label: string, change?: PlanChange, entryText = '') {
  await writeFile(join(fixture, 'station.py'), `from tides import station\nroute = "${route}"\nlabel = "${label}"\n`);
  await writeFile(join(fixture, 'unread.py'), 'protected = "Not looked up"\n');
  const observe = vi.fn(async (_project: Project, _secrets: ProjectSecrets, paths: string[]) => paths.map(path => ({
    path, ...(project.accounts.length ? { accountId } : {}),
    text: `- textbox "${label}"\n${username} ${password}${path === new URL(project.appUrl).pathname ? entryText : ''}`,
    observedAt: now,
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
          role: 'Keeper', summary: change === 'source-persona' ? `Follow ${source.reference.path}.` : 'Records observations.', ...(project.accounts.length
            ? { accountId: change === 'account' ? 'outside' : accountId } : {}) };
        const locator = change === 'role' ? { by: 'role', value: 'checkbox', name: label }
          : { by: 'label', value: change === 'selector' ? 'Unseen control' : label };
        const cited = ['path', 'hash', 'excerpt', 'unread'].includes(change ?? '') ? evidence
          : change === 'unknown-citation' ? 'S9999' : source.citation;
        const check = { id: 'saved', label: 'Saved reading', kind: 'field', locator, path: route, expected: '12.9',
          phase: 'after_reload', basis: change === 'basis' ? 'test' : 'requirement', sources: [requirement.citation] };
        const journey = { id: 'record', testerId: tester.id, title: 'Log a tide',
          goal: change === 'source-goal' ? `Record a reading based on this code:\n${source.reference.excerpt}`
            : change === 'oracle-goal' ? 'Record a reading. Preserve oracle: the other station remains 16.0.'
              : 'Record a tidal reading of 12.9.',
          entryPath: change === 'route' ? '/invented' : route,
          inputs: { reading: '12.9', ...(change === 'source-input' ? { notes: `Use ${source.reference.path}` } : {}),
            ...(change === 'oracle-input' ? { preserveExpected: '16.0' } : {}) },
          sources: [cited, requirement.citation],
          checks: [check, { ...check, id: 'reachable', kind: 'visible', phase: 'after_action', basis: 'implementation',
            sources: [source.citation], expected: undefined },
          ...(['oracle-goal', 'oracle-input'].includes(change ?? '') ? [
            { ...check, id: 'other-station', phase: 'preserve', expected: '16.0' },
          ] : [])], reason: 'Record and read back a station measurement.' };
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
  it('grounds the first model turn in the configured entry and startup files', async () => {
    project.appUrl += '/workspace/';
    project.commands = { cwd: 'runtime', start: ['python', 'server.py'] };
    for (let i = 0; i < 35; i++) {
      await mkdir(join(fixture, 'archive', String(i)), { recursive: true });
      await writeFile(join(fixture, 'archive', String(i), 'routes.py'), 'route = "/archived"\n');
    }
    await mkdir(join(fixture, 'runtime'));
    await writeFile(join(fixture, 'runtime', 'server.py'), 'from tides import station\n');
    const test = await setup('/workspace/', 'Active station');
    const discovery = await test.run();

    const messages = JSON.parse(test.prompt()) as { role: string; content: { text: string }[] }[];
    const prompt = JSON.parse(messages.find(message => message.role === 'user')!.content[0].text);
    expect(prompt.observations).toEqual([
      expect.objectContaining({ path: '/workspace/', accountId, text: expect.stringContaining('Active station') }),
    ]);
    expect(prompt.manifest.entryHints[0]).toMatchObject({ path: 'runtime/server.py' });
    expect(prompt.startupSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ citation: expect.stringMatching(/^S[1-9]\d*$/), reference: expect.objectContaining({
        path: 'runtime/server.py', excerpt: 'from tides import station',
      }) }),
    ]));
    expect(test.observe.mock.calls.map(([, , paths]) => paths)).toEqual([['/workspace/']]);
    expect(discovery.observations).toEqual(prompt.observations);
  });

  it('observes a mounted UI route backed by a relative source route', async () => {
    project.appUrl += '/workspace/';
    const test = await setup('/workspace/chart-cabinet', 'High tide');
    await writeFile(join(fixture, 'station.py'), 'route = "/chart-cabinet"\nlabel = "High tide"\n');

    const discovery = await test.run();

    expect(discovery.observations.map(({ path }) => path)).toEqual(['/workspace/', '/workspace/chart-cabinet']);
    expect(discovery.plan.journeys[0].entryPath).toBe('/workspace/chart-cabinet');
  });

  it('can observe a visible link beyond the entry snapshot cutoff', async () => {
    project.appUrl += '/workspace/';
    const test = await setup('/workspace/inspect/17', 'High tide', undefined,
      `\n${'  - text: Reading summary\n'.repeat(200)}  - link "Inspect reading":\n    - /url: /workspace/inspect/17`);
    await writeFile(join(fixture, 'station.py'), 'label = "High tide"\n');

    const discovery = await test.run();

    expect(discovery.observations.map(({ path }) => path)).toEqual(['/workspace/', '/workspace/inspect/17']);
    expect(discovery.observations[0].text.length).toBeLessThanOrEqual(5000);
  });

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
    ['unknown-citation', /citation/i],
    ['account', /account/i], ['reuse', /account/i], ['route', /route/i], ['selector', /locator/i],
    ['basis', /basis/i], ['multiple', /one journey/i], ['role', /locator/i],
    ['source-goal', /actor.*source/i], ['source-persona', /actor.*source/i], ['source-input', /actor.*source/i],
    ['oracle-goal', /actor.*oracle/i], ['oracle-input', /actor.*oracle/i],
  ] as const)('rejects %s without accepting a plan', async (change, reason) => {
    const test = await setup('/chart-cabinet', 'High tide', change);
    await expect(test.run()).rejects.toThrow(reason);
    expect(test.submitted()).toMatch(reason);
  });

  it.each(['path', 'hash', 'excerpt', 'unread'] as const)('rejects reconstructed %s citations at the tool boundary', async change => {
    const test = await setup('/chart-cabinet', 'High tide', change);
    await expect(test.run()).rejects.toThrow(/without a submitted plan/);
    expect(test.submitted()).toMatch(/expected string/i);
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

  it('finds matching routes in a workspace imported by the startup before other workspaces', async () => {
    project.commands = { cwd: 'runtime', start: ['node', 'start.mjs'] };
    await mkdir(join(fixture, 'runtime'));
    await mkdir(join(fixture, 'packages/active-ui'), { recursive: true });
    await mkdir(join(fixture, 'archive'));
    await writeFile(join(fixture, 'runtime/start.mjs'), 'import { start } from "@test/active/browser";\n');
    await writeFile(join(fixture, 'packages/active-ui/package.json'), '{"name":"@test/active"}');
    await writeFile(join(fixture, 'packages/active-ui/panel.ts'), 'export const route = "/routes";\n');
    await Promise.all(Array.from({ length: 21 }, (_, i) => writeFile(join(fixture, 'archive', `routes-${i}.ts`),
      'export const routes = "/routes";\n')));

    let firstPath: string | undefined;
    const complete = vi.fn(async (request: unknown) => {
      if (complete.mock.calls.length === 1) return call(1, 'search_source', { query: 'routes', limit: 1 });
      const { messages } = request as { messages: { content: string }[] };
      firstPath = JSON.parse(messages.at(-1)!.content)[0]?.reference.path;
      return completion();
    });
    await expect(createRepositoryBrain({ model: 'mock-brain', complete })(project, secrets, () => {}))
      .rejects.toThrow(/without a submitted plan/);
    expect(firstPath).toBe('packages/active-ui/panel.ts');
  });

  it('stops provider errors after one call and reports a sanitized failure', async () => {
    await writeFile(join(fixture, 'app.py'), 'def readings(): return "Readings"');
    const onProgress = vi.fn();
    const complete = vi.fn(async () => { throw new Error(`Provider failed with ${password}`); });
    const discover = createRepositoryBrain({ model: 'mock-brain', complete });
    await expect(discover(project, secrets, onProgress)).rejects.toThrow(/provider/i);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls.flat()).toContain('Repository discovery provider failed');
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(password);
  });

  it('stops a provider that keeps requesting source at twelve turns', async () => {
    await writeFile(join(fixture, 'app.py'), 'def readings(): return "Readings"');
    let turn = 0;
    const complete = vi.fn(async () => call(++turn, 'search_source', { query: 'nothing' }));
    const discover = createRepositoryBrain({ model: 'mock-brain', complete });
    await expect(discover(project, secrets, () => {})).rejects.toThrow(/turn limit/i);
    expect(complete).toHaveBeenCalledTimes(12);
  });
});
