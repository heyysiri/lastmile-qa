import {config} from 'dotenv';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import type {Study,StudyApplication,StudyExecutionDetail,StudyExecution} from '../packages/contracts/src/studies';
config({quiet:true});
const base=`http://127.0.0.1:${process.env.RUNNER_PORT||4000}/api`;
async function api<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch(`${base}/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.RUNNER_API_TOKEN||'local-development-runner'}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
 if(!response.ok)throw new Error(`Runner returned HTTP ${response.status} for ${path}`);
 return response.json();
}
const applications=await api<StudyApplication[]>('applications');
const application=applications[0];
if(!application)throw new Error('No connected application');
const existingStudyId=process.argv[2];
const study=existingStudyId?await api<Study>(`studies/${encodeURIComponent(existingStudyId)}`):await api<Study>('studies/generate',{requestId:randomUUID(),applicationId:application.id,domain:application.domain,count:3,audience:'Test two different new sellers setting up their stores with distinct names and one experienced seller updating stock quantity. They all read English and use a pointer with normal connectivity. Keep tasks within the connected app capabilities. Generate different useful inputs and explain the assumptions.'});
console.log(JSON.stringify({studyId:study.id,title:study.title,users:study.users.map(user=>({name:user.name,workflow:user.workflowId,goal:user.goal}))}));
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/c1-study-draft.json',JSON.stringify(study,null,2));
const execution=await api<StudyExecution>(`studies/${study.id}/launch`,{requestId:randomUUID(),revision:study.revision});
console.log(JSON.stringify({executionId:execution.id,status:execution.status}));
const deadline=Date.now()+240000;
while(Date.now()<deadline){
 const result=await api<StudyExecutionDetail>(`study-executions/${execution.id}`);
 if(['completed','interrupted'].includes(result.status)){
  await writeFile('artifacts/c1-checkpoint.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({id:result.id,status:result.status,runs:result.runs.map(run=>({id:run.id,verdict:run.verdict,namespaceId:run.namespaceId,modelCalls:run.evidence?.modelCalls,startedAt:run.startedAt,finishedAt:run.finishedAt,assertions:run.assertions}))}));
  const namespaces=result.runs.map(run=>run.namespaceId);
  if(result.status!=='completed'||result.runs.length!==3||new Set(namespaces).size!==3||namespaces.some(n=>!n)||result.runs.some(run=>run.verdict!=='passed'||!run.evidence?.modelCalls))throw new Error('Study did not meet live checkpoint expectations; inspect stored evidence');
  const latestStart=Math.max(...result.runs.map(run=>Date.parse(run.steps[0]?.timestamp||'')));
  const earliestEnd=Math.min(...result.runs.map(run=>Date.parse(run.steps.at(-1)?.timestamp||'')));
  if(!(latestStart<earliestEnd))throw new Error('No three-way execution overlap was recorded');
  console.log('Verified three independent passing journeys with separate state and overlapping execution.');
  process.exit(0);
 }
 await new Promise(resolve=>setTimeout(resolve,1500));
}
throw new Error(`Study execution timed out: ${execution.id}`);
