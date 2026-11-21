import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {ProjectJourneySchema,ProjectPlanSchema,type ConnectProjectRequest,type Project,type ProjectDetail,type ProjectDiscovery,type ProjectFinding,type ProjectHistory,type ProjectJourney,type ProjectRepair,type ProjectRepairRequest,type ProjectRun,type ProjectRunRequest,type ProjectRuntime,type ProjectSecrets,type ProjectTester,type ProjectTesterResult} from '@lastmile/contracts/projects';
import {PatchProposalSchema} from '@lastmile/contracts/evolution';
import {classifyOutcome} from './outcome';
import {hashValue} from './artifacts';import {RunnerError} from './store';
type Job={id:string;projectId:string;requestId:string;kind:'discover'|'run'|'repair';status:'queued'|'running'|'completed'|'interrupted';data:unknown};
type Row={data:string};const decode=<T>(row:Row|undefined):T|undefined=>row?JSON.parse(row.data):undefined;const now=()=>new Date().toISOString();
const same=(left:unknown,right:unknown)=>hashValue([left])===hashValue([right]);

function validateDiscovery(discovery:ProjectDiscovery,project:Project,previous?:ProjectDiscovery):ProjectDiscovery {
 const plan=ProjectPlanSchema.safeParse(discovery?.plan);
 if(!plan.success||!discovery.index?.version)throw new Error('Discovery returned an invalid project plan');
 const accounts=new Set(project.accounts.map(account=>account.id));
 const bound=new Set<string>();
 for(const {accountId} of plan.data.testers){
  if(accounts.size ? !accountId||!accounts.has(accountId)||bound.has(accountId) : accountId!==undefined)
   throw new Error('Discovery returned invalid tester account bindings');
  if(accountId)bound.add(accountId);
 }
 if(discovery.observations.some(({accountId})=>accountId!==undefined&&!accounts.has(accountId))||
    previous?.plan.testers.some(old=>!plan.data.testers.some(tester=>tester.id===old.id&&tester.accountId===old.accountId)))
  throw new Error('Discovery changed or invented an account binding');
 return {...discovery,plan:plan.data};
}

function matchesFinding(finding:ProjectFinding,result:ProjectTesterResult){
 return finding.journeyId===result.journey.id&&finding.testerId===result.tester.id&&
  finding.failedCheckIds.every(id=>result.checks.some(check=>check.id===id&&check.status==='failed'))&&
  (finding.confidence==='inconclusive'||(result.run.verdict==='failed'&&finding.failedCheckIds.length>0));
}

function requirePreviousCoverage(discovery:ProjectDiscovery,previous?:ProjectRun){
 if(previous?.results.some(result=>!same(discovery.plan.journeys.find(journey=>journey.id===result.journey.id),result.journey)||
    !same(discovery.plan.testers.find(tester=>tester.id===result.tester.id),result.tester)))
  throw new Error('Release execution removed or changed a previous frozen journey or tester');
}

function matchesResult(result:ProjectTesterResult,tester:ProjectTester,journey:ProjectJourney,capturePreserve:boolean) {
 const {run,checks}=result;
 if(!same(result.tester,tester)||!ProjectJourneySchema.safeParse(result.journey).success||
    !same({...result.journey,checks:[]},{...journey,checks:[]})||
    result.journey.checks.length!==journey.checks.length||checks.length!==journey.checks.length||
    run.assertions.length!==checks.length||run.status!=='completed'||typeof run.id!=='string'||!run.id||
    run.scenario.id!==journey.id||run.scenario.goal!==journey.goal||run.scenario.entryPath!==journey.entryPath||
    !same(run.context,tester.context)||!same(run.inputs,journey.inputs))return false;
 for(const [index,frozen] of journey.checks.entries()){
  const definition=result.journey.checks[index];
  const captured=capturePreserve&&frozen.phase==='preserve'&&frozen.expected===undefined;
  if(!same(captured?{...definition,expected:undefined}:definition,frozen))return false;
  const check=checks.find(check=>check.id===frozen.id);
  const assertion=run.assertions.find(assertion=>assertion.id===frozen.id);
  if(!check||!assertion||check.label!==frozen.label||check.basis!==frozen.basis||check.phase!==frozen.phase||
     !same(check.sources,frozen.sources)||assertion.status!==check.status||
     assertion.expected!==check.expected||assertion.actual!==check.actual)return false;
  const visible=frozen.kind==='visible';
  const expected=definition.expected??(visible&&frozen.phase!=='preserve'?true:undefined);
  if(check.status==='not_evaluated'){
   if(check.expected!==expected&&check.expected!==definition.expected)return false;
   continue;
  }
  if(expected===undefined||check.expected!==expected||(visible&&typeof expected!=='boolean')||
     (check.actual!==undefined&&typeof check.actual!==(visible?'boolean':'string')))return false;
  const observed=visible?expected:String(expected);
  if(check.status!==(check.actual===observed?'passed':'failed'))return false;
 }
 return (run.verdict==='inconclusive'||run.verdict===classifyOutcome(checks,true))&&
  (!result.finding||matchesFinding(result.finding,result));
}

