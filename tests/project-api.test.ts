import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createServer} from '../apps/runner/src/server';
import {openRunStore} from '../apps/runner/src/store';
import {hashValue} from '../apps/runner/src/artifacts';
import {ContextPackSchema,ScenarioSchema} from '../packages/contracts/src';
import {ConnectProjectSchema,type ConnectProjectRequest,type Project,type ProjectDiscovery,type ProjectRun,type ProjectRuntime} from '../packages/contracts/src/projects';
const roots:string[]=[];const apps:ReturnType<typeof createServer>[]=[];const headers={authorization:'Bearer project-test'};
async function setup(runtime?:ProjectRuntime){const root=await mkdtemp(join(tmpdir(),'project-api-'));roots.push(root);const app=createServer({databasePath:join(root,'qa.sqlite'),apiToken:'project-test',projectRuntime:runtime});apps.push(app);return {root,app};}
const timestamp='2026-01-01T00:00:00.000Z';
const controlAccount={label:'Control',username:'control@example.test',password:'other-private-password'};
const source={path:'stock.ts',startLine:1,endLine:1,hash:'a'.repeat(64),excerpt:'Stock remains unchanged'};
const context=ContextPackSchema.parse({id:'warehouse-context',label:'Warehouse',viewport:{width:1024,height:768},locale:'en',preferredLanguage:'English',familiarity:'experienced',interaction:'pointer',reducedMotion:'no-preference',network:{mode:'normal'},inputs:{}});
function discover(project:Project):ProjectDiscovery {
 const testers=project.accounts.map(({id},i)=>({id:`tester-${i}`,name:`Warehouse staff ${i}`,role:'Warehouse',summary:'Review stock',accountId:id,context}));
 return {
  index:{version:'a'.repeat(64),sourceLines:120000,fileCount:2000,excludedFiles:20,indexedAt:timestamp,changedPaths:[]},
  plan:{summary:'Stock management',features:[{id:'stock',title:'Stock',description:'Review stock',sources:[source]}],roles:['Warehouse'],testers,
   journeys:testers.map(tester=>({id:`journey-${tester.id}`,testerId:tester.id,title:'Stock review',goal:'Review warehouse stock',entryPath:'/stock',inputs:{},sources:[source],reason:'Stock is part of the brief',
    checks:[{id:'quantity',label:'Preserve stock',kind:'field',locator:{by:'label',value:'Stock'},basis:'requirement',phase:'preserve',path:'/stock',sources:[source]},
     {id:'confirmation',label:'Show confirmation',kind:'visible',locator:{by:'text',value:'Saved'},basis:'requirement',phase:'after_action',sources:[source]},
     {id:'threshold',label:'Stock threshold',kind:'field',locator:{by:'label',value:'Threshold'},basis:'requirement',phase:'after_reload',expected:7,sources:[source]},
     {id:'enabled',label:'Tracking enabled',kind:'text',locator:{by:'testId',value:'enabled'},basis:'requirement',phase:'after_reload',expected:true,sources:[source]}]})),gaps:[]},
  observations:[],modelCalls:1,durationMs:10,generatedAt:timestamp,
 };
}
function complete(run:ProjectRun):ProjectRun {
 const {journeys,testers}=run.discovery!.plan;
 const results=journeys.map((frozen,i)=>{
  const tester=testers.find(tester=>tester.id===frozen.testerId)!;
  const journey={...frozen,checks:frozen.checks.map(check=>check.phase==='preserve'?{...check,expected:'10'}:check)};
  const checks=journey.checks.map(({id,label,basis,phase,sources,kind,expected=true})=>({
   id,label,basis,phase,sources,expected,actual:phase==='preserve'&&i===0?'11':kind==='visible'?expected:String(expected),
   status:(phase==='preserve'&&i===0?'failed':'passed') as 'failed'|'passed',
  }));
  const scenario=ScenarioSchema.parse({id:journey.id,label:journey.title,goal:journey.goal,entryPath:journey.entryPath,initialStateId:'stock',inputSlots:{},contract:{scope:'ui_only',assertions:[{id:'independent-checks',kind:'visible',locator:{by:'role',value:'main'}}]}});
  return {tester,journey,checks,sessionContinued:false,run:{
   id:`evidence-${run.id}-${i}`,requestId:run.request.requestId,scenario,context:tester.context,inputs:{},status:'completed' as const,
   verdict:i===0?'failed' as const:'passed' as const,createdAt:timestamp,manifestHash:'manifest',executionMode:'ai_guided' as const,
   steps:[],assertions:checks.map(({id,status,expected,actual})=>({id,status,expected,actual})),findings:[],capabilities:[],artifacts:[],
   evidence:{buildId:'before',scenarioHash:hashValue(scenario),policyVersion:'1',model:'test',actions:[{action:{tool:'navigate' as const,path:'/stock'},url:'/stock',observation:'Stock page'}],modelCalls:1,finishedByAgent:true},
  }};
 });
 return {...run,status:'completed',phase:'Finished',results,metrics:{...run.metrics,passed:results.length-1,failed:1}};
}
const get=(app:ReturnType<typeof createServer>,url:string)=>app.inject({url,headers});
const post=(app:ReturnType<typeof createServer>,url:string,payload:unknown)=>app.inject({method:'POST',url,payload:JSON.stringify(payload),headers:{...headers,'content-type':'application/json'}});
async function connect(app:ReturnType<typeof createServer>,root:string,options:Partial<ConnectProjectRequest>={}) {
 const response=await post(app,'/api/projects',{...body(root),...options});
 expect(response.statusCode).toBe(202);
 return response.json<Project>();
}
async function startRun(app:ReturnType<typeof createServer>,project:Project,mode:'explore'|'release'='explore') {
 await expect.poll(async()=>(await get(app,`/api/projects/${project.id}`)).json().status).toBe('ready');
 const response=await post(app,`/api/projects/${project.id}/runs`,{requestId:'run-1',mode});
 expect(response.statusCode).toBe(202);
 return response.json<ProjectRun>();
}
const readRun=async(app:ReturnType<typeof createServer>,id:string)=>(await get(app,`/api/project-runs/${id}`)).json<ProjectRun>();
const body=(root:string)=>({requestId:'connect-1',name:'Unknown app',repositoryPath:root,appUrl:'http://127.0.0.1:9998',brief:'Test staff managing unusual stock records',accounts:[{label:'Warehouse staff',username:'staff@example.test',password:'private-development-password'}]});
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it('connects an unregistered repository and never returns account credentials',async()=>{const {app,root}=await setup();const r=await app.inject({method:'POST',url:'/api/projects',headers,payload:body(root)});expect(r.statusCode).toBe(202);expect(r.body).not.toContain('private-development-password');expect(r.body).not.toContain('staff@example.test');expect(r.json()).toMatchObject({name:'Unknown app',status:'discovering'});expect((await app.inject({url:'/api/projects/'+r.json().id,headers})).statusCode).toBe(200);});
it('recovers a lost connect response by request ID without another project',async()=>{const {app,root}=await setup();const req={method:'POST' as const,url:'/api/projects',headers,payload:body(root)};const a=await app.inject(req),b=await app.inject(req);expect(a.json().id).toBe(b.json().id);expect((await app.inject({url:'/api/projects/by-request/connect-1',headers})).json().id).toBe(a.json().id);expect((await app.inject({url:'/api/projects',headers})).json()).toHaveLength(1);expect((await app.inject({...req,payload:{...body(root),brief:'Different intent'}})).statusCode).toBe(409);});
it('requires authenticated connections and rejects missing repositories',async()=>{const {app,root}=await setup();expect((await app.inject({method:'POST',url:'/api/projects',payload:body(root)})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/api/projects',headers,payload:{...body(root),repositoryPath:join(root,'absent')}})).statusCode).toBe(400);});
it('does not enqueue testing before discovery completes',async()=>{const {app,root}=await setup();const p=(await app.inject({method:'POST',url:'/api/projects',headers,payload:body(root)})).json();expect((await app.inject({method:'POST',url:`/api/projects/${p.id}/runs`,headers,payload:{requestId:'run-1'}})).statusCode).toBe(409);});
it('executes durable discovery once and safely records provider failures',async()=>{const discover=vi.fn(async()=>{throw new Error('provider failed private-development-password');});const {app,root}=await setup({discover,execute:vi.fn()});const p=(await app.inject({method:'POST',url:'/api/projects',headers,payload:body(root)})).json();await expect.poll(async()=> (await app.inject({url:'/api/projects/'+p.id,headers})).json().status).toBe('failed');const done=await app.inject({url:'/api/projects/'+p.id,headers});expect(done.body).not.toContain('private-development-password');expect(discover).toHaveBeenCalledTimes(1);});
it('keeps frozen discovery in run requests and preserves idempotency',async()=>{
 let finish!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;});
 const execute=vi.fn<ProjectRuntime['execute']>(async(_p,_s,run)=>{await gate;return complete(run);});
 const {app,root}=await setup({discover:async project=>discover(project),execute});
 const project=await connect(app,root);
 try {
  const run=await startRun(app,project);
  const retry=await post(app,`/api/projects/${project.id}/runs`,{requestId:'run-1'});
  expect(retry.json().id).toBe(run.id);
  expect(run.discovery?.index.version).toBe(discover(project).index.version);
  expect((await post(app,`/api/projects/${project.id}/runs`,{requestId:'run-2',mode:'release'})).statusCode).toBe(409);
  finish();
  await expect.poll(async()=> (await readRun(app,run.id)).status).toBe('completed');
  const finished=await readRun(app,run.id);
  expect(finished.discovery?.plan.journeys[0].checks[0].expected).toBeUndefined();
  expect(finished.results[0].journey.checks[0].expected).toBe('10');
  expect(execute).toHaveBeenCalledTimes(1);
 } finally {finish();}
});
it('returns a validation response for a malformed application URL',async()=>{
 const {app,root}=await setup();
 const response=await post(app,'/api/projects',{...body(root),appUrl:'not a URL'});
 expect(response.statusCode).toBe(400);
 expect(response.json()).toMatchObject({code:'validation'});
});

it.each([false,true])('passes the previous completed evidence and rejects removed release checks (drop=%s)',async(drop)=>{
 let received:ProjectRun|undefined;
 const execute:ProjectRuntime['execute']=async(_project,_secrets,run,_history,update,previous)=>{
  if(run.request.mode==='release'){
   received=previous;
   if(!previous)throw new Error('Previous evidence missing');
   const refreshed=structuredClone(run.discovery!);refreshed.plan.journeys=previous.results.map(result=>structuredClone(result.journey));
   if(drop)refreshed.plan.journeys[0].checks.pop();
   run.discovery=refreshed;update(run);
  }
  return complete(run);
 };
 const {app,root}=await setup({discover:async p=>discover(p),execute});const project=await connect(app,root);
 const first=await startRun(app,project);await expect.poll(async()=>(await readRun(app,first.id)).status).toBe('completed');
 const next=(await post(app,`/api/projects/${project.id}/runs`,{requestId:'release-2',mode:'release'})).json<ProjectRun>();
 await expect.poll(async()=>(await readRun(app,next.id)).status).toBe('completed');const done=await readRun(app,next.id);
 expect(received?.id).toBe(first.id);
 if(drop)expect(done.error).toMatch(/prior|previous|frozen/i);else expect(done.error).toBeUndefined();
});
it.each([
 ['invalid plan',(d:ProjectDiscovery)=>{d.plan.features=[];}],
 ['duplicate planned checks',(d:ProjectDiscovery)=>{d.plan.journeys[0].checks[1].id=d.plan.journeys[0].checks[0].id;}],
 ['unknown binding',(d:ProjectDiscovery)=>{d.plan.testers[0].accountId='unknown';}],
 ['unknown observation account',(d:ProjectDiscovery)=>{d.observations.push({path:'/stock',accountId:'unknown',text:'Stock',observedAt:timestamp});}],
])('does not mark discovery ready with %s',async(_name,change)=>{
 const {app,root}=await setup({discover:async project=>{const d=discover(project);change(d);return d;},execute:vi.fn()});
 const project=await connect(app,root,{accounts:[...body(root).accounts,controlAccount]});
 const read=async()=>(await get(app,`/api/projects/${project.id}`)).json();
 await expect.poll(async()=>(await read()).status).not.toBe('discovering');
 expect(await read()).toMatchObject({status:'failed',error:expect.any(String)});
 expect((await read()).discovery).toBeUndefined();
});
it.each([
 ['tester identity',(r:ProjectRun)=>{r.results[0].tester={...r.results[0].tester,id:'unplanned'};}],
 ['journey identity',(r:ProjectRun)=>{r.results[0].journey.id='unplanned';}],
 ['check locator',(r:ProjectRun)=>{r.results[0].journey.checks[0].locator={by:'label',value:'Other stock'};}],
 ['result check ID',(r:ProjectRun)=>{r.results[0].checks[0].id='unplanned';}],
 ['unplanned expectation',(r:ProjectRun)=>{r.results[0].journey.checks[1].expected=false;}],
 ['result check expectation',(r:ProjectRun)=>{r.results[0].checks[0].expected='11';}],
 ['assertion ID',(r:ProjectRun)=>{r.results[0].run.assertions[0].id='unplanned';}],
 ['verdict',(r:ProjectRun)=>{r.results[0].run.verdict='passed';}],
 ['finding',(r:ProjectRun)=>{r.findings=[{id:'finding',testerId:'unplanned',journeyId:r.results[0].journey.id,title:'Stock',description:'Incorrect stock',confidence:'confirmed',impact:'Stock',sources:[source],failedCheckIds:['quantity']}];}],
 ['discovery replacement',(r:ProjectRun)=>{r.discovery!.plan.features=[];}],
])('rejects a run with an invalid %s before writing evidence or history',async(_name,change)=>{
 const {app,root}=await setup({discover:async project=>discover(project),execute:async(_p,_s,run,_history,update)=>{
  const result=complete(run);change(result);
  update({...result,phase:'Finalizing evidence'});
  return result;
 }});
 const project=await connect(app,root);
 const run=await startRun(app,project);
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 expect(await readRun(app,run.id)).toMatchObject({error:expect.any(String),results:[],findings:[]});
 expect((await get(app,`/api/projects/${project.id}`)).json()).toMatchObject({history:[],discovery:{plan:{features:[{id:'stock'}]}}});
});
it('uses an announced release discovery before accepting evidence for its new journey',async()=>{
 const {app,root}=await setup({discover:async project=>discover(project),execute:async(_p,_s,run,_history,update)=>{
  run.discovery!.plan.journeys[0].id='release-journey';
  update(run);
  return complete(run);
 }});
 const project=await connect(app,root);
 const run=await startRun(app,project,'release');
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 const result=await readRun(app,run.id);
 expect(result.error).toBeUndefined();
 expect(result.results[0].journey.id).toBe('release-journey');
 expect((await get(app,`/api/projects/${project.id}`)).json().discovery.plan.journeys[0].id).toBe('release-journey');
});
it('rejects a worker that changes the discovery and evidence together after a release has started',async()=>{
 const {app,root}=await setup({discover:async project=>discover(project),execute:async(_p,_s,run,_history,update)=>{
  run.discovery!.plan.journeys[0].id='release-journey';
  update(run);
  update(complete(run));
  run.discovery!.plan.journeys[0].id='replacement-journey';
  return complete(run);
 }});
 const project=await connect(app,root);
 const run=await startRun(app,project,'release');
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 const result=await readRun(app,run.id);
 expect(result.error).toEqual(expect.any(String));
 expect(result.results.map(({journey})=>journey.id)).toEqual(['release-journey']);
 expect((await get(app,`/api/projects/${project.id}`)).json()).toMatchObject({history:[],discovery:{plan:{journeys:[{id:'journey-tester-0'}]}}});
});
it('interrupts claimed discovery and resumes queued discovery after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-api-restart-'));
 roots.push(root);
 const store=openRunStore(join(root,'qa.sqlite'));
 const running=store.projects.connect(ConnectProjectSchema.parse(body(root)));
 expect(store.projects.claimNext()?.projectId).toBe(running.id);
 const queued=store.projects.connect(ConnectProjectSchema.parse({...body(root),requestId:'connect-2'}));
 store.close();
 const worker=vi.fn(async(project:Project)=>discover(project));
 const app=createServer({databasePath:join(root,'qa.sqlite'),apiToken:'project-test',projectRuntime:{discover:worker,execute:vi.fn()}});
 apps.push(app);
 await app.listen({host:'127.0.0.1',port:0});
 await expect.poll(async()=>(await get(app,`/api/projects/${queued.id}`)).json().status).toBe('ready');
 expect((await get(app,`/api/projects/${running.id}`)).json()).toMatchObject({status:'failed',progress:'Discovery interrupted'});
 expect(worker.mock.calls.map(([project])=>project.id)).toEqual([queued.id]);
});
const patchContent={summary:'Preserve stock',changes:[{path:source.path,beforeHash:source.hash,before:'before',after:'after'}]};
const patch={...patchContent,hash:hashValue(patchContent)};
type Verification=Awaited<ReturnType<NonNullable<ProjectRuntime['repair']>['verify']>>;
function replay(sourceRun:ProjectRun):Verification {
 const results=structuredClone(sourceRun.results);
 for (const result of results) {
  result.run={...result.run,id:`replay-${result.run.id}`,executionMode:'deterministic',verdict:'passed',
   evidence:{...result.run.evidence!,buildId:'after',modelCalls:0,replayCompatible:true,finishedByAgent:false}};
  for (const check of [...result.checks,...result.run.assertions]) {
   check.status='passed';
   check.actual=result.journey.checks.find(definition=>definition.id===check.id)!.kind==='visible'?check.expected:String(check.expected);
  }
 }
 return {outcome:'verified',message:'All checks passed',results};
}
it.each([
 ['complete verified evidence',(_result:Verification)=>{},'verified'],
 ['missing failing case',(result:Verification)=>{result.results.shift();},'inconclusive'],
 ['missing passing control',(result:Verification)=>{result.results.pop();},'inconclusive'],
 ['duplicate journey',(result:Verification)=>{result.results[1]=result.results[0];},'inconclusive'],
 ['duplicate replay evidence ID',(result:Verification)=>{result.results[1].run.id=result.results[0].run.id;},'inconclusive'],
 ['missing check',(result:Verification)=>{result.results[1].checks.pop();},'inconclusive'],
 ['duplicate check',(result:Verification)=>{result.results[1].checks[1]=result.results[1].checks[0];},'inconclusive'],
 ['changed check definition',(result:Verification)=>{result.results[0].journey.checks[0].expected='11';},'inconclusive'],
 ['changed preserve expectation',(result:Verification)=>{result.results[0].checks[0].expected='11';},'inconclusive'],
 ['inconsistent passing observation',(result:Verification)=>{
  result.results[0].checks[0].actual=result.results[0].run.assertions[0].actual='11';
 },'inconclusive'],
 ['non-string field observation',(result:Verification)=>{
  result.results[0].checks[2].actual=result.results[0].run.assertions[2].actual=7;
 },'inconclusive'],
 ['model-assisted replay',(result:Verification)=>{result.results[0].run.evidence!.modelCalls=1;},'inconclusive'],
 ['incomplete action replay',(result:Verification)=>{result.results[0].run.evidence!.actions=[];},'inconclusive'],
 ['replay failure masked as a pass',(result:Verification)=>{result.results[0].run.findings.push({kind:'replay_mismatch',description:'Different page',evidencePaths:[]});},'inconclusive'],
 ['live execution',(result:Verification)=>{result.results[0].run.executionMode='ai_guided';},'inconclusive'],
 ['incompatible replay',(result:Verification)=>{result.results[0].run.evidence!.replayCompatible=false;},'inconclusive'],
 ['fabricated rejection',(result:Verification)=>{result.outcome='rejected';},'inconclusive'],
 ['failed control declared verified',(result:Verification)=>{
  const control=result.results[1];control.run.verdict='failed';
  for (const check of [control.checks[0],control.run.assertions[0]]) {check.status='failed';check.actual='11';}
 },'inconclusive'],
 ['rejected replay with failed control',(result:Verification)=>{
  result.outcome='rejected';
  const control=result.results[1];control.run.verdict='failed';
  for (const check of [control.checks[0],control.run.assertions[0]]) {check.status='failed';check.actual='11';}
 },'rejected'],
])('requires matching frozen evidence for %s',async(_name,change,outcome)=>{
 const verify=vi.fn<NonNullable<ProjectRuntime['repair']>['verify']>(async job=>{
  expect(job.verificationRequest?.patchHash).toBe(patch.hash);
  const result=replay(job.sourceRun);change(result);return result;
 });
 const {app,root}=await setup({
  discover:async project=>discover(project),execute:async(_p,_s,run)=>complete(run),
  repair:{prepare:async()=>({patch,sourceVersion:'a'.repeat(64)}),verify},
 });
 const project=await connect(app,root,{commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]});
 const run=await startRun(app,project);
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 expect((await readRun(app,run.id)).results.map(result=>result.run.verdict)).toEqual(['failed','passed']);
 const prepared=await post(app,'/api/project-repairs',{requestId:'repair-1',runId:run.id});
 expect(prepared.statusCode).toBe(202);
 const url=`/api/project-repairs/${prepared.json().id}`;
 const read=async()=>(await get(app,url)).json();
 await expect.poll(async()=>(await read()).status).toBe('awaiting_review');
 expect((await post(app,`${url}/verify`,{requestId:'verify-1',patchHash:'b'.repeat(64)})).statusCode).toBe(409);
 expect(verify).not.toHaveBeenCalled();
 expect((await post(app,`${url}/verify`,{requestId:'verify-1',patchHash:patch.hash})).statusCode).toBe(202);
 await expect.poll(async()=>(await read()).status).toBe('completed');
 const verification=(await read()).verification;
 expect(verification.outcome).toBe(outcome);
 expect(verification.results).toHaveLength(outcome==='inconclusive'?0:2);
 if(outcome==='verified')expect(verification.results[0].checks).toEqual(expect.arrayContaining([
  expect.objectContaining({id:'threshold',expected:7,actual:'7',status:'passed'}),
  expect.objectContaining({id:'enabled',expected:true,actual:'true',status:'passed'}),
 ]));
 expect(verify).toHaveBeenCalledTimes(1);
});

