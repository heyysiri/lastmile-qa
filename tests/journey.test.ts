import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {desktopContext,storeScenario} from '../packages/contracts/src/examples';
import type {EvidenceRun,BrowserAction} from '../packages/contracts/src/runtime';
const mocks=vi.hoisted(()=>({session:vi.fn(),agent:vi.fn(),verify:vi.fn()}));
vi.mock('../apps/runner/src/browser',()=>({createBrowserSession:mocks.session,replayPosition:async()=>({url:'/onboarding',focus:'none'})}));
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

it('persists the before-state checkpoint and hashes frozen preservation checks before browser actions',async()=>{
 const {hashValue}=await import('../apps/runner/src/artifacts');
 const directory=await mkdtemp(join(tmpdir(),'persistent-journey-'));
 const run:EvidenceRun={id:'persistent-test',requestId:'test',scenario:structuredClone(storeScenario),context:desktopContext,inputs:{storeName:'Siri Crafts'},status:'running',verdict:null,createdAt:new Date().toISOString(),manifestHash:'hash',executionMode:'ai_guided',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[],continuity:{populationId:'p',testerId:'t',mode:'continue',initialStateId:'fresh',workflowId:'store-setup',history:[],preserveStatePaths:['inventory.0.quantity']}};
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({buildId:'build'})));
 const updates:EvidenceRun[]=[];
 mocks.session.mockImplementation(async(options)=>{
  expect(updates[0].continuity?.startCheckpoint).toEqual({id:'cp',digest:'digest'});
  return {page:{},execute:vi.fn(async()=>''),actions:[{action:{tool:'navigate',path:'/onboarding'},url:'/onboarding',observation:'Page'}],capabilities:[],close:async()=>writeFile(join(options.artifactDirectory,'final.png'),'image')};
 });
 mocks.agent.mockResolvedValue({modelCalls:1,finished:true,reason:'done'});
 mocks.verify.mockResolvedValue([...storeScenario.contract.assertions.map(a=>({id:a.id,status:'passed'})),{id:'preserve-0',status:'failed',expected:250,actual:5}]);
 try{
  const executor=createJourneyExecutor({origin:'http://localhost:3001',artifactRoot:directory,testToken:'secret',model:'fake',prepareSession:async(record)=>{
   record.continuity!.startCheckpoint={id:'cp',digest:'digest'};
   record.scenario.contract.assertions.push({id:'preserve-0',kind:'state_equals',path:'inventory.0.quantity',expected:{literal:250}});
   return {namespaceId:'stable-account',cookie:{name:'session',value:'secret-cookie',path:'/'}};
  }});
  const result=await executor(run,update=>updates.push(structuredClone(update)));
  expect(result.verdict).toBe('failed');
  expect(result.evidence?.scenarioHash).toBe(hashValue(result.scenario));
  expect(result.evidence?.scenarioHash).not.toBe(hashValue(storeScenario));
  expect(result.findings[0].description).toMatch(/inventory.0.quantity.*250.*5/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('refreshes visible controls before each replay action without asking the model or retrying mutations',async()=>{
 const {hashValue}=await import('../apps/runner/src/artifacts');
 const {hashReplayPlan}=await import('../apps/runner/src/replay');
 const directory=await mkdtemp(join(tmpdir(),'replay-observation-'));
 const run:EvidenceRun={id:'replay-observe',requestId:'test',scenario:structuredClone(storeScenario),context:desktopContext,inputs:{storeName:'Siri Crafts'},status:'running',verdict:null,createdAt:new Date().toISOString(),manifestHash:'hash',executionMode:'deterministic',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[]};
 const plan={version:1 as const,sourceRunIds:['source'],buildId:'build',scenarioHash:hashValue(run.scenario),actions:[{action:{tool:'navigate' as const,path:'/onboarding'},url:'/onboarding',observation:'Page'},{action:{tool:'click' as const,locator:{by:'role' as const,value:'button',name:'Save store'}},url:'/onboarding',observation:'Saved'}]};
 const calls:string[]=[];
 let refreshed=false;
 vi.stubGlobal('fetch',vi.fn(async(url:URL)=>Response.json(url.pathname.endsWith('/build')?{buildId:'build'}:{namespaceId:'namespace',cookie:{name:'session',value:'synthetic',path:'/'}})));
 mocks.session.mockImplementation(async()=>({page:{},refreshObservation:async()=>{refreshed=true;calls.push('observe');return 'Fresh visible controls';},execute:async(action:BrowserAction)=>{calls.push(action.tool);if(action.tool==='click'&&!refreshed)throw new Error('Observed DOM nodes replaced during hydration');refreshed=false;return 'Done';},actions:[],capabilities:[],close:async()=>{}}));
 mocks.verify.mockResolvedValue(storeScenario.contract.assertions.map(a=>({id:a.id,status:'passed'})));
 try{
  const result=await createJourneyExecutor({origin:'http://localhost:3001',artifactRoot:directory,testToken:'secret',model:'fake'})(run,()=>{},{...plan,hash:hashReplayPlan(plan)});
  expect(result.verdict).toBe('passed');expect(result.evidence?.modelCalls).toBe(0);expect(mocks.agent).not.toHaveBeenCalled();
  expect(calls).toEqual(['navigate','observe','click']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
