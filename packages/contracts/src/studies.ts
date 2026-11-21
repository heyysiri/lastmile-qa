import {z} from 'zod';
import {ContextPackSchema,compileInputs,type ScenarioDefinition,type InputValue} from './index';
import type {EvidenceRun} from './runtime';
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const sentence=z.string().trim().min(1).max(1000);
export const StudyBriefSchema=z.object({applicationId:id,domain:z.string().trim().min(1).max(120),audience:z.string().trim().min(20).max(4000),count:z.number().int().min(1).max(3)}).strict();
export const GenerateStudyRequestSchema=StudyBriefSchema.extend({requestId:id}).strict();
export const StudyUserSchema=z.object({id,name:z.string().trim().min(1).max(80),summary:sentence,coverageReason:sentence,assumptions:z.array(sentence).max(10),workflowId:id,goal:z.string().trim().min(5).max(2000),context:ContextPackSchema}).strict();
export const StudyDraftSchema=z.object({title:z.string().trim().min(1).max(120),summary:sentence,assumptions:z.array(sentence).max(12),users:z.array(StudyUserSchema).min(1).max(3)}).strict();
export const SaveStudyRequestSchema=StudyDraftSchema.extend({revision:z.number().int().positive()}).strict();
export const LaunchStudyRequestSchema=z.object({requestId:id,revision:z.number().int().positive()}).strict();
export type StudyBrief=z.infer<typeof StudyBriefSchema>;
export type StudyUser=z.infer<typeof StudyUserSchema>;
export type StudyDraft=z.infer<typeof StudyDraftSchema>;
export type ApplicationWorkflow={id:string;description:string;scenario:ScenarioDefinition;defaultInputs:Record<string,InputValue>};
export type StudyApplication={id:string;name:string;domain:string;origin:string;description:string;workflows:ApplicationWorkflow[]};
export type Study=StudyDraft&{id:string;revision:number;brief:StudyBrief;createdAt:string;updatedAt:string;generation:{model:string;source:'model';observedPaths:string[]}};
export type StudyExecution={id:string;studyId:string;studyRevision:number;requestId:string;study:Study;status:'queued'|'running'|'completed'|'interrupted';createdAt:string;finishedAt?:string;expectedBuildId?:string;members:{userId:string;runId:string}[]};
export type StudyExecutionDetail=StudyExecution&{runs:EvidenceRun[]};
export type GeneratedStudy={draft:StudyDraft;generation:Study['generation']};
export type GenerateStudy=(brief:StudyBrief,application:StudyApplication)=>Promise<GeneratedStudy>;
export function compileStudyUser(user:StudyUser,application:StudyApplication){
 const workflow=application.workflows.find(w=>w.id===user.workflowId);
 if(!workflow)throw new Error('Choose a supported application workflow');
 const scenario:ScenarioDefinition={...structuredClone(workflow.scenario),id:user.id,revision:1,label:`${user.name}: ${workflow.scenario.label}`.slice(0,120),goal:user.goal};
 const context={...structuredClone(user.context),background:user.summary};
 const inputs=compileInputs(scenario,context);
 if(Object.values(inputs).some(v=>typeof v==='object'))throw new Error('File fixtures are not supported yet');
 return {scenario,context,inputs};
}
export function validateStudyDraft(value:unknown,application:StudyApplication,count?:number):StudyDraft{
 const draft=StudyDraftSchema.parse(value);
 if(count!==undefined&&draft.users.length!==count)throw new Error('Generated tester count does not match the brief');
 const ids=new Set<string>(),situations=new Set<string>();
 for(const user of draft.users){
  if(ids.has(user.id))throw new Error('Tester IDs must be unique');ids.add(user.id);
  compileStudyUser(user,application);
  const context=Object.fromEntries(Object.entries(user.context).filter(([key])=>!['id','label','revision'].includes(key)));
  const key=JSON.stringify({workflowId:user.workflowId,goal:user.goal,context},(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
  if(situations.has(key))throw new Error('Testers must cover distinct situations');situations.add(key);
 }
 return draft;
}
