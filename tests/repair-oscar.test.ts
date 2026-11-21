import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOscarRepairAdapter } from '../apps/runner/src/repair-oscar';
import { applyRepairPatch, createRepairPatch, hashBytes } from '../apps/runner/src/repair-workspace';

const repo = fileURLToPath(new URL('../', import.meta.url));
const oscarRepo = process.env.OSCAR_REPAIR_TEST_REPO ?? repo;
const upstream = join(oscarRepo, '.local-work/p2/oscar-upstream');
const venv = join(oscarRepo, '.local-work/p2/oscar-venv/bin/python');
const bridgeRoot = join(oscarRepo, 'integrations/oscar');
const ready = await Promise.all([access(join(upstream, 'sandbox/settings.py')), access(venv)]).then(() => true, () => false);
const python = ready ? venv : '/usr/bin/python3';
const adapter = createOscarRepairAdapter({ bridgeRoot, python });
const sourcePath = 'src/oscar/apps/customer/views.py';
const source = `from django.views import generic

class ProfileUpdateView(generic.FormView):
    def form_valid(self, form):
        # Keep profile settings
        form.save()
        reset_basket()
        return self.success_url

    def send_email_changed_email(self, old_user, new_email):
        send_notification(old_user, new_email)
`;
const fixed = source.replace('        reset_basket()\n', '');
let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'oscar-repair-test-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

it('allows only the body of ProfileUpdateView.form_valid to change', async () => {
  await mkdir(join(folder, 'src/oscar/apps/customer'), { recursive: true });
  await writeFile(join(folder, sourcePath), source);
  const propose = (after: string, path = sourcePath) => createRepairPatch(folder, adapter.patchPolicy, {
    summary: 'Preserve the basket on a profile edit', changes: [{ path, after }],
  });
  await expect(propose(fixed)).resolves.toMatchObject({ changes: [{ after: fixed }] });
  for (const after of [
    fixed.replace('from django.views import generic', 'import fake as generic'),
    fixed.replace('def form_valid(self, form):', 'def form_valid(self, form=None):'),
    fixed.replace('    def form_valid', '    @decorator\n    def form_valid'),
    fixed.replace('class ProfileUpdateView(generic.FormView):', 'class ProfileUpdateView:'),
    fixed.replace('send_notification(old_user, new_email)', 'pass'),
    fixed.replace('form.save()', 'form.save('),
    fixed + '\ndef injected():\n    pass\n',
  ]) {
    await expect(propose(after)).rejects.toThrow(/protected|invalid/i);
  }
  await expect(propose(fixed, 'src/oscar/apps/customer/forms.py')).rejects.toThrow(/protected/i);
});

