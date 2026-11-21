import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const workspace = resolve(process.env.VENDURE_WORKSPACE ?? resolve(root, '.local-work/p3/vendure-app'));
const revision = '534e6003534f74761e82de1b8c6061cba89945d1';

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

if (process.versions.node.split('.')[0] !== '22') {
    run('npm', ['exec', '--yes', '--package=node@22.22.0', '--', 'node', script], root);
    process.exit(0);
}

if (!existsSync(workspace)) {
    mkdirSync(dirname(workspace), { recursive: true });
    const checkout = mkdtempSync(resolve(dirname(workspace), '.vendure-checkout-'));
    try {
        run('git', ['init', '--quiet'], checkout);
        run('git', ['fetch', '--depth=1', 'https://github.com/vendurehq/vendure.git', revision], checkout);
        run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkout);
        renameSync(checkout, workspace);
    } finally {
        rmSync(checkout, { recursive: true, force: true });
    }
}

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
if (head.status !== 0 || head.stdout.trim() !== revision) {
    throw new Error(`Expected Vendure ${revision} at ${workspace}. Use a dedicated checkout at the pinned revision.`);
}

const installed = resolve(workspace, 'node_modules/.marketplace-installed');
if (!existsSync(installed)) {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], workspace);
    run('npm', ['rebuild', 'bcrypt', 'better-sqlite3'], workspace);
    writeFileSync(installed, revision + '\n');
}

const local = resolve(workspace, 'local-marketplace');
cpSync(resolve(root, 'integrations/vendure/app'), local, { recursive: true, force: false });
const data = resolve(local, '.data');
mkdirSync(data, { recursive: true, mode: 0o700 });
const credentials = resolve(data, 'credentials.json');
if (!existsSync(credentials)) {
    if (existsSync(resolve(data, 'vendure.sqlite'))) {
        throw new Error('Existing Vendure database requires its original credentials.json.');
    }
    const values = Object.fromEntries(
        ['cookieSecret', 'manager', 'catalog', 'orders'].map(key => [key, randomBytes(24).toString('hex')]),
    );
    writeFileSync(credentials, JSON.stringify(values) + '\n', { flag: 'wx', mode: 0o600 });
}
run('npm', ['run', 'build'], local);
run('npm', ['run', 'seed'], local);
console.log(`Vendure workspace: ${workspace}\nStart with npm run start from ${local} (Node 22).`);