it('does not offer a patch for review if the proposal hash does not identify its contents',async()=>{
 const {app,root}=await setup({
  discover:async project=>discover(project),execute:async(_p,_s,run)=>complete(run),
  repair:{prepare:async()=>({patch:{...patch,summary:'Changed after hashing'},sourceVersion:'a'.repeat(64)}),verify:vi.fn()},
 });
 const project=await connect(app,root,{commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]});
 const run=await startRun(app,project);
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 const prepared=await post(app,'/api/project-repairs',{requestId:'repair-1',runId:run.id});
 expect(prepared.statusCode).toBe(202);
 const url=`/api/project-repairs/${prepared.json().id}`;
 const read=async()=>(await get(app,url)).json();
 await expect.poll(async()=>(await read()).status).toMatch(/^(completed|awaiting_review)$/);
 expect(await read()).toMatchObject({status:'completed',error:expect.any(String)});
 expect((await read()).patch).toBeUndefined();
});

it('rejects a stored repair source with evidence outside its saved discovery',async()=>{
 const {app,root}=await setup({
  discover:async project=>discover(project),execute:async(_p,_s,run)=>complete(run),
  repair:{prepare:async()=>({patch,sourceVersion:'a'.repeat(64)}),verify:vi.fn()},
 });
 const project=await connect(app,root,{commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]});
 const run=await startRun(app,project);
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 const historical=await readRun(app,run.id);
 historical.results[0].tester.id='unplanned';
 const db=new Database(join(root,'qa.sqlite'));
 try {
  db.prepare('UPDATE dev_project_runs SET data=? WHERE id=?').run(JSON.stringify(historical),run.id);
 } finally {db.close();}
 const response=await post(app,'/api/project-repairs',{requestId:'repair-1',runId:run.id});
 expect(response.statusCode).toBe(409);
 expect(response.json()).toMatchObject({code:'repair_evidence_required'});
});


