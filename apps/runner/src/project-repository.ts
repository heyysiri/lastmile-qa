import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {join,resolve,relative,sep} from 'node:path';
import {promisify} from 'node:util';
import {hashValue} from './artifacts';
import {setTimeout as delay} from 'node:timers/promises';
import type {ProjectRepair,ProjectRepositoryRuntime,ProjectCommands} from '@lastmile/contracts/projects';
import {prepareVendureRecipe} from '../../../integrations/vendure/recipe.mjs';
import {cloneRepository,syncRepository,createGitHubRepositoryClient} from './github-repository';
import {compareProjectReplayResults} from './project-context-investigation';
const exec=promisify(execFile);
const git=async(root:string,args:string[])=>(await exec('git',['-C',root,...args],{timeout:30000,maxBuffer:2_000_000})).stdout.trim();
const exists=async(path:string)=>stat(path).then(()=>true,()=>false);
async function freePort(){const server=createServer();return new Promise<number>((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(error=>error||!address||typeof address==='string'?fail(error??new Error('Port unavailable')):ok(address.port));});});}
async function assertPortFree(port:number){const server=createServer();await new Promise<void>((ok,fail)=>{server.once('error',()=>fail(new Error('Managed application port is occupied. Stop the previous application instance and retry.')));server.listen(port,'127.0.0.1',()=>server.close(error=>error?fail(error):ok()));});}
function launch(argv:string[],cwd:string,port:number){
 const {PATH,HOME,TMPDIR,TMP,TEMP,CI,LANG,LC_ALL,TZ}=process.env;
 const [command,...args]=argv.map(arg=>arg.replaceAll('{port}',String(port)));
 const child=spawn(command,args,{cwd,env:{PATH,HOME,TMPDIR,TMP,TEMP,CI,LANG,LC_ALL,TZ,PORT:String(port),HOST:'127.0.0.1'},detached:true,stdio:'ignore'});
 let exited=false;const done=new Promise<boolean>(ok=>{child.once('error',()=>{exited=true;ok(false);});child.once('exit',code=>{exited=true;ok(code===0);});});
 const kill=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
 return {done,exited:()=>exited,async close(){kill('SIGTERM');await Promise.race([done,delay(500)]);kill('SIGKILL');await done;}};
}
type Transport={clone:typeof cloneRepository;sync:typeof syncRepository;publish:ReturnType<typeof createGitHubRepositoryClient>['publishVerifiedPatch']};
type Options={root:string;token:string;transport?:Transport};
export function createProjectRepository(options:Options):ProjectRepositoryRuntime {
 const transport=options.transport??{clone:cloneRepository,sync:syncRepository,publish:createGitHubRepositoryClient({token:options.token}).publishVerifiedPatch};
 let active:{projectId:string;sha:string;appUrl:string;process:ReturnType<typeof launch>}|undefined;
 let operation:ReturnType<typeof launch>|undefined;const cancellation=new AbortController();
 async function stop(){const previous=active;active=undefined;if(previous)await previous.process.close();}
 async function command(argv:string[],cwd:string,port:number,description:string){
  cancellation.signal.throwIfAborted();const child=launch(argv,cwd,port);operation=child;let timer:ReturnType<typeof setTimeout>|undefined;
  try{const ok=await Promise.race([child.done,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),900000);})]);if(!ok)throw new Error(`${description} failed. Check the configured command in the managed checkout.`);}
  finally{clearTimeout(timer);await child.close();if(operation===child)operation=undefined;}
 }
 async function cwdFor(root:string,commands:ProjectCommands){const canonical=await realpath(root);const cwd=await realpath(resolve(canonical,commands.cwd??'.'));if(cwd!==canonical&&!cwd.startsWith(canonical+sep))throw new Error('Application working directory leaves its managed checkout');return cwd;}
 async function retained(root:string,oldSha:string|undefined,sha:string,repairs:ProjectRepair[],verifiedCoverageRunId?:string){
  if(oldSha===sha)return {coverageMode:'retain' as const,verifiedCoverageRunId};
  if(!oldSha)return {coverageMode:'refresh' as const,verifiedCoverageRunId:undefined};
  const paths=(await git(root,['diff','--name-only',oldSha,sha])).split('\n').filter(Boolean).sort();
  for(const repair of repairs){if(repair.verification?.outcome!=='verified'||repair.sourceRun.revision!==oldSha||!repair.patch)continue;
   if(JSON.stringify(paths)!==JSON.stringify(repair.patch.changes.map(c=>c.path).sort()))continue;
   if((await Promise.all(repair.patch.changes.map(async change=>await readFile(join(root,change.path),'utf8')===change.after))).every(Boolean))return {coverageMode:'retain' as const,verifiedCoverageRunId:repair.sourceRun.id};
  }return {coverageMode:'refresh' as const,verifiedCoverageRunId:undefined};
 }
 return {
  async prepare(project,secrets,mode,onProgress,repairs){
   const github=project.github;if(!github)throw new Error('GitHub project configuration is missing');
   if(!/^[a-zA-Z0-9_-]{1,80}$/.test(project.id))throw new Error('Invalid managed project identity');
   const directory=resolve(options.root,project.id,'repository');const metadata=resolve(options.root,project.id,'prepared.json');
   await mkdir(resolve(options.root,project.id),{recursive:true,mode:0o700});
   let sha:string;
   if(!await exists(directory)){
    if(mode==='resume')throw new Error('Managed checkout is missing; sync the project first');
    onProgress('Cloning the selected GitHub branch');sha=await transport.clone({repositoryUrl:github.repositoryUrl,directory,branch:github.branch,token:options.token,signal:cancellation.signal});
   }else if(mode==='sync'){
    await stop();onProgress('Syncing the selected branch');sha=await transport.sync({repositoryUrl:github.repositoryUrl,directory,branch:github.branch,token:options.token,signal:cancellation.signal});
   }else sha=await git(directory,['rev-parse','HEAD']);
   if(await git(directory,['status','--porcelain','--untracked-files=no']))throw new Error('Managed checkout has tracked source changes; restore its revision before testing');
   if(mode==='resume'&&sha!==github.sha)throw new Error('Managed revision no longer matches the frozen test revision; sync before testing');
   let commands=project.commands,install=github.install,accounts=secrets.accounts,entryPath=github.entryPath;
   if(github.setup==='auto'){
    const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8')) as {name?:string};
    if(pkg.name!=='vendure')throw new Error('Automatic setup is available for Vendure. Choose custom setup and provide install, build and start commands for this repository.');
    const recipe=prepareVendureRecipe({workspace:directory});
    commands={cwd:relative(directory,recipe.workingDirectory),build:['/bin/sh','-c',recipe.buildCommand],start:['/bin/sh','-c',recipe.startCommand],databasePath:relative(directory,recipe.databasePath),runtimeFiles:recipe.runtimeFiles.map(path=>relative(directory,path))};
    install=['/bin/sh','-c',recipe.installCommand];
    const credentials=JSON.parse(await readFile(join(recipe.workingDirectory,'.data/credentials.json'),'utf8')) as Record<string,string>;
    if(!accounts.length)accounts=['catalog','orders'].map(role=>({id:`${project.id}-${role}`,label:role==='catalog'?'Catalogue and inventory staff':'Order operations staff',username:`${role}@example.test`,password:credentials[role]}));
    if(entryPath==='/')entryPath='/dashboard/';
   }
   if(!commands?.start.length)throw new Error('Application start command is required');
   const cwd=await cwdFor(directory,commands);
   const configuration=JSON.stringify({sha,commands,install});
   const previous=await readFile(metadata,'utf8').catch(()=>undefined);
   if(active&&(active.projectId!==project.id||active.sha!==sha||active.process.exited()))await stop();
   let appUrl=active?.appUrl;
   if(!appUrl){
    const portPath=resolve(options.root,project.id,'port.json');
    const savedPort=await readFile(portPath,'utf8').then(raw=>JSON.parse(raw) as number,()=>undefined);
    if(savedPort!==undefined&&(!Number.isInteger(savedPort)||savedPort<1||savedPort>65535))throw new Error('Managed application port is invalid');
    const port=savedPort??await freePort();
    await writeFile(portPath,JSON.stringify(port),{mode:0o600});
    try{
     if(previous!==configuration){
      if(install){
       const installPath=resolve(options.root,project.id,'installed.json');
       const dependencyFiles=await Promise.all(['package.json','package-lock.json','pnpm-lock.yaml','yarn.lock'].map(path=>readFile(join(directory,path),'utf8').catch(()=>'')));
       const installHash=hashValue({install,dependencyFiles});
       if(await readFile(installPath,'utf8').catch(()=>'')!==installHash||!await exists(join(directory,'node_modules'))){onProgress('Installing application dependencies');await command(install,cwd,port,'Dependency installation');await writeFile(installPath,installHash,{mode:0o600});}
      }
      if(commands.build){onProgress('Building the application and preparing development data');await command(commands.build,cwd,port,'Application build');}
      if(await git(directory,['status','--porcelain','--untracked-files=no']))throw new Error('Application build changed tracked source; revision cannot be verified');
      await writeFile(metadata,configuration,{mode:0o600});
     }
     await assertPortFree(port);
     onProgress('Starting the managed application');const child=launch(commands.start,cwd,port);active={projectId:project.id,sha,appUrl:`http://127.0.0.1:${port}${entryPath}`,process:child};appUrl=active.appUrl;
     const deadline=Date.now()+120000;let ready=false;
     while(Date.now()<deadline&&!child.exited()){
      cancellation.signal.throwIfAborted();try{const response=await fetch(appUrl,{redirect:'manual',signal:AbortSignal.timeout(1500)});await response.body?.cancel();if(response.status>=200&&response.status<400){ready=true;break;}}catch{}await delay(300,undefined,{signal:cancellation.signal});
     }
     if(!ready)throw new Error('Application did not become ready. Check its start command and entry path.');
    }catch(error){await stop();throw error;}
   }
   const coverage=mode==='resume'?{coverageMode:github.coverageMode,verifiedCoverageRunId:github.verifiedCoverageRunId}:await retained(directory,github.sha,sha,repairs,github.verifiedCoverageRunId);
   return {repositoryPath:directory,appUrl,allowedOrigins:[new URL(appUrl).origin],commands,accounts,github:{...github,entryPath,sha,...coverage,syncedAt:mode==='resume'?github.syncedAt:new Date().toISOString()}};
  },
  async publish(repair){
   if(repair.verification?.outcome!=='verified'||!repair.patch||!repair.sourceRun.revision||!repair.project.github)throw new Error('Only a verified GitHub repair can be published');
   const checks=compareProjectReplayResults(repair.sourceRun,repair.verification.results);
   if(!checks.length||checks.some(check=>check.after.status!=='passed'))throw new Error('Verified replay evidence is incomplete');
   const github=repair.project.github;
   return transport.publish({repositoryUrl:github.repositoryUrl,baseBranch:github.branch,baseSha:repair.sourceRun.revision,repairId:repair.id,patch:repair.patch,title:`Fix: ${repair.patch.summary.replace(/\s+/g,' ').slice(0,120)}`,body:`${repair.patch.summary}\n\nVerified by lastmile qa. against commit ${repair.sourceRun.revision}.\n\nAll ${repair.verification.results.length} frozen journeys passed independent checks using zero-model replay. Patch hash: ${repair.patch.hash}.\n\nReview and merge manually, then Sync & test to run the retained users again.`});
  },
  async close(){cancellation.abort();await operation?.close();await stop();},
 };
}
