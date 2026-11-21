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

it('requests an initial plan before the budget ends and restores evidence tools for corrections', async () => {
  await writeFile(join(fixture, 'app.py'), 'def readings(): return "Readings"');
  let turn = 0;
  const complete = async (request: unknown) => {
    const body = request as { tools: { function: { name: string } }[]; tool_choice?: unknown };
    expect(body.tool_choice).toBe('required');
    if (++turn === 10) expect(body.tools.map(tool => tool.function.name)).toEqual(['submit_plan']);
    if (turn > 10) expect(body.tools.map(tool => tool.function.name)).toContain('observe_app');
    return call(turn, 'search_source', { query: 'readings' });
  };
  await expect(createRepositoryBrain({ model: 'test', complete })(project, secrets, () => {})).rejects.toThrow(/turn limit/);
  expect(turn).toBe(18);
});

it('returns malformed plan errors to the model without corrupting the provider conversation',async()=>{
 await writeFile(join(fixture,'app.py'),'def readings(): return "Readings"');let turns=0;
 const complete=async()=>++turns===1?call(turns,'submit_plan',{plan:{summary:'Incomplete plan'}}):completion();
 await expect(createRepositoryBrain({model:'test',complete})(project,secrets,()=>{})).rejects.toThrow(/submitted plan|schema/);
 expect(turns).toBe(2);
});

it('returns the observed redirect destination when a requested route is read from cache', async () => {
  await writeFile(join(fixture, 'app.py'), 'route = "/workspace"');
  const observe = vi.fn(async (_project: Project, _secrets: ProjectSecrets, paths: string[]) => paths.map(path => ({
    requestedPath: path, path: path === '/workspace' ? '/workspace?view=all' : path,
    text: '- heading "Workspace"', accountId, observedAt: now,
  })));
  let turn = 0, cached = '';
  const complete = async (request: unknown) => {
    if (++turn < 3) return call(turn, 'observe_app', { paths: ['/workspace'] });
    cached = (request as { messages: { content: string }[] }).messages.at(-1)!.content;
    return completion();
  };
  await expect(createRepositoryBrain({ model: 'test', observe, complete })(project, secrets, () => {})).rejects.toThrow(/submitted plan/);
  expect(cached).toContain('/workspace?view=all');
  expect(observe.mock.calls.filter(([, , paths]) => paths.includes('/workspace'))).toHaveLength(1);
});

type PlanChange = 'role' | 'path' | 'hash' | 'excerpt' | 'unread' | 'unknown-citation' | 'account' | 'reuse' | 'route' | 'selector' | 'route-selector' | 'auto-observe'
  | 'field-name' | 'field-name-duplicate' | 'field-name-unobserved' | 'unlinked-label' | 'missing-expected' | 'ambiguous-text'
  | 'basis' | 'identity' | 'multiple' | 'source-goal' | 'source-persona' | 'source-input' | 'oracle-goal' | 'oracle-input';

