import {describe,it,expect} from 'vitest';
import {EnrollPopulationRequestSchema,LaunchPopulationRequestSchema} from '../packages/contracts/src/populations';
describe('population command boundaries',()=>{
 it('requires an explicit saved study revision for enrollment',()=>{
  expect(EnrollPopulationRequestSchema.safeParse({requestId:'enroll-1',studyId:'s',label:'Customers'}).success).toBe(false);
  expect(EnrollPopulationRequestSchema.parse({requestId:'enroll-1',studyId:'s',revision:2,label:'Customers'}).revision).toBe(2);
 });
 it('freezes baseline tasks instead of accepting replacement inputs for checkpoint comparison',()=>{
  const input={requestId:'check-1',releaseLabel:'Candidate',mode:'checkpoint',baselineExecutionId:'baseline'};
  expect(LaunchPopulationRequestSchema.safeParse(input).success).toBe(true);
  expect(LaunchPopulationRequestSchema.safeParse({...input,tasks:[]}).success).toBe(false);
 });
 it('bounds continuations and rejects duplicate testers and fixture objects',()=>{
  const task={testerId:'returning',workflowId:'store-setup',goal:'Update store name',inputs:{storeName:'Tea'}};
  const request={requestId:'next',releaseLabel:'Release 1',mode:'continue',tasks:[task]};
  expect(LaunchPopulationRequestSchema.safeParse(request).success).toBe(true);
  expect(LaunchPopulationRequestSchema.safeParse({...request,tasks:[task,task]}).success).toBe(false);
  expect(LaunchPopulationRequestSchema.safeParse({...request,tasks:[{...task,inputs:{file:{fixtureId:'x'}}}]}).success).toBe(false);
  expect(LaunchPopulationRequestSchema.safeParse({...request,tasks:[]}).success).toBe(false);
 });
});
