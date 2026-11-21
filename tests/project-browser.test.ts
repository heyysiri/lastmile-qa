import {createServer,type RequestListener,type Server} from 'node:http';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {StepEvent} from '../packages/contracts/src/index';
import {desktopContext} from '../packages/contracts/src/examples';
import {BrowserActionError,createBrowserSession,routeIdentity,type BrowserSession} from '../apps/runner/src/browser';
const sessions:BrowserSession[]=[],servers:Server[]=[],dirs:string[]=[];
afterEach(async()=>{await Promise.all(sessions.splice(0).map(s=>s.close()));await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function serve(body:string|RequestListener){const server=createServer((q,r)=>{r.setHeader('content-type','text/html');if(typeof body==='string')r.end(body);else body(q,r);});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function browser(origin:string,extra:Partial<Parameters<typeof createBrowserSession>[0]>={}){const directory=await mkdtemp(join(tmpdir(),'project-browser-'));dirs.push(directory);const session=await createBrowserSession({pack:desktopContext,inputs:{},origin,artifactDirectory:directory,signal:AbortSignal.timeout(30000),onStep:()=>{},...extra});sessions.push(session);return session;}
it('persists a real browser profile while a different tester stays isolated',async()=>{
 const origin=await serve('<h1>Workspace</h1>');const first=await browser(origin);await first.execute({tool:'navigate',path:'/'});
 await first.page.evaluate(()=>{localStorage.setItem('tester','one');document.cookie='account=one; Path=/';});
 const restored=await browser(origin,{storageState:await first.storageState()});await restored.execute({tool:'navigate',path:'/'});
 expect(await restored.page.evaluate(()=>[localStorage.getItem('tester'),document.cookie])).toEqual(['one','account=one']);
 const other=await browser(origin);await other.execute({tool:'navigate',path:'/'});expect(await other.page.evaluate(()=>[localStorage.getItem('tester'),document.cookie])).toEqual([null,'']);
});
it('permits declared API origins but rejects undeclared origins and privileged test routes',async()=>{
 const api=await serve('allowed'),blocked=await serve('blocked');const origin=await serve('<h1>Workspace</h1>');const session=await browser(origin,{allowedOrigins:[api]});await session.execute({tool:'navigate',path:'/'});
 const results=await session.page.evaluate(async urls=>Promise.all(urls.map(async url=>{try {await fetch(url,{mode:'no-cors'});return true;}catch{return false;}})),[api,blocked,api+'/api/test/state']);
 expect(results).toEqual([true,false,false]);
});
it('records query and fragment changes on the same pathname',async()=>{
 const origin=await serve('<h1>Edit record</h1><a href="/edit?id=42#stock">Stock</a>');
 const session=await browser(origin);
 await session.execute({tool:'navigate',path:'/edit?id=42#details'});
 await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Stock'}});
 await session.execute({tool:'navigate',path:'/edit?id=43#stock'});
 expect(session.actions).toMatchObject([
  {routeVersion:2,urlBefore:'blank',url:origin+'/edit?id=42#details'},
  {routeVersion:2,urlBefore:'/edit?id=42#details',url:origin+'/edit?id=42#stock'},
  {routeVersion:2,urlBefore:'/edit?id=42#stock',url:origin+'/edit?id=43#stock'},
 ]);
 expect(routeIdentity(session.actions[2].url)).toBe('/edit?id=43#stock');
 expect((await session.inspectReplayPosition()).url).toBe('/edit?id=43#stock');
});
it('records the landed route when the same navigation redirects to different records',async()=>{
 let destination='/edit?id=42#stock';
 const origin=await serve((request,response)=>{
  if(request.url==='/start')response.writeHead(302,{location:destination});
  response.end('<h1>Edit record</h1>');
 });
 const session=await browser(origin);
 await session.execute({tool:'navigate',path:'/start'});
 destination='/edit?id=43#details';
 await session.execute({tool:'navigate',path:'/start'});
 expect(session.actions.map(({urlBefore,url})=>[urlBefore,url])).toEqual([
  ['blank',origin+'/edit?id=42#stock'],
  ['/edit?id=42#stock',origin+'/edit?id=43#details'],
 ]);
});
it('redacts private account values from browser JSON evidence',async()=>{
 const account='private+account@example.test',password='private-password';
 const encoded=encodeURIComponent(account);
 const origin=await serve((request,response)=>{
  if(request.url?.startsWith('/lookup/'))response.writeHead(404);
  response.end(`<label for="${account}">${account}</label><input id="${account}" value="${account}" autofocus><label>Password<input type="password"></label><p>${password}</p>`);
 });
 const directory=await mkdtemp(join(tmpdir(),'project-browser-evidence-'));dirs.push(directory);
 const steps:StepEvent[]=[];
 const session=await browser(origin,{artifactDirectory:directory,inputs:{password},redactValues:[account,password],onStep:step=>steps.push(step)});
 const observation=await session.execute({tool:'navigate',path:'/'});
 expect(await session.page.locator(':focus').getAttribute('id')).toBe(account);
 const focused=await session.inspectReplayPosition();
 await session.page.evaluate(path=>fetch(path).then(response=>response.text()),`/lookup/${encoded}`);
 await session.execute({tool:'pressKey',key:'Tab'});
 await session.close();
 expect(session.actions[1]?.focusBefore).toContain('[private]');
 expect(session.networkEvents).toContainEqual(expect.objectContaining({kind:'http_error',status:404}));
 const evidence=JSON.stringify({observation,focused,steps,actions:session.actions,capabilities:session.capabilities,network:session.networkEvents})+
  await readFile(join(directory,'network.json'),'utf8');
 for(const value of [account,password,encoded])expect(evidence).not.toContain(value);
});
it('records credential input references and rejects private action literals',async()=>{
 const password='private-password';
 const origin=await serve('<label>Password<input type="password"></label>');
 const steps:StepEvent[]=[];
 const session=await browser(origin,{inputs:{password},redactValues:[password],onStep:step=>steps.push(step)});
 await session.execute({tool:'navigate',path:'/'});
 const locator={by:'label',value:'Password'} as const;
 await session.execute({tool:'fill',locator,value:{input:'password'}});
 expect(await session.page.getByLabel('Password').inputValue()).toBe(password);
 expect(session.actions[1]?.action).toEqual({tool:'fill',locator,value:{input:'password'}});
 await expect(session.execute({tool:'fill',locator,value:{literal:password}})).rejects.toBeInstanceOf(BrowserActionError);
 expect(JSON.stringify({steps,actions:session.actions})).not.toContain(password);
});
it('suppresses every screenshot when an app can render private account data',async()=>{
 const origin=await serve('<input value="private-account"><input type="password" value="private-password"><p>private-account</p>');
 const directory=await mkdtemp(join(tmpdir(),'project-browser-evidence-'));dirs.push(directory);
 const steps:StepEvent[]=[];
 const session=await browser(origin,{artifactDirectory:directory,redactValues:['private-account','private-password'],onStep:step=>steps.push(step)});
 await session.execute({tool:'navigate',path:'/'});
 expect(await session.page.locator('input').first().inputValue()).toBe('private-account');
 await session.observe();
 await session.close();
 expect(steps.every(step=>step.screenshot===undefined)).toBe(true);
 expect(await readdir(directory)).toEqual(['network.json']);
 expect(session.capabilities).toContainEqual(expect.objectContaining({factor:'screenshots',status:'unsupported'}));
});
it('masks password controls in screenshots for sessions without account data',async()=>{
 const origin=await serve('<body style="margin:0"><input type="password" value="example" style="background:red;width:120px;height:40px"></body>');
 const directory=await mkdtemp(join(tmpdir(),'project-browser-evidence-'));dirs.push(directory);
 const session=await browser(origin,{artifactDirectory:directory});
 await session.execute({tool:'navigate',path:'/'});
 const screenshot=await readFile(join(directory,'step-1.png'));
 const pixel=await session.page.evaluate(async png=>{
  const image=new Image();
  image.src='data:image/png;base64,'+png;
  await image.decode();
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('2d')!;
  context.drawImage(image,0,0);
  return Array.from(context.getImageData(100,20,1,1).data);
 },screenshot.toString('base64'));
 expect(pixel).toEqual([255,0,255,255]);
});
it('rejects replay routes containing raw or URL-encoded private account values',async()=>{
 const secret='private+account@example.test',encoded=encodeURIComponent(secret);
 const origin=await serve((request,response)=>{
  if(request.url==='/start')response.writeHead(302,{location:`/edit?account=${encoded}#stock`});
  response.end('<h1>Edit record</h1>');
 });
 const steps:StepEvent[]=[];
 const session=await browser(origin,{redactValues:[secret],onStep:step=>steps.push(step)});
 for(const path of [`/edit#${secret}`,'/start']){
  const execution=session.execute({tool:'navigate',path});
  await expect(execution).rejects.toBeInstanceOf(BrowserActionError);
  await expect(execution).rejects.toThrow(/route.*private/i);
 }
 expect(session.page.url()).toBe(origin+`/edit?account=${encoded}#stock`);
 expect(session.actions).toEqual([]);
 for(const value of [secret,encoded])expect(JSON.stringify(steps)).not.toContain(value);
});