it('automatically prepares and verifies once after a single run request, preserving the exact frozen checks',async()=>{
 const prepare=vi.fn(async()=>({patch,sourceVersion:'a'.repeat(64)}));
 const verify=vi.fn<NonNullable<ProjectRuntime['repair']>['verify']>(async job=>{
  expect(job.verificationRequest?.patchHash).toBe(job.patch?.hash);
  expect(job.sourceRun.results).toHaveLength(2);
  return replay(job.sourceRun);
 });
 const {app,root}=await setup({discover:async p=>discover(p),execute:async(_p,_s,r)=>complete(r),repair:{prepare,verify}});
 const project=await connect(app,root,{commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]});
 await expect.poll(async()=>(await get(app,`/api/projects/${project.id}`)).json().status).toBe('ready');
 const request={requestId:'automatic-run',mode:'explore',autoRepair:true};
 const response=await post(app,`/api/projects/${project.id}/runs`,request);
 expect(response.statusCode).toBe(202);
 const run=response.json<ProjectRun>();
 expect((await post(app,`/api/projects/${project.id}/runs`,request)).json().id).toBe(run.id);
 const repairs=async()=>(await get(app,`/api/project-repairs?projectId=${project.id}`)).json();
 await expect.poll(async()=>(await repairs())[0]?.verification?.outcome).toBe('verified');
 expect(await repairs()).toHaveLength(1);
 expect(prepare).toHaveBeenCalledTimes(1);expect(verify).toHaveBeenCalledTimes(1);
 expect((await repairs())[0].sourceRun.results).toEqual((await readRun(app,run.id)).results);
 expect((await get(app,`/api/projects/${project.id}`)).json().repairs[0].verification.outcome).toBe('verified');
});

