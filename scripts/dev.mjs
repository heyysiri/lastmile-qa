import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(root, '.env'), quiet: true });
const defaults = {
  RUNNER_PORT: '4000', RUNNER_API_TOKEN: 'local-development-runner',
  TEST_API_TOKEN: 'local-development-test', ENABLE_TEST_API: 'true',
  SELLER_DEMO_URL: 'http://127.0.0.1:3001', RUNNER_URL: 'http://127.0.0.1:4000',
  QA_DATABASE_PATH: resolve(root, '.data/qa.sqlite'),
  SELLER_DATABASE_PATH: resolve(root, '.data/seller.sqlite'),
  ARTIFACT_ROOT: resolve(root, 'artifacts/runs'),
};
const env = { ...defaults, ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
const names = ['runner', 'seller-demo', 'lastmile'];
const command = process.argv.includes('--production') ? 'start' : 'dev';
const children = names.map(name => spawn('pnpm', ['--filter', `@lastmile/${name}`, command], { cwd: root, env, stdio: 'inherit', detached: true }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Child has already exited. */ } }
  process.exitCode = code;
}
children.forEach((child, index) => {
  child.on('error', error => { console.error(`Cannot start ${names[index]}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${names[index]} stopped (${code}); stopping the local stack.`); stop(code || 1); } });
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('LastMile QA: http://127.0.0.1:3000 | Seller demo: http://127.0.0.1:3001 | Runner: http://127.0.0.1:4000');
