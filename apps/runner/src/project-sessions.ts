import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {ContextPack} from '@lastmile/contracts';
import type {EvidenceRun} from '@lastmile/contracts/runtime';
import type {Project,ProjectSecrets,ProjectObservation} from '@lastmile/contracts/projects';
import {createBrowserSession,type BrowserSession} from './browser';
import {runAgent} from './agent';
import {hashValue} from './artifacts';

export const projectBrowserContext:ContextPack={id:'project-browser',revision:1,label:'Application browser',viewport:{width:1440,height:1000},locale:'en-US',preferredLanguage:'English',familiarity:'experienced',knownTerms:[],interaction:'pointer',reducedMotion:'no-preference',network:{mode:'normal'},inputs:{}};
export function projectActorRun(goal:string,entryPath:string,inputs:EvidenceRun['inputs'],context:ContextPack=projectBrowserContext):EvidenceRun {
 const id=randomUUID();return {id,requestId:id,scenario:{id,revision:1,label:'Application journey',goal,entryPath,initialStateId:'native-session',inputSlots:Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,{type:typeof value==='number'?'number':typeof value==='boolean'?'boolean':'text',required:true}])),contract:{scope:'ui_only',assertions:[{id:'independent-checks',kind:'visible',locator:{by:'role',value:'main'}}]},investigation:{factors:[],maxAttempts:4}},context,inputs,status:'running',verdict:null,createdAt:new Date().toISOString(),manifestHash:hashValue({goal,inputs}),executionMode:'ai_guided',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[]};
}
type Options={privateRoot:string;apiKey?:string;model:string;actor?:typeof runAgent};
export function createProjectSessions(options:Options){
 const actor=options.actor??runAgent;
 const statePath=(project:Project,identity:string,root?:string)=>join(root??join(options.privateRoot,'sessions',project.id),`${identity}.json`);
 async function load(project:Project,identity:string,root?:string){try{return JSON.parse(await readFile(statePath(project,identity,root),'utf8')) as Awaited<ReturnType<BrowserSession['storageState']>>;}catch{return undefined;}}
 async function save(project:Project,identity:string,state:Awaited<ReturnType<BrowserSession['storageState']>>,root?:string){const path=statePath(project,identity,root);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(state),{mode:0o600});}
 const privateValues=(secrets:ProjectSecrets)=>secrets.accounts.flatMap(a=>[a.username,a.password]);
 async function authenticate(project:Project,secrets:ProjectSecrets,identity:string,sessionRoot?:string,allowModel=true){
  const account=secrets.accounts.find(a=>a.id===identity),stored=await load(project,identity,sessionRoot);
  if(!account)return {state:stored,continued:Boolean(stored),modelCalls:0};
  const directory=join(options.privateRoot,'authentication',randomUUID());let session:BrowserSession|undefined;
  try{
   session=await createBrowserSession({pack:projectBrowserContext,inputs:{accountUsername:account.username,accountPassword:account.password},origin:project.appUrl,allowedOrigins:project.allowedOrigins,storageState:stored,redactValues:privateValues(secrets),artifactDirectory:directory,signal:AbortSignal.timeout(90000),onStep:()=>{}});
   await session.execute({tool:'navigate',path:new URL(project.appUrl).pathname});
   // Authentication is detected from the ordinary password control, never a vendor route/API.
   await session.page.locator('input[type="password"]:visible').waitFor({state:'visible',timeout:1500}).catch(()=>{});
   let modelCalls=0;
   if(await session.page.locator('input[type="password"]:visible').count()){
    if(!allowModel)throw new Error('Frozen replay session requires authentication; replay makes no model calls');
    const login=projectActorRun('Sign in to this application using accountUsername and accountPassword. Stop when the signed-in application is visible. Do not change any business data.',new URL(project.appUrl).pathname,{accountUsername:'[private account input]',accountPassword:'[private password input]'});
    const result=await actor(session,login,{apiKey:options.apiKey,model:options.model});modelCalls=result.modelCalls;
    if(!result.finished||await session.page.locator('input[type="password"]:visible').count())throw new Error('The supplied development account could not sign in');
   }
   const state=await session.storageState();await save(project,identity,state,sessionRoot);
   return {state,continued:Boolean(stored),modelCalls};
  }finally{await session?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
 }
 async function observe(project:Project,secrets:ProjectSecrets,paths:string[]):Promise<ProjectObservation[]>{
  const identities=project.accounts.length?project.accounts.map(a=>a.id):['guest'];
  return (await Promise.all(identities.map(async identity=>{
   const directory=join(options.privateRoot,'observations',randomUUID());let session:BrowserSession|undefined;
   try{const auth=await authenticate(project,secrets,identity);session=await createBrowserSession({pack:projectBrowserContext,inputs:{},origin:project.appUrl,allowedOrigins:project.allowedOrigins,storageState:auth.state,redactValues:privateValues(secrets),artifactDirectory:directory,signal:AbortSignal.timeout(60000),onStep:()=>{}});
    const results:ProjectObservation[]=[];
    for(const path of paths.slice(0,12)){try{await session.execute({tool:'navigate',path});await session.page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>{});results.push({path:new URL(session.page.url()).pathname,accountId:identity==='guest'?undefined:identity,text:await session.refreshObservation(),observedAt:new Date().toISOString()});}catch{/* Unavailable routes remain explicit coverage gaps in discovery. */}}
    return results;
   }catch{return [];}finally{await session?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
  }))).flat();
 }
 return {statePath,load,save,authenticate,observe,privateValues};
}
