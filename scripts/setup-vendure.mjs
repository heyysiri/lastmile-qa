import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareVendureRecipe, VENDURE_REVISION } from '../integrations/vendure/recipe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
    workspace: { type: 'string' },
    port: { type: 'string' },
    'prepare-only': { type: 'boolean', default: false },
} });
const workspace = resolve(values.workspace ?? process.env.VENDURE_WORKSPACE ?? resolve(root, '.local-work/p3/vendure-app'));
const port = values.port === undefined ? undefined : Number(values.port);

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: ['inherit', 'inherit', 'inherit'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (!existsSync(workspace)) {
    // Managed environments clone independently; prepare-only never contacts a remote.
    if (values['prepare-only']) throw new Error('Clone the Vendure checkout before preparing its recipe.');
    mkdirSync(dirname(workspace), { recursive: true });
    const checkout = mkdtempSync(resolve(dirname(workspace), '.vendure-checkout-'));
    try {
        run('git', ['init', '--quiet'], checkout);
        run('git', ['fetch', '--depth=1', 'https://github.com/heyysiri/vendure.git', VENDURE_REVISION], checkout);
        run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkout);
        renameSync(checkout, workspace);
    } finally {
        rmSync(checkout, { recursive: true, force: true });
    }
}
const recipe = prepareVendureRecipe({ workspace, port });
if (!values['prepare-only']) {
    run('/bin/sh', ['-c', recipe.installCommand], recipe.workingDirectory);
    run('/bin/sh', ['-c', recipe.buildCommand], recipe.workingDirectory);
}
console.log(JSON.stringify(recipe));
