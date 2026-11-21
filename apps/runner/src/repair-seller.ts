import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import ts from 'typescript';
import type { AccountCheckpoint } from '@lastmile/contracts/populations';
import { hashBytes, readRepairBuild, type RepairPatchPolicy, type WithRepairBuild } from './repair-workspace';

const app = 'apps/seller-demo';
const store = `${app}/lib/store.ts`;

function protectedStoreSource(text: string) {
  const file = ts.createSourceFile(store, text, ts.ScriptTarget.Latest, true);
  const seller = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SellerStore');
  if (!seller || !ts.isClassDeclaration(seller)) throw new Error('Patch changed the protected seller store structure');
  const methods = seller.members.filter(member => ts.isMethodDeclaration(member)
    && ts.isIdentifier(member.name) && ['saveStoreName', 'saveQuantity'].includes(member.name.text));
  if (methods.length !== 2) throw new Error('Patch changed the protected seller store methods');
  let protectedText = text;
  for (const method of methods.reverse()) {
    if (!ts.isMethodDeclaration(method) || !method.body) throw new Error('Patch changed the protected seller store methods');
    protectedText = protectedText.slice(0, method.body.getStart(file)) + '{}' + protectedText.slice(method.body.end);
  }
  return protectedText;
}

export const sellerPatchPolicy: RepairPatchPolicy = {
  editable: [store, `${app}/components/StoreForm.tsx`, `${app}/components/InventoryForm.tsx`],
  validateEdit(path, before, after) {
    // This file also implements trusted checkpoints and readback. Freeze callers,
    // signatures, fixtures and all code outside the production write methods.
    if (path === store && protectedStoreSource(before) !== protectedStoreSource(after)) {
      throw new Error('Patch changed protected seller fixtures, checkpoints or readback');
    }
  },
};
export const sellerCodePaths = [...sellerPatchPolicy.editable, `${app}/lib/api.ts`];
export const sellerCodingInstructions = 'If editing seller store.ts, change only the bodies of the existing saveStoreName or saveQuantity methods.';

export async function backupSellerDatabase(from: string, to: string, checkpoints: AccountCheckpoint[]) {
  const original = new Database(from, { readonly: true, fileMustExist: true });
  try { await original.backup(to); } finally { original.close(); }
  const snapshot = new Database(to, { fileMustExist: true });
  try {
    snapshot.pragma('journal_mode = DELETE');
    snapshot.pragma('secure_delete = ON');
    snapshot.prepare('DELETE FROM sessions').run();
    snapshot.exec('VACUUM');
    const checkpoint = snapshot.prepare<[string], { digest: string; state_json: string }>('SELECT digest, state_json FROM checkpoints WHERE id = ?');
    for (const { id, digest } of checkpoints) {
      const row = checkpoint.get(id);
      if (!row || row.digest !== digest || hashBytes(row.state_json) !== digest) {
        throw new Error('A frozen starting checkpoint is unavailable or corrupt');
      }
    }
  } finally { snapshot.close(); }
}

async function copySellerDependencies(root: string, tree: string, signal: AbortSignal) {
  // Turbopack requires packages inside the build root. Copy the existing pnpm
  // tree with copy-on-write where supported and keep its relative links.
  for (const directory of ['', app, 'packages/contracts']) {
    const from = await realpath(join(root, directory, 'node_modules'));
    const to = join(tree, directory, 'node_modules');
    await cp(from, to, {
      recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: () => { signal.throwIfAborted(); return true; },
    });
  }
}

export function repairChildEnvironment(env: NodeJS.ProcessEnv, settings: {
  databasePath: string; testToken: string; defect?: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    ENABLE_TEST_API: 'true', TEST_API_TOKEN: settings.testToken, SELLER_DATABASE_PATH: settings.databasePath,
    ...(settings.defect === undefined ? {} : { SELLER_DEMO_DEFECT: settings.defect }),
  };
}

function startProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  let exited = false;
  child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-4096); });
  const done = new Promise<boolean>(finish => {
    child.once('error', () => { exited = true; finish(false); });
    child.once('exit', code => { exited = true; finish(code === 0); });
  });
  function kill(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return {
    done, exited: () => exited, output: () => output,
    async close() {
      kill('SIGTERM');
      await Promise.race([done, delay(500)]);
      kill('SIGKILL');
    },
  };
}

export const withSellerBuild: WithRepairBuild = async (options, use) => {
  const { root, tree, testToken, signal } = options;
  await copySellerDependencies(root, tree, signal);
  signal.throwIfAborted();
  const env = repairChildEnvironment(process.env, options);
  const build = startProcess('pnpm', ['--filter', '@lastmile/seller-demo', 'build'], tree, env);
  try {
    const passed = await Promise.race([build.done, delay(120_000, false, { signal, ref: false })]);
    if (!passed) throw new Error('Isolated seller build failed');
  } catch {
    throw new Error('Isolated seller build failed or timed out');
  } finally {
    await build.close();
  }
  signal.throwIfAborted();
  const server = startProcess(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '0'], join(tree, app), env);
  try {
    const startSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!server.exited()) {
      const port = server.output().match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (port && port !== '0') {
        const origin = `http://127.0.0.1:${port}`;
        const buildId = await readRepairBuild(origin, testToken, startSignal)
          .catch(() => undefined); // Wait until the locally spawned server handles authenticated requests.
        if (buildId) return await use({ origin, buildId });
      }
      await delay(100, undefined, { signal: startSignal });
    }
    throw new Error('Isolated seller server exited before startup');
  } finally {
    await server.close();
  }
};
