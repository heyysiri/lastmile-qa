import {describe,expect,it,vi} from 'vitest';
import {desktopContext} from '../packages/contracts/src/examples';
import type {SuggestionSnapshot} from '../packages/contracts/src/evolution';
import type {EvidenceRun} from '../packages/contracts/src/runtime';
import {createApplications} from '../apps/runner/src/applications';
import {createJourneyPlanner,plannerContext,validateSuggestions} from '../apps/runner/src/journey-planner';
const context={applicationId:'seller-demo',version:'v2',capturedAt:'today',sources:[{kind:'requirement' as const,path:'requirements.md',digest:'r1',excerpt:'Preserve inventory when editing a profile'},{kind:'code' as const,path:'store.ts',digest:'s2',excerpt:'save profile'}]};
function snapshot():SuggestionSnapshot{return {context,previousContext:{...context,version:'v1',sources:context.sources.map(s=>({...s,digest:s.kind==='code'?'s1':s.digest}))},application:createApplications('http://127.0.0.1:3001')[0],objective:'Check returning sellers after profile changes',population:{id:'pop',label:'Sellers',applicationId:'seller-demo',origin:'http://127.0.0.1:3001',studyId:'study',studyRevision:1,createdAt:'today',testers:['a','b'].map(id=>({id,initialStateId:'active-seller',profile:{id,name:id,summary:'Independent seller',coverageReason:'Retained inventory',assumptions:[],workflowId:'store-setup',goal:'Save profile name',context:{...desktopContext,inputs:{storeName:'Mango'}}}})),episodes:['a','b'].map(id=>({testerId:id,executionId:'ex',releaseLabel:'Old release',run:{id:`run-${id}`,status:'completed',verdict:'passed',createdAt:'yesterday',scenario:{goal:'Update stock'},continuity:{mode:'continue'},steps:[{observation:'Inventory saved'}],evidence:{buildId:'old'},assertions:[{id:'qty',status:'passed',actual:250}],namespaceId:'private-namespace'} as unknown as EvidenceRun}))}};}
const suggestions=()=>['a','b'].map(testerId=>({task:{testerId,workflowId:'store-setup',goal:'Save the store name Mango',inputs:{storeName:'Mango'}},reason:'Verify a profile edit retains saved inventory',sourcePaths:['requirements.md'],historyRunIds:[`run-${testerId}`],assumptions:['Coverage hypothesis, not a prediction']}));
describe('grounded next journey planner',()=>{
 it('supplies changed source digests and bounded observed history without credentials or full run records',()=>{
  const input=plannerContext(snapshot());
  expect(input.changedSourcePaths).toEqual(['store.ts']);
  expect(JSON.stringify(input)).toContain('run-a');
  expect(JSON.stringify(input)).not.toContain('private-namespace');
  expect(JSON.stringify(input)).not.toContain('assertions');
 });
 it('requires exactly one supported valid task per enrolled tester',()=>{
  expect(validateSuggestions(suggestions(),snapshot())).toHaveLength(2);
  for(const mutate of [(v:ReturnType<typeof suggestions>)=>v.pop(),(v:ReturnType<typeof suggestions>)=>{v[1].task.testerId='a';},(v:ReturnType<typeof suggestions>)=>{v[0].task.workflowId='invented';},(v:ReturnType<typeof suggestions>)=>{v[0].task.inputs.storeName='x'.repeat(81);}]){const v=suggestions();mutate(v);expect(()=>validateSuggestions(v,snapshot())).toThrow();}
 });
 it('rejects invented sources and another tester history',()=>{
  const v=suggestions();v[0].sourcePaths=['made-up.ts'];expect(()=>validateSuggestions(v,snapshot())).toThrow();
  v[0].sourcePaths=['requirements.md'];v[0].historyRunIds=['run-b'];expect(()=>validateSuggestions(v,snapshot())).toThrow();
 });
 it('calls the provider once and validates its result',async()=>{
  const complete=vi.fn(async()=>JSON.stringify({suggestions:suggestions()}));
  const generate=createJourneyPlanner({apiKey:'test',model:'test',complete});
  expect(await generate(snapshot())).toHaveLength(2);expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]).toBeDefined();
 });
 it('sanitizes provider errors and refuses malformed or incomplete output',async()=>{
  const generate=createJourneyPlanner({apiKey:'test',model:'test',complete:async()=>{throw new Error('Bearer private-secret');}});
  await expect(generate(snapshot())).rejects.toThrow('provider is unavailable');
  await expect(createJourneyPlanner({apiKey:'test',model:'test',complete:async()=>'{}'})(snapshot())).rejects.toThrow('valid grounded');
 });
 it('does not call the model when unconfigured',async()=>{
  const complete=vi.fn();await expect(createJourneyPlanner({model:'test',complete})(snapshot())).rejects.toThrow('Configure OpenAI');expect(complete).not.toHaveBeenCalled();
 });
});
