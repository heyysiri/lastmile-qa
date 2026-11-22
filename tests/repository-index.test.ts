import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySource, scanRepository, searchRepository, startupWorkspaces } from '../apps/runner/src/repository-index';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
async function file(path: string, content: string | Buffer) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'repository-index-test-'));
  git('init', '-q');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('repository index', () => {
  it('indexes 100k source lines, symbols and import links, with searchable tests', async () => {
    const lines = Array.from({ length: 999 }, (_, i) => `export const reading${i} = ${i};\n`).join('');
    await Promise.all(Array.from({ length: 100 }, (_, i) => file(`modules/${i}.ts`, `import './shared';\n${lines}`)));
    await file('spec/reading.test.py', 'def test_tide_gauge():\n    assert gauge.stores_spring_tide\n');
    await file('rules.graphql', 'type TideGauge {\n  station: String!\n}\n');

    const index = await scanRepository(root);
    expect(index.sourceLines).toBe(100_003);
    expect(index.files).toHaveLength(102);
    expect(index.files.find(f => f.path === 'modules/0.ts')).toMatchObject({
      kind: 'code', lines: 1000, imports: ['./shared'], symbols: expect.arrayContaining(['reading0']),
    });
    expect(index.files.find(f => f.path === 'rules.graphql')?.symbols).toContain('TideGauge');
    expect(index.files.find(f => f.path === 'spec/reading.test.py')).toMatchObject({ kind: 'test', symbols: ['test_tide_gauge'] });
    expect(await searchRepository(index, 'stores_spring_tide')).toEqual([
      expect.objectContaining({ path: 'spec/reading.test.py', startLine: 1, endLine: 2, excerpt: 'def test_tide_gauge():\n    assert gauge.stores_spring_tide' }),
    ]);
    expect(await searchRepository(index, 'nonexistentterm')).toEqual([]);
    expect(JSON.stringify(index)).not.toContain('assert gauge.stores_spring_tide');
  });

  it('uses ignored startup imports only as hints and excludes secret-bearing or symlinked launch files', async () => {
    await file('.gitignore', '/runtime/\n');
    await file('runtime/start.mjs', 'import "@example/active/browser";');
    await file('packages/ui/package.json', '{"name":"@example/active"}');
    const index = await scanRepository(root);
    expect(await startupWorkspaces(index, 'runtime')).toEqual(['packages/ui']);
    expect(index.files.map(item => item.path)).toEqual(['packages/ui/package.json']);
    await expect(readRepositorySource(index, 'runtime/start.mjs')).rejects.toThrow(/outside the repository index/);
    await file('runtime/start.mjs', 'import "@example/active/browser"; const apiKey = "private-value-never-send";');
    expect(await startupWorkspaces(index, 'runtime')).toEqual([]);
    await symlink(join(root, 'packages/ui'), join(root, 'linked-startup'));
    expect(await startupWorkspaces(index, 'linked-startup')).toEqual([]);
    expect(await startupWorkspaces(index, '../')).toEqual([]);
  });

  it('excludes secrets, dependencies, tracked generated files, ignored source and symlinks', async () => {
    await file('src/page.ts', 'export const panel = "Tide gauge";');
    await file('src/binary.ts', Buffer.from([0, 0xff, 0x81]));
    await file('src/client.ts', '// @generated\nexport const generated = true;');
    await file('auth/credentials.json', '{"sensitive":true}');
    await file('src/key.ts', 'const key = "-----BEGIN PRIVATE KEY-----";');
    await file('src/deploy.ts', 'const apiKey = "reusable-secret-123";');
    await file('dist/compiled.js', 'export const compiled = true;');
    await file('node_modules/p/index.js', 'export const dependency = true;');
    await file('.private/private.ts', 'export const privateSource = true;');
    await file('package-lock.json', '{}');
    await file('.gitignore', 'ignored.ts\n');
    await file('ignored.ts', 'export const ignored = true;');
    const outside = await mkdtemp(join(tmpdir(), 'repository-index-outside-'));
    try {
      await writeFile(join(outside, 'outside.ts'), 'export const outside = true;');
      await symlink(join(outside, 'outside.ts'), join(root, 'src', 'linked.ts'));
      await symlink(outside, join(root, 'linked-directory'));
      git('add', 'src', 'dist', 'auth', '.private', 'package-lock.json');
      await file('notes.md', '# Sailing requirements');
      const index = await scanRepository(root);
      expect(index.files.map(f => f.path)).toEqual(['notes.md', 'src/page.ts']);
      expect(index.excludedFiles).toBeGreaterThanOrEqual(8);
      await expect(readRepositorySource(index, '../outside.ts')).rejects.toThrow();
      await expect(readRepositorySource(index, 'src/linked.ts')).rejects.toThrow();
      await rm(join(root, 'src'), { recursive: true });
      await writeFile(join(outside, 'page.ts'), 'export const panel = "Tide gauge";');
      await symlink(outside, join(root, 'src'));
      await expect(readRepositorySource(index, 'src/page.ts')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('detects added, edited and deleted paths from the preceding snapshot', async () => {
    await file('route.ts', 'export const route = "/gauges";');
    await file('deleted.ts', 'export const obsolete = true;');
    git('add', '.');
    const first = await scanRepository(root);
    expect((await scanRepository(root, first)).version).toBe(first.version);

    await file('route.ts', 'export const route = "/stations";');
    await file('layout.ts', 'export const layout = "grid";');
    await rm(join(root, 'deleted.ts'));
    const next = await scanRepository(root, first);
    expect(next.changedPaths).toEqual(['deleted.ts', 'layout.ts', 'route.ts']);
    expect(next.version).not.toBe(first.version);
    await expect(readRepositorySource(first, 'route.ts')).rejects.toThrow(/changed/i);
    expect(await searchRepository(first, 'gauges')).toEqual([]);
    expect((await searchRepository(next, 'stations'))[0]?.path).toBe('route.ts');
  });

  it('returns bounded exact ranges and preserves line provenance', async () => {
    await file('guide.md', `${'x'.repeat(4000)}\n${'item\n'.repeat(200)}`);
    const index = await scanRepository(root);
    const first = await readRepositorySource(index, 'guide.md', 1, 201);
    expect(first).toMatchObject({ startLine: 1, endLine: 1, excerpt: 'x'.repeat(3000) });
    const later = await readRepositorySource(index, 'guide.md', 2, 201);
    expect(later).toMatchObject({ startLine: 2, endLine: 121, excerpt: Array(120).fill('item').join('\n') });
    expect(later.hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(readRepositorySource(index, 'guide.md', 202)).rejects.toThrow(/line/i);
    await expect(readRepositorySource(index, 'guide.md', 2, 1)).rejects.toThrow(/line/i);
  });

  it('fails explicitly when eligible source exceeds the byte budget', async () => {
    await writeFile(join(root, 'oversize.ts'), '');
    const { truncate } = await import('node:fs/promises');
    await truncate(join(root, 'oversize.ts'), 100 * 1024 * 1024 + 1);
    await expect(scanRepository(root)).rejects.toThrow(/100 MB/);
  });
});
