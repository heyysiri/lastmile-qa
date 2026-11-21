import { execFile, spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { RepairAdapter } from './repair-runtime';
import { readRepairBuild } from './repair-workspace';

const exec = promisify(execFile);
const oscarSource = 'src/oscar';
const profileView = `${oscarSource}/apps/customer/views.py`;
const requirements = '.lastmile/requirements.md';
const bridge = '.lastmile/bridge';
const maxSourceBytes = 50_000_000;

const validateProfileBody = `
import ast, io, json, sys

def protected(source):
    module = ast.parse(source)
    compile(module, '<profile-view>', 'exec')
    view, = [node for node in module.body if isinstance(node, ast.ClassDef) and node.name == 'ProfileUpdateView']
    method, = [node for node in view.body if isinstance(node, ast.FunctionDef) and node.name == 'form_valid']
    lines = io.StringIO(source, newline='').readlines()
    if lines[method.lineno - 1].rstrip('\\r\\n') != '    def form_valid(self, form):':
        raise ValueError()
    return lines[:method.lineno], lines[method.end_lineno:]

before, after = json.load(sys.stdin)
sys.exit(0 if protected(before) == protected(after) else 1)
`;

const verifyCheckpointDigests = `
import hashlib, json, sys

def valid(row):
    canonical = json.dumps(json.loads(row['state']), sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest() == row['digest']

sys.exit(0 if all(map(valid, json.load(sys.stdin))) else 1)
`;

function baseEnvironment(): NodeJS.ProcessEnv {
  const { PATH, HOME, TMPDIR, LANG, LC_ALL } = process.env;
  return { PATH, HOME, TMPDIR, LANG, LC_ALL };
}

function checkPython(python: string, script: string, data: unknown) {
  return spawnSync(python, ['-I', '-S', '-c', script], {
    env: baseEnvironment(), input: JSON.stringify(data), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000,
  }).status === 0;
}

const excluded = (path: string) => path.split('/').some(name => name.startsWith('.env')
  || ['.git', '.data', 'node_modules', '__pycache__', 'media', 'cache', 'logs'].includes(name)
  || /\.(?:pyc|pyo|sqlite3?|db|log)(?:$|[.-])/.test(name));

async function sourceEntry(root: string, path: string) {
  const parts = path.split('/');
  let location = root;
  for (const part of parts.slice(0, -1)) {
    location = join(location, part);
    if (!(await lstat(location)).isDirectory()) throw new Error('Oscar repair source directory must be a regular directory');
  }
  location = join(location, parts.at(-1)!);
  return { location, info: await lstat(location) };
}

async function copyOscarSource(root: string, target: string, bridgeRoot: string, signal: AbortSignal) {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '-z', '--', oscarSource, 'sandbox', 'pyproject.toml', 'setup.cfg', 'setup.py', 'MANIFEST.in', 'LICENSE', 'README.rst'], {
    env: baseEnvironment(), timeout: 5000, maxBuffer: 1_000_000, signal,
  });
  const sourcePaths = new Set(stdout.split('\0').filter(path => path && !excluded(path)));
  if (!sourcePaths.has(profileView)) throw new Error('Missing pinned Oscar source');
  await mkdir(target, { mode: 0o700 });
  let bytes = 0;
  async function copy(from: string, path: string, to = path) {
    signal.throwIfAborted();
    const { location, info } = await sourceEntry(from, path);
    if (!info.isFile()) throw new Error('Oscar repair source must be a regular file');
    bytes += info.size;
    if (bytes > maxSourceBytes) throw new Error('Oscar repair source exceeds the size limit');
    const dest = join(target, to);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(location, dest, constants.COPYFILE_EXCL);
  }
  async function copyTree(from: string, directory: string, include: (name: string) => boolean, prefix = '') {
    signal.throwIfAborted();
    const location = directory ? (await sourceEntry(from, directory)).location : from;
    if (!(await lstat(location)).isDirectory()) throw new Error('Oscar repair source directory must be a regular directory');
    for (const entry of await readdir(location, { withFileTypes: true })) {
      const path = directory ? directory + '/' + entry.name : entry.name;
      if (excluded(path)) continue;
      if (entry.isDirectory()) await copyTree(from, path, include, prefix);
      else if (include(entry.name) && (prefix || !sourcePaths.has(path))) await copy(from, path, prefix + path);
    }
  }
  for (const path of sourcePaths) await copy(root, path);
  // The pinned setup builds these assets in place. Sandbox public/ contains
  // derived static files and media, while runserver serves from the source assets.
  await copyTree(root, `${oscarSource}/static`, name => /\.(?:css|ico|jpg|js|map|png|rst|scss|svg|woff2)$/.test(name));
  await copy(root, requirements);
  await copyTree(bridgeRoot, '', name => name.endsWith('.py') && !name.startsWith('test_'), bridge + '/');
}

