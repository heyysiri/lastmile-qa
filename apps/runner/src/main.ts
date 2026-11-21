import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createServer } from './server';
import { createJourneyExecutor } from './journey';
import { createApplications, validateApplicationInputValues } from './applications';
import { createStudyGenerator } from './study-generator';

const root = fileURLToPath(new URL('../../../', import.meta.url));
config({ path: resolve(root, '.env'), quiet: true });

try {
  const journey = createJourneyExecutor({origin:process.env.SELLER_DEMO_URL || 'http://127.0.0.1:3001',artifactRoot:resolve(root,process.env.ARTIFACT_ROOT || 'artifacts/runs'),testToken:process.env.TEST_API_TOKEN || 'local-development-test',apiKey:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL || 'gpt-4.1-mini'});
  const app = createServer({
    validateStudyUser: validateApplicationInputValues,
    applications: createApplications(process.env.SELLER_DEMO_URL || 'http://127.0.0.1:3001'),
    generateStudy: createStudyGenerator({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', testToken: process.env.TEST_API_TOKEN || 'local-development-test' }),
    databasePath: resolve(root, process.env.QA_DATABASE_PATH || '.data/qa.sqlite'),
    artifactRoot: resolve(root, process.env.ARTIFACT_ROOT || 'artifacts/runs'),
    sellerDemoUrl: process.env.SELLER_DEMO_URL,
    getBuildId:async()=>{const response=await fetch(new URL('/api/test/build',process.env.SELLER_DEMO_URL||'http://127.0.0.1:3001'),{headers:{authorization:`Bearer ${process.env.TEST_API_TOKEN||'local-development-test'}`},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Build service unavailable');const body=await response.json();if(typeof body.buildId!=='string'||!body.buildId)throw new Error('Build identity missing');return body.buildId;},
    executeRun: journey,
    executeReplay: journey,
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
