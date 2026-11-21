import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { EvidenceRun, InvestigationRecord } from '../packages/contracts/src/runtime';
import type { ContextPack, ScenarioDefinition } from '../packages/contracts/src/index';
config({quiet:true});
const base=`http://127.0.0.1:${process.env.RUNNER_PORT||4000}`;
async function api<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch(`${base}/api/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.RUNNER_API_TOKEN||'local-development-runner'}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(!response.ok)throw new Error(`Runner returned HTTP ${response.status} for ${path}`);
 return response.json();
}
const argument=(name:string)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const scenarioId=argument('scenario-id'),targetId=argument('target-pack'),controlId=argument('control-pack');
if(!scenarioId||!targetId||!controlId)throw new Error('Supply --scenario-id=ID --target-pack=ID --control-pack=ID');
const scenarios=await api<ScenarioDefinition[]>('scenarios'),contexts=await api<ContextPack[]>('context-packs');
const scenario=scenarios.find(s=>s.id===scenarioId),target=contexts.find(c=>c.id===targetId),control=contexts.find(c=>c.id===controlId);
if(!scenario||!target||!control)throw new Error('Selected configuration does not exist');
async function run(context:ContextPack){
 const {id}=await api<{id:string}>('runs',{requestId:randomUUID(),scenarioId:scenario!.id,scenarioRevision:scenario!.revision,contextPackId:context.id,contextRevision:context.revision});
 const deadline=Date.now()+210000;
 while(Date.now()<deadline){
  const result=await api<EvidenceRun>(`runs/${id}`);
  if(result.status==='completed'||result.status==='interrupted'){console.log(JSON.stringify({id,context:context.label,verdict:result.verdict,findings:result.findings,modelCalls:result.evidence?.modelCalls}));return result;}
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 throw new Error('Timed out waiting for journey');
}
const controlRun=await run(control);
if(controlRun.verdict!=='passed')throw new Error('Control did not pass; inspect its evidence before launching more trials');
let targetRun=await run(target);
if(targetRun.verdict==='inconclusive'){
 const replay=await api<{id:string}>(`runs/${controlRun.id}/replay`,{requestId:randomUUID(),contextPackId:target.id,contextRevision:target.revision});
 const until=Date.now()+210000;
 for(;;){targetRun=await api<EvidenceRun>(`runs/${replay.id}`);if(targetRun.status==='completed'||targetRun.status==='interrupted')break;if(Date.now()>until)throw new Error(`Replay timed out: ${replay.id}`);await new Promise(resolve=>setTimeout(resolve,1500));}
 console.log(JSON.stringify({replayId:replay.id,verdict:targetRun.verdict,findings:targetRun.findings}));
}
if(controlRun.verdict!=='passed'||targetRun.verdict!=='failed')throw new Error('Expected a verified control pass and target failure before investigation');
const job=await api<InvestigationRecord>('investigations',{requestId:randomUUID(),targetRunId:targetRun.id,controlRunId:controlRun.id,factors:scenario.investigation.factors,maxAttempts:scenario.investigation.maxAttempts});
const deadline=Date.now()+scenario.investigation.maxAttempts*185000;
let completed=false;
while(Date.now()<deadline){
 const result=await api<InvestigationRecord>(`investigations/${job.id}`);
 if(result.status==='completed'||result.status==='interrupted'){
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/g2-checkpoint.json',JSON.stringify({controlRunId:controlRun.id,targetRunId:targetRun.id,investigation:result},null,2));
  console.log(JSON.stringify({id:job.id,status:result.status,error:result.error,conclusion:result.result?.conclusion,isolation:result.result?.isolationStatus,likelyTriggers:result.result?.likelyTriggers,attempts:result.result?.attemptsUsed,message:result.result?.message}));
  completed=true;
  if(result.result?.conclusion!=='reproducible_failure'||result.result.isolationStatus!=='isolated')process.exitCode=1;
  break;
 }
 await new Promise(resolve=>setTimeout(resolve,1500));
}

if(!completed)throw new Error(`Investigation timed out: ${job.id}`);
