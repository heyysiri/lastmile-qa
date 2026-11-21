import {z} from 'zod';
import {OutcomeContractSchema} from '@lastmile/contracts';
import type {EvidenceRun} from '@lastmile/contracts/runtime';
import {readPath} from './verifier';
const sessionSchema=z.object({namespaceId:z.string().min(1),cookie:z.object({name:z.string().min(1),value:z.string().min(1),path:z.literal('/')})});
export type PreparedSession=z.infer<typeof sessionSchema>;
/** Only the runner sees credentials and account snapshots; actors receive their browser cookie. */
export function createPersistentSessionPreparer(options:{origin:string;testToken:string}){
 const origin=new URL(options.origin).origin;
 return async(run:EvidenceRun,signal:AbortSignal):Promise<PreparedSession>=>{
  const continuity=run.continuity;
  if(!continuity)throw new Error('Missing persistent account identity');
  async function post(path:string,body:unknown){
   const response=await fetch(new URL(path,origin),{method:'POST',redirect:'error',headers:{authorization:`Bearer ${options.testToken}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)])});
   if(!response.ok)throw new Error(`Account service returned HTTP ${response.status}`);
   return response.json();
  }
  if(continuity.mode==='checkpoint'){
   const checkpoint=continuity.startCheckpoint;
   if(!checkpoint)throw new Error('Missing baseline checkpoint');
   const cloned=await post(`/api/test/checkpoints/${encodeURIComponent(checkpoint.id)}/clone`,{cloneKey:run.id});
   if(cloned.digest!==checkpoint.digest)throw new Error('Checkpoint digest changed');
   return sessionSchema.parse(cloned);
  }
  const setup=sessionSchema.parse(await post('/api/test/accounts/session',{accountKey:`${continuity.populationId}:${continuity.testerId}`,fixtureId:continuity.initialStateId}));
  const checkpoint=await post('/api/test/checkpoints',{namespaceId:setup.namespaceId,requestId:run.id});
  if(typeof checkpoint.id!=='string'||!checkpoint.id||typeof checkpoint.digest!=='string'||!checkpoint.digest||checkpoint.state?.namespaceId!==setup.namespaceId)throw new Error('Invalid account checkpoint');
  const assertions=continuity.preserveStatePaths.map((path,index)=>{
   const result=readPath(checkpoint.state,path);
   const scalar=z.union([z.string(),z.number().finite(),z.boolean()]);
   if(!result.ok||!scalar.safeParse(result.value).success)throw new Error('Preserved account field is unavailable');
   return {id:`preserve-${index}`,kind:'state_equals' as const,path,expected:{literal:scalar.parse(result.value)}};
  });
  const contract=OutcomeContractSchema.parse({...run.scenario.contract,assertions:[...run.scenario.contract.assertions,...assertions]});
  run.scenario.contract=contract;
  continuity.startCheckpoint={id:checkpoint.id,digest:checkpoint.digest};
  return setup;
 };
}
