import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {Client,type CallToolResult} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const cleanups:(()=>Promise<unknown>)[]=[];
const token='mcp-private-token';
const account={label:'Staff',username:'staff-private@example.test',password:'private-password'};
const connection={requestId:'connect-1',name:'Local app',repositoryPath:'/tmp/example',appUrl:'http://127.0.0.1:9000',brief:'Test editing stock',accounts:[account]};
const project={id:'project-1',name:'Local app',status:'ready',accounts:[{id:'account-1',label:'Staff'}]};
const baseRun={id:'run-1',projectId:project.id,request:{requestId:'run-1',mode:'explore',autoRepair:true},status:'completed',metrics:{failed:1,inconclusive:0}};
const repair={id:'repair-1',projectId:project.id,request:{requestId:'auto-run-1',runId:'run-1',automatic:true},status:'running',phase:'verify'};
const send=(res:ServerResponse,body:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
async function fixture(handler:(req:IncomingMessage,res:ServerResponse,body:Record<string,unknown>)=>void){
 const requests:{path:string;method:string;body:Record<string,unknown>}[]=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):{};
  requests.push({path:req.url!,method:req.method!,body});
  if(req.headers.authorization!==`Bearer ${token}`){send(res,{code:'unauthorized',message:`Do not echo ${token}`},401);return;}
  handler(req,res,body);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 cleanups.push(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing fixture port');
 return {url:`http://127.0.0.1:${address.port}`,requests};
}
async function start(url:string,env:Record<string,string>={}){
 const cwd=await mkdtemp(join(tmpdir(),'lastmile-mcp-'));
 cleanups.push(()=>rm(cwd,{recursive:true,force:true}));
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('scripts/mcp.mjs')],cwd,env:{RUNNER_URL:url,RUNNER_API_TOKEN:token,...env},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk.toString();});
 const client=new Client({name:'lastmile-mcp-test',version:'1.0.0'});
 cleanups.push(()=>client.close());
 try{await client.connect(transport);}catch(error){throw new Error(`MCP initialization failed: ${stderr}`,{cause:error});}
 return {client,stderr:()=>stderr};
}
async function call(client:Client,name:string,args:Record<string,unknown>={}){
 const result=await client.callTool({name,arguments:args});
 if(!('content' in result))throw new Error('Expected tool result');
 return result as CallToolResult;
}
function data(result:CallToolResult){const item=result.content[0];if(item.type!=='text')throw new Error('Expected text');return JSON.parse(item.text);}
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

it('initializes over real stdio from another cwd and advertises bounded tools',async()=>{
 const {url}=await fixture((_req,res)=>send(res,{status:'ok',projectExecutionReady:true,projectRepairsReady:true}));
 const {client,stderr}=await start(url);
 const {tools}=await client.listTools();
 expect(tools.map(tool=>tool.name).sort()).toEqual(['lastmile_connect_project','lastmile_get_connection','lastmile_get_project','lastmile_get_repair','lastmile_get_run','lastmile_health','lastmile_list_projects','lastmile_retry_repair','lastmile_run_project'].sort());
 expect(tools.find(t=>t.name==='lastmile_run_project')?.inputSchema.required).toEqual(expect.arrayContaining(['requestId','projectId']));
 expect(tools.find(t=>t.name==='lastmile_get_run')?.description).toMatch(/repair/i);
 expect(data(await call(client,'lastmile_health'))).toMatchObject({status:'ok',projectExecutionReady:true});
 expect(stderr()).toBe('');
});

it('forwards shared connection defaults, recovers by request ID, and lists/reads projects without credentials',async()=>{
 const {url,requests}=await fixture((req,res)=>send(res,req.url==='/api/projects'&&req.method==='GET'?[project]:project,req.method==='POST'?202:200));
 const {client}=await start(url);
 const first=await call(client,'lastmile_connect_project',connection);
 const again=await call(client,'lastmile_connect_project',connection);
 expect(data(first).id).toBe(data(again).id);
 expect(requests[0].body).toEqual({...connection,allowedOrigins:[],requirements:''});
 expect(data(await call(client,'lastmile_get_connection',{requestId:'connect-1'})).id).toBe(project.id);
 expect(data(await call(client,'lastmile_list_projects'))).toMatchObject([{id:project.id,name:project.name,status:'ready'}]);
 expect(data(await call(client,'lastmile_get_project',{projectId:project.id})).id).toBe(project.id);
 expect(JSON.stringify(first)).not.toContain(account.password);
 expect(JSON.stringify(first)).not.toContain(account.username);
 expect(requests.map(r=>r.path)).toContain('/api/projects/by-request/connect-1');
});