it.each(['healthy','inconclusive','no control','missing setup','missing runtime'] as const)('does not automatically repair %s and records why when blocked',async mode=>{
 const prepare=vi.fn(async()=>({patch,sourceVersion:'a'.repeat(64)}));const verify=vi.fn();
 const {app,root}=await setup({discover:async p=>discover(p),execute:async(_p,_s,run)=>{
  const r=complete(run);
  if(mode==='healthy') {r.results=replay(r).results; r.metrics.failed=0;r.metrics.passed=2;}
  if(mode==='inconclusive')r.results[1].run.verdict='inconclusive';
  return r;
 },...(mode==='missing runtime'?{}:{repair:{prepare,verify}})});
 const project=await connect(app,root,{...(mode==='missing setup'?{}:{commands:{start:['test-server']}}),accounts:mode==='no control'?body(root).accounts:[...body(root).accounts,controlAccount]});
 await expect.poll(async()=>(await get(app,`/api/projects/${project.id}`)).json().status).toBe('ready');
 const response=await post(app,`/api/projects/${project.id}/runs`,{requestId:'automatic-run',autoRepair:true});
 expect(response.statusCode).toBe(202);const run=response.json<ProjectRun>();
 await expect.poll(async()=>(await readRun(app,run.id)).status).toBe('completed');
 const stored=await readRun(app,run.id);
 expect(stored.error).toBeUndefined();
 if(mode==='healthy')expect(stored.repairBlockedReason).toBeUndefined();
 else expect(stored.repairBlockedReason).toEqual(expect.any(String));
 expect((await get(app,`/api/project-repairs?projectId=${project.id}`)).json()).toEqual([]);
 expect(prepare).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
});

