import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createServer} from '../apps/runner/src/server';
import {openRunStore} from '../apps/runner/src/store';
import {hashValue} from '../apps/runner/src/artifacts';
import {ContextPackSchema,ScenarioSchema} from '../packages/contracts/src';
import type {Project,ProjectDetail,ProjectDiscovery,ProjectRepair,ProjectRun,ProjectRuntime} from '../packages/contracts/src/projects';

const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const timestamp = '2026-01-01T00:00:00.000Z';
const source = {path:'stock.ts',startLine:1,endLine:1,hash:hashValue('before'),excerpt:'Stock remains unchanged'};
const proposal = {summary:'Preserve stock',changes:[{path:source.path,beforeHash:source.hash,before:'before',after:'after'}]};
const patch = {...proposal,hash:hashValue(proposal)};
const pullRequest = {url:'https://github.com/example/warehouse/pull/4',number:4,branch:'lastmile/repair',headSha:'c'.repeat(40),baseSha:sha};
const connection = {requestId:'connect',name:'Warehouse',repositoryUrl:'https://github.com/example/warehouse',branch:'release',brief:'Review warehouse stock'};

function discovery(project:Project):ProjectDiscovery {
 const testers=project.accounts.map(({id},i)=>{
  const context=ContextPackSchema.parse({id:`context-${i}`,label:'Warehouse',viewport:{width:1024,height:768},locale:'en',preferredLanguage:'English',familiarity:'experienced',interaction:'pointer',reducedMotion:'no-preference',network:{mode:'normal'},inputs:{}});
  return {id:`tester-${i}`,name:`Staff ${i}`,role:'Warehouse',summary:'Review stock',accountId:id,context};
 });
 return {
  index:{version:'e'.repeat(64),sourceLines:10,fileCount:1,excludedFiles:0,indexedAt:timestamp,changedPaths:[]},
  plan:{summary:'Warehouse',features:[{id:'stock',title:'Stock',description:'Review stock',sources:[source]}],roles:['Warehouse'],testers,
   journeys:testers.map(tester=>({id:`journey-${tester.id}`,testerId:tester.id,title:'Stock review',goal:'Review stock',entryPath:'/stock',inputs:{},sources:[source],reason:'Stock is part of the brief',
    checks:[{id:'stock',label:'Stock',kind:'visible',locator:{by:'text',value:'Stock'},basis:'requirement',phase:'after_action',sources:[source]}]})),gaps:[]},
  observations:[],modelCalls:1,durationMs:10,generatedAt:timestamp,
 };
}

function results(run:ProjectRun,failFirst:boolean,replay=false) {
 const {journeys,testers}=run.discovery!.plan;
 return journeys.map((journey,i)=>{
  const tester=testers.find(tester=>tester.id===journey.testerId)!;
  const failed=failFirst&&i===0;
  const status=failed?'failed' as const:'passed' as const;
  const checks=journey.checks.map(({id,label,basis,phase,sources})=>({id,label,basis,phase,sources,expected:true,actual:!failed,status}));
  const scenario=ScenarioSchema.parse({id:journey.id,label:journey.title,goal:journey.goal,entryPath:journey.entryPath,initialStateId:'stock',inputSlots:{},contract:{scope:'ui_only',assertions:[{id:'stock',kind:'visible',locator:{by:'text',value:'Stock'}}]}});
  return {tester,journey,checks,sessionContinued:false,run:{
   id:`${replay?'replay':'evidence'}-${run.id}-${i}`,requestId:run.request.requestId,scenario,context:tester.context,inputs:{},status:'completed' as const,
   verdict:status,createdAt:timestamp,manifestHash:'manifest',executionMode:replay?'deterministic' as const:'ai_guided' as const,
   steps:[],assertions:checks.map(({id,status,expected,actual})=>({id,status,expected,actual})),findings:[],capabilities:[],artifacts:[],
   evidence:{buildId:replay?'after':'before',scenarioHash:hashValue(scenario),policyVersion:'1',model:'test',actions:[{action:{tool:'navigate' as const,path:'/stock'},url:'/stock',observation:'Stock page'}],modelCalls:replay?0:1,finishedByAgent:!replay,replayCompatible:replay},
  }};
 });
}

