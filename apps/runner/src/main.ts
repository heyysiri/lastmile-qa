import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createServer } from './server';
import { createTenantServer } from './tenant-server';
import { createPrivateWorkspace } from './private-workspace';
import { createJourneyExecutor } from './journey';
import { createApplications, validateApplicationInputValues } from './applications';
import { createStudyGenerator } from './study-generator';
import {createPersistentSessionPreparer} from './persistent-session';
import {createApplicationContextReader} from './application-context';
import {createJourneyPlanner} from './journey-planner';
import {createOscarApplication} from './oscar-application';
import {createRepairRuntime} from './repair-runtime';
import {createOscarRepairAdapter} from './repair-oscar';
import {createProjectRuntime} from './project-runtime';
import {createProjectRepository} from './project-repository';
import {createGitHubCredentials} from './github-credentials';

const root = fileURLToPath(new URL('../../../', import.meta.url));
config({ path: resolve(root, '.env'), quiet: true });

try {
  const privateMode = process.env.LASTMILE_AUTH === 'clerk' || Boolean(process.env.CLERK_SECRET_KEY);
  if (process.env.DASHBOARD_ORIGIN && !privateMode) throw new Error('Hosted dashboard requires Clerk authentication');
  if (privateMode) {
    const apiToken = process.env.RUNNER_API_TOKEN ?? '';
    const app = createTenantServer({
      root: resolve(root, '.data/workspaces'), apiToken,
      createWorkspace: directory => createPrivateWorkspace({
        directory, apiToken, model: process.env.OPENAI_MODEL,
        // Hosted execution must use isolated workers before it can run untrusted repository scripts.
        apiKey: process.env.DASHBOARD_ORIGIN ? undefined : process.env.OPENAI_API_KEY,
      }),
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
    const address = await app.listen({ host: '127.0.0.1', port: Number(process.env.RUNNER_PORT || 4000) });
    console.log(`Private workspace runner listening at ${address}`);
  } else {
  const oscar=process.env.LASTMILE_APPLICATION==='oscar';
  const origin=oscar?(process.env.OSCAR_URL||'http://127.0.0.1:8000'):(process.env.SELLER_DEMO_URL||'http://127.0.0.1:3001');
  const testToken=process.env.TEST_API_TOKEN||'local-development-test';
  const model=process.env.OPENAI_MODEL||'gpt-4.1-mini';
  const apiKey=process.env.OPENAI_API_KEY;
  const artifactRoot=resolve(root,process.env.ARTIFACT_ROOT||'artifacts/runs');
  const applicationRoot=oscar?resolve(root,process.env.OSCAR_ROOT||'.local-work/p2/oscar-upstream'):root;
  const sources:Parameters<typeof createApplicationContextReader>[1]=oscar?{'oscar-commerce':[
    {kind:'requirement' as const,path:'.lastmile/requirements.md'},
    {kind:'code' as const,path:'src/oscar/apps/customer/views.py',focus:'class ProfileUpdateView('},
    {kind:'code' as const,path:'src/oscar/apps/customer/forms.py',focus:'class UserForm('},
    {kind:'code' as const,path:'src/oscar/apps/basket/views.py',focus:'class BasketView('},
    {kind:'code' as const,path:'src/oscar/apps/basket/abstract_models.py',focus:'    def add_product('},
  ]}:{'seller-demo':[
    {kind:'requirement' as const,path:'apps/seller-demo/requirements.md'},
    {kind:'code' as const,path:'apps/seller-demo/lib/api.ts'},
    {kind:'code' as const,path:'apps/seller-demo/lib/store.ts'},
    {kind:'code' as const,path:'apps/seller-demo/components/StoreForm.tsx'},
    {kind:'code' as const,path:'apps/seller-demo/components/InventoryForm.tsx'},
  ]};
  const journey = createJourneyExecutor({prepareSession:createPersistentSessionPreparer({origin,testToken}),origin,artifactRoot,testToken,apiKey,model});
  const projectRuntime=apiKey?createProjectRuntime({privateRoot:resolve(root,'.data/projects'),artifactRoot,apiKey,model}):undefined;
  const githubCredentials=createGitHubCredentials({directory:resolve(root,'.data/credentials'),fallback:process.env.GITHUB_PAT});
  if(projectRuntime)projectRuntime.repository=createProjectRepository({root:resolve(root,'.data/repositories'),token:githubCredentials.token});
  const app = createServer({
    projectRuntime,
    githubCredentials,
    repairRuntime: apiKey ? createRepairRuntime({root:applicationRoot,workspaceRoot:resolve(root,'.data/repairs'),
      sellerDatabasePath:resolve(root,oscar?(process.env.OSCAR_DATABASE_PATH||'.data/oscar.sqlite'):(process.env.SELLER_DATABASE_PATH||'.data/seller-demo.sqlite')),
      artifactRoot,origin,testToken,apiKey,model,defect:oscar?process.env.OSCAR_DEMO_DEFECT:process.env.SELLER_DEMO_DEFECT},
      oscar?{adapter:createOscarRepairAdapter({bridgeRoot:resolve(root,'integrations/oscar'),python:resolve(root,'.local-work/p2/oscar-venv/bin/python')})}:undefined):undefined,
    getApplicationContext:createApplicationContextReader(applicationRoot,sources),
    generateSuggestions:apiKey?createJourneyPlanner({apiKey,model}):undefined,
    validateStudyUser: validateApplicationInputValues,
    applications: oscar?[createOscarApplication(origin)]:createApplications(origin),
    generateStudy: createStudyGenerator({apiKey,model,testToken}),
    databasePath: resolve(root, process.env.QA_DATABASE_PATH || '.data/qa.sqlite'),
    artifactRoot,
    sellerDemoUrl:origin,
    getBuildId:async()=>{const response=await fetch(new URL('/api/test/build',origin),{headers:{authorization:`Bearer ${testToken}`},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Build service unavailable');const body=await response.json();if(typeof body.buildId!=='string'||!body.buildId)throw new Error('Build identity missing');return body.buildId;},
    executeRun: journey,
    executeReplay: journey,
  });
  app.addHook('onClose',async()=>{await projectRuntime?.repository?.close?.();});
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
  const address = await app.listen({ host: '127.0.0.1', port: Number(process.env.RUNNER_PORT || 4000) });
  console.log(`Runner listening at ${address}`);
  }
} catch {
  console.error('Runner could not start. Check its configuration and port.');
  process.exitCode = 1;
}