async function setup(route: string, label: string, change?: PlanChange, entryText = '') {
  await writeFile(join(fixture, 'station.py'), `from tides import station\nroute = "${route}"\nlabel = "${label}"\n`);
  await writeFile(join(fixture, 'unread.py'), 'protected = "Not looked up"\n');
  const observe = vi.fn(async (_project: Project, _secrets: ProjectSecrets, paths: string[]) => paths
    .filter(path => path === route || path === new URL(project.appUrl).pathname).map(path => ({
    path, ...(project.accounts.length ? { accountId } : {}),
    text: (change?.startsWith('field-name') ? '  - generic: navigation filler\n'.repeat(240)
      + (change === 'field-name-unobserved' ? '' : '- fieldName "readings.current"\n'.repeat(change === 'field-name-duplicate' ? 2 : 1)) : '')
      + (change === 'ambiguous-text' ? `- heading "${label}"\n- link "${label}"\n` : change === 'unlinked-label' ? `- fieldName "readings.current" nearbyLabel "${label}"\n` : `- textbox "${label}"\n`)
      + `${username} ${password}${path === new URL(project.appUrl).pathname ? entryText : ''}`,
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
        return call(turn, 'observe_app', { paths: [change === 'auto-observe' ? '/' : route] });
      case 4: {
        expect(JSON.parse(result)[0]).toMatchObject({ path: change === 'auto-observe' ? '/' : route, text: expect.stringContaining(label) });
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
        const locator = change?.startsWith('field-name') ? { by: 'fieldName', value: 'readings.current' }
          : change === 'ambiguous-text' ? { by: 'text', value: label }
          : change === 'role' ? { by: 'role', value: 'checkbox', name: label }
          : { by: 'label', value: ['selector', 'route-selector'].includes(change ?? '') ? 'Unseen control' : label };
        const cited = ['path', 'hash', 'excerpt', 'unread'].includes(change ?? '') ? evidence
          : change === 'unknown-citation' ? 'S9999' : source.citation;
        const check = { id: 'saved', label: 'Saved reading', kind: 'field', locator, path: route, expected: change === 'missing-expected' ? undefined : '12.9',
          phase: 'after_reload', basis: change === 'basis' ? 'test' : 'requirement', sources: [requirement.citation] };
        const journey = { id: 'record', testerId: tester.id, title: 'Log a tide',
          goal: change === 'source-goal' ? `Record a reading based on this code:\n${source.reference.excerpt}`
            : change === 'oracle-goal' ? 'Record a reading. Preserve oracle: the other station remains 16.0.'
              : 'Record a tidal reading of 12.9.',
          entryPath: ['route', 'route-selector'].includes(change ?? '') ? '/invented' : route,
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
  it('does not treat nearby label text or source markup as an accessible label absent from the observed page', async () => {
    await expect((await setup('/chart-cabinet', 'High tide', 'unlinked-label')).run()).rejects.toThrow(/locator/i);
  });
  it('grounds exact field names in observed DOM metadata beyond a long sidebar', async () => {
    const discovery = await (await setup('/chart-cabinet', 'High tide', 'field-name')).run();
    expect(discovery.plan.journeys[0].checks[0].locator).toEqual({ by: 'fieldName', value: 'readings.current' });
    expect(discovery.observations.every(observation => observation.text.length <= 5000)).toBe(true);
  });
  it.each(['field-name-duplicate', 'field-name-unobserved'] as const)('rejects %s metadata instead of guessing a field', async change => {
    await expect((await setup('/chart-cabinet', 'High tide', change)).run()).rejects.toThrow(/locator/i);
  });
  it('corroborates proposed journey and readback routes during submission without another model navigation request', async () => {
    const test = await setup('/chart-cabinet', 'High tide', 'auto-observe');
    const discovery = await test.run();
    expect(test.observe).toHaveBeenCalledWith(project, secrets, ['/chart-cabinet']);
    expect(discovery.observations).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/chart-cabinet', accountId })]));
  });
  it.each([
    { scenario: 'a conflicting guest check', control: 'Station name', expected: 'East station', accounts: false, rejects: true },
    { scenario: 'an uncaptured conflicting guest check', control: 'Station name', expected: undefined, accounts: false, rejects: true },
    { scenario: 'a guest check on an untouched field', control: 'Calibration', expected: '10', accounts: false, rejects: false },
    { scenario: 'the same control under distinct accounts', control: 'Station name', expected: 'East station', accounts: true, rejects: false },
  ])('handles $scenario when a prior journey plans a write', async ({ control, expected, accounts, rejects }) => {
    const path = '/station';
    await writeFile(join(fixture, 'station.py'), 'route = "/station"\nname = "Station name"\ncalibration = "Calibration"\nthreshold = "Alarm threshold"\n');
    project.accounts = accounts ? [{ id: 'editor', label: 'Editor' }, { id: 'operator', label: 'Operator' }] : [];
    const testers = ['editor', 'operator'].map(id => ({
      id, name: id, role: 'Staff', summary: 'Maintains station settings.', ...(accounts ? { accountId: id } : {}),
    }));
    let turn = 0;
    const complete = async (request: unknown) => {
      if (++turn === 1) return call(turn, 'search_source', { query: 'Station name' });
      if (turn > 2) return completion();
      const { messages } = request as { messages: { content: string }[] };
      const [{ citation }] = JSON.parse(messages.at(-1)!.content) as { citation: string }[];
      const sources = [citation];
      const field = (id: string, label: string, value: string, phase: string, expected?: string) => ({
        id, label, kind: 'field', locator: { by: 'label', value }, phase, path, expected, basis: 'implementation', sources,
      });
      const journeys = [
        { id: 'rename', testerId: 'editor', title: 'Rename the station', goal: 'Save a new station name.', entryPath: path,
          inputs: { name: 'East Annex' }, checks: [field('saved-name', 'Saved station name', 'Station name', 'after_reload', 'East Annex')],
          reason: 'Staff can update station names.', sources },
        { id: 'adjust', testerId: 'operator', title: 'Adjust the alarm', goal: 'Save a new alarm threshold.', entryPath: path,
          inputs: { threshold: '6' }, checks: [field('saved-threshold', 'Saved threshold', 'Alarm threshold', 'after_reload', '6'),
            field('preserved', 'Preserved setting', control, 'preserve', expected)], reason: 'Staff can adjust alarm thresholds.', sources },
      ];
      return call(turn, 'submit_plan', { plan: { summary: 'Station settings', roles: ['Staff'], testers, journeys, gaps: [],
        features: [{ id: 'settings', title: 'Station settings', description: 'Update station settings.', sources }] } });
    };
    const result = createRepositoryBrain({ model: 'test', complete })(project, { accounts: [] }, () => {});
    if (rejects) {
      await expect(result).rejects.toThrow(/journeys share.*preserve an untouched field/i);
    } else {
      expect((await result).plan.journeys[1].checks[1]).toMatchObject({ phase: 'preserve', expected });
    }
  });

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

  it('grounds checks in form controls beyond a long navigation snapshot', async () => {
    const path = '/workspace/';
    project.appUrl += path;
    const test = await setup(path, 'High tide');
    await writeFile(join(fixture, 'station.py'), '# High tide readings\n');
    test.observe.mockResolvedValueOnce([{ path, accountId, observedAt: now, text: [
      '- heading "High tide"',
      '- navigation:',
      '  - listitem: Station navigation entry\n'.repeat(150).trimEnd(),
      '- main:',
      '  - spinbutton "High tide" [ref=e151]: "12.9"',
      '  - button "Save reading" [ref=e152]',
      '  - link "Read saved reading" [ref=e153]:',
      '    - /url: /workspace/readings/17',
      `  - text: ${username} ${password}`,
    ].join('\n') }]);

    const discovery = await test.run();

    const { text } = discovery.observations[0];
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(text).toContain('- spinbutton "High tide"');
    expect(text).toContain('- button "Save reading"');
    expect(text).toMatch(/- link "Read saved reading"[^\n]*\n\s+- \/url: \/workspace\/readings\/17/);
    expect(discovery.plan.gaps.join(' ')).not.toMatch(/locator/i);
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
    ['account', /account/i], ['reuse', /account/i], ['route', /record.*route.*\/invented/i], ['selector', /saved.*locator.*Unseen control/i],
    ['route-selector', /record.*route.*\/invented[\s\S]*saved.*locator.*Unseen control/i],
    ['missing-expected', /journeys\.0\.checks\.0.*expected value/i],
    ['ambiguous-text', /locator/i],
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

  it('stops a provider that keeps requesting source at eighteen turns', async () => {
    await writeFile(join(fixture, 'app.py'), 'def readings(): return "Readings"');
    let turn = 0;
    const complete = vi.fn(async () => call(++turn, 'search_source', { query: 'nothing' }));
    const discover = createRepositoryBrain({ model: 'mock-brain', complete });
    await expect(discover(project, secrets, () => {})).rejects.toThrow(/turn limit/i);
    expect(complete).toHaveBeenCalledTimes(18);
  });
});
