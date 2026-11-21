import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {ContextPack} from '@lastmile/contracts';
import type {EvidenceRun} from '@lastmile/contracts/runtime';
import type {Project,ProjectSecrets,ProjectObservation} from '@lastmile/contracts/projects';
import {createBrowserSession,routeIdentity,type BrowserSession} from './browser';
import {runAgent} from './agent';
import {hashValue} from './artifacts';

export const projectBrowserContext:ContextPack={id:'project-browser',revision:1,label:'Application browser',viewport:{width:1440,height:1000},locale:'en-US',preferredLanguage:'English',familiarity:'experienced',knownTerms:[],interaction:'pointer',reducedMotion:'no-preference',network:{mode:'normal'},inputs:{}};
export function projectActorRun(goal:string,entryPath:string,inputs:EvidenceRun['inputs'],context:ContextPack=projectBrowserContext):EvidenceRun {
 const id=randomUUID();return {id,requestId:id,scenario:{id,revision:1,label:'Application journey',goal,entryPath,initialStateId:'native-session',inputSlots:Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,{type:typeof value==='number'?'number':typeof value==='boolean'?'boolean':'text',required:true}])),contract:{scope:'ui_only',assertions:[{id:'independent-checks',kind:'visible',locator:{by:'role',value:'main'}}]},investigation:{factors:[],maxAttempts:4}},context,inputs,status:'running',verdict:null,createdAt:new Date().toISOString(),manifestHash:hashValue({goal,inputs}),executionMode:'ai_guided',steps:[],assertions:[],findings:[],capabilities:[],artifacts:[]};
}
type Options={privateRoot:string;apiKey?:string;model:string;actor?:typeof runAgent};
async function hasSignedInEvidence(session:BrowserSession,account:ProjectSecrets['accounts'][number],origin:string){
 const {page}=session;
 const signOut=/^(?:sign|log)[ -]?out$/i;
 const evidence=page.getByRole('button',{name:signOut}).or(page.getByRole('link',{name:signOut}))
  .or(page.getByRole('button',{name:/^(?:account menu|my account|your account)$/i}))
  .or(page.getByRole('heading',{name:`${account.label} home`,exact:true}))
  .or(page.getByText(account.username,{exact:true}));
 try{
  await evidence.filter({visible:true}).first().waitFor({state:'visible',timeout:1500});
  return new URL(page.url()).origin===origin&&!await page.locator('input[type="password"]:visible').count();
 }catch{return false;}
}

async function expandNavigation(session:BrowserSession){
 const toggles=session.page.locator('button[aria-expanded="false"][aria-controls]:not([aria-haspopup], [type="submit" i], [form], main *, [role="main"] *, form *)').filter({visible:true});
 for(const toggle of (await toggles.elementHandles()).slice(0,8)){
  if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click({timeout:800}).catch(()=>{});
 }
}

export function createProjectSessions(options:Options){
 const actor=options.actor??runAgent;
 const statePath=(project:Project,identity:string,root?:string)=>join(root??join(options.privateRoot,'sessions',project.id),`${identity}.json`);
 async function load(project:Project,identity:string,root?:string){try{return JSON.parse(await readFile(statePath(project,identity,root),'utf8')) as Awaited<ReturnType<BrowserSession['storageState']>>;}catch{return undefined;}}
 async function save(project:Project,identity:string,state:Awaited<ReturnType<BrowserSession['storageState']>>,root?:string){const path=statePath(project,identity,root);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(state),{mode:0o600});}
 const privateValues=(secrets:ProjectSecrets)=>secrets.accounts.flatMap(a=>[a.username,a.password]);
 async function authenticate(project:Project,secrets:ProjectSecrets,identity:string,sessionRoot?:string,allowModel=true){
  const account=secrets.accounts.find(a=>a.id===identity),stored=await load(project,identity,sessionRoot);
  if(!account){const verified=!project.accounts.some(a=>a.id===identity);return {verified,state:verified?stored:undefined,continued:verified&&Boolean(stored),modelCalls:0};}
  const directory=join(options.privateRoot,'authentication',randomUUID()),signal=AbortSignal.timeout(90000);
  const entryPath=routeIdentity(project.appUrl),origin=new URL(project.appUrl).origin;let session:BrowserSession|undefined,modelCalls=0;
  const unverified=()=>({verified:false,state:undefined,continued:false,modelCalls});
  const open=(storageState:typeof stored)=>createBrowserSession({pack:projectBrowserContext,inputs:{accountUsername:account.username,accountPassword:account.password},origin,allowedOrigins:project.allowedOrigins,storageState,redactValues:privateValues(secrets),artifactDirectory:directory,signal,onStep:()=>{}});
  try{
   session=await open(stored);
   await session.execute({tool:'navigate',path:entryPath});
   const continued=Boolean(stored)&&await hasSignedInEvidence(session,account,origin);
   if(!continued){
    if(!allowModel)return unverified();
    const login=projectActorRun('Sign in to this application using accountUsername and accountPassword. Stop when the signed-in application is visible. Do not change any business data.',entryPath,{accountUsername:'[private account input]',accountPassword:'[private password input]'});
    const result=await actor(session,login,{apiKey:options.apiKey,model:options.model,signal});modelCalls=result.modelCalls;
    if(!result.finished||signal.aborted||!await hasSignedInEvidence(session,account,origin))return unverified();
    const destination=routeIdentity(session.page.url()),state=await session.storageState();
    // Journeys start in a new browser. Require the sign-in evidence to survive restoration.
    await session.close();
    session=await open(state);
    await session.execute({tool:'navigate',path:destination});
    if(!await hasSignedInEvidence(session,account,origin))return unverified();
   }
   const state=await session.storageState();await save(project,identity,state,sessionRoot);
   return {verified:true,state,continued,modelCalls};
  }catch{return unverified();}finally{await session?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
 }
 async function observe(project:Project,secrets:ProjectSecrets,paths:string[]):Promise<ProjectObservation[]>{
  const identities=project.accounts.length?project.accounts.map(a=>a.id):['guest'];
  const results:ProjectObservation[]=[];
  // Development apps may share a single-writer database across all accounts.
  for(const identity of identities){
   const directory=join(options.privateRoot,'observations',randomUUID());let session:BrowserSession|undefined;
   try{const auth=await authenticate(project,secrets,identity);if(!auth.verified)continue;session=await createBrowserSession({pack:projectBrowserContext,inputs:{},origin:project.appUrl,allowedOrigins:project.allowedOrigins,storageState:auth.state,redactValues:privateValues(secrets),artifactDirectory:directory,signal:AbortSignal.timeout(60000),onStep:()=>{}});
    for(const path of paths.slice(0,12)){
     try{
      await session.execute({tool:'navigate',path});
      await session.page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>{});
      await expandNavigation(session);
      const text=await session.refreshObservation();
      results.push({path:routeIdentity(session.page.url()),requestedPath:path,accountId:identity==='guest'?undefined:identity,text,observedAt:new Date().toISOString()});
     }catch{/* Unavailable routes remain explicit coverage gaps in discovery. */}
    }
   }catch{/* This account stays an explicit coverage gap. */}finally{await session?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
  }
  return results;
 }
 return {statePath,load,save,authenticate,observe,privateValues};
}
