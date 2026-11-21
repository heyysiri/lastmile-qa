import {z} from 'zod';
import type {RunStatus} from './index';
import type {StudyUser} from './studies';
import type {EvidenceRun} from './runtime';
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const label=z.string().trim().min(1).max(120);
export const EnrollPopulationRequestSchema=z.object({requestId:id,studyId:id,revision:z.number().int().positive(),label}).strict();
export const PersistentTaskSchema=z.object({testerId:id,workflowId:id,goal:z.string().trim().min(5).max(2000),inputs:z.record(id,z.union([z.string(),z.number().finite(),z.boolean()]))}).strict();
export const LaunchPopulationRequestSchema=z.discriminatedUnion('mode',[
 z.object({requestId:id,releaseLabel:label,mode:z.literal('continue'),tasks:z.array(PersistentTaskSchema).min(1).max(3)}).strict(),
 z.object({requestId:id,releaseLabel:label,mode:z.literal('checkpoint'),baselineExecutionId:id}).strict(),
]).superRefine((value,ctx)=>{if(value.mode==='continue'&&new Set(value.tasks.map(t=>t.testerId)).size!==value.tasks.length)ctx.addIssue({code:'custom',message:'Tester IDs must be unique'});});
export type EnrollPopulationRequest=z.infer<typeof EnrollPopulationRequestSchema>;
export type LaunchPopulationRequest=z.infer<typeof LaunchPopulationRequestSchema>;
export type PersistentTask=z.infer<typeof PersistentTaskSchema>;
export type AccountCheckpoint={id:string;digest:string};
export type MemoryObservation={runId:string;buildId:string;goal:string;observation:string;recordedAt:string};
export type ContinuityEvidence={populationId:string;testerId:string;mode:'continue'|'checkpoint';initialStateId:string;workflowId:string;preserveStatePaths:string[];history:MemoryObservation[];startCheckpoint?:AccountCheckpoint;baselineRunId?:string;sourceReplayHash?:string};
export type ApplicationContextSource={kind:'code'|'requirement'|'observation';path:string;digest:string;excerpt:string};
export type ApplicationContext={applicationId:string;version:string;capturedAt:string;sources:ApplicationContextSource[]};
export type PopulationTester={id:string;profile:StudyUser;initialStateId:string};
export type Population={id:string;label:string;applicationId:string;origin:string;studyId:string;studyRevision:number;createdAt:string;testers:PopulationTester[]};
export type PopulationEpisode={testerId:string;executionId:string;releaseLabel:string;run:EvidenceRun};
export type PopulationDetail=Population&{episodes:PopulationEpisode[]};
export type PopulationExecution={id:string;populationId:string;requestId:string;mode:'continue'|'checkpoint';releaseLabel:string;buildId:string;status:RunStatus;createdAt:string;finishedAt?:string;population:Population;baselineExecutionId?:string;applicationContext?:ApplicationContext;members:{testerId:string;runId:string}[]};
export type ReleaseComparison={testerId:string;baselineRunId:string;outcome:'still_passing'|'regression'|'inconclusive';message:string};
export type PopulationExecutionDetail=PopulationExecution&{runs:EvidenceRun[];comparisons?:ReleaseComparison[]};