it('defaults to automatic repair, keeps idempotency IDs, follows repair completion and supports an automatic retry',async()=>{
 let finished=false;
 const {url,requests}=await fixture((req,res,body)=>{
  if(req.url==='/api/project-repairs?projectId=project-1')return send(res,[{...repair,status:finished?'completed':'running',...(finished?{verification:{outcome:'verified'}}:{})}]);
  if(req.url==='/api/project-repairs/repair-1')return send(res,{...repair,status:'completed',patch:{summary:'Fix stock'},verification:{outcome:'verified'}});
  if(req.url==='/api/project-repairs')return send(res,{...repair,request:body},202);
  send(res,baseRun,req.method==='POST'?202:200);
 });
 const {client}=await start(url);
 const args={projectId:project.id,requestId:'stable-run'};
 expect(data(await call(client,'lastmile_run_project',args)).id).toBe('run-1');
 expect(data(await call(client,'lastmile_run_project',args)).id).toBe('run-1');
 expect(requests[0].body).toEqual({requestId:'stable-run',mode:'explore',autoRepair:true});
 expect(requests[1].body).toEqual(requests[0].body);
 const running=data(await call(client,'lastmile_get_run',{runId:'run-1'}));
 expect(running).toMatchObject({run:{status:'completed'},repairStatus:'running',repairs:[{id:'repair-1'}]});
 expect(running.dashboardUrl).toBe('http://127.0.0.1:3000/projects/project-1');
 finished=true;
 expect(data(await call(client,'lastmile_get_run',{runId:'run-1'}))).toMatchObject({repairStatus:'completed',repairs:[{verification:{outcome:'verified'}}]});
 expect(data(await call(client,'lastmile_get_repair',{repairId:'repair-1'}))).toMatchObject({patch:{summary:'Fix stock'},verification:{outcome:'verified'}});
 await call(client,'lastmile_retry_repair',{runId:'run-1',requestId:'stable-retry'});
 expect(requests.at(-1)?.body).toEqual({runId:'run-1',requestId:'stable-retry',automatic:true});
 await call(client,'lastmile_run_project',{...args,requestId:'release-run',mode:'release',autoRepair:false});
 expect(requests.at(-1)?.body).toEqual({requestId:'release-run',mode:'release',autoRepair:false});
});

it.each([
 [{...baseRun,status:'running'},'awaiting_run'],
 [{...baseRun,request:{...baseRun.request,autoRepair:false}},'not_requested'],
 [{...baseRun,metrics:{failed:0,inconclusive:0}},'not_needed'],
 [{...baseRun,repairBlockedReason:'Complete evidence required'},'blocked'],
 [baseRun,'pending'],
])('distinguishes absent repair states: %s',async(run,status)=>{
 const {url}=await fixture((req,res)=>send(res,req.url?.startsWith('/api/project-repairs?')?[]:run));
 const {client}=await start(url);
 expect(data(await call(client,'lastmile_get_run',{runId:'run-1'}))).toMatchObject({repairStatus:status,repairs:[]});
});

it('rejects invalid identifiers and missing request IDs before sending HTTP requests',async()=>{
 const {url,requests}=await fixture((_req,res)=>send(res,project));
 const {client}=await start(url);
 for(const [name,args] of [['lastmile_get_project',{projectId:'../health'}],['lastmile_run_project',{projectId:project.id}],['lastmile_retry_repair',{runId:'run-1'}]] as const){
  expect((await call(client,name,args)).isError).toBe(true);
 }
 expect(requests).toEqual([]);
});

it('reports unknown IDs and runner errors without reflecting secret response bodies',async()=>{
 const {url}=await fixture((_req,res)=>send(res,{code:'not_found',message:`${account.password} ${account.username} ${token}`},404));
 const {client,stderr}=await start(url);
 const result=await call(client,'lastmile_get_project',{projectId:'missing'});
 expect(result.isError).toBe(true);
 expect(data(result)).toMatchObject({code:'not_found',status:404});
 for(const secret of [account.password,account.username,token])expect(JSON.stringify(result)+stderr()).not.toContain(secret);
});

it('reports authentication failures and offline runners as tool errors',async()=>{
 const {url}=await fixture((_req,res)=>send(res,project));
 const {client}=await start(url,{RUNNER_API_TOKEN:'incorrect'});
 expect(data(await call(client,'lastmile_list_projects'))).toMatchObject({code:'unauthorized',status:401});
 const {client:offline}=await start('http://127.0.0.1:1');
 expect(data(await call(offline,'lastmile_health'))).toMatchObject({code:'runner_unavailable'});
});

