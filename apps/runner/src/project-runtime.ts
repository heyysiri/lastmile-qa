import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,cp,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import Database from 'better-sqlite3';
import type {DiscoverProject,Project,ProjectSecrets,ProjectRun,ProjectHistory,ProjectJourney,ProjectTester,ProjectTesterResult,ProjectCheckResult,ProjectRuntime,RepositoryIndex} from '@lastmile/contracts/projects';
import {createBrowserSession,replayPosition,type BrowserSession} from './browser';
import {runAgent} from './agent';
import {hashValue,writeArtifactManifest} from './artifacts';
import {classifyOutcome} from './outcome';
import {scanRepository} from './repository-index';
import {captureProjectChecks,verifyProjectChecks} from './project-verifier';
import {createProjectSessions,projectActorRun} from './project-sessions';
import {createRepositoryBrain} from './project-brain';
import {createProjectRepairRuntime} from './project-repair';

type Options={privateRoot:string;artifactRoot:string;apiKey?:string;model:string;discover?:DiscoverProject;actor?:typeof runAgent};
export function createProjectRuntime(options:Options):ProjectRuntime&{replay:(project:Project,secrets:ProjectSecrets,source:ProjectRun,sessionRoot:string)=>Promise<ProjectRun>}{
 const sessions=createProjectSessions(options),actor=options.actor??runAgent;
 const discover=options.discover??createRepositoryBrain({apiKey:options.apiKey,model:options.model,observe:sessions.observe});
 async function snapshot(project:Project,run:ProjectRun,index:RepositoryIndex){
  const directory=join(options.privateRoot,'snapshots',run.id);await mkdir(join(directory,'sessions'),{recursive:true,mode:0o700});
  await writeFile(join(directory,'source-manifest.json'),JSON.stringify({version:index.version,files:index.files.map(({path,hash})=>({path,hash}))}),{mode:0o600});
  const stateRoot=join(options.privateRoot,'sessions',project.id);await cp(stateRoot,join(directory,'sessions'),{recursive:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
  async function contained(path:string){const root=await realpath(project.repositoryPath),file=await realpath(resolve(root,path));if(!file.startsWith(root+sep))throw new Error('Private snapshot input escaped the development repository');return file;}
  if(project.commands?.databasePath){const db=new Database(await contained(project.commands.databasePath),{readonly:true});try{await db.backup(join(directory,'database.sqlite'));}finally{db.close();}}
  const files=[];for(const path of project.commands?.runtimeFiles??[])files.push({path,contentBase64:(await readFile(await contained(path))).toString('base64')});
  await writeFile(join(directory,'runtime-files.json'),JSON.stringify({files}),{mode:0o600});
 }
 function summary(run:ProjectRun){
  run.findings=run.results.flatMap(r=>r.finding?[r.finding]:[]);
  run.metrics.passed=run.results.filter(r=>r.run.verdict==='passed').length;run.metrics.failed=run.results.filter(r=>r.run.verdict==='failed').length;run.metrics.inconclusive=run.results.filter(r=>r.run.verdict==='inconclusive').length;
  run.metrics.browserActions=run.results.reduce((n,r)=>n+(r.run.evidence?.actions.length??0),0);
  run.summary=run.metrics.failed?`${run.metrics.failed} journey${run.metrics.failed===1?' needs':'s need'} attention. ${run.metrics.passed} passed the independent checks.`:run.metrics.inconclusive?`${run.metrics.inconclusive} journey${run.metrics.inconclusive===1?' needs':'s need'} more evidence. ${run.metrics.passed} passed.`:`All ${run.metrics.passed} journeys passed their independent checks.`;
 }
 async function testJourney(project:Project,secrets:ProjectSecrets,tester:ProjectTester,input:ProjectJourney,history:ProjectHistory[],sourceVersion:string,onProgress:()=>void,original?:ProjectTesterResult,sessionRoot?:string):Promise<ProjectTesterResult>{
  const journey=structuredClone(input),run=projectActorRun(journey.goal,journey.entryPath,journey.inputs,tester.context);
  run.scenario.id=journey.id;run.scenario.label=journey.title;run.executionMode=original?'deterministic':'ai_guided';
  run.continuity={populationId:project.id,testerId:tester.id,mode:'continue',initialStateId:'native-session',workflowId:journey.id,preserveStatePaths:[],history:history.filter(h=>h.testerId===tester.id).slice(0,3).map(h=>({runId:h.runId,buildId:'observed-history',goal:h.goal,observation:h.observations.join('\n'),recordedAt:h.createdAt}))};
  run.evidence={buildId:sourceVersion,scenarioHash:hashValue(journey),policyVersion:'project-ui-v1',model:original?'none':options.model,modelCalls:0,actions:[],finishedByAgent:false,...(original?{replayCompatible:false}: {})};
  const directory=join(options.artifactRoot,run.id);await mkdir(directory,{recursive:true});
  const identity=tester.accountId??tester.id,stored=await sessions.load(project,identity,sessionRoot);let session:BrowserSession|undefined,complete=false,message='';let checks:ProjectCheckResult[]=[];
  const signal=AbortSignal.timeout(180000);
  try{
   session=await createBrowserSession({pack:tester.context,inputs:journey.inputs,origin:project.appUrl,allowedOrigins:project.allowedOrigins,storageState:stored,redactValues:sessions.privateValues(secrets),artifactDirectory:directory,signal,onStep:step=>{run.steps.push({...step,screenshot:step.screenshot?`${run.id}/${step.screenshot}`:undefined});onProgress();}});
   if(original){
    // Repair receives private copies of the before-run sessions and frozen values. No agent participates.
    const actions=original.run.evidence?.actions;if(!actions?.length)throw new Error('Recorded browser actions are unavailable');
    for(const recorded of actions){
     if(recorded.action.tool!=='navigate'){
      await session.refreshObservation();const position=await replayPosition(session.page);
      if(recorded.urlBefore&&position.url!==recorded.urlBefore)throw new Error('Replay reached a different page');
      if(recorded.action.tool==='pressKey'&&recorded.focusBefore&&position.focus!==recorded.focusBefore)throw new Error('Replay keyboard focus changed');
     }
     await session.execute(recorded.action);
    }
    complete=true;run.evidence.replayCompatible=true;
   }else{
    journey.checks=await captureProjectChecks(session.page,journey.checks,new URL(project.appUrl).origin,signal);
    await session.execute({tool:'navigate',path:journey.entryPath});
    const result=await actor(session,run,{apiKey:options.apiKey,model:options.model,signal});
    complete=result.finished;message=result.reason;run.evidence.modelCalls=result.modelCalls;run.evidence.finishedByAgent=result.finished;
   }
   checks=await verifyProjectChecks(session.page,journey.checks,new URL(project.appUrl).origin,signal);
   await sessions.save(project,identity,await session.storageState(),sessionRoot);
  }catch(error){complete=false;message=error instanceof Error?error.message:'Browser execution unavailable';}
  finally{if(session){run.evidence.actions=structuredClone(session.actions);run.capabilities=structuredClone(session.capabilities);await session.close().catch(()=>{complete=false;message='Browser evidence could not be saved';});}}
  if(!checks.length)checks=journey.checks.map(c=>({id:c.id,label:c.label,basis:c.basis,phase:c.phase,sources:c.sources,expected:c.expected,status:'not_evaluated',message:'The journey did not reach independent verification'}));
  // Accounts never appear in public checks, history or provider inputs.
  const redact=(value:string)=>sessions.privateValues(secrets).filter(Boolean).reduce((text,secret)=>text.replaceAll(secret,'[private]'),value);
  checks=checks.map(c=>({...c,actual:typeof c.actual==='string'?redact(c.actual):c.actual,expected:typeof c.expected==='string'?redact(c.expected):c.expected}));
  run.assertions=checks;run.status='completed';run.finishedAt=new Date().toISOString();run.verdict=classifyOutcome(checks,complete);
  const failed=checks.filter(c=>c.status==='failed'),result:ProjectTesterResult={tester,journey,run,checks,sessionContinued:Boolean(stored)};
  if(run.verdict!=='passed'){
   const description=run.verdict==='inconclusive'?redact(message||'One or more independent checks could not be evaluated.'):failed.map(c=>`${c.label}: expected ${JSON.stringify(c.expected)}, observed ${JSON.stringify(c.actual)??'unavailable'}.`).join(' ');
   result.finding={id:randomUUID(),testerId:tester.id,journeyId:journey.id,title:run.verdict==='inconclusive'?`${tester.name} needs more evidence`:failed[0].label,description,confidence:run.verdict==='inconclusive'?'inconclusive':failed.every(c=>c.basis!=='implementation'&&c.actual!==undefined&&c.actual!==false)?'confirmed':'suspected',impact:journey.reason,sources:failed.length?failed.flatMap(c=>c.sources):journey.sources,failedCheckIds:failed.map(c=>c.id)};
   run.findings=[{kind:run.verdict==='inconclusive'?(original?'replay_mismatch':'agent_error'):'functional_failure',description,evidencePaths:[`${run.id}/assertions.json`]}];
  }
  await writeFile(join(directory,'assertions.json'),JSON.stringify(checks,null,2));await writeFile(join(directory,'run.json'),JSON.stringify(run,null,2));
  const manifest=await writeArtifactManifest(directory);run.artifactManifestHash=hashValue(manifest);run.artifacts=manifest.map(a=>`${run.id}/${a.name}`);
  return result;
 }
 async function execute(project:Project,secrets:ProjectSecrets,input:ProjectRun,history:ProjectHistory[],onUpdate:(run:ProjectRun)=>void){
  const started=Date.now(),run=structuredClone(input);const index=await scanRepository(project.repositoryPath);
  let discovery=project.discovery;
  if(!discovery||input.request.mode==='release'||discovery.index.version!==index.version){run.phase='Refreshing the application map';onUpdate(run);discovery=await discover(project,secrets,message=>{run.phase=message;onUpdate(run);},discovery);run.metrics.modelCalls+=discovery.modelCalls;}
  run.discovery=discovery;run.sourceVersion=discovery.index.version;
  if(index.version!==discovery.index.version)throw new Error('Source changed while the test team was prepared; run again after the edit completes');
  await Promise.all(discovery.plan.testers.map(async tester=>{const auth=await sessions.authenticate(project,secrets,tester.accountId??tester.id);run.metrics.modelCalls+=auth.modelCalls;}));
  await snapshot(project,run,index);run.phase='Your testers are exploring';onUpdate(run);
  // Independent routes run together. A shared entry is serialized to avoid changing the same screen/entity concurrently.
  const lanes=new Map<string,Promise<unknown>>();
  await Promise.all(discovery.plan.journeys.map(journey=>{
   const work=(lanes.get(journey.entryPath)??Promise.resolve()).then(async()=>{const tester=discovery!.plan.testers.find(t=>t.id===journey.testerId)!;const result=await testJourney(project,secrets,tester,journey,history,index.version,()=>{});run.results.push(result);run.metrics.modelCalls+=result.run.evidence?.modelCalls??0;summary(run);onUpdate(structuredClone(run));});lanes.set(journey.entryPath,work);return work;
  }));
  run.results.sort((a,b)=>discovery!.plan.journeys.findIndex(j=>j.id===a.journey.id)-discovery!.plan.journeys.findIndex(j=>j.id===b.journey.id));
  if((await scanRepository(project.repositoryPath)).version!==index.version){for(const result of run.results){result.run.verdict='inconclusive';if(result.finding)result.finding.confidence='inconclusive';}run.error='Repository changed during execution; these results cannot establish a product regression';}
  run.status='completed';run.phase='Results ready';run.finishedAt=new Date().toISOString();run.metrics.elapsedMs=Date.now()-started;summary(run);return run;
 }
 async function replay(project:Project,secrets:ProjectSecrets,source:ProjectRun,sessionRoot:string){
  const run:ProjectRun={...structuredClone(source),id:randomUUID(),results:[],findings:[],status:'running',error:undefined,metrics:{elapsedMs:0,modelCalls:0,browserActions:0,passed:0,failed:0,inconclusive:0}};const start=Date.now();
  // Session storage origins include ports, unlike cookies. Rebind only the original app origin in the private snapshot.
  for(const tester of source.discovery?.plan.testers??source.results.map(r=>r.tester)){const identity=tester.accountId??tester.id,state=await sessions.load(project,identity,sessionRoot);if(state){const sourceOrigin=new URL(source.results[0]?.run.evidence?.actions.find(a=>a.action.tool==='navigate')?.url??project.appUrl).origin;for(const item of state.origins)if(item.origin===sourceOrigin)item.origin=new URL(project.appUrl).origin;await sessions.save(project,identity,state,sessionRoot);}}
  for(const original of source.results)run.results.push(await testJourney(project,secrets,original.tester,original.journey,[],source.sourceVersion!,()=>{},original,sessionRoot));
  run.status='completed';run.phase='Frozen checks replayed';run.finishedAt=new Date().toISOString();run.metrics.elapsedMs=Date.now()-start;summary(run);return run;
 }
 const repair=createProjectRepairRuntime({workspaceRoot:join(options.privateRoot,'repairs'),privateRoot:options.privateRoot,apiKey:options.apiKey,model:options.model,replay});
 return {discover,execute,replay,repair};
}