type Repository=NonNullable<ProjectRuntime['repository']>;
function fakeRuntime({failFirst=false,verification='verified'}:{failFirst?:boolean;verification?:'verified'|'rejected'|'inconclusive'}={}){
 const prepare=vi.fn<Repository['prepare']>(async(project,secrets,mode)=>({
  repositoryPath:'/managed/warehouse',appUrl:'http://127.0.0.1:3005/stock',allowedOrigins:[],commands:{start:['warehouse']},
  github:{...project.github!,sha:mode==='sync'?nextSha:project.github?.sha??sha,syncedAt:timestamp},
  accounts:secrets.accounts.length?secrets.accounts:[{id:'staff',label:'Staff',username:'private-staff@example.test',password:'private-staff-password'},
   {id:'control',label:'Control',username:'private-control@example.test',password:'private-control-password'}],
 }));
 const publish=vi.fn<Repository['publish']>(async()=>pullRequest);
 const discover=vi.fn<ProjectRuntime['discover']>(async project=>discovery(project));
 const execute=vi.fn<ProjectRuntime['execute']>(async(_project,_secrets,run)=>({...run,status:'completed',phase:'Finished',results:results(run,failFirst),revision:'ignored-worker-revision'}));
 const repair={
  prepare:vi.fn<NonNullable<ProjectRuntime['repair']>['prepare']>(async()=>({patch,sourceVersion:'e'.repeat(64)})),
  verify:vi.fn<NonNullable<ProjectRuntime['repair']>['verify']>(async repair=>({outcome:verification,message:'Replayed',results:verification==='inconclusive'?[]:results(repair.sourceRun,verification==='rejected',true)})),
 };
 return {repository:{prepare,publish},discover,execute,repair};
}

const headers={authorization:'Bearer project-test'};
const roots:string[]=[];
const apps=new Set<ReturnType<typeof createServer>>();
afterEach(async()=>{
 for(const app of apps)await app.close();
 apps.clear();
 for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});

async function setup(runtime?:ProjectRuntime){
 const root=await mkdtemp(join(tmpdir(),'github-api-'));
 roots.push(root);
 const databasePath=join(root,'qa.sqlite');
 const open=()=>{
  const app=createServer({databasePath,apiToken:'project-test',projectRuntime:runtime});
  apps.add(app);
  const get=(url:string)=>app.inject({url,headers});
  const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{...headers,'content-type':'application/json'},payload:JSON.stringify(payload)});
  return {get,post,close:async()=>{await app.close();apps.delete(app);}};
 };
 return {...open(),databasePath,open};
}

async function connect(api:Awaited<ReturnType<typeof setup>>){
 const response=await api.post('/api/projects/github',connection);
 expect(response.statusCode).toBe(202);
 const {id}=response.json<Project>();
 expect(response.json()).toMatchObject({status:'discovering',repositoryPath:'',appUrl:'http://127.0.0.1:1/'});
 const url=`/api/projects/${id}`;
 const detail=async()=>(await api.get(url)).json<ProjectDetail>();
 await expect.poll(async()=>(await detail()).status).toBe('ready');
 return {id,url,detail};
}

it('persists one GitHub connection and its public cases across SQLite reopen',async()=>{
 const runtime=fakeRuntime();
 const api=await setup(runtime);
 const project=await connect(api);
 const before=await project.detail();
 expect(before).toMatchObject({github:{sha,branch:'release'},accounts:[{id:'staff',label:'Staff'},{id:'control',label:'Control'}],cases:[{id:'journey-tester-0'},{id:'journey-tester-1'}]});
 expect(JSON.stringify(before)).not.toMatch(/private-(staff|control)/);
 expect(runtime.discover.mock.calls[0][1].accounts[0].password).toBe('private-staff-password');
 await api.close();
 const reopened=api.open();
 const retry=await reopened.post('/api/projects/github',connection);
 expect(retry.statusCode).toBe(202);
 expect(retry.json().id).toBe(project.id);
 expect((await reopened.post('/api/projects/github',{...connection,branch:'other'})).statusCode).toBe(409);
 expect((await reopened.get(project.url)).json()).toEqual(before);
 expect(runtime.repository.prepare.mock.calls.map(([, ,mode])=>mode)).toEqual(['connect']);
});