it('resumes each queued automatic stage after reopening the database without repeating preparation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'automatic-repair-restart-'));roots.push(root);const path=join(root,'qa.sqlite');
 let store=openRunStore(path);
 const prepare=vi.fn(async()=>({patch,sourceVersion:'a'.repeat(64)}));
 const verify=vi.fn<NonNullable<ProjectRuntime['repair']>['verify']>(async job=>replay(job.sourceRun));
 const runtime:ProjectRuntime={discover:async p=>discover(p),execute:async(_p,_s,r)=>complete(r),repair:{prepare,verify}};
 try{
  const p=store.projects.connect(ConnectProjectSchema.parse({...body(root),commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]}));
  await store.projects.execute(store.projects.claimNext()!,runtime);
  const run=store.projects.enqueueRun(p.id,{requestId:'automatic-run',mode:'explore',autoRepair:true});
  await store.projects.execute(store.projects.claimNext()!,runtime);
  expect(store.projects.repairs(p.id)).toHaveLength(1);
  store.close();store=openRunStore(path);store.projects.recoverInterrupted();
  await store.projects.execute(store.projects.claimNext()!,runtime);
  expect(store.projects.repairs(p.id)[0]).toMatchObject({status:'queued',phase:'verify',verificationRequest:{patchHash:patch.hash}});
  store.close();store=openRunStore(path);store.projects.recoverInterrupted();
  await store.projects.execute(store.projects.claimNext()!,runtime);
  expect(store.projects.repairs(p.id)[0].verification?.outcome).toBe('verified');
  expect(store.projects.enqueueRun(p.id,{requestId:'automatic-run',mode:'explore',autoRepair:true}).id).toBe(run.id);
  expect(store.projects.claimNext()).toBeUndefined();expect(prepare).toHaveBeenCalledTimes(1);expect(verify).toHaveBeenCalledTimes(1);
 }finally{store.close();}
});

