import {createServer,type Server} from 'node:http';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createProjectSessions} from '../apps/runner/src/project-sessions';
import type {Project,ProjectSecrets} from '../packages/contracts/src/projects';
const roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});
it('authenticates through ordinary UI once, retains account binding, and never gives passwords to the actor',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-sessions-'));roots.push(root);
 const server=createServer((q,r)=>{r.setHeader('content-type','text/html');if(q.url==='/login'){r.setHeader('set-cookie','login=staff; Path=/');r.end('<h1>Staff home</h1>');}else r.end(q.headers.cookie?.includes('login=staff')?'<h1>Staff home</h1>':'<label>Email<input></label><label>Password<input type="password"></label><a href="/login">Sign in</a>');});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const project:Project={id:'project',name:'Staff application',repositoryPath:root,brief:'Test staff tasks',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin,allowedOrigins:[],accounts:[{id:'account',label:'Staff'}]};
 const secrets:ProjectSecrets={accounts:[{id:'account',label:'Staff',username:'staff-private',password:'password-private'}]};
 const actor=vi.fn(async(session,run)=>{expect(JSON.stringify(run)).not.toContain('password-private');await session.execute({tool:'fill',locator:{by:'label',value:'Email'},value:{input:'accountUsername'}});await session.execute({tool:'fill',locator:{by:'label',value:'Password'},value:{input:'accountPassword'}});expect(await session.observe()).not.toContain('staff-private');await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Sign in'}});return {finished:true,modelCalls:1,reason:'Done'};});
 const service=createProjectSessions({privateRoot:root,model:'test',actor});
 const first=await service.authenticate(project,secrets,'account');expect(first.modelCalls).toBe(1);
 const second=await service.authenticate(project,secrets,'account');expect(second.continued).toBe(true);expect(actor).toHaveBeenCalledTimes(1);
 const seen=await service.observe(project,secrets,['/']);expect(seen[0]).toMatchObject({accountId:'account',path:'/'});expect(seen[0].text).toContain('Staff home');
 const path=service.statePath(project,'account');expect((await stat(path)).mode&0o777).toBe(0o600);expect(await readFile(path,'utf8')).toContain('login');
},15000);

it('marks sign-in unverified when its positive UI disappears in a restored browser',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-sessions-'));roots.push(root);
 const server=createServer((_q,r)=>{
  r.setHeader('content-type','text/html');r.setHeader('set-cookie','guest=1; Path=/');
  r.end(`<button onclick="this.textContent = 'Sign out'">Sign in</button>`);
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const project:Project={id:'project',name:'Staff application',repositoryPath:root,brief:'Test staff tasks',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin,allowedOrigins:[],accounts:[{id:'account',label:'Staff'}]};
 const secrets:ProjectSecrets={accounts:[{id:'account',label:'Staff',username:'staff-private',password:'password-private'}]};
 const service=createProjectSessions({privateRoot:root,model:'test',actor:async session=>{
  await session.execute({tool:'click',locator:{by:'role',value:'button',name:'Sign in'}});
  return {finished:true,modelCalls:1,reason:'Done'};
 }});
 expect(await service.authenticate(project,secrets,'account')).toMatchObject({verified:false,modelCalls:1});
 expect(await service.load(project,'account')).toBeUndefined();
},15000);

it('uses the configured query and fragment to sign in through an email-first UI',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-sessions-'));roots.push(root);
 const server=createServer((q,r)=>{
  r.setHeader('content-type','text/html');
  if(q.headers.cookie?.includes('login=staff')){r.end('<button>Sign out</button>');return;}
  if(q.url==='/start?next=stock'){
   r.end(`<main></main><script>if(location.hash==='#signin')document.querySelector('main').innerHTML='<label>Email<input></label><a href="/password">Continue</a>'</script>`);return;
  }
  if(q.url==='/password'){r.end('<label>Password<input type="password"></label><a href="/signed-in">Sign in</a>');return;}
  if(q.url==='/signed-in'){r.setHeader('set-cookie','login=staff; Path=/');r.end('<button>Sign out</button>');return;}
  r.end('<h1>Public landing</h1>');
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const project:Project={id:'project',name:'Staff application',repositoryPath:root,brief:'Test staff tasks',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin+'/start?next=stock#signin',allowedOrigins:[],accounts:[{id:'account',label:'Staff'}]};
 const secrets:ProjectSecrets={accounts:[{id:'account',label:'Staff',username:'staff-private',password:'password-private'}]};
 const actor=vi.fn<typeof import('../apps/runner/src/agent').runAgent>(async(session)=>{
  await session.execute({tool:'fill',locator:{by:'label',value:'Email'},value:{input:'accountUsername'}});
  await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Continue'}});
  await session.execute({tool:'fill',locator:{by:'label',value:'Password'},value:{input:'accountPassword'}});
  await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Sign in'}});
  return {finished:true,modelCalls:1,reason:'Done'};
 });
 const service=createProjectSessions({privateRoot:root,model:'test',actor});
 expect(await service.authenticate(project,secrets,'account')).toMatchObject({verified:true,continued:false,modelCalls:1});
 expect(await service.observe(project,secrets,['/start?next=stock#signin'])).toEqual(expect.arrayContaining([expect.objectContaining({accountId:'account',path:'/start?next=stock#signin',text:expect.stringContaining('Sign out')})]));
 expect(actor).toHaveBeenCalledTimes(1);
},15000);

it('does not store or attribute a public landing session when the login actor finishes without signed-in evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-sessions-'));roots.push(root);
 const server=createServer((q,r)=>{
  r.setHeader('content-type','text/html');r.end(q.url==='/passwordless'?'<h1>Check your email</h1>':'<h1>Welcome</h1><a href="/passwordless">Sign in</a>');
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const project:Project={id:'project',name:'Staff application',repositoryPath:root,brief:'Test staff tasks',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin,allowedOrigins:[],accounts:[{id:'account',label:'Staff'}]};
 const secrets:ProjectSecrets={accounts:[{id:'account',label:'Staff',username:'staff-private',password:'password-private'}]};
 const service=createProjectSessions({privateRoot:root,model:'test',actor:async session=>{
  await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Sign in'}});
  return {finished:true,modelCalls:1,reason:'Done'};
 }});
 expect(await service.authenticate(project,secrets,'account')).toMatchObject({verified:false,continued:false,modelCalls:1});
 expect(await service.load(project,'account')).toBeUndefined();
 expect(await service.observe(project,secrets,['/'])).toEqual([expect.objectContaining({accountId:undefined,text:expect.stringContaining('Welcome')})]);
},15000);

it('observes collapsed navigation links without opening content or form controls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-sessions-'));roots.push(root);
 const server=createServer((_q,r)=>{
  r.setHeader('content-type','text/html');r.end(`
   <nav><button type="button" aria-expanded="false" aria-controls="inventory" onclick="this.setAttribute('aria-expanded','true'); inventory.hidden = false">Inventory</button>
   <ul id="inventory" hidden><li><a href="/stock">Stock records</a></li></ul></nav>
   <main><button type="button" aria-expanded="false" aria-controls="content" onclick="content.hidden = false">Options</button>
   <p id="content" hidden>Content expanded</p></main>
   <form><button type="button" aria-expanded="false" aria-controls="fields" onclick="fields.hidden = false">More fields</button>
   <p id="fields" hidden>Form expanded</p></form>`);
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const project:Project={id:'project',name:'Staff application',repositoryPath:root,brief:'Test staff tasks',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin,allowedOrigins:[],accounts:[]};
 const [seen]=await createProjectSessions({privateRoot:root,model:'test'}).observe(project,{accounts:[]},['/']);
 expect(seen.text).toContain('link "Stock records"');
 expect(seen.text).not.toMatch(/Content expanded|Form expanded/);
},15000);

it('observes both accounts without overlapping login writes on a single-writer development app',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-serial-logins-'));roots.push(root);let busy=false,collisions=0;
 const server=createServer(async(q,r)=>{
  r.setHeader('content-type','text/html');
  if(q.url==='/signin'){
   if(busy){collisions++;r.writeHead(503).end('<h1>Database is locked</h1>');return;}
   busy=true;await new Promise(resolve=>setTimeout(resolve,500));r.setHeader('set-cookie','signed=yes; Path=/');busy=false;
   r.end('<button>Sign out</button>');return;
  }
  r.end(q.headers.cookie?.includes('signed=yes')?'<button>Sign out</button><h1>Profile</h1>':'<a href="/signin">Sign in</a>');
 });servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const accounts=['a','b'].map(id=>({id,label:`Shopper ${id}`,username:`user-${id}`,password:`password-${id}`}));
 const project:Project={id:'serial',name:'Shop',repositoryPath:root,brief:'Review profiles',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin,allowedOrigins:[],accounts:accounts.map(({id,label})=>({id,label}))};
 const service=createProjectSessions({privateRoot:root,model:'test',actor:async session=>{await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Sign in'}});return {finished:true,modelCalls:1,reason:'Done'};}});
 const observations=await service.observe(project,{accounts},['/']);
 expect(collisions).toBe(0);expect(observations.map(o=>o.accountId)).toEqual(['a','b',undefined]);
},20000);

it('keeps two behavioral profiles browser-local state separate while sharing supplied account access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'persona-sessions-'));roots.push(root);
 const server=createServer((q,r)=>{r.setHeader('content-type','text/html');if(q.url==='/login'){r.setHeader('set-cookie','signed=1; Path=/');r.end('<button>Sign out</button>');return;}r.end(q.headers.cookie?.includes('signed=1')?'<button>Sign out</button>':'<a href="/login">Sign in</a>');});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const project:Project={id:'project',name:'Shared access',repositoryPath:root,brief:'Staff',requirements:'',createdAt:'now',updatedAt:'now',status:'ready',progress:'Ready',appUrl:origin,allowedOrigins:[],accounts:[{id:'account',label:'Staff'}]};
 const secrets:ProjectSecrets={accounts:[{id:'account',label:'Staff',username:'staff-private',password:'password-private'}]};
 const service=createProjectSessions({privateRoot:root,model:'test',actor:async session=>{await session.execute({tool:'click',locator:{by:'role',value:'link',name:'Sign in'}});return {finished:true,modelCalls:1,reason:'Done'};}});
 await service.authenticate(project,secrets,'account');
 const first=await service.authenticate(project,secrets,'account',undefined,true,'persona-one');
 expect(first.verified).toBe(true);
 const state=first.state!;state.origins=[{origin,localStorage:[{name:'draft',value:'Only first persona'}]}];await service.save(project,'persona-one',state);
 const second=await service.authenticate(project,secrets,'account',undefined,true,'persona-two');
 expect(second.verified).toBe(true);
 expect(await service.load(project,'persona-two')).toEqual(second.state);
 expect(JSON.stringify(second.state)).not.toContain('Only first persona');
 expect(JSON.stringify(await service.load(project,'persona-one'))).toContain('Only first persona');
 const seen=await service.observe(project,secrets,['/']);
 expect(seen.find(o=>o.accountId===undefined)?.text).toContain('Sign in');
 expect(seen.find(o=>o.accountId==='account')?.text).toContain('Sign out');
},15000);
