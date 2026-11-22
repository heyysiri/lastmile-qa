import {createServer,type Server} from 'node:http';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createProjectRuntime} from '../apps/runner/src/project-runtime';
import {projectBrowserContext} from '../apps/runner/src/project-sessions';
import {scanRepository,readRepositorySource} from '../apps/runner/src/repository-index';
import type {Project,ProjectDiscovery,ProjectRun} from '../packages/contracts/src/projects';
const roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});
async function fixture(options:{shared?:boolean;privateValue?:string;authentication?:boolean}={}){const root=await mkdtemp(join(tmpdir(),'project-runtime-'));roots.push(root);await writeFile(join(root,'requirements.md'),'Staff can rename a record. Renaming must preserve its existing quantity.');
 const values:Record<string,{name:string;stock:number}>={a:{name:'A',stock:17},b:{name:'B',stock:23}};let defect=true,redirect=false,delayFirstAlternateRead=options.shared,loginBusy=false,loginCollisions=0;
 const server=createServer(async(q,r)=>{
  if(options.authentication){
   r.setHeader('content-type','text/html');
   if(q.url==='/signin'){
    if(loginBusy){loginCollisions++;r.writeHead(503).end('<h1>Database is locked</h1>');return;}
    loginBusy=true;await new Promise(resolve=>setTimeout(resolve,500));r.setHeader('set-cookie','signed=yes; Path=/');loginBusy=false;
    r.end('<button>Sign out</button>');return;
   }
   if(!q.headers.cookie?.includes('signed=yes')){r.end('<a href="/signin">Sign in</a>');return;}
  }
  const alternate=q.url?.includes('/b');const key=alternate&&!options.shared?'b':'a';
  if(redirect&&q.method==='GET'&&q.url==='/edit/a?id=42'){r.writeHead(302,{location:'/edit/a?id=43#details'}).end();return;}
  if(q.method==='POST'){let body='';for await(const chunk of q)body+=chunk;values[key].name=new URLSearchParams(body).get('name')!;if(defect&&key==='a')values[key].stock=1;r.writeHead(303,{location:'/edit/'+(alternate?'b':'a')});r.end();return;}
  if(delayFirstAlternateRead&&alternate){delayFirstAlternateRead=false;await new Promise(resolve=>setTimeout(resolve,2200));}
  r.setHeader('content-type','text/html');r.end(`${options.authentication?'<button>Sign out</button>':''}<main><form method="post"><label>Name<input name="name" value="${values[key].name}"></label><label>Stock<input value="${options.privateValue??values[key].stock}" readonly></label><button>Save</button></form></main>`);
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const index=await scanRepository(root),source=await readRepositorySource(index,'requirements.md');const testers=['a','b'].map(id=>({id,name:id,role:'Staff',summary:'Maintain assigned records',context:{...projectBrowserContext,id}}));
 const discovery:ProjectDiscovery={index:{...index,fileCount:index.files.length},plan:{summary:'Records',features:[{id:'records',title:'Records',description:'Edit records',sources:[source]}],roles:['Staff'],testers,journeys:testers.map(t=>({id:t.id,testerId:t.id,title:'Rename record',goal:'Rename your record using newName, then save.',entryPath:'/edit/'+t.id,inputs:{newName:'Updated '+t.id},checks:[{id:'name',label:'Saved name',kind:'field',locator:{by:'label',value:'Name'},expected:'Updated '+t.id,phase:'after_reload',path:'/edit/'+t.id,basis:'requirement',sources:[source]},{id:'stock',label:'Existing stock remains intact',kind:'field',locator:{by:'label',value:'Stock'},phase:'preserve',path:'/edit/'+t.id,basis:'requirement',sources:[source]}],sources:[source],reason:'Renaming must preserve stock'})),gaps:[]},observations:[],modelCalls:0,durationMs:0,generatedAt:new Date().toISOString()};
 const project:Project={id:'project',name:'Records',repositoryPath:root,appUrl:origin,allowedOrigins:[],brief:'Staff can rename records',requirements:'',accounts:[],createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',discovery};
 const run:ProjectRun={id:'run-one',projectId:project.id,request:{requestId:'first',mode:'explore'},status:'running',phase:'Starting',createdAt:new Date().toISOString(),results:[],findings:[],summary:'',metrics:{elapsedMs:0,modelCalls:0,browserActions:0,passed:0,failed:0,inconclusive:0}};
 return {root,values,project,run,discovery,loginCollisions:()=>loginCollisions,setDefect:(v:boolean)=>{defect=v;},redirectRecord:()=>{redirect=true;}};
}

const saveName:typeof import('../apps/runner/src/agent').runAgent=async session=>{
 await session.execute({tool:'fill',locator:{by:'label',value:'Name'},value:{input:'newName'}});
 await session.execute({tool:'click',locator:{by:'role',value:'button',name:'Save'}});
 return {finished:true,modelCalls:1,reason:'Done'};
};

it('freezes shared stock before either tester writes and replays in the same order',async()=>{
 const f=await fixture({shared:true});
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',actor:saveName});
 const result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(result.results.map(r=>r.checks[1])).toMatchObject([{expected:'17',actual:'1',status:'failed'},{expected:'17',actual:'1',status:'failed'}]);
 expect(f.values.a.name).toBe('Updated b');
 f.values.a={name:'A',stock:17};
 const replay=await runtime.replay(f.project,{accounts:[]},result,join(f.root,'.private','snapshots','run-one','sessions'));
 expect(replay.results.map(r=>r.checks)).toEqual(result.results.map(r=>r.checks));
 expect(f.values.a.name).toBe('Updated b');
},30000);

it('rejects a different record after the last recorded navigation',async()=>{
 const f=await fixture();f.discovery.plan.journeys[0].entryPath='/edit/a?id=42#details';
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',actor:async()=>({finished:true,modelCalls:1,reason:'Done'})});
 const result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(result.results[0].run.evidence?.actions[0]).toMatchObject({routeVersion:2,url:`${f.project.appUrl}/edit/a?id=42#details`});
 f.redirectRecord();
 const replay=await runtime.replay(f.project,{accounts:[]},result,join(f.root,'.private','snapshots','run-one','sessions'));
 expect(replay.results[0].run).toMatchObject({verdict:'inconclusive',evidence:{replayCompatible:false}});
 expect(replay.results[0].finding?.description).toMatch(/different page/i);
},20000);

it('keeps a preserve value containing a private account string out of public progress and final results',async()=>{
 const username='staff-private@example.test';const f=await fixture({privateValue:`Owner: ${username}`});
 const updates:ProjectRun[]=[];
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',actor:saveName});
 const result=await runtime.execute(f.project,{accounts:[{id:'unused-account',label:'Staff',username,password:'not-public-password'}]},f.run,[],update=>updates.push(structuredClone(update)));
 expect(JSON.stringify([...updates,result])).not.toContain(username);
 expect(result.results[0].run.verdict).toBe('inconclusive');
 expect(result.results[0].journey.checks[1].expected).toBeUndefined();
 expect(result.results[0].checks[1]).toMatchObject({status:'not_evaluated',message:expect.stringMatching(/private/i)});
 for(const file of ['assertions.json','run.json']){
  const artifact=await readFile(join(f.root,'.artifacts',result.results[0].run.id,file),'utf8');
  expect(artifact).not.toContain(username);
 }
},20000);

it('skips account-bound cases when the public page gives no proof of sign-in',async()=>{
 const f=await fixture();
 f.project.accounts=[{id:'account',label:'Staff'}];f.discovery.plan.testers[0].accountId='account';
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',actor:async(session,run)=>run.inputs.newName?saveName(session,run):{finished:true,modelCalls:1,reason:'Done'}});
 const result=await runtime.execute(f.project,{accounts:[{id:'account',label:'Staff',username:'staff-private',password:'password-private'}]},f.run,[],()=>{});
 expect(result.results[0]).toMatchObject({sessionContinued:false,run:{verdict:'inconclusive'},checks:[{status:'not_evaluated',message:expect.stringMatching(/sign.in|account/i)},{status:'not_evaluated'}]});
 expect(f.values.a.name).toBe('A');
 expect(f.values.b.name).toBe('Updated b');
},20000);

it('keeps executed release checks when refreshed discovery replaces a case',async()=>{
 const f=await fixture();f.setDefect(false);
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor:saveName});
 const baseline=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(baseline.metrics.passed).toBe(2);
 const replacement=f.discovery.plan.journeys[0];
 replacement.checks=[{...replacement.checks[0],id:'save-visible',kind:'visible',locator:{by:'role',value:'button',name:'Save'},phase:'after_action',path:undefined,expected:true}];
 f.values.a.stock=9;
 const released=await runtime.execute(f.project,{accounts:[]},{...f.run,id:'release',request:{requestId:'release',mode:'release'}},[],()=>{},baseline);
 expect(released.results[0].journey).toEqual(baseline.results[0].journey);
 expect(released.results[0].checks[1]).toMatchObject({id:'stock',expected:'17',actual:'9',status:'failed'});
 expect(released.results.slice(1).map(r=>r.checks.map(c=>c.id))).toEqual([['name','stock'],['save-visible']]);
 expect(released.discovery?.plan.journeys.map(j=>j.id)).toEqual(released.results.map(r=>r.journey.id));
 expect(new Set(released.discovery?.plan.journeys.map(j=>j.id)).size).toBe(3);
},25000);

it('reports stale release citations on prior checks while still running changed coverage',async()=>{
 const f=await fixture();f.setDefect(false);
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor:saveName});
 const baseline=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 await writeFile(join(f.root,'requirements.md'),'Staff can rename a record. The save control remains visible after editing.');
 const index=await scanRepository(f.root),source=await readRepositorySource(index,'requirements.md');
 f.discovery.index={...index,fileCount:index.files.length};
 const fresh=f.discovery.plan.journeys[0];
 fresh.sources=[source];fresh.checks=[{...fresh.checks[0],id:'save-visible',kind:'visible',locator:{by:'role',value:'button',name:'Save'},phase:'after_action',path:undefined,expected:true,sources:[source]}];
 f.discovery.plan.journeys[1].checks.forEach(check=>{check.sources=[source];});
 const released=await runtime.execute(f.project,{accounts:[]},{...f.run,id:'release',request:{requestId:'release',mode:'release'}},[],()=>{},baseline);
 expect(released.results[0].journey).toEqual(baseline.results[0].journey);
 expect(released.results[0].checks[1]).toMatchObject({id:'stock',expected:'17',status:'not_evaluated',message:expect.stringMatching(/prior.*source/i)});
 expect(released.results[0].run.verdict).toBe('inconclusive');
 expect(released.results[2].checks).toMatchObject([{id:'save-visible',status:'passed'}]);
 expect(released.results[3].checks[1]).toMatchObject({id:'stock',status:'passed'});
},25000);

