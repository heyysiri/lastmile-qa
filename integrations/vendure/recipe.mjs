import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDURE_REVISION = '534e6003534f74761e82de1b8c6061cba89945d1';
const node22 = 'npm exec --yes --package=node@22.22.0 --';

/** Prepare an already cloned checkout. No network, installation, or Git revision changes. */
export function prepareVendureRecipe({ workspace, port }) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error('port must be an integer between 1 and 65535');
    }
    const checkout = resolve(workspace);
    const git = args => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(checkout)) throw new Error('workspace must be the Git checkout root');
    // Local excludes also work for linked worktrees; never modify the fork's tracked .gitignore.
    if (git(['ls-files', '--', 'local-marketplace']).length) {
        throw new Error('local-marketplace must be untracked runtime state');
    }
    const exclude = resolve(checkout, git(['rev-parse', '--git-path', 'info/exclude']));
    mkdirSync(dirname(exclude), { recursive: true });
    if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes('/local-marketplace/')) {
        appendFileSync(exclude, '\n/local-marketplace/\n');
    }
    const workingDirectory = resolve(checkout, 'local-marketplace');
    const data = resolve(workingDirectory, '.data');
    const credentials = resolve(data, 'credentials.json');
    const databasePath = resolve(data, 'vendure.sqlite');
    if (!existsSync(credentials) && existsSync(databasePath)) {
        throw new Error('Existing Vendure database requires its original credentials.json.');
    }
    cpSync(fileURLToPath(new URL('./app', import.meta.url)), workingDirectory, { recursive: true, force: false });
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (!existsSync(credentials)) {
        const values = Object.fromEntries(
            ['cookieSecret', 'manager', 'catalog', 'orders'].map(key => [key, randomBytes(24).toString('hex')]),
        );
        writeFileSync(credentials, JSON.stringify(values) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return {
        workingDirectory,
        installCommand: `${node22} npm --prefix .. ci --ignore-scripts --no-audit --no-fund && ${node22} npm --prefix .. rebuild bcrypt better-sqlite3`,
        buildCommand: `${node22} npm run build && ${node22} npm run seed`,
        startCommand: `PORT=${port ?? '{port}'} ${node22} npm run start`,
        ...(port === undefined ? {} : { port }),
        databasePath,
        runtimeFiles: [credentials, databasePath, resolve(data, 'assets')],
    };
}
