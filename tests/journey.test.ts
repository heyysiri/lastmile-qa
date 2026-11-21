import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {desktopContext,storeScenario} from '../packages/contracts/src/examples';
import type {EvidenceRun} from '../packages/contracts/src/runtime';
const mocks=vi.hoisted(()=>({session:vi.fn(),agent:vi.fn(),verify:vi.fn()}));
vi.mock('../apps/runner/src/browser',()=>({createBrowserSession:mocks.session}));
vi.mock('../apps/runner/src/agent',()=>({runAgent:mocks.agent}));
vi.mock('../apps/runner/src/verifier',()=>({verifyOutcome:mocks.verify,safeMessage:()=> 'Safe error'}));
import {createJourneyExecutor} from '../apps/runner/src/journey';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('keeps privileged readback outside the browser, binds namespace and persists independent evidence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'journey-'));
 const run:EvidenceRun={id:'journey-test',requestId:'test',scenario:storeScenario,context:desktopContext,inputs:{storeName:'Siri Crafts'},status:'running',verdict:null,createdAt:new Date().toISOString(),manifestHash:'hash',executionMode:'ai_guided',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[]};
 const fetchMock=vi.fn(async(url:URL)=>Response.json(url.pathname.endsWith('/build')?{buildId:'build'}:url.pathname.endsWith('/sessions')?{namespaceId:'namespace',cookie:{name:'session',value:'synthetic',path:'/'}}:{namespaceId:'namespace',store:{name:'Siri Crafts',status:'ready'}}));
 vi.stubGlobal('fetch',fetchMock);
 mocks.session.mockImplementation(async(options)=>({page:{},execute:vi.fn(async()=>''),actions:[{action:{tool:'navigate',path:'/onboarding'},url:'/onboarding',observation:'Page'}],capabilities:[],networkEvents:[],close:async()=>writeFile(join(options.artifactDirectory,'final.png'),'image')}));
 mocks.agent.mockResolvedValue({modelCalls:2,finished:true,reason:'done'});
 mocks.verify.mockImplementation(async(input)=>{expect((await input.readState()).namespaceId).toBe('namespace');return storeScenario.contract.assertions.map(a=>({id:a.id,status:'passed'}));});
 try {
  const execute=createJourneyExecutor({origin:'http://localhost:3001',artifactRoot:directory,testToken:'server-secret',model:'test-model',apiKey:'model-secret'});
  const result=await execute(run,()=>{});
  expect(result.verdict).toBe('passed');expect(result.namespaceId).toBe('namespace');
  expect(result.artifacts).toContain('journey-test/readback.json');
  expect(mocks.session.mock.calls[0][0]).not.toHaveProperty('testToken');
  expect(JSON.stringify(result)).not.toContain('server-secret');expect(JSON.stringify(result)).not.toContain('model-secret');
  expect(fetchMock.mock.calls).toHaveLength(4);
  fetchMock.mockImplementation(async()=>Response.json({buildId:'changed-build'}));
  const staleRun:EvidenceRun={...run,id:'stale-build',expectedBuildId:'original-build'};
  const stale=await execute(staleRun,()=>{});
  expect(stale.verdict).toBe('inconclusive');
  expect(mocks.session).toHaveBeenCalledTimes(1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
