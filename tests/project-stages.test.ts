import {createServer,type Server} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createProjectRuntime} from '../apps/runner/src/project-runtime';
import {projectBrowserContext} from '../apps/runner/src/project-sessions';
import {scanRepository,readRepositorySource} from '../apps/runner/src/repository-index';
import type {Project,ProjectDiscovery,ProjectRun} from '../packages/contracts/src/projects';
import type {runAgent} from '../apps/runner/src/agent';
const roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0))await new Promise<void>(r=>s.close(()=>r()));for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(persist:boolean,delayed=false,hydrating=false){
 const root=await mkdtemp(join(tmpdir(),'project-stages-'));roots.push(root);
 await writeFile(join(root,'requirements.md'),'The draft must survive closing and reopening the browser.');
 const server=createServer((_q,r)=>{r.setHeader('content-type','text/html');const html=`<main><label>Draft<input oninput="${persist?(delayed?"const value=this.value;setTimeout(()=>localStorage.setItem('draft',value),900)":"localStorage.setItem('draft',this.value)"):"sessionStorage.setItem('draft',this.value)"}"></label><label>Temporary<input oninput="sessionStorage.setItem('temp',this.value)"></label></main><script>document.querySelector('input').value=${persist?'localStorage':'sessionStorage'}.getItem('draft')||'';document.querySelectorAll('input')[1].value=sessionStorage.getItem('temp')||''</script>`;r.end(hydrating?html.replace('<main>','<template id="pending"><main>').replace('</main>','</main></template>').replace('<script>','<script>setTimeout(()=>{document.body.append(document.querySelector("template").content.cloneNode(true));').replace('</script>','},900)</script>'):html);});servers.push(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const index=await scanRepository(root),source=await readRepositorySource(index,'requirements.md');
 const tester={id:'returning',name:'Returning seller',role:'Seller',summary:'Interrupted work',context:{...projectBrowserContext,id:'returning'}};
 const discovery:ProjectDiscovery={index:{...index,fileCount:index.files.length},plan:{summary:'Return to a draft',features:[{id:'draft',title:'Draft',description:'Resume work',sources:[source]}],roles:['Seller'],testers:[tester],journeys:[{id:'resume',testerId:tester.id,title:'Resume draft',goal:'Start a draft and return later.',entryPath:'/',inputs:{draft:'Weekend sale'},reason:'Interrupted work',sources:[source],stages:[{id:'write',label:'Start work',goal:'Write the draft input and leave.',transition:'continue'},{id:'return',label:'Return to work',goal:'Continue working with the draft.',transition:'reopen',entryPath:'/',pauseMs:10}],checks:[{id:'draft-return',label:'Draft survives return',kind:'field',locator:{by:'label',value:'Draft'},expected:'Weekend sale',phase:'after_action',atStageStart:'return',basis:'requirement',sources:[source]},{id:'final',label:'Draft at the end',kind:'field',locator:{by:'label',value:'Draft'},expected:'Weekend sale',phase:'after_action',basis:'requirement',sources:[source]}]}],gaps:[]},observations:[],modelCalls:0,durationMs:0,generatedAt:new Date().toISOString()};
 const project:Project={id:'project',name:'Draft application',repositoryPath:root,appUrl:origin,allowedOrigins:[],brief:'Resume saved drafts',requirements:'',accounts:[],createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',discovery};
 const run:ProjectRun={id:'staged-run',projectId:project.id,request:{requestId:'first',mode:'explore'},status:'running',phase:'Starting',createdAt:new Date().toISOString(),results:[],findings:[],summary:'',metrics:{elapsedMs:0,modelCalls:0,browserActions:0,passed:0,failed:0,inconclusive:0}};
 const runtime=(actor:typeof runAgent)=>createProjectRuntime({privateRoot:join(root,'.private'),artifactRoot:join(root,'.artifacts'),model:'test',actor});
 return {root,project,run,discovery,runtime};
}

it.each([true,false])('checks state immediately after a real browser reopen before an actor can restore lost data (persist=%s)',async persist=>{
 const f=await fixture(persist);let stage=0;const actor=vi.fn<typeof runAgent>(async(session)=>{
  if(stage++===1)expect(await session.page.getByLabel('Temporary').inputValue()).toBe('');
  await session.execute({tool:'fill',locator:{by:'label',value:'Draft'},value:{input:'draft'}});
  await session.execute({tool:'fill',locator:{by:'label',value:'Temporary'},value:{literal:'discard on close'}});
  return {finished:true,modelCalls:1,reason:'Done'};
 });
 const result=await f.runtime(actor).execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(actor).toHaveBeenCalledTimes(2);
 const evidence=result.results[0];
 expect(evidence.run.verdict).toBe(persist?'passed':'failed');
 expect(evidence.checks).toMatchObject([{id:'draft-return',atStageStart:'return',status:persist?'passed':'failed',actual:persist?'Weekend sale':''},{id:'final',status:'passed'}]);
 expect(evidence.run.evidence?.stages).toMatchObject([{id:'write',completed:true,modelCalls:1},{id:'return',transition:'reopen',completed:true,modelCalls:1}]);
 expect(evidence.run.evidence?.modelCalls).toBe(2);
},20000);

it('replays every stage and entry check without invoking the model and rejects a missing transition trace',async()=>{
 const f=await fixture(true);const actor=vi.fn<typeof runAgent>(async session=>{await session.execute({tool:'fill',locator:{by:'label',value:'Draft'},value:{input:'draft'}});return {finished:true,modelCalls:1,reason:'Done'};});
 const runtime=f.runtime(actor),source=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 const sessions=join(f.root,'.private','snapshots',f.run.id,'sessions');
 const replay=await runtime.replay(f.project,{accounts:[]},source,sessions);
 expect(replay.results[0].run).toMatchObject({verdict:'passed',evidence:{modelCalls:0,replayCompatible:true,stages:[{id:'write',modelCalls:0},{id:'return',modelCalls:0}]}});
 expect(replay.results[0].checks).toEqual(source.results[0].checks);
 expect(actor).toHaveBeenCalledTimes(2);
 delete source.results[0].run.evidence!.stages;
 const missing=await runtime.replay(f.project,{accounts:[]},source,sessions);
 expect(missing.results[0].run).toMatchObject({verdict:'inconclusive',evidence:{replayCompatible:false}});
},20000);

it('shares the model budget across stages and does not launch a second actor after exhaustion',async()=>{
 const f=await fixture(true);const actor=vi.fn<typeof runAgent>(async()=>({finished:true,modelCalls:20,reason:'Done'}));
 const result=await f.runtime(actor).execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(actor).toHaveBeenCalledTimes(1);
 expect(result.results[0].run.verdict).toBe('inconclusive');
 expect(result.results[0].checks[0].status).toBe('not_evaluated');
 expect(result.metrics.modelCalls).toBe(20);
},15000);

it('closes the browser before waiting away, so pending autosave is not granted extra time',async()=>{
 const f=await fixture(true,true);f.discovery.plan.journeys[0].stages![1].pauseMs=1500;
 let stage=0;const actor:typeof runAgent=async session=>{if(stage++===0)await session.execute({tool:'fill',locator:{by:'label',value:'Draft'},value:{input:'draft'}});return {finished:true,modelCalls:1,reason:'Done'};};
 const result=await f.runtime(actor).execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(result.results[0].checks[0]).toMatchObject({status:'failed',actual:''});
},15000);

it('applies offline and recovery between stages while retaining the same browser-local draft',async()=>{
 const f=await fixture(true);const journey=f.discovery.plan.journeys[0];
 journey.stages!.splice(1,0,{id:'offline',label:'Connection drops',goal:'Notice the connection failure.',transition:'continue',network:{mode:'offline'}});
 journey.stages![2].network={mode:'normal'};
 let stage=0;const statuses:boolean[]=[];
 const actor:typeof runAgent=async session=>{
  if(stage++===0)await session.execute({tool:'fill',locator:{by:'label',value:'Draft'},value:{input:'draft'}});
  else statuses.push(await session.page.evaluate(async()=>{try{return (await fetch('/ping')).ok;}catch{return false;}}));
  return {finished:true,modelCalls:1,reason:'Done'};
 };
 const runtime=f.runtime(actor),result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(statuses).toEqual([false,true]);expect(result.results[0].run.verdict).toBe('passed');
 const replay=await runtime.replay(f.project,{accounts:[]},result,join(f.root,'.private','snapshots',f.run.id,'sessions'));
 expect(replay.results[0].run.evidence?.stages?.map(s=>s.network.mode)).toEqual(['normal','offline','normal']);
 expect(replay.results[0].run).toMatchObject({verdict:'passed',evidence:{modelCalls:0,replayCompatible:true}});
},20000);

it('waits for a recorded form control to hydrate during zero-model staged replay',async()=>{
 const f=await fixture(true,false,true);
 const actor=vi.fn<typeof runAgent>(async session=>{
  await session.page.getByLabel('Draft').waitFor({state:'visible'});
  await session.refreshObservation();
  await session.execute({tool:'fill',locator:{by:'label',value:'Draft'},value:{input:'draft'}});
  return {finished:true,modelCalls:1,reason:'Saved'};
 });
 const runtime=f.runtime(actor),source=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(source.results[0].run.verdict).toBe('passed');
 const replay=await runtime.replay(f.project,{accounts:[]},source,join(f.root,'.private','snapshots',f.run.id,'sessions'));
 expect(replay.results[0].run).toMatchObject({verdict:'passed',evidence:{modelCalls:0,replayCompatible:true}});
 expect(replay.results[0].checks).toEqual(source.results[0].checks);
 expect(actor).toHaveBeenCalledTimes(2);
},20000);