const backupOscarDatabase = (python: string): RepairAdapter['backupDatabase'] => async (from, to, checkpoints) => {
  const original = new Database(from, { readonly: true, fileMustExist: true });
  try { await original.backup(to); } finally { original.close(); }
  const snapshot = new Database(to, { fileMustExist: true });
  try {
    snapshot.pragma('journal_mode = DELETE');
    snapshot.pragma('secure_delete = ON');
    snapshot.exec('DELETE FROM django_session; VACUUM;');
    const checkpoint = snapshot.prepare<[string], { digest: string; state: string }>('SELECT digest, state FROM qa_bridge_checkpoint WHERE id = ?');
    const rows = checkpoints.map(({ id, digest }) => {
      const row = checkpoint.get(id.replaceAll('-', '').toLowerCase());
      if (!row || row.digest !== digest) throw new Error('A frozen Oscar checkpoint is unavailable or corrupt');
      return row;
    });
    if (!checkPython(python, verifyCheckpointDigests, rows)) throw new Error('A frozen Oscar checkpoint is unavailable or corrupt');
  } finally { snapshot.close(); }
};

function startPython(python: string, args: string[], tree: string, env: NodeJS.ProcessEnv) {
  const child = spawn(python, ['-u', `${bridge}/manage.py`, ...args], {
    cwd: tree, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  let exited = false;
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-4096); });
  const done = new Promise<boolean>(resolve => {
    child.once('error', () => { exited = true; resolve(false); });
    child.once('exit', code => { exited = true; resolve(code === 0); });
  });
  function kill(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return {
    done, exited: () => exited,
    port: () => output.match(/Starting development server at http:\/\/127\.0\.0\.1:([1-9]\d*)\//)?.[1],
    async close() {
      kill('SIGTERM');
      await Promise.race([done, delay(500, undefined, { ref: false })]);
      kill('SIGKILL');
      await done;
    },
  };
}

const withOscarBuild = (python: string): RepairAdapter['withBuild'] => async (options, use) => {
  const { tree, databasePath, testToken, defect, signal } = options;
  signal.throwIfAborted();
  const env = {
    ...baseEnvironment(),
    OSCAR_ROOT: tree, OSCAR_DATABASE_PATH: databasePath, DJANGO_SETTINGS_MODULE: 'lastmile_settings',
    ENABLE_TEST_API: 'true', TEST_API_TOKEN: testToken, PYTHONDONTWRITEBYTECODE: '1',
    ...(defect === undefined ? {} : { OSCAR_DEMO_DEFECT: defect }),
  };
  const check = startPython(python, ['check'], tree, env);
  try {
    const passed = await Promise.race([check.done, delay(30_000, false, { signal, ref: false })]);
    if (!passed) throw new Error('Isolated Oscar management check failed or timed out');
  } finally {
    await check.close();
  }

  signal.throwIfAborted();
  const server = startPython(python, ['runserver', '127.0.0.1:0', '--noreload'], tree, env);
  let onAbort: (() => void) | undefined;
  try {
    const startSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let serving: { origin: string; buildId: string } | undefined;
    while (!server.exited()) {
      const port = server.port();
      if (port) {
        const origin = `http://127.0.0.1:${port}`;
        const buildId = await readRepairBuild(origin, testToken, startSignal).catch(() => undefined);
        if (buildId) {
          serving = { origin, buildId };
          break;
        }
      }
      await delay(100, undefined, { signal: startSignal });
    }
    if (!serving) throw new Error('Isolated Oscar server exited before startup');
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([aborted, (async () => use(serving))()]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await server.close();
  }
};

export function createOscarRepairAdapter({ bridgeRoot, python }: { bridgeRoot: string; python: string }): RepairAdapter {
  return {
    applicationId: 'oscar-commerce',
    codePaths: [profileView, `${oscarSource}/apps/customer/forms.py`, `${oscarSource}/apps/basket/views.py`, `${oscarSource}/apps/basket/abstract_models.py`],
    codingInstructions: [
      'Only edit the body of ProfileUpdateView.form_valid in src/oscar/apps/customer/views.py.',
      'Preserve profile validation, the profile save, email change notifications and existing user feedback.',
      'Preserve the basket when saving a profile. Leave defect configuration, fields, and checks intact.',
    ].join(' '),
    patchPolicy: {
      editable: [profileView],
      validateEdit(path, before, after) {
        if (path !== profileView || !checkPython(python, validateProfileBody, [before, after])) {
          throw new Error('Oscar patch is invalid or changes protected source outside ProfileUpdateView.form_valid');
        }
      },
    },
    copySource: (root, target, signal) => copyOscarSource(root, target, bridgeRoot, signal),
    backupDatabase: backupOscarDatabase(python),
    withBuild: withOscarBuild(python),
  };
}
