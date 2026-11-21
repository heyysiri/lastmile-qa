import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Walk up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function resolveDatabasePath(env: Record<string, string | undefined>, cwd: string = process.cwd()): string {
  const configured = env.SELLER_DATABASE_PATH?.trim();
  if (configured && isAbsolute(configured)) return configured;
  // The runtime database is external state, never a bundled build asset.
  return join(/* turbopackIgnore: true */ findRepoRoot(cwd), configured || '.data/seller-demo.sqlite');
}
