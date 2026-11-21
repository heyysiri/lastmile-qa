import {describe,expect,it} from 'vitest';
import {SuggestJourneysRequestSchema,PrepareRepairRequestSchema,VerifyRepairRequestSchema,PatchProposalSchema,JourneySuggestionSchema} from '../packages/contracts/src/evolution';
describe('evolution requests',()=>{
 it('requires stable request IDs and bounded objectives',()=>{
  expect(SuggestJourneysRequestSchema.safeParse({requestId:'next-1',objective:'Exercise returning customers'}).success).toBe(true);
  for(const input of [{requestId:''},{requestId:'x',objective:'x'.repeat(2001)},{requestId:'x',url:'https://other.test'}])expect(SuggestJourneysRequestSchema.safeParse(input).success).toBe(false);
 });
 it('accepts only a source execution and the reviewed patch hash',()=>{
  expect(PrepareRepairRequestSchema.safeParse({requestId:'r1',executionId:'execution-1'}).success).toBe(true);
  expect(PrepareRepairRequestSchema.safeParse({requestId:'r1',executionId:'e',assertions:[]}).success).toBe(false);
  expect(VerifyRepairRequestSchema.safeParse({requestId:'v1',patchHash:'a'.repeat(64)}).success).toBe(true);
  expect(VerifyRepairRequestSchema.safeParse({requestId:'v1',patchHash:'old',patch:{}}).success).toBe(false);
 });
 it('rejects unbounded and duplicate patch paths',()=>{
  const change={path:'apps/seller-demo/lib/store.ts',beforeHash:'a'.repeat(64),before:'old',after:'new'};
  const patch={summary:'Preserve existing inventory',changes:[change],hash:'b'.repeat(64)};
  expect(PatchProposalSchema.safeParse(patch).success).toBe(true);
  expect(PatchProposalSchema.safeParse({...patch,changes:[change,change]}).success).toBe(false);
  expect(PatchProposalSchema.safeParse({...patch,changes:[{...change,path:'../.env'}]}).success).toBe(false);
 });
 it('requires an explicit rationale and bounded source references',()=>{
  const suggestion={task:{testerId:'a',workflowId:'store-setup',goal:'Update the store name',inputs:{storeName:'Mango'}},reason:'Check the profile after past inventory activity',sourcePaths:['apps/seller-demo/requirements.md'],historyRunIds:['run-1'],assumptions:[]};
  expect(JourneySuggestionSchema.safeParse(suggestion).success).toBe(true);
  expect(JourneySuggestionSchema.safeParse({...suggestion,reason:''}).success).toBe(false);
 });
});
