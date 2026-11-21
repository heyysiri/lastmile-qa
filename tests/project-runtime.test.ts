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
async function fixture(){const root=await mkdtemp(join(tmpdir(),'project-runtime-'));roots.push(root);await writeFile(join(root,'requirements.md'),'Staff can rename a record. Renaming must preserve its existing quantity.');
 const values:Record<string,{name:string;stock:number}>={a:{name:'A',stock:17},b:{name:'B',stock:23}};let defect=true;
 const server=createServer(async(q,r)=>{const key=q.url?.includes('/b')?'b':'a';if(q.method==='POST'){let body='';for await(const chunk of q)body+=chunk;values[key].name=new URLSearchParams(body).get('name')!;if(defect&&key==='a')values[key].stock=1;r.writeHead(303,{location:'/edit/'+key});r.end();return;}r.setHeader('content-type','text/html');r.end(`<main><form method="post"><label>Name<input name="name" value="${values[key].name}"></label><label>Stock<input value="${values[key].stock}" readonly></label><button>Save</button></form></main>`);});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const index=await scanRepository(root),source=await readRepositorySource(index,'requirements.md');const testers=['a','b'].map(id=>({id,name:id,role:'Staff',summary:'Maintain assigned records',context:{...projectBrowserContext,id}}));
 const discovery:ProjectDiscovery={index:{...index,fileCount:index.files.length},plan:{summary:'Records',features:[{id:'records',title:'Records',description:'Edit records',sources:[source]}],roles:['Staff'],testers,journeys:testers.map(t=>({id:t.id,testerId:t.id,title:'Rename record',goal:'Rename your record using newName, then save.',entryPath:'/edit/'+t.id,inputs:{newName:'Updated '+t.id},checks:[{id:'name',label:'Saved name',kind:'field',locator:{by:'label',value:'Name'},expected:'Updated '+t.id,phase:'after_reload',path:'/edit/'+t.id,basis:'requirement',sources:[source]},{id:'stock',label:'Existing stock remains intact',kind:'field',locator:{by:'label',value:'Stock'},phase:'preserve',path:'/edit/'+t.id,basis:'requirement',sources:[source]}],sources:[source],reason:'Renaming must preserve stock'})),gaps:[]},observations:[],modelCalls:0,durationMs:0,generatedAt:new Date().toISOString()};
 const project:Project={id:'project',name:'Records',repositoryPath:root,appUrl:origin,allowedOrigins:[],brief:'Staff can rename records',requirements:'',accounts:[],createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',discovery};
 const run:ProjectRun={id:'run-one',projectId:project.id,request:{requestId:'first',mode:'explore'},status:'running',phase:'Starting',createdAt:new Date().toISOString(),results:[],findings:[],summary:'',metrics:{elapsedMs:0,modelCalls:0,browserActions:0,passed:0,failed:0,inconclusive:0}};
 return {root,values,project,run,discovery,setDefect:(v:boolean)=>{defect=v;}};
}
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