it('syncs once per request and queues a pinned release run while preserving prior cases and history',async()=>{
 const runtime=fakeRuntime();
 const api=await setup(runtime);
 const project=await connect(api);
 const first=await api.post(`${project.url}/runs`,{requestId:'first'});
 expect(first.statusCode).toBe(202);
 expect(first.json<ProjectRun>().revision).toBe(sha);
 await expect.poll(async()=>(await project.detail()).github?.lastTestedSha).toBe(sha);
 const before=await project.detail();
 const syncUrl=`${project.url}/sync`;
 const prepare=runtime.repository.prepare.getMockImplementation()!;
 runtime.repository.prepare.mockImplementation(async(...args)=>{
  const prepared=await prepare(...args);
  if(args[2]==='sync')prepared.github={...prepared.github,coverageMode:'retain',verifiedCoverageRunId:before.runs[0].id};
  return prepared;
 });
 expect((await api.post(syncUrl,{requestId:'sync'})).statusCode).toBe(202);
 expect((await api.post(syncUrl,{requestId:'sync',run:true})).statusCode).toBe(202);
 expect((await api.post(syncUrl,{requestId:'sync',run:false})).statusCode).toBe(409);
 await expect.poll(async()=>(await project.detail()).github?.lastTestedSha).toBe(nextSha);
 const after=await project.detail();
 expect(after.github?.verifiedCoverageRunId).toBe(before.runs[0].id);
 expect(runtime.execute.mock.calls.at(-1)?.[0].github?.verifiedCoverageRunId).toBe(before.runs[0].id);
 expect(after.accounts).toEqual(before.accounts);
 expect(after.discovery?.plan.testers).toEqual(before.discovery?.plan.testers);
 expect(after.runs).toHaveLength(2);
 expect(after.runs[0]).toMatchObject({status:'completed',revision:nextSha,request:{mode:'release',autoRepair:true}});
 expect(after.runs[1]).toEqual(before.runs[0]);
 expect(after.history).toEqual(expect.arrayContaining(before.history));
 expect(after.cases?.map(({id,journey,createdAt})=>({id,journey,createdAt}))).toEqual(before.cases?.map(({id,journey,createdAt})=>({id,journey,createdAt})));
 expect(after.cases?.[0]).toMatchObject({lastRunId:after.runs[0].id,outcome:'passed'});
 expect(runtime.repository.prepare.mock.calls.map(([p,,mode])=>[mode,p.github?.sha])).toEqual([
  ['connect',undefined],['resume',sha],['sync',sha],['resume',nextSha],
 ]);
});

it('keeps prior evidence and revision when sync preparation fails',async()=>{
 const runtime=fakeRuntime();
 const api=await setup(runtime);
 const project=await connect(api);
 const before=await project.detail();
 runtime.repository.prepare.mockRejectedValueOnce(new Error('Startup failed for private-staff-password'));
 expect((await api.post(`${project.url}/sync`,{requestId:'sync'})).statusCode).toBe(202);
 await expect.poll(async()=>(await project.detail()).error).toMatch(/Startup failed/);
 const after=await project.detail();
 expect(after).toMatchObject({status:'ready',github:before.github,accounts:before.accounts,discovery:before.discovery,cases:before.cases,runs:[]});
 expect(after.error).not.toContain('private-staff-password');
});

it('fails a run if resume returns a different revision',async()=>{
 const runtime=fakeRuntime();
 const api=await setup(runtime);
 const project=await connect(api);
 const before=await project.detail();
 runtime.repository.prepare.mockResolvedValueOnce({repositoryPath:before.repositoryPath,appUrl:before.appUrl,allowedOrigins:[],commands:before.commands!,github:{...before.github!,sha:nextSha},accounts:[]});
 const response=await api.post(`${project.url}/runs`,{requestId:'run'});
 expect(response.statusCode).toBe(202);
 await expect.poll(async()=>(await project.detail()).runs[0].status).toBe('completed');
 expect((await project.detail()).runs[0]).toMatchObject({revision:sha,results:[],error:expect.stringMatching(/revision/i)});
 expect((await project.detail()).github).toEqual(before.github);
 expect(runtime.execute).not.toHaveBeenCalled();
});

it('publishes verified repairs automatically and recovers a lost PR response with an idempotent retry',async()=>{
 const runtime=fakeRuntime({failFirst:true});
 const api=await setup(runtime);
 const project=await connect(api);
 runtime.repository.publish.mockRejectedValueOnce(new Error('Lost response after creating the PR'));
 expect((await api.post(`${project.url}/runs`,{requestId:'run',autoRepair:true})).statusCode).toBe(202);
 const read=async()=>(await project.detail()).repairs?.[0];
 await expect.poll(async()=>(await read())?.error).toMatch(/Lost response/);
 const failed=(await read())!;
 expect(failed).toMatchObject({status:'completed',phase:'publish',verification:{outcome:'verified'},sourceRun:{revision:sha}});
 expect(runtime.repair.verify.mock.invocationCallOrder[0]).toBeLessThan(runtime.repository.publish.mock.invocationCallOrder[0]);
 await api.close();
 const reopened=api.open();
 const retryUrl=`/api/project-repairs/${failed.id}/publish`;
 expect((await reopened.post(retryUrl,{requestId:'retry'})).statusCode).toBe(202);
 expect((await reopened.post(retryUrl,{requestId:'retry'})).statusCode).toBe(202);
 const persisted=async()=>(await reopened.get(`/api/project-repairs/${failed.id}`)).json<ProjectRepair>();
 await expect.poll(async()=>(await persisted()).pullRequest).toEqual(pullRequest);
 expect((await persisted()).error).toBeUndefined();
 expect((await reopened.post(retryUrl,{requestId:'another'})).json<ProjectRepair>().pullRequest).toEqual(pullRequest);
 expect(runtime.repository.publish.mock.calls.map(([repair])=>[repair.id,repair.sourceRun.revision])).toEqual([[failed.id,sha],[failed.id,sha]]);
 expect(runtime.repair.verify).toHaveBeenCalledTimes(1);
});