it.each(['requirement','implementation'] as const)('handles %s-backed checks when supporting implementation changes',async basis=>{
 const f=await fixture();f.setDefect(false);
 await writeFile(join(f.root,'app.js'),'// original save implementation');
 let index=await scanRepository(f.root);const implementation=await readRepositorySource(index,'app.js');
 f.discovery.index={...index,fileCount:index.files.length};
 for(const journey of f.discovery.plan.journeys)for(const check of journey.checks){check.sources.push(implementation);check.basis=basis;}
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor:saveName});
 const baseline=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(baseline.metrics.passed).toBe(2);
 await writeFile(join(f.root,'app.js'),'// changed save implementation');f.setDefect(true);
 index=await scanRepository(f.root);f.discovery.index={...index,fileCount:index.files.length};
 f.discovery.plan.journeys=[];
 const released=await runtime.execute(f.project,{accounts:[]},{...f.run,id:'release',request:{requestId:'release',mode:'release'}},[],()=>{},baseline);
 expect(released.results[0].journey).toEqual(baseline.results[0].journey);
 expect(released.results[0].checks[1]).toMatchObject(basis==='requirement'?{id:'stock',expected:'17',actual:'1',status:'failed'}:{id:'stock',expected:'17',status:'not_evaluated'});
 expect(released.results[1].run.verdict).toBe(basis==='requirement'?'passed':'inconclusive');
},25000);

