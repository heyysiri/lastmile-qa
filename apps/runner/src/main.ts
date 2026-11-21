import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createServer } from './server';

const root = fileURLToPath(new URL('../../../', import.meta.url));
config({ path: resolve(root, '.env'), quiet: true });

try {
  const app = createServer({
    databasePath: resolve(root, process.env.QA_DATABASE_PATH || '.data/qa.sqlite'),
    artifactRoot: resolve(root, process.env.ARTIFACT_ROOT || 'artifacts/runs'),
    sellerDemoUrl: process.env.SELLER_DEMO_URL,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
  const address = await app.listen({ host: '127.0.0.1', port: Number(process.env.RUNNER_PORT || 4000) });
  console.log(`Runner listening at ${address}`);
} catch {
  console.error('Runner could not start. Check its configuration and port.');
  process.exitCode = 1;
}