it('validates Django checkpoints with Python canonical JSON and scrubs sessions from a WAL snapshot', async () => {
  const from = join(folder, 'live.sqlite');
  const to = join(folder, 'snapshot.sqlite');
  const id = 'fd2d72e2-e576-4f5d-866f-7b78d1bbdc90';
  const session = 'session-only-sentinel';
  const digest = hashBytes('{"numeric":1.0,"profile":{"firstName":"Zo\\u00eb \\ud83c\\udf31"},"z":true}');
  // Noncanonical order and whitespace test that validation hashes parsed state.
  const state = '{"profile": {"firstName": "Zoë 🌱"}, "numeric": 1.0, "z": true}';
  const original = new Database(from);
  try {
    original.pragma('journal_mode = WAL');
    original.exec('CREATE TABLE django_session (session_key TEXT); CREATE TABLE qa_bridge_checkpoint (id TEXT PRIMARY KEY, digest TEXT, state TEXT);');
    original.prepare('INSERT INTO django_session VALUES (?)').run(session);
    original.prepare('INSERT INTO qa_bridge_checkpoint VALUES (?, ?, ?)').run(id.replaceAll('-', ''), digest, state);
    await adapter.backupDatabase(from, to, [{ id, digest }]);
    const saved = new Database(to, { readonly: true });
    try {
      expect(saved.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(saved.prepare('SELECT * FROM django_session').all()).toEqual([]);
      expect(saved.prepare('SELECT digest, state FROM qa_bridge_checkpoint').get()).toEqual({ digest, state });
    } finally { saved.close(); }
    expect((await readFile(to)).includes(session)).toBe(false);
    expect(original.prepare('SELECT * FROM django_session').all()).toEqual([{ session_key: session }]);
    expect(original.prepare('SELECT digest, state FROM qa_bridge_checkpoint').get()).toEqual({ digest, state });
    await expect(adapter.backupDatabase(from, join(folder, 'bad-id.sqlite'), [{ id: 'missing', digest }])).rejects.toThrow(/checkpoint/i);
    await expect(adapter.backupDatabase(from, join(folder, 'bad-digest.sqlite'), [{ id, digest: '0'.repeat(64) }])).rejects.toThrow(/checkpoint/i);
    original.prepare('UPDATE qa_bridge_checkpoint SET state = ?').run('{}');
    await expect(adapter.backupDatabase(from, join(folder, 'bad-state.sqlite'), [{ id, digest }])).rejects.toThrow(/checkpoint/i);
  } finally { original.close(); }
});

it.skipIf(!ready)('serves the copied Oscar app and clones a checkpoint in a private database, then closes the server', async () => {
  const tree = join(folder, 'app');
  const databasePath = join(folder, 'private.sqlite');
  const testToken = 'disposable-oscar-test-token';
  const defect = 'reset-basket-on-profile-save';
  const signal = AbortSignal.timeout(30_000);
  await adapter.copySource(upstream, tree, signal);
  expect(await readFile(join(tree, '.lastmile/requirements.md'))).toEqual(await readFile(join(upstream, '.lastmile/requirements.md')));
  const profileSource = await readFile(join(tree, sourcePath), 'utf8');
  expect(profileSource).toBe(await readFile(join(upstream, sourcePath), 'utf8'));
  await access(join(tree, 'src/oscar/static/oscar/css/styles.css'));
  for (const path of ['.git', 'node_modules', 'sandbox/public/media', '.lastmile/bridge/test_bridge.py', 'src/oscar/__pycache__']) {
    await expect(access(join(tree, path))).rejects.toThrow();
  }

  const manage = '.lastmile/bridge/manage.py';
  const env = {
    OSCAR_ROOT: tree, OSCAR_DATABASE_PATH: databasePath, PYTHONDONTWRITEBYTECODE: '1',
    OSCAR_DEMO_DEFECT: defect,
  };
  execFileSync(python, [manage, 'migrate', '--run-syncdb', '--noinput'], { cwd: tree, env, timeout: 20_000 });

  // Compare to the real source and bridge contents without contacting the shared app.
  const releaseId = execFileSync(python, ['-c', `
import django, manage
django.setup()
from qa_bridge.middleware import build_id
print(build_id())
`], { cwd: bridgeRoot, env: { ...env, OSCAR_ROOT: upstream }, encoding: 'utf8', timeout: 10_000 }).trim();

  const wrapper = join(folder, 'python');
  await writeFile(wrapper, '#!/bin/sh\nif [ -n "$OPENAI_API_KEY" ] || [ -n "$PYTHONPATH" ]; then exit 1; fi\nexec ' + JSON.stringify(python) + ' "$@"\n', { mode: 0o700 });
  const isolated = createOscarRepairAdapter({ bridgeRoot, python: wrapper });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'should-not-reach-python';
  let origin = '';
  let checkpointId = '';
  const finish = new Error('intentional callback failure');

  async function post(path: string, body: object) {
    const response = await fetch(origin + '/api/test/' + path, {
      method: 'POST', headers: { authorization: 'Bearer ' + testToken, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    expect(response.ok).toBe(true);
    return response.json();
  }

  async function state(namespaceId: string) {
    const response = await fetch(origin + '/api/test/state?namespaceId=' + namespaceId, {
      headers: { authorization: 'Bearer ' + testToken }, signal,
    });
    expect(response.ok).toBe(true);
    return response.json();
  }

  async function saveProfile(clone: { namespaceId: string; cookie: { name: string; value: string } }) {
    const { profile: { email } } = await state(clone.namespaceId);
    const url = origin + '/en-gb/accounts/profile/edit/';
    const cookie = clone.cookie.name + '=' + clone.cookie.value;
    const form = await fetch(url, { headers: { cookie }, redirect: 'manual', signal });
    expect(form.status).toBe(200);
    const csrf = form.headers.getSetCookie().find(value => value.startsWith('csrftoken='))?.split(';')[0];
    if (!csrf) throw new Error('Profile form did not issue a CSRF cookie');
    const response = await fetch(url, {
      method: 'POST', redirect: 'manual', signal,
      headers: { cookie: cookie + '; ' + csrf, 'x-csrftoken': csrf.slice('csrftoken='.length) },
      body: new URLSearchParams({ email, first_name: 'River', last_name: 'Tester' }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/en-gb/accounts/profile/');
    return state(clone.namespaceId);
  }

  try {
    await expect(isolated.withBuild({ root: upstream, tree, databasePath, testToken, defect, signal }, async (server) => {
      origin = server.origin;
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
      expect(server.buildId).toBe(releaseId);
      // Oscar lazily creates this image on the first basket render. Parallel
      // customers must find it ready before either request starts.
      expect(await readFile(join(tree, 'sandbox/public/media/image_not_found.jpg')))
        .toEqual(await readFile(join(tree, 'src/oscar/static/oscar/img/image_not_found.jpg')));
      expect((await fetch(origin + '/api/test/build', { signal })).status).toBe(401);
      expect((await fetch(origin + '/', { signal })).ok).toBe(true);

      const { namespaceId } = await post('accounts/session', { fixtureId: 'returning-customer', accountKey: 'private-fixture' });
      const checkpoint = await post('checkpoints', { namespaceId, requestId: 'private-checkpoint' });
      checkpointId = checkpoint.id;
      const clone = await post('checkpoints/' + checkpoint.id + '/clone', { cloneKey: 'private-clone' });
      expect(clone.namespaceId).not.toBe(namespaceId);
      expect(clone.digest).toBe(checkpoint.digest);
      expect(await state(clone.namespaceId)).toMatchObject({ basket: { quantity: 4 }, orderCount: 0 });
      expect(await saveProfile(clone)).toMatchObject({ profile: { firstName: 'River' }, basket: { quantity: 1 } });
      throw finish;
    })).rejects.toBe(finish);
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }

  const policy = adapter.patchPolicy;
  const after = profileSource.replace(/^        # LASTMILE DEMO REGRESSION:[^\n]*\n(?:[^\n]*\n){3}/m, '');
  const patch = await createRepairPatch(tree, policy, { summary: 'Preserve the basket after a profile save', changes: [{ path: sourcePath, after }] });
  await applyRepairPatch({ tree, policy, patch });

  const controller = new AbortController();
  await expect(adapter.withBuild({ root: upstream, tree, databasePath, testToken, defect, signal: controller.signal }, async server => {
    origin = server.origin;
    expect(server.buildId).not.toBe(releaseId);
    const clone = await post('checkpoints/' + checkpointId + '/clone', { cloneKey: 'patched-clone' });
    expect(await saveProfile(clone)).toMatchObject({ profile: { firstName: 'River' }, basket: { quantity: 4 } });
    controller.abort(finish);
    return new Promise(() => {});
  })).rejects.toBe(finish);
  await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}, 35_000);