function validateRunUpdate(update:ProjectRun,original:ProjectRun,discovery:ProjectDiscovery,status:'running'|'completed'):ProjectRun {
 if(update.sourceVersion!==discovery.index.version||(update.discovery&&!same(update.discovery,discovery)))
  throw new Error('Project worker changed the frozen discovery');
 const {results,findings}=update;
 if((status==='completed'&&!update.error&&results.length!==discovery.plan.journeys.length)||
    new Set(results.map(({journey})=>journey.id)).size!==results.length||
    new Set(results.map(({run})=>run.id)).size!==results.length||results.some(result=>{
     const journey=discovery.plan.journeys.find(journey=>journey.id===result.journey.id);
     const tester=discovery.plan.testers.find(tester=>tester.id===journey?.testerId);
     return !journey||!tester||!matchesResult(result,tester,journey,true);
    }))throw new Error('Project worker returned evidence outside the frozen journeys and checks');
 if(findings.some(finding=>!results.some(result=>matchesFinding(finding,result))))
  throw new Error('Project worker returned a finding outside the evaluated checks');
 const metrics={...update.metrics,
  passed:results.filter(({run})=>run.verdict==='passed').length,
  failed:results.filter(({run})=>run.verdict==='failed').length,
  inconclusive:results.filter(({run})=>run.verdict==='inconclusive').length};
 return {...update,status,discovery,metrics,id:original.id,projectId:original.projectId,request:original.request,createdAt:original.createdAt,repairBlockedReason:original.repairBlockedReason};
}

function requireRepairSource(run:ProjectRun,project:Project){
 try{
  const discovery=validateDiscovery(run.discovery!,project);
  validateRunUpdate(run,run,discovery,'completed');
  if(run.status==='completed'&&!run.error&&run.results.some(({run})=>run.verdict==='failed')&&
     run.results.some(({run})=>run.verdict==='passed')&&run.results.every(({run})=>
      (run.verdict==='failed'||run.verdict==='passed')&&run.evidence?.actions.length))return;
 }catch{/* Stored runs may predate worker output validation. */}
 throw new RunnerError(409,'repair_evidence_required','Repair needs complete frozen evidence for a failing case and a passing control');
}

function reviewablePatch(value:unknown){
 const parsed=PatchProposalSchema.safeParse(value);
 if(!parsed.success)return;
 const {summary,changes,hash}=parsed.data;
 if(hash===hashValue({summary,changes}))return parsed.data;
}

function replayOutcome(source:ProjectRun,results:ProjectTesterResult[]) {
 if(results.length!==source.results.length||new Set(results.map(({journey})=>journey.id)).size!==results.length||
    new Set(results.map(({run})=>run.id)).size!==results.length)return 'inconclusive';
 for(const frozen of source.results){
  const result=results.find(({journey})=>journey.id===frozen.journey.id);
  const actions=frozen.run.evidence?.actions;
  if(!result||!actions?.length||source.results.some(({run})=>run.id===result.run.id)||
     !matchesResult(result,frozen.tester,frozen.journey,false)||
     result.run.executionMode!=='deterministic'||result.run.evidence?.modelCalls!==0||
     result.run.evidence.replayCompatible!==true||
     !same(result.run.evidence.actions.map(({action})=>action),actions.map(({action})=>action))||
     result.run.findings.some(({kind})=>kind==='environment_failure'||kind==='replay_mismatch'||kind==='agent_error')||
     (result.run.verdict!=='passed'&&result.run.verdict!=='failed'))return 'inconclusive';
 }
 return results.some(({run})=>run.verdict==='failed')?'rejected':'verified';
}

