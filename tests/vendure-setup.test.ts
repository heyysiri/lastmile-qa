import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { prepareVendureRecipe } from '../integrations/vendure/recipe.mjs';

const workspaces: string[] = [];
function checkout() {
    const workspace = mkdtempSync(join(tmpdir(), 'vendure-recipe-'));
    workspaces.push(workspace);
    execFileSync('git', ['init', '--quiet', '--initial-branch=demo'], { cwd: workspace });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/heyysiri/vendure.git'], { cwd: workspace });
    writeFileSync(join(workspace, 'package.json'), '{"name":"vendure"}');
    execFileSync('git', ['add', 'package.json'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Recipe Test', '-c', 'user.email=recipe@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: workspace });
    return workspace;
}
afterEach(() => { for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true }); });

test('prepares ignored runtime files without changing Git state or exposing credentials', () => {
    const workspace = checkout();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
    const recipe = prepareVendureRecipe({ workspace, port: 9321 });
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' })).toBe(head);
    expect(recipe.workingDirectory).toBe(join(workspace, 'local-marketplace'));
    expect(recipe.startCommand).toContain('PORT=9321');
    expect(recipe.startCommand).toContain('node@22.22.0');
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8' }).trim()).toBe('demo');
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workspace, encoding: 'utf8' }).trim()).toBe('https://github.com/heyysiri/vendure.git');
    const credentialPath = join(recipe.workingDirectory, '.data/credentials.json');
    const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(recipe)).not.toContain(credentials.manager);
    expect(execFileSync('git', ['check-ignore', credentialPath, recipe.databasePath], { cwd: workspace, encoding: 'utf8' })).toContain('credentials.json');
    writeFileSync(recipe.databasePath, 'existing database');
    writeFileSync(join(recipe.workingDirectory, 'server.ts'), '// local customization');
    prepareVendureRecipe({ workspace, port: 9322 });
    expect(readFileSync(credentialPath, 'utf8')).toBe(JSON.stringify(credentials) + '\n');
    expect(readFileSync(recipe.databasePath, 'utf8')).toBe('existing database');
    expect(readFileSync(join(recipe.workingDirectory, 'server.ts'), 'utf8')).toBe('// local customization');
});

test('supports manager port substitution and rejects unsafe port values', () => {
    const workspace = checkout();
    expect(prepareVendureRecipe({ workspace }).startCommand).toContain('PORT={port}');
    for (const port of [0, 65536, 1.5, '123; echo unsafe']) {
        expect(() => Reflect.apply(prepareVendureRecipe, undefined, [{ workspace, port }])).toThrow(/port/i);
    }
});

test('does not replace credentials for an existing database', () => {
    const workspace = checkout();
    mkdirSync(join(workspace, 'local-marketplace/.data'), { recursive: true });
    writeFileSync(join(workspace, 'local-marketplace/.data/vendure.sqlite'), 'existing database');
    expect(() => prepareVendureRecipe({ workspace, port: 9321 })).toThrow(/original credentials/);
});

test('CLI prepare-only emits the public recipe without installing or building', () => {
    const workspace = checkout();
    const output = execFileSync(process.execPath, ['scripts/setup-vendure.mjs', '--workspace', workspace, '--port', '9323', '--prepare-only'], { encoding: 'utf8' });
    const recipe = JSON.parse(output);
    expect(recipe.port).toBe(9323);
    expect(recipe.buildCommand).toContain('npm run seed');
    expect(recipe.runtimeFiles).toContain(join(workspace, 'local-marketplace/.data/credentials.json'));
});

test('refuses runtime files already in the Git index', () => {
    const workspace = checkout();
    mkdirSync(join(workspace, 'local-marketplace'));
    writeFileSync(join(workspace, 'local-marketplace/server.ts'), '// tracked');
    execFileSync('git', ['add', 'local-marketplace'], { cwd: workspace });
    expect(() => prepareVendureRecipe({ workspace })).toThrow(/untracked runtime state/);
});
