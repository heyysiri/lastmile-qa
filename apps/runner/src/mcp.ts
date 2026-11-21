import {McpServer,type CallToolResult} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {ConnectProjectSchema,ProjectRunRequestSchema,ProjectRepairRequestSchema,type Project,type ProjectDetail,type ProjectDiscovery,type ProjectRun,type ProjectRepair,type ProjectTesterResult} from '@lastmile/contracts/projects';

const id=ConnectProjectSchema.shape.requestId;
const empty=z.object({}).strict();
const connectionResponse=z.object({id,status:z.enum(['discovering','ready','failed'])});
const errors:Record<string,string>={
 unauthorized:'Runner authorization failed. Check RUNNER_API_TOKEN.',
 not_found:'The requested project, connection, run, or repair does not exist.',
 validation:'The runner rejected the request inputs.',
 repository_unavailable:'The repository directory is not available to the runner.',
 request_conflict:'This request ID already has different inputs. Reuse the original inputs or choose a new ID for new work.',
 project_busy:'The project already has work in progress. Poll its current jobs before starting another.',
 discovery_required:'Wait for project discovery to finish before running tests.',
 repair_unavailable:'Private repair execution is not configured on the runner.',
 repair_setup_required:'Connect fixed build/start commands to verify a private repair.',
 repair_evidence_required:'Repair needs complete frozen evidence for a failing case and a passing control.',
};
class ApiError extends Error {
 constructor(readonly code:string,message:string,readonly status?:number){super(message);}
}
function origin(value:string,name:string){
 try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error();return url.origin;}
 catch{throw new Error(`${name} must be an HTTP origin without credentials, a path, query, or fragment`);}
}
function resultSummary(result:ProjectTesterResult){
 const {tester,journey,checks,finding,sessionContinued,run}=result;
 return {
  tester:{id:tester.id,name:tester.name,role:tester.role},journey:{id:journey.id,title:journey.title,goal:journey.goal},
  checks:checks.map(({id,label,status,expected,actual,basis,phase,atStageStart,message})=>({id,label,status,expected,actual,basis,phase,atStageStart,message})),finding,sessionContinued,
  run:{id:run.id,status:run.status,verdict:run.verdict,executionMode:run.executionMode,findings:run.findings,...(run.evidence?{evidence:{modelCalls:run.evidence.modelCalls,replayCompatible:run.evidence.replayCompatible,actionCount:run.evidence.actions.length}}:{})},
 };
}
function discoverySummary(discovery:ProjectDiscovery){
 const {index,plan,modelCalls,durationMs,generatedAt}=discovery;
 const {version,fileCount,sourceLines,excludedFiles,indexedAt,changedPaths}=index;
 return {index:{version,fileCount,sourceLines,excludedFiles,indexedAt,changedPathCount:changedPaths.length},plan,modelCalls,durationMs,generatedAt};
}
function runSummary(run:ProjectRun){
 return {...run,discovery:undefined,...(run.results?{results:run.results.map(resultSummary)}:{})};
}
function repairSummary(repair:ProjectRepair){
 const {id,projectId,status,phase,error,verification,request}=repair;
 return {id,projectId,status,phase,error,request,...(verification?{verification:{outcome:verification.outcome,message:verification.message}}:{})};
}