it('keeps prior release coverage available when refreshed discovery fails',async()=>{
 const f=await fixture();f.setDefect(false);
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>{throw new Error('Discovery service unavailable');},actor:saveName});
 const baseline=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 const released=await runtime.execute(f.project,{accounts:[]},{...f.run,id:'release',request:{requestId:'release',mode:'release'}},[],()=>{},baseline);
 expect(released.results.map(r=>r.journey)).toEqual(baseline.results.map(r=>r.journey));
 expect(released.metrics.passed).toBe(2);
 expect(released.discovery?.plan.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/refresh.*coverage|coverage.*refresh/i)]));
},20000);
it('finds cross-feature state loss with a passing control, freezes pre-action values and replays without a model',async()=>{
 const f=await fixture();const actor=vi.fn(async(session,run)=>{expect(JSON.stringify(run.context)).not.toContain('requirements.md');await session.execute({tool:'fill',locator:{by:'label',value:'Name'},value:{input:'newName'}});await session.execute({tool:'click',locator:{by:'role',value:'button',name:'Save'}});return {finished:true,modelCalls:1,reason:'Done'};});
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor});
 const result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 expect(result.metrics).toMatchObject({passed:1,failed:1,inconclusive:0,modelCalls:2});expect(result.findings[0]).toMatchObject({confidence:'confirmed',failedCheckIds:['stock']});expect(result.findings[0].description).toContain('17');expect(result.findings[0].description).toContain('1');
 expect(result.results[0].journey.checks[1].expected).toBe('17');expect(f.discovery.plan.journeys[0].checks[1].expected).toBeUndefined();
 expect(await readFile(join(f.root,'.private','snapshots','run-one','source-manifest.json'),'utf8')).toContain('requirements.md');
 f.setDefect(false);f.values.a.stock=17;f.values.b.stock=23;
 const replay=await runtime.replay(f.project,{accounts:[]},result,join(f.root,'.private','snapshots','run-one','sessions'));
 expect(replay.metrics).toMatchObject({passed:2,failed:0,modelCalls:0});expect(actor).toHaveBeenCalledTimes(2);expect(replay.results.every(r=>r.run.evidence?.replayCompatible)).toBe(true);
},30000);
it('does not label an unfinished agent or changed source as a product defect',async()=>{
 const f=await fixture();const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor:async()=>({finished:false,modelCalls:1,reason:'Blocked'})});
 const result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});expect(result.metrics.inconclusive).toBe(2);expect(result.findings.every(f=>f.confidence==='inconclusive')).toBe(true);
},20000);
it('treats an uncorroborated missing generated selector as suspected, not a confirmed defect',async()=>{
 const f=await fixture();f.discovery.plan.journeys[0].checks[0].locator={by:'label',value:'Invented control'};
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor:async()=>({finished:true,modelCalls:1,reason:'Done'})});
 const result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});expect(result.results[0].finding?.confidence).toBe('suspected');
},20000);
it('downgrades the whole comparison if source changes while testers act',async()=>{
 const f=await fixture();const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover:async()=>f.discovery,actor:async()=>{await writeFile(join(f.root,'requirements.md'),'The application changed during the run.');return {finished:true,modelCalls:1,reason:'Done'};}});
 const result=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});expect(result.error).toMatch(/changed during/);expect(result.results.every(r=>r.run.verdict==='inconclusive')).toBe(true);
},20000);


