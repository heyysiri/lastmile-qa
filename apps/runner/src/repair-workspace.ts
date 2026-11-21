import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PatchProposalSchema, type PatchProposal } from '@lastmile/contracts/evolution';
import { hashValue } from './artifacts';

const exec = promisify(execFile);
const maxFileBytes = 150_000;
const maxPatchBytes = 250_000;
export const hashBytes = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export type RepairPatchPolicy = {
  editable: readonly string[];
  validateEdit?: (path: string, before: string, after: string) => void;
};

const proposalSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  changes: z.array(z.object({ path: z.string().min(1), after: z.string().max(maxFileBytes) }).strict()).min(1).max(4),
}).strict();

async function sourceFile(root: string, path: string) {
  const parts = path.split('/');
  if (isAbsolute(path) || path.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid relative repair source path');
  }
  let current = root;
  for (const segment of parts.slice(0, -1)) {
    current = join(current, segment);
    if (!(await lstat(current)).isDirectory()) throw new Error('Repair source parent must be a directory without symlinks');
  }
  current = join(current, parts.at(-1)!);
  const info = await lstat(current);
  if (!info.isFile()) throw new Error('Repair source must be a regular file without symlinks');
  return { path: current, mode: info.mode & 0o777 };
}

export async function readSourceText(root: string, path: string) {
  return readFile((await sourceFile(root, path)).path, 'utf8');
}

const excluded = (path: string) => path.split('/').some(part =>
  part.startsWith('.env') || ['.git', '.data', '.next', 'artifacts', 'node_modules', '.local-work', '.worktrees'].includes(part),
);

async function copyFile(root: string, target: string, path: string) {
  const source = await sourceFile(root, path);
  await mkdir(join(target, ...path.split('/').slice(0, -1)), { recursive: true, mode: 0o700 });
  await writeFile(join(target, path), await readFile(source.path), { flag: 'wx', mode: source.mode });
}

export async function copyTrackedSource(root: string, target: string, signal?: AbortSignal) {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '-z', '--stage'], { timeout: 5000, maxBuffer: 4_000_000, signal });
  await mkdir(target, { mode: 0o700 });
  for (const entry of stdout.split('\0').filter(Boolean)) {
    signal?.throwIfAborted();
    const split = entry.indexOf('\t');
    const [mode, , stage] = entry.slice(0, split).split(' ');
    const path = entry.slice(split + 1);
    if (excluded(path)) continue;
    if (!['100644', '100755'].includes(mode) || stage !== '0') throw new Error('Tracked repair source must be a regular file without symlinks');
    await copyFile(root, target, path);
  }
}

async function sourcePaths(directory: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = prefix + entry.name;
    if (excluded(path)) throw new Error('Unexpected file in frozen repair source');
    if (entry.isDirectory()) paths.push(...await sourcePaths(join(directory, entry.name), path + '/'));
    else if (entry.isFile()) paths.push(path);
    else throw new Error('Frozen repair source contains a symlink or special file');
  }
  return paths;
}

export async function hashSourceTree(root: string) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Missing frozen source directory');
  const entries = [];
  for (const path of await sourcePaths(root)) {
    const source = await sourceFile(root, path);
    entries.push([path, source.mode, hashBytes(await readFile(source.path))]);
  }
  return hashValue(entries);
}

export async function copyFrozenSource(root: string, target: string, signal: AbortSignal) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Missing frozen source directory');
  await mkdir(target, { mode: 0o700 });
  for (const path of await sourcePaths(root)) {
    signal.throwIfAborted();
    await copyFile(root, target, path);
  }
}

function validateChanges(policy: RepairPatchPolicy, changes: PatchProposal['changes']) {
  let bytes = 0;
  for (const { path, before, after } of changes) {
    if (!policy.editable.includes(path) || excluded(path)) throw new Error('Proposed patch targets a protected file');
    if (before === after) throw new Error('Proposed patch contains an unchanged file');
    const beforeBytes = Buffer.byteLength(before);
    const afterBytes = Buffer.byteLength(after);
    bytes += beforeBytes + afterBytes;
    if (beforeBytes > maxFileBytes || afterBytes > maxFileBytes || bytes > maxPatchBytes) {
      throw new Error('Proposed patch exceeds the size limit');
    }
    policy.validateEdit?.(path, before, after);
  }
}

export async function createRepairPatch(tree: string, policy: RepairPatchPolicy, raw: unknown): Promise<PatchProposal> {
  const { summary, changes } = proposalSchema.parse(raw);
  const paths = changes.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some(path => !policy.editable.includes(path))) {
    throw new Error('Proposed patch targets duplicate or protected files');
  }
  const edits = [];
  for (const { path, after } of [...changes].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const before = await readSourceText(tree, path);
    edits.push({ path, before, beforeHash: hashBytes(before), after });
  }
  validateChanges(policy, edits);
  const body = { summary, changes: edits };
  return PatchProposalSchema.parse({ ...body, hash: hashValue(body) });
}

export async function applyRepairPatch({ tree, policy, patch }: { tree: string; policy: RepairPatchPolicy; patch: PatchProposal }) {
  const { hash, summary, changes } = PatchProposalSchema.parse(patch);
  if (hash !== hashValue({ summary, changes })) throw new Error('Reviewed patch hash changed');
  validateChanges(policy, changes);
  const writes: { path: string; content: string }[] = [];
  for (const { path, beforeHash, before, after } of changes) {
    const source = await sourceFile(tree, path);
    const current = await readFile(source.path);
    if (hashBytes(current) !== beforeHash || hashBytes(before) !== beforeHash) throw new Error('Reviewed patch source changed');
    writes.push({ path: source.path, content: after });
  }
  for (const { path, content } of writes) await writeFile(path, content);
}

export async function readRepairBuild(origin: string, testToken: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(new URL('/api/test/build', origin), {
    headers: { authorization: `Bearer ${testToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error',
  });
  if (!response.ok) throw new Error('Application build identity is unavailable');
  const body = await response.json();
  if (typeof body.buildId !== 'string' || !body.buildId) throw new Error('Application build identity is missing');
  return body.buildId;
}

export type RepairBuildOptions = {
  root: string; tree: string; databasePath: string; testToken: string; defect?: string; signal: AbortSignal;
};
export type RepairServing = { origin: string; buildId: string };
export type WithRepairBuild = <T>(options: RepairBuildOptions, use: (server: RepairServing) => Promise<T>) => Promise<T>;