export function createMcpServer(env:NodeJS.ProcessEnv=process.env){
 const runnerUrl=origin(env.RUNNER_URL??'http://127.0.0.1:4000','RUNNER_URL');
 const dashboardUrl=origin(env.LASTMILE_DASHBOARD_URL??'http://127.0.0.1:3000','LASTMILE_DASHBOARD_URL');
 const token=env.RUNNER_API_TOKEN??'local-development-runner';
 const timeout=Number(env.LASTMILE_MCP_TIMEOUT_MS??10000);
 if(!Number.isInteger(timeout)||timeout<1||timeout>120000)throw new Error('LASTMILE_MCP_TIMEOUT_MS must be between 1 and 120000');
 if(!token.trim()||/[\r\n]/.test(token))throw new Error('RUNNER_API_TOKEN must be a nonempty single line');
 const link=(projectId:string)=>`${dashboardUrl}/projects/${encodeURIComponent(projectId)}`;
 const connected=(value:unknown)=>{const project=connectionResponse.parse(value);return {...project,dashboardUrl:link(project.id)};};
 async function request<T>(path:string,body?:unknown):Promise<T>{
  const signal=AbortSignal.timeout(timeout);
  try{
   const response=await fetch(`${runnerUrl}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal});
   if(!response.ok){
    const payload=await response.json().catch(()=>null);
    const code=typeof payload?.code==='string'&&Object.hasOwn(errors,payload.code)?payload.code:response.status===401?'unauthorized':response.status===404?'not_found':'runner_error';
    throw new ApiError(code,errors[code]??`Runner request failed (HTTP ${response.status}).`,response.status);
   }
   return await response.json() as T;
  }catch(error){
   if(error instanceof ApiError)throw error;
   if(signal.aborted)throw new ApiError('runner_timeout','Runner request timed out. Recover a connection by its request ID, or retry the same write with identical inputs and request ID.');
   throw new ApiError('runner_unavailable','Cannot reach the runner. Check that it is running and RUNNER_URL is correct. Redirects are not followed.');
  }
 }
 async function respond(action:()=>Promise<unknown>):Promise<CallToolResult>{
  try{
   const text=JSON.stringify(await action());
   return {content:[{type:'text',text}]};
  }catch(error){
   const safe=error instanceof ApiError?{code:error.code,message:error.message,status:error.status}:{code:'invalid_runner_response',message:'The runner returned an unexpected response.'};
   return {isError:true,content:[{type:'text',text:JSON.stringify(safe)}]};
  }
 }
 const server=new McpServer({name:'lastmile-qa',version:'1.0.0'},{instructions:'Use lastmile qa. to connect a running development application and repository, discover its test team, run explore or release checks, and inspect private automatic repairs. Reuse stable request IDs after uncertain write responses. Poll discovering/queued/running jobs every few seconds. A completed run is not a completed repair: inspect repairStatus, repairBlockedReason, errors, and verification outcome. Only verified means the private patch passed frozen checks. Patches are never applied to the source repository by these tools. Use synthetic development accounts; inline credentials enter the MCP host conversation.'});
 const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 const write={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true};
 server.registerTool('lastmile_health',{description:'Check runner reachability and discovery, execution, and private repair readiness. Start the local runner separately if unavailable.',inputSchema:empty,annotations:read},()=>respond(()=>request('/api/health')));
 server.registerTool('lastmile_list_projects',{description:'List connected projects and discovery status. Use lastmile_get_project for generated testers, journeys, and run history.',inputSchema:empty,annotations:read},()=>respond(async()=>{
  const projects=await request<Project[]>('/api/projects');
  return projects.map(({id,name,status,progress,appUrl,error})=>({id,name,status,progress,appUrl,error,dashboardUrl:link(id)}));
 }));
 server.registerTool('lastmile_connect_project',{description:'Connect an existing repository and running development app. Use a stable requestId and absolute repositoryPath on the runner machine. Discovery runs asynchronously: poll lastmile_get_project until ready or failed. Accounts must be synthetic development accounts. Optional fixed commands enable private repair verification; start is an argv array, not a shell string. Recover an uncertain response with lastmile_get_connection(requestId).',inputSchema:ConnectProjectSchema,annotations:write},args=>respond(async()=>connected(await request('/api/projects',args))));
 server.registerTool('lastmile_get_connection',{description:'Recover a connection after a lost response using its original requestId. This never creates a project. Poll lastmile_get_project for discovery.',inputSchema:z.object({requestId:id}).strict(),annotations:read},({requestId})=>respond(async()=>connected(await request(`/api/projects/by-request/${requestId}`))));
 server.registerTool('lastmile_get_project',{description:'Inspect discovery progress, generated testers and journeys, gaps, index metrics, and compact run/repair history. Wait for ready before running tests; failed is terminal and includes error. includeEvidence adds full index paths, discovery browser snapshots, and original history evidence.',inputSchema:z.object({projectId:id,includeEvidence:z.boolean().default(false)}).strict(),annotations:read},({projectId,includeEvidence})=>respond(async()=>{
  const project=await request<ProjectDetail>(`/api/projects/${projectId}`);
  if(includeEvidence)return {...project,dashboardUrl:link(projectId)};
  return {...project,...(project.discovery?{discovery:discoverySummary(project.discovery)}:{}),...(project.runs?{runs:project.runs.map(runSummary)}:{}),...(project.repairs?{repairs:project.repairs.map(repairSummary)}:{}),dashboardUrl:link(projectId)};
 }));
 server.registerTool('lastmile_run_project',{description:'Queue explore or release testing against development data; browser journeys may change business records. autoRepair defaults true and prepares/verifies any eligible fix privately. Use a stable requestId; retries must use identical inputs. Poll lastmile_get_run until both run and automatic repair finish. A completed run alone is not repair success. No patch is applied to the original repository.',inputSchema:ProjectRunRequestSchema.extend({projectId:id,autoRepair:z.boolean().default(true)}),annotations:{...write,destructiveHint:true}},({projectId,...requestBody})=>respond(async()=>runSummary(await request<ProjectRun>(`/api/projects/${projectId}/runs`,requestBody))));
 server.registerTool('lastmile_get_run',{description:'Poll run status and automatic repairStatus together. queued/running/awaiting_run/pending require polling. completed/interrupted are terminal jobs; blocked/not_needed/not_requested explain absence of repair. Read run.error and repairBlockedReason. A completed repair succeeds only when verification.outcome is verified. Results retain findings/checks; includeEvidence adds full browser logs.',inputSchema:z.object({runId:id,includeEvidence:z.boolean().default(false)}).strict(),annotations:read},({runId,includeEvidence})=>respond(async()=>{
  const run=await request<ProjectRun>(`/api/project-runs/${runId}`);
  const repairs=(await request<ProjectRepair[]>(`/api/project-repairs?projectId=${encodeURIComponent(run.projectId)}`)).filter(repair=>repair.request.runId===run.id);
  const automatic=repairs.find(repair=>repair.request.automatic);
  const repairStatus=automatic?.status??(!run.request.autoRepair?'not_requested':run.status==='queued'||run.status==='running'?'awaiting_run':run.repairBlockedReason||run.error||run.status==='interrupted'?'blocked':!run.metrics.failed&&!run.metrics.inconclusive?'not_needed':'pending');
  return {run:includeEvidence?run:runSummary(run),repairStatus,repairs:repairs.map(repair=>({...repairSummary(repair),dashboardUrl:link(repair.projectId)})),dashboardUrl:link(run.projectId)};
 }));
 server.registerTool('lastmile_get_repair',{description:'Inspect a private repair patch, verification outcome, checks, and evidence. Poll queued/running; completed/interrupted are terminal. awaiting_review requires attention. Only verification.outcome=verified establishes success. This does not apply the patch. includeEvidence adds full source and replay browser logs.',inputSchema:z.object({repairId:id,includeEvidence:z.boolean().default(false)}).strict(),annotations:read},({repairId,includeEvidence})=>respond(async()=>{
  const repair=await request<ProjectRepair>(`/api/project-repairs/${repairId}`);
  if(includeEvidence)return {...repair,dashboardUrl:link(repair.projectId)};
  const {sourceRun,project,verification,investigation,...details}=repair;
  return {...details,...(sourceRun?{sourceRun:runSummary(sourceRun)}:{}),...(project?{project:{id:project.id,name:project.name,appUrl:project.appUrl}}:{}),...(verification?{verification:{...verification,...(verification.results?{results:verification.results.map(resultSummary)}:{})}}:{}),...(investigation?{investigation:{...investigation,trials:investigation.trials.map(trial=>({...trial,results:trial.results.map(resultSummary)}))}}:{}),dashboardUrl:link(repair.projectId)};
 }));
 server.registerTool('lastmile_retry_repair',{description:'Queue a new automatic private repair attempt for an eligible completed run, including verification. Use a new requestId for a deliberate new attempt; reuse it for network retries with identical inputs. Requires fixed project commands, complete failing evidence, and a passing control. Poll lastmile_get_repair; never applies patches to the source repository.',inputSchema:ProjectRepairRequestSchema.omit({automatic:true}),annotations:write},args=>respond(async()=>repairSummary(await request<ProjectRepair>('/api/project-repairs',{...args,automatic:true}))));
 return server;
}