it('authenticates execution accounts without concurrent writes before freezing all preconditions',async()=>{
 const f=await fixture({authentication:true});
 const accounts=['a','b'].map(id=>({id,label:`Staff ${id}`,username:`user-${id}`,password:`password-${id}`}));
 f.project.accounts=accounts.map(({id,label})=>({id,label}));
 for(const tester of f.discovery.plan.testers)tester.accountId=tester.id;
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',actor:async(session,run,options)=>{
  if(run.inputs.newName)return saveName(session,run,options);
  await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Sign in'}});
  return {finished:true,modelCalls:1,reason:'Done'};
 }});
 const result=await runtime.execute(f.project,{accounts},f.run,[],()=>{});
 expect(f.loginCollisions()).toBe(0);
 expect(result.results.map(r=>r.run.verdict)).toEqual(['failed','passed']);
 expect(result.results.map(r=>r.checks[1].expected)).toEqual(['17','23']);
},20000);

it('retains users and frozen cases without regenerating coverage after an approved GitHub fix',async()=>{
 const f=await fixture();const discover=vi.fn(async()=>{throw new Error('Coverage must not regenerate for a verified fix');});
 const runtime=createProjectRuntime({privateRoot:join(f.root,'.private'),artifactRoot:join(f.root,'.artifacts'),model:'test',discover,actor:saveName});
 const baseline=await runtime.execute(f.project,{accounts:[]},f.run,[],()=>{});
 await writeFile(join(f.root,'implementation.ts'),'export const fixed = true;');f.setDefect(false);
 // Restore the same precondition for this release; the application owns its durable state.
 f.values.a.stock=17;
 const project={...f.project,github:{repositoryUrl:'https://github.com/test/app',branch:'demo',setup:'custom' as const,entryPath:'/',coverageMode:'retain' as const,sha:'a'.repeat(40)}};
 const released=await runtime.execute(project,{accounts:[]},{...f.run,id:'release-fixed',request:{requestId:'release-fixed',mode:'release'}},[],()=>{},baseline);
 expect(discover).not.toHaveBeenCalled();expect(released.results.map(result=>result.tester)).toEqual(baseline.results.map(result=>result.tester));
 expect(released.results.map(result=>result.journey)).toEqual(baseline.results.map(result=>result.journey));
 expect(released.metrics.passed).toBe(2);expect(released.discovery?.index.version).not.toBe(baseline.discovery?.index.version);
});