it('stops automatic preparation failure without looping or verifying a missing patch',async()=>{
 const prepare=vi.fn(async()=>({error:'Source cannot fit the coding budget'}));const verify=vi.fn();
 const {app,root}=await setup({discover:async p=>discover(p),execute:async(_p,_s,r)=>complete(r),repair:{prepare,verify}});
 const project=await connect(app,root,{commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]});
 await expect.poll(async()=>(await get(app,`/api/projects/${project.id}`)).json().status).toBe('ready');
 const response=await post(app,`/api/projects/${project.id}/runs`,{requestId:'automatic-run',autoRepair:true});expect(response.statusCode).toBe(202);
 const read=async()=>(await get(app,`/api/project-repairs?projectId=${project.id}`)).json();
 await expect.poll(async()=>(await read())[0]?.status).toBe('completed');
 expect((await read())[0]).toMatchObject({error:'Source cannot fit the coding budget'});
 expect(prepare).toHaveBeenCalledTimes(1);expect(verify).not.toHaveBeenCalled();
});

it('accepts distinct personas sharing supplied access and a guest alongside authenticated testers',async()=>{
 const {app,root}=await setup({discover:async project=>{
  const d=discover(project),base=d.plan.testers[0];
  d.plan.testers.push({...structuredClone(base),id:'returning',name:'Returning seller',context:{...base.context,familiarity:'first_time'}});
  d.plan.testers.push({...structuredClone(base),id:'guest',name:'Guest',accountId:undefined});
  for(const testerId of ['returning','guest'])d.plan.journeys.push({...structuredClone(d.plan.journeys[0]),id:testerId,testerId});
  return d;
 },execute:vi.fn()});
 const p=await connect(app,root);
 await expect.poll(async()=>(await get(app,`/api/projects/${p.id}`)).json().status).not.toBe('discovering');
 const ready=(await get(app,`/api/projects/${p.id}`)).json();
 expect(ready.status).toBe('ready');
 expect(ready.discovery.plan.testers).toHaveLength(3);
});

it('persists a recomputed investigation without trusting a claimed network trigger',async()=>{
 const prepare=vi.fn(async()=>({patch,sourceVersion:'a'.repeat(64),investigation:{factor:'network' as const,outcome:'likely_trigger' as const,message:'Unverified claim',trials:[]}}));
 const {app,root}=await setup({discover:async p=>discover(p),execute:async(_p,_s,r)=>complete(r),repair:{prepare,verify:async job=>replay(job.sourceRun)}});
 const project=await connect(app,root,{commands:{start:['test-server']},accounts:[...body(root).accounts,controlAccount]});
 await expect.poll(async()=>(await get(app,`/api/projects/${project.id}`)).json().status).toBe('ready');
 await post(app,`/api/projects/${project.id}/runs`,{requestId:'investigate',autoRepair:true});
 const repairs=async()=>(await get(app,`/api/project-repairs?projectId=${project.id}`)).json();
 await expect.poll(async()=>(await repairs())[0]?.verification?.outcome).toBe('verified');
 expect((await repairs())[0].investigation).toMatchObject({outcome:'unresolved',trials:[]});
 expect((await repairs())[0].investigation.message).not.toContain('Unverified claim');
});
