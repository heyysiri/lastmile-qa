import { join } from 'node:path';
import { findRepoRoot } from './config';
import { servedBuildId } from './build';
import { createApi } from './api';
import { resolveDatabasePath } from './config';
import { SellerStore } from './store';

const g = globalThis as unknown as { __sellerRuntime?: { store: SellerStore; api: ReturnType<typeof createApi> } };

export function runtime() {
  if (!g.__sellerRuntime) {
    const store = new SellerStore(resolveDatabasePath(process.env));
    g.__sellerRuntime = { store, api: createApi({ store, env: process.env, getBuildId: () => servedBuildId(join(/* turbopackIgnore: true */ findRepoRoot(process.cwd()), 'apps/seller-demo'), `${process.env.SELLER_DEMO_DEFECT || ''}:${process.env.SELLER_BUILD_ID || ''}`, process.env.NODE_ENV === 'production') }) };
  }
  return g.__sellerRuntime;
}