it.each(['rejected','inconclusive'] as const)('refuses to publish a %s repair',async verification=>{
 const runtime=fakeRuntime({failFirst:true,verification});
 const api=await setup(runtime);
 const project=await connect(api);
 expect((await api.post(`${project.url}/runs`,{requestId:'run',autoRepair:true})).statusCode).toBe(202);
 const read=async()=>(await project.detail()).repairs?.[0];
 await expect.poll(async()=>(await read())?.verification?.outcome).toBe(verification);
 expect((await api.post(`/api/project-repairs/${(await read())!.id}/publish`,{requestId:'retry'})).statusCode).toBe(409);
 expect(runtime.repository.publish).not.toHaveBeenCalled();
});


it('refuses to retry publication after syncing past the verified base',async()=>{
 const runtime=fakeRuntime({failFirst:true});
 const api=await setup(runtime);
 const project=await connect(api);
 runtime.repository.publish.mockRejectedValueOnce(new Error('GitHub unavailable'));
 expect((await api.post(`${project.url}/runs`,{requestId:'run',autoRepair:true})).statusCode).toBe(202);
 await expect.poll(async()=>(await project.detail()).repairs?.[0]?.error).toBe('GitHub unavailable');
 const repair=(await project.detail()).repairs![0];
 expect((await api.post(`${project.url}/sync`,{requestId:'sync',run:false})).statusCode).toBe(202);
 await expect.poll(async()=>(await project.detail()).github?.sha).toBe(nextSha);
 const retry=await api.post(`/api/project-repairs/${repair.id}/publish`,{requestId:'retry'});
 expect(retry.statusCode).toBe(409);
 expect(retry.json()).toMatchObject({code:'stale_revision'});
 expect((await project.detail()).repairs?.[0]).toEqual(repair);
 expect(runtime.repository.publish).toHaveBeenCalledTimes(1);
 expect((await project.detail()).runs).toHaveLength(1);
});

it('recovers an interrupted sync with its prior revision and resumes a queued retry from SQLite',async()=>{
 const runtime=fakeRuntime();
 const api=await setup(runtime);
 const project=await connect(api);
 const before=await project.detail();
 await api.close();
 const store=openRunStore(api.databasePath);
 try {
  store.projects.sync(project.id,{requestId:'lost',run:true});
  expect(store.projects.claimNext()?.kind).toBe('sync');
  store.recoverInterrupted();
  expect(store.projects.detail(project.id)).toMatchObject({status:'ready',github:before.github,cases:before.cases,
   error:expect.stringMatching(/interrupted/i)});
  store.projects.sync(project.id,{requestId:'retry',run:true});
 } finally {store.close();}
 const reopened=api.open();
 expect((await reopened.post(`${project.url}/sync`,{requestId:'retry'})).statusCode).toBe(202);
 const detail=async()=>(await reopened.get(project.url)).json<ProjectDetail>();
 await expect.poll(async()=>(await detail()).github?.lastTestedSha).toBe(nextSha);
 expect((await detail()).runs).toHaveLength(1);
 expect(runtime.repository.prepare.mock.calls.map(([,,mode])=>mode)).toEqual(['connect','sync','resume']);
});

it('preserves verification across an interrupted publication and allows a retry',async()=>{
 const runtime=fakeRuntime({failFirst:true});
 const api=await setup(runtime);
 const project=await connect(api);
 runtime.repository.publish.mockRejectedValueOnce(new Error('GitHub unavailable'));
 expect((await api.post(`${project.url}/runs`,{requestId:'run',autoRepair:true})).statusCode).toBe(202);
 await expect.poll(async()=>(await project.detail()).repairs?.[0]?.error).toBe('GitHub unavailable');
 const repair=(await project.detail()).repairs![0];
 await api.close();
 const store=openRunStore(api.databasePath);
 try {
  store.projects.enqueuePublish(repair.id,'lost');
  expect(store.projects.claimNext()?.kind).toBe('publish');
  store.recoverInterrupted();
 } finally {store.close();}
 const reopened=api.open();
 const url=`/api/project-repairs/${repair.id}`;
 expect((await reopened.get(url)).json()).toMatchObject({phase:'publish',status:'interrupted',verification:repair.verification,error:expect.stringMatching(/interrupted/i)});
 expect((await reopened.post(`${url}/publish`,{requestId:'retry'})).statusCode).toBe(202);
 await expect.poll(async()=>(await reopened.get(url)).json<ProjectRepair>().pullRequest).toEqual(pullRequest);
 expect(runtime.repair.verify).toHaveBeenCalledTimes(1);
});
