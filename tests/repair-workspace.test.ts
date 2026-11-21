import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SellerStore } from '../apps/seller-demo/lib/store';
import { applyRepairPatch, copyTrackedSource, createRepairPatch, hashSourceTree, readSourceText } from '../apps/runner/src/repair-workspace';
import { backupSellerDatabase, repairChildEnvironment, sellerPatchPolicy } from '../apps/runner/src/repair-seller';

const sourcePath = 'apps/seller-demo/lib/store.ts';
const original = await readFile(new URL('../apps/seller-demo/lib/store.ts', import.meta.url), 'utf8');
const fixed = original.replace("if (resetStock) this.db.prepare('UPDATE inventory SET quantity = 5 WHERE namespace_id = ?').run(namespaceId);", 'void resetStock;');
let dir: string;
let root: string;
let snapshot: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'repair-workspace-test-'));
  root = join(dir, 'root');
  snapshot = join(dir, 'snapshot');
  await mkdir(join(root, 'apps/seller-demo/lib'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, sourcePath), original);
  await writeFile(join(root, 'package.json'), '{}');
  execFileSync('git', ['-C', root, 'add', '.']);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('creates and applies an exact patch to a framework route file with a dollar parameter',async()=>{
 const path='apps/seller-demo/lib/products_.$id.tsx';
 await writeFile(join(root,path),'export const title = "wrong";');
 const policy={editable:[path]};
 const patch=await createRepairPatch(root,policy,{summary:'Preserve the full title',changes:[{path,search:'"wrong"',replace:'"right"'}]});
 await applyRepairPatch({tree:root,policy,patch});
 expect(await readFile(join(root,path),'utf8')).toBe('export const title = "right";');
});

it('copies tracked sources while excluding environments, state, and untracked files', async () => {
  await mkdir(join(root, '.data'));
  await writeFile(join(root, '.data/fake.sqlite'), 'fake');
  await writeFile(join(root, '.env'), 'mock');
  await writeFile(join(root, 'untracked.txt'), 'untracked');
  execFileSync('git', ['-C', root, 'add', '.env', '.data']);
  await copyTrackedSource(root, snapshot);
  expect(await readSourceText(snapshot, sourcePath)).toBe(original);
  for (const path of ['.env', '.data/fake.sqlite', '.git/config', 'untracked.txt']) {
    await expect(readFile(join(snapshot, path))).rejects.toThrow();
  }
  const hash = await hashSourceTree(snapshot);
  await writeFile(join(snapshot, 'untracked.ts'), 'injected');
  expect(await hashSourceTree(snapshot)).not.toBe(hash);
});

it('rejects symlink sources and symlinked parent directories', async () => {
  await symlink(join(root, sourcePath), join(root, 'link.ts'));
  execFileSync('git', ['-C', root, 'add', 'link.ts']);
  await expect(copyTrackedSource(root, snapshot)).rejects.toThrow(/symlink|regular/i);
  await rm(join(root, 'link.ts'));
  const lib = join(root, 'apps/seller-demo/lib');
  await rm(lib, { recursive: true });
  await symlink(dir, lib);
  await expect(readSourceText(root, sourcePath)).rejects.toThrow(/symlink|directory/i);
});

it.each([
  ['../store.ts', fixed],
  ['apps/seller-demo/lib/api.ts', fixed],
  [sourcePath, original],
  [sourcePath, original.replace('return { namespaceId, store: store ?? null, inventory };', 'throw new Error("replaced oracle");')],
  [sourcePath, original.replace('export const FIXTURES:', 'export const FIXTURES /* tampered */:')],
])('rejects an invalid edit to %s', async (path, after) => {
  await expect(createRepairPatch(root, sellerPatchPolicy, { summary: 'Repair', changes: [{ path, after }] })).rejects.toThrow();
});

it('validates and applies exact reviewed content only in the supplied snapshot', async () => {
  await copyTrackedSource(root, snapshot);
  const patch = await createRepairPatch(snapshot, sellerPatchPolicy, { summary: 'Preserve stock', changes: [{ path: sourcePath, after: fixed }] });
  const options = { tree: snapshot, policy: sellerPatchPolicy, patch };
  await expect(applyRepairPatch({ ...options, patch: { ...patch, hash: '0'.repeat(64) } })).rejects.toThrow(/hash/i);
  await writeFile(join(snapshot, sourcePath), original + '\n');
  await expect(applyRepairPatch(options)).rejects.toThrow(/source/i);
  await writeFile(join(snapshot, sourcePath), original);
  await applyRepairPatch(options);
  expect(await readSourceText(snapshot, sourcePath)).toBe(fixed);
  expect(await readSourceText(root, sourcePath)).toBe(original);
});

it('assembles an exact unique replacement into a complete reviewable patch', async () => {
  const search = "if (resetStock) this.db.prepare('UPDATE inventory SET quantity = 5 WHERE namespace_id = ?').run(namespaceId);";
  const patch = await createRepairPatch(root, sellerPatchPolicy, { summary: 'Preserve stock', changes: [{ path: sourcePath, search, replace: 'void resetStock;' }] });
  expect(patch.changes[0].before).toBe(original);
  expect(patch.changes[0].after).toBe(fixed);
  expect(await readSourceText(root, sourcePath)).toBe(original);
});

it.each(['', 'missing source text', 'namespaceId'])('rejects an absent or ambiguous exact replacement %s', async search => {
  await expect(createRepairPatch(root, sellerPatchPolicy, { summary: 'Repair', changes: [{ path: sourcePath, search, replace: '' }] })).rejects.toThrow();
});

it('backs up live SQLite checkpoints without copying usable sessions or changing the source', async () => {
  const from = join(root, 'seller.sqlite');
  const to = join(dir, 'copy.sqlite');
  const seller = new SellerStore(from);
  try {
    const session = seller.openAccount('real', 'active-seller');
    const checkpoint = seller.captureCheckpoint(session.namespaceId, 'original');
    await backupSellerDatabase(from, to, [checkpoint]);
    const copied = new Database(to, { readonly: true });
    try {
      expect(copied.prepare('SELECT * FROM sessions').all()).toEqual([]);
      expect(copied.prepare('SELECT digest FROM checkpoints WHERE id = ?').get(checkpoint.id)).toEqual({ digest: checkpoint.digest });
    } finally { copied.close(); }
    expect(seller.resolveSession(session.token)).toBe(session.namespaceId);
  } finally { seller.close(); }
});

it('constructs a clean environment for build and start', () => {
  const env = repairChildEnvironment({ PATH: '/bin', HOME: '/home/test', TMPDIR: '/tmp', OPENAI_API_KEY: 'mock', RUNNER_API_TOKEN: 'mock', NODE_OPTIONS: '--mock', SELLER_DATABASE_PATH: 'wrong', SELLER_DEMO_DEFECT: 'wrong' }, {
    databasePath: '/private/seller.sqlite', testToken: 'private', defect: 'same',
  });
  expect(env).toEqual({
    PATH: '/bin', HOME: '/home/test', TMPDIR: '/tmp', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    ENABLE_TEST_API: 'true', TEST_API_TOKEN: 'private', SELLER_DATABASE_PATH: '/private/seller.sqlite', SELLER_DEMO_DEFECT: 'same',
  });
});
