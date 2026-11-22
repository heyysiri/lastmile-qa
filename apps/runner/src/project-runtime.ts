import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,cp,realpath,rm,readdir,rename} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import Database from 'better-sqlite3';
import {setTimeout as pause} from 'node:timers/promises';
import type {ProjectStageEvidence,RecordedAction} from '@lastmile/contracts/runtime';
import {MAX_PROJECT_JOURNEYS,MAX_PROJECT_TESTERS} from '@lastmile/contracts/projects';
import type {DiscoverProject,Project,ProjectSecrets,ProjectRun,ProjectHistory,ProjectJourney,ProjectTester,ProjectTesterResult,ProjectCheck,ProjectCheckResult,ProjectDiscovery,ProjectRuntime,RepositoryIndex,SourceReference} from '@lastmile/contracts/projects';
import {createBrowserSession,routeIdentity,type BrowserSession} from './browser';
import {runAgent} from './agent';
import {hashValue,writeArtifactManifest} from './artifacts';
import {classifyOutcome} from './outcome';
import {scanRepository,sourceReference,repositorySourceKind} from './repository-index';
import {captureProjectChecks,verifyProjectChecks} from './project-verifier';
import {createProjectSessions,projectActorRun} from './project-sessions';
import {createRepositoryBrain} from './project-brain';
import {createProjectRepairRuntime} from './project-repair';

type Options={privateRoot:string;artifactRoot:string;apiKey?:string;model:string;discover?:DiscoverProject;actor?:typeof runAgent};
type PreparedJourney={journey:ProjectJourney;unavailable:Map<string,string>;blocked?:string};
const containsPrivateValue=(value:unknown,privateValues:string[])=>typeof value==='string'&&privateValues.some(secret=>value.includes(secret));

function currentSourceCheck(project:Project,index:RepositoryIndex){
 const files=new Map(index.files.map(file=>[file.path,file.hash]));
 const textSources=new Map([['$brief',project.brief],['$requirements',project.requirements]]);
 return (ref:SourceReference)=>{
  const text=textSources.get(ref.path);
  if(text===undefined)return files.get(ref.path)===ref.hash;
  try{return hashValue(sourceReference(ref.path,hashValue(text),text,ref.startLine,ref.endLine))===hashValue(ref);}
  catch{return false;}
 };
}

function releaseDiscovery(fresh:ProjectDiscovery,prior:ProjectTesterResult[],isCurrent:(check:ProjectCheck)=>boolean):ProjectDiscovery {
 const journeys=prior.map(r=>r.journey),testers=new Map(prior.map(r=>[r.tester.id,r.tester]));
 const ids=new Set(journeys.map(j=>j.id));
 // Ignore presentation and a prior run's captured value when comparing coverage.
 const coverage=({testerId,entryPath,goal,inputs,checks,stages}:ProjectJourney)=>hashValue({testerId,entryPath,goal,inputs,stages,checks:checks.map(({kind,locator,phase,path,expected,atStageStart})=>hashValue({kind,locator,phase,path,atStageStart,expected:phase==='preserve'?undefined:expected??(kind==='visible'?true:undefined)})).sort()});
 const covered=new Set(journeys.filter(j=>j.checks.every(c=>isCurrent(c)&&(c.phase!=='preserve'||c.expected!==undefined))).map(coverage));
 let omitted=0;
 for(const journey of fresh.plan.journeys){
  const key=coverage(journey);
  if(covered.has(key))continue;
  if(journeys.length>=MAX_PROJECT_JOURNEYS||(!testers.has(journey.testerId)&&testers.size>=MAX_PROJECT_TESTERS)){omitted++;continue;}
  const tester=fresh.plan.testers.find(t=>t.id===journey.testerId)!;
  if(!testers.has(tester.id))testers.set(tester.id,tester);
  let id=journey.id;
  for(let n=2;ids.has(id);n++)id=`${journey.id.slice(0,76)}-${n}`;
  ids.add(id);covered.add(key);journeys.push({...journey,id});
 }
 const gaps=omitted?[`${omitted} newly discovered ${omitted===1?'journey was':'journeys were'} omitted because prior coverage filled the configured team or journey limit.`,...fresh.plan.gaps].slice(0,15):fresh.plan.gaps;
 return {...fresh,plan:{...fresh.plan,testers:[...testers.values()],journeys,gaps}};
}

