import {createServer,type Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {desktopContext} from '../packages/contracts/src/examples';
import {createBrowserSession,type BrowserSession} from '../apps/runner/src/browser';
const sessions:BrowserSession[]=[],servers:Server[]=[],dirs:string[]=[];
afterEach(async()=>{await Promise.all(sessions.splice(0).map(s=>s.close()));await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function serve(body:string){const server=createServer((_q,r)=>r.end(body));servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
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
it('removes private account values from model observations and capability evidence',async()=>{
 const origin=await serve('<label>Account<input value="private-account"></label><p>private-password</p>');
 const session=await browser(origin,{inputs:{password:'private-password'},redactValues:['private-account','private-password']});
 const observation=await session.execute({tool:'navigate',path:'/'});
 expect(observation).not.toContain('private-account');expect(observation).not.toContain('private-password');expect(JSON.stringify(session.capabilities)).not.toContain('private-password');
});