it('times out a stalled runner and refuses redirects with its authorization header',async()=>{
 let leaked=false;
 const target=await fixture((_req,res)=>{leaked=true;send(res,project);});
 const redirect=await fixture((_req,res)=>{res.writeHead(302,{location:target.url});res.end();});
 const {client}=await start(redirect.url);
 expect(data(await call(client,'lastmile_list_projects'))).toMatchObject({code:'runner_unavailable'});
 expect(leaked).toBe(false);
 const stalled=await fixture(()=>{});
 const {client:slow}=await start(stalled.url,{LASTMILE_MCP_TIMEOUT_MS:'50'});
 expect(data(await call(slow,'lastmile_health'))).toMatchObject({code:'runner_timeout'});
});


it('keeps findings and frozen checks in compact responses and exposes browser evidence on demand',async()=>{
 const result={tester:{id:'tester-1'},journey:{id:'journey-1'},checks:[{id:'quantity',status:'passed'}],run:{id:'evidence-1',status:'completed',verdict:'passed',executionMode:'deterministic',steps:[{observation:'Large browser log'}],evidence:{modelCalls:0,replayCompatible:true,actions:[{action:{tool:'navigate',path:'/stock'}}]}}};
 const fullRun={...baseRun,findings:[{id:'finding-1',title:'Stock changed'}],results:[result],discovery:{plan:{summary:'Full discovery'}}};
 const fullRepair={...repair,status:'completed',sourceRun:fullRun,project:{...project,discovery:{plan:{summary:'Large repeated discovery'}}},patch:{summary:'Fix stock'},verification:{outcome:'verified',results:[result]}};
 const {url}=await fixture((req,res)=>send(res,req.url==='/api/project-runs/run-1'?fullRun:req.url?.startsWith('/api/project-repairs?')?[fullRepair]:fullRepair));
 const {client}=await start(url);
 const compact=data(await call(client,'lastmile_get_run',{runId:'run-1'}));
 expect(compact.run.findings).toEqual(fullRun.findings);
 expect(compact.run.results[0]).toMatchObject({checks:result.checks,run:{executionMode:'deterministic',evidence:{modelCalls:0,replayCompatible:true}}});
 expect(compact.run.results[0].run.steps).toBeUndefined();
 expect(compact.repairs[0].sourceRun).toBeUndefined();
 expect(compact.repairs[0].patch).toBeUndefined();
 const details=data(await call(client,'lastmile_get_repair',{repairId:'repair-1'}));
 expect(details).toMatchObject({patch:fullRepair.patch,verification:{outcome:'verified',results:[{checks:result.checks,run:{evidence:{modelCalls:0}}}]}});
 expect(details.project.discovery).toBeUndefined();
 const evidence=data(await call(client,'lastmile_get_run',{runId:'run-1',includeEvidence:true}));
 expect(evidence.run.results[0].run.steps).toEqual(result.run.steps);
 expect(data(await call(client,'lastmile_get_repair',{repairId:'repair-1',includeEvidence:true})).sourceRun).toEqual(fullRun);
});

it('does not expose supplied account credentials even when an upstream connect response echoes them',async()=>{
 const {url}=await fixture((_req,res)=>send(res,{...project,error:`${account.username} ${account.password} ${token}`}));
 const {client}=await start(url);
 const response=JSON.stringify(await call(client,'lastmile_connect_project',connection));
 for(const secret of [account.password,account.username,token])expect(response).not.toContain(secret);
});

it('rejects unsafe configuration at startup without printing its values',async()=>{
 const secret='private-config-secret';
 await expect(start(`http://user:${secret}@127.0.0.1:4000`)).rejects.toThrow('Cannot start lastmile qa. MCP');
 try{await start('http://127.0.0.1:4000',{LASTMILE_MCP_TIMEOUT_MS:secret});throw new Error('Expected startup rejection');}
 catch(error){expect(String(error)).toContain('Cannot start lastmile qa. MCP');expect(String(error)).not.toContain(secret);}
});

it('redacts string values without corrupting JSON keys, booleans, or null for short credentials',async()=>{
 const {url}=await fixture((_req,res)=>send(res,{...project,nullable:null,failed:false,message:'a null',accounts:[{id:'account-1',label:'Staff'}]}));
 const {client}=await start(url);
 const result=await call(client,'lastmile_connect_project',{...connection,accounts:[{label:'Staff',username:'a',password:'null'}]});
 expect(data(result)).toMatchObject({nullable:null,failed:false,message:'[private] [private]'});
 expect(data(result).accounts).toBeDefined();
 const {tools}=await client.listTools();
 expect(tools.find(t=>t.name==='lastmile_run_project')?.annotations?.destructiveHint).toBe(true);
});