function notEvaluated({id,label,basis,phase,sources,expected,atStageStart}:ProjectCheck,message:string):ProjectCheckResult {
 return {id,label,basis,phase,sources,expected,...(atStageStart?{atStageStart}:{}),status:'not_evaluated',message};
}

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
 async function prepareJourney(project:Project,tester:ProjectTester,input:ProjectJourney,unavailable:Map<string,string>,verified:boolean,privateValues:string[]):Promise<PreparedJourney>{
  const prepared={journey:structuredClone(input),unavailable};
  if(!verified)return {...prepared,blocked:'The development account could not be verified as signed in'};
  if(unavailable.size===input.checks.length)return {...prepared,blocked:'The prior coverage could not be evaluated'};
  const needsCapture=input.checks.filter(c=>c.phase==='preserve'&&c.expected===undefined&&!unavailable.has(c.id));
  if(!needsCapture.length)return prepared;
  const directory=join(options.privateRoot,'captures',randomUUID()),signal=AbortSignal.timeout(180000);
  let session:BrowserSession|undefined;
  try{
   const stored=await sessions.loadPersona(project,tester);
   session=await createBrowserSession({pack:tester.context,inputs:{},origin:project.appUrl,allowedOrigins:project.allowedOrigins,storageState:stored,redactValues:privateValues,artifactDirectory:directory,signal,onStep:()=>{}});
   const captured=await captureProjectChecks(session.page,needsCapture,new URL(project.appUrl).origin,signal);
   for(const check of captured){
    if(containsPrivateValue(check.expected,privateValues)){
     unavailable.set(check.id,'The preserved value contains private account data');
    }else prepared.journey.checks[prepared.journey.checks.findIndex(c=>c.id===check.id)]=check;
   }
   if(unavailable.size===input.checks.length)return {...prepared,blocked:'The preserved state could not be evaluated'};
   return prepared;
  }catch(error){return {...prepared,blocked:error instanceof Error?error.message:'Could not capture preserved state'};}
  finally{await session?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
 }
 async function testJourney(project:Project,secrets:ProjectSecrets,tester:ProjectTester,{journey,unavailable,blocked}:PreparedJourney,history:ProjectHistory[],sourceVersion:string,original?:ProjectTesterResult,sessionRoot?:string):Promise<ProjectTesterResult>{
  const run=projectActorRun(journey.goal,journey.entryPath,journey.inputs,tester.context);
  run.scenario.id=journey.id;run.scenario.label=journey.title;run.executionMode=original?'deterministic':'ai_guided';
  run.continuity={populationId:project.id,testerId:tester.id,mode:'continue',initialStateId:'native-session',workflowId:journey.id,preserveStatePaths:[],history:history.filter(h=>h.testerId===tester.id).slice(0,3).map(h=>({runId:h.runId,buildId:'observed-history',goal:h.goal,observation:h.observations.join('\n'),recordedAt:h.createdAt}))};
  run.evidence={buildId:sourceVersion,scenarioHash:hashValue(journey),policyVersion:'project-ui-v1',model:original?'none':options.model,modelCalls:0,actions:[],finishedByAgent:false,...(original?{replayCompatible:false}: {})};
  const directory=join(options.artifactRoot,run.id);await mkdir(directory,{recursive:true});
  const identity=sessions.personaIdentity(tester),stored=await sessions.loadPersona(project,tester,sessionRoot);let session:BrowserSession|undefined,complete=false,message='';let checks:ProjectCheckResult[]=[];
  const signal=AbortSignal.timeout(180000),privateValues=sessions.privateValues(secrets).filter(Boolean);
  const completedActions:RecordedAction[]=[];
  let storage=stored,segment=0,segmentDirectory=directory,segmentPrefix='';
  const actionCount=()=>completedActions.length+(session?.actions.length??0);
  const open=async(network:ProjectTester['context']['network'])=>{
   segmentPrefix=journey.stages?`visit-${++segment}-`:'';
   segmentDirectory=journey.stages?join(directory,`visit-${segment}`):directory;
   await mkdir(segmentDirectory,{recursive:true});
   session=await createBrowserSession({pack:{...tester.context,network},inputs:journey.inputs,origin:project.appUrl,allowedOrigins:project.allowedOrigins,storageState:storage,redactValues:privateValues,artifactDirectory:segmentDirectory,signal,actionLimit:40-run.steps.length,onStep:step=>{run.steps.push({...step,index:run.steps.length+1,screenshot:step.screenshot?`${run.id}/${segmentPrefix}${step.screenshot}`:undefined});}});
  };
  const close=async()=>{
   if(!session)return;
   const closing=session;session=undefined;
   completedActions.push(...structuredClone(closing.actions));
   run.capabilities.push(...structuredClone(closing.capabilities));
   await closing.close();
   if(segmentPrefix){
    for(const name of await readdir(segmentDirectory))if(name!=='trace.zip')await rename(join(segmentDirectory,name),join(directory,segmentPrefix+name));
    await rm(segmentDirectory,{recursive:true,force:true});
   }
  };
  const replayActions=async(actions:RecordedAction[])=>{
   for(const recorded of actions){
    const versioned=recorded.routeVersion===2,navigation=recorded.action.tool==='navigate';
    if(!navigation)await session!.refreshObservation();
    if(versioned||!navigation){
     const position=await session!.inspectReplayPosition(),current=versioned?position.url:new URL(session!.page.url()).pathname;
     if(recorded.urlBefore&&current!==recorded.urlBefore)throw new Error('Replay reached a different page before an action');
     if(recorded.action.tool==='pressKey'&&recorded.focusBefore&&position.focus!==recorded.focusBefore)throw new Error('Replay keyboard focus changed');
    }
    await session!.execute(recorded.action);
    if(versioned&&(await session!.inspectReplayPosition()).url!==routeIdentity(recorded.url))throw new Error('Replay reached a different page after an action');
   }
  };
  const verify=async(selected:ProjectCheck[])=>{
   checks.push(...await verifyProjectChecks(session!.page,selected.filter(c=>!unavailable.has(c.id)),new URL(project.appUrl).origin,signal));
  };
  try{
   if(blocked)throw new Error(blocked);
   if(journey.stages){
    const traces=original?.run.evidence?.stages,actions=original?.run.evidence?.actions;
    let expectedStart=0,network=tester.context.network;
    if(original){
     if(!traces||traces.length!==journey.stages.length||!actions?.length)throw new Error('Recorded stage transitions are unavailable');
     for(const [i,stage] of journey.stages.entries()){
      const trace=traces[i];network=stage.network??network;
      if(trace.id!==stage.id||trace.transition!==stage.transition||hashValue(trace.network)!==hashValue(network)||trace.pauseMs!==(stage.pauseMs??0)||!trace.completed||!Number.isInteger(trace.entryActionEnd)||trace.entryActionEnd<trace.actionStart||trace.entryActionEnd>trace.actionEnd||trace.actionStart!==expectedStart||!Number.isInteger(trace.actionEnd)||trace.actionEnd>actions.length)throw new Error('Recorded stage transitions do not match the frozen journey');
      expectedStart=trace.actionEnd;
     }
     if(expectedStart!==actions.length)throw new Error('Recorded actions are outside their stages');
    }
    network=tester.context.network;run.evidence.stages=[];
    for(const [i,stage] of journey.stages.entries()){
     signal.throwIfAborted();
     if(!original&&run.evidence.modelCalls>=20)throw new Error('Journey model call budget exhausted');
     network=stage.network??network;
     let destination=stage.entryPath;
     if(session&&stage.transition==='reopen'){
      destination??=routeIdentity(session.page.url());storage=await session.storageState();await close();
     }
     if(stage.pauseMs)await pause(stage.pauseMs,undefined,{signal});
     if(!session)await open(network);else await session.setConnectivity(network);
     const trace:ProjectStageEvidence={id:stage.id,transition:stage.transition,network:structuredClone(network),pauseMs:stage.pauseMs??0,actionStart:actionCount(),entryActionEnd:actionCount(),actionEnd:actionCount(),modelCalls:0,completed:false};
     run.evidence.stages.push(trace);
     try{
      if(original){const frozen=traces![i];await replayActions(actions!.slice(frozen.actionStart,frozen.entryActionEnd));}
      else if(i===0||stage.transition==='reopen'||destination)await session!.execute({tool:'navigate',path:destination??journey.entryPath});
      trace.entryActionEnd=actionCount();
      const entryUrl=routeIdentity(session!.page.url());
      await verify(journey.checks.filter(c=>c.atStageStart===stage.id));
      if(original){const frozen=traces![i];await replayActions(actions!.slice(frozen.entryActionEnd,frozen.actionEnd));trace.completed=true;}
      else{
       // Readback checks may visit another record; restore the actor's entry without hiding a failed entry check.
       if(routeIdentity(session!.page.url())!==entryUrl)await session!.execute({tool:'navigate',path:entryUrl});
       const episode={...run,scenario:{...run.scenario,goal:stage.goal},context:{...run.context,network}};
       const result=await actor(session!,episode,{apiKey:options.apiKey,model:options.model,signal,modelCallLimit:20-run.evidence.modelCalls});
       trace.modelCalls=result.modelCalls;run.evidence.modelCalls+=result.modelCalls;trace.completed=result.finished;message=result.reason;
       if(!result.finished)throw new Error(result.reason||'The stage did not finish');
      }
     }finally{trace.actionEnd=actionCount();}
    }
    complete=true;run.evidence.finishedByAgent=!original;
    if(original)run.evidence.replayCompatible=true;
    await verify(journey.checks.filter(c=>!c.atStageStart));
   }else{
    await open(tester.context.network);
    if(original){
     const actions=original.run.evidence?.actions;if(!actions?.length||original.run.evidence?.stages)throw new Error('Recorded browser actions are unavailable');
     await replayActions(actions);complete=true;run.evidence.replayCompatible=true;
    }else{
     await session!.execute({tool:'navigate',path:journey.entryPath});
     const result=await actor(session!,run,{apiKey:options.apiKey,model:options.model,signal});
     complete=result.finished;message=result.reason;run.evidence.modelCalls=result.modelCalls;run.evidence.finishedByAgent=result.finished;
    }
    await verify(journey.checks);
   }
   await sessions.save(project,identity,await session!.storageState(),sessionRoot);
  }catch(error){complete=false;if(original)run.evidence.replayCompatible=false;message=error instanceof Error?error.message:'Browser execution unavailable';}
  finally{
   await close().catch(()=>{complete=false;if(original)run.evidence!.replayCompatible=false;message='Browser evidence could not be saved';});
   run.evidence.actions=completedActions;
  }
  const redact=(value:string)=>privateValues.reduce((text,secret)=>text.replaceAll(secret,'[private]'),value);
  checks=journey.checks.map(c=>{
   const result=checks.find(check=>check.id===c.id);
   if(containsPrivateValue(result?.actual,privateValues))return notEvaluated(c,'The observed value contains private account data');
   return result??notEvaluated(c,unavailable.get(c.id)??redact(blocked??'The journey did not reach independent verification'));
  });
  run.assertions=checks;run.status='completed';run.finishedAt=new Date().toISOString();run.verdict=classifyOutcome(checks,complete);
  const failed=checks.filter(c=>c.status==='failed'),result:ProjectTesterResult={tester,journey,run,checks,sessionContinued:!blocked&&Boolean(stored)};
  if(run.verdict!=='passed'){
   const description=run.verdict==='inconclusive'?redact(message||'One or more independent checks could not be evaluated.'):failed.map(c=>`${c.label}: expected ${JSON.stringify(c.expected)}, observed ${JSON.stringify(c.actual)??'unavailable'}.`).join(' ');
   result.finding={id:randomUUID(),testerId:tester.id,journeyId:journey.id,title:run.verdict==='inconclusive'?`${tester.name} needs more evidence`:failed[0].label,description,confidence:run.verdict==='inconclusive'?'inconclusive':failed.every(c=>c.basis!=='implementation'&&c.actual!==undefined&&c.actual!==false)?'confirmed':'suspected',impact:journey.reason,sources:failed.length?failed.flatMap(c=>c.sources):journey.sources,failedCheckIds:failed.map(c=>c.id)};
   run.findings=[{kind:run.verdict==='inconclusive'?(original?'replay_mismatch':'agent_error'):'functional_failure',description,evidencePaths:[`${run.id}/assertions.json`]}];
  }
  await writeFile(join(directory,'assertions.json'),JSON.stringify(checks,null,2));await writeFile(join(directory,'run.json'),JSON.stringify(run,null,2));
  const manifest=await writeArtifactManifest(directory);run.artifactManifestHash=hashValue(manifest);run.artifacts=manifest.map(a=>`${run.id}/${a.name}`);
  return result;
 }
 async function execute(project:Project,secrets:ProjectSecrets,input:ProjectRun,history:ProjectHistory[],onUpdate:(run:ProjectRun)=>void,previousRun?:ProjectRun){
  const started=Date.now(),run=structuredClone(input);const index=await scanRepository(project.repositoryPath);
  const prior=input.request.mode==='release'?(previousRun?.results??[]):[];
  const retain=project.github?.coverageMode==='retain'&&input.request.mode==='release'&&prior.length>0;
  const verifiedTransition=retain&&previousRun?.status==='completed'&&!previousRun.error&&
   project.github?.verifiedCoverageRunId===previousRun.id&&previousRun.revision!==project.github.sha;
  const unchangedRevision=retain&&previousRun?.status==='completed'&&!previousRun.error&&
   previousRun.sourceVersion===index.version&&previousRun.revision===project.github?.sha;
  const evaluatedChecks=new Set((verifiedTransition||unchangedRevision)?prior.flatMap(result=>result.journey.checks
   .filter(check=>result.checks.some(outcome=>outcome.id===check.id&&outcome.status!=='not_evaluated')).map(check=>hashValue(check))):[]);
  const privateValues=sessions.privateValues(secrets).filter(Boolean);
  const isCurrent=currentSourceCheck(project,index);
  const currentCheck=(check:ProjectCheck)=>{
   const basisSources=check.sources.filter(ref=>{
    const kind=ref.path==='$brief'||ref.path==='$requirements'?'requirement':repositorySourceKind(ref.path);
    return check.basis==='implementation'?kind==='code'||kind==='config':kind===check.basis;
   });
   return basisSources.length>0&&(basisSources.every(isCurrent)||(check.basis==='implementation'&&evaluatedChecks.has(hashValue(check))&&
    basisSources.every(ref=>index.files.some(file=>file.path===ref.path&&(file.kind==='code'||file.kind==='config')))));
  };
  if(prior.some(r=>r.journey.checks.some(c=>containsPrivateValue(c.expected,privateValues))))
   throw new Error('Prior coverage contains a private account value and cannot be published');
  let discovery=project.discovery;
  if(retain&&discovery){
   const previous=previousRun?.discovery??discovery;
   discovery={...previous,index:{version:index.version,sourceLines:index.sourceLines,excludedFiles:index.excludedFiles,indexedAt:index.indexedAt,changedPaths:index.changedPaths,fileCount:index.files.length},plan:{...previous.plan,journeys:[]},observations:[],modelCalls:0};
  }else if(!discovery||input.request.mode==='release'||discovery.index.version!==index.version){
   run.phase='Refreshing the application map';onUpdate(run);
   try{
    discovery=await discover(project,secrets,message=>{run.phase=message;onUpdate(run);},discovery);
    run.metrics.modelCalls+=discovery.modelCalls;
   }catch(error){
    const previous=previousRun?.discovery??discovery;
    if(!prior.length||!previous)throw error;
    discovery={...previous,index:{version:index.version,sourceLines:index.sourceLines,excludedFiles:index.excludedFiles,indexedAt:index.indexedAt,changedPaths:[],fileCount:index.files.length},
     plan:{...previous.plan,journeys:[],gaps:['Discovery could not refresh coverage for this release. Prior coverage is retained.',...previous.plan.gaps].slice(0,15)},observations:[],modelCalls:0,durationMs:Date.now()-started,generatedAt:new Date().toISOString()};
   }
  }
  if(index.version!==discovery.index.version)throw new Error('Source changed while the test team was prepared; run again after the edit completes');
  if(prior.length)discovery=releaseDiscovery(discovery,prior,currentCheck);
  run.discovery=discovery;run.sourceVersion=discovery.index.version;
  run.phase='Freezing journey preconditions';onUpdate(structuredClone(run));
  const testers=new Map(discovery.plan.testers.map(t=>[t.id,t]));
  const authenticated=new Map<string,boolean>();
  for(const tester of discovery.plan.testers){
   const auth=await sessions.authenticate(project,secrets,tester.accountId??tester.id,undefined,true,sessions.personaIdentity(tester));run.metrics.modelCalls+=auth.modelCalls;
   authenticated.set(tester.id,auth.verified);
  }
  await snapshot(project,run,index);
  const priorIds=new Set(prior.map(r=>r.journey.id));
  const prepared:PreparedJourney[]=[];
  for(const journey of discovery.plan.journeys){
   const tester=testers.get(journey.testerId)!;
   const unavailable=new Map<string,string>();
   if(priorIds.has(journey.id))for(const check of journey.checks){
    if(!currentCheck(check))unavailable.set(check.id,'A prior check source citation is stale or missing');
    else if(check.phase==='preserve'&&check.expected===undefined)unavailable.set(check.id,'The prior run did not freeze a preserved value');
   }
   prepared.push(await prepareJourney(project,tester,journey,unavailable,authenticated.get(tester.id)===true,privateValues));
  }
  run.phase='Your testers are exploring';onUpdate(structuredClone(run));
  // Different entry paths can share backend state. Replay starts from the
  // same pre-action snapshot and uses this same serial journey order.
  for(const item of prepared){
   const result=await testJourney(project,secrets,testers.get(item.journey.testerId)!,item,history,index.version);
   run.results.push(result);run.metrics.modelCalls+=result.run.evidence?.modelCalls??0;summary(run);onUpdate(structuredClone(run));
  }
  if((await scanRepository(project.repositoryPath)).version!==index.version){for(const result of run.results){result.run.verdict='inconclusive';if(result.finding)result.finding.confidence='inconclusive';}run.error='Repository changed during execution; these results cannot establish a product regression';}
  run.status='completed';run.phase='Results ready';run.finishedAt=new Date().toISOString();run.metrics.elapsedMs=Date.now()-started;summary(run);return run;
 }
 async function replay(project:Project,secrets:ProjectSecrets,source:ProjectRun,sessionRoot:string){
  const run:ProjectRun={...structuredClone(source),id:randomUUID(),results:[],findings:[],status:'running',error:undefined,metrics:{elapsedMs:0,modelCalls:0,browserActions:0,passed:0,failed:0,inconclusive:0}};const start=Date.now();
  // Session storage origins include ports, unlike cookies. Rebind only the original app origin in the private snapshot.
  for(const tester of source.discovery?.plan.testers??source.results.map(r=>r.tester)){const identity=sessions.personaIdentity(tester),state=await sessions.loadPersona(project,tester,sessionRoot);if(state){const sourceOrigin=new URL(source.results[0]?.run.evidence?.actions.find(a=>a.action.tool==='navigate')?.url??project.appUrl).origin;for(const item of state.origins)if(item.origin===sourceOrigin)item.origin=new URL(project.appUrl).origin;await sessions.save(project,identity,state,sessionRoot);}}
  for(const original of source.results)run.results.push(await testJourney(project,secrets,original.tester,{journey:structuredClone(original.journey),unavailable:new Map()},[],source.sourceVersion!,original,sessionRoot));
  run.status='completed';run.phase='Frozen checks replayed';run.finishedAt=new Date().toISOString();run.metrics.elapsedMs=Date.now()-start;summary(run);return run;
 }
 const repair=createProjectRepairRuntime({workspaceRoot:join(options.privateRoot,'repairs'),privateRoot:options.privateRoot,apiKey:options.apiKey,model:options.model,replay});
 return {discover,execute,replay,repair};
}
