import { createApi } from './api';
import { resolveDatabasePath } from './config';
import { SellerStore } from './store';

const g = globalThis as unknown as { __sellerRuntime?: { store: SellerStore; api: ReturnType<typeof createApi> } };

export function runtime() {
  if (!g.__sellerRuntime) {
    const store = new SellerStore(resolveDatabasePath(process.env));
    g.__sellerRuntime = { store, api: createApi({ store, env: process.env }) };
  }
  return g.__sellerRuntime;
}