export function createProjectStore(db:Database.Database){
 db.exec(`CREATE TABLE IF NOT EXISTS dev_projects(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,secrets TEXT NOT NULL);CREATE TABLE IF NOT EXISTS dev_project_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(project_id,kind,request_id));CREATE TABLE IF NOT EXISTS dev_project_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS dev_project_repairs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS dev_project_history(project_id TEXT NOT NULL,tester_id TEXT NOT NULL,run_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,tester_id,run_id));`);
 const get=(id:string)=>decode<Project>(db.prepare('SELECT data FROM dev_projects WHERE id=?').get(id) as Row|undefined);
 const requireProject=(id:string)=>{const p=get(id);if(!p)throw new RunnerError(404,'not_found','Project does not exist');return p;};
 const save=(p:Project)=>{db.prepare('UPDATE dev_projects SET data=? WHERE id=?').run(JSON.stringify(p),p.id);return p;};
 const list=()=> (db.prepare('SELECT data FROM dev_projects ORDER BY rowid DESC').all() as Row[]).map(r=>JSON.parse(r.data) as Project);
 const getRun=(id:string)=>decode<ProjectRun>(db.prepare('SELECT data FROM dev_project_runs WHERE id=?').get(id) as Row|undefined);
 const saveRun=(r:ProjectRun)=>{db.prepare('INSERT INTO dev_project_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.id,r.projectId,JSON.stringify(r));return r;};
 const getRepair=(id:string)=>decode<ProjectRepair>(db.prepare('SELECT data FROM dev_project_repairs WHERE id=?').get(id) as Row|undefined);
 const saveRepair=(r:ProjectRepair)=>{db.prepare('INSERT INTO dev_project_repairs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.id,r.projectId,JSON.stringify(r));return r;};
 const runs=(projectId:string)=>(db.prepare('SELECT data FROM dev_project_runs WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Row[]).map(r=>JSON.parse(r.data) as ProjectRun);
 const repairs=(projectId?:string)=>((projectId?db.prepare('SELECT data FROM dev_project_repairs WHERE project_id=? ORDER BY rowid DESC').all(projectId):db.prepare('SELECT data FROM dev_project_repairs ORDER BY rowid DESC').all()) as Row[]).map(r=>JSON.parse(r.data) as ProjectRepair);
 const history=(projectId:string)=>(db.prepare('SELECT data FROM dev_project_history WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Row[]).map(r=>JSON.parse(r.data) as ProjectHistory);
 const busy=(projectId:string)=>Boolean(db.prepare("SELECT 1 FROM dev_project_jobs WHERE project_id=? AND status IN ('queued','running')").get(projectId));
 const assertIdle=(projectId:string)=>{if(busy(projectId))throw new RunnerError(409,'project_busy','This project already has work in progress');};
 function existing(projectId:string,kind:Job['kind'],requestId:string,request:unknown){const row=db.prepare('SELECT id,request_hash FROM dev_project_jobs WHERE project_id=? AND kind=? AND request_id=?').get(projectId,kind,requestId) as {id:string;request_hash:string}|undefined;if(row&&row.request_hash!==hashValue(request))throw new RunnerError(409,'request_conflict','Request ID already has different inputs');return row?.id;}
 function enqueue(projectId:string,kind:Job['kind'],requestId:string,request:unknown,data:unknown,id:string=randomUUID()){db.prepare('INSERT INTO dev_project_jobs VALUES(?,?,?,?,?,?,?)').run(id,projectId,requestId,hashValue(request),kind,'queued',JSON.stringify(data));return id;}
 const byRequest=(requestId:string)=>decode<Project>(db.prepare('SELECT data FROM dev_projects WHERE request_id=?').get(requestId) as Row|undefined);
 const secrets=(id:string)=>{const row=db.prepare('SELECT secrets FROM dev_projects WHERE id=?').get(id) as {secrets:string}|undefined;if(!row)throw new RunnerError(404,'not_found','Project does not exist');return JSON.parse(row.secrets) as ProjectSecrets;};
 const connect=db.transaction((request:ConnectProjectRequest)=>{const old=db.prepare('SELECT data,request_hash FROM dev_projects WHERE request_id=?').get(request.requestId) as (Row&{request_hash:string})|undefined;if(old){if(old.request_hash!==hashValue(request))throw new RunnerError(409,'request_conflict','Request ID already has different inputs');return JSON.parse(old.data) as Project;}
  const accountSecrets:ProjectSecrets={accounts:request.accounts.map(a=>({...a,id:randomUUID()}))};const p:Project={id:randomUUID(),name:request.name,repositoryPath:request.repositoryPath,appUrl:request.appUrl,allowedOrigins:request.allowedOrigins,brief:request.brief,requirements:request.requirements,accounts:accountSecrets.accounts.map(({id,label})=>({id,label})),commands:request.commands,createdAt:now(),updatedAt:now(),status:'discovering',progress:'Reading the development repository'};db.prepare('INSERT INTO dev_projects VALUES(?,?,?,?,?)').run(p.id,request.requestId,hashValue(request),JSON.stringify(p),JSON.stringify(accountSecrets));enqueue(p.id,'discover',request.requestId,{requestId:request.requestId},{project:p});return p;
 }).immediate;
 const refresh=db.transaction((projectId:string,requestId:string)=>{const p=requireProject(projectId);if(existing(projectId,'discover',requestId,{requestId}))return p;assertIdle(projectId);enqueue(projectId,'discover',requestId,{requestId},{project:p});return save({...p,status:'discovering',progress:'Refreshing application understanding',updatedAt:now(),error:undefined});}).immediate;
 const enqueueRun=db.transaction((projectId:string,request:ProjectRunRequest)=>{const p=requireProject(projectId);const old=existing(projectId,'run',request.requestId,request);if(old)return getRun(old)!;assertIdle(projectId);if(p.status!=='ready'||!p.discovery)throw new RunnerError(409,'discovery_required','Wait for application discovery to complete');const run:ProjectRun={id:randomUUID(),projectId,request,status:'queued',phase:'Waiting for browser workers',createdAt:now(),discovery:structuredClone(p.discovery),sourceVersion:p.discovery.index.version,results:[],findings:[],summary:'',metrics:{elapsedMs:0,modelCalls:0,browserActions:0,passed:0,failed:0,inconclusive:0}};enqueue(projectId,'run',request.requestId,request,{project:p},run.id);return saveRun(run);}).immediate;
 const enqueueRepair=db.transaction((request:ProjectRepairRequest)=>{const run=getRun(request.runId);if(!run)throw new RunnerError(404,'not_found','Test run does not exist');const p=requireProject(run.projectId);const old=existing(p.id,'repair',request.requestId,request);if(old)return getRepair(old)!;assertIdle(p.id);requireRepairSource(run,p);if(!p.commands)throw new RunnerError(409,'repair_setup_required','Connect fixed build/start commands to verify a private repair');const job:ProjectRepair={id:randomUUID(),projectId:p.id,request,status:'queued',phase:'prepare',createdAt:now(),sourceRun:structuredClone(run),project:structuredClone(p)};enqueue(p.id,'repair',request.requestId,request,{repairId:job.id},job.id);return saveRepair(job);}).immediate;
 const verifyRepair=db.transaction((id:string,request:{requestId:string;patchHash:string})=>{const job=getRepair(id);if(!job)throw new RunnerError(404,'not_found','Repair does not exist');if(job.verificationRequest){if(hashValue(job.verificationRequest)!==hashValue(request))throw new RunnerError(409,'request_conflict','Verification already has different inputs');return job;}if(job.status!=='awaiting_review'||reviewablePatch(job.patch)?.hash!==request.patchHash)throw new RunnerError(409,'stale_patch','Review the current patch before verifying');assertIdle(job.projectId);const next={...job,status:'queued' as const,phase:'verify' as const,verificationRequest:request};db.prepare("UPDATE dev_project_jobs SET status='queued',data=? WHERE id=?").run(JSON.stringify({repairId:id}),id);return saveRepair(next);}).immediate;
 const claimNext=db.transaction(()=>{const row=db.prepare("SELECT id,project_id,request_id,kind,status,data FROM dev_project_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get() as {id:string;project_id:string;request_id:string;kind:Job['kind'];status:Job['status'];data:string}|undefined;if(!row)return;db.prepare("UPDATE dev_project_jobs SET status='running' WHERE id=?").run(row.id);return {id:row.id,projectId:row.project_id,requestId:row.request_id,kind:row.kind,status:'running' as const,data:JSON.parse(row.data)};}).immediate;
 function safeError(error:unknown,privateData:ProjectSecrets){let message=error instanceof Error?error.message:'Project work could not complete';for(const a of privateData.accounts)for(const secret of [a.password,a.username])if(secret)message=message.replaceAll(secret,'[private]');return message.slice(0,1000);}
 async function execute(job:Job,runtime?:ProjectRuntime){
  const privateData=secrets(job.projectId);
  try {
   if(!runtime)throw new Error('Project execution is not configured');
   if(job.kind==='discover'){
    const project=requireProject(job.projectId);
    const result=await runtime.discover(structuredClone(project),privateData,message=>save({...requireProject(project.id),progress:message}),structuredClone(project.discovery));
    const discovery=validateDiscovery(result,project,project.discovery);
    save({...requireProject(project.id),discovery,status:'ready',progress:'Your test team is ready',updatedAt:now(),error:undefined});
   }else if(job.kind==='run'){
    const original=getRun(job.id)!;
    const {project}=job.data as {project:Project};
    const running=saveRun({...original,status:'running',phase:'Starting your test team'});
    let discovery=validateDiscovery(original.discovery!,project);
    const previous=original.request.mode==='release'?runs(project.id).find(run=>run.id!==original.id&&run.status==='completed'&&!run.error&&run.results.length):undefined;
    let canRefresh=true;
    const result=await runtime.execute(structuredClone(project),privateData,structuredClone(running),history(project.id),update=>{
     if(getRun(job.id)?.status!=='running')return;
     const candidate=update.discovery;
     // The runtime may refresh once before publishing any journey evidence.
     const refreshed=candidate&&canRefresh&&!update.results.length&&!same(candidate,discovery)&&
      (original.request.mode==='release'||candidate.index?.version!==discovery.index.version)
      ?validateDiscovery(candidate,project,discovery):undefined;
     if(refreshed||update.results.length)requirePreviousCoverage(refreshed??discovery,previous);
     const progress=validateRunUpdate(update,original,refreshed??discovery,'running');
     saveRun(progress);
     if(refreshed)discovery=refreshed;
     if(refreshed||progress.results.length)canRefresh=false;
    },previous?structuredClone(previous):undefined);
    if(result.status!=='completed')throw new Error('Project worker returned unfinished results');
    requirePreviousCoverage(discovery,previous);
    const finished=validateRunUpdate(result,original,discovery,'completed');
    finished.finishedAt??=now();
    if(finished.error)finished.error=safeError(new Error(finished.error),privateData);
    db.transaction(()=>{
     saveRun(finished);
     for(const {tester,run,journey} of finished.results){
      const h:ProjectHistory={testerId:tester.id,runId:run.id,goal:journey.goal,outcome:run.verdict??'inconclusive',observations:run.steps.slice(-3).map(s=>s.observation.slice(0,2000)),createdAt:finished.finishedAt!};
      db.prepare('INSERT OR IGNORE INTO dev_project_history VALUES(?,?,?,?)').run(project.id,h.testerId,h.runId,JSON.stringify(h));
     }
     if(!previous)save({...requireProject(project.id),discovery:finished.discovery,updatedAt:now()});
     if(original.request.autoRepair){
      let blocked:string|undefined;
      if(finished.metrics.inconclusive)blocked='Repair paused because some test results are inconclusive. Those checks need complete evidence first.';
      else if(finished.metrics.failed){
       if(!project.commands?.start.length)blocked='Automatic repair needs the application start command. Testing results are saved.';
       else if(!runtime.repair)blocked='Automatic repair is not available on this runner. Testing results are saved.';
       else {try{requireRepairSource(finished,project);}catch{blocked='Repair needs complete evidence for both a failing journey and a passing control.';}}
       if(!blocked){
        db.prepare("UPDATE dev_project_jobs SET status='completed' WHERE id=?").run(job.id);
        enqueueRepair({requestId:`auto-${finished.id}`,runId:finished.id,automatic:true});
       }
      }
      if(blocked)saveRun({...finished,repairBlockedReason:blocked});
     }
    }).immediate();
   }else{
    if(!runtime.repair)throw new Error('Private repair execution is not configured');
    const repair=getRepair(job.id)!;
    saveRepair({...repair,status:'running'});
    requireRepairSource(repair.sourceRun,repair.project);
    if(repair.phase==='prepare'){
     const proposal=await runtime.repair.prepare(structuredClone(repair),privateData);
     if(proposal.error)throw new Error(proposal.error);
     const patch=reviewablePatch(proposal.patch);
     if(!patch)throw new Error('Repair worker did not return a reviewable patch');
     db.transaction(()=>{
      saveRepair({...repair,patch,sourceVersion:proposal.sourceVersion,status:'awaiting_review'});
      if(repair.request.automatic){
       db.prepare("UPDATE dev_project_jobs SET status='completed' WHERE id=?").run(job.id);
       verifyRepair(repair.id,{requestId:`auto-${repair.id}`,patchHash:patch.hash});
      }
     }).immediate();
    }else{
     const patch=reviewablePatch(repair.patch);
     if(!patch||repair.verificationRequest?.patchHash!==patch.hash)throw new Error('Verification requires the exact reviewed patch');
     const result=await runtime.repair.verify(structuredClone(repair),privateData);
     const outcome=replayOutcome(repair.sourceRun,result.results);
     const matched=outcome!=='inconclusive'&&outcome===result.outcome;
     const verification:NonNullable<ProjectRepair['verification']>=matched
      ?{outcome,message:outcome==='verified'?'The reviewed patch passed all frozen checks and controls':'One or more frozen checks failed on the reviewed patch',results:result.results}
      :{outcome:'inconclusive',message:result.outcome==='inconclusive'&&result.results.length===0
       ?safeError(new Error(result.message),privateData):'Verification could not establish a complete, compatible replay of the frozen checks and controls',results:[]};
     saveRepair({...repair,verification,status:'completed',finishedAt:now()});
    }
   }
  }catch(error){
   const message=safeError(error,privateData);
   if(job.kind==='discover')save({...requireProject(job.projectId),status:'failed',progress:'Discovery needs attention',error:message,updatedAt:now()});
   else if(job.kind==='run'){
    const r=getRun(job.id)!;
    saveRun({...r,status:'completed',phase:'Testing could not complete',finishedAt:now(),error:message});
   }else{
    const r=getRepair(job.id)!;
    saveRepair({...r,status:'completed',finishedAt:now(),error:message,...(r.phase==='verify'?{verification:{outcome:'inconclusive',message,results:[]}}:{})});
   }
  }finally{
   db.prepare("UPDATE dev_project_jobs SET status='completed' WHERE id=? AND status='running'").run(job.id);
  }
 }
 const recoverInterrupted=db.transaction(()=>{for(const row of db.prepare("SELECT id,project_id,kind FROM dev_project_jobs WHERE status='running'").all() as {id:string;project_id:string;kind:Job['kind']}[]){if(row.kind==='discover')save({...requireProject(row.project_id),status:'failed',error:'Discovery was interrupted; refresh to retry',progress:'Discovery interrupted'});else if(row.kind==='run'){const r=getRun(row.id)!;saveRun({...r,status:'interrupted',phase:'Worker stopped',finishedAt:now()});}else{const r=getRepair(row.id)!;saveRepair({...r,status:'interrupted',finishedAt:now()});}}db.prepare("UPDATE dev_project_jobs SET status='interrupted' WHERE status='running'").run();}).immediate;
 return {connect,byRequest,get,list,refresh,enqueueRun,getRun,runs,enqueueRepair,getRepair,repairs,verifyRepair,claimNext,execute,recoverInterrupted,history,detail:(id:string):ProjectDetail=>({...requireProject(id),runs:runs(id),history:history(id),repairs:repairs(id)}),findEvidence:(id:string)=>{for(const p of list())for(const r of runs(p.id))for(const t of r.results)if(t.run.id===id)return t.run;for(const r of repairs())for(const t of r.verification?.results??[])if(t.run.id===id)return t.run;}};
}
